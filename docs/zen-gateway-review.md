# zen-gateway 深度质量审查报告

> 审查日期：2026-08-16
> 审查对象：`zen-gateway/gateway.mjs`（483 行，Node ≥18 单文件 OpenAI 兼容网关）
> 审查人：QA/审计 team（research）
> 范围：只读审查，不改生产代码。Anthropic `/v1/messages` 端点在**并行开发中**（实测运行中的实例已有该端点，但磁盘上的 483 行文件尚未包含），其实现细节纳入**后续审查**，本报告以当前磁盘代码为准。
> 方法：静态代码审查 + 本机实测（真实网关 18888 上跑通非流式/流式/模型别名；独立端口 19999 验证鉴权绕过与 body 大小）。

---

## 结论速览

| 严重度 | 数量 | 最严重问题 |
|---|---|---|
| **HIGH** | **2** | ① 请求体无大小上限（内存 DoS）；② 并发 401 时 `rotate()` 冷却"当前 key"而非"实际失败的 key"，健康 key 被误冷却 |
| **MEDIUM** | **6** | token 空串静默关鉴权、token 明文打 stdout、客户端断开上游未清理、事件循环被锁阻塞、鉴权非恒定时间、中层分片流中断无错误帧 |
| **LOW** | **8** | parseResetTime 时区偏移 regex 过窄、ZEN_MODELS 硬编码、corrupt 配置静默、无 reconcileCurrent、~~无 last_status~~（**X1 已修**，2026-08-16）等 |

正面结论：**核心轮换/锁/原子写/流式透传逻辑正确且与 go-rotate 高度一致**（实测非流式 `OK`、流式 `gpt-4o→glm-5.2` SSE 逐块透传均通过；锁跨进程互斥、原子写 tmp+rename、冷却默认 300、日志轮转 1MB/3 份完全一致）。问题集中在**并发/资源/鉴权边界**上，多数在默认 `127.0.0.1` 单机场景影响有限，但一旦 `ZEN_GATEWAY_HOST=0.0.0.0` 开放内网共享，HIGH/MEDIUM 立即放大为真实风险。

---

## 1. 安全

### S1 🔴 HIGH — 请求体无大小上限 → 内存 DoS
- **位置**：`handleChatCompletions` L386-387 `let raw = ""` + `for await (const chunk of req) raw += chunk`。
- **问题**：整个 body 无界累加进内存后再 `JSON.parse`，无 Content-Length 校验、无字节计数上限。**实测**：向 19999 端口 POST 5MB body，网关完整接收并继续处理（HTTP 100/继续），未拒绝。
- **影响**：默认 `127.0.0.1` 下仅本地进程能打；一旦 `HOST=0.0.0.0` 开放内网，任意内网主机可反复发超大 body 打爆内存（配合无鉴权=无人值守耗尽内存）。
- **修复建议**：
  1. 读 body 前列 `Content-Length`，若 > 上限（建议 10MB）直接 413；
  2. 流式累加时用计数器，超限即 `req.destroy()` + 413；
  3. 建议上限做常量 `MAX_BODY_BYTES`。

### S2 🟠 MEDIUM — `ZEN_GATEWAY_TOKEN` 为空串时静默关闭鉴权
- **位置**：`gatewayAuth` L347-349 `const token = process.env.ZEN_GATEWAY_TOKEN; if (!token) return true`。
- **问题**：`""` 是 falsy，`ZEN_GATEWAY_TOKEN=""` 会让**所有请求免鉴权放行**。常见触发：`.env` 里写成 `ZEN_GATEWAY_TOKEN=`、脚本 `export ZEN_GATEWAY_TOKEN="$TOK"` 而 `$TOK` 为空。用户以为开了鉴权，实际是裸奔。**实测**：`ZEN_GATEWAY_TOKEN=""` 下无 header 请求 `healthz` 返回 200。
- **修复建议**：只有 `token === undefined`（完全未设置）才视为不鉴权；空串应在启动时告警并拒绝启动（或视为仍有鉴权但所有请求必 401）。至少 `if (token === undefined || token === "")` 单独处理并 log 警告。

