# zen-gateway

> opencode zen（Go 档）→ OpenAI + Anthropic 兼容网关，让 claude code / codex / cursor 等标准客户端直接使用 opencode zen 免费模型。

单文件、**零 npm 依赖**（Node ≥ 18 原生 `http` + `fetch`），本地/内网可部署。与 go-rotate **共用 `go-keys.json`**（同文件、同跨进程锁、同原子写），配额用尽自动轮换 key 并重试一次。

## 架构

```
┌────────────┐   OpenAI 格式请求（任意模型名）   ┌─────────────────┐   固定 hy3 等真实模型    ┌──────────────┐
│ codex      │ ── POST /v1/chat/completions ──▶ │  zen-gateway     │ ── Bearer <当前key> ──▶ │ opencode zen │
│ cursor     │ ── GET  /v1/models             ──▶ │  (18888)        │                         │ /zen/go/v1   │
│ openai SDK │ ── GET  /healthz               ──▶ │  ├ 模型映射      │ ◀── SSE 逐块透传 ─────── │              │
└────────────┘                                     │  ├ key 轮换(锁)  │                         └──────────────┘
                                                   │  └ 日志          │
┌────────────┐   Anthropic Messages 协议（双层转换）└─────────────────┘
│ claude code│ ── POST /v1/messages ─────────────▶ │  Anthropic→OpenAI→zen→OpenAI→Anthropic
│            │ ── x-api-key / Authorization Bearer
└────────────┘
                                    ▲ 读/写（锁+原子）
                                    │
                          ~/.config/opencode/go-keys.json  ［与 go-rotate 共用］
```

- **codex / cursor / OpenAI SDK**：走 OpenAI 兼容 `POST /v1/chat/completions`，SSE 原样透传。
- **claude code**：走 Anthropic Messages `POST /v1/messages`，网关做**双层协议转换**（Anthropic 请求 → OpenAI 请求 → 上游 zen → OpenAI 响应 → Anthropic 响应），流式逐事件转换（不缓冲整段响应）。
- **codex（新版）/ cursor（GPT-5 系）**：走 OpenAI Responses `POST /v1/responses`；`/v1/chat/completions` 收到含 `input` 无 `messages` 的 body 时自动走 Responses 转换（cursor 兼容分支）。

## 动态模型表

启动时**异步拉取上游 `/v1/models`**（用当前 key，3s 超时）并入运行时动态表；拉取失败静默降级为内置 26 个模型并警告（不阻塞启动）。模型判定优先级：**动态表（上游最新）→ 内置表 → 别名表 → 默认 `hy3`**。

```bash
curl http://127.0.0.1:18888/v1/models                    # 合并动态+内置（去重排序）
curl -X POST http://127.0.0.1:18888/v1/models/refresh    # 手动刷新动态表
```

## 用量统计

### 实时计数（内存，重启清零）

网关内存中记录每 key 的使用量：

```bash
curl http://127.0.0.1:18888/api/usage
# → {"totalRequests":N,"rotations":N,"uptimeSec":N,"perKey":{"act1":{"success":N,"rotated":N,"cooldown_until":null}}}
```

- `success`：该 key 成功响应的请求数；`rotated`：该 key 作为失败方触发轮换的次数。
- `/healthz` 也附带 `rotations` 总数。
- **重启清零**（内存计数，非持久化）。

### 用量趋势（usage.jsonl，持久化）

每次请求完成后**追加**一行 JSON 到 `usage.jsonl`（默认 `~/.local/share/zen-gateway/usage.jsonl`，可用 `ZEN_USAGE_FILE` 覆盖），格式：

```json
{"ts":"2026-08-16T05:22:38.171Z","key":"act2","ok":true,"model":"hy3","rotated":false,"endpoint":"chat"}
```

