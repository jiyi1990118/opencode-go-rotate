# opencode zen → OpenAI + Anthropic 兼容网关 · 架构设计

> 调研 + 设计 + 实现记录。日期：2026-08-16。实现见 `zen-gateway/gateway.mjs`。

## 1. 背景与目标

让标准客户端（claude code / codex / cursor / openai SDK）直接使用 opencode zen（Go 档）免费模型，同时复用 go-rotate 已有的多 key 自动轮换能力。

- **codex / cursor / openai SDK**：OpenAI 兼容 `POST /v1/chat/completions`（SSE 原样透传）。
- **claude code**：原生 Anthropic `POST /v1/messages` 协议，网关做**双层协议转换**（Anthropic → OpenAI → zen → OpenAI → Anthropic），流式逐事件转换。

约束：单文件、零 npm 依赖（Node ≥ 18 原生）、本地/内网可部署、与 go-rotate 共用 `go-keys.json` 且不破坏其行为。

## 2. 机制研究结论（源码 + 线上实测）

### 2.1 opencode zen 端点（源码 `packages/console/app/src/routes/zen/go/v1/` + 线上实测）

| 端点 | 说明 | 实测 |
|---|---|---|
| `POST https://opencode.ai/zen/go/v1/chat/completions` | OpenAI 兼容，支持 `stream` / `model` / `max_tokens` / tools | ✅ 真实 key 跑通 |
| `GET /v1/models` | 返回 Go 档 26 个真实模型 | ✅ |
| `/v1/messages`、`/v1/responses`、`/v1/usage` | Anthropic / Responses / 用量端点（上游存在；本网关已实现自己的兼容端点，见 §3.8/§3.11/§3.12） | 源码确认存在 |

- 鉴权：`Authorization: Bearer <key>`，从 header 取（源码 `parseApiKey: h => h.split(" ")[1]`）。
- 模型取自 `ZenData.list("lite")`（Go 档 "lite" 列表），`/v1/models` 过滤掉 `alpha-` 前缀。
- 流式：标准 SSE，`data: {"object":"chat.completion.chunk",...}`，头部有 `: keep-alive` 注释行。
- 上游自己做 provider failover（`MAX_FAILOVER_RETRIES=3`）+ 自身限流（IP/key TPM/TPS）。

### 2.2 Go 档真实模型（线上 `/v1/models` 实测，26 个）

```
deepseek-v4-flash  deepseek-v4-pro  glm-5  glm-5.1  glm-5.2  glm-5.3
gpt-5.6-luna  grok-4.5  hy3  hy3-preview
kimi-k2.5  kimi-k2.6  kimi-k2.7-code  kimi-k3
mimo-v2-omni  mimo-v2-pro  mimo-v2.5  mimo-v2.5-pro
minimax-m2.5  minimax-m2.7  minimax-m3
qwen3.5-plus  qwen3.6-plus  qwen3.7-max  qwen3.7-plus  qwen3.8-max
```

### 2.3 hy3 是推理模型（重要 caveat）

实测：`max_tokens=8` 时返回 `content: null` + `reasoning: "..."`（8 个 token 全被 reasoning 吃掉）；`max_tokens=200` 时正常返回 `content: "OK"`（reasoning 20 + content 3）。→ **推理模型需预留 max_tokens 余量**。

### 2.4 配额/鉴权错误判定（来自 go-rotate `isQuotaError`）

- 状态码：`401 / 402 / 429`
- 或消息匹配：`quota | insufficient | balance | rate.?limit | usage limit | exceeded`
- 轮换优先级：解析错误消息中 `reset at <time 含时区偏移>`，否则用 `cooldown_minutes` 滚动窗口。

## 3. 架构决策

### 3.1 单文件零依赖，Node 原生

- 用 `node:http` 起服务，`fetch` 发上游请求，`ReadableStream` 做流式透传。
- 不复用 go-rotate.ts（那是 bun 插件，依赖 `Bun.serve` + 浏览器全局），网关自包含一套与 go-rotate **同思路**的锁/原子写/轮换（约 60 行），保证跨运行时可用。