### S3 🟠 MEDIUM — 启动时把完整 token 打到 stdout
- **位置**：L475 `console.log(\`  auth: Bearer ${process.env.ZEN_GATEWAY_TOKEN}\`)`。
- **问题**：token 原文写入 stdout。若 `nohup ... >log 2>&1 &` 或 CI/systemd 捕获 stdout，token 会落盘/入日志被泄露。日志文件 `/tmp/opencode-go-rotate.log` 本身**从不**记录 token 或 key（仅记路由与 key 名，这点是好的）。
- **修复建议**：输出掩码 `token.slice(0,4) + "…"`，完整值绝不打印。

### S4 🟡 LOW-MED — 鉴权比较非恒定时间 + 无失败限速
- **位置**：L351 `return h === \`Bearer ${token}\``。
- **问题**：JS 字符串 `===` 非恒定时间，理论上存在时序侧信道；且对鉴权失败无任何限速/延迟。默认 `127.0.0.1` 下时序 oracle 无实际意义，但 `0.0.0.0` 开放后是远程爆破面。
- **修复建议**（可选，本地单机可忽略）：失败时 `crypto.timingSafeEqual`；若 `HOST !== "127.0.0.1"` 且未设 token，拒绝启动（见 S7）。

### S5 ✅ 无关键泄露（确认良好）
- 请求日志仅记 `req.method + req.url`（L447）与 key 名（L217/227），从不记 `Authorization` 值或 key 全文。`/healthz` 只返回 key 数量与 current 名，不返回 key 值。
- **路径穿越**：`new URL(req.url, ...)` 后仅对 `pathname` 做固定路由匹配（L428-458），无文件服务、无文件路径拼接。**安全**。

### S6 🟠 MEDIUM — 无鉴权 + `0.0.0.0` = 开放代理烧配额
- **位置**：L464 `const HOST = process.env.ZEN_GATEWAY_HOST || DEFAULT_HOST`，配合 S1/S2。
- **问题**：架构文档 README 已说明"内网共享需 `0.0.0.0` + token"，但代码无强制：`HOST=0.0.0.0` 且未设 token 时，网关就是一台**用你 opencode key 的免费开放代理**，内网任何人可消耗你的配额/免费档。
- **修复建议**：启动时若 `HOST !== "127.0.0.1"` 且 `!token`，打印醒目警告并在 `ZEN_GATEWAY_INSECURE` 未显式置位时拒绝启动。

---

## 2. 并发

### C1 🔴 HIGH — 并发 401 时冷却"当前 key"而非"实际失败的 key" → 健康 key 被误冷却
- **位置**：`rotate()` L210-230 内 `const cur = currentKey(cfg)`；调用方 `sendWithRotation` L314 只读了一次 `key`。
- **问题**：锁（`withLockSync`）保证**写入互斥**（这点正确，不会损坏文件），但轮换语义是"把当前 current 冷却"。两个并发请求都先读到 `key=A`，上游都 401：
  - 请求1 进锁：`currentKey=A` → 冷却 A → `pickNext` 选 B → current=B → 重试成功。
  - 请求2 此时持有的还是 `key=A`，再进锁：**重新 loadConfig 得到 current=B** → 冷却 B → 切 C → 用 C 重试。
  - 结果：健康的 B 被误冷却，且一次配额耗尽事件触发两次轮换。
- **影响**：多请求并发命中同一耗尽 key 时，会连锁冷却掉多个健康 key，加速"全部冷却"。
- **修复建议**：
  1. `rotate()` 显式接收失败的 key 名，只冷却/切换那个 key，而不是 `currentKey(cfg)`；
  2. 进锁后重读配置，若 `current` 已不是失败 key（说明已被别的线程轮换过），直接返回不再重复冷却；
  3. 可选：进程内加"正在轮换"标志，避免同一轮配额事件的重复 rotate。

