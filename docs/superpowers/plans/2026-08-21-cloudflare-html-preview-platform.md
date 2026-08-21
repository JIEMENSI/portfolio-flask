# Cloudflare HTML Preview Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Flask portfolio with a Cloudflare-hosted HTML project and immutable version platform, then migrate all authoritative PythonAnywhere data without loss.

**Architecture:** A TypeScript monorepo deploys separate Admin and Preview Workers so uploaded HTML never receives the admin session cookie. Both Workers share D1 metadata and R2 objects; the Admin Worker owns authenticated mutations, while the Preview Worker serves the public gallery, version shells, and raw HTML after project-level authorization.

**Tech Stack:** TypeScript 5, Cloudflare Workers, Hono, D1, R2, Web Crypto, Vitest, Wrangler, Playwright, Node.js 22

**Spec:** `docs/superpowers/specs/2026-08-21-html-preview-platform-design.md`

## Global Constraints

- Accept exactly one `.html` or `.htm` file per upload, non-empty, maximum 16 MiB.
- Versions are immutable; restore creates the next version and never overwrites an R2 object.
- Public projects are anonymously viewable; private project and version links return HTTP 403 with “无权限查看”.
- Project and version share IDs are cryptographically random and non-enumerable.
- Admin and Preview Workers use separate hostnames; no admin cookie is sent to preview content.
- Management mutations require an authenticated session and CSRF token.
- PythonAnywhere online files are the migration authority; local ignored files are not authoritative.
- Secrets, production data, cookies, archives, and Cloudflare credentials must never enter Git.
- Existing user change `data/visitors.json` must remain untouched.

## Planned File Structure

```text
package.json                         workspace scripts and pinned dependencies
tsconfig.json                        shared strict TypeScript configuration
vitest.config.ts                     Workers test configuration
wrangler.admin.toml                  Admin Worker bindings and assets
wrangler.preview.toml                Preview Worker bindings and assets
migrations/0001_initial.sql          D1 schema and indexes
src/shared/types.ts                  binding, entity, and DTO contracts
src/shared/ids.ts                    random share/session/CSRF identifiers
src/shared/repository.ts             all D1 queries and transactions
src/shared/storage.ts                immutable R2 object operations
src/shared/responses.ts              error and security response helpers
src/admin/index.ts                   Admin Worker router
src/admin/auth.ts                    password, session, cookie, CSRF logic
src/admin/projects.ts                project lifecycle endpoints
src/admin/versions.ts                upload, restore, and version deletion
src/admin/assets/*                   admin HTML, CSS, and browser JS
src/preview/index.ts                 Preview Worker router
src/preview/pages.ts                 gallery, shell, 403, 404 rendering
src/preview/assets/*                 public CSS and browser JS
scripts/migrate_pythonanywhere.mjs    manifest-driven legacy importer
scripts/verify_migration.mjs         count, size, and SHA-256 verifier
tests/unit/*                         pure and repository unit tests
tests/integration/*                  Worker request and binding tests
tests/e2e/*                          browser acceptance tests
.github/workflows/deploy.yml         tested main-branch deployment
README.md                            local setup, deploy, migration, recovery
```

---

### Task 1: Worker Workspace and Test Harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `wrangler.admin.toml`, `wrangler.preview.toml`
- Create: `src/shared/types.ts`, `src/admin/index.ts`, `src/preview/index.ts`
- Test: `tests/integration/health.test.ts`

**Interfaces:**
- Produces: `Env`, `Project`, `Version`, `adminApp`, and `previewApp` used by all later tasks.

- [ ] **Step 1: Write failing health tests**

```ts
it.each([adminApp, previewApp])("returns health status", async (app) => {
  const response = await app.request("/health", {}, env);
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/integration/health.test.ts`
Expected: FAIL because workspace modules do not exist.

- [ ] **Step 3: Add strict workspace, Hono apps, and bindings**

Define `Env` with `DB: D1Database`, `FILES: R2Bucket`, `ADMIN_PASSWORD_HASH: string`, `SESSION_PEPPER: string`, and optional `MIGRATION_TOKEN`. Add only `/health` to both apps. Configure both Wrangler files to bind the same D1 database and R2 bucket while deploying distinct Worker names.

- [ ] **Step 4: Run tests and typecheck**

