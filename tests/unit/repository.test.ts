import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectRepository } from "../../src/shared/repository";
import type { Env } from "../../src/shared/types";

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {}
}

const versionInput = (filename: string) => ({
  shareId: `share-${filename}`,
  changeNote: "",
  originalFilename: filename,
  objectKey: `objects/${filename}`,
  fileSize: 18,
  sha256: "a".repeat(64),
  restoredFromVersionId: null,
  createdAt: "2026-08-21T00:00:00.000Z"
});

const schemaSql = `CREATE TABLE projects (id TEXT PRIMARY KEY, share_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', remark TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '未分组', cover_object_key TEXT, is_public INTEGER NOT NULL, current_version_id TEXT, next_version_number INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trashed_at TEXT);
CREATE TABLE versions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, share_id TEXT NOT NULL UNIQUE, version_number INTEGER NOT NULL, change_note TEXT NOT NULL DEFAULT '', original_filename TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, file_size INTEGER NOT NULL, sha256 TEXT NOT NULL, restored_from_version_id TEXT, created_at TEXT NOT NULL, deleted_at TEXT, UNIQUE(project_id, version_number), FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE);`;

const testEnv = env as unknown as Env;

describe("ProjectRepository", () => {
  beforeEach(async () => {
    await testEnv.DB.exec("PRAGMA foreign_keys = OFF;\nDROP TABLE IF EXISTS audit_logs;\nDROP TABLE IF EXISTS idempotency_keys;\nDROP TABLE IF EXISTS admin_sessions;\nDROP TABLE IF EXISTS versions;\nDROP TABLE IF EXISTS projects;\nPRAGMA foreign_keys = ON;");
    await testEnv.DB.exec(schemaSql);
  });

  it("allocates sequential versions and advances the current version", async () => {
    const repo = new ProjectRepository(testEnv.DB);
    const project = await repo.createProject({ name: "结算页", isPublic: true });

    const v1 = await repo.createNextVersion(project.id, versionInput("a.html"));
    const v2 = await repo.createNextVersion(project.id, versionInput("b.html"));

    expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
    expect((await repo.getProject(project.id))?.currentVersionId).toBe(v2.id);
  });

  it("lists only active public projects", async () => {
    const repo = new ProjectRepository(testEnv.DB);
    const visible = await repo.createProject({ name: "公开", isPublic: true });
    await repo.createProject({ name: "私有", isPublic: false });
    const archived = await repo.createProject({ name: "归档", isPublic: true });
    await repo.archiveProject(archived.id);

    const projects = await repo.listPublicProjects();

    expect(projects.map((project) => project.id)).toEqual([visible.id]);
  });
});
