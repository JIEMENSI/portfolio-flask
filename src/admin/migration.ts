import type { Context, Hono } from "hono";
import { randomShareId } from "../shared/ids";
import { ProjectRepository } from "../shared/repository";
import { deleteObjects, putVersionObject, validateHtml } from "../shared/storage";
import type { Env } from "../shared/types";

type AdminApp = Hono<{ Bindings: Env }>;

type LegacyMetadata = {
  id?: string; title?: string; description?: string; remark?: string; group?: string;
  filename?: string; original_name?: string; cover?: string; is_public?: boolean;
  created_at?: string; expected_size?: number; expected_sha256?: string;
};

function migrationAuth(context: Context<{ Bindings: Env }>): Response | null {
  if (!context.env.MIGRATION_TOKEN) return context.json({ error: "NOT_FOUND" }, 404);
  const supplied = context.req.header("Authorization");
  if (supplied !== `Bearer ${context.env.MIGRATION_TOKEN}`) return context.json({ error: "迁移令牌无效" }, 401);
  return null;
}

function extension(filename: string): string {
  const match = filename.toLowerCase().match(/\.[a-z0-9]{1,8}$/);
  return match?.[0] ?? ".bin";
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function rollback(env: Env, projectId: string | null, objectKeys: string[]) {
  await deleteObjects(env.FILES, objectKeys);
  if (projectId) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM versions WHERE project_id = ?").bind(projectId),
      env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(projectId)
    ]);
  }
}

export function registerMigrationRoutes(app: AdminApp): void {
  app.post("/api/migration/import", async (context) => {
    const denied = migrationAuth(context);
    if (denied) return denied;
    const form = await context.req.formData();
    let metadata: LegacyMetadata;
    try { metadata = JSON.parse(String(form.get("metadata") ?? "")); }
    catch { return context.json({ error: "INVALID_METADATA" }, 400); }
    const legacyId = metadata.id?.trim();
    const title = metadata.title?.trim();
    const htmlFile = form.get("html");
    if (!legacyId || !title || !(htmlFile instanceof File)) return context.json({ error: "INVALID_METADATA" }, 400);

    const repo = new ProjectRepository(context.env.DB);
    const key = `migration:${legacyId}`;
    const reservation = await repo.reserveIdempotencyKey(key);
    if (!reservation.reserved) {
      if (!reservation.responseJson) return context.json({ error: "迁移正在处理中" }, 409);
      return context.json(JSON.parse(reservation.responseJson), 200, { "Idempotent-Replay": "true" });
    }

    let projectId: string | null = null;
    const objectKeys: string[] = [];
    try {
      const html = await validateHtml(htmlFile);
      if (metadata.expected_size !== undefined && metadata.expected_size !== html.fileSize) throw new Error("FILE_SIZE_MISMATCH");
      if (metadata.expected_sha256 && metadata.expected_sha256.toLowerCase() !== html.sha256) throw new Error("FILE_HASH_MISMATCH");

      const cover = form.get("cover");
      let coverObjectKey: string | null = null;
      let coverResult: { objectKey: string; originalFilename: string; fileSize: number; sha256: string } | null = null;
      if (cover instanceof File && cover.size > 0) {
        coverObjectKey = `migration/covers/${legacyId}/${crypto.randomUUID()}${extension(cover.name)}`;
        const coverBytes = await cover.arrayBuffer();
        coverResult = { objectKey: coverObjectKey, originalFilename: cover.name, fileSize: cover.size, sha256: await sha256(coverBytes) };
        await context.env.FILES.put(coverObjectKey, coverBytes, { metadata: { contentType: cover.type || "application/octet-stream", sha256: coverResult.sha256, originalFilename: cover.name } });
        objectKeys.push(coverObjectKey);
      }

      const createdAt = metadata.created_at || new Date().toISOString();
      const project = await repo.createProject({
        name: title, description: metadata.description ?? "", remark: metadata.remark ?? "",
        groupName: metadata.group || "未分组", coverObjectKey, isPublic: metadata.is_public !== false,
        createdAt
      });
      projectId = project.id;
      const stored = await putVersionObject(context.env.FILES, project.id, crypto.randomUUID(), html);
      objectKeys.push(stored.objectKey);
      const version = await repo.createNextVersion(project.id, {
        shareId: randomShareId(), changeNote: "从原网站迁移", originalFilename: metadata.original_name || html.originalFilename,
        objectKey: stored.objectKey, fileSize: stored.fileSize, sha256: stored.sha256,
        restoredFromVersionId: null, createdAt
      });
      const result = { legacyId, project: await repo.getProject(project.id), version, cover: coverResult };
      await repo.completeIdempotencyKey(key, JSON.stringify(result));
      return context.json(result, 201);
    } catch (error) {
      await rollback(context.env, projectId, objectKeys);
      await repo.releaseIdempotencyKey(key);
      return context.json({ error: error instanceof Error ? error.message : "MIGRATION_FAILED" }, 400);
    }
  });

  app.get("/api/migration/report", async (context) => {
    const denied = migrationAuth(context);
    if (denied) return denied;
    const rows = await context.env.DB.prepare("SELECT response_json FROM idempotency_keys WHERE key LIKE 'migration:%' AND response_json != '__PENDING__' ORDER BY created_at")
      .all<{ response_json: string }>();
    const projects = rows.results.map((row) => JSON.parse(row.response_json) as {
      legacyId: string; project: { name: string; description: string; remark: string; groupName: string; isPublic: boolean; createdAt: string; coverObjectKey: string | null };
      version: { originalFilename: string; fileSize: number; sha256: string; objectKey: string };
      cover: { originalFilename: string; fileSize: number; sha256: string; objectKey: string } | null;
    }).map((item) => ({
      legacyId: item.legacyId, title: item.project.name, description: item.project.description,
      remark: item.project.remark, group: item.project.groupName, isPublic: item.project.isPublic,
      createdAt: item.project.createdAt, coverObjectKey: item.project.coverObjectKey,
      version: item.version, cover: item.cover
    }));
    return context.json({ projectCount: projects.length, projects });
  });
}
