import { Hono } from "hono";
import { ProjectRepository } from "../shared/repository";
import type { Env } from "../shared/types";
import { forbiddenPage, galleryPage, notFoundPage, previewPage, PUBLIC_CSS } from "./pages";

export const previewApp = new Hono<{ Bindings: Env }>();

previewApp.get("/health", (context) => context.json({ ok: true }));

const shellHeaders = { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const html = (body: string, status = 200) => new Response(body, { status, headers: shellHeaders });

previewApp.get("/assets/styles.css", (context) => context.body(PUBLIC_CSS, 200, { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" }));

previewApp.get("/", async (context) => {
  const projects = await new ProjectRepository(context.env.DB).listPublicProjects();
  return html(galleryPage(projects));
});

async function resolveVersion(repo: ProjectRepository, kind: "project" | "version", shareId: string) {
  if (kind === "project") {
    const project = await repo.getProjectByShareId(shareId);
    if (!project) return null;
    const version = project.currentVersionId ? await repo.getVersion(project.currentVersionId) : null;
    return { project, version };
  }
  const version = await repo.getVersionByShareId(shareId);
  if (!version) return null;
  return { project: await repo.getProject(version.projectId), version };
}

const allowed = (project: Awaited<ReturnType<ProjectRepository["getProject"]>>) => project?.isPublic && project.status === "active";

previewApp.get("/p/:shareId", async (context) => {
  const resolved = await resolveVersion(new ProjectRepository(context.env.DB), "project", context.req.param("shareId"));
  if (!resolved || !resolved.project || !resolved.version) return html(notFoundPage(), 404);
  if (!allowed(resolved.project)) return html(forbiddenPage(), 403);
  return html(previewPage(resolved.project, resolved.version));
});

previewApp.get("/v/:shareId", async (context) => {
  const resolved = await resolveVersion(new ProjectRepository(context.env.DB), "version", context.req.param("shareId"));
  if (!resolved || !resolved.project || !resolved.version) return html(notFoundPage(), 404);
  if (!allowed(resolved.project)) return html(forbiddenPage(), 403);
  return html(previewPage(resolved.project, resolved.version));
});

previewApp.get("/raw/:shareId", async (context) => {
  const resolved = await resolveVersion(new ProjectRepository(context.env.DB), "version", context.req.param("shareId"));
  if (!resolved || !resolved.project || !resolved.version) return html(notFoundPage(), 404);
  if (!allowed(resolved.project)) return html(forbiddenPage(), 403);
  const object = await context.env.FILES.get(resolved.version.objectKey);
  if (!object) return html(notFoundPage(), 404);
  return new Response(object.body, { headers: {
    "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'"
  } });
});

previewApp.notFound(() => html(notFoundPage(), 404));

export default previewApp;
