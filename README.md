# 个人作品集网站（支持 HTML 上传）

基于 Flask 的轻量个人作品集网站。

## 功能

- **游客**：可浏览首页、作品列表、作品预览（iframe 嵌入 HTML）
- **管理员**：账号密码登录后，可上传 HTML 作品、删除作品
- 上传时需填写作品名称，选择 .html / .htm 文件

## 管理员账号

- 账号：`17671883601`
- 密码：`zxcvbnm123`

## 本地运行

```bash
# 安装依赖（如果还没装）
pip3 install --user flask

# 进入目录
cd portfolio-flask

# 运行（需要设置 PYTHONPATH 如果 flask 装在 user 目录）
export PYTHONPATH=/root/.local/lib/python3.12/site-packages:$PYTHONPATH
python3 app.py
```

然后访问 http://127.0.0.1:5000

## 项目结构

```
portfolio-flask/
├── app.py                 # 主程序
├── data/
│   └── works.json         # 作品元数据
├── static/
│   └── uploads/           # 上传的 HTML 文件存放处
├── templates/             # 页面模板
└── README.md
```

## 部署建议（公开访问）

因为需要文件持久化，推荐以下平台（都有免费额度）：

1. **Render**（推荐）
   - 新建 Web Service
   - 连接 Git 仓库或直接上传
   - Build Command: `pip install flask`
   - Start Command: `python app.py`
   - 注意：免费实例会休眠，且文件存储是临时的（重启会丢）。生产环境建议改用云存储（如 S3 / Cloudflare R2）

2. **Railway**
   - 类似，支持持久磁盘（付费）或临时

3. **自己的服务器 / VPS**
   - 用 gunicorn + nginx 更稳定
   - `pip install gunicorn`
   - `gunicorn -b 0.0.0.0:5000 app:app`

## 安全说明

- 当前密码是明文硬编码，仅适合个人私用。
- 上传的 HTML 用 iframe + sandbox 预览，降低 XSS 风险，但仍建议只上传自己信任的文件。
- 生产环境请更换 `app.secret_key`，并考虑 HTTPS。

## 后续可优化

- 支持封面图上传
- 作品分类 / 标签
- 使用云存储替代本地文件
- 更完善的认证（JWT / NextAuth 等）
- 换成 Next.js 全栈版本（更现代）