### 3.2 与 go-rotate 共用 go-keys.json（跨进程安全）

- 同一配置文件 `~/.config/opencode/go-keys.json`。
- 写操作走**同一把文件锁** `go-keys.json.lock`（`wx` 创建 + 陈旧锁 15s + 超时 5s 降级）+ **原子写**（tmp+rename）。
- 轮换后同步 `~/.local/share/opencode/auth.json`，与 go-rotate 插件路径保持一致。
- 该文件锁与 go-rotate 的完全兼容（同一路径、同一创建/清理协议），两者可安全并发。
- **测试/多实例隔离**：`ZEN_CONFIG` 覆盖 go-keys.json 路径，`ZEN_AUTH_FILE` 覆盖 auth.json 路径
  （2026-08-16 新增，独立可只设一个）。轮换类集成测试必须同时设两者，避免假 key 写进真实
  go-keys.json / auth.json（此前曾发生轮换测试把假 key 写进真实 auth.json 的事故，见测试报告）。

### 3.3 模型映射（请求任意模型名 → 真实 zen 模型）

```
mapModel(requested):
  命中 ZEN_MODELS（26 个真实模型）   → 原样透传
  命中 MODEL_ALIASES（grok-code→hy3 等）→ 映射
  其它（claude-*、gpt-*、未知）       → DEFAULT_MODEL（hy3，可 env 覆盖）
```

- 优点：客户端保留自己习惯的模型名，无需改配置。
- 兜底默认 `hy3`（推理模型）；agentic/工具密集场景可 `ZEN_DEFAULT_MODEL=deepseek-v4-flash|glm-5.2` 避免推理开销。

### 3.4 轮换时序（请求内自动重试一次）

```
客户端请求
  → 取当前 key
  → 拼接 body，model 替换为映射后的真实模型
  → 上游请求（第 1 次）
      ├─ 2xx           → 直接返回 / SSE 透传
      └─ 配额错误(401/402/429 或消息匹配)
          → 锁内 rotate：失败 key 进冷却 + 写 last_status → 切下一可用 key（清空其 last_status）→ syncAuth
          → 用新 key 重试一次
              ├─ 2xx    → 返回
              └─ 仍配额 → 返回最后一次上游错误（不无限重试）
```

- 流式场景：先读上游响应头判断是否 2xx；2xx 则 SSE 逐块透传（不缓冲）；非 2xx 则读完整错误体 → 轮换 → 重试。流中段报错无法重试（已在 README 标注）。
- **`last_status` 健康状态同步（X1 修复，2026-08-16）**：`rotate()` 冷却失败 key 时按 go-rotate 契约写 `last_status`（`classifyGoError(msg, statusCode)` → 枚举 `invalid`/`nobalance`/`limited`/`error`，与 go-rotate 插件/CLI 逐条一致），新当前 key 清空为 `null`（视为未探测）；**无可用 key（no-next）分支同样落盘**（saveConfig），保证 go-rotate Web `/api/status` 能实时看到被网关轮换过的 key 的健康状态。字段结构与 go-rotate 完全同构（字符串枚举），Web/CLI 的 `statusLabel` 映射直接渲染。

### 3.5 流式透传（不缓冲）

- `fetch` 上游（`stream` 由 body 决定），`res.ok` 后 `res.body.getReader()` 逐块 `res.write(value)` 写给客户端，`content-type: text/event-stream`。
- 不透传 `: keep-alive` 会破坏 SSE 心跳，原样转发。

### 3.6 鉴权（可选）

- 默认绑定 `127.0.0.1`，不鉴权。
- 设 `ZEN_GATEWAY_TOKEN` 后，所有端点需 `Authorization: Bearer <token>`；内网共享需同时 `ZEN_GATEWAY_HOST=0.0.0.0` + token。

### 3.7 日志

- 与 go-rotate 同文件 `/tmp/opencode-go-rotate.log`，格式 `[ISO] [gateway] msg`。
- 含日志轮转（1MB / 保留 3 份），防止无限增长。