### C2 🟠 MEDIUM — `Atomics.wait` 阻塞整个事件循环
- **位置**：`withLockSync` L112 `Atomics.wait(new Int32Array(...), 0, 0, 50)`。
- **问题**：`Atomics.wait` 在 Node 主线程是**同步阻塞**的。轮换时若锁被其它进程持有（最多等 5s），网关主线程被卡死，**所有并发在途的 SSE 流和其他请求全部冻结**。单机单用户无感；多 agent 并发长时间流式时，一次锁竞争就卡住所有流。
- **修复建议**：改用异步锁（poll + `setTimeout`/`setImmediate` 让出事件循环），或短自旋后让 `withLockSync` 返回 Promise。对当前单机规模可作 MEDIUM 记录，暂缓。

### C3 🟡 LOW-MED — 并发上游/SSE 连接无上限
- **位置**：`handleChatCompletions` L395 → `sendWithRotation` 每次新建一个上游 `fetch`；`pipeStream` L364 每个连接持有一个上游 reader，最长 300s。
- **问题**：无并发上限。默认本地 → LOW；`0.0.0.0` 开放后是连接耗尽型 DoS。
- **修复建议**：加简单并发信号量（如 `MAX_CONCURRENT=8`），超限返回 429。

---

## 3. 错误处理

### E1 🟠 MEDIUM — 客户端断开后上游 reader 未取消 → 资源泄漏
- **位置**：`pipeStream` L372-383。
- **问题**：客户端断开时 `res.write` 抛错 → `catch` → `res.destroy()`。但上游 `reader.read()` 循环**没有**被取消，上游会继续把数据拉到内存直到流结束或 300s 超时。**实测**：SSE 透传正常，但无 close 处理器。
- **修复建议**：`res.on("close", () => { try { reader.cancel().catch(()=>{}) } catch {} })`，并在 catch 里对上游做 abort。

### E2 🟡 LOW-MED — 流式中段上游错误 → 直接截断，无错误帧
- **位置**：`pipeStream` L380-382。
- **问题**：响应头已 2xx、流中段上游断开时，网关 `res.destroy()`，客户端只看到截断的 SSE，无 `data: {"error":...}` 或 `finish_reason` 收尾。架构文档已注明"流中段报错无法重试"，属已知限制，但应尽量发一个 SSE 错误帧让客户端识别而非静默截断。
- **修复建议**：catch 里尝试 `res.write('event: error\ndata: {"error":"upstream stream interrupted"}\n\n')` 后再 destroy。

### E3 ✅ JSON 解析失败 / 上游错误 JSON 处理正确
- `handleChatCompletions` L389-392：body 非 JSON → 400。good。
- `sendWithRotation` L315-317：无 key / 空 key 数组 → 500 `no key configured`。good。
- `parseErrorBody` L298-304：`JSON.parse` 失败回退为 `{error:{message:text}}`。good。

### E4 🟡 LOW — go-keys.json 损坏时静默回退，无日志
- **位置**：`loadConfig` L134-150 catch 分支 silent。
- **问题**：go-rotate.ts 的 `loadConfig` 在 catch 里 `log("loadConfig error: ...")`（go-rotate.ts L153），网关静默。坏了不好排查。
- **修复建议**：catch 里加一行 `log`。

---

## 4. 轮换逻辑

### R1 🟡 LOW — `parseResetTime` 时区偏移 regex 过窄
- **位置**：L179 `(?:\s*[+-]\d{4})?`。
- **问题**：只认 `+0800` 四位数偏移，不认 `+8:00`（冒号）或 `Z`。若上游 `reset at` 用冒号偏移，`Date.parse` 会 NaN → 走无偏移分支按本地时区解释 → 冷却时间算错。与 go-rotate.ts L202 完全一致（一致性 OK，但边界一样差）。
- **修复建议**：放宽为 `[+-]\d{2}:?\d{2}|Z`。

