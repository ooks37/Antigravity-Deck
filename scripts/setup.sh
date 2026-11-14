#!/usr/bin/env bash
# === Antigravity Deck 中文版 — 一键安装与更新 (macOS / Linux) ===
# 用法: curl -sL https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/setup.sh | bash

set -e

REPO="https://github.com/ooks37/Antigravity-Deck.git"
REPO_API="https://api.github.com/repos/ooks37/Antigravity-Deck"
INSTALL_DIR="$HOME/.antigravity-deck"

# --- 解析目标版本引用（优先 AG_DECK_REF，其次本仓库正式 Release，默认追踪 main 分支）---
get_latest_ref() {
    if [ -n "${AG_DECK_REF:-}" ]; then
        echo "$AG_DECK_REF"
        return
    fi
    # 仅查询当前 fork 仓库自身发布的正式 Release，不回退到从上游同步过来的旧英文 tag
    local tag
    tag=$(curl -sL "$REPO_API/releases/latest" 2>/dev/null \
        | grep '"tag_name"' | head -1 \
        | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
    if [ -n "$tag" ]; then
        echo "$tag"
        return
    fi
    echo "main"
}

echo ""
echo "  🔮 Antigravity Deck 中文版 — 一键安装与更新"
echo "  ============================================"
echo ""
echo "  安装位置: $INSTALL_DIR"
echo ""

# --- 检查前置依赖 ---
missing=()

# Node.js
if command -v node &>/dev/null; then
    node_ver=$(node --version)
    major=$(echo "$node_ver" | sed 's/^v\([0-9]*\).*/\1/')
    if [ "$major" -lt 18 ]; then
        echo "  ⚠️  当前 Node.js 版本为 $node_ver，需要 v18 及以上"
        missing+=("Node.js 18+")
    else
        echo "  ✅ Node.js $node_ver"
    fi
else
    echo "  ❌ 未检测到 Node.js"
    missing+=("Node.js 18+")
fi

# Git
if command -v git &>/dev/null; then
    echo "  ✅ $(git --version)"
else
    echo "  ❌ 未检测到 Git"
    missing+=("Git")
fi

# cloudflared (可选 — 仅 npm run online 远程穿透时需要)
cf_found=false
if command -v cloudflared &>/dev/null; then
    cf_found=true
elif [ -f /opt/homebrew/bin/cloudflared ]; then
    cf_found=true
elif [ -f /usr/local/bin/cloudflared ]; then
    cf_found=true
fi

if $cf_found; then
    echo "  ✅ cloudflared"
else
    echo "  ⚠️  未检测到 cloudflared（可选 — 仅公网远程穿透时需要）"
fi

if [ ${#missing[@]} -gt 0 ]; then
    echo ""
    echo "  缺少以下前置依赖:"
    for m in "${missing[@]}"; do
        case "$m" in
            "Node.js 18+") echo "    → 安装 Node.js: https://nodejs.org/" ;;
            "Git")         echo "    → 安装 Git: https://git-scm.com/" ;;
        esac
    done
    echo ""
    echo "  请先安装缺失工具，然后重新运行此脚本。"
    echo ""
    exit 1
fi

echo ""

# === 检测安装/更新场景 ===
scenario="fresh"       # fresh | up-to-date | updated
updated_files=""

TARGET_REF=$(get_latest_ref)

if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"

    # 确保 origin 指向当前 fork 仓库
    git remote set-url origin "$REPO" 2>/dev/null || true

    # 记录更新前 commit hash
    hash_before=$(git rev-parse HEAD 2>/dev/null || echo "")

    echo "  📂 检测到已有安装 — 正在检查更新..."

    if git fetch origin --tags --quiet 2>/dev/null; then
        TARGET_REF=$(get_latest_ref)
        target_hash=$(git rev-parse --verify "refs/remotes/origin/$TARGET_REF^{commit}" 2>/dev/null \
            || git rev-parse --verify "$TARGET_REF^{commit}" 2>/dev/null || echo "")

        if [ -n "$target_hash" ] && [ "$hash_before" = "$target_hash" ]; then
            scenario="up-to-date"
            echo "  ✅ 已是最新版本 ($TARGET_REF)"
        else
            echo "  📥 正在更新至 $TARGET_REF..."

            if git show-ref --verify --quiet "refs/remotes/origin/$TARGET_REF"; then
                git checkout -B "$TARGET_REF" "origin/$TARGET_REF" --quiet 2>/dev/null \
                    || git checkout "$TARGET_REF" --quiet 2>/dev/null
            else
                git -c advice.detachedHead=false checkout "$TARGET_REF" --quiet 2>/dev/null
            fi

            hash_after=$(git rev-parse HEAD 2>/dev/null || echo "")
            updated_files=$(git diff --name-only "$hash_before" "$hash_after" 2>/dev/null || echo "")
            scenario="updated"

            echo "  ✅ 已更新至 $TARGET_REF"
        fi
    else
        echo "  ⚠️  拉取更新失败（可能处于离线状态）— 将继续使用当前版本"
        scenario="up-to-date"
    fi
else
    echo "  📥 首次安装 — 正在克隆仓库..."
    mkdir -p "$INSTALL_DIR"
    git clone "$REPO" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
    if git show-ref --verify --quiet "refs/remotes/origin/$TARGET_REF"; then
        git checkout -B "$TARGET_REF" "origin/$TARGET_REF" --quiet 2>/dev/null \
            || git checkout "$TARGET_REF" --quiet 2>/dev/null
    else
        git -c advice.detachedHead=false checkout "$TARGET_REF" --quiet 2>/dev/null
    fi
    echo "  ✅ 已安装 $TARGET_REF"
fi

# === 按需安装依赖 ===
need_backend_deps=false
need_frontend_deps=false

case "$scenario" in
    "fresh")
        need_backend_deps=true
        need_frontend_deps=true
        ;;
    "updated")
        if echo "$updated_files" | grep -qE "^package\.json$|^package-lock\.json$"; then
            need_backend_deps=true
        fi
        if echo "$updated_files" | grep -qE "^frontend/package\.json$|^frontend/package-lock\.json$"; then
            need_frontend_deps=true
        fi

        echo ""
        echo "  📋 本次更新变更摘要:"

        be_count=$(echo "$updated_files" | grep -cvE "^frontend/|^scripts/|^docs/|^electron/|^$" || true)
        fe_count=$(echo "$updated_files" | grep -c "^frontend/" || true)
        el_count=$(echo "$updated_files" | grep -c "^electron/" || true)
        sc_count=$(echo "$updated_files" | grep -c "^scripts/" || true)
        doc_count=$(echo "$updated_files" | grep -c "^docs/" || true)

        [ "$be_count" -gt 0 ] 2>/dev/null && echo "    后端: $be_count 个文件"
        [ "$fe_count" -gt 0 ] 2>/dev/null && echo "    前端: $fe_count 个文件"
        [ "$el_count" -gt 0 ] 2>/dev/null && echo "    Electron: $el_count 个文件"
        [ "$sc_count" -gt 0 ] 2>/dev/null && echo "    脚本: $sc_count 个文件"
        [ "$doc_count" -gt 0 ] 2>/dev/null && echo "    文档: $doc_count 个文件"
        ;;
    "up-to-date")
        if [ ! -d "$INSTALL_DIR/node_modules" ]; then
            need_backend_deps=true
        fi
        if [ ! -d "$INSTALL_DIR/frontend/node_modules" ]; then
            need_frontend_deps=true
        fi
        ;;
esac

echo ""

if $need_backend_deps; then
    echo "  📦 正在安装后端依赖..."
    npm install
else
    echo "  ✅ 后端依赖无变更，跳过安装"
fi

if $need_frontend_deps; then
    echo ""
    echo "  📦 正在安装前端依赖..."
    npm install --prefix frontend
else
    echo "  ✅ 前端依赖无变更，跳过安装"
fi

# --- 初始化配置文件 ---
if [ ! -f "settings.json" ]; then
    cp settings.sample.json settings.json
    echo "  📝 已从模板生成 settings.json"
fi


# === 启动服务 ===
echo ""
echo "  正在启动 Antigravity Deck..."
echo ""

if $cf_found; then
    node start-tunnel.js --quiet --build
else
    node start-tunnel.js --local --build
fi
