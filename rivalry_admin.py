# -*- coding: utf-8 -*-
"""
Rivalry 图集管理后台 —— Flask Blueprint
===========================================
管理 exe 客户端（Rivalry）里能看到的全部内容：
  - 图集（exe 首页轮播 / 图集网格 / 图集详情）
  - 图集内照片（原图 + 缩略图，本体存海外 iDrive）
  - 注册用户

登录复用 portfolio 的 admin 后台（/login，session role=admin），
与个人主页的作品管理共用一套账号，入口在 /admin 页面。

图片查看 / 云上删除需要服务端访问 iDrive，凭证配置在 config.local.json：
  "rivalry_idrive": {
    "access_key": "...",
    "secret_key": "...",
    "bucket": "gallery",
    "endpoint": "https://s3.ap-northeast-1.idrivee2.com",
    "region": "ap-northeast-1"
  }
（也可用环境变量 IDRIVE_ACCESS_KEY / IDRIVE_SECRET_KEY / IDRIVE_BUCKET 等）
未配置凭证时：图片无法预览，删除只删元数据并在页面提示"云端图片未清理"。
"""
import os
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from functools import wraps

from flask import (Blueprint, Response, abort, flash, redirect,
                   render_template, request, session, url_for)

from rivalry_api import (ROLE_LABEL, ROLE_LEVEL, _load_local_cfg,
                         album_ids_s, album_photos_s, albums_s, fav_index_s,
                         favs_s, photos_s, uids_s, users_s)

adm = Blueprint("rivalry_admin", __name__, url_prefix="/rivalry-admin")

PAGE_SIZE = 20

# =====================================================================
# 鉴权：复用 portfolio 的 admin 登录（session role=admin）
# =====================================================================

def _admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if session.get("role") != "admin":
            flash("需要管理员账号才能访问图集管理", "error")
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


def _role_level(role):
    return ROLE_LEVEL.get(role or "user", 0)


def _role_label(role):
    return ROLE_LABEL.get(role or "user", "普通账号")


def _current_role():
    """当前后台登录者角色：portfolio admin 账号=超级管理员；Rivalry 注册用户取其库中角色"""
    if session.get("rivalry_admin_from_account"):
        return "super_admin"
    role = session.get("rivalry_admin_role")
    if role in ROLE_LEVEL:
        return role
    # 兼容旧登录会话（未标记来源的后台管理员账号，视为超级管理员）
    if session.get("role") == "admin":
        return "super_admin"
    return "user"


def _current_uid():
    """当前后台登录者对应 Rivalry 用户 id（portfolio admin 账号无对应 Rivalry 账号时为空）"""
    return session.get("rivalry_admin_uid") or ""


def _can_manage_users():
    """用户管理：超级管理员 / 主管理号"""
    return _role_level(_current_role()) >= 2


def _can_upload_album():
    """上传图集：子管理号及以上"""
    return _role_level(_current_role()) >= 1


def _can_manage_album(aid):
    """管理某图集：主管理号及以上可管理任意图集；子管理号仅自己创建的"""
    a = albums_s.get(aid)
    if not a:
        return False
    if _role_level(_current_role()) >= 2:
        return True
    return bool(a.get("owner")) and a.get("owner") == _current_uid()


def _is_current_super():
    return _current_role() == "super_admin"


@adm.app_context_processor
def _inject_nav_role():
    """给全站导航注入当前后台登录者的角色铭牌"""
    if session.get("rivalry_admin_from_account"):
        return {"nav_role_key": "super_admin", "nav_role_label": "超级管理员"}
    r = session.get("rivalry_admin_role")
    if r and r in ROLE_LABEL:
        return {"nav_role_key": r, "nav_role_label": ROLE_LABEL[r]}
    return {}


# =====================================================================
# iDrive 访问（服务端代理图片 + 云清理）
# =====================================================================

_IDRIVE_CFG = None
_IDRIVE_CFG_AT = 0.0
_IDRIVE_S3 = None
_IDRIVE_LOCK = threading.RLock()
_IMG_CACHE = OrderedDict()
_IMG_CACHE_LOCK = threading.RLock()
_IMG_CACHE_MAX = 300              # 最多缓存 300 张缩略图
_IMG_CACHE_ITEM_MAX = 512 * 1024  # 单张缓存上限 512KB


