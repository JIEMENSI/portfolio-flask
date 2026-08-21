import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../../src/admin/index";
import type { Env } from "../../src/shared/types";
import { loginHeaders, resetDatabase } from "../helpers/admin";

const testEnv = { ...(env as unknown as Env), ADMIN_PASSWORD_HASH: "pbkdf2$100000$00112233445566778899aabbccddeeff$baef35f707683ac1635ccb699a498db6a227243d1742a0c5837d6a0f65fc14ea", SESSION_PEPPER: "test-pepper" } satisfies Env;

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

describe("version workflows", () => {
  beforeEach(() => resetDatabase(testEnv));

  it("publishes sequential immutable versions", async () => {
    const headers = await loginHeaders(testEnv);
    const project = await createProject(headers);
    const v1 = await upload(project.id, headers, "<!doctype html><title>V1</title>", "首版");
    const v2 = await upload(project.id, headers, "<!doctype html><title>V2</title>", "改版");

    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
    expect(v1.objectKey).not.toBe(v2.objectKey);
    expect(await (await testEnv.FILES.get(v1.objectKey))?.text()).toContain("V1");
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
});