Run: `npm test -- tests/integration/health.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts wrangler.*.toml src tests/integration/health.test.ts
git commit -m "build: scaffold Cloudflare worker workspace"
```

### Task 2: D1 Schema and Repository

**Files:**
- Create: `migrations/0001_initial.sql`
- Create: `src/shared/repository.ts`
- Test: `tests/unit/repository.test.ts`

**Interfaces:**
- Consumes: `Env`, `Project`, `Version` from `src/shared/types.ts`.
- Produces: `ProjectRepository` methods `createProject`, `getProjectByShareId`, `listPublicProjects`, `createNextVersion`, `setVisibility`, `trashProject`, `restoreProject`, and `purgeProject`.

- [ ] **Step 1: Write failing repository tests**

```ts
it("allocates unique sequential versions atomically", async () => {
  const project = await repo.createProject({ name: "结算页", isPublic: true });
  const v1 = await repo.createNextVersion(project.id, versionInput("a.html"));
  const v2 = await repo.createNextVersion(project.id, versionInput("b.html"));
  expect([v1.versionNumber, v2.versionNumber]).toEqual([1, 2]);
  expect((await repo.getProject(project.id))?.currentVersionId).toBe(v2.id);
});
```

Also test public listing excludes private, archived, and trashed projects; project and version share IDs are unique; and project status transitions preserve rows.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/unit/repository.test.ts`
Expected: FAIL because schema and repository are absent.

- [ ] **Step 3: Implement schema and explicit repository queries**

Create `projects`, `versions`, `admin_sessions`, `idempotency_keys`, and `audit_logs` tables with foreign keys and indexes. Use D1 batch/transaction-safe statements so version number allocation and current version update cannot diverge. Never expose numeric IDs in public URLs.

- [ ] **Step 4: Run repository tests**

Run: `npm test -- tests/unit/repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations src/shared/repository.ts tests/unit/repository.test.ts
git commit -m "feat: add project and version repository"
```

### Task 3: Immutable R2 Storage and Upload Validation

**Files:**
- Create: `src/shared/storage.ts`, `src/shared/ids.ts`
- Test: `tests/unit/storage.test.ts`

**Interfaces:**
- Produces: `validateHtml(file): Promise<ValidatedHtml>`, `putVersionObject(bucket, projectId, versionId, html)`, `copyVersionObject`, `deleteObjects`, and `randomShareId()`.

- [ ] **Step 1: Write validation and immutability tests**

```ts
it("rejects an oversized HTML upload", async () => {
  const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], "large.html");
  await expect(validateHtml(file)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
});