def _idrive_config():
    """读取 iDrive 凭证（config.local.json 的 rivalry_idrive 优先，其次环境变量）"""
    global _IDRIVE_CFG, _IDRIVE_CFG_AT
    now = time.time()
    if _IDRIVE_CFG is not None and now - _IDRIVE_CFG_AT < 60:
        return _IDRIVE_CFG
    cfg = _load_local_cfg().get("rivalry_idrive") or {}
    env = os.environ
    conf = {
        "access_key": str(cfg.get("access_key") or env.get("IDRIVE_ACCESS_KEY", "")),
        "secret_key": str(cfg.get("secret_key") or env.get("IDRIVE_SECRET_KEY", "")),
        "bucket": str(cfg.get("bucket") or env.get("IDRIVE_BUCKET", "gallery")),
        "endpoint": str(cfg.get("endpoint") or env.get("IDRIVE_ENDPOINT", "https://s3.ap-northeast-1.idrivee2.com")),
        "region": str(cfg.get("region") or env.get("IDRIVE_REGION", "ap-northeast-1")),
    }
    _IDRIVE_CFG = conf
    _IDRIVE_CFG_AT = now
    return conf


def _idrive_available():
    c = _idrive_config()
    return bool(c["access_key"] and c["secret_key"])


def _idrive_s3():
    global _IDRIVE_S3
    if _IDRIVE_S3 is not None:
        return _IDRIVE_S3
    with _IDRIVE_LOCK:
        if _IDRIVE_S3 is None:
            import boto3
            from botocore.config import Config as BotoConfig
            c = _idrive_config()
            _IDRIVE_S3 = boto3.client(
                "s3",
                endpoint_url=c["endpoint"],
                region_name=c["region"],
                aws_access_key_id=c["access_key"],
                aws_secret_access_key=c["secret_key"],
                config=BotoConfig(signature_version="s3v4", connect_timeout=15,
                                  read_timeout=60, retries={"max_attempts": 2}),
            )
    return _IDRIVE_S3


def _get_img(key, cacheable):
    """从 iDrive 取图字节；cacheable=True 时缓存（缩略图小、适合缓存）"""
    if not key or not _idrive_available():
        return None
    if cacheable:
        with _IMG_CACHE_LOCK:
            if key in _IMG_CACHE:
                _IMG_CACHE.move_to_end(key)
                return _IMG_CACHE[key]
    try:
        obj = _idrive_s3().get_object(Bucket=_idrive_config()["bucket"], Key=key)
        data = obj["Body"].read()
    except Exception:
        return None
    if cacheable and len(data) <= _IMG_CACHE_ITEM_MAX:
        with _IMG_CACHE_LOCK:
            _IMG_CACHE[key] = data
            _IMG_CACHE.move_to_end(key)
            while len(_IMG_CACHE) > _IMG_CACHE_MAX:
                _IMG_CACHE.popitem(last=False)
    return data


def _delete_cloud_keys(keys):
    """批量删除 iDrive 对象；未配置凭证或删除失败不致命，返回是否执行过云删除"""
    if not keys or not _idrive_available():
        return False
    try:
        s3 = _idrive_s3()
        bucket = _idrive_config()["bucket"]
        for k in keys:
            if k:
                try:
                    s3.delete_object(Bucket=bucket, Key=k)
                except Exception:
                    pass
        return True
    except Exception:
        return False


# =====================================================================
# 数据处理（保证与 rivalry_api 的 store 一致性）
# =====================================================================

def _fmt_time(iso):
    """ISO UTC -> 本地可读时间；解析失败原样返回"""
    try:
        dt = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S.%fZ")
        dt = dt.replace(tzinfo=timezone.utc).astimezone()
        return dt.strftime("%Y-%m-%d %H:%M")
    except Exception:
        return iso or "—"


def _user_display(user_id):
    email = uids_s.get(user_id)
    user = users_s.get(email) if email else None
    if user:
        return user.get("username") or email, email
    return "已注销", email