### R2 ✅ `pickNext` 有界，无死循环
- **位置**：L198-207 `for i=1..keys.length` 模取，全冷却返回 `undefined`；`rotate` L220-222 维持当前 key。空 keys 时循环不执行，安全。**正确**。

### R3 ✅ 重试逻辑正确（仅重试一次、复用同一 body）
- **位置**：L313-343。`bodyStr` 在 L320 构造一次，重试 `upstreamOnce(newKey.key, bodyStr, ...)` 原样复用（相同 model、相同 stream 标志）。仅在 `newKey.name !== key.name` 时重试（L333），否则返回原错误。**非无限重试**。**正确**。

---

## 5. 流式

- **✅ 真逐块透传**：`pipeStream` L374-378 每 `reader.read()` 一块即 `res.write(value)`，不整体缓冲。**已实测**：流式返回逐块 SSE，别名 `gpt-4o` 正确映射到 `glm-5.2`。
- **资源清理缺陷**：见 E1（客户端断开未 cancel 上游）。

---

## 6. 模型映射

### M1 🟡 LOW — hy3 推理模型 `content:null` 只是透传，未兜底
- **位置**：`mapModel`/`sendWithRotation`。
- **问题**：`hy3` 是推理模型，`max_tokens` 不足时上游返回 `content:null` + `reasoning`。网关原样透传，不做任何 max_tokens 抬升或告警。客户端（如 cursor 把默认模型设成 hy3）会看到空 content。属**客户端侧坑**，非网关 bug，但可在网关加保护。
- **修复建议**：定义 `ZEN_MIN_MAX_TOKENS`（如 512），body 里 `max_tokens` 若小于该值且 mapModel 结果是推理模型则自动抬升；或在透传时对 `content:null && reasoning` 追加一条日志。至少文档醒目提示。

### M2 ✅ 别名表与 ZEN_MODELS 一致
- `MODEL_ALIAASES`（原名 typo，双 A，L247）所有 value（`glm-5.2`/`deepseek-v4-flash`/`deepseek-v4-pro`/`grok-4.5`/`qwen3.7-max`/`DEFAULT_MODEL`）均存在于 `ZEN_MODELS`。`mapModel` 先查真实模型再查别名，未知回落 `DEFAULT_MODEL`。**正确**。

### M3 🟡 LOW — `ZEN_MODELS` 26 个硬编码，上游新增模型会过期
- **位置**：L235-242。
- **问题**：上游 `/v1/models` 会变（免费名单/新模型），硬编码列表过期后新模型名被误映射到默认模型。架构文档已注明"以 /v1/models 为准"，但对网关自身是静态表。
- **修复建议**：启动时可选拉一次上游 `/v1/models` 合并到 `ZEN_MODELS`（缓存），失败回退硬编码表。

---

## 7. 兼容性

### T1 ✅ Node 18/20/22
- `AbortSignal.timeout`（≥17.3）、全局 `fetch` + `ReadableStream.getReader()`（≥18）、`IncomingMessage` 异步迭代（≥12）、`SharedArrayBuffer`+`Atomics.wait`（Node 主线程允许，异于浏览器）。**本机 v24.14.1 与 Node18 语义一致**。

### T2 🟡 LOW — bun 兼容未实测
- 用 `node:http/node:fs/node:os` + 全局 `fetch`，bun 均支持，理论上可跑；文档称"bun 可选"，未实测。不做承诺即可。

---