- `ts`：请求完成时间（ISO）；`key`：最终使用的 key 名；`ok`：最终响应是否 2xx；`rotated`：本次请求是否触发轮换；`model`：实际映射后的上游模型；`endpoint`：`chat` / `messages` / `responses`。
- 与 `/api/usage` 内存计数互补：`/api/usage` 是**当前进程**实时状态，`usage.jsonl` 是**跨重启**的趋势数据。
- 简单追加写（`appendFileSync`），零依赖；行数上限 5000，超过后截断保留后 1000 行（防无限膨胀）。
- 查看：`tail -f ~/.local/share/zen-gateway/usage.jsonl`，趋势分析用 `node zen-gateway/usage-report.mjs`（零依赖：汇总 / 按 key 明细 / 按日趋势柱状图，支持 `--key/--endpoint` 筛选与 `--json` 输出；详见 `docs/用量趋势分析.md`）：

```bash
node zen-gateway/usage-report.mjs
# 总请求数  : 18      成功 11  失败 7  成功率 61.1%  轮换次数 2  坏行数 0
# 按 key 明细: act1 18 11 7 2  2026-08-16T06:02:24.347Z
# 按日趋势  : 2026-08-16 |##############################  18
```
- 另可用 CLI `go-rotate stats` 从日志 `/tmp/opencode-go-rotate.log` 统计每 key 的轮换/冷却次数（跨进程，含插件轮换记录）。

## 系统通知（macOS）

配额耗尽触发轮换**成功切换到新 key 后**，通过 `osascript` 发 macOS 系统通知（`display notification`），文案含新 key 名（不含 key 值）：

`zen-gateway 轮换 — 已切换到 key "act2"（配额耗尽自动轮换）`

- 仅 macOS（非 darwin 自动跳过）；`osascript` 失败只 `log()` 不 crash（静默）。
- 用 `ZEN_NOTIFY=0` 关闭（默认开）。

## 主动探测（尽力而为的配额保活）

opencode zen 无公开配额 API，只能发最小请求探测当前 key 是否仍可用。设 `ZEN_PROBE_INTERVAL_MIN`（分钟，>0 启用）后，网关每间隔对**当前 key** 发最小探测（`hy3` + `max_tokens:1` + 非流式 + 15s 超时）：

- 配额错误（401/402/429 或消息匹配配额类）→ 走与请求路径相同的 `rotate()`（冷却失败 key + 轮换 + 通知）。
- 成功 / 其它错误 → 仅 `log()` 状态，不轮换。
- 探测异常静默（只 log 不 crash）；与请求路径并发安全（`rotate()` 内部已有 `withLockAsync` 锁）。
- **默认关闭**（`ZEN_PROBE_INTERVAL_MIN` 未设或 ≤0 不启用），需要时再开。

## 启动

```bash
cd zen-gateway
node gateway.mjs                 # 前台运行，Ctrl+C 停止
# 或后台运行（日志重定向到文件，客户端日志仍写 /tmp/opencode-go-rotate.log）
nohup node gateway.mjs >/tmp/zen-gateway.log 2>&1 &
```

> **独立部署（无 opencode 机器）**：本网关不依赖 opencode 本体——UA 自动回退官方版本、鉴权只用 `go-keys.json` 的 `sk-` key、`plan=zen` 即免费档。Linux systemd / macOS launchd 完整部署步骤见 [`docs/部署指南-独立机器.md`](../docs/部署指南-独立机器.md)。

