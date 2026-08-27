# -*- coding: utf-8 -*-
"""
Rivalry 图集相册后端 —— PythonAnywhere 版（Flask Blueprint）
=====================================================================
从 Cloudflare Worker (cf-worker/worker.js) 1:1 移植，接口与错误格式完全一致。

职责：
  - 用户注册/登录/刷新令牌（JWT HS256 + refresh token，与 worker.js 兼容）
  - 图集（Album）增删查 + 图集内照片元数据
  - 收藏（按图集）、标题搜索、最新图集（首页轮播）
  - 管理员机制：上传/删除图集仅管理员

存储：
  - 用户/图集/收藏等元数据 → data/rivalry/*.json（JSON 文件存储，无需 SQL）
  - 图片本体由客户端直连 IDrive e2，本服务不存图
  - 密码哈希 PBKDF2-SHA256(100000) 与 worker.js 完全一致，老 KV 数据可迁移

配置（config.local.json，推荐）：
  {
    "rivalry_admin_emails": ["me@example.com"],
    "rivalry_auth_secret": "随机长字符串（不配则自动生成并持久化到 data/rivalry/secret.key）"
  }
或环境变量：RIVALRY_ADMIN_EMAILS（逗号分隔）、RIVALRY_AUTH_SECRET
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time as _time
import uuid
from datetime import datetime, timezone

from flask import Blueprint, Response, jsonify, request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data", "rivalry")
os.makedirs(DATA_DIR, exist_ok=True)

bp = Blueprint("rivalry_api", __name__, url_prefix="/rivalry-api")

# =====================================================================
# 配置
# =====================================================================

def _load_local_cfg():
    try:
        with open(os.path.join(BASE_DIR, "config.local.json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _get_auth_secret():
    """读取 AUTH_SECRET；未配置则自动生成并持久化（重启不失效）"""
    env = os.environ.get("RIVALRY_AUTH_SECRET", "").strip()
    if env:
        return env
    local = _load_local_cfg().get("rivalry_auth_secret", "")
    if local:
        return str(local).strip()
    secret_path = os.path.join(DATA_DIR, "secret.key")
    try:
        s = open(secret_path, "r", encoding="utf-8").read().strip()
        if s:
            return s
    except Exception:
        pass
    s = secrets.token_urlsafe(48)
    try:
        with open(secret_path, "w", encoding="utf-8") as f:
            f.write(s)
    except Exception:
        pass
    return s


AUTH_SECRET = _get_auth_secret()


def _get_admin_emails():
    """管理员邮箱（小写去重）"""
    emails = []
    env = os.environ.get("RIVALRY_ADMIN_EMAILS", "")
    if env:
        emails += [e.strip().lower() for e in env.split(",") if e.strip()]
    local = _load_local_cfg().get("rivalry_admin_emails", [])
    if isinstance(local, str):
        local = [e.strip() for e in local.split(",") if e.strip()]
    if local:
        emails += [str(e).strip().lower() for e in local if str(e).strip()]
    seen, out = set(), []
    for e in emails:
        if e and e not in seen:
            seen.add(e)
            out.append(e)
    return out


ADMIN_EMAILS = _get_admin_emails()


def _get_super_admin_emails():
    """超级管理员邮箱（小写去重），优先级高于 ADMIN_EMAILS"""
    emails = []
    env = os.environ.get("RIVALRY_SUPER_ADMIN_EMAILS", "")
    if env:
        emails += [e.strip().lower() for e in env.split(",") if e.strip()]
    local = _load_local_cfg().get("rivalry_super_admin_emails", [])
    if isinstance(local, str):
        local = [e.strip() for e in local.split(",") if e.strip()]
    if local:
        emails += [str(e).strip().lower() for e in local if str(e).strip()]
    seen, out = set(), []
    for e in emails:
        if e and e not in seen:
            seen.add(e)
            out.append(e)
    return out


SUPER_ADMIN_EMAILS = _get_super_admin_emails()

# 角色体系：super_admin(3) > admin(2) > sub_admin(1) > user(0)
ROLE_LEVEL = {"super_admin": 3, "admin": 2, "sub_admin": 1, "user": 0}
ROLE_LABEL = {"super_admin": "超级管理员", "admin": "主管理号", "sub_admin": "子管理号", "user": "普通账号"}

# =====================================================================
# JSON 文件存储（进程内缓存 + 原子写 + 线程锁）
# 说明：PythonAnywhere 免费版为单进程 WSGI，内存缓存不会过期；
#       若外部手工改了文件，需要 Reload 一次让缓存重建。
# =====================================================================

class _FileStore:
    def __init__(self, name, default):
        self.path = os.path.join(DATA_DIR, name)
        self._default = default
        self._lock = threading.RLock()
        self._cache = None

    def _load(self):
        if self._cache is not None:
            return self._cache
        data = json.loads(json.dumps(self._default))  # 深拷贝默认值
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, type(self._default)):
                data = loaded
        except Exception:
            pass
        self._cache = data
        return data

    def _persist(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._cache, f, ensure_ascii=False)
        os.replace(tmp, self.path)

    def get(self, key, default=None):
        with self._lock:
            data = self._load()
            return data.get(key, default)

    def put(self, key, value):
        with self._lock:
            data = self._load()
            data[key] = value
            self._persist()

    def delete(self, key):
        with self._lock:
            data = self._load()
            if key in data:
                del data[key]
                self._persist()

    def read(self):
        with self._lock:
            return self._load()

    def replace(self, value):
        with self._lock:
            self._cache = value
            self._persist()


users_s = _FileStore("users.json", {})           # email -> user
uids_s = _FileStore("uids.json", {})             # user_id -> email
refresh_s = _FileStore("refresh.json", {})       # refresh_token -> {user_id}
albums_s = _FileStore("albums.json", {})         # album_id -> album
album_photos_s = _FileStore("album_photos.json", {})  # album_id -> [photo_id]
photos_s = _FileStore("photos.json", {})         # photo_id -> photo
album_ids_s = _FileStore("album_ids.json", [])   # [album_id]（新->旧）
favs_s = _FileStore("favs.json", {})             # user_id -> [album_id]
fav_index_s = _FileStore("fav_index.json", {})   # album_id -> [user_id]

# =====================================================================
# 密码 / JWT（与 worker.js 兼容）
# =====================================================================

def _random_hex(n_bytes):
    return secrets.token_hex(n_bytes)


def _hash_password(password, salt_hex):
    """PBKDF2-SHA256, 100000 次迭代, 256 位 —— 与 worker.js hashPassword 完全一致"""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), 100000
    ).hex()


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _now_iso():
    now = datetime.now(timezone.utc)
    return now.strftime("%Y-%m-%dT%H:%M:%S") + ".%03dZ" % (now.microsecond // 1000)


def _sign_jwt(payload, ttl_sec):
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"},
                                separators=(",", ":")).encode("utf-8"))
    now = int(_time.time())
    body = _b64url(json.dumps({**payload, "iat": now, "exp": now + ttl_sec},
                              separators=(",", ":")).encode("utf-8"))
    signing_input = f"{header}.{body}".encode("utf-8")
    sig = hmac.new(AUTH_SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
    return f"{header}.{body}.{_b64url(sig)}"


def _verify_jwt(token):
    try:
        parts = token.split(".")
        if len(parts) != 3:
            return None
        h, p, s = parts
        signing_input = f"{h}.{p}".encode("utf-8")
        expected = hmac.new(AUTH_SECRET.encode("utf-8"), signing_input, hashlib.sha256).digest()
        if not hmac.compare_digest(_b64url_decode(s), expected):
            return None
        payload = json.loads(_b64url_decode(p))
        if payload.get("exp") and payload["exp"] < _time.time():
            return None
        return payload
    except Exception:
        return None

# =====================================================================
# 响应 / 通用工具
# =====================================================================

def _json(data, status=200):
    resp = jsonify(data)
    resp.status_code = status
    return resp


def _err(msg, status=400):
    return _json({"error": msg}, status)


def _to_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _public_user(user):
    return {
        "id": user.get("id"),
        "email": user.get("email"),
        "role": user.get("role") or "user",
        "user_metadata": {"username": user.get("username", "")},
    }


def _is_admin_email(email):
    return (email or "").strip().lower() in ADMIN_EMAILS


def _is_super_admin_email(email):
    return (email or "").strip().lower() in SUPER_ADMIN_EMAILS


def _role_level(role):
    return ROLE_LEVEL.get(role or "user", 0)


def _can_upload(role):
    """super_admin / admin / sub_admin 均可上传图集"""
    return _role_level(role) >= 1


def _can_manage_all_albums(role):
    """super_admin / admin 可管理任意图集"""
    return _role_level(role) >= 2


def _role_for_email(email):
    """新账号默认角色：超级管理员邮箱→super_admin；管理员邮箱→admin；否则 user"""
    e = (email or "").strip().lower()
    if e in SUPER_ADMIN_EMAILS:
        return "super_admin"
    if e in ADMIN_EMAILS:
        return "admin"
    return "user"


def _sync_login_role(user):
    """登录时同步角色：超级/管理员邮箱强制对应角色；普通邮箱保留库中已有角色（可能已被提升为子管理号）"""
    e = str(user.get("email", "")).strip().lower()
    if e in SUPER_ADMIN_EMAILS:
        user["role"] = "super_admin"
    elif e in ADMIN_EMAILS:
        user["role"] = "admin"
    return user


def _require_auth():
    """返回 (payload, None) 或 (None, 错误响应)"""
    h = request.headers.get("Authorization", "")
    token = h[7:] if h.startswith("Bearer ") else None
    if not token:
        return None, _err("未登录", 401)
    payload = _verify_jwt(token)
    if not payload:
        return None, _err("登录已过期，请重新登录", 401)
    return payload, None


def _make_session(user):
    access = _sign_jwt(
        {"sub": user["id"], "email": user["email"], "role": user.get("role") or "user"},
        7 * 86400)
    refresh_token = _random_hex(32)
    refresh_s.put(refresh_token, {"user_id": user["id"]})
    return {
        "access_token": access,
        "refresh_token": refresh_token,
        "user": _public_user(user),
    }

# =====================================================================
# 认证
# =====================================================================

@bp.route("/auth/register", methods=["POST"])
def _register():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _err("请求格式错误")
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    username = str(body.get("username", "")).strip()
    if not re.match(r"^[\w.+-]+@[\w-]+(\.[\w-]+)+$", email):
        return _err("邮箱格式不正确")
    if len(password) < 6:
        return _err("密码至少需要 6 位")
    if not username:
        return _err("用户名不能为空")
    if users_s.get(email):
        return _err("该邮箱已注册")
    salt = _random_hex(16)
    user = {
        "id": str(uuid.uuid4()),
        "email": email,
        "username": username,
        "salt": salt,
        "pw_hash": _hash_password(password, salt),
        "role": _role_for_email(email),
        "created_at": _now_iso(),
    }
    users_s.put(email, user)
    uids_s.put(user["id"], email)
    return _json(_make_session(user), 201)


@bp.route("/auth/login", methods=["POST"])
def _login():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _err("请求格式错误")
    email = str(body.get("email", "")).strip().lower()
    password = str(body.get("password", ""))
    user = users_s.get(email)
    if not user:
        return _err("邮箱或密码错误", 401)
    if _hash_password(password, user.get("salt", "")) != user.get("pw_hash"):
        return _err("邮箱或密码错误", 401)
    if user.get("banned"):
        return _err("账号已被拉黑，请联系管理员", 403)
    # 登录时同步角色：超级/管理员邮箱强制对应角色，普通邮箱保留提升后的角色
    _sync_login_role(user)
    users_s.put(email, user)
    return _json(_make_session(user))


@bp.route("/auth/refresh", methods=["POST"])
def _refresh():
    body = request.get_json(silent=True) or {}
    token = str(body.get("refresh_token", ""))
    rec = refresh_s.get(token)
    if not rec:
        return _err("登录已过期，请重新登录", 401)
    email = uids_s.get(rec.get("user_id"))
    user = users_s.get(email) if email else None
    if not user:
        return _err("账号不存在", 401)
    refresh_s.delete(token)  # 轮换 refresh token
    return _json(_make_session(user))


@bp.route("/auth/logout", methods=["POST"])
def _logout():
    return Response(status=204)


@bp.route("/me", methods=["GET"])
def _me():
    payload, err = _require_auth()
    if err:
        return err
    email = uids_s.get(payload["sub"])
    u = users_s.get(email) if email else None
    if u:
        return _json(_public_user(u))
    return _json(_public_user({
        "id": payload["sub"],
        "email": payload.get("email", ""),
        "role": payload.get("role") or "user",
        "username": "",
    }))

# =====================================================================
# 图集
# =====================================================================

def _album_summary(a):
    return {
        "id": a.get("id"),
        "title": a.get("title"),
        "tags": a.get("tags") or [],
        "cover_key": a.get("cover_key"),
        "cover_thumb_key": a.get("cover_thumb_key"),
        "photo_count": a.get("photo_count") or 0,
        "owner": a.get("owner"),
        "created_at": a.get("created_at"),
    }


@bp.route("/albums/latest", methods=["GET"])
def _latest_albums():
    limit = _to_int(request.args.get("limit") or 10, 10)
    limit = max(1, min(limit, 30))
    out = []
    for aid in album_ids_s.read()[:limit]:
        a = albums_s.get(aid)
        if a:
            out.append(_album_summary(a))
    return _json(out)


@bp.route("/albums", methods=["GET"])
def _list_albums():
    payload, err = _require_auth()
    if err:
        return err
    limit = _to_int(request.args.get("limit") or 24, 24)
    limit = max(1, min(limit, 100))
    offset = max(_to_int(request.args.get("offset") or 0, 0), 0)
    q = request.args.get("q", "").strip().lower()
    tag = request.args.get("tag", "").strip().lower()
    only_fav = request.args.get("only_fav") == "1"

    ids = favs_s.get(payload["sub"], []) if only_fav else album_ids_s.read()
    out = []
    for aid in ids:
        a = albums_s.get(aid)
        if not a:
            continue
        if q and q not in (a.get("title") or "").lower():
            continue
        if tag and not any(tag in str(t).lower() for t in (a.get("tags") or [])):
            continue
        out.append(_album_summary(a))
    return _json({"albums": out[offset:offset + limit], "total": len(out)})


@bp.route("/albums", methods=["POST"])
def _create_album():
    payload, err = _require_auth()
    if err:
        return err
    if not _can_upload(payload.get("role")):
        return _err("仅子管理号及以上可上传图集", 403)
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return _err("请求格式错误")
    title = str(body.get("title", "")).strip()
    if not title:
        return _err("图集标题不能为空")
    tags = [str(t).strip() for t in (body.get("tags") or []) if str(t).strip()][:10]
    photos = body.get("photos")
    if not isinstance(photos, list) or len(photos) == 0:
        return _err("至少需要一张照片")

    aid = str(uuid.uuid4())
    now = _now_iso()
    photo_ids = []
    for ph in photos:
        pid = str(uuid.uuid4())
        photos_s.put(pid, {
            "id": pid,
            "album_id": aid,
            "filename": str(ph.get("filename") or ""),
            "object_key": str(ph.get("object_key") or ""),
            "thumb_key": str(ph.get("thumb_key") or ""),
            "size_bytes": _to_int(ph.get("size_bytes")),
            "width": _to_int(ph.get("width")),
            "height": _to_int(ph.get("height")),
            "created_at": now,
        })
        photo_ids.append(pid)

    first = photos[0]
    album = {
        "id": aid,
        "title": title,
        "tags": tags,
        "owner": payload["sub"],
        "cover_key": str(first.get("object_key") or ""),
        "cover_thumb_key": str(first.get("thumb_key") or ""),
        "photo_count": len(photo_ids),
        "created_at": now,
    }
    albums_s.put(aid, album)
    album_photos_s.put(aid, photo_ids)

    ids = album_ids_s.read()
    ids.insert(0, aid)
    album_ids_s.replace(ids)
    return _json({"album": _album_summary(album), "photos": len(photo_ids)}, 201)


@bp.route("/albums/<aid>/photos", methods=["POST"])
def _add_album_photos(aid):
    payload, err = _require_auth()
    if err:
        return err
    if not _can_upload(payload.get("role")):
        return _err("仅子管理号及以上可上传图集", 403)
    album = albums_s.get(aid)
    if not album:
        return _err("图集不存在", 404)
    # 子管理号只能向自己创建的图集添加照片
    if not _can_manage_all_albums(payload.get("role")) and album.get("owner") != payload["sub"]:
        return _err("只能向自己创建的图集添加照片", 403)
    body = request.get_json(silent=True)
    photos = body.get("photos") if isinstance(body, dict) else None
    if not isinstance(photos, list) or len(photos) == 0:
        return _err("至少需要一张照片")

    photo_ids = album_photos_s.get(aid, [])
    now = _now_iso()
    for ph in photos:
        pid = str(uuid.uuid4())
        photos_s.put(pid, {
            "id": pid,
            "album_id": aid,
            "filename": str(ph.get("filename") or ""),
            "object_key": str(ph.get("object_key") or ""),
            "thumb_key": str(ph.get("thumb_key") or ""),
            "size_bytes": _to_int(ph.get("size_bytes")),
            "width": _to_int(ph.get("width")),
            "height": _to_int(ph.get("height")),
            "created_at": now,
        })
        photo_ids.append(pid)
    album_photos_s.put(aid, photo_ids)
    album["photo_count"] = len(photo_ids)
    albums_s.put(aid, album)
    return _json({"ok": True, "photo_count": len(photo_ids)})


@bp.route("/albums/<aid>", methods=["GET"])
def _get_album(aid):
    payload, err = _require_auth()
    if err:
        return err
    album = albums_s.get(aid)
    if not album:
        return _err("图集不存在", 404)
    photos = []
    for pid in album_photos_s.get(aid, []):
        p = photos_s.get(pid)
        if p:
            photos.append(p)
    return _json({"album": _album_summary(album), "photos": photos})


@bp.route("/albums/<aid>", methods=["DELETE"])
def _delete_album(aid):
    payload, err = _require_auth()
    if err:
        return err
    album = albums_s.get(aid)
    if not album:
        return _err("图集不存在", 404)
    # 主管理号及以上可删任意图集；子管理号仅可删自己创建的图集
    if not _can_manage_all_albums(payload.get("role")):
        if payload.get("role") != "sub_admin" or album.get("owner") != payload["sub"]:
            return _err("无权限删除此图集", 403)
    for pid in album_photos_s.get(aid, []):
        photos_s.delete(pid)
    album_photos_s.delete(aid)
    albums_s.delete(aid)

    ids = album_ids_s.read()
    if aid in ids:
        ids.remove(aid)
        album_ids_s.replace(ids)

    for uid in fav_index_s.get(aid, []):
        favs = favs_s.get(uid, [])
        if aid in favs:
            favs.remove(aid)
            favs_s.put(uid, favs)
    fav_index_s.delete(aid)
    return _json({"ok": True})

# =====================================================================
# 收藏（按图集）
# =====================================================================

@bp.route("/albums/<aid>/favorite", methods=["GET"])
def _check_favorite(aid):
    payload, err = _require_auth()
    if err:
        return err
    return _json({"is_favorite": aid in favs_s.get(payload["sub"], [])})


@bp.route("/albums/<aid>/favorite", methods=["PUT"])
def _add_favorite(aid):
    payload, err = _require_auth()
    if err:
        return err
    if not albums_s.get(aid):
        return _err("图集不存在", 404)
    favs = favs_s.get(payload["sub"], [])
    if aid not in favs:
        favs.insert(0, aid)
        favs_s.put(payload["sub"], favs)
        idx = fav_index_s.get(aid, [])
        if payload["sub"] not in idx:
            idx.append(payload["sub"])
            fav_index_s.put(aid, idx)
    return _json({"ok": True})


@bp.route("/albums/<aid>/favorite", methods=["DELETE"])
def _remove_favorite(aid):
    payload, err = _require_auth()
    if err:
        return err
    favs = favs_s.get(payload["sub"], [])
    if aid in favs:
        favs.remove(aid)
        favs_s.put(payload["sub"], favs)
    idx = fav_index_s.get(aid, [])
    if payload["sub"] in idx:
        idx.remove(payload["sub"])
        fav_index_s.put(aid, idx)
    return _json({"ok": True})

# =====================================================================
# 健康检查 / CORS
# =====================================================================

@bp.route("/health", methods=["GET"])
def _health():
    return _json({"ok": True})


@bp.after_request
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    return resp


@bp.route("/<path:_path>", methods=["OPTIONS"])
def _options(_path):
    return Response(status=204)
