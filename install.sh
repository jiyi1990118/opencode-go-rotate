#!/usr/bin/env bash
# ============================================================
# go-rotate 一键安装脚本 (opencode-go 多 key 自动轮换插件)
#
# 用法:
#   方式一（推荐，一行命令）:
#     curl -fsSL <REPO>/install.sh | bash
#   方式二（克隆/下载仓库后本地运行）:
#     bash install.sh
#   完整安装（插件 + CLI + 配置 + zen-gateway 网关服务）:
#     bash install.sh --all
#   卸载:
#     bash install.sh uninstall [-y]               # 仅卸载插件/CLI/配置
#     bash install.sh uninstall --gateway [-y]     # 同时卸载 zen-gateway 网关服务
#
# 安装内容:
#   1. 插件 go-rotate.ts  -> ~/.config/opencode/plugins/
#   2. CLI  go-rotate     -> ~/.local/bin/  (并加入 PATH)
#   3. 默认配置 go-keys.json (若不存在)
#   4. [--all] zen-gateway 网关服务（launchd 常驻，开机自启）
# 可重复运行（幂等，不会覆盖已有配置）。
# ============================================================
set -euo pipefail

# ---- 源码所在仓库的 raw 根 URL（末尾不要带 /）----
BASE_URL="https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main"
# ----------------------------------------------------------------

# 颜色
C_GREEN='\033[0;32m'; C_YELLOW='\033[1;33m'; C_CYAN='\033[0;36m'; C_RED='\033[0;31m'; C_NC='\033[0m'
info()  { echo -e "${C_CYAN}[go-rotate]${C_NC} $*"; }
ok()    { echo -e "${C_GREEN}[go-rotate]${C_NC} $*"; }
warn()  { echo -e "${C_YELLOW}[go-rotate]${C_NC} $*"; }
die()   { echo -e "${C_RED}[go-rotate]${C_NC} $*" >&2; exit 1; }

# 依赖检查
command -v curl >/dev/null 2>&1 || die "需要 curl (macOS: brew install curl; Debian/Ubuntu: sudo apt install curl)"
command -v python3 >/dev/null 2>&1 || die "需要 python3"

# 路径
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
PLUGIN_DIR="$CONFIG_DIR/plugins"
DATA_DIR="$CONFIG_DIR"
AUTH_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/opencode"

# 选择 bin 目录：优先 ~/.local/bin（若已存在且在 PATH），否则 ~/bin
pick_bin_dir() {
  for d in "$HOME/.local/bin" "$HOME/bin"; do
    if [ -d "$d" ] && [[ ":$PATH:" == *":$d:"* ]]; then
      echo "$d"; return
    fi
  done
  echo "$HOME/.local/bin"
}
BIN_DIR="$(pick_bin_dir)"

# --all 标记：默认安装完成后追加安装 zen-gateway 网关服务（任意位置识别）
ALL_FLAG="no"
for arg in "$@"; do
  [ "$arg" = "--all" ] && ALL_FLAG="yes"
done

# 判断是"本地运行"还是"curl|bash"
THIS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"

fetch_or_copy() {
  local src="$1" dst="$2"
  if [ -f "$THIS_DIR/$src" ]; then
    cp "$THIS_DIR/$src" "$dst"
  else
    # 通过 BASE_URL 拉取（兼容 curl|bash）
    local tmp; tmp="$(mktemp)"
    if ! curl -fsSL "$BASE_URL/$src" -o "$tmp"; then
      rm -f "$tmp"
      die "下载失败: $BASE_URL/$src（请检查 BASE_URL 或网络）"
    fi
    cp "$tmp" "$dst"; rm -f "$tmp"
  fi
}

