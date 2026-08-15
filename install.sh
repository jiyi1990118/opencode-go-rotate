#!/usr/bin/env bash
# ============================================================
# go-rotate 一键安装脚本 (opencode-go 多 key 自动轮换插件)
#
# 用法:
#   方式一（推荐，一行命令）:
#     curl -fsSL <REPO>/install.sh | bash
#   方式二（克隆/下载仓库后本地运行）:
#     bash install.sh
#
# 安装内容:
#   1. 插件 go-rotate.ts  -> ~/.config/opencode/plugins/
#   2. CLI  go-rotate     -> ~/.local/bin/  (并加入 PATH)
#   3. 默认配置 go-keys.json (若不存在)
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

# ================== 卸载模式 ==================
# 用法: bash install.sh uninstall  或  bash install.sh -u
if [ "${1:-}" = "uninstall" ] || [ "${1:-}" = "-u" ]; then
  echo ""
  warn "正在卸载 go-rotate ..."
  PLUGIN="$PLUGIN_DIR/go-rotate.ts"
  CLI="$BIN_DIR/go-rotate"
  CONFIG="$DATA_DIR/go-keys.json"
  echo "  将删除:"
  [ -f "$PLUGIN" ] && echo "    $PLUGIN"
  [ -f "$CLI" ] && echo "    $CLI"
  [ -f "$CONFIG" ] && echo "    $CONFIG"
  ans=""
  if [ "${2:-}" != "-y" ]; then
    printf "确认卸载？删除配置会丢失 key 列表 [y/N]: "
    read -r ans
  else
    ans="y"
  fi
  if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
    [ -f "$PLUGIN" ] && rm -f "$PLUGIN" && ok "已删除插件 $PLUGIN"
    [ -f "$CLI" ] && rm -f "$CLI" && ok "已删除 CLI $CLI"
    [ -f "$CONFIG" ] && rm -f "$CONFIG" && ok "已删除配置 $CONFIG"
    ok "卸载完成。auth.json 未改动（保留你的 opencode-go 凭据）。"
  else
    warn "已取消卸载。"
  fi
  exit 0
fi
# ==================================================

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
    warn "无法创建 auth.json（$AUTH_DIR），将由 opencode 首次启动时自动创建。"
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