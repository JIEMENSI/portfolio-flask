import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../../src/admin/index";
import type { Env } from "../../src/shared/types";
import { resetDatabase } from "../helpers/admin";

const testEnv = { ...(env as unknown as Env), MIGRATION_TOKEN: "migration-secret" } satisfies Env;

type LegacyTestMetadata = {
  id: string; title: string; description: string; remark: string; group: string; filename: string;
  original_name: string; cover: string; is_public: boolean; created_at: string; expected_size?: number;
};

const legacy: LegacyTestMetadata = {
  id: "a19ece02", title: "毛豆上货", description: "开发预览", remark: "保留备注",
  group: "业务原型", filename: "a19ece02.html", original_name: "store-binding_1.html",
  cover: "a19ece02.png", is_public: false, created_at: "2026-08-07 17:14:07"
};

function importRequest(metadata: LegacyTestMetadata = legacy, html = "<!doctype html><title>毛豆上货</title>", cover = true) {
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("html", new File([html], metadata.filename, { type: "text/html" }));
  if (cover) form.set("cover", new File([new Uint8Array([137, 80, 78, 71])], metadata.cover, { type: "image/png" }));
  return adminApp.request("/api/migration/import", {
    method: "POST", headers: { Authorization: "Bearer migration-secret" }, body: form
  }, testEnv);
}

describe("legacy migration", () => {
  beforeEach(() => resetDatabase(testEnv));

  it("requires the dedicated migration token instead of an admin cookie", async () => {
    const form = new FormData();
    const response = await adminApp.request("/api/migration/import", { method: "POST", body: form }, testEnv);
    expect(response.status).toBe(401);

    const disabledEnv = { ...testEnv, MIGRATION_TOKEN: undefined };
    expect((await adminApp.request("/api/migration/import", { method: "POST", body: form }, disabledEnv)).status).toBe(404);
  });

  it("preserves legacy metadata, privacy, cover, and HTML as V1", async () => {
    const response = await importRequest();
    expect(response.status).toBe(201);
    const result = await response.json<{ project: { name: string; isPublic: boolean; createdAt: string; coverObjectKey: string }; version: { versionNumber: number; originalFilename: string } }>();
    expect(result.project).toMatchObject({ name: "毛豆上货", isPublic: false, createdAt: "2026-08-07 17:14:07" });
    expect(result.version).toMatchObject({ versionNumber: 1, originalFilename: "store-binding_1.html" });
    expect(await testEnv.FILES.get(result.project.coverObjectKey)).not.toBeNull();

    const report = await adminApp.request("/api/migration/report", { headers: { Authorization: "Bearer migration-secret" } }, testEnv);
    expect(report.status).toBe(200);
    const body = await report.json<{ projects: { legacyId: string; title: string; group: string; isPublic: boolean; version: { fileSize: number; sha256: string } }[] }>();
    expect(body.projects[0]).toMatchObject({ legacyId: "a19ece02", title: "毛豆上货", group: "业务原型", isPublic: false });
    expect(body.projects[0]?.version.sha256).toHaveLength(64);
  });

  it("replays a legacy id without creating duplicate rows or objects", async () => {
    expect((await importRequest()).status).toBe(201);
    const replay = await importRequest();
    expect(replay.status).toBe(200);
    expect(replay.headers.get("Idempotent-Replay")).toBe("true");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>())?.count).toBe(1);
  });

  it("rejects a size mismatch and leaves no partial project", async () => {
    const response = await importRequest({ ...legacy, expected_size: 999 });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toBe("FILE_SIZE_MISMATCH");
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>())?.count).toBe(0);
  });
});
