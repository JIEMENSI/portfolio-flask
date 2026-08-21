import { describe, expect, it } from "vitest";
import { adminApp } from "../../src/admin/index";
import { previewApp } from "../../src/preview/index";
import type { Env } from "../../src/shared/types";

const env = {} as Env;

describe("worker health endpoints", () => {
  it.each([
    ["admin", adminApp],
    ["preview", previewApp]
  ])("reports that the %s worker is healthy", async (_name, app) => {
    const response = await app.request("/health", {}, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });
});
