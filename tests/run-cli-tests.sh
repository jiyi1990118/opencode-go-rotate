#!/usr/bin/env bash
# go-rotate CLI 测试一键运行：语法检查 + 单测
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== py_compile =="
python3 -m py_compile go-rotate
echo "OK"

echo
echo "== 单元测试 =="
python3 tests/test-go-rotate-cli.py

echo
echo "== 真实配置隔离确认（md5 应前后一致）=="
md5 ~/.config/opencode/go-keys.json ~/.local/share/opencode/auth.json 2>/dev/null || true