def _album_view(a):
    author, email = _user_display(a.get("owner"))
    favs = fav_index_s.get(a.get("id"), [])
    return {
        "id": a.get("id"),
        "title": a.get("title") or "未命名",
        "tags": a.get("tags") or [],
        "photo_count": a.get("photo_count") or 0,
        "cover_thumb_key": a.get("cover_thumb_key"),
        "cover_key": a.get("cover_key"),
        "created_at": _fmt_time(a.get("created_at")),
        "created_raw": a.get("created_at") or "",
        "author": author,
        "author_email": email or "",
        "owner": a.get("owner") or "",
        "fav_count": len(favs),
    }


def _user_view(email, user):
    uid = user.get("id")
    albums = [a for a in album_ids_s.read() if (albums_s.get(a) or {}).get("owner") == uid]
    return {
        "email": email,
        "username": user.get("username") or "—",
        "role": user.get("role") or "user",
        "banned": bool(user.get("banned")),
        "created_at": _fmt_time(user.get("created_at")),
        "album_count": len(albums),
        "fav_count": len(favs_s.get(uid, [])),
    }


def _delete_album_core(aid, purge_cloud):
    """删除图集（含照片元数据；purge_cloud=True 时同步清理 iDrive 云图）"""
    photos = album_photos_s.get(aid, [])
    cloud_keys = []
    for pid in photos:
        ph = photos_s.get(pid)
        if ph:
            cloud_keys += [ph.get("object_key"), ph.get("thumb_key")]
        photos_s.delete(pid)
    if purge_cloud:
        _delete_cloud_keys(cloud_keys)
    album_photos_s.delete(aid)
    albums_s.delete(aid)
    ids = [x for x in album_ids_s.read() if x != aid]
    album_ids_s.replace(ids)
    for uid in fav_index_s.get(aid, []):
        favs = favs_s.get(uid, [])
        if aid in favs:
            favs_s.put(uid, [x for x in favs if x != aid])
    fav_index_s.delete(aid)


def _delete_photo_core(pid, purge_cloud):
    """删除图集内单张照片；删空后自动删除图集"""
    ph = photos_s.get(pid)
    if not ph:
        return None
    aid = ph.get("album_id")
    if purge_cloud:
        _delete_cloud_keys([ph.get("object_key"), ph.get("thumb_key")])
    photos_s.delete(pid)
    pids = [x for x in album_photos_s.get(aid, []) if x != pid]
    album_photos_s.put(aid, pids)
    album = albums_s.get(aid)
    if album:
        album["photo_count"] = len(pids)
        # 删的是封面时，封面顺延到第一张
        if album.get("cover_key") == ph.get("object_key") and pids:
            np = photos_s.get(pids[0])
            if np:
                album["cover_key"] = np.get("object_key")
                album["cover_thumb_key"] = np.get("thumb_key")
        albums_s.put(aid, album)
        if not pids:  # 删空了，连图集一起删
            _delete_album_core(aid, purge_cloud=False)
            return "album_deleted"
    return "ok"


# =====================================================================
# 页面路由
# =====================================================================

@adm.route("/")
@_admin_required
def index():
    tab = request.args.get("tab", "albums")
    q = request.args.get("q", "").strip().lower()
    page = max(1, int(request.args.get("page") or 1))
    cloud_ok = _idrive_available()

    cur_role = _current_role()
    cur_label = _role_label(cur_role)
    can_users = _can_manage_users()
    can_upload = _can_upload_album()
    # 无用户管理权限时强制停留在图集 tab
    if tab == "users" and not can_users:
        tab = "albums"

    # 统计卡片
    users = users_s.read()
    album_ids = album_ids_s.read()
    photo_total = sum((albums_s.get(a) or {}).get("photo_count") or 0 for a in album_ids)
    fav_total = sum(len(v) for v in fav_index_s.read().values())
    total_bytes = sum((photos_s.get(p) or {}).get("size_bytes") or 0
                      for aid in album_ids for p in album_photos_s.get(aid, []))
    stats = {
        "users": len(users),
        "albums": len(album_ids),
        "photos": photo_total,
        "favs": fav_total,
        "bytes": total_bytes,
    }

    if tab == "users":
        rows = []
        for email, user in users.items():
            if q and q not in email.lower() and q not in (user.get("username") or "").lower():
                continue
            rows.append(_user_view(email, user))
        rows.sort(key=lambda x: x["created_at"], reverse=True)
    else:
        rows = []
        for aid in album_ids:
            a = albums_s.get(aid)
            if not a:
                continue
            title = (a.get("title") or "").lower()
            tag_hit = any(q in str(t).lower() for t in (a.get("tags") or []))
            if q and q not in title and not tag_hit:
                continue
            rows.append(_album_view(a))
        rows.sort(key=lambda x: x["created_raw"], reverse=True)

    total = len(rows)
    pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    page = min(page, pages)
    rows = rows[(page - 1) * PAGE_SIZE: page * PAGE_SIZE]

    return render_template(
        "rivalry_admin.html", tab=tab, q=request.args.get("q", ""),
        albums=rows if tab != "users" else None, users=rows if tab == "users" else None,
        stats=stats, page=page, pages=pages, total=total,
        cloud_ok=cloud_ok, active_page="admin",
        cur_role=cur_role, cur_label=cur_label, cur_uid=_current_uid(),
        can_users=can_users, can_upload=can_upload,
    )