默认绑定 `127.0.0.1:18888`（避开 go-rotate 的 8899 与 tui-control 的 7792-7811）。

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ZEN_GATEWAY_PORT` | `18888` | 监听端口 |
| `ZEN_GATEWAY_HOST` | `127.0.0.1` | 监听地址（仅本地；内网共享可改 `0.0.0.0`） |
| `ZEN_GATEWAY_TOKEN` | 无 | 设置后所有请求需 `Authorization: Bearer <token>` |
| `ZEN_CONFIG` | `~/.config/opencode/go-keys.json` | key 配置文件路径覆盖（测试/多实例用） |
| `ZEN_AUTH_FILE` | `~/.local/share/opencode/auth.json` | auth.json 路径覆盖（测试/多实例隔离用；不设则行为不变，轮换仍同步真实 auth.json） |
| `ZEN_DEFAULT_MODEL` | `hy3` | 未知名模型映射到的真实模型 |
| `ZEN_UPSTREAM_BASE` | `https://opencode.ai/zen/go/v1` | 上游端点覆盖 |
| `ZEN_USAGE_FILE` | `~/.local/share/zen-gateway/usage.jsonl` | 用量趋势追加日志路径覆盖（测试用） |
| `ZEN_NOTIFY` | 开 | `0` 关闭轮换系统通知（仅 macOS） |
| `ZEN_PROBE_INTERVAL_MIN` | 关 | 主动探测间隔（分钟）；`>0` 启用，`0`/未设不启用 |

## zen 免费档 IP 轮换（egress 出口池）

> 背景：opencode.ai 免费档（`plan=zen`）按 **IP** 限流（实测：同一 key + 官方 UA 直连固定 IP 高频请求易触发 `429 FreeUsageLimitError`，换出口 IP 可绕过——与账号无关，所以 key 轮换无效）。

在 `gateway-config.json` 配置 `egress` 数组即可启用（**未配置时行为与旧版完全一致**，零开销）：

```jsonc
{
  "plan": "zen",
  "ip_rotation": true,          // IP 轮换总开关（可选，缺省 true；false = 关闭，即使有出口池也走本地直连）
  "egress": [
    "direct",                     // 本地直连
    "socks5://user:pass@host:1080", // SOCKS5 代理（可选认证）
    "socks5://host2:1080"
  ]
}
```

- `egress` **≥2 项**时启用 IP 轮换；仅 `direct` 或未配置 → 不轮换（单出口直连，向后兼容）。
- 出口项：`direct` = 本地直连；`socks5://[user:pass@]host:port` = SOCKS5 代理（零依赖手写握手 + CONNECT 隧道，支持无认证与 user-pass 认证）。
- 触发条件：请求返回 `FreeUsageLimitError`（免费档按 IP 限流）→ **自动切到下一个出口重试一次**，成功则固化该出口，后续请求不再无脑轮换；失败则保留新出口供下次再判。
- **IP 轮换总开关 `ip_rotation: false`**：关闭时即使配置了出口池也**直接走本地直连、不轮换**（如免费代理全军覆没时可一键关闭）。开启/关闭与出口增删**无需重启网关即时生效**（模块按需读当前配置）。
- Web 管理端（127.0.0.1:8899 → 网关 → IP 池卡）顶部有「IP 轮换总开关」按钮，一键开/关（写 `ip_rotation`，即时生效，无需重启）。
- 生效方式：改 `gateway-config.json` 后 `zen-gateway restart`（出口池模块加载时固化一次）。
- 适用场景：本地直连被限时，挂 1~2 个稳定 SOCKS5 代理作备用出口（免费公开代理存活率极低，建议用付费稳定代理）。

### 健康检查（每出口真实最小探测）

`POST /api/gateway/egress/health`（带鉴权头）——对配置的每个出口发一次最小请求（`hy3-free` + `max_tokens:1`），返回隧道连通性 + 该出口 IP 是否被上游限流：

```bash
curl -s -X POST -H "Authorization: Bearer <TOKEN>" http://127.0.0.1:18888/api/gateway/egress/health
# → {"checkedAt":"2026-08-18T09:57:00Z","egress":[
#      {"index":0,"url":"socks5://1.2.3.4:1080","ms":2000,"status":429,"ok":false,"error":"HTTP 429 (FreeUsageLimitError)"},
#      {"index":1,"url":"socks5://5.6.7.8:1080","ms":1200,"status":200,"ok":true}]}
```