# ================== zen-gateway 服务安装 ==================
# 用法: bash install.sh zen-gateway  或  bash install.sh --zen-gateway
# 卸载: bash install.sh zen-gateway-uninstall
# 把 zen-gateway 做成 macOS 常驻服务（launchd LaunchAgent，开机自启）。
install_zen_gateway() {
  echo ""
  info "=============================================="
  info " zen-gateway · opencode zen → OpenAI 兼容网关（macOS 常驻服务）"
  info "=============================================="
  command -v node >/dev/null 2>&1 || die "需要 node（≥18）。请先安装 Node.js"

  local NODE_BIN GATEWAY_DIR LAUNCH_AGENTS_DIR LOG_PATH PLIST_DST
  NODE_BIN="$(command -v node)"
  GATEWAY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/zen-gateway"
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  LOG_PATH="$HOME/Library/Logs/zen-gateway.log"
  PLIST_DST="$LAUNCH_AGENTS_DIR/com.go-rotate.zen-gateway.plist"

  # 1) gateway.mjs —— 程序本体放 ~/.local/share/zen-gateway/（应用数据目录，非配置）
  mkdir -p "$GATEWAY_DIR"
  fetch_or_copy "zen-gateway/gateway.mjs" "$GATEWAY_DIR/gateway.mjs"
  [ -x "$GATEWAY_DIR/gateway.mjs" ] || chmod +x "$GATEWAY_DIR/gateway.mjs"
  ok "gateway  => $GATEWAY_DIR/gateway.mjs"

  # 2) 管理脚本 -> ~/.local/bin/zen-gateway（与 go-rotate CLI 不冲突）
  mkdir -p "$BIN_DIR"
  fetch_or_copy "zen-gateway/zen-gateway" "$BIN_DIR/zen-gateway"
  chmod +x "$BIN_DIR/zen-gateway"
  ok "管理脚本 => $BIN_DIR/zen-gateway"

  # 3) 生成 LaunchAgent plist（模板占位符 → 真实绝对路径）
  mkdir -p "$LAUNCH_AGENTS_DIR"
  local TPL_TMP; TPL_TMP="$(mktemp)"
  fetch_or_copy "zen-gateway/launchd/com.go-rotate.zen-gateway.plist" "$TPL_TMP"
  python3 - "$TPL_TMP" "$PLIST_DST" "$NODE_BIN" "$GATEWAY_DIR/gateway.mjs" "$GATEWAY_DIR" "$LOG_PATH" <<'PY'
import sys
tpl, dst, node, mjs, gdir, lpath = sys.argv[1:]
s = open(tpl, encoding="utf-8").read()
for k, v in [("__NODE_BIN__", node), ("__GATEWAY_MJS__", mjs),
             ("__GATEWAY_DIR__", gdir), ("__LOG_PATH__", lpath)]:
    s = s.replace(k, v)
open(dst, "w", encoding="utf-8").write(s)
PY
  rm -f "$TPL_TMP"
  ok "plist    => $PLIST_DST"

  # 4) 加载 LaunchAgent（新版 bootstrap，回退旧版 load）
  if launchctl bootstrap "gui/$(id -u)" "$PLIST_DST" 2>/dev/null; then
    ok "服务已加载（label: com.go-rotate.zen-gateway），开机自启 + 崩溃自动重启"
  elif launchctl print "gui/$(id -u)/com.go-rotate.zen-gateway" >/dev/null 2>&1; then
    warn "label 已加载（可能是已安装的旧 plist），未重复 bootstrap。如需重载: zen-gateway restart"
  elif launchctl load "$PLIST_DST" 2>/dev/null; then
    ok "服务已加载（label: com.go-rotate.zen-gateway，旧版 load），开机自启 + 崩溃自动重启"
  else
    warn "LaunchAgent 加载失败（bootstrap/load 均失败）。请手动检查: launchctl bootstrap gui/\$(id -u) $PLIST_DST"
  fi

  echo ""
  echo "  常用命令："
  echo "    zen-gateway status     # 查看状态"
  echo "    zen-gateway start      # 启动"
  echo "    zen-gateway stop       # 停止"
  echo "    zen-gateway logs -f    # 跟踪日志 (~/Library/Logs/zen-gateway.log)"
  echo "    zen-gateway uninstall  # 卸载（不动 go-keys.json / auth.json）"
  echo "  卸载服务：bash install.sh zen-gateway-uninstall"
  echo ""
}

