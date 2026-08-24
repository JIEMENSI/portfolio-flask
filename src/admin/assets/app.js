const $ = (selector) => document.querySelector(selector);
let csrfToken = sessionStorage.getItem("csrfToken") || "";
let projects = [];
let filter = "active";

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (csrfToken) headers.set("X-CSRF-Token", csrfToken);
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) showLogin();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "操作失败");
  return body;
}

function showLogin() { $("#login").classList.remove("hidden"); $("#app").classList.add("hidden"); }
function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); loadProjects(); }
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const formatSize = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

async function loadProjects() {
  try { projects = (await api("/api/projects")).projects; renderProjects(); } catch (error) { if (csrfToken) alert(error.message); }
}
function renderProjects() {
  const visible = projects.filter((project) => project.status === filter);
  $("#projects").innerHTML = visible.map((project) => `<article class="card" data-id="${project.id}"><span class="badge">${project.isPublic ? "公开" : "私有"}</span><h3>${escapeHtml(project.name)}</h3><p class="muted">${escapeHtml(project.description || "暂无说明")}</p><small>已保留 ${project.nextVersionNumber - 1} 个版本</small></article>`).join("") || '<p class="muted">这里还没有项目。</p>';
}

async function openProject(id) {
  const { project, versions, previewBaseUrl } = await api(`/api/projects/${id}`);
  $("#detail").innerHTML = `<div class="detail-head"><div><h2>${escapeHtml(project.name)}</h2><p class="muted">项目链接会始终展示最新版</p></div><div class="actions"><button class="ghost" data-copy="${previewBaseUrl}/p/${project.shareId}">复制项目链接</button><button class="ghost" data-visibility="${!project.isPublic}">${project.isPublic ? "设为私有" : "设为公开"}</button></div></div><label class="drop">上传新 HTML 版本<input id="version-file" type="file" accept=".html,.htm,text/html"><input id="change-note" placeholder="本次改了什么（可选）"></label><section>${versions.map((version) => `<article class="version"><span class="version-number">V${version.versionNumber}</span><div><strong>${escapeHtml(version.changeNote || version.originalFilename)}</strong><small>${formatSize(version.fileSize)} · ${version.sha256.slice(0, 12)}…</small></div><div class="actions"><button class="ghost" data-copy="${previewBaseUrl}/v/${version.shareId}">复制本版本链接</button>${project.currentVersionId !== version.id ? `<button class="ghost" data-restore="${version.versionNumber}">恢复为新版</button>` : '<span class="badge">当前版本</span>'}</div></article>`).join("")}</section>`;
  $("#version-file").addEventListener("change", async (event) => {
    const file = event.target.files[0]; if (!file) return;
    const form = new FormData(); form.set("html", file); form.set("changeNote", $("#change-note").value);
    try { await api(`/api/projects/${id}/versions`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() }, body: form }); await loadProjects(); await openProject(id); } catch (error) { alert(error.message); }
  });
  $("#detail").onclick = async (event) => {
    const button = event.target.closest("button"); if (!button) return;
    if (button.dataset.copy) await copy(button.dataset.copy, button);
    if (button.dataset.visibility) { await api(`/api/projects/${id}/visibility`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isPublic: button.dataset.visibility === "true" }) }); await loadProjects(); await openProject(id); }
    if (button.dataset.restore) { await api(`/api/projects/${id}/versions/${button.dataset.restore}/restore`, { method: "POST" }); await loadProjects(); await openProject(id); }
  };
}
async function copy(text, button) { try { await navigator.clipboard.writeText(text); } catch { const input = document.createElement("textarea"); input.value = text; document.body.append(input); input.select(); document.execCommand("copy"); input.remove(); } const old = button.textContent; button.textContent = "已复制"; setTimeout(() => button.textContent = old, 1200); }

$("#login-form").addEventListener("submit", async (event) => { event.preventDefault(); try { const result = await api("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("#password").value }) }); csrfToken = result.csrfToken; sessionStorage.setItem("csrfToken", csrfToken); showApp(); } catch (error) { $("#login-error").textContent = error.message; } });
$("#projects").addEventListener("click", (event) => { const card = event.target.closest("[data-id]"); if (card) openProject(card.dataset.id); });
$("#filters").addEventListener("click", (event) => { const button = event.target.closest("button"); if (!button) return; filter = button.dataset.filter; $("#filters .selected")?.classList.remove("selected"); button.classList.add("selected"); renderProjects(); $("#detail").innerHTML = ""; });
$("#new-project").onclick = () => $("#project-dialog").showModal();
$("#project-form").addEventListener("submit", async (event) => { if (event.submitter?.value === "cancel") return; event.preventDefault(); const data = new FormData(event.currentTarget); const project = await api("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: data.get("name"), description: data.get("description"), isPublic: data.get("isPublic") === "on" }) }); $("#project-dialog").close(); event.currentTarget.reset(); await loadProjects(); await openProject(project.id); });
$("#logout").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); csrfToken = ""; sessionStorage.removeItem("csrfToken"); showLogin(); };
if (csrfToken) showApp(); else showLogin();
