import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../../src/admin/index";
import type { Env } from "../../src/shared/types";

const testEnv = {
  ...(env as unknown as Env),
  ADMIN_PASSWORD_HASH: "pbkdf2$100000$00112233445566778899aabbccddeeff$baef35f707683ac1635ccb699a498db6a227243d1742a0c5837d6a0f65fc14ea",
  SESSION_PEPPER: "test-pepper"
} satisfies Env;

async function adminHeaders() {
  const response = await adminApp.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct" })
  }, testEnv);
  const { csrfToken } = await response.json<{ csrfToken: string }>();
  return {
    "content-type": "application/json",
    cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!,
    "X-CSRF-Token": csrfToken
  };
}

describe("project lifecycle API", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("PRAGMA foreign_keys = OFF;\nDROP TABLE IF EXISTS audit_logs;\nDROP TABLE IF EXISTS admin_sessions;\nDROP TABLE IF EXISTS versions;\nDROP TABLE IF EXISTS projects;\nPRAGMA foreign_keys = ON;\nCREATE TABLE projects (id TEXT PRIMARY KEY, share_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '未分组', cover_object_key TEXT, is_public INTEGER NOT NULL, current_version_id TEXT, next_version_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT);\nCREATE TABLE versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_id TEXT NOT NULL UNIQUE, version_number INTEGER NOT NULL, change_note TEXT NOT NULL DEFAULT '', original_filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, restored_from_version_id TEXT, created_at TEXT NOT NULL, deleted_at TEXT);\nCREATE TABLE admin_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL);\nCREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL);");
  });

  it("creates and lists a private project for the administrator", async () => {
    const headers = await adminHeaders();
    const created = await adminApp.request("/api/projects", {
      method: "POST", headers,
      body: JSON.stringify({ name: "支付页", description: "开发预览", isPublic: false })
    }, testEnv);

    expect(created.status).toBe(201);
    const project = await created.json<{ id: string; isPublic: boolean }>();
    expect(project.isPublic).toBe(false);

    const listed = await adminApp.request("/api/projects", { headers }, testEnv);
    expect((await listed.json<{ projects: { id: string }[] }>()).projects.map((item) => item.id)).toEqual([project.id]);
  });

  it("changes visibility and moves a project through archive, trash, and restore", async () => {
    const headers = await adminHeaders();
    const created = await adminApp.request("/api/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "商品页", isPublic: true })
    }, testEnv);
    const project = await created.json<{ id: string }>();

    for (const [action, expectedStatus] of [["visibility", "active"], ["archive", "archived"], ["trash", "trashed"], ["restore", "active"]] as const) {
      const body = action === "visibility" ? JSON.stringify({ isPublic: false }) : undefined;
      const response = await adminApp.request(`/api/projects/${project.id}/${action}`, { method: "POST", headers, body }, testEnv);
      expect(response.status).toBe(200);
      expect((await response.json<{ status: string }>()).status).toBe(expectedStatus);
    }
  });

  it("rejects project creation without an administrator session", async () => {
    const response = await adminApp.request("/api/projects", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "秘密" })
    }, testEnv);
    expect(response.status).toBe(401);
  });
});