### 📌 第三轮复测结论（2026-08-16）：bun 瞬时 AbortError 观察项 → 实为「上游超时进程崩溃」真实 bug，已关闭观察项、升级为 HIGH
- **原观察项**：bun 1.3.14 下首次启动后立刻发请求偶发一次 AbortError（未复现）。
- **复测方法**：临时端口 18897 + 假 key + 真实上游，`bun gateway.mjs`。启动后立刻连发 5 次 → 其中 2-3 次触发。**据实复现**。
- **根因（已定位，非 bun 特有）**：`handleChatCompletions` / `handleResponsesBody` / `handleMessages` 均 `await sendWithRotation(...)` **无 try/catch**；`upstreamOnce` 用 `AbortSignal.timeout(15000)`（非流式）。当上游卡住 ≥15s，fetch 抛 AbortError → unhandled rejection → **进程崩溃**（进程退出，客户端 HTTP:000）。
- **跨运行时验证**：用「挂起 mock 上游（永不响应）」在 **Node v24.14.1 与 bun 1.3.14 下均复现**——15s 超时后客户端 HTTP:000、进程 DEAD、日志 `AbortError: This operation was aborted`。**非 bun 特有，是网关通用缺陷**。
- **影响**：上游 API 卡顿/超时即可让整个网关进程退出（launchd KeepAlive 会重启，但所有在途请求全部中断）。与 zapier/超时相关的真实场景风险 HIGH。
- **修复建议（主线程）**：① 三个 handler 对 `sendWithRotation` 的 await 包 try/catch，AbortError 时返回 `sendJson(res, 504, ...)` 而非让 Promise 外泄；② 顶层加 `process.on("unhandledRejection", ...)` / `process.on("uncaughtException", ...)` 兜底 log 不退出（或至少不崩溃）。**不改生产代码（本 team 仅验证）。**

## 8. 与 go-rotate.ts 一致性对照

| 项 | go-rotate.ts | gateway.mjs | 一致? |
|---|---|---|---|
| 锁文件路径 | `CONFIG_FILE+".lock"` | 同 | ✅ |
| 锁协议（wx+陈旧15s+超时5s+Atomics 50ms） | 同 | 同 | ✅ |
| 原子写（tmp+rename） | 同 | 同 | ✅ |
| 日志文件 | `/tmp/opencode-go-rotate.log` | 同 | ✅ |
| 日志轮转（1MB/3份） | 同 | 同 | ✅ 逻辑逐行相同 |
| 冷却默认 300min | 同 | 同 | ✅ |
| `parseResetTime` | 同 | 同 | ✅（含相同边界缺陷 R1） |
| `pickNext` | 同 | 同 | ✅ |
| `isQuotaError` | `quotaStatus\|quotaWords` | 同 | ✅ |
| 日志前缀 | `[ISO] msg` | `[ISO] [gateway] msg` | 有意区分 ✅ |

### 差异点（LOW，不影响功能）
- **X1**：~~gateway 的 `rotate` 不写 `last_status`（go-rotate 用 `classifyGoError` 写）。gateway 轮换过的 key 在 go-rotate Web 上看不到健康状态。建议补写。~~ **已修（本轮，2026-08-16）**：`rotate()` 冷却失败 key 时按 go-rotate 契约写 `last_status`（枚举 `invalid`/`nobalance`/`limited`/`error`，新增 `classifyGoError(msg, statusCode)` 与插件逐条一致）；新当前 key 清空 `last_status`（=null，同插件）；**no-next 分支补 `saveConfig`**（原实现该分支不落盘，cooldown_until+last_status 只存内存，Web 看不到——对齐插件 mutateConfig 恒保存行为）。验证：单元测试 +8 断言（128/128 PASS）；临时沙箱集成实测 9/9 PASS（401→轮换→act1.last_status=invalid 落盘、act2 切换清空、no-next 分支持久化、chat/healthz 回归、真实 auth.json/go-keys.json 零污染）。
- **X2**：gateway 无 `reconcileCurrent`。若 `current` 指向已删除的 name，gateway 请求用 `keys[0]`（L170）但**不回写** `current`；go-rotate 会自愈。建议补。
- **X3**：gateway 忽略 `provider_id`，固定转发到 `GO_API`。go-rotate 用 `provider_id` 匹配 `opencode*`。gateway 是 go 专用，可接受，但若配置里 provider_id 非 go 仍会转发，需文档说明。