### 3.8 Anthropic Messages API 兼容层（claude code 直连，双层协议转换）

`POST /v1/messages` 兼容 claude code 的 Anthropic 协议。核心是把「Anthropic 请求 → OpenAI 请求 → 上游 zen → OpenAI 响应 → Anthropic 响应」做两层转换：

```
 claude code                        zen-gateway                            opencode zen
 ┌──────────┐  POST /v1/messages   ┌──────────────────────────────┐   POST /v1/chat/completions
 │ /v1/messages│  Anthropic 请求    │ ① anthropicToOpenAI(body)    │   Bearer <当前key>
 └────┬─────┘  x-api-key/Bearer    │ ② sendWithRotation(openaiBody)│──▶ OpenAI 格式
      │         anthropic-version  │ ③ openAIToAnthropic / stream │◀── 响应
      └───────────────────────────▶│ ④ streamAnthropic(逐事件)    │
                                    └──────────────────────────────┘
```

**① 请求转换 `anthropicToOpenAI`（只拷贝已知字段，`thinking`/`stop_sequences`/`metadata`/`top_k` 忽略，避免打 400）：**

| Anthropic 字段 | → OpenAI |
|---|---|
| `model`（如 claude-sonnet-4） | `mapModel` → 真实 zen 模型（默认 hy3） |
| `max_tokens` / `temperature` / `top_p` / `stream` | 原样透传 |
| `system`（string 或 content 数组） | 首条 `role:"system"` |
| `messages[].content` string | OpenAI `content` string |
| `messages[].content[]` text 块 | 拼接进 `content`（有 image 时转 content 数组） |
| `messages[].content[]` image（base64/url） | `image_url` 数组 |
| `messages[].content[]` tool_result | 拆出 `role:"tool"`（tool_call_id 取 `tool_use_id`），紧跟其后 |
| `tools[]`（name/description/input_schema） | OpenAI `{type:"function",function:{name,description,parameters}}` |
| `tool_choice`（auto/any/tool+name） | `"auto"` / `"required"` / `{type:"function",function:{name}}` |

**② 复用 `sendWithRotation`：** 与 OpenAI 端点同一套 key 轮换逻辑（401/402/429 → 冷却 → 切 key → 重试一次）。`sendWithRotation` 现返回 `mappedModel` 供响应组装。

**③ 非流式响应转换 `openAIToAnthropic`：**

| OpenAI 响应 | → Anthropic |
|---|---|
| `choices[0].message.content` | `content:[{type:"text",text}]` |
| `message.content`=null 但 `reasoning_content` 存在 | 用 reasoning 当 text（推理模型坑） |
| `message.tool_calls[]` | `content:[{type:"tool_use",id,name,input}]`（input 由 arguments JSON.parse） |
| `finish_reason` stop/length/tool_calls | `stop_reason` end_turn/max_tokens/tool_use |
| `usage.prompt_tokens/completion_tokens` | `usage.input_tokens/output_tokens` |
| content 为空（max_tokens 被推理吃完） | 补一个空 text 块 + `stop_reason:"max_tokens"`（避免 claude code 报错） |

**④ 流式逐事件转换 `streamAnthropic`（不缓冲整段响应）：**

OpenAI SSE chunk → Anthropic SSE 事件，事件映射见下表。内部只保留「一个块内」的小缓冲：SSE 行级拼装（网络层可能任意切分）+ tool_calls 参数分片透传（`partial_json` 原样转发，不做跨事件 JSON 拼接）。

### 3.9 Anthropic 流式事件映射表

| OpenAI chunk 字段 | → Anthropic SSE 事件 |
|---|---|
| （首个 chunk） | `event:message_start`（model、usage 初始） |
| `delta.content`（首个分片） | `content_block_start`（type:text） |
| `delta.content`（后续分片） | `content_block_delta`（text_delta） |
| `delta.tool_calls[i]` 首次出现（含新 id/name） | 关上一个块 + `content_block_start`（type:tool_use） |
| `delta.tool_calls[i].function.arguments` | `content_block_delta`（input_json_delta，partial_json 透传） |
| 块结束（切到另一块 / 流结束） | `content_block_stop` |
| `finish_reason` | `message_delta`（stop_reason: end_turn/max_tokens/tool_use + output_tokens） |
| `data:[DONE]` | `message_stop` + 结束 |
| `: keep-alive` 注释 | 原样透传 |