- 状态语义：`ok:true`（HTTP 200）= 该出口 IP 当前未被限流、隧道通；`429 FreeUsageLimit` = 代理活着但该 IP 被限；`error` = 隧道连接失败/超时（代理挂了）。
- 每项 15s 超时、**串行**执行（探测 n 项 ≈ n×15s 上限）；真实消耗每项 ~1 token。
- 只读探测：不轮换、不冷却、不改 current。
- Web 管理端（127.0.0.1:8899 → 网关 → IP 池卡「检查出口」按钮）已集成：逐项显示 `健康`/`IP 被限流 429`/`不可用` 徽标。修改出口后无需重启即可用「检查出口」验证。

### 免费代理批量淘源（`fetch_proxies.py`）

根目录 `fetch_proxies.py`（零依赖 Python 标准库）批量拉取 4 个免费 SOCKS5 列表源 → 连通性验证 → 输出可直接粘贴进 `egress` 的 `socks5://host:port`：

```bash
python3 fetch_proxies.py --check --limit 300 --timeout 6   # 拉取 + 连通性验证（默认验证目标 opencode.ai:443）
python3 fetch_proxies.py --check --to 1.2.3.4:443          # 指定验证目标
python3 fetch_proxies.py --limit 100                       # 仅拉取不验证
python3 fetch_proxies.py --json                            # JSON 输出（供脚本消费）
```

- 输出分两栏：`socks5://host:port \t OK/FALL \t ms`，OK 项按延迟升序排前面。
- 选出的活代理填进 `egress` 后，用 Web/IP 池「检查出口」做**真实请求**验证——连通≠可用，免费数据中心 IP 大多已被 opencode.ai 限流（429），但限流是分时段的，池子轮换 + 健康检查会自动在各出口间浮动挑可用者。
- 2026-08 实测：859 候选 → 154 连通（18% 存活率），其中大部分对 opencode.ai 返回 429（代理连通但 IP 被限），仅极少数能 200。稳定方案仍建议付费 SOCKS5（Webshare 免费档 10 IP 或 DataImpulse $1/GB）。

## 验证

```bash
# 健康检查
curl -s http://127.0.0.1:18888/healthz

# 模型清单
curl -s http://127.0.0.1:18888/v1/models

# 非流式（请求任意模型名，网关会映射到 hy3）
curl -s http://127.0.0.1:18888/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":200,"stream":false}'

# 流式（SSE 逐块透传）
curl -sN http://127.0.0.1:18888/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"hy3","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_tokens":200,"stream":true}'
```

若设置了 `ZEN_GATEWAY_TOKEN`，所有请求加 `-H 'Authorization: Bearer <token>'`。

## 服务化运行（macOS launchd / Linux systemd，推荐）

把 zen-gateway 做成常驻服务：**开机自启**、崩溃自动重启、日志持久化，用 `zen-gateway` 命令统一管理。适合作为长驻的「供应服务」。macOS 用 launchd LaunchAgent，Linux 用 systemd **--user** unit，安装脚本自动识别系统。

### 安装（一键）

```bash
bash install.sh zen-gateway      # 或 bash install.sh --zen-gateway（需 Node ≥ 18）
```

安装内容（自动识别 macOS / Linux）：
- 拷贝 `gateway.mjs` → `~/.local/share/zen-gateway/gateway.mjs`
- 创建默认 `go-keys.json`（`~/.config/opencode/`）与 `gateway-config.json`（`~/.local/share/zen-gateway/`，0600）——安装即可用，后续 `go-rotate add` 填 key、`go-rotate gateway plan zen|go` 切套餐
- 拷贝管理脚本 → `~/.local/bin/zen-gateway`
- macOS：生成 LaunchAgent `~/Library/LaunchAgents/com.go-rotate.zen-gateway.plist` 并 `launchctl bootstrap`
- Linux：生成 systemd user unit `~/.config/systemd/user/zen-gateway.service` 并 `systemctl --user enable --now`

> 若你之前用 `nohup node gateway.mjs &` 手动跑过网关，请先停掉它（`pkill -f gateway.mjs`），
> 否则旧实例会占用 18888 端口，导致服务实例 `EADDRINUSE`（KeepAlive 会反复重启但它占不到端口）。

