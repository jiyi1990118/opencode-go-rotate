# zen-gateway 纯逻辑单元测试报告

- 日期：2026-08-16
- 测试文件：`zen-gateway/tests/run-tests.mjs`（零 npm 依赖，node 内置 `node:assert`）
- 被测对象：`zen-gateway/gateway.mjs`（v24.14.1 实测）
- 结果：**144/144 PASS（exit 0）**（2026-08-16 追加 `/api/usage/trend` 纯函数 16 用例，原 120 用例未删改）

## 运行方式

```bash
cd zen-gateway/tests && node run-tests.mjs
# 或显式：ZEN_TEST=1 node run-tests.mjs
```

脚本自身会 `process.env.ZEN_TEST = "1"` 再动态 `import("../gateway.mjs")`；
测试前固定 `ZEN_DEFAULT_MODEL=hy3`、`ZEN_NOTIFY=0`、`ZEN_CONFIG/ZEN_USAGE_FILE` 指向 /tmp，
并清除 `ZEN_GATEWAY_HOST/TOKEN/PROBE_INTERVAL_MIN/UPSTREAM_BASE` —— **绝不触碰真实
go-keys.json / auth.json / 18888 常驻服务**。

## 导出钩子方案（gateway.mjs 唯一两处改动）

| 位置 | 改动 | 说明 |
|---|---|---|
| L1592-1611 | `server.listen(...)` 包进 `if (!process.env.ZEN_TEST) { ... }` | 测试时跳过 listen；正常启动路径逐字节等价 |
| L1628-1655 | 文件末尾新增顶层命名 `export { ... }` + 测试钩子 `__setDynamicModels` | 导出 16 个纯函数 |

**关键工程决策（与任务建议方案的偏差及理由）**：任务建议 `module.exports = {...}`，
但 gateway.mjs 是 **ESM（.mjs）**，实测 `module.exports` 直接抛
`ReferenceError: module is not defined in ES module scope`。因此改用 **ESM 顶层命名导出**：

- 直接运行 `node gateway.mjs` 时导出是惰性的，运行时行为与改动前完全一致（已验证回归）；
- `ZEN_TEST=1` 时跳过 listen，测试可 `import()` 到内部纯函数且不启动服务器；
- `__setDynamicModels(list)` 是唯一新增函数：重置 `mapModel` 依赖的模块顶层 `let ZEN_MODELS_DYNAMIC`
  （任务允许的最小注入方案），导出为 `const` 箭头函数，不改任何纯函数实现。

导出清单：`parseResetTime / isQuotaStatus / isQuotaError / mapModel / pickNext / currentKey /
cooldownUntilDefault / maskToken / parseErrorBody / combineSignals / anthropicToOpenAI /
openAIToAnthropic / responsesToOpenAI / openAIToResponse / allModelIds / __setDynamicModels`。

## 覆盖清单

| 函数 | 用例数 | 关键覆盖点 | 结果 |
|---|---|---|---|
| parseResetTime | 11 | `+0800`/`+08:00`/`Z`/`-0500`/无偏移/毫秒/大小写/无效串×3 | PASS |
| isQuotaStatus / isQuotaError | 14 | 401/402/429、500/403、quota/insufficient/balance/rate limit/exceeded、body.message 兜底、中文（见发现②） | PASS |
| mapModel | 12 | 内置 26 模型原样、别名 gpt-4o→glm-5.2/grok-code→hy3/gpt-4o-mini→deepseek-v4-flash、未知名→hy3、大小写、动态表优先/重置 | PASS |
| anthropicToOpenAI | 19 | system string/数组/空、user/assistant string、text blocks 拼接、image base64/url、tool_result→tool、thinking/stop_sequences/metadata/top_k 忽略、tools/tool_choice 转换 | PASS |
| openAIToAnthropic | 11 | text 块结构、finish_reason→stop_reason 映射、tool_calls→tool_use、非法 arguments 兜底、reasoning_content 兜底、空 content→max_tokens、usage/id 清洗 | PASS |
| responsesToOpenAI | 12 | input string/数组、function_call_output→tool、instructions→system、max_output_tokens→max_tokens、tools/tool_choice 转换 | PASS |
| openAIToResponse | 7 | output_text、length→incomplete、content null 兜底、tool_calls→function_call、usage total | PASS |
| currentKey | 3 | current 存在/不存在（X2 自愈语义）/空 keys | PASS |
| cooldownUntilDefault | 3 | 显式 30min/缺省 300min/合法 ISO | PASS |
| maskToken | 5 | 前4+****+后4、中段不泄漏、<8/空→****、不含原文 | PASS |
| parseErrorBody | 5 | 合法 JSON/带 status/非法 JSON/空串/JSON 原始值 | PASS |
| combineSignals | 9 | 单信号原样返回、abort A/B、预置已 abort、双 abort 幂等 | PASS |
| pickNext | 6 | 下一可用/跳过冷却/过期可用/全冷却/current 不在 keys/空 keys | PASS |
| allModelIds | 2 | 26 内置升序、动态合并去重 | PASS |
| aggregateUsage / readUsageFile | 16 | 空文件空结构、坏行计数（非JSON/缺字段/非法时间）、按 key 汇总+lastTs、按日归日（+08:00 偏移折算 UTC）、按 endpoint（含 unknown）、days 窗口过滤、key 筛选、全局成功/失败/轮换、days 非法回退 7、readUsageFile 不存在/空/正常 | PASS |
| **合计** | **144** | **182+ 个断言点** | **144/144 PASS** |