> 注意：OpenAI 的 tool_calls 会把 `id`/`name` 放在该 tool 的首个 chunk，`arguments` 以任意位置分片到达。按 `tc.index` 跟踪当前打开的 tool 块：同一 index 的 arguments 分片落在同一块内；index 变化才关旧开新，保证 `input_json_delta` 语义正确。

### 3.10 鉴权（Anthropic 路径）

- 复用 `gatewayAuth`（`ZEN_GATEWAY_TOKEN`），并扩展接受 claude code 的 `x-api-key` header（等于 token 时通过）。
- `anthropic-version` header 被接收但**不强制**校验版本号。

### 3.11 Responses API 兼容层（新版 codex / cursor GPT-5 系）

- `POST /v1/responses`：双层转换（`responsesToOpenAI`：input 数组/instructions/max_output_tokens/tools → chat completions；`openAIToResponse`：output_text/function_call → Responses）；流式逐事件转换（response.created → … → output_text.delta → … → response.completed）。
- **cursor 兼容**：`/v1/chat/completions` 收到含 `input` 无 `messages` 的 body 自动走 Responses 转换（不改客户端配置）。
- 错误路径：流中段上游报错发 `response.failed` 事件；非流式错误直接 `sendResponsesError`。

### 3.12 动态模型表（M3）与用量统计

- **动态模型表**：启动异步拉取上游 `/v1/models`（当前 key Bearer，3s 超时）→ `ZEN_MODELS_DYNAMIC`；失败降级内置 26 个并警告。判定优先级：动态 → 内置 → 别名 → 默认 `hy3`。`POST /v1/models/refresh` 手动刷新；`GET /v1/models` 返回动态∪内置（去重排序）。
- **用量统计**（内存，重启清零）：`sendWithRotation` 成功/轮换路径计数；`GET /api/usage` 返回 `{totalRequests, rotations, uptimeSec, perKey:{name:{success, rotated, cooldown_until}}}`；`/healthz` 附 `rotations`。

#### 3.12.1 用量趋势持久化（usage.jsonl，2026-08-16 新增）

`/api/usage` 是内存实时计数（重启清零），无法看跨重启趋势。新增**追加日志** `usage.jsonl`（默认 `~/.local/share/zen-gateway/usage.jsonl`，`ZEN_USAGE_FILE` 可覆盖）补足趋势：

- `appendUsage()` 每次 `sendWithRotation` 完成后 `appendFileSync` 一行 JSON：
  `{"ts":ISO,"key":name,"ok":bool,"model":mappedModel,"rotated":bool,"endpoint":"chat|messages|responses"}`
  - `ok` = 最终响应 2xx；`rotated` = 本次是否触发轮换；`endpoint` 由各调用点传入（`handleChatCompletions`→`chat`、`handleMessages`→`messages`、`handleResponsesBody`→`responses`）。
- **行数上限**：`_usageCount` 内存计数（启动 `seedUsageCount()` 从文件回填）；超过 5000 行且为 100 的倍数时 `truncateUsageIfNeeded()` 截断保留后 1000 行（防无限膨胀）。
- 与 `/api/usage` 各司其职：前者持久趋势、后者当前进程实时状态。

#### 3.12.2 轮换系统通知（macOS，2026-08-16 新增）

`rotate()` 成功切换到新 key（`log("✅ 轮换到 key ...")`）后调 `notify(title, text)`：

- `execFile("osascript", ["-e", 'display notification ... with title ...'])`，文案含新 key 名不含 key 值；失败只 `log()` 不 crash。
- 守卫：`process.platform !== "darwin"` 跳过；`ZEN_NOTIFY=0` 关闭（默认开）。
- osascript 是系统命令，不增加 npm 依赖。