### 管理命令

| 命令 | 说明 |
|---|---|
| `zen-gateway status` | 查看状态（running / stopped，含健康检查 + launchd/systemd 详情） |
| `zen-gateway start` | 启动（幂等，已在运行则提示） |
| `zen-gateway stop` | 停止（幂等，未运行则提示） |
| `zen-gateway restart` | 重启 |
| `zen-gateway logs [-f]` | 查看 / 跟踪日志（`-f` 跟随） |
| `zen-gateway uninstall [-y]` | 卸载服务（bootout/disable + 删 unit/plist/日志，**不动 go-keys.json / auth.json**） |

### 卸载

```bash
zen-gateway uninstall            # 交互确认
# 或用 install.sh 一键卸载（含删 gateway.mjs 与管理脚本、bootout/disable）：
bash install.sh zen-gateway-uninstall -y
```

### macOS 服务细节

- **label**：`com.go-rotate.zen-gateway`（项目品牌命名，对任何用户可移植，不用 `com.jary.*`）。
- **plist**：`RunAtLoad=true`（开机自启）`KeepAlive=true`（崩溃自动重启）`ProcessType=Background`（无 UI 后台服务）。
- **日志**：`StandardOutPath`/`StandardErrorPath` → `~/Library/Logs/zen-gateway.log`。
  网关自身还会写 `/tmp/opencode-go-rotate.log`（与 go-rotate 同文件，含 key 轮换记录）。
- **端口/环境变量**：默认不注入环境变量，走代码默认值（`127.0.0.1:18888` / 默认模型）。
  如需改端口/上游/加 token，编辑 `~/Library/LaunchAgents/com.go-rotate.zen-gateway.plist`
  的 `EnvironmentVariables`（模板里留了注释示例），然后：
  ```bash
  launchctl bootout gui/$(id -u)/com.go-rotate.zen-gateway
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.go-rotate.zen-gateway.plist
  ```

### Linux（systemd --user）细节

- **unit**：`~/.config/systemd/user/zen-gateway.service`（模板 `zen-gateway/systemd/zen-gateway.user.service`，安装时替换占位符）。
- **自启**：`systemctl --user enable --now`；如需**开机**自启（无人登录场景），执行 `loginctl enable-linger $USER`。
- **日志**：`~/.local/share/zen-gateway/logs/gateway.log`（由 unit 内 `ZEN_LOG_FILE` 指向）。
- **环境变量**：默认内置 `ZEN_UPSTREAM_UA=opencode/1.18.18`（无 opencode 机器也自动回退官方 UA），其余走代码默认值；编辑 unit 加 `Environment=` 行后 `systemctl --user daemon-reload && systemctl --user restart zen-gateway`。

### Anthropic Messages 端点（claude code）

```bash
# 非流式（Anthropic 协议 → 上层转换 → zen）
curl -s http://127.0.0.1:18888/v1/messages \
  -H 'x-api-key: any' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4","max_tokens":200,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
# → {"id":"msg_...","type":"message","role":"assistant","model":"hy3","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn",...}

# 流式（逐事件转换：message_start → content_block_start → content_block_delta → ... → message_stop）
curl -sN http://127.0.0.1:18888/v1/messages \
  -H 'x-api-key: any' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4","stream":true,"max_tokens":200,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'

# 带 tools（Anthropic tools/tool_choice → OpenAI function/tool_calls → Anthropic tool_use）
curl -s http://127.0.0.1:18888/v1/messages \
  -H 'x-api-key: any' -H 'anthropic-version: 2023-06-01' -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4","max_tokens":300,"tools":[{"name":"get_weather","description":"Get weather","input_schema":{"type":"object","properties":{"city":{"type":"string"}}}}],"messages":[{"role":"user","content":"Weather in SF? Use the tool."}]}'
```

