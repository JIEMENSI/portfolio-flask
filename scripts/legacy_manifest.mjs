import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const hashFile = async (filename) => createHash("sha256").update(await readFile(filename)).digest("hex");

async function fileInfo(filename, originalFilename) {
  const details = await stat(filename);
  return { path: filename, filename: path.basename(filename), originalFilename, fileSize: details.size, sha256: await hashFile(filename) };
}

export async function buildLegacyManifest(sourceRoot) {
  const worksPath = path.join(sourceRoot, "data", "works.json");
  const works = JSON.parse(await readFile(worksPath, "utf8"));
  if (!Array.isArray(works)) throw new Error("works.json 必须是数组");
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const projects = [];
  const referencedHtml = new Set();

  for (const work of works) {
    const legacyId = String(work.id ?? "").trim();
    if (!legacyId) { errors.push("发现缺少 id 的作品"); continue; }
    if (seen.has(legacyId)) { errors.push(`重复作品 id: ${legacyId}`); continue; }
    seen.add(legacyId);
    const htmlName = String(work.filename || `${legacyId}.html`);
    const htmlPath = path.join(sourceRoot, "static", "uploads", htmlName);
    referencedHtml.add(htmlName.toLowerCase());
    let html;
    try { html = await fileInfo(htmlPath, String(work.original_name || htmlName)); }
    catch { errors.push(`缺少 HTML: ${htmlName}`); continue; }
    let cover = null;
    if (work.cover) {
      const coverPath = path.join(sourceRoot, "static", "covers", String(work.cover));
      try { cover = await fileInfo(coverPath, String(work.cover)); }
      catch { errors.push(`缺少封面: ${work.cover}`); }
    }
    projects.push({
      legacyId, title: String(work.title || legacyId), description: String(work.description || ""),
      remark: String(work.remark || ""), group: String(work.group || "未分组"),
      isPublic: work.is_public !== false, createdAt: String(work.created_at || ""), html, cover
    });
  }

  const uploadsDir = path.join(sourceRoot, "static", "uploads");
  for (const name of await readdir(uploadsDir).catch(() => [])) {
    if (/\.html?$/i.test(name) && !referencedHtml.has(name.toLowerCase())) warnings.push(`未被 works.json 引用的 HTML: ${name}`);
  }
  return { generatedAt: new Date().toISOString(), sourceRoot: path.resolve(sourceRoot), projects, errors, warnings };
}
