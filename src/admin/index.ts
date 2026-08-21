import { Hono } from "hono";
import type { Env } from "../shared/types";

export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/health", (context) => context.json({ ok: true }));

export default adminApp;
