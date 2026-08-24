import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../../src/admin/index";
import type { Env } from "../../src/shared/types";
import { loginHeaders, resetDatabase } from "../helpers/admin";

const testEnv = { ...(env as unknown as Env), ADMIN_PASSWORD_HASH: "pbkdf2$100000$00112233445566778899aabbccddeeff$baef35f707683ac1635ccb699a498db6a227243d1742a0c5837d6a0f65fc14ea", SESSION_PEPPER: "test-pepper", PREVIEW_BASE_URL: "http://preview.local" } satisfies Env;

async function createProject(headers: Record<string, string>) {
  const response = await adminApp.request("/api/projects", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: "支付页", isPublic: true })
  }, testEnv);
  return response.json<{ id: string }>();
}

async function upload(projectId: string, headers: Record<string, string>, html: string, note: string) {
  const form = new FormData();
  form.set("html", new File([html], "prototype.html", { type: "text/html" }));
  form.set("changeNote", note);
  const response = await adminApp.request(`/api/projects/${projectId}/versions`, { method: "POST", headers, body: form }, testEnv);
  expect(response.status).toBe(201);
  return response.json<{ id: string; versionNumber: number; objectKey: string; sha256: string; restoredFromVersionId: string | null }>();
}

function uploadRequest(projectId: string, headers: Record<string, string>, html: string, idempotencyKey: string) {
  const form = new FormData();
  form.set("html", new File([html], "prototype.html", { type: "text/html" }));
  form.set("changeNote", "防重测试");
  return adminApp.request(`/api/projects/${projectId}/versions`, {
    method: "POST", headers: { ...headers, "Idempotency-Key": idempotencyKey }, body: form
  }, testEnv);
}

describe("version workflows", () => {
  beforeEach(() => resetDatabase(testEnv));

  it("publishes sequential immutable versions", async () => {
    const headers = await loginHeaders(testEnv);
    const project = await createProject(headers);
    const v1 = await upload(project.id, headers, "<!doctype html><title>V1</title>", "首版");
    const v2 = await upload(project.id, headers, "<!doctype html><title>V2</title>", "改版");

    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
    expect(v1.objectKey).not.toBe(v2.objectKey);
    expect(await testEnv.FILES.get(v1.objectKey, "text")).toContain("V1");

    const detail = await adminApp.request(`/api/projects/${project.id}`, { headers }, testEnv);
    expect(detail.status).toBe(200);
    const payload = await detail.json<{ versions: { versionNumber: number }[]; previewBaseUrl: string }>();
    expect(payload.versions.map((version) => version.versionNumber)).toEqual([2, 1]);
    expect(payload.previewBaseUrl).toBe("http://preview.local");
  });

  it("restores V1 by creating V3 with identical content", async () => {
    const headers = await loginHeaders(testEnv);
    const project = await createProject(headers);
    const v1 = await upload(project.id, headers, "<!doctype html><title>V1</title>", "首版");
    await upload(project.id, headers, "<!doctype html><title>V2</title>", "改版");

    const response = await adminApp.request(`/api/projects/${project.id}/versions/1/restore`, { method: "POST", headers }, testEnv);
    expect(response.status).toBe(201);
    const v3 = await response.json<{ versionNumber: number; sha256: string; restoredFromVersionId: string }>();
    expect(v3).toMatchObject({ versionNumber: 3, sha256: v1.sha256, restoredFromVersionId: v1.id });
  });

  it("replays duplicate uploads without creating another version or object", async () => {
    const headers = await loginHeaders(testEnv);
    const project = await createProject(headers);

    const first = await uploadRequest(project.id, headers, "<!doctype html><title>Only once</title>", "upload-1");
    const second = await uploadRequest(project.id, headers, "<!doctype html><title>Only once</title>", "upload-1");

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers.get("Idempotent-Replay")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    const row = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM versions WHERE project_id = ?")
      .bind(project.id).first<{ count: number }>();
    expect(row?.count).toBe(1);
    expect((await testEnv.FILES.list({ prefix: `projects/${project.id}/versions/` })).keys).toHaveLength(1);
  });

  it("requires confirmation and only deletes a historical version", async () => {
    const headers = await loginHeaders(testEnv);
    const project = await createProject(headers);
    const v1 = await upload(project.id, headers, "<!doctype html><title>V1</title>", "首版");

    const currentCheck = await adminApp.request(`/api/projects/${project.id}/versions/1/delete-check`, {
      method: "POST", headers
    }, testEnv);
    expect(currentCheck.status).toBe(409);

    await upload(project.id, headers, "<!doctype html><title>V2</title>", "改版");
    const check = await adminApp.request(`/api/projects/${project.id}/versions/1/delete-check`, {
      method: "POST", headers
    }, testEnv);
    expect(check.status).toBe(200);
    const confirmation = await check.json<{ confirmationToken: string }>();

    const unconfirmed = await adminApp.request(`/api/projects/${project.id}/versions/1`, {
      method: "DELETE", headers
    }, testEnv);
    expect(unconfirmed.status).toBe(400);

    const deleted = await adminApp.request(`/api/projects/${project.id}/versions/1`, {
      method: "DELETE", headers: { ...headers, "X-Delete-Confirmation": confirmation.confirmationToken }
    }, testEnv);
    expect(deleted.status).toBe(200);
    expect(await testEnv.FILES.get(v1.objectKey)).toBeNull();
    const row = await testEnv.DB.prepare("SELECT deleted_at FROM versions WHERE id = ?")
      .bind(v1.id).first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).not.toBeNull();
  });
});
