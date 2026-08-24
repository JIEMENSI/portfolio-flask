#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildLegacyManifest } from "./legacy_manifest.mjs";

function options(argv) {
  const result = { dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") result.dryRun = true;
    else if (argv[i]?.startsWith("--")) result[argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return result;
}

const args = options(process.argv);
if (!args.source || !args.report || (!args.dryRun && !args.adminUrl)) {
  console.error("用法: node scripts/migrate_pythonanywhere.mjs --source <备份目录> --report <仓库外报告.json> [--admin-url <地址>] [--dry-run]");
  process.exit(2);
}
const manifest = await buildLegacyManifest(args.source);
await mkdir(path.dirname(path.resolve(args.report)), { recursive: true });
await writeFile(args.report, JSON.stringify(manifest, null, 2), "utf8");
for (const warning of manifest.warnings) console.warn(`警告: ${warning}`);
if (manifest.errors.length) {
  for (const error of manifest.errors) console.error(`错误: ${error}`);
  process.exit(1);
}
if (args.dryRun) {
  console.log(`检查完成：${manifest.projects.length} 个项目，未上传；清单已写入 ${path.resolve(args.report)}`);
  process.exit(0);
}
const token = process.env.MIGRATION_TOKEN;
if (!token) throw new Error("请通过环境变量 MIGRATION_TOKEN 提供迁移令牌");
const results = [];
for (const project of manifest.projects) {
  const metadata = {
    id: project.legacyId, title: project.title, description: project.description, remark: project.remark,
    group: project.group, filename: project.html.filename, original_name: project.html.originalFilename,
    cover: project.cover?.filename || "", is_public: project.isPublic, created_at: project.createdAt,
    expected_size: project.html.fileSize, expected_sha256: project.html.sha256
  };
  const form = new FormData();
  form.set("metadata", JSON.stringify(metadata));
  form.set("html", new File([await import("node:fs/promises").then(({ readFile }) => readFile(project.html.path))], project.html.filename, { type: "text/html" }));
  if (project.cover) form.set("cover", new File([await import("node:fs/promises").then(({ readFile }) => readFile(project.cover.path))], project.cover.filename));
  const response = await fetch(new URL("/api/migration/import", args.adminUrl), { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
  const body = await response.json();
  if (!response.ok) throw new Error(`${project.legacyId} 迁移失败: ${body.error || response.status}`);
  results.push({ legacyId: project.legacyId, status: response.headers.get("Idempotent-Replay") ? "replayed" : "imported" });
  console.log(`${project.legacyId}: ${results.at(-1).status}`);
}
manifest.migration = { completedAt: new Date().toISOString(), adminUrl: args.adminUrl, results };
await writeFile(args.report, JSON.stringify(manifest, null, 2), "utf8");
console.log(`迁移完成：${results.length} 个项目。请继续运行独立校验器。`);
