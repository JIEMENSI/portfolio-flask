import { Hono } from "hono";
import type { Env } from "../shared/types";
import { login, logout } from "./auth";
import { registerProjectRoutes } from "./projects";

export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/health", (context) => context.json({ ok: true }));
adminApp.post("/api/auth/login", login);
adminApp.post("/api/auth/logout", logout);
registerProjectRoutes(adminApp);

export default adminApp;