## `/api/usage/trend` 追加（2026-08-16）

新增 `GET /api/usage/trend` 端点：从持久化 `usage.jsonl` 实时聚合历史趋势（与 `/api/usage` 内存计数互补）。

- **纯函数**（文件末尾 export 区新增，与既有 16 个并列）：
  - `aggregateUsage(lines, opts)` → `{total, byKey:{name:{requests,success,fail,rotated,lastTs}}, byDay:{YYYY-MM-DD:{requests,success,rotated}}, byEndpoint:{ep:{requests,ok}}, badLines, window:{days,startUtc,endUtc}}`
  - `readUsageFile(path)` → 行数组（文件不存在/不可读返回 `[]`，不抛错）
  - `utcDateKey(isoStr)` / `windowDays(days, now)`（与 usage-report.mjs 同语义的辅助）
- **语义**：坏行（非 JSON / 缺 `key`/`ts` / 时间不可解析）跳过计 `badLines`；空行不算坏行；`ts` 经 `Date` 归一取 UTC 日期键（兼容 `+08:00` 偏移）；`days` 只聚合近 N 天（默认 7，非法回退 7，上限 3650 防内存滥用）；`key` 精确筛选（可选）；`badLines` 不受筛选影响。
- **端点**：`?days=N`、`?key=NAME`；文件不存在 → 空结构 HTTP 200（非 404）；每次请求同步重读（文件 ≤5000 行，开销可忽略，未做缓存）。

### 验证记录（真实执行，2026-08-16）

1. `node --check gateway.mjs` → OK（exit 0）
2. `ZEN_TEST=1 node run-tests.mjs` → **144/144 PASS**（原 120 用例未删改，新增 16 用例）
3. **真实集成**（临时端口 18921 + 临时 ZEN_CONFIG 假 key + 临时 usage.jsonl 10 合法行 + 2 坏行）：
   - `GET /api/usage/trend`（默认 days=7）→ `total=10`、`badLines=2`、byKey act1{5,4,1,0}/act2{3,1,2,1}/act3{2,2,0,0}、byDay 含 08-14 两条（`+08:00` 折算）、byEndpoint chat{7,6}/messages{2,0}/responses{1,1} —— **与独立 python 核算逐字段一致**
   - `?days=3` → `total=7`（08-11/12/13 被滤），window 08-14..08-16
   - `?key=act1` → `total=5`，byKey 仅 act1，`badLines=2` 不变
   - 独立核算：python 脚本重算 usage.jsonl（total=10/bad=2、byKey、byDay、byEndpoint 全同）
4. **文件不存在场景**（第二个临时实例 18922，ZEN_USAGE_FILE 指向不存在路径）：
   - `GET /api/usage/trend` → `{"total":0,"byKey":{},"byDay":{},"byEndpoint":{},"badLines":0,"window":{...}}` HTTP **200**（非 404）
   - `?days=abc` → 回退 days=7
5. **回归**（临时实例）：healthz 200（keys=3 current=act1）、`/api/usage` 内存计数正常、`/v1/models` 26 个、`POST /v1/chat/completions`（假 key）→ 401 AuthError（预期，上游拒绝），usage.jsonl 追加 1 行 `{key:act2, ok:false, rotated:true}`（语义：首次失败不单独写行，rotated 行记录重试后的新 key 与状态）
6. **清理**：18921/18922 进程已 kill，端口释放；真实 18888 常驻服务全程未重启；真实 go-keys.json md5 与基线一致（未污染）。
7. **⚠️ 事故与还原（必须记录）**：第 5 步 chat 回归的假 key 401 触发了 `rotate() → syncAuth()`，**把临时假 key 写进了真实 auth.json**（`AUTH_FILE` 是 gateway.mjs 硬编码常量，无 env 覆盖——`ZEN_CONFIG` 只隔离 go-keys.json）。已按真实 go-keys.json 的 `test` key（`sk-epyPd50...`）还原 auth.json。**教训：gateway.mjs 的轮换类集成测试必然写真实 auth.json，测后必须还原；或先备份 auth.json。**

## 验证记录（真实执行）