#### 3.12.3 配额主动探测（定时保活，2026-08-16 新增）

opencode zen 无公开配额 API，只能发最小请求探测。`ZEN_PROBE_INTERVAL_MIN`（分钟）`>0` 时启用 `setInterval`：

- `probeCurrentKey()` 对**当前 key** 发最小探测（`GO_API` + `hy3` + `max_tokens:1` + 非流式 + `PROBE_TIMEOUT_MS` 15s），复用 `upstreamOnce`。
- 配额错误（`isQuotaError`）→ 调 `rotate(errBody, status, key.name)`（与请求路径一致：冷却失败 key + 轮换 + 通知）；成功/其它/异常 → 仅 `log()`，不轮换、静默。
- `_probeRunning` 标志防并发重复；`rotate()` 内部 `withLockAsync` 天然与请求路径并发安全。
- **默认关闭**（未设或 ≤0 不启用），Timers 不增加既有行为负担；探测不写 `usage.jsonl`（非客户端请求）。
- **reconcileCurrent（X2）**：`loadConfig` 中 current 不在 keys → 警告 + 内存修正为 keys[0]，写路径持久化（热路径不写盘）。
- **CLI 侧**：`go-rotate` 写命令 `_with_lock`（O_EXCL + 15s 陈旧锁 + 5s 超时降级，与插件同参数）+ `save()` 原子写（.tmp+rename）；`go-rotate stats` 从日志统计每 key 轮换/冷却次数。

## 4. 数据流

```
claude code/codex/cursor
  │  POST /v1/chat/completions {model:"claude-3-5-sonnet", stream:true, ...}
  ▼
zen-gateway (node:http, 18888)
  ├─ gatewayAuth?（token 校验）
  ├─ mapModel → "hy3"
  ├─ key = currentKey(go-keys.json)
  ├─ fetch https://opencode.ai/zen/go/v1/chat/completions  Bearer <key>
  │     ├─ 2xx  →  SSE 逐块透传回客户端
  │     └─ 429  →  rotate(): 锁内冷却+切换+syncAuth → 新 key 重试一次
  │                  └── 写 go-keys.json（原子）+ auth.json
  ▼
opencode zen（上游，自带 provider failover + 限流）
```

## 5. 边界情况

| 场景 | 处理 |
|---|---|
| go-keys.json 无 key | 返回 500 `no key configured`，日志提示 `go-rotate add` |
| 全部 key 冷却中 | `rotate()` 维持当前 key，返回原配额错误 |
| 请求未知模型名 | 映射到默认模型（hy3） |
| `stream:true` 上游 2xx | SSE 逐块透传，不缓冲 |
| `stream:true` 上游配额错误（响应头阶段） | 读错误体 → 轮换 → 重试一次 |
| 流中段报错 | 无法重试，连接中断（客户端可见） |
| 鉴权失败 | 401（仅当设置了 token） |
| 锁竞争（与 go-rotate 并发写） | 同一把锁 + 原子写，安全 |
| hy3 推理消耗 max_tokens | 文档注明，可换非推理模型 |
| Anthropic `thinking` 参数 | 忽略（不传给上游，避免 400） |
| Anthropic `system` 数组 / `tool_result` | 转成 system 消息 / role:"tool" |
| Anthropic `content:null`（推理吃光 token） | 空 text 块 + `stop_reason:"max_tokens"` |
| Anthropic 流式 tool_calls 分片 | 按 tc.index 跟踪块，input_json_delta 透传 |
| Anthropic 错误路径（上游 401/402/429） | 转 `{type:"error",error:{type:"api_error",message}}` |

## 6. 验证结果