### OpenAI Responses 端点（新版 codex / cursor GPT-5 系）

新版 codex（2026 起仅 Responses API）与 cursor 的 GPT-5 系模型走 `POST /v1/responses`（body 用 `input` 数组 + `max_output_tokens`）。网关已实现双兼容：

```bash
# 非流式（Responses → OpenAI → zen → Responses）
curl -s http://127.0.0.1:18888/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5","input":[{"role":"user","content":[{"type":"input_text","text":"Reply with exactly: OK"}]}],"max_output_tokens":200}'
# → {"id":"resp_...","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}],...}

# 流式（逐事件转换：response.created → ... → response.output_text.delta → ... → response.completed）
curl -sN http://127.0.0.1:18888/v1/responses \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-5","input":[{"role":"user","content":[{"type":"input_text","text":"Reply with exactly: OK"}]}],"max_tokens":200,"stream":true}'

# cursor 兼容：GPT-5 系模型会把 Responses 形状 body 发到 /v1/chat/completions
# → 网关自动检测（body 含 input 无 messages）走 Responses 转换，无需特殊配置
```

| 客户端 | 配置 |
|---|---|
| **codex** | `OPENAI_BASE_URL=http://127.0.0.1:18888/v1` `OPENAI_API_KEY=<任何占位或 token>`（新版自动走 /v1/responses）— **已实测**（codex-cli 0.147.0，config.toml 需 `model_provider="zen"` + `wire_api="responses"` + **`web_search="disabled"`**，见 [clients.md](../docs/zen-gateway-clients.md) §2） |
| **cursor** | 自定义 OpenAI 兼容 endpoint → `http://127.0.0.1:18888/v1`，API key 填 token（GPT-5 系模型名自动走 Responses 检测分支） |

- 鉴权：claude code 发 `x-api-key` 或 `Authorization: Bearer`，两者网关都接受（设了 `ZEN_GATEWAY_TOKEN` 时关键值必须等于 token）。
- `anthropic-version` header 被接收但**不强制校验**。
- `thinking` 参数被忽略（不传给上游，避免 400）；`max_tokens` 不足时按 `stop_reason:"max_tokens"` + 空 text 块返回，避免 claude code 报错。

## 供其它 agent 的 baseURL 配置

模型名会被**自动映射**到 zen 真实模型（未知名 → `hy3`），各 agent 可保留自己习惯的模型名：

| 客户端 | 配置 |
|---|---|
| **claude code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:18888` + `ANTHROPIC_AUTH_TOKEN=<ZEN_GATEWAY_TOKEN>`（可选）+ `ANTHROPIC_API_KEY=any`（见下） |
| **codex** | `OPENAI_BASE_URL=http://127.0.0.1:18888/v1` `OPENAI_API_KEY=<任何占位或 token>` |
| **cursor** | 自定义 OpenAI 兼容 endpoint → `http://127.0.0.1:18888/v1`，API key 填 token |
| **curl / openai SDK** | `base_url="http://127.0.0.1:18888/v1"` |

### claude code 直连（Anthropic Messages API）— 已实测 ✅

claude code 原生走 Anthropic 协议，网关已提供 `/v1/messages` 兼容端点，**无需第三方协议转换层**。实测（2026-08-16，claude v2.x 本机）：

| 测试 | 命令 | 结果 |
|---|---|---|
| 基础问答 | `claude -p "Reply with exactly: OK"` | ✅ `OK`（约 30s，hy3 推理） |
| 显式模型 | `claude -p "What is 2+2?" --model hy3` | ✅ `4` |
| **工具多轮** | `claude -p "Use bash to calculate 17*23, then reply with just the result."` | ✅ `391`（tool_use → tool_result 完整循环） |