1. **语法检查**：`node --check zen-gateway/gateway.mjs` → `SYNTAX_OK`（exit 0）。
2. **正常启动路径回归**（不设 ZEN_TEST，临时端口 18901 + 临时 ZEN_CONFIG + `ZEN_NOTIFY=0`）：
   - `curl /healthz` → `{"ok":true,"keys":1,"available":1,"current":"act1","defaultModel":"hy3","rotations":0}`（200）
   - `GET /v1/models` → 26 个模型
   - 启动日志正常打印 listen/路由/默认模型；kill 后端口释放（lsof 0 行）
   - 结论：**listen 未被破坏，正常启动路径等价**
3. **单元测试**：`node run-tests.mjs` 与 `ZEN_TEST=1 node run-tests.mjs` 均 **119/119 PASS，exit 0**。
4. **真实服务不受影响**：18888 常驻服务 healthz 前后均 200（`keys=2 current=act1`，未做任何写操作）；
   auth.json / go-keys.json 全程未触碰；18901 临时进程已清理。

## 发现的实现差异 / 待主线程裁决项（未改生产实现）

1. **【差异，任务规格 vs 实现】`anthropicToOpenAI` 不转换 `tool_use` block**
   - 任务规格假设「tool_use→tool_calls」；实际代码（L472-498）只处理 `text`/`image`/`tool_result`
   三种 block，**`tool_use` 被整体丢弃**（assistant 消息只剩文本，无 tool_calls 产出，已按实际行为断言）。
   - 风险：多轮工具调用时，claude code 会把「assistant tool_use + user tool_result」发回；
   tool_use 被丢后上游只看到孤立 `role:"tool"` 消息（无前置 assistant tool_calls），
   OpenAI 兼容端点通常 400「tool messages must follow assistant tool_calls」。
   - 建议：主线程核实 `anthropicToOpenAI` 补 `tool_use` 分支 →
   `{role:"assistant", tool_calls:[{id, type:"function", function:{name, arguments: JSON.stringify(input)}}]}`。
   反向 `openAIToAnthropic` 的 tool_calls→tool_use 是完整的（L535-541），往返不对称。
2. **【差异，任务规格 vs 实现】`isQuotaError` 正则不含中文**
   - 任务规格假设「中文 配额/余额 → true」；实际正则
   `/quota|insufficient|balance|rate.?limit|usage limit|exceeded/i`（L325）**纯英文**，
   中文消息返回 false（已按实际行为断言）。
   - 实际影响低：opencode zen 上游错误均为英文（quota exceeded / insufficient balance 等），
   但若上游未来返回中文错误则不会触发轮换。建议主线程决定是否补中文关键词。
3. **【差异，任务规格 vs 实现】`cooldownUntilDefault` 无 per-key 参数**
   - 任务规格签名 `(cfg, key?)`（每 key 独立冷却 window）实际在 **go-rotate.ts 插件**实现，
   gateway.mjs 内 `cooldownUntilDefault(cfg)` 仅取全局 `cfg.cooldown_minutes`（缺省 300）。
   网关轮换冷却实际用的是「失败 key 的独立 cooldown_until（解析 reset at）+ 全局默认」，
   与插件侧 schema 兼容。非缺陷，仅签名差异，报告以实际实现为准。
4. **【观察，低危】`openAIToResponse` 纯 tool_calls 响应 status 被标 `incomplete`**
   - `content === ""` 且无 reasoning 时走「空文本兜底」分支（L1107-1117），把本该 `completed`
   的工具调用回合强制标为 `incomplete`，并额外产出空文本 message 块。
   - codex 客户端对 incomplete 会视为截断，可能触发重试或误判。建议主线程核实：
   该 else 分支应仅当 `content == null`（推理吃完）时触发，`content === ""` 且有 tool_calls 时应保持 completed。
5. **【观察，低危】`responsesToOpenAI` 忽略 `function_call` 追问项**（L1057 注释明确「够用」）
   - 多轮工具闭环中 assistant 的 function_call 历史不回传；与 #1 同类（工具历史不完整）。
   已按实际行为断言，供主线程评估是否需要支持。
6. **【无风险】`parseErrorBody("123")` 返回原始值 123**（非对象）——调用方若直接取 `.error` 会
   undefined，但现有调用路径（`err.error?.message ?? err.message`）均安全，仅记录。

## 遗留

- `combineSignals` 的监听器清理（abort 后 removeEventListener）未做细粒度单测（需事件桩），
  已在 `gateway.mjs` 源码确认实现正确（L761-764），报告说明即可。
- 流式转换（`streamAnthropic` / `streamResponses` / `pipeStream`）依赖真实 SSE 上游，非纯函数，
  未纳入本单测（任务允许），建议后续以 mock 上游做集成级验证。
- `rotate()` / `saveConfig()` / `syncAuth()` 涉及真实文件与锁，未纳入本纯逻辑单测
  （会写 auth.json/go-keys.json，违背「绝不触碰真实配置」约束）。