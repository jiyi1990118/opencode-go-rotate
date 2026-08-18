# 网关自适配优化（Phase 24）

> 2026-08-17 主线程交付。处理 Phase 21 遗留三项 + UA 版本硬编码风险，全部实装于 `zen-gateway/gateway.mjs`。

## 背景与动机

Phase 21（UA 限流修复）把上游请求 UA 硬编码为 `opencode/1.18.18`（从本机 opencode 二进制提取）。三个隐患：

1. **UA 版本硬编码**：上游升级 UA 校验规则 / 本机 opencode 版本升级后，硬编码版本可能被限流或失真。
2. **FreeUsageLimitError 误轮换**：`isQuotaError` 把 429 一律当配额耗尽 → 上游免费档限流（`FreeUsageLimitError`）会触发轮换并冷却健康 key 300 分钟（TUI 双 key 曾因此全冷却，见 Phase 21 事故）。
3. **推理模型截断无消息**：hy3-free/hy3 是推理模型，`max_tokens` 过小时 `content:null` + `finish_reason:max_tokens` → 客户端收到空内容。

## 四项自适配

### ① UA 自动探测（P1）

```js
function resolveUpstreamUA(execSyncImpl = execFileSync, env = process.env) {
  if (env.ZEN_UPSTREAM_UA) return env.ZEN_UPSTREAM_UA
  try {
    const raw = execSyncImpl("opencode", ["--version"], { timeout: 3000, encoding: "utf8" })
    const m = String(raw).match(/(\d+\.\d+\.\d+[-\w.]*)/)
    if (m) return `opencode/${m[1]}`
  } catch {}
  return UPSTREAM_UA_FALLBACK // "opencode/1.18.18"
}
```

- env `ZEN_UPSTREAM_UA` 显式覆盖优先（测试/生产均可用）。
- 探测 `opencode --version`（PATH 无此命令或解析失败 → 回退常量，不影响启动）。
- `UPSTREAM_UA` 常量改为模块加载时 `resolveUpstreamUA()` 求值。

### ② FreeUsageLimitError 不轮换（P2）

```js
function shouldRotateForError(status, body) {
  if (body && body.error && body.error.type === "FreeUsageLimitError") return false
  return isQuotaError(status, body)
}
```

- 免费档限流（429 FreeUsageLimitError）→ 透传 429，不轮换、不冷却、不写 last_status。
- 普通配额/鉴权错误（CreditsError 等）→ 保持原轮换语义。
- `sendWithRotation` 两处判定（首次 + 重试后）均改用该函数。

### ③ 推理截断自动重试（P3）

```js
function truncationRetryPlan(bodyText, bodyObj) {
  if (String(process.env.ZEN_AUTO_MAX_TOKENS) === "0") return null // 显式关闭
  let parsed; try { parsed = JSON.parse(bodyText) } catch { return null }
  const choice = parsed && parsed.choices && parsed.choices[0]
  if (!choice || choice.finish_reason !== "max_tokens") return null
  const msg = choice.message
  if (msg && typeof msg.content === "string" && msg.content.length > 0) return null // 有内容不重试
  const orig = Number(bodyObj && bodyObj.max_tokens) || 0
  const next = Math.min(Math.max(orig > 0 ? orig * 2 : 4096, 4096), 131072)
  if (next === orig) return null // 已达上限
  return next
}
```

- `retryTruncatedContent(bodyText, bodyObj, mappedModel, key, timeoutMs, clientSignal)`：按 plan 放大 `max_tokens` 同 key 重发一次；成功返回重试 body。
- 接入 `sendWithRotation` **非流式成功路径**（流式不介入——流式无法事后补全）。
- 上限 131072 单次 2 倍放大，最多重试一次。

### ④ 三协议 handler 成功路径修复（前置工程债）

- 既有缺口：`upstreamOnce` 在 `res.ok` 时 `bodyText:""`（为流式不消费 body），非流式 handler 靠 `upstream.text()` 再读。截断判定需要 body → `sendWithRotation` 非流式成功时主动 `res.text()` 读取，交给判定 + 随 `out.bodyText` 透传。
- chat/messages/responses 三处 `const text = await upstream.text()` → `const text = out.bodyText || (await upstream.text())`（messages/responses 的转换器 openAIToAnthropic / openAIToResponse 依赖 body）。
- 截断重试成功时 `sendWithRotation` 返回 `res: new Response(null, { status: 200 })`——**必须是真实 Response**（字面量 `{ok,status}` 无 `headers`，chat handler 的 `upstream.headers.get("content-type")` 抛 TypeError → 响应永不落盘 → 客户端挂起）。

## 验证

| 项 | 结果 |
|---|---|
| `node --check gateway.mjs` | ✅ |
| 网关单测 | 222 → **234 全 PASS**（+12：resolveUpstreamUA 5 / shouldRotateForError 4 / truncationRetryPlan 5） |
| mock 上游 E2E（隔离网关 19002 + mock 19001，按 max_tokens 分流） | 见下 |
| 安装副本 md5 | `e3167e96…` 一致 |
| 真实 18888 回归 | hy3 非流式 'OK' / 流式 chunk / gpt-4o-mini→deepseek-v4-flash 'OK' / /v1/models 26 / status plan=go v1.1.0 |

### mock E2E 明细（模型名会被 mapModel 映射，分流必须用请求体字段）

| 用例 | 请求 | 期望 | 实际 |
|---|---|---|---|
| T1 | max_tokens=30（截断响应） | 自动放大至 4096 重试 → 'OK' | ✅ chat/messages/responses 三协议均 'OK' |
| T2 | max_tokens=1（429 FreeUsageLimitError） | 透传 429、零轮换 | ✅ rotations=0、current 不变、无冷却 |
| T3 | max_tokens=2（429 CreditsError） | 轮换 k2 重试仍 429 透传 | ✅ rotations=1、current_gateway=k2、k1 last_status=nobalance、网关域冷却 |
| T4 | max_tokens=131072（截断响应） | 达上限不重试原样透传 | ✅ content=null finish=max_tokens |
| 全程 | - | 无 unhandledRejection | ✅ |

## 遗留（非阻塞）

- UA 探测依赖本地 PATH 有 `opencode` 命令（无则回退常量）。
- 截断重试按 2 倍放大最多一次（131072 上限）；`ZEN_AUTO_MAX_TOKENS=0` 显式关闭。
- usage.jsonl 截断重试成功记 `ok:true`（重试消耗未单独统计）。