推荐用环境变量配置（注意：**`~/.claude/settings.json` 里若有 `ANTHROPIC_AUTH_TOKEN`（如别的代理的 `PROXY_MANAGED`）会劫持直连、忽略 BASE_URL**——务必先删掉或用 `claude --settings <临时文件>` 覆盖）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:18888
export ANTHROPIC_AUTH_TOKEN=<ZEN_GATEWAY_TOKEN>   # 若网关设了 token 则填之；否则可省
export ANTHROPIC_API_KEY=any-placeholder           # claude code 必填，但网关用 AUTH_TOKEN 鉴权，随意填
claude -p "hi"                                     # 或 claude -p --model claude-sonnet-4 "hi"
```

- `ANTHROPIC_BASE_URL` 指向网关根地址（claude code 会自动拼 `/v1/messages`）。
- `ANTHROPIC_AUTH_TOKEN` 让 claude code 发 `Authorization: Bearer <token>`，**这是网关鉴权的首选通道**（token 密文不出现在 URL）。
- `ANTHROPIC_API_KEY` 填任意占位（claude code 要求存在）；网关里 `x-api-key` 只有等于 token 才鉴权通过，所以真实 token 走 AUTH_TOKEN 更稳。
- 若不想用环境变量，可用 `claude config set apiKeyHelper "echo <token>"`（让 claude code 通过 helper 取 key），但**每次 claude code 启动都要有上述 env**，环境变量更推荐。
- 模型名自动映射：`claude-sonnet-4` / `claude-opus-4` / `claude-haiku-4-5` 等 → 默认 `hy3`；想换非推理模型可设 `ZEN_DEFAULT_MODEL=deepseek-v4-flash`。

## key 管理与轮换

- 复用 `~/.config/opencode/go-keys.json`（与 go-rotate 同一个文件，增删 key 用 `go-rotate` 或 Web 界面）。
- 每次请求取**当前 key**；上游返回 401/402/429 或消息含 `quota/insufficient/balance/rate limit/exceeded` → 当前 key 进冷却（优先解析错误里的 `reset at <time>`，否则用 `cooldown_minutes`）→ 切下一个可用 key → **重试一次**。
- **`plan=zen` 免费档自动轮换已禁用**（2026-08-18）：同设备 UA/频率限流与账号无关，轮换无效反而误伤冷却——401/402/CreditsError 等配额类错误一律**透传不轮换、不冷却**（`FreeUsageLimitError` 本就不轮换）。`plan=go` 付费档保留自动轮换；手动轮换（`gateway next` / Web）不受影响。
- 写配置与 go-rotate 用**同一把文件锁**（`go-keys.json.lock`）+ 原子写（tmp+rename），跨进程安全。
- 轮换结果同步写 `~/.local/share/opencode/auth.json`，保证与 opencode 插件路径一致。

## 模型映射表

| 客户端请求模型 | 实际发往 zen | 说明 |
|---|---|---|
| `hy3` / `hy3-preview` | 原样透传 | 直接命中 |
| `grok-code` / `grok-3` / `grok-3-mini` | `hy3` | hy3 是推理模型，语义接近最新 grok |
| `grok-4` | `grok-4.5` | |
| `claude-*` / `gpt-5` / `gemini-*` | `hy3`（默认） | 未知名 → 默认模型 |
| `gpt-4o` | `glm-5.2` | |
| `gpt-4o-mini` / 小模型 | `deepseek-v4-flash` | 轻量 |
| `deepseek-chat` | `deepseek-v4-pro` | |
| `deepseek-reasoner` | `hy3` | 推理 |
| `qwen-max` | `qwen3.7-max` | |
| **其它任意** | `hy3` | 兜底 |

已在 `ZEN_MODELS` 中硬编码的 26 个真实 Go 档模型会原样透传：`deepseek-v4-flash/pro`、`glm-5/5.1/5.2/5.3`、`gpt-5.6-luna`、`grok-4.5`、`hy3/hy3-preview`、`kimi-k2.5/2.6/2.7-code/k3`、`mimo-v2-omni/pro/2.5/2.5-pro`、`minimax-m2.5/2.7/m3`、`qwen3.5-plus/3.6-plus/3.7-max/3.7-plus/3.8-max`。

## 已知注意事项

- **hy3 是推理模型**：会先输出 `reasoning` 再输出 `content`，`max_tokens` 需预留推理余量，否则可能只返回 `content: null`。工具密集 / agentic 场景若不想被推理开销拖慢，可用 `ZEN_DEFAULT_MODEL=deepseek-v4-flash` 或 `glm-5.2`（非推理）。
- **Anthropic 端点也一样**：`content: null` 时网关会转成 `stop_reason:"max_tokens"` + 空 text 块，claude code 不会崩。
- 流式时上游会发 `: keep-alive` 注释行，网关原样透传（OpenAI 与 Anthropic 端点都是）。
- 未设置 `ZEN_GATEWAY_TOKEN` 时默认只绑定 `127.0.0.1`；要内网共享请同时改 `ZEN_GATEWAY_HOST=0.0.0.0` **并**设置 token。
- 流式透传/转换不缓冲整段响应；Anthropic 流式只保留一个块内的小缓冲（SSE 行拼装 + tool_calls 参数分片透传）。若上游在流中段报错，无法中途重试（仅重试发生在响应头返回配额错误时）。

## 新装常见问题（2026-08-16 端到端安装审计补充）

> 以下条目来自对新装用户全链路（安装 → 服务化 → 端点 → 卸载）的真实审计，详见 `docs/审查报告-新装审计.md`。

1. **macOS 系统 bash 3.2 下中文提示乱码/变量值丢失**：`zen-gateway` 管理脚本中「中文全角字符紧邻 `$变量`」的提示（如 `状态: running（健康检查通过 $HEALTH_URL）`）在系统 bash 3.2 下会丢值乱码。**功能与退出码不受影响**，仅提示显示问题；用 zsh 运行或忽略即可。已知（非阻断）。
2. **18888 端口被手动实例占用（EADDRINUSE）**：如果此前 `nohup node gateway.mjs &` 手动跑过，旧实例占着 18888，LaunchAgent（KeepAlive）会反复重启但占不到端口。**先 `pkill -f gateway.mjs` 再 `bash install.sh zen-gateway`**。
3. **launchd 首次 spawn 较慢**：`zen-gateway start` 的健康等待上限 15s，首次 bootstrap 可能需要 ~8s，属正常；等不到就用 `zen-gateway logs` 看进度。
4. **`zen-gateway status` 显示「loaded 但健康检查未通过」**：先 `zen-gateway logs` 看报错——常见是端口被占（见 2）或 `node` 不在 LaunchAgent 环境（安装时已写入绝对路径，一般不会）。
5. **codex 接入必须 `web_search = "disabled"`**：codex 默认会发 `{"type":"web_search"}` 工具（无 name），网关会转成空名 function 导致上游 400。config.toml 顶层加 `web_search = "disabled"`，详见 `docs/zen-gateway-clients.md` §2。
6. **claude code 被 `ANTHROPIC_AUTH_TOKEN` 劫持**：只要该变量存在（如 `PROXY_MANAGED`），claude code 会忽略 `ANTHROPIC_BASE_URL` 直连上游。切网关前 `unset ANTHROPIC_AUTH_TOKEN`，详见 `docs/zen-gateway-clients.md` §1。
7. **改端口/加 token**：编辑 `~/Library/LaunchAgents/com.go-rotate.zen-gateway.plist` 取消注释 `EnvironmentVariables` 块填值，然后 `zen-gateway restart`（或 bootout + bootstrap）。

## 与 go-rotate 的关系

- **共用**：`go-keys.json`、`auth.json` 同步、日志 `/tmp/opencode-go-rotate.log`、跨进程文件锁。
- **独立**：go-rotate 是 opencode 插件（bun），本网关是纯 Node 服务，两者可同时运行、互不干扰。
- 本网关自带一份与 go-rotate 同思路的锁/原子写/轮换实现（约 60 行自包含），避免跨运行时依赖。