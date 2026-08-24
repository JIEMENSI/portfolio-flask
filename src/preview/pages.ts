import type { Project, Version } from "../shared/types";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]!);

const document = (title: string, body: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/assets/styles.css"></head><body>${body}</body></html>`;

export const PUBLIC_CSS = `
:root{color-scheme:light;font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;color:#172033;background:#f5f7fb}
*{box-sizing:border-box}body{margin:0}a{color:inherit}.wrap{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:44px 0}
h1{margin:0 0 12px;font-size:clamp(28px,5vw,48px)}.muted{color:#68728a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:28px}
.card{display:block;padding:22px;border:1px solid #e1e5ee;border-radius:16px;background:#fff;text-decoration:none;box-shadow:0 8px 28px #1720330a}.card:hover{border-color:#6e7df2}
.preview{display:grid;grid-template-rows:auto 1fr;height:100vh;background:#fff}.bar{padding:12px 18px;border-bottom:1px solid #e1e5ee}.bar strong{margin-right:10px}
iframe{width:100%;height:100%;border:0;background:#fff}.state{min-height:100vh;display:grid;place-content:center;text-align:center;padding:24px}.state h1{font-size:34px}
`;

export function galleryPage(projects: Project[]): string {
  const cards = projects.map((project) => `<a class="card" href="/p/${encodeURIComponent(project.shareId)}"><strong>${escapeHtml(project.name)}</strong><p class="muted">${escapeHtml(project.description || "点击查看最新版本")}</p></a>`).join("");
  return document("HTML 预览", `<main class="wrap"><h1>HTML 预览</h1><p class="muted">打开项目即可查看最新版本</p><section class="grid">${cards || '<p class="muted">暂无公开项目</p>'}</section></main>`);
}

export function previewPage(project: Project, version: Version): string {
  return document(project.name, `<main class="preview"><header class="bar"><strong>${escapeHtml(project.name)}</strong><span class="muted">V${version.versionNumber} · ${escapeHtml(version.changeNote || "无版本说明")}</span></header><iframe title="${escapeHtml(project.name)}" sandbox="allow-scripts allow-forms allow-modals allow-popups" src="/raw/${encodeURIComponent(version.shareId)}"></iframe></main>`);
}

export const forbiddenPage = () => document("无权限查看", '<main class="state"><div><h1>无权限查看</h1><p class="muted">该内容未公开，或分享权限已被关闭。</p></div></main>');
export const notFoundPage = () => document("页面不存在", '<main class="state"><div><h1>页面不存在</h1><p class="muted">链接可能有误或版本已被删除。</p></div></main>');
