#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
const previewUrl = process.env.PREVIEW_WORKER_URL;
if (!databaseId || !/^[0-9a-f-]{36}$/i.test(databaseId)) throw new Error("CLOUDFLARE_D1_DATABASE_ID 缺失或格式无效");
if (!previewUrl || !/^https:\/\//i.test(previewUrl)) throw new Error("PREVIEW_WORKER_URL 必须是 HTTPS 地址");
await mkdir(".deploy", { recursive: true });
for (const name of ["wrangler.admin.toml", "wrangler.preview.toml"]) {
  const source = await readFile(name, "utf8");
  const rendered = source.replaceAll("D1_DATABASE_ID", databaseId).replaceAll("PREVIEW_WORKER_URL", previewUrl);
  await writeFile(path.join(".deploy", name), rendered, "utf8");
}
console.log("已生成生产部署配置");
