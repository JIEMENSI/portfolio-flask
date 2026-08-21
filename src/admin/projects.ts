import type { Context, Hono } from "hono";
import { ProjectRepository } from "../shared/repository";
import type { Env } from "../shared/types";
import { requireAdmin, requireCsrf } from "./auth";

type AdminApp = Hono<{ Bindings: Env }>;

async function authorize(context: Context<{ Bindings: Env }>, mutation = false) {
  const session = await requireAdmin(context);
  if (session instanceof Response) return session;
  if (mutation) return await requireCsrf(context, session);
  return null;
}

async function audit(env: Env, action: string, targetId: string) {
  await env.DB.prepare("INSERT INTO audit_logs (action, target_type, target_id, result, created_at) VALUES (?, 'project', ?, 'success', ?)")
    .bind(action, targetId, new Date().toISOString()).run();
}

export function registerProjectRoutes(app: AdminApp): void {
  app.get("/api/projects", async (context) => {
    const denied = await authorize(context);
    if (denied) return denied;
    return context.json({ projects: await new ProjectRepository(context.env.DB).listProjects() });
  });

  app.post("/api/projects", async (context) => {
    const denied = await authorize(context, true);
    if (denied) return denied;
    const body: { name?: string; description?: string; remark?: string; groupName?: string; isPublic?: boolean } =
      await context.req.json().catch(() => ({}));
    const name = body.name?.trim();
    if (!name) return context.json({ error: "项目名称不能为空" }, 400);
    const project = await new ProjectRepository(context.env.DB).createProject({
      name, description: body.description?.trim(), remark: body.remark?.trim(),
      groupName: body.groupName?.trim(), isPublic: body.isPublic === true
    });
    await audit(context.env, "project.create", project.id);
    return context.json(project, 201);
  });

  app.post("/api/projects/:id/visibility", async (context) => {
    const denied = await authorize(context, true);
    if (denied) return denied;
    const body: { isPublic?: boolean } = await context.req.json().catch(() => ({}));
    if (typeof body.isPublic !== "boolean") return context.json({ error: "公开状态无效" }, 400);
    const project = await new ProjectRepository(context.env.DB).setVisibility(context.req.param("id"), body.isPublic);
    if (!project) return context.json({ error: "项目不存在" }, 404);
    await audit(context.env, "project.visibility", project.id);
    return context.json(project);
  });

  for (const [action, status] of [["archive", "archived"], ["trash", "trashed"], ["restore", "active"]] as const) {
    app.post(`/api/projects/:id/${action}`, async (context) => {
      const denied = await authorize(context, true);
      if (denied) return denied;
      const project = await new ProjectRepository(context.env.DB).setStatus(context.req.param("id"), status);
      if (!project) return context.json({ error: "项目不存在" }, 404);
      await audit(context.env, `project.${action}`, project.id);
      return context.json(project);
    });
  }
}