it("stores content under a never-reused key with SHA-256", async () => {
  const result = await putVersionObject(bucket, "p1", "v1", validated);
  expect(result.objectKey).toMatch(/^projects\/p1\/versions\/v1\//);
  expect(result.sha256).toHaveLength(64);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/unit/storage.test.ts`
Expected: FAIL because storage helpers are absent.

- [ ] **Step 3: Implement validation and R2 operations**

Check filename extension, byte length, non-empty content, and basic HTML markers. Generate an unpredictable object suffix and write `Content-Type: text/html; charset=utf-8`, original filename, and SHA-256 as metadata. Do not implement overwrite APIs.

- [ ] **Step 4: Run storage tests**

Run: `npm test -- tests/unit/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/storage.ts src/shared/ids.ts tests/unit/storage.test.ts
git commit -m "feat: add immutable HTML object storage"
```

### Task 4: Administrator Authentication and CSRF

**Files:**
- Create: `src/admin/auth.ts`, `src/shared/responses.ts`
- Modify: `src/admin/index.ts`
- Test: `tests/integration/auth.test.ts`

**Interfaces:**
- Produces: `requireAdmin`, `requireCsrf`, `/api/auth/login`, `/api/auth/logout`, and `/api/auth/session`.

- [ ] **Step 1: Write authentication tests**

```ts
it("sets a secure admin-only session cookie", async () => {
  const response = await adminApp.request("/api/auth/login", postJson({ password: "correct" }), env);
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toMatch(/HttpOnly;.*Secure;.*SameSite=Strict/);
});

it("rejects mutation without CSRF", async () => {
  const response = await adminApp.request("/api/projects", { method: "POST", headers: sessionHeaders });
  expect(response.status).toBe(403);
});
```

Also test invalid passwords, expired sessions, logout, rate limiting, token hashing, and that raw tokens are never stored in D1.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/integration/auth.test.ts`
Expected: FAIL because auth routes are absent.

- [ ] **Step 3: Implement Web Crypto authentication**

Verify the configured PBKDF2 password hash with constant-time comparison, create a random session token, store only its peppered SHA-256 hash, and issue a `__Host-admin_session` cookie. Return a session-bound CSRF token and require it in `X-CSRF-Token` on mutations. Add a bounded login-attempt limiter.

- [ ] **Step 4: Run auth tests**

Run: `npm test -- tests/integration/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/auth.ts src/shared/responses.ts src/admin/index.ts tests/integration/auth.test.ts
git commit -m "feat: secure administrator sessions"
```

### Task 5: Project Lifecycle API

**Files:**
- Create: `src/admin/projects.ts`
- Modify: `src/admin/index.ts`
- Test: `tests/integration/projects.test.ts`

**Interfaces:**
- Produces: authenticated JSON endpoints for list, get, edit, visibility, archive, trash, restore, and purge.

- [ ] **Step 1: Write lifecycle tests**

```ts
it("makes existing share links inaccessible after privacy change", async () => {
  await setVisibility(project.id, false, adminHeaders);
  const response = await previewApp.request(`/p/${project.shareId}`, {}, env);
  expect(response.status).toBe(403);
});
```

Test active/archive/trash filters, 30-day age reporting, restore, purge summary, missing project, CSRF, and audit entries.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/integration/projects.test.ts`
Expected: FAIL because project routes are absent.

- [ ] **Step 3: Implement lifecycle endpoints**

Use explicit status transitions. Purge must first return the version count and total bytes for confirmation, then delete all R2 keys and D1 rows only after a second request containing the confirmation nonce.

- [ ] **Step 4: Run lifecycle tests**

Run: `npm test -- tests/integration/projects.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/projects.ts src/admin/index.ts tests/integration/projects.test.ts
git commit -m "feat: add project lifecycle API"
```

### Task 6: Version Upload, Restore, and Delete API

**Files:**
- Create: `src/admin/versions.ts`
- Modify: `src/admin/index.ts`
- Test: `tests/integration/versions.test.ts`

**Interfaces:**
- Produces: `POST /api/projects/:id/versions`, `POST /api/projects/:id/versions/:version/restore`, and safe version deletion endpoints.

- [ ] **Step 1: Write version behavior tests**

```ts
it("restores V1 by creating V3 with identical content", async () => {
  const restored = await restoreVersion(project.id, 1, adminHeaders);
  expect(restored.versionNumber).toBe(3);
  expect(restored.restoredFromVersionId).toBe(v1.id);
  expect(restored.sha256).toBe(v1.sha256);
});
```

Test sequential numbering, immutable old objects, idempotency key replay, cleanup after D1 failure, missing R2 source, current-version deletion rejection, and two-phase historical deletion.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/integration/versions.test.ts`
Expected: FAIL because version routes are absent.

- [ ] **Step 3: Implement upload and restore orchestration**

Validate first, reserve the next version, upload to a unique R2 key, and commit metadata. Cache successful upload response by `Idempotency-Key`. Restore uses R2 copy and creates a normal next version with `restored_from_version_id`.

- [ ] **Step 4: Run version tests**

Run: `npm test -- tests/integration/versions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/admin/versions.ts src/admin/index.ts tests/integration/versions.test.ts
git commit -m "feat: add immutable version workflows"
```

### Task 7: Preview Worker, Gallery, and Permission Pages

**Files:**
- Create: `src/preview/pages.ts`, `src/preview/assets/styles.css`
- Modify: `src/preview/index.ts`
- Test: `tests/integration/preview.test.ts`

**Interfaces:**
- Produces: `/`, `/p/:shareId`, `/v/:shareId`, `/raw/:shareId`, 403, and 404 responses.

- [ ] **Step 1: Write preview access matrix tests**

```ts
it.each([
  ["public project", publicProjectUrl, 200],
  ["private project", privateProjectUrl, 403],
  ["private version", privateVersionUrl, 403],
  ["missing version", "/v/not-found", 404],
])("handles %s", async (_name, path, status) => {
  expect((await previewApp.request(path, {}, env)).status).toBe(status);
});
```

Test that the gallery excludes private/archived/trashed projects, project links resolve current version, version links remain pinned, and raw HTML has no admin cookie or management CORS permission.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/integration/preview.test.ts`
Expected: FAIL because preview routes are absent.

- [ ] **Step 3: Implement public pages and raw delivery**

Render a lightweight shell with project/version metadata and a sandboxed iframe pointing to `/raw/:shareId`. Return the raw R2 object only after rechecking project status and visibility. Use separate preview hostname configuration and appropriate CSP/security headers.

- [ ] **Step 4: Run preview tests**

Run: `npm test -- tests/integration/preview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preview tests/integration/preview.test.ts
git commit -m "feat: serve public and private preview pages"
```

### Task 8: Admin Dashboard UI

**Files:**
- Create: `src/admin/assets/index.html`, `src/admin/assets/app.js`, `src/admin/assets/styles.css`
- Modify: `src/admin/index.ts`, `wrangler.admin.toml`
- Test: `tests/e2e/admin.spec.ts`

**Interfaces:**
- Consumes: Tasks 4–6 Admin JSON APIs.
- Produces: browser flows for login, project list/detail, create/upload, copy links, visibility, archive, trash, restore, and purge.

- [ ] **Step 1: Write failing browser acceptance test**

```ts
test("creates a project and uploads V2", async ({ page }) => {
  await login(page);
  await createProject(page, "支付页", "fixtures/v1.html");
  await uploadVersion(page, "支付页", "fixtures/v2.html", "调整按钮");
  await expect(page.getByText("V2")).toBeVisible();
  await expect(page.getByRole("button", { name: "复制本版本链接" })).toBeVisible();
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npm run test:e2e -- tests/e2e/admin.spec.ts`
Expected: FAIL because dashboard assets are absent.

- [ ] **Step 3: Implement responsive dashboard**

Reuse the existing Chinese visual language where practical. Organize by projects, render version timelines, show file size/hash/change note, and require visible confirmation dialogs for destructive actions. Use `navigator.clipboard` with a text-selection fallback.

- [ ] **Step 4: Run E2E and accessibility checks**

Run: `npm run test:e2e -- tests/e2e/admin.spec.ts`
Expected: PASS on desktop and mobile viewports with no serious accessibility violations.

- [ ] **Step 5: Commit**

```bash
git add src/admin/assets src/admin/index.ts wrangler.admin.toml tests/e2e/admin.spec.ts
git commit -m "feat: build project administration dashboard"
```

### Task 9: PythonAnywhere Migration and Verification Tools

**Files:**
- Create: `scripts/migrate_pythonanywhere.mjs`, `scripts/verify_migration.mjs`
- Modify: `src/admin/index.ts`
- Test: `tests/integration/migration.test.ts`, `tests/fixtures/legacy/*`

**Interfaces:**
- Produces: one-time `POST /api/migration/import` protected by `MIGRATION_TOKEN`; CLI reads an extracted legacy directory and emits `migration-report.json` outside Git.

- [ ] **Step 1: Write fixture migration tests**

```ts
it("preserves legacy metadata and visibility as V1", async () => {
  const result = await importLegacy(fixture("works.json"), fixtureFiles, env);
  expect(result.projects[0]).toMatchObject({ name: "毛豆上货", isPublic: true });
  expect(result.projects[0].versions[0].versionNumber).toBe(1);
});
```

Test missing files, extra files, duplicate IDs, cover migration, created time preservation, private status, size/hash mismatch, rerun idempotency, and failure reports.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- tests/integration/migration.test.ts`
Expected: FAIL because importer is absent.

- [ ] **Step 3: Implement manifest-driven importer**

The CLI reads `data/works.json`, resolves `static/uploads` and `static/covers`, computes local counts/sizes/SHA-256, and sends one multipart import at a time with a stable legacy idempotency key. The endpoint exists only when `MIGRATION_TOKEN` is configured and never accepts a browser cookie as migration authority.

- [ ] **Step 4: Implement independent verifier**

Fetch the admin migration report endpoint, compare remote D1/R2 metadata with the local manifest, print per-item differences, and exit nonzero on any count, size, hash, title, timestamp, group, or visibility mismatch.

- [ ] **Step 5: Run migration tests**

Run: `npm test -- tests/integration/migration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts src/admin/index.ts tests/integration/migration.test.ts tests/fixtures/legacy
git commit -m "feat: add verified legacy data migration"
```

### Task 10: Deployment Pipeline and Operations Documentation

**Files:**
- Create: `.github/workflows/deploy.yml`
- Modify: `README.md`, `.gitignore`, `package.json`
- Test: `.github/workflows/deploy.yml` via local lint and GitHub Actions dry validation

**Interfaces:**
- Produces: main-branch test gate and sequential Admin/Preview deployment; documented setup and rollback commands.

- [ ] **Step 1: Add deployment contract tests**

Create `tests/unit/config.test.ts` that loads both Wrangler configs and asserts distinct Worker names, shared D1/R2 binding names, no literal account secrets, compatibility dates, and production routes supplied only through environment configuration.

- [ ] **Step 2: Run test and verify failure**

Run: `npm test -- tests/unit/config.test.ts`
Expected: FAIL until production-safe configs are complete.

- [ ] **Step 3: Add GitHub Actions deployment**

On pushes to `main`, run install, typecheck, unit/integration tests, and build before deployment. Deploy Admin then Preview with scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets. Never run migration automatically.

- [ ] **Step 4: Rewrite README operations guide**

Document local setup, D1 migration, R2 creation, secret generation, two Worker URLs, test commands, manual deployment, GitHub secrets, PythonAnywhere backup, migration dry-run, verification, rollback, and post-migration secret removal.

- [ ] **Step 5: Run full local quality gate**

Run: `npm ci && npm run typecheck && npm test && npm run build`
Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add .github README.md .gitignore package.json tests/unit/config.test.ts wrangler.*.toml
git commit -m "ci: add tested Cloudflare deployment pipeline"
```

### Task 11: Production Authorization, Deployment, and Data Cutover

**Files:**
- No source changes expected; generated archives and reports stay outside the repository.

**Interfaces:**
- Consumes: tested main branch, Cloudflare account authorization, GitHub authorization, and logged-in PythonAnywhere browser session.
- Produces: deployed Workers, verified migrated data, and a retained rollback package.

- [ ] **Step 1: Verify source and secret hygiene**

Run: `git status --short && git log --oneline -10 && git grep -n -I -E "(api[_-]?token|account[_-]?id|password|session.*=)" -- ':!docs/**'`
Expected: only known non-secret examples; `data/visitors.json` remains an unrelated local change and is not committed.

- [ ] **Step 2: Obtain official account authorization**

The user signs in through official GitHub, Cloudflare, and PythonAnywhere pages. Do not request or accept passwords in chat. Configure least-privilege GitHub and Cloudflare tokens through their secret UIs.

- [ ] **Step 3: Deploy an isolated Cloudflare staging environment**

Create staging D1/R2 resources, apply `0001_initial.sql`, configure password/session secrets, deploy both Workers, and run the complete E2E suite against staging.

- [ ] **Step 4: Back up authoritative PythonAnywhere data**

Pause uploads and create a timestamped archive containing `data/`, `static/uploads/`, `static/covers/`, and `static/avatars/`; back up `config.local.json` separately. Download both to a non-repository directory and generate the local migration manifest.

- [ ] **Step 5: Run staging migration and verification**

Run the migration CLI against staging, then the independent verifier. Expected: zero differences in record count, file count, byte size, SHA-256, title, description, remark, group, created time, cover, and visibility.

- [ ] **Step 6: Perform user acceptance testing**

Verify at least one public and one private project, fixed latest link, permanent V1 link, new-version upload, restore, mobile display, 403 page, archive, trash, and recovery.

- [ ] **Step 7: Deploy production and repeat verified migration**

Create production D1/R2, apply migrations, deploy both Workers, import the frozen PythonAnywhere archive, and require the verifier to report zero differences before announcing cutover.

- [ ] **Step 8: Push and verify GitHub deployment**

Push the reviewed commits to GitHub, confirm the workflow passes, and verify both production health endpoints and representative preview links.

- [ ] **Step 9: Preserve rollback state**

Keep PythonAnywhere unchanged and retain the timestamped archive, manifest, and verification report outside Git for the observation period. Remove `MIGRATION_TOKEN` after migration succeeds. Record Cloudflare rollback commands and deployed version IDs.

---

## Final Verification Gate

Before claiming completion, run:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
git status --short
```

Expected: all quality commands pass; only explicitly preserved unrelated user changes may remain. Then verify deployed Admin and Preview `/health`, one public current link, one public historical link, and one private link returning 403.