- 语法：`node --check` PASS。
- **OpenAI 端点**：真实 key 非流式（content:"OK"/"pong"）、流式 SSE 透传、`/v1/models` 26 模型均实测。
- **Anthropic 端点（`/v1/messages`）**：
  - R1 非流式 `claude-sonnet-4` → `{"type":"message","model":"hy3","content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn","usage":{input:17,output:22}}` ✅
  - R2 流式 → 事件序列完整：`keep-alive` → `message_start` → `content_block_start` → `content_block_delta(text_delta "OK")` → `content_block_stop` → `message_delta(end_turn)` → `message_stop` ✅
  - R3 带 tools → `content:[{type:"tool_use",name:"get_weather",input:{city:"San Francisco"}}]` + `stop_reason:"tool_use"` ✅
  - R4 流式 tools → `content_block_start(tool_use)` + 3 段 `input_json_delta` 分片 + `stop_reason:"tool_use"` ✅
  - R5 `system` 数组 + `thinking` 忽略 + `tool_result` 多轮 → 正常返回 `"3"` ✅
  - R6 `max_tokens=8`（hy3 content:null）→ 空 text 块 + `stop_reason:"max_tokens"` ✅
  - R7 假 key 流式 → Anthropic error（非 SSE）✅；R8 坏 JSON → 400 Anthropic error ✅
  - R9 OpenAI 端点回归 `gpt-4o`→`glm-5.2`、`hy3`→content:"pong" ✅
- 假 key 401 → 轮换 → 重试一次 → 返回 Anthropic `{"type":"error","message":"Invalid API key."}`（临时 `ZEN_CONFIG` 验证）。
- 详见 `zen-gateway/README.md` 的验证命令。

## 7. 使用步骤（用户）

1. `cd zen-gateway && node gateway.mjs`（已配好 go-keys.json 则直接可用）。
2. `curl http://127.0.0.1:18888/healthz` 确认。
3. codex / cursor 设 `base_url=http://127.0.0.1:18888/v1`；claude code 设 `ANTHROPIC_BASE_URL=http://127.0.0.1:18888` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_API_KEY=any`（见 README）。

## 8. 部署拓扑（macOS 常驻服务）

zen-gateway 是「供应服务」，默认长期在线。macOS 用 launchd LaunchAgent 托管：

```
                 ┌─────────────── launchd (gui/uid) ───────────────┐
                 │  com.go-rotate.zen-gateway                      │
                 │  RunAtLoad=true   KeepAlive=true   Background   │
                 │  ProgramArgs: <node> <gateway.mjs>              │
                 │  WorkingDirectory: ~/.local/share/zen-gateway   │
                 │  stdout/stderr → ~/Library/Logs/zen-gateway.log │
                 └───────────────┬─────────────────────────────────┘
                                 │ spawn（崩溃自动重启）
                                 ▼
                          node gateway.mjs  (127.0.0.1:18888)
                                 │
    ┌──────────────┐  healthz/  ├── 读/写 ── ~/.config/opencode/go-keys.json
    │ claude code  │  models/   │            （与 go-rotate 共用，锁+原子写）
    │ codex/cursor │  chat ...  │
    └──────────────┘            ▼
                         opencode zen 上游
```

- **安装**：`bash install.sh zen-gateway`（拷贝 gateway.mjs → `~/.local/share/zen-gateway/`、生成 plist → `~/Library/LaunchAgents/`、管理脚本 → `~/.local/bin/zen-gateway`、`launchctl bootstrap`）。
- **管理**：`zen-gateway {start|stop|restart|status|logs|uninstall}`（见 `zen-gateway/README.md`）。
- **卸载**：`bash install.sh zen-gateway-uninstall`（bootout + 删文件，不动 go-keys.json / auth.json）。
- **命名**：label 用 `com.go-rotate.zen-gateway`（项目品牌、对任何用户可移植）。
- **Linux**：同一逻辑用 systemd `Restart=always` 实现（unit 示例见 README「服务化运行」节）。
- **已知坑**：若此前用 `nohup node gateway.mjs &` 手动跑过，旧实例占 18888 会让 LaunchAgent `EADDRINUSE` 反复重启；先 `pkill -f gateway.mjs` 再装服务。CI/Docker 等无 GUI 会话环境不适用 launchd，改用 systemd。