# ============================================================
# go-rotate Windows 一键安装脚本（PowerShell，安装即用）
#
# 用法（PowerShell 或 CMD）:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   # 仅安装 zen-gateway 网关服务（不装 opencode 插件）:
#   powershell -ExecutionPolicy Bypass -File install.ps1 -GatewayOnly
#
# 安装内容:
#   1. 插件 go-rotate.ts  -> %USERPROFILE%\.config\opencode\plugins\（跳过 GatewayOnly）
#   2. CLI  go-rotate     -> %USERPROFILE%\.local\bin\ + go-rotate.cmd（跳过 GatewayOnly）
#   3. 默认配置 go-keys.json + gateway-config.json（若不存在，0600 语义）
#   4. zen-gateway.cmd 包装脚本（设置 env + 启动 node gateway.mjs）
#   5. Windows 计划任务 com.go-rotate.zen-gateway（schtasks，登录时自启 + 立即运行）
#
# 可重复运行（幂等，不覆盖已有配置）。卸载:
#   schtasks /End /TN com.go-rotate.zen-gateway ; schtasks /Delete /F /TN com.go-rotate.zen-gateway
#   Remove-Item -Recurse -Force "$env:USERPROFILE\.local\share\zen-gateway"
# ============================================================
param(
  [switch]$GatewayOnly   # 只装网关服务（服务器无 opencode 场景）
)

$ErrorActionPreference = "Stop"

$HOME_N = $env:USERPROFILE
if (-not $HOME_N -or $HOME_N -eq "") { $HOME_N = $env:USERPROFILE }
$HomeDir = $HOME_N

$ConfigDir  = Join-Path $HomeDir ".config\opencode"
$PluginDir  = Join-Path $ConfigDir "plugins"
$BinDir     = Join-Path $HomeDir ".local\bin"
$GwDir      = Join-Path $HomeDir ".local\share\zen-gateway"
$GwLog      = Join-Path $GwDir "logs"
$GwCfg      = Join-Path $GwDir "gateway-config.json"
$GwWrapper  = Join-Path $GwDir "zen-gateway.cmd"
$GwKeys     = Join-Path $ConfigDir "go-keys.json"
$GwUnitLog  = Join-Path $GwLog "gateway.log"
$GwUnitUsage= Join-Path $GwLog "usage.jsonl"
$TaskName   = "com.go-rotate.zen-gateway"

function Write-Step($msg) { Write-Host "[go-rotate] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "[go-rotate] $msg" -ForegroundColor Green }
function Write-WarnL($msg){ Write-Host "[go-rotate] $msg" -ForegroundColor Yellow }

# 检查依赖
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "[go-rotate] 错误: 未找到 node。请先安装 Node.js ≥ 18 (https://nodejs.org/)" -ForegroundColor Red
  exit 1
}
$NodeBin = (Get-Command node).Source
$PythonBin = $null
if (Get-Command python -ErrorAction SilentlyContinue) { $PythonBin = (Get-Command python).Source }

# 1) 查找仓库文件（脚本旁 or 下载）——安装脚本通常与源码一起分发；
#    若脚本在仓库内运行则 cp；否则提示从 GitHub raw 拉取。
$SrcRoot = $PSScriptRoot
function Get-SourceFile([string]$rel, [string]$dst) {
  $local = Join-Path $SrcRoot $rel
  if (Test-Path $local) { Copy-Item $local $dst -Force; return }
  # 回退：从 GitHub raw 拉取（BASE_URL 与 install.sh 一致）
  $url = "https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main/$rel"
  try {
    Invoke-WebRequest -Uri $url -OutFile $dst -UseBasicParsing -TimeoutSec 30
  } catch {
    Write-Host "[go-rotate] 下载失败: $url ($_)" -ForegroundColor Red
    exit 1
  }
}

New-Item -ItemType Directory -Force -Path $GwDir, $GwLog, $ConfigDir | Out-Null

# 2) gateway.mjs 程序本体
Get-SourceFile "zen-gateway/gateway.mjs" (Join-Path $GwDir "gateway.mjs")
Write-Ok "gateway => $GwDir\gateway.mjs"

