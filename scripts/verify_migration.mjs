#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith("--") ? [...pairs, [value.slice(2), all[index + 1]]] : pairs, []));
if (!args.manifest || !args["admin-url"]) {
  console.error("用法: node scripts/verify_migration.mjs --manifest <清单.json> --admin-url <地址>");
  process.exit(2);
}
const token = process.env.MIGRATION_TOKEN;
if (!token) throw new Error("请通过环境变量 MIGRATION_TOKEN 提供迁移令牌");
const local = JSON.parse(await readFile(args.manifest, "utf8"));
const response = await fetch(new URL("/api/migration/report", args["admin-url"]), { headers: { Authorization: `Bearer ${token}` } });
if (!response.ok) throw new Error(`读取远端迁移报告失败: ${response.status}`);
const remote = await response.json();
const remoteById = new Map(remote.projects.map((item) => [item.legacyId, item]));
const differences = [];
const compare = (id, field, actual, expected) => { if (actual !== expected) differences.push(`${id} ${field}: 本地=${JSON.stringify(expected)} 远端=${JSON.stringify(actual)}`); };
for (const project of local.projects) {
  const found = remoteById.get(project.legacyId);
  if (!found) { differences.push(`${project.legacyId}: 远端缺失`); continue; }
  compare(project.legacyId, "title", found.title, project.title);
  compare(project.legacyId, "description", found.description, project.description);
  compare(project.legacyId, "remark", found.remark, project.remark);
  compare(project.legacyId, "group", found.group, project.group);
  compare(project.legacyId, "isPublic", found.isPublic, project.isPublic);
  compare(project.legacyId, "createdAt", found.createdAt, project.createdAt);
  compare(project.legacyId, "html.fileSize", found.version.fileSize, project.html.fileSize);
  compare(project.legacyId, "html.sha256", found.version.sha256, project.html.sha256);
  compare(project.legacyId, "html.originalFilename", found.version.originalFilename, project.html.originalFilename);
  compare(project.legacyId, "cover.fileSize", found.cover?.fileSize ?? null, project.cover?.fileSize ?? null);
  compare(project.legacyId, "cover.sha256", found.cover?.sha256 ?? null, project.cover?.sha256 ?? null);
  remoteById.delete(project.legacyId);
}
for (const id of remoteById.keys()) differences.push(`${id}: 远端存在但本地清单没有`);
if (differences.length) {
  console.error(`校验失败，共 ${differences.length} 项差异：`);
  for (const difference of differences) console.error(`- ${difference}`);
  process.exit(1);
}
console.log(`校验通过：${local.projects.length} 个项目，元数据、文件大小与 SHA-256 全部一致。`);
