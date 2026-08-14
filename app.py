from flask import Flask, render_template, request, redirect, url_for, session, flash, send_from_directory, abort, jsonify
import os
import json
import uuid
import time
from datetime import datetime
from functools import wraps
from werkzeug.utils import secure_filename

# 网站上线时间：2026年8月6日13时24分36秒
SITE_LAUNCH_TIME = datetime(2026, 8, 6, 13, 24, 36).timestamp()

# 获取项目根目录（兼容不同运行方式）
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "portfolio-secret-key-change-in-production-2026")
app.config["UPLOAD_FOLDER"] = os.path.join(BASE_DIR, "static", "uploads")
app.config["COVER_FOLDER"] = os.path.join(BASE_DIR, "static", "covers")
app.config["AVATAR_FOLDER"] = os.path.join(BASE_DIR, "static", "avatars")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB max
ALLOWED_COVER_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
ALLOWED_AVATAR_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp"}

# 管理员账号（支持多个）
ADMIN_ACCOUNTS = [
    {"username": "17671883601", "password": "zxcvbnm123"},
    {"username": "13797885246", "password": "wahsmmyj"},
]

DATA_FILE = os.path.join(BASE_DIR, "data", "works.json")
AVATARS_FILE = os.path.join(BASE_DIR, "data", "avatars.json")
GROUPS_FILE = os.path.join(BASE_DIR, "data", "groups.json")
DEFAULT_AVATAR = "images/avatar.png"  # 相对 static 目录
DEFAULT_GROUP = "默认"  # 默认分组名

# 确保目录存在
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["COVER_FOLDER"], exist_ok=True)
os.makedirs(app.config["AVATAR_FOLDER"], exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, "data"), exist_ok=True)
os.makedirs(os.path.join(BASE_DIR, "static", "css"), exist_ok=True)

def load_works():
    if not os.path.exists(DATA_FILE):
        return []
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            works = json.load(f)
        # 兼容旧数据：确保每个 work 都有 group 字段
        for w in works:
            if "group" not in w:
                w["group"] = DEFAULT_GROUP
        return works
    except Exception:
        return []

def save_works(works):
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(works, f, ensure_ascii=False, indent=2)

def load_groups():
    """加载分组列表，若文件不存在返回默认分组"""
    if not os.path.exists(GROUPS_FILE):
        return [DEFAULT_GROUP]
    try:
        with open(GROUPS_FILE, "r", encoding="utf-8") as f:
            groups = json.load(f)
        if not groups or DEFAULT_GROUP not in groups:
            groups.insert(0, DEFAULT_GROUP)
        return groups
    except Exception:
        return [DEFAULT_GROUP]

def save_groups(groups):
    with open(GROUPS_FILE, "w", encoding="utf-8") as f:
        json.dump(groups, f, ensure_ascii=False, indent=2)

def load_avatars():
    """加载头像映射 {username: avatar_filename}"""
    if not os.path.exists(AVATARS_FILE):
        return {}
    try:
        with open(AVATARS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}

def save_avatars(avatars):
    with open(AVATARS_FILE, "w", encoding="utf-8") as f:
        json.dump(avatars, f, ensure_ascii=False, indent=2)

def get_avatar_url(username):
    """获取账号头像URL（相对 static 路径）；未自定义则返回默认头像"""
    if not username:
        return DEFAULT_AVATAR
    avatars = load_avatars()
    fname = avatars.get(username)
    if fname:
        return f"avatars/{fname}"
    return DEFAULT_AVATAR

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if session.get("role") != "admin":
            flash("需要管理员账号才能上传作品", "error")
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated_function

def mask_username(username):
    """账号脱敏：保留前3后3，中间用星号"""
    if not username:
        return ""
    if len(username) <= 6:
        return "*" * len(username)
    return username[:3] + "*" * (len(username) - 6) + username[-3:]

