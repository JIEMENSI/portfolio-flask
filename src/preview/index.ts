import { Hono } from "hono";
import type { Env } from "../shared/types";

export const previewApp = new Hono<{ Bindings: Env }>();

previewApp.get("/health", (context) => context.json({ ok: true }));

export default previewApp;
