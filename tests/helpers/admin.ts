import { adminApp } from "../../src/admin/index";
import type { Env } from "../../src/shared/types";

export async function resetDatabase(env: Env) {
  await env.DB.exec("PRAGMA foreign_keys = OFF;\nDROP TABLE IF EXISTS idempotency_keys;\nDROP TABLE IF EXISTS audit_logs;\nDROP TABLE IF EXISTS admin_sessions;\nDROP TABLE IF EXISTS versions;\nDROP TABLE IF EXISTS projects;\nPRAGMA foreign_keys = ON;\nCREATE TABLE projects (id TEXT PRIMARY KEY, share_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '未分组', cover_object_key TEXT, is_public INTEGER NOT NULL, current_version_id TEXT, next_version_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT);\nCREATE TABLE versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_id TEXT NOT NULL UNIQUE, version_number INTEGER NOT NULL, change_note TEXT NOT NULL DEFAULT '', original_filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, restored_from_version_id TEXT, created_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(project_id, version_number));\nCREATE TABLE admin_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL);\nCREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, response_json TEXT NOT NULL, created_at TEXT NOT NULL);\nCREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, result TEXT NOT NULL, created_at TEXT NOT NULL);");
}

export async function loginHeaders(env: Env) {
  const response = await adminApp.request("/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "correct" })
  }, env);
  const { csrfToken } = await response.json<{ csrfToken: string }>();
  return { cookie: response.headers.get("set-cookie")!.split(";", 1)[0]!, "X-CSRF-Token": csrfToken };
}