@app.context_processor
def inject_user():
    """全局注入用户信息给模板"""
    uptime_seconds = int(time.time() - SITE_LAUNCH_TIME)
    role = session.get("role")
    if role == "admin":
        username = session.get("username", "")
        return {
            "user_role": "admin",
            "display_name": mask_username(username),
            "avatar_url": get_avatar_url(username),
            "uptime_seconds": uptime_seconds,
        }
    if role == "guest":
        return {
            "user_role": "guest",
            "display_name": "游客114514",
            "avatar_url": DEFAULT_AVATAR,
            "uptime_seconds": uptime_seconds,
        }
    return {"user_role": None, "display_name": None, "avatar_url": None, "uptime_seconds": uptime_seconds}

@app.route("/")
def index():
    # 已登录用户看作品列表，未登录跳登录页
    if session.get("role") in ("admin", "guest"):
        return redirect(url_for("works_list"))
    return redirect(url_for("login"))

@app.route("/works")
def works_list():
    works = load_works()
    works = sorted(works, key=lambda x: x.get("created_at", ""), reverse=True)
    groups = load_groups()
    current_group = request.args.get("group", "")
    # 统计各分组作品数
    group_counts = {}
    for w in works:
        g = w.get("group", DEFAULT_GROUP)
        group_counts[g] = group_counts.get(g, 0) + 1
    # 按分组筛选
    if current_group:
        filtered = [w for w in works if w.get("group", DEFAULT_GROUP) == current_group]
    else:
        filtered = works
    # AJAX 局部刷新：只返回作品网格片段
    if request.args.get("partial") == "1":
        return render_template("works_grid.html", works=filtered)
    return render_template("works.html", works=filtered, groups=groups,
                           current_group=current_group, group_counts=group_counts,
                           total_count=len(works))

@app.route("/works/<work_id>")
def work_detail(work_id):
    works = load_works()
    work = next((w for w in works if w["id"] == work_id), None)
    if not work:
        abort(404)
    return render_template("work_detail.html", work=work)

@app.route("/preview/<work_id>")
def preview(work_id):
    """直接提供上传的 HTML 文件内容"""
    works = load_works()
    work = next((w for w in works if w["id"] == work_id), None)
    if not work:
        abort(404)
    filename = work.get("filename")
    if not filename:
        abort(404)
    filepath = os.path.join(app.config["UPLOAD_FOLDER"], filename)
    if not os.path.exists(filepath):
        abort(404)
    # 读取文件内容并返回，确保 Content-Type 为 text/html
    with open(filepath, "r", encoding="utf-8") as f:
        html_content = f.read()
    return html_content, 200, {"Content-Type": "text/html; charset=utf-8"}

@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("role") == "admin":
        return redirect(url_for("admin"))
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        matched = next((a for a in ADMIN_ACCOUNTS if a["username"] == username and a["password"] == password), None)
        if matched:
            session["role"] = "admin"
            session["username"] = username
            flash("管理员登录成功", "success")
            return redirect(url_for("admin"))
        else:
            flash("账号或密码错误", "error")
    return render_template("login.html")

@app.route("/guest_login")
def guest_login():
    session["role"] = "guest"
    session["username"] = "游客114514"
    flash("已以游客身份进入，可浏览作品（不能上传）", "success")
    return redirect(url_for("index"))

@app.route("/logout")
def logout():
    session.clear()
    flash("已退出登录", "success")
    return redirect(url_for("login"))

@app.route("/upload_avatar", methods=["POST"])
@admin_required
def upload_avatar():
    """管理员上传自定义头像"""
    file = request.files.get("avatar_file")
    if not file or file.filename == "":
        flash("请选择头像图片", "error")
        return redirect(request.referrer or url_for("admin"))

    original = file.filename
    ext = os.path.splitext(original)[1].lower()
    if ext not in ALLOWED_AVATAR_EXT:
        flash("头像格式不支持（仅 png/jpg/jpeg/gif/webp）", "error")
        return redirect(request.referrer or url_for("admin"))

    username = session.get("username", "")
    avatars = load_avatars()

    # 删除旧头像文件（非默认）
    old_fname = avatars.get(username)
    if old_fname:
        old_path = os.path.join(app.config["AVATAR_FOLDER"], old_fname)
        if os.path.exists(old_path):
            try:
                os.remove(old_path)
            except Exception:
                pass

    # 保存新头像
    new_fname = f"{uuid.uuid4().hex[:12]}{ext}"
    dest = os.path.join(app.config["AVATAR_FOLDER"], new_fname)
    file.save(dest)

    avatars[username] = new_fname
    save_avatars(avatars)

    flash("头像更新成功", "success")
    return redirect(request.referrer or url_for("admin"))

