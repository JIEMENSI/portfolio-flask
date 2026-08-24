import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";

const load = (name: string) => readFile(new URL(`../../${name}`, import.meta.url), "utf8");
const execute = promisify(execFile);

test("admin and preview configs use distinct workers with shared production resources", async () => {
  const [admin, preview] = await Promise.all([load("wrangler.admin.toml"), load("wrangler.preview.toml")]);
  assert.match(admin, /name = "html-preview-admin"/);
  assert.match(preview, /name = "html-preview-public"/);
  for (const config of [admin, preview]) {
    assert.match(config, /database_name = "html-preview"/);
    assert.match(config, /bucket_name = "html-preview-files"/);
    assert.doesNotMatch(config, /local-placeholder|api[_-]?token|account[_-]?id/i);
  }
});

test("repository files contain no retired plaintext administrator credential", async () => {
  const readme = await load("README.md");
  assert.doesNotMatch(readme, /17671883601|zxcvbnm123/);
});

test("deployment renderer injects runtime bindings without changing tracked configs", async () => {
  await execute(process.execPath, ["scripts/render_deploy_configs.mjs"], {
    cwd: new URL("../..", import.meta.url),
    env: { ...process.env, CLOUDFLARE_D1_DATABASE_ID: "11111111-2222-3333-4444-555555555555", PREVIEW_WORKER_URL: "https://preview.example.com" }
  });
  const rendered = await load(".deploy/wrangler.admin.toml");
  assert.match(rendered, /database_id = "11111111-2222-3333-4444-555555555555"/);
  assert.match(rendered, /PREVIEW_BASE_URL = "https:\/\/preview.example.com"/);
});