# 3) go-keys.json（key 池，默认空 + 提示填 key；ascii 无 BOM，避免 JSON 解析器不兼容）
if (-not (Test-Path $GwKeys)) {
  @'
{
  "provider_id": "opencode-go",
  "cooldown_minutes": 300,
  "current": "",
  "keys": []
}
'@ | Set-Content -Path $GwKeys -Encoding ascii
  Write-Ok "go-keys.json => $GwKeys"
} else {
  Write-Ok "go-keys.json 已存在，跳过: $GwKeys"
}

# 4) gateway-config.json（套餐/token）
if (-not (Test-Path $GwCfg)) {
  '{"plan":"go"}' | Set-Content -Path $GwCfg -Encoding ascii
  Write-Ok "网关配置 => $GwCfg"
} else {
  Write-Ok "网关配置已存在，跳过: $GwCfg"
}

# 5) zen-gateway.cmd 包装脚本（计划任务执行；设置 env 后启动 node gateway.mjs）
#    %* 占位忽略（计划任务无参数）；日志重定向到网关日志文件。
$wrapper = @"
@echo off
setlocal
set "ZEN_LOG_FILE=$GwUnitLog"
set "ZEN_USAGE_FILE=$GwUnitUsage"
"$NodeBin" "$GwDir\gateway.mjs"
"@
Set-Content -Path $GwWrapper -Value $wrapper -Encoding ascii
Write-Ok "包装脚本 => $GwWrapper"

# 6) 注册计划任务（登录时自启 + 立即运行；ONLOGON 无需管理员）
schtasks /Create /F /TN $TaskName /TR "`"$GwWrapper`"" /SC ONLOGON | Out-Null
schtasks /Run /TN $TaskName | Out-Null
Write-Ok "计划任务已注册并启动（$TaskName），登录时自启 + 崩溃由 OS 重启（登录会话内）"

if (-not $GatewayOnly) {
  # 7) 插件 go-rotate.ts（opencode 用）
  New-Item -ItemType Directory -Force -Path $PluginDir | Out-Null
  Get-SourceFile "go-rotate.ts" (Join-Path $PluginDir "go-rotate.ts")
  Write-Ok "插件 => $PluginDir\go-rotate.ts"

  # 8) CLI go-rotate（Python）+ go-rotate.cmd 便捷入口
  if (-not $PythonBin) {
    Write-WarnL "未找到 python（CLI 需要 Python 3）。仅安装插件 + 网关服务；CLI 请在装 Python 后重新运行。"
  } else {
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $cliNoExt = Join-Path $BinDir "go-rotate"
    $cliCmd   = Join-Path $BinDir "go-rotate.cmd"
    Get-SourceFile "go-rotate" $cliNoExt
    # Windows 无 shebang，用 .cmd 便捷入口调 python；也保留无扩展名文件供参考
    "@echo off`r`n`"$PythonBin`" `"$cliNoExt`" %*`r`n" | Set-Content -Path $cliCmd -Encoding ascii
    Write-Ok "CLI => $BinDir\go-rotate.cmd"
    $binPathInUser = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($binPathInUser -notlike "*$BinDir*") {
      [Environment]::SetEnvironmentVariable("Path", "$binPathInUser;$BinDir", "User")
      Write-WarnL "已将 $BinDir 加入用户 PATH（新终端生效）。"
    } else {
      Write-Ok "PATH 已包含 $BinDir"
    }
  }
}

Write-Host ""
Write-Ok "安装完成！"
Write-Host "  下一步："
if (-not $GatewayOnly) {
  Write-Host "    1) 新终端执行: go-rotate add <名称> sk-<你的opencode账号key>"
  Write-Host "    2) 查看状态:    go-rotate status"
  Write-Host "    Web 界面:      go-rotate web  （http://127.0.0.1:8899）"
} else {
  Write-Host "    1) 编辑 go-keys.json 填入 opencode 账号 API key（$GwKeys）"
}
Write-Host "    2) 切换 zen 免费档: go-rotate gateway plan zen  （默认 go 付费档，免费档自动轮换已禁用）"
Write-Host "    3) 管理服务:      go-rotate gateway status / logs"