@app.route("/admin/groups", methods=["POST"])
@admin_required
def manage_groups():
    """分组管理：新增/删除分组"""
    action = request.form.get("action", "")
    name = request.form.get("name", "").strip()

    if action == "add":
        if not name:
            flash("分组名称不能为空", "error")
            return redirect(url_for("admin"))
        groups = load_groups()
        if name not in groups:
            groups.append(name)
            save_groups(groups)
            flash(f"分组「{name}」已添加", "success")
        else:
            flash(f"分组「{name}」已存在", "error")

    elif action == "delete":
        if not name:
            flash("分组名称不能为空", "error")
            return redirect(url_for("admin"))
        if name == DEFAULT_GROUP:
            flash("默认分组不可删除", "error")
            return redirect(url_for("admin"))
        groups = load_groups()
        if name in groups:
            groups.remove(name)
            save_groups(groups)
            # 将该分组下的作品移到默认分组
            works = load_works()
            changed = False
            for w in works:
                if w.get("group") == name:
                    w["group"] = DEFAULT_GROUP
                    changed = True
            if changed:
                save_works(works)
            flash(f"分组「{name}」已删除，相关作品已移至默认分组", "success")
        else:
            flash("分组不存在", "error")

    return redirect(url_for("admin"))

@app.route("/admin")
@admin_required
def admin():
    works = load_works()
    works = sorted(works, key=lambda x: x.get("created_at", ""), reverse=True)
    groups = load_groups()
    return render_template("admin.html", works=works, groups=groups)

@app.route("/admin/upload", methods=["GET", "POST"])
@admin_required
def upload():
    if request.method == "POST":
        title = request.form.get("title", "").strip()
        description = request.form.get("description", "").strip()
        remark = request.form.get("remark", "").strip()
        group = request.form.get("group", DEFAULT_GROUP).strip() or DEFAULT_GROUP
        file = request.files.get("html_file")
        cover = request.files.get("cover_file")

        if not title:
            flash("请输入作品名称", "error")
            return redirect(url_for("upload"))
        if not file or file.filename == "":
            flash("请选择 HTML 文件", "error")
            return redirect(url_for("upload"))

        # 先校验原始文件名的扩展名（secure_filename可能剥离扩展名）
        original_filename = file.filename
        if not (original_filename.lower().endswith(".html") or original_filename.lower().endswith(".htm")):
            flash("只支持上传 .html 或 .htm 文件", "error")
            return redirect(url_for("upload"))

        filename = secure_filename(original_filename)

        # 若分组不存在则自动添加
        groups = load_groups()
        if group not in groups:
            groups.append(group)
            save_groups(groups)

        # 生成唯一文件名
        work_id = str(uuid.uuid4())[:8]
        ext = os.path.splitext(filename)[1].lower()
        new_filename = f"{work_id}{ext}"
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], new_filename)
        file.save(filepath)

        # 处理封面图
        cover_filename = ""
        if cover and cover.filename:
            cover_filename = _save_cover(cover, work_id)
            if cover_filename is None:
                # 封面图格式不合法，继续保存作品但提示
                flash("作品已保存，但封面图格式不支持（仅 png/jpg/jpeg/gif/webp）", "error")

        # 保存元数据
        works = load_works()
        works.append({
            "id": work_id,
            "title": title,
            "description": description,
            "remark": remark,
            "group": group,
            "filename": new_filename,
            "cover": cover_filename,
            "original_name": filename,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        })
        save_works(works)

        flash(f"作品「{title}」上传成功！", "success")
        return redirect(url_for("admin"))

    groups = load_groups()
    return render_template("upload.html", groups=groups)