---

## 修复优先级建议（给主线程）

- **P0（HIGH，建议立即）**：S1 请求体上限；C1 rotate 冷却目标 key。
- **P1（MEDIUM，下个迭代）**：S2 空 token 防护；S3 掩码 token；S6 拒绝无鉴权 0.0.0.0；E1 客户端断开 cancel 上游；C2 锁改异步。
- **P2（LOW/优化）**：E2 流错误帧；E4 corrupt 配置日志；R1 时区 regex 放宽；M1 推理模型 max_tokens 兜底；M3 动态模型表；~~X1~~（**已修 2026-08-16**）；X2 对齐 go-rotate。

---

## 附：实测记录（本次）
- 非流式 `hy3` → `content='OK'` ✅
- 流式 `gpt-4o`（别名→glm-5.2）→ SSE 逐块透传 ✅
- `/v1/models` → 26 模型 ✅
- 鉴权：正确 token 200 / 无 token 401 / 错 token 401 / `BearerX` 401（严格）；**空 token 环境变量 → 免鉴权 200**（S2 实证）
- 5MB body → 网关完整接收（S1 实证）
- claude code 直连网关 `/v1/messages`：实测挂起无请求到达（Anthropic 端点在并行开发中，未纳入本次审查）

---

## 📌 已修复（2026-08-16 主线程 + 并行 team）

| 项 | 状态 | 修复方式 |
|---|---|---|
| S1 请求体无上限（HIGH） | ✅ | `readBody` + `MAX_BODY_BYTES=8MB`，超限 413（实测 9MB→413） |
| C1 并发 401 误冷却（HIGH） | ✅ | `rotate(errBody,status,failedKeyName)` 冷却实际失败 key |
| S2 空 token 静默关鉴权 | ✅ | 空串视为未设置（语义明确） |
| S3 token 明文打 stdout | ✅ | `maskToken` 掩码输出 |
| S6 无鉴权 0.0.0.0 开放代理 | ✅ | 非 loopback + 无 token → 拒绝启动退出码 1；`ZEN_ALLOW_OPEN_NOSEC=1` 显式绕过（实测：0.0.0.0 无 token 退出 ✅，有 token 启动 ✅） |
| C2 文件锁阻塞事件循环 | ✅ | 新增 `withLockAsync`（sleep 100ms 轮询让出事件循环），运行路径全走异步锁 |
| E1 客户端断开上游未清理 | ✅ | `AbortController` + `res.on("close")` → abort 上游 fetch；`combineSignals` 桥接超时+客户端双信号 |
| E2 流中段错误无错误帧 | ✅ | OpenAI `data:{error}` 帧 / Anthropic `event: error` / Responses `response.failed`（客户端已断开则销毁跳过） |
| R1 parseResetTime 时区 regex 过窄 | ✅ | 放宽 `+0800`/`+08:00`/`Z`/无偏移，仍解析为 UTC |
| E4 corrupt 配置静默 | ✅ | `loadConfig` catch 时 `log()` 警告 |
| M1 推理模型 content:null 兜底 | ✅ | 非流式路径 reasoning 填入 content 兜底 |

**新增（本轮）**：`POST /v1/responses`（新版 codex / cursor GPT-5 系）——`/v1/chat/completions` 收到含 `input` 无 `messages` 的 body 自动走 Responses 转换。实测：非流式 ✅、流式 9 事件序列 ✅、cursor 检测分支 ✅。

### 追加修复（2026-08-16 第二轮）

