import { Hono } from "hono";
import type { Env } from "../shared/types";
import { login, logout } from "./auth";
import { registerMigrationRoutes } from "./migration";
import { registerProjectRoutes } from "./projects";
import { registerVersionRoutes } from "./versions";

export const adminApp = new Hono<{ Bindings: Env }>();

adminApp.get("/health", (context) => context.json({ ok: true }));
adminApp.post("/api/auth/login", login);
adminApp.post("/api/auth/logout", logout);
registerProjectRoutes(adminApp);
registerVersionRoutes(adminApp);
registerMigrationRoutes(adminApp);

export default adminApp;