def _save_cover(file_storage, work_id):
    """保存封面图，返回文件名；格式不合法返回 None"""
    original = secure_filename(file_storage.filename)
    ext = os.path.splitext(original)[1].lower()
    if ext not in ALLOWED_COVER_EXT:
        return None
    cover_name = f"{work_id}{ext}"
    dest = os.path.join(app.config["COVER_FOLDER"], cover_name)
    file_storage.save(dest)
    return cover_name

@app.route("/admin/edit/<work_id>", methods=["GET", "POST"])
@admin_required
def edit_work(work_id):
    works = load_works()
    work = next((w for w in works if w["id"] == work_id), None)
    if not work:
        flash("作品不存在", "error")
        return redirect(url_for("admin"))

    if request.method == "POST":
        title = request.form.get("title", "").strip()
        description = request.form.get("description", "").strip()
        remark = request.form.get("remark", "").strip()
        group = request.form.get("group", DEFAULT_GROUP).strip() or DEFAULT_GROUP
        cover = request.files.get("cover_file")
        remove_cover = request.form.get("remove_cover") == "1"

        if not title:
            flash("请输入作品名称", "error")
            return redirect(url_for("edit_work", work_id=work_id))

        # 若分组不存在则自动添加
        groups = load_groups()
        if group not in groups:
            groups.append(group)
            save_groups(groups)

        work["title"] = title
        work["description"] = description
        work["remark"] = remark
        work["group"] = group

        if remove_cover and work.get("cover"):
            old_cover_path = os.path.join(app.config["COVER_FOLDER"], work["cover"])
            if os.path.exists(old_cover_path):
                try:
                    os.remove(old_cover_path)
                except Exception:
                    pass
            work["cover"] = ""

        if cover and cover.filename:
            new_cover = _save_cover(cover, work_id)
            if new_cover:
                # 删除旧封面
                if work.get("cover") and work["cover"] != new_cover:
                    old_path = os.path.join(app.config["COVER_FOLDER"], work["cover"])
                    if os.path.exists(old_path):
                        try:
                            os.remove(old_path)
                        except Exception:
                            pass
                work["cover"] = new_cover
            else:
                flash("封面图格式不支持（仅 png/jpg/jpeg/gif/webp）", "error")

        save_works(works)
        flash("作品信息已更新", "success")
        return redirect(url_for("admin"))

    groups = load_groups()
    return render_template("edit.html", work=work, groups=groups)

@app.route("/admin/delete/<work_id>", methods=["POST"])
@admin_required
def delete_work(work_id):
    works = load_works()
    work = next((w for w in works if w["id"] == work_id), None)
    if work:
        # 删除文件
        filepath = os.path.join(app.config["UPLOAD_FOLDER"], work.get("filename", ""))
        if os.path.exists(filepath):
            try:
                os.remove(filepath)
            except Exception:
                pass
        # 删除封面
        if work.get("cover"):
            cover_path = os.path.join(app.config["COVER_FOLDER"], work["cover"])
            if os.path.exists(cover_path):
                try:
                    os.remove(cover_path)
                except Exception:
                    pass
        # 删除记录
        works = [w for w in works if w["id"] != work_id]
        save_works(works)
        flash("作品已删除", "success")
    else:
        flash("作品不存在", "error")
    return redirect(url_for("admin"))

@app.route("/api/uptime")
def get_uptime():
    """获取服务器运行时间"""
    uptime_seconds = time.time() - SITE_LAUNCH_TIME
    
    days = int(uptime_seconds // 86400)
    hours = int((uptime_seconds % 86400) // 3600)
    minutes = int((uptime_seconds % 3600) // 60)
    seconds = int(uptime_seconds % 60)
    
    return jsonify({
        "days": days,
        "hours": hours,
        "minutes": minutes,
        "seconds": seconds,
        "total_seconds": int(uptime_seconds)
    })

@app.errorhandler(404)
def not_found(e):
    return render_template("404.html"), 404

if __name__ == "__main__":
    # 初始化空数据
    if not os.path.exists(DATA_FILE):
        save_works([])
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "1") == "1"
    # 开启 reloader：代码修改后自动重启，方便开发预览
    app.run(host="0.0.0.0", port=port, debug=debug, use_reloader=debug)