@adm.route("/albums/<aid>")
@_admin_required
def album_detail(aid):
    a = albums_s.get(aid)
    if not a:
        abort(404)
    photo_ids = album_photos_s.get(aid, [])
    photos = []
    for pid in photo_ids:
        ph = photos_s.get(pid)
        if not ph:
            continue
        photos.append({
            "id": pid,
            "filename": ph.get("filename") or "未命名",
            "object_key": ph.get("object_key"),
            "thumb_key": ph.get("thumb_key"),
            "size_bytes": ph.get("size_bytes") or 0,
            "width": ph.get("width") or 0,
            "height": ph.get("height") or 0,
            "created_at": _fmt_time(ph.get("created_at")),
            "is_cover": ph.get("object_key") == a.get("cover_key"),
        })
    author, author_email = _user_display(a.get("owner"))
    return render_template(
        "rivalry_admin_album.html",
        album={**a, "author": author, "author_email": author_email or "",
               "created_at": _fmt_time(a.get("created_at"))},
        photos=photos, photo_total=len(photos),
        cloud_ok=_idrive_available(), active_page="admin",
        cur_role=_current_role(), cur_label=_role_label(_current_role()),
        can_upload=_can_upload_album(), can_manage=_can_manage_album(aid),
    )


@adm.route("/img/<path:key>")
@_admin_required
def img(key):
    """iDrive 图片代理：缩略图缓存，原图不缓存"""
    if not key or ".." in key:
        abort(404)
    cacheable = key.startswith("thumbs/")
    data = _get_img(key, cacheable)
    if not data:
        abort(404)
    ctype = "image/jpeg"
    if key.lower().endswith(".png"):
        ctype = "image/png"
    elif key.lower().endswith(".gif"):
        ctype = "image/gif"
    elif key.lower().endswith(".webp"):
        ctype = "image/webp"
    return Response(data, content_type=ctype)


# =====================================================================
# 操作路由（POST 表单）
# =====================================================================

@adm.route("/albums/<aid>/update", methods=["POST"])
@_admin_required
def update_album(aid):
    a = albums_s.get(aid)
    if not a:
        flash("图集不存在", "error")
        return redirect(url_for("rivalry_admin.index"))
    if not _can_manage_album(aid):
        flash("无权限修改此图集", "error")
        return redirect(url_for("rivalry_admin.album_detail", aid=aid))
    title = request.form.get("title", "").strip()
    if not title:
        flash("图集标题不能为空", "error")
        return redirect(url_for("rivalry_admin.album_detail", aid=aid))
    tags_raw = request.form.get("tags", "").strip()
    tags = [t.strip() for t in tags_raw.replace("，", ",").split(",") if t.strip()][:10]
    a["title"] = title
    a["tags"] = tags
    albums_s.put(aid, a)
    flash("图集信息已更新", "success")
    return redirect(url_for("rivalry_admin.album_detail", aid=aid))


