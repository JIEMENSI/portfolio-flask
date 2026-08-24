import type { Context, Hono } from "hono";
import { ProjectRepository } from "../shared/repository";
import { randomShareId } from "../shared/ids";
import { deleteObjects, putVersionObject, validateHtml } from "../shared/storage";
import type { Env } from "../shared/types";
import { requireAdmin, requireCsrf } from "./auth";

type AdminApp = Hono<{ Bindings: Env }>;

async function authorize(context: Context<{ Bindings: Env }>) {
  const session = await requireAdmin(context);
  if (session instanceof Response) return session;
  return requireCsrf(context, session);
}

async function deletionToken(env: Env, projectId: string, versionId: string, sha256: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${projectId}:${versionId}:${sha256}:${env.SESSION_PEPPER}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function registerVersionRoutes(app: AdminApp): void {
  app.post("/api/projects/:id/versions", async (context) => {
    const denied = await authorize(context);
    if (denied) return denied;
    const repo = new ProjectRepository(context.env.DB);
    const project = await repo.getProject(context.req.param("id"));
    if (!project) return context.json({ error: "项目不存在" }, 404);
    const idempotencyKey = context.req.header("Idempotency-Key")?.trim() ?? "";
    if (idempotencyKey.length > 128) return context.json({ error: "防重标识过长" }, 400);
    const storedIdempotencyKey = `${project.id}:upload:${idempotencyKey}`;
    if (idempotencyKey) {
      const reservation = await repo.reserveIdempotencyKey(storedIdempotencyKey);
      if (!reservation.reserved) {
        if (!reservation.responseJson) return context.json({ error: "相同请求正在处理中" }, 409);
        return context.json(JSON.parse(reservation.responseJson), 200, { "Idempotent-Replay": "true" });
      }
    }
    const form = await context.req.formData();
    const file = form.get("html");
    if (!(file instanceof File)) {
      if (idempotencyKey) await repo.releaseIdempotencyKey(storedIdempotencyKey);
      return context.json({ error: "请选择HTML文件" }, 400);
    }
    let objectKey: string | null = null;
    try {
      const html = await validateHtml(file);
      const stored = await putVersionObject(context.env.FILES, project.id, crypto.randomUUID(), html);
      objectKey = stored.objectKey;
      const version = await repo.createNextVersion(project.id, {
        shareId: randomShareId(), changeNote: String(form.get("changeNote") ?? "").trim(),
        originalFilename: html.originalFilename, objectKey, fileSize: stored.fileSize,
        sha256: stored.sha256, restoredFromVersionId: null, createdAt: new Date().toISOString()
      });
      if (idempotencyKey) await repo.completeIdempotencyKey(storedIdempotencyKey, JSON.stringify(version));
      return context.json(version, 201);
    } catch (error) {
      if (objectKey) await deleteObjects(context.env.FILES, [objectKey]);
      if (idempotencyKey) await repo.releaseIdempotencyKey(storedIdempotencyKey);
      const code = error instanceof Error ? error.message : "UPLOAD_FAILED";
      return context.json({ error: code }, 400);
    }
  });

  app.post("/api/projects/:id/versions/:number/delete-check", async (context) => {
    const denied = await authorize(context);
    if (denied) return denied;
    const repo = new ProjectRepository(context.env.DB);
    const project = await repo.getProject(context.req.param("id"));
    if (!project) return context.json({ error: "项目不存在" }, 404);
    const version = await repo.getVersionByNumber(project.id, Number(context.req.param("number")));
    if (!version) return context.json({ error: "版本不存在" }, 404);
    if (project.currentVersionId === version.id) return context.json({ error: "当前版本不能删除" }, 409);
    return context.json({
      versionNumber: version.versionNumber,
      fileSize: version.fileSize,
      confirmationToken: await deletionToken(context.env, project.id, version.id, version.sha256)
    });
  });

  app.delete("/api/projects/:id/versions/:number", async (context) => {
    const denied = await authorize(context);
    if (denied) return denied;
    const repo = new ProjectRepository(context.env.DB);
    const project = await repo.getProject(context.req.param("id"));
    if (!project) return context.json({ error: "项目不存在" }, 404);
    const version = await repo.getVersionByNumber(project.id, Number(context.req.param("number")));
    if (!version) return context.json({ error: "版本不存在" }, 404);
    if (project.currentVersionId === version.id) return context.json({ error: "当前版本不能删除" }, 409);
    const expected = await deletionToken(context.env, project.id, version.id, version.sha256);
    if (context.req.header("X-Delete-Confirmation") !== expected) {
      return context.json({ error: "请先确认要删除的历史版本" }, 400);
    }
    const deletedAt = new Date().toISOString();
    await repo.markVersionDeleted(version.id, deletedAt);
    try {
      await deleteObjects(context.env.FILES, [version.objectKey]);
    } catch (error) {
      await repo.markVersionDeleted(version.id, null);
      throw error;
    }
    return context.json({ deleted: true, versionNumber: version.versionNumber });
  });

  app.post("/api/projects/:id/versions/:number/restore", async (context) => {
    const denied = await authorize(context);
    if (denied) return denied;
    const repo = new ProjectRepository(context.env.DB);
    const projectId = context.req.param("id");
    const source = await repo.getVersionByNumber(projectId, Number(context.req.param("number")));
    if (!source) return context.json({ error: "版本不存在" }, 404);
    const object = await context.env.FILES.get(source.objectKey);
    if (!object) return context.json({ error: "源文件不存在" }, 409);
    const file = new File([await object.arrayBuffer()], source.originalFilename, { type: "text/html" });
    const validated = await validateHtml(file);
    const stored = await putVersionObject(context.env.FILES, projectId, crypto.randomUUID(), validated);
    try {
      const version = await repo.createNextVersion(projectId, {
        shareId: randomShareId(), changeNote: `恢复自 V${source.versionNumber}`,
        originalFilename: source.originalFilename, objectKey: stored.objectKey,
        fileSize: stored.fileSize, sha256: stored.sha256, restoredFromVersionId: source.id,
        createdAt: new Date().toISOString()
      });
      return context.json(version, 201);
    } catch (error) {
      await deleteObjects(context.env.FILES, [stored.objectKey]);
      throw error;
    }
  });
}