uninstall_zen_gateway() {
  echo ""
  warn "正在卸载 zen-gateway 服务 ..."
  local GATEWAY_DIR LAUNCH_AGENTS_DIR PLIST_DST LOG_PATH
  GATEWAY_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/zen-gateway"
  LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
  PLIST_DST="$LAUNCH_AGENTS_DIR/com.go-rotate.zen-gateway.plist"
  LOG_PATH="$HOME/Library/Logs/zen-gateway.log"
  local ans=""
  if [ "${2:-}" != "-y" ]; then
    printf "确认卸载？（不动 go-keys.json / auth.json）[y/N]: "
    read -r ans
  else
    ans="y"
  fi
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    # 先卸载 launchd 服务
    launchctl bootout "gui/$(id -u)/com.go-rotate.zen-gateway" 2>/dev/null || true
    launchctl bootout "gui/$(id -u)" "$PLIST_DST" 2>/dev/null || true
    launchctl unload "$PLIST_DST" 2>/dev/null || true
    [ -f "$PLIST_DST" ] && rm -f "$PLIST_DST" && ok "已删除 $PLIST_DST"
    [ -f "$LOG_PATH" ] && rm -f "$LOG_PATH" && ok "已删除 $LOG_PATH"
    [ -d "$GATEWAY_DIR" ] && rm -rf "$GATEWAY_DIR" && ok "已删除 $GATEWAY_DIR"
    [ -f "$BIN_DIR/zen-gateway" ] && rm -f "$BIN_DIR/zen-gateway" && ok "已删除 $BIN_DIR/zen-gateway"
    ok "zen-gateway 卸载完成。go-keys.json / auth.json 未改动。"
  else
    warn "已取消卸载。"
  fi
  exit 0
}

# ================== 卸载模式 ==================
# 用法: bash install.sh uninstall [--gateway] [-y]  或  bash install.sh -u
if [ "${1:-}" = "uninstall" ] || [ "${1:-}" = "-u" ]; then
  echo ""
  warn "正在卸载 go-rotate ..."
  PLUGIN="$PLUGIN_DIR/go-rotate.ts"
  CLI="$BIN_DIR/go-rotate"
  CONFIG="$DATA_DIR/go-keys.json"
  GW_FLAG="no"
  UNINSTALL_Y="no"
  for arg in "$@"; do
    [ "$arg" = "--gateway" ] && GW_FLAG="yes"
    [ "$arg" = "-y" ] && UNINSTALL_Y="yes"
  done
  echo "  将删除:"
  [ -f "$PLUGIN" ] && echo "    $PLUGIN"
  [ -f "$CLI" ] && echo "    $CLI"
  [ -f "$CONFIG" ] && echo "    $CONFIG"
  if [ "$GW_FLAG" = "yes" ]; then
    echo "    zen-gateway 网关服务（launchd 任务 + 程序 + 管理脚本）"
  fi
  ans=""
  if [ "$UNINSTALL_Y" != "yes" ]; then
    printf "确认卸载？删除配置会丢失 key 列表 [y/N]: "
    read -r ans
  else
    ans="y"
  fi
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    [ -f "$PLUGIN" ] && rm -f "$PLUGIN" && ok "已删除插件 $PLUGIN"
    [ -f "$CLI" ] && rm -f "$CLI" && ok "已删除 CLI $CLI"
    [ -f "$CONFIG" ] && rm -f "$CONFIG" && ok "已删除配置 $CONFIG"
    if [ "$GW_FLAG" = "yes" ]; then
      # 主卸载已确认；传 -y 给网关函数跳过其内部二次确认（该函数检查 $2 位）
      ( uninstall_zen_gateway -y -y )
    fi
    ok "卸载完成。auth.json 未改动（保留你的 opencode-go 凭据）。"
  else
    warn "已取消卸载。"
  fi
  exit 0
