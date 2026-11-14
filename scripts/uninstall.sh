#!/usr/bin/env bash
# === Antigravity Deck 中文版 — 一键卸载 (macOS / Linux) ===
# 用法: curl -sL https://raw.githubusercontent.com/ooks37/Antigravity-Deck/main/scripts/uninstall.sh | bash

INSTALL_DIR="$HOME/.antigravity-deck"

echo ""
echo "  🗑️  Antigravity Deck — 卸载程序"
echo "  ================================="
echo ""
echo "  安装位置: $INSTALL_DIR"
echo ""

if [ ! -d "$INSTALL_DIR" ]; then
    echo "  ℹ️  无需卸载 — 未找到安装目录。"
    echo ""
    exit 0
fi

# --- Kill processes with open handles inside the install dir ---
echo "  🔍 正在检查运行中的进程..."

killed=0

# Find processes whose command line references the install dir
if command -v pgrep &>/dev/null; then
    pids=$(pgrep -f "$INSTALL_DIR" 2>/dev/null || true)
    if [ -n "$pids" ]; then
        for pid in $pids; do
            proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            kill -9 "$pid" 2>/dev/null && {
                echo "  ✅ 已终止 $proc_name (PID $pid)"
                killed=$((killed + 1))
            }
        done
    fi
fi

# macOS: use lsof to find any process with open files inside the dir
if command -v lsof &>/dev/null; then
    lsof_pids=$(lsof +D "$INSTALL_DIR" 2>/dev/null | awk 'NR>1 {print $2}' | sort -u || true)
    if [ -n "$lsof_pids" ]; then
        for pid in $lsof_pids; do
            proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            kill -9 "$pid" 2>/dev/null && {
                echo "  ✅ 已终止 $proc_name (PID $pid) [lsof]"
                killed=$((killed + 1))
            }
        done
    fi
fi

# Linux: use fuser to find processes with files open in the dir
if command -v fuser &>/dev/null; then
    fuser_pids=$(fuser -m "$INSTALL_DIR" 2>/dev/null || true)
    if [ -n "$fuser_pids" ]; then
        for pid in $fuser_pids; do
            proc_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            kill -9 "$pid" 2>/dev/null && {
                echo "  ✅ 已终止 $proc_name (PID $pid) [fuser]"
                killed=$((killed + 1))
            }
        done
    fi
fi

if [ "$killed" -eq 0 ]; then
    echo "  ✅ 未发现运行中的进程"
else
    echo "  ⏳ 等待进程退出..."
    sleep 2
fi

echo ""

# --- Delete the install directory ---
echo "  🗑️  正在删除 $INSTALL_DIR ..."

if rm -rf "$INSTALL_DIR" 2>/dev/null; then
    echo "  ✅ Antigravity Deck 已卸载完成。"
else
    echo "  ⚠️  普通权限删除失败 — 尝试使用管理员权限重试..."
    sudo rm -rf "$INSTALL_DIR" 2>/dev/null && \
        echo "  ✅ Antigravity Deck 已卸载完成。" || \
        echo "  ❌ 无法删除目录，请手动关闭所有相关进程后重试。"
fi

echo ""
