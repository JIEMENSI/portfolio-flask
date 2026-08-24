import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { previewApp } from "../../src/preview/index";
import { ProjectRepository } from "../../src/shared/repository";
import type { Env } from "../../src/shared/types";
import { resetDatabase } from "../helpers/admin";

const testEnv = env as unknown as Env;

async function fixture(name: string, projectShareId: string, versionShareId: string, isPublic = true) {
  const repo = new ProjectRepository(testEnv.DB);
  const project = await repo.createProject({ name, isPublic, shareId: projectShareId });
  const objectKey = `fixtures/${versionShareId}.html`;
  await testEnv.FILES.put(objectKey, `<!doctype html><title>${name}</title>`);
  const version = await repo.createNextVersion(project.id, {
    shareId: versionShareId, changeNote: "首版", originalFilename: `${name}.html`, objectKey,
    fileSize: name.length, sha256: versionShareId.padEnd(64, "0").slice(0, 64),
    restoredFromVersionId: null, createdAt: new Date().toISOString()
  });
  return { project, version };
}

describe("preview access", () => {
  beforeEach(() => resetDatabase(testEnv));

  it("lists only active public projects", async () => {
    await fixture("公开项目", "public-project", "public-v1");
    await fixture("私有项目", "private-project", "private-v1", false);
    const archived = await fixture("已归档项目", "archived-project", "archived-v1");
    await new ProjectRepository(testEnv.DB).setStatus(archived.project.id, "archived");

    const response = await previewApp.request("/", {}, testEnv);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("公开项目");
    expect(html).not.toContain("私有项目");
    expect(html).not.toContain("已归档项目");
  });

  it("keeps the project link current and the version link pinned", async () => {
    const { project } = await fixture("版本项目", "version-project", "version-v1");
    const repo = new ProjectRepository(testEnv.DB);
    await testEnv.FILES.put("fixtures/version-v2.html", "<!doctype html><title>V2</title>");
    await repo.createNextVersion(project.id, {
      shareId: "version-v2", changeNote: "第二版", originalFilename: "v2.html", objectKey: "fixtures/version-v2.html",
      fileSize: 32, sha256: "2".repeat(64), restoredFromVersionId: null, createdAt: new Date().toISOString()
    });

    const projectPage = await previewApp.request("/p/version-project", {}, testEnv);
    expect(await projectPage.text()).toContain('/raw/version-v2');
    const pinnedPage = await previewApp.request("/v/version-v1", {}, testEnv);
    expect(await pinnedPage.text()).toContain('/raw/version-v1');
    const raw = await previewApp.request("/raw/version-v1", {}, testEnv);
    expect(await raw.text()).toContain("版本项目");
    expect(raw.headers.get("set-cookie")).toBeNull();
    expect(raw.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns the explicit permission page for every private link", async () => {
    await fixture("内部方案", "private-project", "private-v1", false);
    for (const path of ["/p/private-project", "/v/private-v1", "/raw/private-v1"]) {
      const response = await previewApp.request(path, {}, testEnv);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("无权限查看");
    }
    expect((await previewApp.request("/v/not-found", {}, testEnv)).status).toBe(404);
  });
});