| 项 | 状态 | 修复方式 |
|---|---|---|
| M3 模型表硬编码 | ✅ | 启动异步拉取上游 `/v1/models` 并入动态表（3s 超时失败降级内置 26 个）；`POST /v1/models/refresh` 手动刷新；判定优先级 动态→内置→别名→默认 |
| X2 无 reconcileCurrent | ✅ | `loadConfig` 内存自愈（current 不在 keys → 警告+修正为 keys[0]），写路径持久化 |
| **新增** 使用量统计 | ✅ | `GET /api/usage`（totalRequests/rotations/uptimeSec/perKey{success,rotated,cooldown_until}）+ healthz 附 rotations |
| **新增** CLI 文件锁 | ✅ | `go-rotate` 写命令走 `_with_lock`（O_EXCL+15s 陈旧锁+5s 超时降级），`save()` 原子写（.tmp+rename） |
| **新增** `go-rotate stats` | ✅ | 从 `/tmp/opencode-go-rotate.log` 统计每 key 轮换/冷却次数与最近切换 |
| **发现并修** 非流式错误路径崩溃 | ✅ | `/v1/chat/completions` 重试仍失败时 body 已被消费 → `.text()` 抛 "Body already read"；补 `!upstream.ok` 分支直接返回错误（messages/responses 已有同样守卫） |

**实测记录（第二轮）**：M3（启动拉取 26 个 + /v1/models 合并 + refresh）✅；X2（current="ghost" → 自愈 act1 + 警告日志）✅；/api/usage（假 key 触发轮换后 rotated=1、healthz rotations=1）✅；CLI 并发 60 个写命令并行 JSON 无损无锁残留 ✅；claude code 直连矩阵（OK/4/工具多轮 391）✅；bun 1.3.14 启动+3 连发 OK ✅（首次瞬时 AbortError 未复现，标注观察项）。
### 追加增强（2026-08-16 第三轮：用量趋势 / 系统通知 / 主动探测）

| 项 | 状态 | 实现方式 |
|---|---|---|
| **新增** 用量趋势持久化 | ✅ | `usage.jsonl` 追加日志（默认 `~/.local/share/zen-gateway/usage.jsonl`，`ZEN_USAGE_FILE` 覆盖）；每次 `sendWithRotation` 完成后追加一行 `{ts,key,ok,model,rotated,endpoint}`；行数上限 5000 截断保留后 1000；与 `/api/usage` 内存计数互补（持久趋势 vs 实时状态） |
| **新增** 轮换系统通知（macOS） | ✅ | `rotate()` 成功切换后 `execFile("osascript", display notification)`，文案含新 key 名不含 key 值；非 darwin 或 `ZEN_NOTIFY=0` 跳过；失败静默只 log |
| **新增** 配额主动探测 | ✅ | `ZEN_PROBE_INTERVAL_MIN`（分钟）`>0` 启用 `setInterval`，对当前 key 发最小探测（`hy3`+`max_tokens:1`+15s 超时）；配额错误→`rotate()`（冷却失败 key+轮换+通知），成功/其它→仅 log；默认关闭 |

**实测记录（第三轮）**：`node --check` ✅；mock 上游下 chat/messages/responses 各写 `usage.jsonl` 合法 JSON 行（含 `ok:true`、正确 `endpoint` 标签）；真实上游假 key 401 → 轮换 act1→act2 → `usage.jsonl` `rotated:true` + 日志 `🔔 发送系统通知` ✅（`ZEN_NOTIFY=0` 时无通知日志，可控关）；`ZEN_PROBE_INTERVAL_MIN=0.1`（6s）假 key 探测每 6s 触发、401→轮换、无可用 key 优雅降级 ✅；mock 下探测 200 → `正常` 不轮换 ✅；`usage.jsonl` 5099 行种子 +1 → 截断 1000 保留末行 ✅；回归 chat/messages/responses/models/usage/healthz 全部正常 ✅。**修复过程中发现并修正 1 处标签错位**：`handleResponsesBody` 与 `handleChatCompletions` 的 `endpoint` 参数传反（chat 报了 responses），已对调。
