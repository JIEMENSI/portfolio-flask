import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../../src/admin/index";
import type { Env } from "../../src/shared/types";

const testEnv = {
  ...(env as unknown as Env),
  ADMIN_PASSWORD_HASH: "pbkdf2$100000$00112233445566778899aabbccddeeff$baef35f707683ac1635ccb699a498db6a227243d1742a0c5837d6a0f65fc14ea",
  SESSION_PEPPER: "test-pepper"
} satisfies Env;

describe("administrator authentication", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("DROP TABLE IF EXISTS admin_sessions;\nCREATE TABLE admin_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_hash TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_used_at TEXT NOT NULL);");
  });

  it("sets a secure admin session for the correct password", async () => {
    const response = await adminApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct" })
    }, testEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/__Host-admin_session=.*HttpOnly;.*Secure;.*SameSite=Strict/);
    expect((await response.json<{ csrfToken: string }>()).csrfToken).toHaveLength(64);
  });

  it("rejects an incorrect password", async () => {
    const response = await adminApp.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" })
    }, testEnv);

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects an authenticated mutation without its CSRF token", async () => {
    const login = await adminApp.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "correct" })
    }, testEnv);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0]!;

    const response = await adminApp.request("/api/auth/logout", {
      method: "POST", headers: { cookie }
    }, testEnv);

    expect(response.status).toBe(403);
  });
});
