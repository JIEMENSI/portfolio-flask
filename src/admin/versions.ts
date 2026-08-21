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

export function registerVersionRoutes(app: AdminApp): void {
  app.post("/api/projects/:id/versions", async (context) => {
    const denied = await authorize(context);
    if (denied) return denied;
    const repo = new ProjectRepository(context.env.DB);
    const project = await repo.getProject(context.req.param("id"));
    if (!project) return context.json({ error: "项目不存在" }, 404);
    const form = await context.req.formData();
    const file = form.get("html");
    if (!(file instanceof File)) return context.json({ error: "请选择HTML文件" }, 400);
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
      return context.json(version, 201);
    } catch (error) {
      if (objectKey) await deleteObjects(context.env.FILES, [objectKey]);
      const code = error instanceof Error ? error.message : "UPLOAD_FAILED";
      return context.json({ error: code }, 400);
    }
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