@adm.route("/albums/<aid>/delete", methods=["POST"])
@_admin_required
def delete_album(aid):
    a = albums_s.get(aid)
    if not a:
        flash("图集不存在", "error")
        return redirect(url_for("rivalry_admin.index"))
    if not _can_manage_album(aid):
        flash("无权限删除此图集", "error")
        return redirect(url_for("rivalry_admin.album_detail", aid=aid))
    purge = request.form.get("purge_cloud") == "1"
    title = a.get("title")
    _delete_album_core(aid, purge)
    note = "并已清理云端图片" if purge else ("（云端图片未清理）" if _idrive_available() else "（未配置云凭证，仅删记录）")
    flash(f"图集「{title}」已删除{note}", "success")
    return redirect(url_for("rivalry_admin.index"))


@adm.route("/albums/<aid>/photos/<pid>/delete", methods=["POST"])
@_admin_required
def delete_photo(aid, pid):
    ph = photos_s.get(pid)
    if not ph or ph.get("album_id") != aid:
        flash("照片不存在", "error")
        return redirect(url_for("rivalry_admin.album_detail", aid=aid))
    if not _can_manage_album(aid):
        flash("无权限删除此照片", "error")
        return redirect(url_for("rivalry_admin.album_detail", aid=aid))
    purge = request.form.get("purge_cloud") == "1"
    result = _delete_photo_core(pid, purge)
    if result == "album_deleted":
        flash("该图集照片已删空，图集已自动删除", "success")
        return redirect(url_for("rivalry_admin.index"))
    note = "，云端图片已清理" if purge else ""
    flash(f"照片已删除{note}", "success")
    return redirect(url_for("rivalry_admin.album_detail", aid=aid))


def _user_guard(email, user):
    """用户管理通用守卫：返回错误文案（无权限时），None 表示放行"""
    if not _can_manage_users():
        return "无权限管理用户"
    if user.get("id") and user.get("id") == _current_uid():
        return "不能对自己执行此操作"
    if email and email == session.get("username"):
        return "不能对自己执行此操作"
    if _role_level(user.get("role")) >= 2:
        return "不能操作主管理号及以上账号"
    return None


@adm.route("/users/<path:email>/role", methods=["POST"])
@_admin_required
def set_user_role(email):
    user = users_s.get(email)
    if not user:
        flash("用户不存在", "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    target_role = request.form.get("role", "")
    if target_role not in ROLE_LEVEL or target_role == "super_admin":
        flash("无效角色", "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    err = _user_guard(email, user)
    if err:
        flash(err, "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    # 主管理号只能任命/降级子管理号，不能设置主管理号
    if not _is_current_super() and _role_level(target_role) >= 2:
        flash("仅超级管理员可任命主管理号", "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    user["role"] = target_role
    users_s.put(email, user)
    flash(f"已将 {email} 设为{_role_label(target_role)}", "success")
    return redirect(url_for("rivalry_admin.index", tab="users"))


@adm.route("/users/<path:email>/ban", methods=["POST"])
@_admin_required
def set_user_ban(email):
    user = users_s.get(email)
    if not user:
        flash("用户不存在", "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    err = _user_guard(email, user)
    if err:
        flash(err, "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    user["banned"] = not user.get("banned")
    users_s.put(email, user)
    act = "已拉黑" if user["banned"] else "已解除拉黑"
    flash(f"{act} {email}", "success")
    return redirect(url_for("rivalry_admin.index", tab="users"))


@adm.route("/users/<path:email>/delete", methods=["POST"])
@_admin_required
def delete_user(email):
    user = users_s.get(email)
    if not user:
        flash("用户不存在", "error")
        return redirect(url_for("rivalry_admin.index"))
    err = _user_guard(email, user)
    if err:
        flash(err, "error")
        return redirect(url_for("rivalry_admin.index", tab="users"))
    purge = request.form.get("purge_cloud") == "1"
    uid = user["id"]
    # 删除该用户上传的所有图集
    for aid in list(album_ids_s.read()):
        a = albums_s.get(aid)
        if a and a.get("owner") == uid:
            _delete_album_core(aid, purge)
    # 清理收藏
    for aid in favs_s.get(uid, []):
        fav_index_s.put(aid, [x for x in fav_index_s.get(aid, []) if x != uid])
    favs_s.delete(uid)
    users_s.delete(email)
    uids_s.delete(uid)
    note = "，其图集及云端图片已一并清理" if purge else "，其图集已一并删除"
    flash(f"用户 {email} 已删除{note}", "success")
    return redirect(url_for("rivalry_admin.index", tab="users"))