fi
# ==================================================

# zen-gateway 子命令分发
if [ "${1:-}" = "zen-gateway" ] || [ "${1:-}" = "--zen-gateway" ]; then
  install_zen_gateway
  exit 0
fi
if [ "${1:-}" = "zen-gateway-uninstall" ]; then
  uninstall_zen_gateway "$@"
  exit 0
fi

echo ""
info "=============================================="
info " go-rotate · opencode-go 多 key 自动轮换"
info "=============================================="

# 1) 安装插件
mkdir -p "$PLUGIN_DIR"
plugin_dst="$PLUGIN_DIR/go-rotate.ts"
fetch_or_copy "go-rotate.ts" "$plugin_dst"
ok "插件 => $plugin_dst"

# 2) 安装 CLI
mkdir -p "$BIN_DIR"
cli_dst="$BIN_DIR/go-rotate"
fetch_or_copy "go-rotate" "$cli_dst"
chmod +x "$cli_dst"
ok "CLI  => $cli_dst"

# 3) 确保 CLI 在 PATH
if ! [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
  rc=""
  [ -n "${ZSH_VERSION:-}" ] && rc="$HOME/.zshrc"
  [ -n "${BASH_VERSION:-}" ] && [ -z "$rc" ] && rc="$HOME/.bashrc"
  [ -z "$rc" ] && [ -f "$HOME/.zshrc" ] && rc="$HOME/.zshrc"
  [ -z "$rc" ] && [ -f "$HOME/.bashrc" ] && rc="$HOME/.bashrc"
  if [ -n "$rc" ]; then
    if ! grep -q "export PATH=.*$BIN_DIR" "$rc" 2>/dev/null; then
      printf '\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$rc"
      warn "已将 $BIN_DIR 加入 PATH ($rc)。新终端生效。"
    fi
  else
    warn "未找到 shell 配置文件，请手动将 $BIN_DIR 加入 PATH。"
  fi
fi

# 4) 默认配置（不覆盖已有）
config="$DATA_DIR/go-keys.json"
if [ ! -f "$config" ]; then
  mkdir -p "$DATA_DIR"
  cat > "$config" <<'JSON'
{
  "provider_id": "opencode-go",
  "cooldown_minutes": 300,
  "current": "",
  "keys": []
}
JSON
  ok "已创建默认配置 $config"
else
  ok "配置已存在，跳过: $config"
fi

# 5) 确保 auth.json 存在（opencode 通常已创建；若可写则建立占位）
if [ ! -f "$AUTH_DIR/auth.json" ]; then
  mkdir -p "$AUTH_DIR" 2>/dev/null || true
  printf '{\n  "opencode-go": {\n    "type": "api",\n    "key": ""\n  }\n}\n' > "$AUTH_DIR/auth.json" 2>/dev/null || \
    warn "无法创建 auth.json（ $AUTH_DIR ），将由 opencode 首次启动时自动创建。"
fi

# 6) --all 模式：追加安装 zen-gateway 网关服务（幂等，重复运行不覆盖已有配置/服务）
if [ "$ALL_FLAG" = "yes" ]; then
  install_zen_gateway
fi

echo ""
ok "安装完成！"
echo ""
echo "  下一步："
echo "    1) 配置 key（任选其一）"
echo "        交互式:  go-rotate init"
echo "        命令行:  go-rotate add <名称> <sk-...>"
echo "        Web界面: 启动 opencode 后访问 http://localhost:8899"
echo "    2) 查看状态: go-rotate status"
echo ""
echo "  插件会在每次 opencode 启动时自动加载，"
echo "  配额用尽时自动轮换到下一个可用 key。"
echo ""