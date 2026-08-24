import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getStoredBytes, putVersionObject, validateHtml } from "../../src/shared/storage";
import type { Env } from "../../src/shared/types";

const testEnv = env as unknown as Env;

describe("HTML storage", () => {
  it("rejects files larger than 16 MiB", async () => {
    const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], "large.html", { type: "text/html" });

    await expect(validateHtml(file)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("rejects a non-HTML extension", async () => {
    const file = new File(["<!doctype html><title>x</title>"], "page.txt");

    await expect(validateHtml(file)).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
  });

  it("stores content under a unique immutable key with a SHA-256 digest", async () => {
    const file = new File(["<!doctype html><title>x</title>"], "page.html", { type: "text/html" });
    const validated = await validateHtml(file);

    const stored = await putVersionObject(testEnv.FILES, "project-1", "version-1", validated);
    const bytes = await getStoredBytes(testEnv.FILES, stored.objectKey);

    expect(stored.objectKey).toMatch(/^projects\/project-1\/versions\/version-1\/[a-f0-9]{32}\.html$/);
    expect(stored.sha256).toHaveLength(64);
    expect(new TextDecoder().decode(bytes!)).toBe("<!doctype html><title>x</title>");
  });
});
