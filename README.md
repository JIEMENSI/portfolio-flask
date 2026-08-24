# HTML Preview Platform

面向产品与开发对接的单 HTML 预览平台。上传 `.html` 或 `.htm` 后，可生成项目永久链接和每个版本的固定链接。公开项目允许拿到链接的访客查看；私有项目的所有游客链接统一返回“无权限查看”。

新版本使用 Cloudflare Workers、D1 和 Workers KV。旧 PythonAnywhere 网站在迁移验收完成前保留不动，作为回滚来源。

## 安全边界

- Admin Worker 与 Preview Worker 使用不同域名，上传的 HTML 不会收到管理员 Cookie。
- 管理操作需要管理员 Session 和 CSRF 令牌。
- 迁移接口只接受单独的 `MIGRATION_TOKEN`，不接受管理员 Cookie。
- 密码、Cloudflare Token、数据库 ID、线上备份和迁移报告不得提交 Git。
- HTML 最大 16 MiB；版本不可覆盖，恢复旧版会创建新版本。

## 本地开发

需要 Node.js 22+ 和 pnpm。

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
```

本地应用 D1 表结构：

```bash
pnpm exec wrangler d1 migrations apply html-preview --local --config wrangler.admin.toml
```

管理员密码保存为 PBKDF2-SHA256 编码值，格式为 `pbkdf2$迭代次数$saltHex$hashHex`，最低 100000 次。密码和哈希都不能写进仓库。

## Cloudflare 资源与部署

创建同一套 D1/KV，两个 Worker 共享它们。KV 免费套餐不要求启用 R2 订阅或填写银行卡；单值上限 25 MiB，本项目仍限制单个 HTML 为 16 MiB：

```bash
pnpm exec wrangler d1 create html-preview
pnpm exec wrangler kv namespace create html-preview-files
```

通过环境变量生成被 Git 忽略的生产配置：

```powershell
$env:CLOUDFLARE_D1_DATABASE_ID="Cloudflare 返回的 D1 UUID"
$env:CLOUDFLARE_KV_NAMESPACE_ID="Cloudflare 返回的 KV namespace ID"
$env:PREVIEW_WORKER_URL="https://你的预览域名"
pnpm run config:deploy
pnpm exec wrangler d1 migrations apply html-preview --remote --config .deploy/wrangler.admin.toml
pnpm exec wrangler deploy --config .deploy/wrangler.admin.toml
pnpm exec wrangler deploy --config .deploy/wrangler.preview.toml
```

再通过 Cloudflare 官方 CLI 的交互输入设置密钥：

```bash
pnpm exec wrangler secret put ADMIN_PASSWORD_HASH --config .deploy/wrangler.admin.toml
pnpm exec wrangler secret put SESSION_PEPPER --config .deploy/wrangler.admin.toml
pnpm exec wrangler secret put MIGRATION_TOKEN --config .deploy/wrangler.admin.toml
```

迁移完成后删除 `MIGRATION_TOKEN`。GitHub `production` 环境需要：

- Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、`CLOUDFLARE_KV_NAMESPACE_ID`
- Variable：`PREVIEW_WORKER_URL`

流水线先执行类型检查、全部测试和 dry-run build，再依次部署 Admin 与 Preview；不会自动迁移旧数据。

## PythonAnywhere 备份与迁移

先暂停旧站上传。在 PythonAnywhere 创建包含以下目录的时间戳备份，并下载到仓库外：

```text
data/
static/uploads/
static/covers/
static/avatars/
```

`config.local.json` 单独备份，绝不放进迁移压缩包或 Git。先只读检查：

```powershell
node scripts/migrate_pythonanywhere.mjs --source "仓库外的解压目录" --report "仓库外/migration-report.json" --dry-run
```

工具检查重复 ID、缺失 HTML/封面、未引用 HTML，并计算字节数与 SHA-256。有错误时不会上传。

先迁移 staging，再运行独立校验：

```powershell
$env:MIGRATION_TOKEN="仅用于本次迁移的随机令牌"
node scripts/migrate_pythonanywhere.mjs --source "仓库外的解压目录" --report "仓库外/migration-report.json" --admin-url "https://staging-admin.example.workers.dev"
node scripts/verify_migration.mjs --manifest "仓库外/migration-report.json" --admin-url "https://staging-admin.example.workers.dev"
```

只有校验器报告项目数、标题、说明、备注、分组、公开状态、创建时间、文件大小和 SHA-256 全部一致，才能切换生产地址。

## 回滚

迁移期间不删除或修改 PythonAnywhere 数据。若新站异常：

1. 旧域名继续指向 PythonAnywhere。
2. 在 Cloudflare Dashboard 将两个 Worker 回滚到上一部署版本。
3. 保留备份、迁移清单和校验输出；导入接口按旧作品 ID 幂等，可安全重试。
4. 验收期结束前不要停用旧站或删除时间戳备份。
