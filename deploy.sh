#!/bin/bash
# ============================================================
# PythonAnywhere 一键部署脚本（强数据保护版）
# 用法: 在项目目录下执行 bash deploy.sh
# 安全特性:
#   1. git reset 之前先把 data/ / static/uploads/covers/avatars 整体移动到 /tmp 安全位置
#   2. git pull / git reset 完成后再整体移动回来 + 合并（永不丢失用户数据）
#   3. 如果 works.json 仍为空，自动调用 rebuild_data.py 从上传文件重建
# ============================================================
set -e

cd "$(dirname "$0")"
echo "======================================"
echo "[deploy] 当前目录: $(pwd)"

# ---------- 1) 把用户数据目录先"搬家"到 /tmp 安全位置 ----------
TS=$(date +%s)
SAFE="/tmp/portfolio_data_$TS"
mkdir -p "$SAFE"

echo "[deploy] 步骤1: 保护用户数据 → 搬移到 $SAFE"
for dir in data static/uploads static/covers static/avatars; do
  if [ -d "$dir" ]; then
    # 保留相对路径，便于之后原样搬回
    target="$SAFE/$dir"
    mkdir -p "$(dirname "$target")"
    # 用 mv 是原子操作，不占磁盘额外空间
    mv "$dir" "$target"
    echo "         ✓ $dir → $target  ($(find "$target" -type f 2>/dev/null | wc -l) 个文件)"
  fi
done

# ---------- 2) 拉最新代码 ----------
echo "[deploy] 步骤2: 拉取最新代码（hard reset 保持干净）"
# 既然目录都搬空了，即使有冲突文件也会被 reset 覆盖
if ! git fetch origin main 2>&1; then
  echo "         ⚠ git fetch 失败，尝试继续本地更新"
fi
git reset --hard origin/main 2>&1 || true

# ---------- 3) 把数据目录原样搬回来 ----------
echo "[deploy] 步骤3: 还原用户数据（与新代码做合并）"
for dir in data static/uploads static/covers static/avatars; do
  src="$SAFE/$dir"
  if [ -d "$src" ]; then
    # 如果 git reset 后新代码创建了该目录（例如 data 被 mkdir -p 创建），先清掉空目录
    if [ -d "$dir" ]; then
      # 目录如果不空（新代码带来了新文件？），把 src 里的文件合并进来，非冲突都保留 src 的
      echo "         → 合并 $dir ..."
      cp -rf "$src"/. "$dir"/ 2>/dev/null || true
    else
      mkdir -p "$(dirname "$dir")"
      mv "$src" "$dir"
    fi
    echo "         ✓ $dir 已还原 ($(find "$dir" -type f 2>/dev/null | wc -l) 个文件)"
  fi
done

# ---------- 4) 如果 works.json 不存在或为空，自动从 static/uploads 重建 ----------
if [ ! -f data/works.json ] || [ ! -s data/works.json ]; then
  echo "[deploy] 步骤4: works.json 丢失或为空 → 自动从上传文件重建"
  if [ -f venv/bin/python ]; then
    venv/bin/python rebuild_data.py 2>&1
  else
    python3 rebuild_data.py 2>&1
  fi
else
  echo "[deploy] 步骤4: works.json 存在，跳过自动重建"
fi

# ---------- 5) 收尾 ----------
echo
echo "======================================"
echo "[deploy] ✅ 代码更新完成！"
echo "[deploy] ℹ️  现在请到 PythonAnywhere Web 标签页点击"
echo "         Reload jiemensi.pythonanywhere.com"
echo "         让 WSGI 进程重启生效"
echo "======================================"
