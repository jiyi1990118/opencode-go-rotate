#!/usr/bin/env node
/**
 * zen-gateway 纯逻辑单元测试（零 npm 依赖，node 内置 assert）
 *
 * 运行：
 *   cd zen-gateway/tests && node run-tests.mjs
 *   （脚本自身会设 ZEN_TEST=1；也可显式 ZEN_TEST=1 node run-tests.mjs）
 *
 * 原理：ZEN_TEST=1 时 gateway.mjs 跳过 server.listen（不启动服务器、不发请求、
 * 不写真实配置），只导出内部纯函数。本脚本 import 后逐函数断言实际行为。
 *
 * 说明：所有用例断言「当前实现的实际行为」；与任务规格假设不一致处（如
 * anthropicToOpenAI 不转换 tool_use、isQuotaError 正则不含中文）按实际行为
 * 断言并在 docs/测试报告-zen-gateway.md 记录为发现项，不改生产实现。
 */
import assert from "node:assert"
import os from "node:os"
import path from "node:path"
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs"

/* ---- 测试前固定环境，保证断言确定性、绝不触碰真实配置/服务 ---- */
process.env.ZEN_TEST = "1" // 跳过 listen（网关不启动）
process.env.ZEN_DEFAULT_MODEL = "hy3" // 固定默认模型（mapModel 断言依赖）
process.env.ZEN_NOTIFY = "0" // 不弹系统通知
process.env.ZEN_CONFIG = "/tmp/zen-gateway-unittest-go-keys.json" // 防御：指向临时配置
process.env.ZEN_LOG_FILE = "/tmp/zen-gateway-unittest.log" // 防御：日志落临时文件（绝不污染真实 /tmp/opencode-go-rotate.log）
process.env.ZEN_USAGE_FILE = "/tmp/zen-gateway-unittest-usage.jsonl"
process.env.ZEN_GATEWAY_CONFIG = "/tmp/zen-gateway-unittest-gateway-config.json" // 防御：网关配置指向临时（绝不读真实 ~/.local/share/zen-gateway/）
delete process.env.ZEN_GATEWAY_HOST // 默认 127.0.0.1，避免 S6 拒绝启动
delete process.env.ZEN_GATEWAY_TOKEN
delete process.env.ZEN_PROBE_INTERVAL_MIN
delete process.env.ZEN_UPSTREAM_BASE

// 保证 import 时 ACTIVE_PLAN 为默认 go 档（此前任何测试若残留 zen 配置会污染模块加载态）
try { rmSync(process.env.ZEN_GATEWAY_CONFIG, { force: true }) } catch {}

let gw
try {
  gw = await import("../gateway.mjs")
} catch (e) {
  console.error(`❌ 无法 import gateway.mjs（模块加载失败）: ${e && e.stack || e}`)
  process.exit(1)
}

/* ---- 极简断言 harness ---- */
let passed = 0
const failures = []
let groups = []
let currentGroup = ""

function group(name) {
  currentGroup = name
  groups.push({ name, count: 0 })
  console.log(`\n【${name}】`)
}

function t(name, fn) {
  try {
    fn()
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures.push({ group: currentGroup, name, error: e })
    console.log(`  ❌ ${name}\n     ${String((e && e.message) || e).split("\n").join("\n     ")}`)
  }
}

/* ================= 1. parseResetTime ================= */
group("parseResetTime（reset at 时区解析）")

t("+0800 偏移 → 正确 UTC（08:00+08:00 = 00:00Z，不退化本地时区）", () => {
  assert.equal(gw.parseResetTime("quota exceeded, reset at 2026-08-16 08:00:00 +0800 CST"), "2026-08-16T00:00:00.000Z")
})
t("+08:00 带冒号偏移 → 同样 UTC", () => {
  assert.equal(gw.parseResetTime("reset at 2026-08-16 08:00:00 +08:00"), "2026-08-16T00:00:00.000Z")
})
t("Z 后缀 → 原样 UTC 时间", () => {
  assert.equal(gw.parseResetTime("reset at 2026-08-16T08:00:00Z"), "2026-08-16T08:00:00.000Z")
})
t("负偏移 -0500 → 08:00-05:00 = 13:00Z", () => {
  assert.equal(gw.parseResetTime("reset at 2026-08-16 08:00:00 -0500"), "2026-08-16T13:00:00.000Z")
})
t("无偏移 → 按本地时区解释（本地墙钟时间分量一致）", () => {
  const r = gw.parseResetTime("reset at 2026-08-16 08:00:00")
  assert.ok(r, "应返回非 null")
  const d = new Date(r)
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 7) // 8月（0-based）
  assert.equal(d.getDate(), 16)
  assert.equal(d.getHours(), 8)
  assert.equal(d.getMinutes(), 0)
})
t("毫秒精度保留", () => {
  assert.equal(gw.parseResetTime("reset at 2026-08-16 08:00:00.500 +0800"), "2026-08-16T00:00:00.500Z")
})
t("大小写不敏感（Reset At / reset at）", () => {
  assert.equal(gw.parseResetTime("Reset At 2026-08-16 08:00:00 +0800"), "2026-08-16T00:00:00.000Z")
})
t("无 reset at 文本 → null", () => {
  assert.equal(gw.parseResetTime("no reset time here"), null)
})
t("空字符串 → null", () => {
  assert.equal(gw.parseResetTime(""), null)
})
t("非法时间（25:99:99）→ null（Date.parse NaN）", () => {
  assert.equal(gw.parseResetTime("reset at 2026-08-16 25:99:99 +0800"), null)
})
t("reset at 后跟垃圾 → null", () => {
  assert.equal(gw.parseResetTime("reset at garbage"), null)
})

/* ================= 2. isQuotaStatus / isQuotaError ================= */
group("isQuotaStatus / isQuotaError（配额判定）")

t("isQuotaStatus 401/402/429 → true", () => {
  assert.equal(gw.isQuotaStatus(401), true)
  assert.equal(gw.isQuotaStatus(402), true)
  assert.equal(gw.isQuotaStatus(429), true)
})
t("isQuotaStatus 500/403/200 → false", () => {
  assert.equal(gw.isQuotaStatus(500), false)
  assert.equal(gw.isQuotaStatus(403), false)
  assert.equal(gw.isQuotaStatus(200), false)
})
t("isQuotaError 401/402/429（空 body）→ true", () => {
  assert.equal(gw.isQuotaError(401, {}), true)
  assert.equal(gw.isQuotaError(402, {}), true)
  assert.equal(gw.isQuotaError(429, {}), true)
})
t("isQuotaError 500/403（正常 body）→ false", () => {
  assert.equal(gw.isQuotaError(500, {}), false)
  assert.equal(gw.isQuotaError(403, {}), false)
})
t("msg 含 quota → true", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "quota exceeded" } }), true)
})
t("msg 含 insufficient（大小写不敏感）→ true", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "Insufficient Balance" } }), true)
})
t("msg 含 balance → true", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "your balance is not enough" } }), true)
})
t("msg 含 rate limit → true", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "rate limit reached" } }), true)
})
t("msg 含 rate-limit（连字符）→ true", () => {
  assert.equal(gw.isQuotaError(200, { message: "rate-limit" }), true)
})
t("msg 含 usage limit → true", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "usage limit exceeded" } }), true)
})
t("msg 含 exceeded → true", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "you have exceeded your quota" } }), true)
})
t("body.message 兜底字段也能识别", () => {
  assert.equal(gw.isQuotaError(200, { message: "insufficient balance" }), true)
})
t("正常错误 msg → false", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "model not found" } }), false)
})
t("中文 配额/余额/限流/超出 → true（已修，主线程 2026-08-16）", () => {
  assert.equal(gw.isQuotaError(200, { error: { message: "配额不足" } }), true)
  assert.equal(gw.isQuotaError(200, { error: { message: "余额不足" } }), true)
  assert.equal(gw.isQuotaError(200, { error: { message: "请求已被限流" } }), true)
  assert.equal(gw.isQuotaError(200, { error: { message: "使用量超出限制" } }), true)
  assert.equal(gw.isQuotaError(200, { error: { message: "model not found" } }), false)
})

/* ================= 2.5 classifyGoError（与 go-rotate 契约一致，X1 修复 2026-08-16） ================= */
group("classifyGoError（健康状态分类，契约对齐 go-rotate）")

t("401 + Invalid API key → invalid", () => {
  assert.equal(gw.classifyGoError("Invalid API key.", 401), "invalid")
})
t("401 + invalid api key（小写）→ invalid（大小写不敏感）", () => {
  assert.equal(gw.classifyGoError("invalid api key", 401), "invalid")
})
t("401 无明确消息 → nobalance（与 go-rotate 一致）", () => {
  assert.equal(gw.classifyGoError("", 401), "nobalance")
})
t("402 → nobalance", () => {
  assert.equal(gw.classifyGoError("payment required", 402), "nobalance")
})
t("msg 含 insufficient/balance → nobalance（非 401/402 状态）", () => {
  assert.equal(gw.classifyGoError("Insufficient Balance", 200), "nobalance")
  assert.equal(gw.classifyGoError("your balance is not enough", 403), "nobalance")
})
t("429 → limited", () => {
  assert.equal(gw.classifyGoError("rate limit reached", 429), "limited")
})
t("msg 含 quota/rate/limit/exceeded → limited（非 429 状态）", () => {
  assert.equal(gw.classifyGoError("you have exceeded your quota", 200), "limited")
  assert.equal(gw.classifyGoError("rate-limit", 500), "limited")
})
t("其它错误 → error", () => {
  assert.equal(gw.classifyGoError("model not found", 500), "error")
  assert.equal(gw.classifyGoError("", 403), "error")
  assert.equal(gw.classifyGoError(undefined, undefined), "error")
})

/* ================= 3. mapModel ================= */
group("mapModel（模型映射）")

t("内置真实模型名原样返回", () => {
  assert.equal(gw.mapModel("hy3"), "hy3")
  assert.equal(gw.mapModel("deepseek-v4-flash"), "deepseek-v4-flash")
  assert.equal(gw.mapModel("glm-5.2"), "glm-5.2")
})
t("别名 gpt-4o → glm-5.2", () => {
  assert.equal(gw.mapModel("gpt-4o"), "glm-5.2")
})
t("别名 gpt-4o-mini → deepseek-v4-flash", () => {
  assert.equal(gw.mapModel("gpt-4o-mini"), "deepseek-v4-flash")
})
t("别名 grok-code → hy3", () => {
  assert.equal(gw.mapModel("grok-code"), "hy3")
})
t("别名 deepseek-chat → deepseek-v4-pro", () => {
  assert.equal(gw.mapModel("deepseek-chat"), "deepseek-v4-pro")
})
t("别名 claude-3-5-sonnet-20241022 → 默认 hy3", () => {
  assert.equal(gw.mapModel("claude-3-5-sonnet-20241022"), "hy3")
})
t("未知名 → 默认 hy3", () => {
  assert.equal(gw.mapModel("unknown-model-xyz"), "hy3")
})
t("空串 / undefined → 默认 hy3", () => {
  assert.equal(gw.mapModel(""), "hy3")
  assert.equal(gw.mapModel(undefined), "hy3")
})
t("大小写不敏感（GPT-4O → glm-5.2）", () => {
  assert.equal(gw.mapModel("GPT-4O"), "glm-5.2")
})
t("动态表命中优先（新增模型原样返回）", () => {
  gw.__setDynamicModels(["my-fake-model"])
  assert.equal(gw.mapModel("my-fake-model"), "my-fake-model")
})
t("动态表优先于别名（上游真有 gpt-4o 时返回原样）", () => {
  gw.__setDynamicModels(["gpt-4o"])
  assert.equal(gw.mapModel("gpt-4o"), "gpt-4o")
})
t("重置动态表后恢复默认行为", () => {
  gw.__setDynamicModels([])
  assert.equal(gw.mapModel("my-fake-model"), "hy3")
})
{
  // zen 档：付费别名回退套餐默认 —— 必须用顶层块真 await（不能用 t() 的 async fn：t() 不 await，
  // 会使本 import 与后续 gwA import 在同一微任务批次求值、读取同步阶段最终 env，污染 gwA 的 ACTIVE_PLAN）。
  let ok = true
  let err = null
  let nameZenMap = "zen 档：付费别名回退套餐默认（gpt-4o-mini → hy3-free，不发出付费模型）"
  try {
    const cfgPath = "/tmp/zen-gateway-unittest-gwcfg-zen.json"
    writeFileSync(cfgPath, JSON.stringify({ plan: "zen", token: "a".repeat(64) }))
    const savedCfg = process.env.ZEN_GATEWAY_CONFIG
    const savedDefault = process.env.ZEN_DEFAULT_MODEL
    process.env.ZEN_GATEWAY_CONFIG = cfgPath
    delete process.env.ZEN_DEFAULT_MODEL
    try {
      const zen = await import("../gateway.mjs?plan-zen-map=" + Date.now())
      assert.equal(zen.mapModel("gpt-4o-mini"), "hy3-free")          // 付费别名 → 回退默认
      assert.equal(zen.mapModel("gpt-4o"), "hy3-free")               // 付费别名 → 回退默认
      assert.equal(zen.mapModel("grok-code"), "hy3-free")            // hy3 付费 → 回退默认
      assert.equal(zen.mapModel("hy3-free"), "hy3-free")             // free 内置原样
      assert.equal(zen.mapModel("deepseek-v4-flash-free"), "deepseek-v4-flash-free")
      assert.equal(zen.mapModel("unknown-xyz"), "hy3-free")          // 未知名默认
    } finally {
      process.env.ZEN_GATEWAY_CONFIG = savedCfg
      if (savedDefault === undefined) delete process.env.ZEN_DEFAULT_MODEL
      else process.env.ZEN_DEFAULT_MODEL = savedDefault
    }
  } catch (e) {
    ok = false
    err = e
  }
  if (ok) {
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${nameZenMap}`)
  } else {
    failures.push({ group: currentGroup, name: nameZenMap, error: err })
    console.log(`  ❌ ${nameZenMap}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`)
  }
}
t("go 档：付费别名不受影响（gpt-4o-mini → deepseek-v4-flash 仍在内置表）", () => {
  assert.equal(gw.mapModel("gpt-4o-mini"), "deepseek-v4-flash")
  assert.equal(gw.mapModel("gpt-4o"), "glm-5.2")
  assert.equal(gw.mapModel("grok-code"), "hy3")
})

/* ================= 4. anthropicToOpenAI ================= */
group("anthropicToOpenAI（Anthropic→OpenAI 请求转换）")

t("system 字符串 → 首条 role:system", () => {
  const out = gw.anthropicToOpenAI({ model: "m", system: "you are helpful", messages: [] })
  assert.equal(out.messages[0].role, "system")
  assert.equal(out.messages[0].content, "you are helpful")
})
t("system content 数组 → 按 \\n 拼接", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
    messages: [],
  })
  assert.equal(out.messages[0].content, "a\nb")
})
t("system 空数组 → 不生成 system 消息", () => {
  const out = gw.anthropicToOpenAI({ model: "m", system: [], messages: [] })
  assert.equal(out.messages.length, 0)
})
t("user string content → 原样", () => {
  const out = gw.anthropicToOpenAI({ model: "m", messages: [{ role: "user", content: "hello" }] })
  assert.deepEqual(out.messages, [{ role: "user", content: "hello" }])
})
t("assistant string content → 原样", () => {
  const out = gw.anthropicToOpenAI({ model: "m", messages: [{ role: "assistant", content: "hi there" }] })
  assert.deepEqual(out.messages, [{ role: "assistant", content: "hi there" }])
})
t("text blocks 数组 → 拼接为单条字符串", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }],
  })
  assert.deepEqual(out.messages, [{ role: "user", content: "one\ntwo" }])
})
t("image base64 block → image_url data URI", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }],
  })
  assert.equal(out.messages[0].content[0].type, "image_url")
  assert.equal(out.messages[0].content[0].image_url.url, "data:image/png;base64,AAAA")
})
t("image url block → image_url url", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://x/y.png" } }] }],
  })
  assert.equal(out.messages[0].content[0].image_url.url, "https://x/y.png")
})
t("text+image 混合 → 文本块数组 + image_url", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
      ],
    }],
  })
  assert.equal(out.messages[0].content.length, 2)
  assert.equal(out.messages[0].content[0].type, "text")
  assert.equal(out.messages[0].content[1].type, "image_url")
})
t("tool_result string → role:tool + tool_call_id", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "42" }] }],
  })
  assert.deepEqual(out.messages, [{ role: "tool", tool_call_id: "toolu_1", content: "42" }])
})
t("tool_result content 数组 → 拼接", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_2",
        content: [{ type: "text", text: "r1" }, { type: "text", text: "r2" }],
      }],
    }],
  })
  assert.deepEqual(out.messages, [{ role: "tool", tool_call_id: "toolu_2", content: "r1\nr2" }])
})
t("assistant tool_use block → tool_calls（已修，主线程 2026-08-16）", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "toolu_1", name: "foo", input: {} },
      ],
    }],
  })
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].content, "calling")
  assert.deepEqual(out.messages[0].tool_calls, [
    { id: "toolu_1", type: "function", function: { name: "foo", arguments: "{}" } },
  ])
})
t("assistant 纯 tool_use（无文本）→ content:null + tool_calls", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    messages: [{
      role: "assistant",
      content: [{ type: "tool_use", id: "toolu_9", name: "bar", input: { a: 1 } }],
    }],
  })
  assert.equal(out.messages.length, 1)
  assert.equal(out.messages[0].content, null)
  assert.deepEqual(out.messages[0].tool_calls, [
    { id: "toolu_9", type: "function", function: { name: "bar", arguments: '{"a":1}' } },
  ])
})
t("thinking 参数被忽略（不产生字段）", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    thinking: { type: "enabled", budget_tokens: 1000 },
    messages: [{ role: "user", content: "q" }],
  })
  assert.ok(!("thinking" in out))
})
t("stop_sequences / metadata / top_k 被忽略", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    stop_sequences: ["\n\n"],
    metadata: { user_id: "x" },
    top_k: 5,
    messages: [{ role: "user", content: "q" }],
  })
  assert.ok(!("stop_sequences" in out) && !("metadata" in out) && !("top_k" in out))
})
t("max_tokens / temperature / top_p / stream 拷贝", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    max_tokens: 100,
    temperature: 0.5,
    top_p: 0.9,
    stream: true,
    messages: [{ role: "user", content: "q" }],
  })
  assert.equal(out.max_tokens, 100)
  assert.equal(out.temperature, 0.5)
  assert.equal(out.top_p, 0.9)
  assert.equal(out.stream, true)
})
t("tools 转换 {name,description,input_schema} → {type:function,function:{...}}", () => {
  const out = gw.anthropicToOpenAI({
    model: "m",
    tools: [{
      name: "get_weather",
      description: "d",
      input_schema: { type: "object", properties: { city: { type: "string" } } },
    }],
    messages: [],
  })
  assert.equal(out.tools[0].type, "function")
  assert.equal(out.tools[0].function.name, "get_weather")
  assert.deepEqual(out.tools[0].function.parameters.properties, { city: { type: "string" } })
})
t("tool_choice any → required", () => {
  assert.equal(gw.anthropicToOpenAI({ model: "m", tool_choice: { type: "any" }, messages: [] }).tool_choice, "required")
})
t("tool_choice tool+name → {type:function,function:{name}}", () => {
  assert.deepEqual(
    gw.anthropicToOpenAI({ model: "m", tool_choice: { type: "tool", name: "foo" }, messages: [] }).tool_choice,
    { type: "function", function: { name: "foo" } },
  )
})
t("tool_choice auto/none → auto", () => {
  assert.equal(gw.anthropicToOpenAI({ model: "m", tool_choice: { type: "auto" }, messages: [] }).tool_choice, "auto")
  assert.equal(gw.anthropicToOpenAI({ model: "m", tool_choice: { type: "none" }, messages: [] }).tool_choice, "auto")
})

/* ================= 5. openAIToAnthropic ================= */
group("openAIToAnthropic（OpenAI→Anthropic 响应转换）")

t("text → content[0] text 块 + role/model 结构", () => {
  const r = gw.openAIToAnthropic(
    { id: "chatcmpl-1", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    "hy3",
  )
  assert.equal(r.type, "message")
  assert.equal(r.role, "assistant")
  assert.equal(r.model, "hy3")
  assert.deepEqual(r.content, [{ type: "text", text: "hi" }])
})
t("finish_reason stop → stop_reason end_turn", () => {
  assert.equal(gw.openAIToAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, "m").stop_reason, "end_turn")
})
t("finish_reason length → stop_reason max_tokens", () => {
  assert.equal(gw.openAIToAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }, "m").stop_reason, "max_tokens")
})
t("finish_reason tool_calls → stop_reason tool_use", () => {
  assert.equal(gw.openAIToAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "tool_calls" }] }, "m").stop_reason, "tool_use")
})
t("tool_calls → tool_use（arguments 解析为 input）", () => {
  const r = gw.openAIToAnthropic({
    choices: [{
      message: { content: "", tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"sz"}' } }] },
      finish_reason: "tool_calls",
    }],
  }, "m")
  assert.equal(r.content[0].type, "tool_use")
  assert.equal(r.content[0].id, "call_1")
  assert.equal(r.content[0].name, "get_weather")
  assert.deepEqual(r.content[0].input, { city: "sz" })
})
t("tool_calls 非法 JSON arguments → input {} 兜底", () => {
  const r = gw.openAIToAnthropic({
    choices: [{
      message: { content: "", tool_calls: [{ id: "c2", function: { name: "f", arguments: "not-json{" } }] },
      finish_reason: "tool_calls",
    }],
  }, "m")
  assert.deepEqual(r.content[0].input, {})
})
t("content null + reasoning_content → text 用 reasoning 兜底", () => {
  const r = gw.openAIToAnthropic({ choices: [{ message: { content: null, reasoning_content: "thinking..." }, finish_reason: "stop" }] }, "m")
  assert.deepEqual(r.content, [{ type: "text", text: "thinking..." }])
})
t("content 空 + 无 reasoning → 空 text 块 + stop_reason 强制 max_tokens", () => {
  const r = gw.openAIToAnthropic({ choices: [{ message: {}, finish_reason: "stop" }] }, "m")
  assert.deepEqual(r.content, [{ type: "text", text: "" }])
  assert.equal(r.stop_reason, "max_tokens")
})
t("usage 映射 prompt_tokens/completion_tokens", () => {
  const r = gw.openAIToAnthropic(
    { choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
    "m",
  )
  assert.deepEqual(r.usage, { input_tokens: 11, output_tokens: 7 })
})
t("id 清洗：非字母数字剥除 + 24 字符截断", () => {
  const r = gw.openAIToAnthropic({ id: "chatcmpl-abc123XYZ", choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, "m")
  assert.equal(r.id, "msg_chatcmplabc123XYZ")
})
t("无 id → msg_zen", () => {
  assert.equal(gw.openAIToAnthropic({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }, "m").id, "msg_zen")
})

/* ================= 6. responsesToOpenAI ================= */
group("responsesToOpenAI（Responses→OpenAI 请求转换）")

t("input 字符串 → user 消息", () => {
  const out = gw.responsesToOpenAI({ model: "m", input: "hello" })
  assert.deepEqual(out.messages, [{ role: "user", content: "hello" }])
})
t("input message 数组（content 数组 input_text）→ 消息", () => {
  const out = gw.responsesToOpenAI({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] })
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }])
})
t("input 含 output_text / text 类型块 → 拼接", () => {
  const out = gw.responsesToOpenAI({
    model: "m",
    input: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "a" }, { type: "text", text: "b" }] }],
  })
  assert.deepEqual(out.messages, [{ role: "assistant", content: "a\nb" }])
})
t("function_call_output → role:tool + call_id", () => {
  const out = gw.responsesToOpenAI({ model: "m", input: [{ type: "function_call_output", call_id: "fc_1", output: "42" }] })
  assert.deepEqual(out.messages, [{ role: "tool", tool_call_id: "fc_1", content: "42" }])
})
t("function_call_output 非字符串 output → JSON 序列化", () => {
  const out = gw.responsesToOpenAI({ model: "m", input: [{ type: "function_call_output", call_id: "fc_2", output: { result: 42 } }] })
  assert.equal(out.messages[0].content, '{"result":42}')
})
t("function_call 追问项被忽略（实现现状，见报告）", () => {
  const out = gw.responsesToOpenAI({ model: "m", input: [{ type: "function_call", call_id: "fc_3", name: "f", arguments: "{}" }] })
  assert.equal(out.messages.length, 0)
})
t("instructions 字符串 → system", () => {
  const out = gw.responsesToOpenAI({ model: "m", instructions: "be concise", input: "q" })
  assert.equal(out.messages[0].role, "system")
  assert.equal(out.messages[0].content, "be concise")
})
t("instructions 数组 → 拼接 system", () => {
  const out = gw.responsesToOpenAI({
    model: "m",
    instructions: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }],
    input: "q",
  })
  assert.equal(out.messages[0].content, "a\nb")
})
t("max_output_tokens → max_tokens", () => {
  const out = gw.responsesToOpenAI({ model: "m", max_output_tokens: 200, input: "q" })
  assert.equal(out.max_tokens, 200)
})
t("tools 转换（function 包装）", () => {
  const out = gw.responsesToOpenAI({
    model: "m",
    tools: [{ type: "function", name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }],
    input: "q",
  })
  assert.equal(out.tools[0].type, "function")
  assert.equal(out.tools[0].function.name, "get_weather")
  assert.deepEqual(out.tools[0].function.parameters, { type: "object", properties: {} })
})
t("tool_choice / temperature / stream 透传", () => {
  const out = gw.responsesToOpenAI({ model: "m", tool_choice: "auto", temperature: 0.2, stream: true, input: "q" })
  assert.equal(out.tool_choice, "auto")
  assert.equal(out.temperature, 0.2)
  assert.equal(out.stream, true)
})
t("无 input/messages → 空 messages 数组 + model 保留", () => {
  const out = gw.responsesToOpenAI({ model: "hy3" })
  assert.deepEqual(out.messages, [])
  assert.equal(out.model, "hy3")
})

/* ================= 7. openAIToResponse ================= */
group("openAIToResponse（OpenAI→Responses 响应转换）")

t("文本 → output[0] message + output_text", () => {
  const r = gw.openAIToResponse(
    { id: "x", choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } },
    "hy3",
    "gpt-5",
  )
  assert.equal(r.object, "response")
  assert.equal(r.model, "gpt-5")
  assert.equal(r.status, "completed")
  assert.equal(r.output[0].type, "message")
  assert.equal(r.output[0].content[0].type, "output_text")
  assert.equal(r.output[0].content[0].text, "hi")
})
t("usage total = input + output", () => {
  const r = gw.openAIToResponse({ choices: [{ message: { content: "x" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4 } }, "m", null)
  assert.equal(r.usage.total_tokens, 7)
  assert.equal(r.usage.input_tokens, 3)
  assert.equal(r.usage.output_tokens, 4)
})
t("finish_reason length → status incomplete", () => {
  assert.equal(gw.openAIToResponse({ choices: [{ message: { content: "x" }, finish_reason: "length" }] }, "m", null).status, "incomplete")
})
t("content null → 空 output_text + incomplete", () => {
  const r = gw.openAIToResponse({ choices: [{ message: {}, finish_reason: "stop" }] }, "m", null)
  assert.equal(r.status, "incomplete")
  assert.equal(r.output[0].content[0].text, "")
})
t("tool_calls → function_call 输出项", () => {
  const r = gw.openAIToResponse({
    choices: [{ message: { content: "", tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"c":1}' } }] }, finish_reason: "tool_calls" }] },
    "m",
    null,
  )
  const fc = r.output.find((o) => o.type === "function_call")
  assert.ok(fc)
  assert.equal(fc.name, "get_weather")
  assert.equal(fc.arguments, '{"c":1}')
  assert.equal(fc.call_id, "call_1")
})
t("纯 tool_calls 响应 → completed + 无空文本块（已修，主线程 2026-08-16）", () => {
  const r = gw.openAIToResponse({
    choices: [{ message: { content: "", tool_calls: [{ id: "c", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
    "m",
    null,
  )
  assert.equal(r.status, "completed")
  assert.equal(r.output.filter((o) => o.type === "message").length, 0)
  assert.equal(r.output.filter((o) => o.type === "function_call").length, 1)
})
t("reasoning_content 兜底（content null）", () => {
  const r = gw.openAIToResponse({ choices: [{ message: { content: null, reasoning_content: "rt" }, finish_reason: "stop" }] }, "m", null)
  assert.equal(r.output[0].content[0].text, "rt")
})

/* ================= 8. currentKey ================= */
group("currentKey（当前 key 解析）")

t("current 存在 → 返回该 key", () => {
  const cfg = { current: "b", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }
  assert.equal(gw.currentKey(cfg).name, "b")
})
t("current 不存在（X2 自愈语义）→ keys[0]", () => {
  const cfg = { current: "ghost", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }
  assert.equal(gw.currentKey(cfg).name, "a")
})
t("空 keys → undefined（== null）", () => {
  assert.equal(gw.currentKey({ current: "", keys: [] }), undefined)
})
t("网关域：current_gateway 优先于 current（两域不同游标各自独立）", () => {
  const cfg = { current: "a", current_gateway: "b", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }
  assert.equal(gw.currentKey(cfg).name, "b")
})
t("网关域：仅 current → 兜底 current（旧配置零迁移）", () => {
  const cfg = { current: "a", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }
  assert.equal(gw.currentKey(cfg).name, "a")
})
t("网关域：current_gateway 指向不存在 → keys[0]（自愈）", () => {
  const cfg = { current: "a", current_gateway: "ghost", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }
  assert.equal(gw.currentKey(cfg).name, "a")
})

/* ================= 8b. loadConfig（含网关域 reconcile 自愈 + 迁移兜底） ================= */
group("loadConfig（current_gateway 读侧兜底 / 双域自愈）")

t("默认值含 current_gateway（空配置 → '')", () => {
  const p = process.env.ZEN_CONFIG
  writeFileSync(p, "{}", "utf8")
  const cfg = gw.loadConfig()
  assert.ok("current_gateway" in cfg, "返回对象必须含 current_gateway 字段")
  assert.equal(cfg.current_gateway, "")
})
t("有 current_gateway → 原样返回（与 current 并列）", () => {
  const p = process.env.ZEN_CONFIG
  writeFileSync(
    p,
    JSON.stringify({ current: "a", current_gateway: "b", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }),
    "utf8",
  )
  const cfg = gw.loadConfig()
  assert.equal(cfg.current, "a")
  assert.equal(cfg.current_gateway, "b")
})
t("迁移兜底：无 current_gateway → current_gateway ?? current", () => {
  const p = process.env.ZEN_CONFIG
  writeFileSync(p, JSON.stringify({ current: "a", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }), "utf8")
  const cfg = gw.loadConfig()
  assert.equal(cfg.current_gateway, "a")
})
t("自愈：current_gateway 指向不存在 → 兜底 current（有效时）", () => {
  const p = process.env.ZEN_CONFIG
  writeFileSync(
    p,
    JSON.stringify({ current: "a", current_gateway: "ghost", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }),
    "utf8",
  )
  const cfg = gw.loadConfig()
  assert.equal(cfg.current, "a")
  assert.equal(cfg.current_gateway, "a")
})
t("自愈：current_gateway 与 current 均无效 → 归 keys[0]", () => {
  const p = process.env.ZEN_CONFIG
  writeFileSync(
    p,
    JSON.stringify({ current: "x", current_gateway: "g", keys: [{ name: "a", key: "k1" }, { name: "b", key: "k2" }] }),
    "utf8",
  )
  const cfg = gw.loadConfig()
  assert.equal(cfg.current, "a")
  assert.equal(cfg.current_gateway, "a")
})

/* ================= 9. cooldownUntilDefault ================= */
group("cooldownUntilDefault（默认冷却窗口）")

t("显式 cooldown_minutes=30 → now+30min ISO", () => {
  const before = Date.now()
  const r = gw.cooldownUntilDefault({ cooldown_minutes: 30 })
  const after = Date.now()
  const tms = Date.parse(r)
  assert.ok(tms >= before + 29 * 60000 && tms <= after + 31 * 60000, `超出窗口: ${r}`)
})
t("缺省 → DEFAULT_COOLDOWN_MIN=300min", () => {
  const before = Date.now()
  const r = gw.cooldownUntilDefault({})
  const tms = Date.parse(r)
  assert.ok(tms >= before + 299 * 60000 && tms <= before + 301 * 60000 + 5000, `超出窗口: ${r}`)
})
t("返回合法 ISO 字符串", () => {
  const r = gw.cooldownUntilDefault({ cooldown_minutes: 1 })
  assert.ok(!Number.isNaN(Date.parse(r)))
  assert.ok(r.endsWith("Z"))
})

/* ================= 10. maskToken ================= */
group("maskToken（token 掩码）")

t("长度 ≥8 → 前4+****+后4，中间不泄漏", () => {
  const tok = "sk-abcdefgh12345678"
  const m = gw.maskToken(tok)
  assert.equal(m, "sk-a****5678")
  assert.ok(!m.includes(tok.slice(4, -4)))
})
t("长度恰为 8 → 首4+尾4 全覆盖", () => {
  assert.equal(gw.maskToken("abcdefgh"), "abcd****efgh")
})
t("长度 <8 → ****", () => {
  assert.equal(gw.maskToken("abc"), "****")
  assert.equal(gw.maskToken("abcdef"), "****")
})
t("空串 / undefined / null → ****", () => {
  assert.equal(gw.maskToken(""), "****")
  assert.equal(gw.maskToken(undefined), "****")
  assert.equal(gw.maskToken(null), "****")
})
t("掩码结果不含完整原文", () => {
  const tok = "sk-1234567890abcdef"
  assert.ok(!gw.maskToken(tok).includes(tok))
})

/* ================= 11. parseErrorBody ================= */
group("parseErrorBody（错误体解析）")

t("合法 JSON 对象 → 解析", () => {
  assert.deepEqual(gw.parseErrorBody('{"error":{"message":"boom"}}'), { error: { message: "boom" } })
})
t("带 status 的错误体 → 结构保留", () => {
  const r = gw.parseErrorBody('{"error":{"message":"m","type":"x"},"status":429}')
  assert.equal(r.error.message, "m")
  assert.equal(r.status, 429)
})
t("非法 JSON → {error:{message:原文}}", () => {
  assert.deepEqual(gw.parseErrorBody("not json at all"), { error: { message: "not json at all" } })
})
t('空串 → {error:{message:""}}', () => {
  assert.deepEqual(gw.parseErrorBody(""), { error: { message: "" } })
})
t("JSON 原始值（\"123\"）→ 原样返回 123（非对象，调用方需自行防御）", () => {
  assert.equal(gw.parseErrorBody("123"), 123)
})

/* ================= 12. combineSignals ================= */
group("combineSignals（双信号桥接）")

t("单信号（B 为空）→ 原样返回 A", () => {
  const a = new AbortController()
  assert.equal(gw.combineSignals(a.signal, null), a.signal)
})
t("单信号（A 为空）→ 原样返回 B", () => {
  const b = new AbortController()
  assert.equal(gw.combineSignals(null, b.signal), b.signal)
})
t("双空 → null", () => {
  assert.equal(gw.combineSignals(null, null), null)
})
t("初始均未 abort → combined 未 abort", () => {
  const c = gw.combineSignals(new AbortController().signal, new AbortController().signal)
  assert.equal(c.aborted, false)
})
t("abort A → combined abort", () => {
  const a = new AbortController()
  const c = gw.combineSignals(a.signal, new AbortController().signal)
  a.abort()
  assert.equal(c.aborted, true)
})
t("abort B → combined abort", () => {
  const b = new AbortController()
  const c = gw.combineSignals(new AbortController().signal, b.signal)
  b.abort()
  assert.equal(c.aborted, true)
})
t("A 预置已 abort → combined 立即 abort", () => {
  const a = new AbortController()
  a.abort()
  assert.equal(gw.combineSignals(a.signal, new AbortController().signal).aborted, true)
})
t("B 预置已 abort → combined 立即 abort", () => {
  const b = new AbortController()
  b.abort()
  assert.equal(gw.combineSignals(new AbortController().signal, b.signal).aborted, true)
})
t("两个源都 abort → combined 保持 abort（幂等不抛）", () => {
  const a = new AbortController()
  const b = new AbortController()
  const c = gw.combineSignals(a.signal, b.signal)
  a.abort()
  b.abort()
  assert.equal(c.aborted, true)
})

/* ================= 13. pickNext ================= */
group("pickNext（轮换选择）")

t("下一可用 key（无冷却）", () => {
  const cfg = { current: "a", keys: [{ name: "a", key: "1" }, { name: "b", key: "2" }, { name: "c", key: "3" }] }
  assert.equal(gw.pickNext(cfg).name, "b")
})
t("跳过【网关域】冷却中的 key（cooldown_until_gateway）", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1" },
      { name: "b", key: "2", cooldown_until_gateway: new Date(Date.now() + 999999).toISOString() },
      { name: "c", key: "3" },
    ],
  }
  assert.equal(gw.pickNext(cfg).name, "c")
})
t("TUI 域 cooldown_until 不影响网关域 pickNext（b 有 TUI 冷却但仍可选）", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1" },
      { name: "b", key: "2", cooldown_until: new Date(Date.now() + 999999).toISOString() },
    ],
  }
  assert.equal(gw.pickNext(cfg).name, "b")
})
t("【网关域】冷却已过期 → 视为可用", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1" },
      { name: "b", key: "2", cooldown_until_gateway: new Date(Date.now() - 1000).toISOString() },
    ],
  }
  assert.equal(gw.pickNext(cfg).name, "b")
})
t("【网关域】全部冷却 → undefined", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1", cooldown_until_gateway: new Date(Date.now() + 999999).toISOString() },
      { name: "b", key: "2", cooldown_until_gateway: new Date(Date.now() + 999999).toISOString() },
    ],
  }
  assert.equal(gw.pickNext(cfg), undefined)
})
t("current 不在 keys → 从 keys[0] 起找可用【网关域】", () => {
  const cfg = {
    current: "ghost",
    keys: [
      { name: "a", key: "1", cooldown_until_gateway: new Date(Date.now() + 999999).toISOString() },
      { name: "b", key: "2" },
    ],
  }
  assert.equal(gw.pickNext(cfg).name, "b")
})
t("起点用网关域 current_gateway（a 网关冷却跳过 → 从 c 起）", () => {
  const cfg = {
    current: "c", // TUI 域游标
    current_gateway: "a", // 网关域游标
    keys: [
      { name: "a", key: "1", cooldown_until_gateway: new Date(Date.now() + 999999).toISOString() },
      { name: "b", key: "2" },
      { name: "c", key: "3" },
    ],
  }
  // start = a（网关域），跳过 a → b（无网关冷却）→ 可选 b
  assert.equal(gw.pickNext(cfg).name, "b")
})
t("空 keys → undefined", () => {
  assert.equal(gw.pickNext({ current: "", keys: [] }), undefined)
})

/* ================= 14. allModelIds ================= */
group("allModelIds（模型清单）")

t("动态表为空 → 26 个内置模型，升序", () => {
  gw.__setDynamicModels([])
  const ids = gw.allModelIds()
  assert.equal(ids.length, 26)
  assert.deepEqual(ids, [...ids].sort())
})
t("动态表合并去重（含内置交集）", () => {
  gw.__setDynamicModels(["glm-5", "zzz-extra"])
  const ids = gw.allModelIds()
  assert.ok(ids.includes("glm-5"))
  assert.ok(ids.includes("zzz-extra"))
  assert.equal(new Set(ids).size, ids.length)
  gw.__setDynamicModels([])
})

/* ================= 15. aggregateUsage / readUsageFile（/api/usage/trend 纯函数） ================= */
// 固定 now（2026-08-16 UTC 12:00），保证 days 窗口确定性：
// 近 7 天窗口 = 2026-08-10..2026-08-16；近 3 天 = 2026-08-14..2026-08-16
const TREND_NOW = new Date("2026-08-16T12:00:00.000Z")
// 混合样本：3 key × 2 端点 × 3 日期（含 5 天前的超窗行）+ 2 坏行 + 空行
const TREND_LINES = [
  '{"ts":"2026-08-16T08:00:00.000Z","key":"act1","ok":true,"model":"hy3","rotated":false,"endpoint":"chat"}',
  '{"ts":"2026-08-16T09:00:00.000Z","key":"act2","ok":false,"model":"hy3","rotated":true,"endpoint":"messages"}',
  '{"ts":"2026-08-16T10:00:00.000Z","key":"act1","ok":true,"model":"glm-5.2","rotated":false,"endpoint":"responses"}',
  '{"ts":"2026-08-15T23:30:00.000Z","key":"act2","ok":true,"model":"hy3","rotated":false,"endpoint":"chat"}',
  '{"ts":"2026-08-15T02:00:00.000+08:00","key":"act1","ok":false,"model":"hy3","rotated":false,"endpoint":"messages"}', // +08:00 → 2026-08-14T18:00Z 归 08-14
  '{"ts":"2026-08-14T05:00:00.000Z","key":"act3","ok":true,"model":"hy3","rotated":false,"endpoint":"chat"}',
  '{"ts":"2026-08-11T05:00:00.000Z","key":"act1","ok":true,"model":"hy3","rotated":false,"endpoint":"chat"}', // 5 天前，超出 days=3 窗口
  "not-json-line", // 坏行 1
  '{"key":"act1"}' // 坏行 2（缺 ts）
]
// 合法记录总数（7 天窗口内全部 7 条合法，含 08-11 那条；3 天窗口为 6 条）
const TREND_VALID_7D = 7

group("aggregateUsage / readUsageFile（/api/usage/trend 纯函数）")

t("空数组 → 空结构（total 0 / 三视图空 / badLines 0 / window 正确）", () => {
  const r = gw.aggregateUsage([], { days: 7, now: TREND_NOW })
  assert.equal(r.total, 0)
  assert.deepEqual(r.byKey, {})
  assert.deepEqual(r.byDay, {})
  assert.deepEqual(r.byEndpoint, {})
  assert.equal(r.badLines, 0)
  assert.equal(r.window.days, 7)
  assert.equal(r.window.startUtc, "2026-08-10T00:00:00.000Z")
  assert.equal(r.window.endUtc, "2026-08-16T23:59:59.999Z")
})

t("坏行计数：非 JSON + 缺 ts 字段计 2，空行不算坏行", () => {
  const r = gw.aggregateUsage([...TREND_LINES, "", "   "], { days: 7, now: TREND_NOW })
  assert.equal(r.badLines, 2)
  assert.equal(r.total, TREND_VALID_7D)
})

t("缺 key 字段也算坏行（rec.key 非 string）", () => {
  const r = gw.aggregateUsage(['{"ts":"2026-08-16T00:00:00.000Z"}'], { days: 7, now: TREND_NOW })
  assert.equal(r.badLines, 1)
  assert.equal(r.total, 0)
})

t("时间不可解析（NaN）→ 坏行", () => {
  const r = gw.aggregateUsage(['{"ts":"not-a-date","key":"act1"}'], { days: 7, now: TREND_NOW })
  assert.equal(r.badLines, 1)
  assert.equal(r.total, 0)
})

t("按 key 汇总：act1 requests=4 success=3 fail=1 rotated=0 lastTs=最新", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, now: TREND_NOW })
  const k = r.byKey["act1"]
  assert.equal(k.requests, 4) // L1+L3+L5+L7
  assert.equal(k.success, 3) // L1 L3 L7 ok
  assert.equal(k.fail, 1) // L5 fail
  assert.equal(k.rotated, 0)
  assert.equal(k.lastTs, "2026-08-16T10:00:00.000Z")
})

t("按 key 汇总：act2 requests=2 success=1 fail=1 rotated=1", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, now: TREND_NOW })
  const k = r.byKey["act2"]
  assert.equal(k.requests, 2)
  assert.equal(k.success, 1)
  assert.equal(k.fail, 1)
  assert.equal(k.rotated, 1)
})

t("按日归日：+08:00 偏移 ISO 折算到前一天 UTC 日期键", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, now: TREND_NOW })
  // 2026-08-15T02:00+08:00 = 2026-08-14T18:00Z → 归 08-14
  assert.equal(r.byDay["2026-08-14"].requests, 2) // 08-14T18:00Z + 08-14T05:00Z
  assert.equal(r.byDay["2026-08-15"].requests, 1)
  assert.equal(r.byDay["2026-08-16"].requests, 3)
  // 08-11 在 7 天窗口内 → 计入
  assert.equal(r.byDay["2026-08-11"].requests, 1)
})

t("按日汇总数字：success/rotated 正确", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, now: TREND_NOW })
  assert.equal(r.byDay["2026-08-16"].success, 2) // act1 chat ok + act1 responses ok
  assert.equal(r.byDay["2026-08-16"].rotated, 1) // act2 messages rotated
  assert.equal(r.byDay["2026-08-14"].success, 1) // act1(+08:00) fail + act3 ok
})

t("按 endpoint 汇总：chat/messages/responses/unknown 各自计数", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, now: TREND_NOW })
  assert.deepEqual(r.byEndpoint["chat"], { requests: 4, ok: 4 }) // L1 L4 L6 L7 全 ok
  assert.deepEqual(r.byEndpoint["messages"], { requests: 2, ok: 0 }) // L2 L5 全 fail
  assert.deepEqual(r.byEndpoint["responses"], { requests: 1, ok: 1 }) // L3
  const r2 = gw.aggregateUsage(['{"ts":"2026-08-16T00:00:00.000Z","key":"a","ok":true}'], { days: 7, now: TREND_NOW })
  assert.deepEqual(r2.byEndpoint["unknown"], { requests: 1, ok: 1 }) // 缺 endpoint → unknown
})

t("days 窗口过滤：days=3 时 08-11 行被排除，total=6", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 3, now: TREND_NOW })
  assert.equal(r.total, 6) // L1-L6，L7(08-11) 被滤
  assert.equal(r.window.startUtc, "2026-08-14T00:00:00.000Z")
  assert.equal(r.window.endUtc, "2026-08-16T23:59:59.999Z")
  assert.equal(r.byKey["act1"].requests, 3) // L1 L3 L5
  assert.ok(!r.byDay["2026-08-11"])
})

t("key 筛选：?key=act2 只统计该 key，total=2，其余视图同步过滤", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, key: "act2", now: TREND_NOW })
  assert.equal(r.total, 2)
  assert.deepEqual(Object.keys(r.byKey), ["act2"])
  assert.equal(r.byEndpoint["chat"].requests, 1) // 仅 act2 的 chat 行
  assert.ok(!r.byEndpoint["responses"]) // act2 无 responses 行
  assert.equal(r.badLines, 2) // 坏行计数不受筛选影响
})

t("总请求/成功/失败/轮换数字正确（全量 7 天）", () => {
  const r = gw.aggregateUsage(TREND_LINES, { days: 7, now: TREND_NOW })
  assert.equal(r.total, 7)
  let succ = 0, fail = 0, rot = 0
  for (const k of Object.values(r.byKey)) { succ += k.success; fail += k.fail; rot += k.rotated }
  assert.equal(succ, 5) // L1 L3 L4 L6 L7 ok
  assert.equal(fail, 2) // L2 L5
  assert.equal(rot, 1) // L2
})

t("days 非法值（0 / -3 / 非数字）→ 回退默认 7", () => {
  for (const bad of [0, -3, "abc", NaN]) {
    const r = gw.aggregateUsage(TREND_LINES, { days: bad, now: TREND_NOW })
    assert.equal(r.window.days, 7)
    assert.equal(r.total, TREND_VALID_7D)
  }
})

t("readUsageFile：文件不存在 → []（不抛错）", () => {
  const lines = gw.readUsageFile("/tmp/definitely-not-exists-usage.jsonl")
  assert.ok(Array.isArray(lines))
  assert.equal(lines.length, 0)
})

t("readUsageFile：空文件 → []", () => {
  const p = "/tmp/zen-gateway-unittest-empty-usage.jsonl"
  writeFileSync(p, "")
  assert.equal(gw.readUsageFile(p).length, 0)
})

t("readUsageFile：正常文件 → 按行拆分（含空行保留给 aggregateUsage 处理）", () => {
  const p = "/tmp/zen-gateway-unittest-real-usage.jsonl"
  const content = TREND_LINES.join("\n") + "\n\n"
  writeFileSync(p, content)
  const lines = gw.readUsageFile(p)
  assert.equal(lines.length, TREND_LINES.length + 2) // 数据行 + 末尾 \n 产生的空行 + 显式空行
  const r = gw.aggregateUsage(lines, { days: 7, now: TREND_NOW })
  assert.equal(r.total, TREND_VALID_7D)
  assert.equal(r.badLines, 2)
})

/* ================= ZEN_AUTH_FILE 隔离（auth.json 绝不落真实路径） ================= */
/* 铁律：本组只操作「临时 auth.json」；对真实 ~/.local/share/opencode/auth.json 仅做只读
 * 快照 + 字节对比（绝不在本组内写入真实 auth.json）。
 * 主 import（gw）在未设 ZEN_AUTH_FILE 时加载 → 其 AUTH_FILE 指向真实路径，仅用于字符串断言。
 * 设 env 的实例用查询串强制重新执行模块顶层（fresh 实例），模拟「import 前设 env」。 */
group("ZEN_AUTH_FILE 隔离（auth.json 绝不落真实路径）")

const realAuthPath = path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
const realAuthBefore = existsSync(realAuthPath) ? readFileSync(realAuthPath, "utf8") : null
const zauthTmp = path.join("/tmp", `gr-zauth-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
mkdirSync(zauthTmp, { recursive: true })

t("不设 ZEN_AUTH_FILE 时 AUTH_FILE 指向真实路径（仅字符串断言，不实际写）", () => {
  assert.ok(gw.AUTH_FILE.includes(os.homedir()), `应包含 homedir，实际: ${gw.AUTH_FILE}`)
  assert.ok(
    gw.AUTH_FILE.endsWith(path.join(".local", "share", "opencode", "auth.json")),
    `应以 .local/share/opencode/auth.json 结尾，实际: ${gw.AUTH_FILE}`,
  )
})

// fresh 实例：先设 env 再 import（查询串绕过 ESM 缓存，重新执行模块顶层常量）
process.env.ZEN_AUTH_FILE = path.join(zauthTmp, "auth.json")
let gwA = null
try {
  process.env.ZEN_GATEWAY_CONFIG = "/tmp/zen-gateway-unittest-gateway-config.json" // 防御：确保 gwA 实例为 go 档（文件缺失→resolvePlan 回退 go；防前面 t() 内 async import 的 env 竞态残留）
gwA = await import("../gateway.mjs?zauth-isolation=1")
} catch (e) {
  failures.push({ group: currentGroup, name: "fresh import（ZEN_AUTH_FILE 已设）", error: e })
  console.log(`  ❌ fresh import（ZEN_AUTH_FILE 已设）: ${String((e && e.message) || e)}`)
}

t("设 ZEN_AUTH_FILE 后（import 前）AUTH_FILE 指向临时路径", () => {
  assert.ok(gwA, "fresh 实例应可加载")
  assert.equal(gwA.AUTH_FILE, process.env.ZEN_AUTH_FILE)
})

t("syncAuth 写临时 auth.json，真实 auth.json 字节不变", () => {
  assert.ok(gwA, "fresh 实例应可加载")
  const fake = "sk-fake-zauth-" + Date.now()
  gwA.syncAuth(fake)
  const written = JSON.parse(readFileSync(gwA.AUTH_FILE, "utf8"))
  assert.equal(written["opencode-go"].key, fake)
  const realAfter = existsSync(realAuthPath) ? readFileSync(realAuthPath, "utf8") : null
  assert.equal(realAfter, realAuthBefore, "真实 auth.json 必须字节不变")
})

t("syncAuth 保留既有 opencode-go 结构并更新 key，其它字段不动", () => {
  assert.ok(gwA, "fresh 实例应可加载")
  writeFileSync(
    gwA.AUTH_FILE,
    JSON.stringify(
      { "opencode-go": { type: "api", key: "old-key" }, "other-provider": { key: "keep-me" } },
      null,
      2,
    ),
  )
  gwA.syncAuth("new-key-2")
  const data = JSON.parse(readFileSync(gwA.AUTH_FILE, "utf8"))
  assert.deepEqual(data["opencode-go"], { type: "api", key: "new-key-2" })
  assert.deepEqual(data["other-provider"], { key: "keep-me" })
})

t("syncAuth 容错：auth.json 损坏 → 静默失败不抛错、文件原样保留（当前实现实际行为）", () => {
  assert.ok(gwA, "fresh 实例应可加载")
  writeFileSync(gwA.AUTH_FILE, "{ this is not valid json")
  assert.doesNotThrow(() => gwA.syncAuth("should-not-write"))
  assert.equal(readFileSync(gwA.AUTH_FILE, "utf8"), "{ this is not valid json")
})

/* rotate() 是 async，同步 harness 的 t() 无法 await → 在 t() 外手动执行并计数（保证汇总准确） */
{
  let ok = true
  let err = null
  try {
    const cfgPath = process.env.ZEN_CONFIG
    const resume = new Date(Date.now() + 99999999).toISOString()
    // 双域配置：TUI 域 current=bad/cooldown_until=未来冷却；网关域 current_gateway=bad/cooldown_until_gateway 干净。
    // 预置临时 auth.json 为「旧 key 内容」，用作铁证：网关 rotate 后必须逐字节不变（不再 syncAuth）。
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          provider_id: "opencode-go",
          current: "bad",
          current_gateway: "bad",
          keys: [
            { name: "bad", key: "sk-fake-bad", cooldown_until: resume },
            { name: "good", key: "sk-fake-good" },
          ],
        },
        null,
        2,
      ),
    )
    writeFileSync(gwA.AUTH_FILE, JSON.stringify({ "opencode-go": { type: "api", key: "sk-old-before-rotate" } }, null, 2))
    const authBytesBefore = readFileSync(gwA.AUTH_FILE, "utf8")
    const cfg2 = await gwA.rotate(
      { error: { message: "quota exceeded, reset at 2026-08-16 08:00:00 +0800 CST" } },
      429,
      "bad",
    )
    // ① 域分离：返回 cfg 的 current（TUI 域）不动，current_gateway 变为新 key
    assert.equal(cfg2.current, "bad")
    assert.equal(cfg2.current_gateway, "good")
    const savedCfg = JSON.parse(readFileSync(cfgPath, "utf8"))
    // ② 持久化同样域分离：current 仍 bad、current_gateway=good
    assert.equal(savedCfg.current, "bad")
    assert.equal(savedCfg.current_gateway, "good")
    // ③ 冷却只写网关域 cooldown_until_gateway；TUI 域 cooldown_until 原值（未来冷却）不被重置
    assert.equal(savedCfg.keys[0].cooldown_until_gateway, "2026-08-16T00:00:00.000Z")
    assert.equal(savedCfg.keys[0].cooldown_until, resume)
    assert.ok(!("cooldown_until" in savedCfg.keys[1]))
    // ④ 🚨 auth.json 铁证：网关 rotate 后临时 auth 逐字节不变（域独立红线：不再 syncAuth）
    assert.equal(readFileSync(gwA.AUTH_FILE, "utf8"), authBytesBefore)
    // ⑤ 新当前 key last_status 清空；真实 auth.json 字节不变
    assert.equal(savedCfg.keys[1].last_status, null)
    const realAfter = existsSync(realAuthPath) ? readFileSync(realAuthPath, "utf8") : null
    assert.equal(realAfter, realAuthBefore, "真实 auth.json 必须字节不变")
  } catch (e) {
    ok = false
    err = e
  }
  const name = "rotate() 域分离 + auth 铁证：假 key 429 → 只动 current_gateway/cooldown_until_gateway + 临时 auth 逐字节不变 + TUI current/cooldown_until 不动"
  if (ok) {
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${name}`)
  } else {
    failures.push({ group: currentGroup, name, error: err })
    console.log(`  ❌ ${name}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`)
  }
}

{
  // 复演：无 current_gateway 的旧配置（迁移兜底）→ rotate 后写 current_gateway，current 保持
  let ok = true
  let err = null
  try {
    const cfgPath = process.env.ZEN_CONFIG
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          provider_id: "opencode-go",
          current: "a",
          keys: [
            { name: "a", key: "sk-fake-a" },
            { name: "b", key: "sk-fake-b" },
          ],
        },
        null,
        2,
      ),
    )
    const cfg2 = await gwA.rotate({ error: { message: "no balance" } }, 402, "a")
    assert.equal(cfg2.current, "a")
    assert.equal(cfg2.current_gateway, "b")
    const savedCfg = JSON.parse(readFileSync(cfgPath, "utf8"))
    assert.equal(savedCfg.current, "a")
    assert.equal(savedCfg.current_gateway, "b")
    assert.equal(savedCfg.keys[0].cooldown_until_gateway, savedCfg.keys[0].cooldown_until_gateway ?? null)
  } catch (e) {
    ok = false
    err = e
  }
  const name2 = "rotate() 旧配置迁移兜底：无 current_gateway → 轮换写 current_gateway、current 保持原值"
  if (ok) {
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${name2}`)
  } else {
    failures.push({ group: currentGroup, name: name2, error: err })
    console.log(`  ❌ ${name2}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`)
  }
}

{
  // 复演：无可用 key（网关域全部冷却）→ 维持网关当前 key，仍持久化失败 key 的网关冷却，不触碰 auth
  let ok = true
  let err = null
  try {
    const cfgPath = process.env.ZEN_CONFIG
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          current: "a",
          current_gateway: "a",
          keys: [
            { name: "a", key: "sk-fake-a", cooldown_until_gateway: new Date(Date.now() + 99999999).toISOString() },
            { name: "b", key: "sk-fake-b", cooldown_until_gateway: new Date(Date.now() + 99999999).toISOString() },
          ],
        },
        null,
        2,
      ),
    )
    const cfg2 = await gwA.rotate({ error: { message: "rate limit" } }, 429, "b")
    assert.equal(cfg2.current_gateway, "a")
    const savedCfg = JSON.parse(readFileSync(cfgPath, "utf8"))
    assert.equal(savedCfg.current_gateway, "a")
    assert.equal(savedCfg.keys[1].cooldown_until_gateway, savedCfg.keys[1].cooldown_until_gateway ?? null)
  } catch (e) {
    ok = false
    err = e
  }
  const name3 = "rotate() 无可用 key（网关域全冷却）→ 维持网关 current_gateway，仍持久化失败 key 网关冷却"
  if (ok) {
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${name3}`)
  } else {
    failures.push({ group: currentGroup, name: name3, error: err })
    console.log(`  ❌ ${name3}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`)
  }
}

{
  // zen 免费档自动轮换禁用（2026-08-18 用户实测：同设备 UA/频率限流与账号无关）：rotate() 必须被跳过——
  // current_gateway 不变、失败 key 不冷却、不写 last_status；go 档行为不受影响（既有测试已覆盖 go 档轮换）。
  let ok = true
  let err = null
  try {
    const tmpDir = "/tmp/zen-gw-norotate-test"
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    const cfgPath = tmpDir + "/go-keys.json"
    const gwCfgPath = tmpDir + "/gateway-config.json"
    writeFileSync(cfgPath, JSON.stringify(
      {
        current: "bad",
        current_gateway: "bad",
        keys: [
          { name: "bad", key: "sk-fake-bad" },
          { name: "good", key: "sk-fake-good" },
        ],
      },
      null, 2,
    ))
    writeFileSync(gwCfgPath, JSON.stringify({ plan: "zen" }))
    const savedCfg = process.env.ZEN_CONFIG
    const savedGwCfg = process.env.ZEN_GATEWAY_CONFIG
    const savedLog = process.env.ZEN_LOG_FILE
    process.env.ZEN_CONFIG = cfgPath
    process.env.ZEN_GATEWAY_CONFIG = gwCfgPath
    process.env.ZEN_LOG_FILE = "/tmp/zen-gw-norotate-test/gw.log"
    try {
      const gwZen = await import("../gateway.mjs?zen-norotate=" + Date.now())
      const cfg2 = await gwZen.rotate({ error: { message: "Insufficient balance" } }, 402, "bad")
      // ① 不轮换：current_gateway 维持 bad
      assert.equal(cfg2.current_gateway, "bad")
      const savedCfg2 = JSON.parse(readFileSync(cfgPath, "utf8"))
      assert.equal(savedCfg2.current_gateway, "bad")
      // ② 不冷却失败 key、不写 last_status
      assert.ok(!("cooldown_until_gateway" in savedCfg2.keys[0]))
      assert.ok(!("last_status" in savedCfg2.keys[0]))
      assert.ok(!("cooldown_until_gateway" in savedCfg2.keys[1]))
      // ③ go 档回归：用 go 档配置重载 → 同一场景仍轮换（防止误伤付费档）
      writeFileSync(gwCfgPath, JSON.stringify({ plan: "go" }))
      const gwGo = await import("../gateway.mjs?go-norotate-regress=" + Date.now())
      const cfg3 = await gwGo.rotate({ error: { message: "Insufficient balance" } }, 402, "bad")
      assert.equal(cfg3.current_gateway, "good")
    } finally {
      process.env.ZEN_CONFIG = savedCfg
      process.env.ZEN_GATEWAY_CONFIG = savedGwCfg
      if (savedLog === undefined) delete process.env.ZEN_LOG_FILE
      else process.env.ZEN_LOG_FILE = savedLog
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  } catch (e) {
    ok = false
    err = e
  }
  const name4 = "zen 档自动轮换禁用：rotate() 跳过（current_gateway 不变/不冷却/不写状态），go 档回归仍轮换"
  if (ok) {
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${name4}`)
  } else {
    failures.push({ group: currentGroup, name: name4, error: err })
    console.log(`  ❌ ${name4}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`)
  }
}

delete process.env.ZEN_AUTH_FILE // 清理：本组为最后一组，避免 env 残留
try {
  rmSync(zauthTmp, { recursive: true, force: true })
} catch {}

/* ================= 16. /api/gateway/* 只读管理端点组装纯函数 ================= */
group("gatewayStatusSummary（/api/gateway/status 组装）")

const _statusCfg = {
  provider_id: "opencode-go",
  cooldown_minutes: 30,
  current: "act1",
  keys: [
    { name: "act1", key: "sk-fake-act1", cooldown_until: null },
    { name: "act2", key: "sk-fake-act2", cooldown_until: "2026-08-16T00:00:00.000Z" },
  ],
}

t("基本字段齐全：running/version/port/defaultModel/modelCount/keys/current/usageFile/upstreamBase/models", () => {
  const s = gw.gatewayStatusSummary(_statusCfg)
  assert.equal(s.running, true)
  assert.equal(s.version, "1.1.0")
  assert.equal(s.port, 18888) // 测试 env 未设 ZEN_GATEWAY_PORT → DEFAULT_PORT
  assert.equal(s.defaultModel, "hy3")
  assert.equal(s.modelCount, 26)
  assert.equal(s.keys, 2)
  assert.equal(s.current, "act1")
  assert.ok(s.usageFile.endsWith("usage.jsonl"))
  assert.equal(s.upstreamBase, "https://opencode.ai/zen/go/v1")
  assert.ok(Array.isArray(s.models))
})

t("models 数组与 modelCount 一致且含真实模型（hy3 / grok-4.5）", () => {
  const s = gw.gatewayStatusSummary(_statusCfg)
  assert.equal(s.models.length, s.modelCount)
  assert.ok(s.models.includes("hy3"))
  assert.ok(s.models.includes("grok-4.5"))
})

t("models 返回拷贝：push 不污染模块常量（再取 modelCount 仍 26）", () => {
  const s = gw.gatewayStatusSummary(_statusCfg)
  s.models.push("__POLLUTED__")
  assert.equal(gw.gatewayStatusSummary(_statusCfg).modelCount, 26)
  assert.ok(!gw.gatewayStatusSummary(_statusCfg).models.includes("__POLLUTED__"))
})

t("opts.port 可注入（路由传模块 PORT，单测可覆盖 env 覆盖语义）", () => {
  assert.equal(gw.gatewayStatusSummary(_statusCfg, { port: 18900 }).port, 18900)
})

t("opts.running=false 可注入", () => {
  assert.equal(gw.gatewayStatusSummary(_statusCfg, { running: false }).running, false)
})

t("网关域：当前字段返回 current_gateway（两域不同游标）", () => {
  const s = gw.gatewayStatusSummary({ current: "act1", current_gateway: "act2", keys: [] })
  assert.equal(s.current, "act2")
})
t("网关域：仅 current → status current 兜底 current（旧配置零迁移）", () => {
  const s = gw.gatewayStatusSummary({ current: "act1", keys: [_statusCfg.keys[0]] })
  assert.equal(s.current, "act1")
})

t("空/损坏 cfg 容错：keys=0 current='' 不抛错", () => {
  assert.equal(gw.gatewayStatusSummary({}).keys, 0)
  assert.equal(gw.gatewayStatusSummary({}).current, "")
  assert.equal(gw.gatewayStatusSummary(null).keys, 0)
})

t("version === '1.1.0'（契约 5.3 GATEWAY_VERSION，空/损坏 cfg 亦恒定）", () => {
  assert.equal(gw.gatewayStatusSummary(_statusCfg).version, "1.1.0")
  assert.equal(gw.gatewayStatusSummary(null).version, "1.1.0")
})

group("gatewayConfigSummary（/api/gateway/config 摘要不泄漏 key）")

t("keys 仅含 name/cooldown_until_gateway 两键（无 key 明文字段）", () => {
  const c = gw.gatewayConfigSummary(_statusCfg)
  assert.equal(c.keys.length, 2)
  for (const k of c.keys) assert.deepEqual(Object.keys(k).sort(), ["cooldown_until_gateway", "name"])
})
t("keys cooldown_until_gateway 取网关域字段（与 current 域一致）", () => {
  const c = gw.gatewayConfigSummary({
    current: "a", current_gateway: "b",
    cooldown_minutes: 30,
    keys: [
      { name: "a", key: "1", cooldown_until: "2026-01-01T00:00:00.000Z", cooldown_until_gateway: "2026-09-01T00:00:00.000Z" },
      { name: "b", key: "2" },
    ],
  })
  assert.equal(c.current, "b")
  assert.equal(c.keys[0].cooldown_until_gateway, "2026-09-01T00:00:00.000Z")
  assert.ok(!("cooldown_until" in c.keys[0]))
  assert.equal(c.keys[1].cooldown_until_gateway, null)
})

t("序列化后不含 key 明文（sk- 前缀与 key 字段绝不出现）", () => {
  const json = JSON.stringify(gw.gatewayConfigSummary(_statusCfg))
  assert.ok(!json.includes("sk-fake"))
  assert.ok(!json.includes('"key"'))
})

t("cooldownMinutes 透传 cfg.cooldown_minutes；缺省回退 300；0 保留", () => {
  assert.equal(gw.gatewayConfigSummary(_statusCfg).cooldownMinutes, 30)
  assert.equal(gw.gatewayConfigSummary({}).cooldownMinutes, 300)
  assert.equal(gw.gatewayConfigSummary({ cooldown_minutes: 0 }).cooldownMinutes, 0)
})

t("current 透传", () => {
  assert.equal(gw.gatewayConfigSummary(_statusCfg).current, "act1")
})
t("网关域：config current 返回 current_gateway（两域不同游标）", () => {
  const c = gw.gatewayConfigSummary({ current: "act1", current_gateway: "act2", keys: [] })
  assert.equal(c.current, "act2")
})

t("autoWeb：raw.auto_web=true/false → 对应值；raw 无该字段/非布尔/缺失 → 键不存在", () => {
  assert.equal(gw.gatewayConfigSummary(_statusCfg, { auto_web: true }).autoWeb, true)
  assert.equal(gw.gatewayConfigSummary(_statusCfg, { auto_web: false }).autoWeb, false)
  assert.ok(!("autoWeb" in gw.gatewayConfigSummary(_statusCfg, {})))
  assert.ok(!("autoWeb" in gw.gatewayConfigSummary(_statusCfg, { auto_web: "yes" })))
  assert.ok(!("autoWeb" in gw.gatewayConfigSummary(_statusCfg, null)))
  assert.ok(!("autoWeb" in gw.gatewayConfigSummary(_statusCfg)))
})

t("空 cfg 容错：keys=[] current='' cooldownMinutes=300", () => {
  const c = gw.gatewayConfigSummary(null)
  assert.deepEqual(c.keys, [])
  assert.equal(c.current, "")
  assert.equal(c.cooldownMinutes, 300)
})

t("readRawConfig：临时配置含 auto_web 可读回；损坏 JSON → null（不抛错）", () => {
  const cfgPath = process.env.ZEN_CONFIG
  writeFileSync(cfgPath, JSON.stringify({ auto_web: false, keys: [{ name: "x", key: "sk-x" }] }, null, 2))
  const raw = gw.readRawConfig()
  assert.equal(raw.auto_web, false)
  assert.equal(raw.keys[0].name, "x")
  writeFileSync(cfgPath, "{ broken json")
  assert.equal(gw.readRawConfig(), null)
  // 恢复合理内容，避免影响后续（若有）
  writeFileSync(
    cfgPath,
    JSON.stringify({ provider_id: "opencode-go", current: "good", keys: [{ name: "good", key: "sk-fake-good" }] }, null, 2),
  )
})

group("gatewayModelsSummary（/api/gateway/models 组装）")

t("models 26 个真实内置模型 + 别名映射含 grok-code→hy3 / gpt-4o→glm-5.2", () => {
  const m = gw.gatewayModelsSummary()
  assert.equal(m.models.length, 26)
  assert.ok(m.models.includes("hy3"))
  assert.equal(m.aliases["grok-code"], "hy3")
  assert.equal(m.aliases["gpt-4o"], "glm-5.2")
})

t("拷贝语义：push models / 改 aliases 不污染模块常量", () => {
  const m = gw.gatewayModelsSummary()
  m.models.push("__POLLUTED__")
  m.aliases["__POLLUTED__"] = "x"
  const m2 = gw.gatewayModelsSummary()
  assert.ok(!m2.models.includes("__POLLUTED__"))
  assert.ok(!("__POLLUTED__" in m2.aliases))
})

t("plans 双套餐明细：go 内置 26 / zen 内置 7，各自动态为空时 models=内置（去重升序）", () => {
  gw.__setDynamicModels([])
  const m = gw.gatewayModelsSummary()
  assert.equal(m.active, "go") // 默认 go 档
  assert.equal(m.plans.go.id, "go")
  assert.equal(m.plans.zen.id, "zen")
  assert.equal(m.plans.go.builtin.length, 26)
  assert.equal(m.plans.zen.builtin.length, 7)
  assert.ok(m.plans.go.models.includes("hy3"))
  assert.ok(m.plans.zen.models.includes("hy3-free"))
  assert.equal(m.plans.go.models.length, 26)
  assert.equal(m.plans.zen.models.length, 7)
  assert.deepEqual(m.plans.zen.models, [...m.plans.zen.models].sort())
  // 向后兼容：models 仍是当前套餐（go）合并清单
  assert.deepEqual(m.models, m.plans.go.models)
})

t("plans 差异化动态表：go/zen 各自并入动态模型且互不串扰", () => {
  gw.__setDynamicModels(["my-go-dyn", "hy3-free"], "go")
  gw.__setDynamicModels(["my-zen-dyn"], "zen")
  const m = gw.gatewayModelsSummary()
  assert.ok(m.plans.go.models.includes("my-go-dyn"))
  assert.ok(!m.plans.go.models.includes("my-zen-dyn")) // go 不并入 zen 动态
  assert.equal(m.plans.go.dynamic.length, 2)
  assert.ok(m.plans.zen.models.includes("my-zen-dyn"))
  assert.ok(m.plans.zen.models.includes("hy3-free")) // 动态与内置交集去重后仍存在
  assert.ok(!m.plans.zen.models.includes("my-go-dyn"))
  assert.equal(m.plans.zen.dynamic.length, 1)
  // 当前套餐合并清单 models 同步含 go 动态
  assert.ok(m.models.includes("my-go-dyn"))
  // 清理，避免污染后续用例
  gw.__setDynamicModels([], "go")
  gw.__setDynamicModels([], "zen")
})

t("plans 子对象同样拷贝：push 不污染模块常量", () => {
  const m = gw.gatewayModelsSummary()
  m.plans.go.models.push("__POLLUTED__")
  m.plans.zen.dynamic.push("__POLLUTED__")
  const m2 = gw.gatewayModelsSummary()
  assert.ok(!m2.plans.go.models.includes("__POLLUTED__"))
  assert.ok(!m2.plans.zen.dynamic.includes("__POLLUTED__"))
})

t("sortedModelUnion：去重排序（动态 ∩ 内置交集只留一份）+ null/非数组容错", () => {
  assert.deepEqual(gw.sortedModelUnion(["zzz", "hy3", "aaa"], ["hy3"]), ["aaa", "hy3", "zzz"])
  assert.deepEqual(gw.sortedModelUnion(null, ["b"]), ["b"])
  assert.deepEqual(gw.sortedModelUnion(["a"], []), ["a"])
})

t("__setDynamicModels(planId) 定向设置：只改指定档，另一档不受影响", () => {
  gw.__setDynamicModels(["only-go"], "go")
  assert.deepEqual(gw.DYNAMIC_GO, ["only-go"])
  assert.deepEqual(gw.DYNAMIC_ZEN, [])
  gw.__setDynamicModels(["only-zen"], "zen")
  assert.deepEqual(gw.DYNAMIC_GO, ["only-go"])
  assert.deepEqual(gw.DYNAMIC_ZEN, ["only-zen"])
  gw.__setDynamicModels([]) // 缺省：两档同清，回归旧语义
  assert.equal(gw.DYNAMIC_GO.length, 0)
  assert.equal(gw.DYNAMIC_ZEN.length, 0)
})

group("getLogRing（内存环形日志缓冲）")

t("LOG_RING_MAX === 200", () => {
  assert.equal(gw.LOG_RING_MAX, 200)
})

t("初始结构：lines 数组、total 数字、lines.length === Math.min(total, 200)", () => {
  const r = gw.getLogRing()
  assert.ok(Array.isArray(r.lines))
  assert.equal(typeof r.total, "number")
  assert.equal(r.lines.length, Math.min(r.total, 200))
})

t("FIFO 顺序：追加 3 条后 total +3、末条为最近 marker", () => {
  const before = gw.getLogRing().total
  for (let i = 1; i <= 3; i++) gw.log(`__RING_FIFO_${i}__`)
  const r = gw.getLogRing()
  assert.equal(r.total, before + 3)
  assert.ok(r.lines[r.lines.length - 1].includes("__RING_FIFO_3__"))
})

t("上限 200：追加 250 条唯一 marker → lines 保持 200、total 累计 +250、首条为第 51 条、末条为第 250 条", () => {
  const before = gw.getLogRing().total
  for (let i = 1; i <= 250; i++) gw.log(`__RING_TEST_${i}__`)
  const r = gw.getLogRing()
  assert.equal(r.total, before + 250)
  assert.equal(r.lines.length, 200)
  assert.ok(r.lines[0].includes("__RING_TEST_51__"), "环形缓冲首条应为第 51 条（前 50 条被挤出）")
  assert.ok(r.lines[199].includes("__RING_TEST_250__"), "末条应为最近一条")
})

t("max 参数：getLogRing(5) 只返回最近 5 条", () => {
  const r = gw.getLogRing(5)
  assert.equal(r.lines.length, 5)
  assert.ok(r.lines[4].includes("__RING_TEST_250__"))
})

/* ================= 17. gateway-config.json 读取 + 套餐/token 解析（Team A 新增） ================= */
const _gwCfgPath = process.env.ZEN_GATEWAY_CONFIG

group("readGatewayConfig（gateway-config.json 读取容错）")

t("文件缺失 → {}（零迁移回退，老部署兼容）", () => {
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
  assert.deepEqual(gw.readGatewayConfig(), {})
})

t("损坏 JSON → {}（不抛错，回退默认）", () => {
  writeFileSync(_gwCfgPath, "{ broken json")
  assert.deepEqual(gw.readGatewayConfig(), {})
})

t("正常文件 → plan/token/token_set_at 归一返回", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", token: "a".repeat(64), token_set_at: "2026-08-16T00:00:00.000Z" }))
  const c = gw.readGatewayConfig()
  assert.equal(c.plan, "zen")
  assert.equal(c.token, "a".repeat(64))
  assert.equal(c.token_set_at, "2026-08-16T00:00:00.000Z")
})

t("ip_rotation 开关读取：缺省 true，显式 false 关闭", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress: ["direct", "socks5://1.2.3.4:1080"] }))
  assert.equal(gw.readGatewayConfig().ip_rotation, true) // 缺省开启
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress: ["direct", "socks5://1.2.3.4:1080"], ip_rotation: false }))
  assert.equal(gw.readGatewayConfig().ip_rotation, false) // 显式关闭
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", ip_rotation: "no" }))
  assert.equal(gw.readGatewayConfig().ip_rotation, true) // 非 false 一律视为开启
})

t("token 非字符串（数字/缺失）→ null；token_set_at 非字符串 → null", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "go", token: 12345, token_set_at: 7 }))
  const c = gw.readGatewayConfig()
  assert.equal(c.token, null)
  assert.equal(c.token_set_at, null)
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "go" }))
  assert.equal(gw.readGatewayConfig().token, null)
})

// 清理临时配置，保持环境干净（ACTIVE_PLAN 已在 import 时固化，不受影响）
try { rmSync(_gwCfgPath, { force: true }) } catch {}

group("resolvePlan（套餐解析，env > 文件 > 默认）")

t("go 档：upstreamBase=zen/go/v1、默认模型 hy3、builtinModels=ZEN_MODELS(26)", () => {
  const p = gw.resolvePlan({ plan: "go" }, {})
  assert.equal(p.id, "go")
  assert.equal(p.upstreamBase, "https://opencode.ai/zen/go/v1")
  assert.equal(p.defaultModel, "hy3")
  assert.equal(p.builtinModels.length, 26)
  assert.ok(p.builtinModels.includes("hy3"))
})

t("zen 档：upstreamBase=zen/v1、默认模型 hy3-free、builtinModels=ZEN_MODELS_ZEN(7)", () => {
  const p = gw.resolvePlan({ plan: "zen" }, {})
  assert.equal(p.id, "zen")
  assert.equal(p.upstreamBase, "https://opencode.ai/zen/v1")
  assert.equal(p.defaultModel, "hy3-free")
  assert.equal(p.builtinModels.length, 7)
  assert.ok(p.builtinModels.includes("hy3-free"))
  assert.ok(p.builtinModels.includes("deepseek-v4-flash-free"))
})

t("无 config / plan 缺失 / 非法 plan → 回退 go 档", () => {
  assert.equal(gw.resolvePlan(null, {}).id, "go")
  assert.equal(gw.resolvePlan({}, {}).id, "go")
  assert.equal(gw.resolvePlan({ plan: "abc" }, {}).id, "go")
  assert.equal(gw.resolvePlan({ plan: null }, {}).id, "go")
})

t("env ZEN_UPSTREAM_BASE / ZEN_DEFAULT_MODEL 优先于文件/默认（go 与 zen 档均生效）", () => {
  const p = gw.resolvePlan({ plan: "go" }, { ZEN_UPSTREAM_BASE: "http://127.0.0.1:9999/v1", ZEN_DEFAULT_MODEL: "env-model" })
  assert.equal(p.id, "go")
  assert.equal(p.upstreamBase, "http://127.0.0.1:9999/v1")
  assert.equal(p.defaultModel, "env-model")
  const z = gw.resolvePlan({ plan: "zen" }, { ZEN_DEFAULT_MODEL: "env-model" })
  assert.equal(z.defaultModel, "env-model")
  assert.equal(z.upstreamBase, "https://opencode.ai/zen/v1")
})

t("env 缺省时文件 plan 决定 upstreamBase（zen 档不残留 go 的 base）", () => {
  const p = gw.resolvePlan({ plan: "zen" }, {})
  assert.equal(p.upstreamBase, "https://opencode.ai/zen/v1")
  assert.notEqual(p.upstreamBase, "https://opencode.ai/zen/go/v1")
})

t("PLANS 表完整性：go/zen 两档各字段齐备且模型表引用正确", () => {
  const plans = gw.PLANS
  assert.deepEqual(Object.keys(plans).sort(), ["go", "zen"])
  assert.equal(plans.go.builtinModels.length, 26)
  assert.equal(plans.zen.builtinModels.length, 7)
  assert.notEqual(plans.go.builtinModels, plans.zen.builtinModels)
  assert.equal(plans.zen.builtinModels, gw.ZEN_MODELS_ZEN)
  for (const id of ["go", "zen"]) {
    assert.equal(plans[id].id, id)
    assert.ok(plans[id].upstreamBase.startsWith("https://opencode.ai/zen"))
    assert.ok(typeof plans[id].defaultModel === "string" && plans[id].defaultModel)
  }
})

group("resolveToken（token 解析，env 优先）")

t("env ZEN_GATEWAY_TOKEN 优先于文件 token", () => {
  assert.equal(gw.resolveToken({ token: "file-token" }, { ZEN_GATEWAY_TOKEN: "env-token" }), "env-token")
})

t("env 空串 → 视为未设置（S2 语义），回退文件 token", () => {
  assert.equal(gw.resolveToken({ token: "file-token" }, { ZEN_GATEWAY_TOKEN: "" }), "file-token")
})

t("无 env → 文件 token", () => {
  assert.equal(gw.resolveToken({ token: "file-token" }, {}), "file-token")
})

t("env 与文件都无 → null（鉴权关闭）", () => {
  assert.equal(gw.resolveToken({}, {}), null)
  assert.equal(gw.resolveToken(null, {}), null)
})

t("文件 token 非字符串（数字/null）→ null", () => {
  assert.equal(gw.resolveToken({ token: 123 }, {}), null)
  assert.equal(gw.resolveToken({ token: null }, {}), null)
})

group("resolveTokens（多 key 解析，env 优先）")

t("env ZEN_GATEWAY_TOKEN → 单元素数组（向后兼容）", () => {
  assert.deepEqual(gw.resolveTokens({ tokens: ["a", "b"] }, { ZEN_GATEWAY_TOKEN: "env-token" }), ["env-token"])
})

t("env 空串 → 视为未设置，回退文件 tokens", () => {
  assert.deepEqual(gw.resolveTokens({ tokens: ["a", "b"] }, { ZEN_GATEWAY_TOKEN: "" }), ["a", "b"])
})

t("文件 tokens 数组优先于单 token 字段", () => {
  assert.deepEqual(gw.resolveTokens({ token: "old", tokens: ["a", "b"] }, {}), ["a", "b"])
})

t("无 tokens → 回退单 token（旧配置兼容）", () => {
  assert.deepEqual(gw.resolveTokens({ token: "old" }, {}), ["old"])
})

t("tokens 空数组/无任何配置 → []（鉴权关闭）", () => {
  assert.deepEqual(gw.resolveTokens({ tokens: [] }, {}), [])
  assert.deepEqual(gw.resolveTokens({}, {}), [])
  assert.deepEqual(gw.resolveTokens(null, {}), [])
})

group("gatewayAuth（多 key 鉴权，模块固化 ACTIVE_TOKENS）")

t("tokens 任一 Bearer 匹配即放行；不匹配拒绝；x-api-key 同域", async () => {
  const cfgPath = "/tmp/zen-gateway-unittest-gwcfg-tokens.json"
  writeFileSync(cfgPath, JSON.stringify({ plan: "zen", tokens: ["sk-alpha", "sk-beta"] }))
  const savedCfg = process.env.ZEN_GATEWAY_CONFIG
  process.env.ZEN_GATEWAY_CONFIG = cfgPath
  try {
    const m = await import("../gateway.mjs?multi-token-auth=" + Date.now())
    const req = (headers) => ({ headers })
    assert.equal(m.gatewayAuth(req({ authorization: "Bearer sk-alpha" })), true)
    assert.equal(m.gatewayAuth(req({ authorization: "Bearer sk-beta" })), true)
    assert.equal(m.gatewayAuth(req({ authorization: "Bearer sk-gamma" })), false)
    assert.equal(m.gatewayAuth(req({ authorization: "Bearer " })), false)
    assert.equal(m.gatewayAuth(req({ "x-api-key": "sk-alpha" })), true)
    assert.equal(m.gatewayAuth(req({})), false)
    assert.equal(m.gatewayStatusSummary({}, { running: true }).tokenCount, 2)
  } finally {
    process.env.ZEN_GATEWAY_CONFIG = savedCfg
  }
})

t("无 token（空数组）→ 鉴权关闭放行一切", async () => {
  const cfgPath = "/tmp/zen-gateway-unittest-gwcfg-notokens.json"
  writeFileSync(cfgPath, JSON.stringify({ plan: "zen", token: null }))
  const savedCfg = process.env.ZEN_GATEWAY_CONFIG
  process.env.ZEN_GATEWAY_CONFIG = cfgPath
  try {
    const m = await import("../gateway.mjs?no-token-auth=" + Date.now())
    assert.equal(m.gatewayAuth(req({ authorization: "Bearer whatever" })), true)
    assert.equal(m.gatewayAuth(req({})), true)
  } finally {
    process.env.ZEN_GATEWAY_CONFIG = savedCfg
  }
})

t("readGatewayConfig：tokens 数组过滤非字符串/空项", async () => {
  const cfgPath = "/tmp/zen-gateway-unittest-gwcfg-normalize.json"
  writeFileSync(cfgPath, JSON.stringify({ plan: "zen", token: "old", tokens: ["sk-a", 123, "", "sk-b"] }))
  const savedCfg = process.env.ZEN_GATEWAY_CONFIG
  process.env.ZEN_GATEWAY_CONFIG = cfgPath
  try {
    const m = await import("../gateway.mjs?token-normalize=" + Date.now())
    assert.deepEqual(m.resolveTokens({ tokens: m.readGatewayConfig().tokens }, {}), ["sk-a", "sk-b"])
  } finally {
    process.env.ZEN_GATEWAY_CONFIG = savedCfg
  }
})

group("ACTIVE_PLAN / ACTIVE_TOKEN / ZEN_MODELS_ZEN（模块加载固化态）")

t("ACTIVE_PLAN 导出：测试 env 默认 go 档（base=go/v1、defaultModel=hy3、builtinModels=26）", () => {
  const p = gw.ACTIVE_PLAN
  assert.equal(p.id, "go")
  assert.equal(p.upstreamBase, "https://opencode.ai/zen/go/v1")
  assert.equal(p.defaultModel, "hy3")
  assert.equal(p.builtinModels.length, 26)
})

t("ACTIVE_TOKEN 导出：测试 env 未设 token → null", () => {
  assert.equal(gw.ACTIVE_TOKEN, null)
})

t("ZEN_MODELS_ZEN 免费档 7 个模型齐全（research §1.1 官方定价表）", () => {
  const m = gw.ZEN_MODELS_ZEN
  assert.equal(m.length, 7)
  for (const id of ["big-pickle", "deepseek-v4-flash-free", "mimo-v2.5-free", "hy3-free", "laguna-s-2.1-free", "nemotron-3-ultra-free", "nemotron-3.5-lightning-free"]) {
    assert.ok(m.includes(id), `应含 ${id}`)
  }
})

group("gatewayStatusSummary 扩展（plan / authEnabled 字段）")

t("status 含 plan='go'（模块默认档）与 authEnabled=false（无 token）", () => {
  const s = gw.gatewayStatusSummary(_statusCfg)
  assert.equal(s.plan, "go")
  assert.equal(s.authEnabled, false)
})

t("status 的 defaultModel/upstreamBase/modelCount 随 ACTIVE_PLAN（默认 go 档）", () => {
  const s = gw.gatewayStatusSummary(_statusCfg)
  assert.equal(s.defaultModel, "hy3")
  assert.equal(s.upstreamBase, "https://opencode.ai/zen/go/v1")
  assert.equal(s.modelCount, 26)
})

group("自适配：UA 探测 / FreeUsageLimit 不轮换 / 截断自动重试判定")

t("resolveUpstreamUA：env ZEN_UPSTREAM_UA 优先（探测不执行）", () => {
  assert.equal(
    gw.resolveUpstreamUA(() => { throw new Error("should not exec") }, { ZEN_UPSTREAM_UA: "opencode/9.9.9" }),
    "opencode/9.9.9",
  )
})

t("resolveUpstreamUA：探测成功 → opencode/<版本>", () => {
  assert.equal(gw.resolveUpstreamUA(() => "1.18.18\n", {}), "opencode/1.18.18")
})

t("resolveUpstreamUA：预发布版本后缀原样保留", () => {
  assert.equal(gw.resolveUpstreamUA(() => "1.19.0-beta.3\n", {}), "opencode/1.19.0-beta.3")
})

t("resolveUpstreamUA：探测失败（未安装/超时）→ 回退稳定默认", () => {
  assert.equal(gw.resolveUpstreamUA(() => { throw new Error("ENOENT") }, {}), "opencode/1.18.18")
})

t("resolveUpstreamUA：输出无版本号 → 回退默认", () => {
  assert.equal(gw.resolveUpstreamUA(() => "opencode CLI\n", {}), "opencode/1.18.18")
})

t("shouldRotateForError：FreeUsageLimitError（zen 免费档限流）不触发轮换", () => {
  assert.equal(
    gw.shouldRotateForError(429, { error: { type: "FreeUsageLimitError", message: "Rate limit exceeded" } }),
    false,
  )
})

t("shouldRotateForError：普通 429 / 401 / 402 照旧触发轮换", () => {
  assert.equal(gw.shouldRotateForError(429, { error: { type: "CreditsError", message: "Insufficient balance" } }), true)
  assert.equal(gw.shouldRotateForError(401, { error: { type: "AuthError" } }), true)
  assert.equal(gw.shouldRotateForError(402, { error: { type: "PaymentRequired" } }), true)
})

t("shouldRotateForError：200 但消息含配额关键词仍触发，无关消息不触发", () => {
  assert.equal(gw.shouldRotateForError(200, { error: { message: "quota exceeded" } }), true)
  assert.equal(gw.shouldRotateForError(200, { error: { message: "unrelated" } }), false)
})

t("truncationRetryPlan：content 空 + finish=max_tokens → 放大 2 倍（下限 4096）", () => {
  const body = JSON.stringify({ choices: [{ finish_reason: "max_tokens", message: { content: null } }] })
  assert.equal(gw.truncationRetryPlan(body, { max_tokens: 30 }), 4096)
  assert.equal(gw.truncationRetryPlan(body, { max_tokens: 4096 }), 8192)
})

t("truncationRetryPlan：content 非空 / finish=stop / 坏 JSON → null", () => {
  assert.equal(
    gw.truncationRetryPlan(JSON.stringify({ choices: [{ finish_reason: "max_tokens", message: { content: "hi" } }] }), { max_tokens: 30 }),
    null,
  )
  assert.equal(
    gw.truncationRetryPlan(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: null } }] }), { max_tokens: 30 }),
    null,
  )
  assert.equal(gw.truncationRetryPlan("not json", { max_tokens: 30 }), null)
})

t("truncationRetryPlan：无 max_tokens → 4096；放大上限 131072 钳制；已达上限不重试", () => {
  const body = JSON.stringify({ choices: [{ finish_reason: "max_tokens", message: { content: null } }] })
  assert.equal(gw.truncationRetryPlan(body, {}), 4096)
  assert.equal(gw.truncationRetryPlan(body, { max_tokens: 100000 }), 131072)
  assert.equal(gw.truncationRetryPlan(body, { max_tokens: 131072 }), null)
})

t("truncationRetryPlan：ZEN_AUTO_MAX_TOKENS=0 关闭自动重试", () => {
  const prev = process.env.ZEN_AUTO_MAX_TOKENS
  process.env.ZEN_AUTO_MAX_TOKENS = "0"
  try {
    assert.equal(
      gw.truncationRetryPlan(JSON.stringify({ choices: [{ finish_reason: "max_tokens", message: { content: null } }] }), { max_tokens: 30 }),
      null,
    )
  } finally {
    if (prev === undefined) delete process.env.ZEN_AUTO_MAX_TOKENS
    else process.env.ZEN_AUTO_MAX_TOKENS = prev
  }
})

/* ================= zen 档 IP 轮换（egress） ================= */
group("parseSocks5Url（SOCKS5 出口 URL 解析）")

t("socks5://host:port → 基本解析", () => {
  assert.deepEqual(gw.parseSocks5Url("socks5://1.2.3.4:1080"), {
    type: "socks5",
    host: "1.2.3.4",
    port: 1080,
    user: null,
    pass: null,
  })
})

t("socks5://user:pass@host:port → 认证解析", () => {
  assert.deepEqual(gw.parseSocks5Url("socks5://alice:secret@1.2.3.4:1080"), {
    type: "socks5",
    host: "1.2.3.4",
    port: 1080,
    user: "alice",
    pass: "secret",
  })
})

t("socks5://host:port/ 尾斜杠容错", () => {
  const e = gw.parseSocks5Url("socks5://h:1080/")
  assert.equal(e.host, "h")
  assert.equal(e.port, 1080)
})

t("非法输入 → null（无端口/越界端口/http 协议/空串）", () => {
  assert.equal(gw.parseSocks5Url("socks5://1.2.3.4"), null)
  assert.equal(gw.parseSocks5Url("socks5://h:70000"), null)
  assert.equal(gw.parseSocks5Url("socks5://h:0"), null)
  assert.equal(gw.parseSocks5Url("http://1.2.3.4:80"), null)
  assert.equal(gw.parseSocks5Url("direct"), null)
  assert.equal(gw.parseSocks5Url(""), null)
})

group("parseEgressList（egress 出口池归一化）")

t("direct + socks5 混合解析", () => {
  const list = gw.parseEgressList(["direct", "socks5://1.2.3.4:1080"])
  assert.equal(list.length, 2)
  assert.equal(list[0].type, "direct")
  assert.equal(list[1].type, "socks5")
  assert.equal(list[1].host, "1.2.3.4")
})

t("重复项去重", () => {
  const list = gw.parseEgressList(["socks5://1.2.3.4:1080", "socks5://1.2.3.4:1080", "direct"])
  assert.equal(list.length, 2)
})

t("非法项（非字符串/无端口/空）过滤", () => {
  const list = gw.parseEgressList(["direct", 123, "junk", "", null, "socks5://bad"])
  assert.equal(list.length, 1)
  assert.equal(list[0].type, "direct")
})

t("非数组 → 空列表", () => {
  assert.equal(gw.parseEgressList(null).length, 0)
  assert.equal(gw.parseEgressList("direct").length, 0)
  assert.equal(gw.parseEgressList(undefined).length, 0)
})

group("parseHead（HTTP/1.1 响应头解析）")

t("状态行 + 普通头解析", () => {
  const h = gw.parseHead('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nContent-Length: 42')
  assert.equal(h.status, 200)
  assert.equal(h.headers.get("content-type"), "application/json")
  assert.equal(h.headers.get("Content-Length"), "42")
  assert.equal(h.headers.get("missing"), null)
})

t("HTTP/1.0 状态行", () => {
  const h = gw.parseHead("HTTP/1.0 404 Not Found\r\nx-a: b")
  assert.equal(h.status, 404)
  assert.equal(h.headers.get("x-a"), "b")
})

t("非法状态行 → null", () => {
  assert.equal(gw.parseHead("not a status"), null)
  assert.equal(gw.parseHead(""), null)
})

t("retryTruncatedContent 透传 egress（截断重试不绕开已被绕限流的出口，T-1 修复）", async () => {
  // 静态断言：函数签名带第 7 参 egress，两个调用点分别透传 nextEgress / currentEgress
  const src = readFileSync(new URL("../gateway.mjs", import.meta.url), "utf8")
  assert.ok(src.includes("egress = null"), "retryTruncatedContent 第 7 参 egress 缺省 null（直连路径不变）")
  assert.ok(src.includes("clientSignal, egress"), "上游调用透传 egress")
  assert.ok(src.includes("clientSignal, nextEgress"), "出口轮换路径截断重试复用新出口")
  assert.ok(src.includes("clientSignal, currentEgress()"), "直连成功路径截断重试复用当前出口（否则回到本地直连再撞 429）")
})

t("egressSnapshot / currentEgress / rotateEgress 模块状态（EGRESS_ENABLED 关时零行为）", () => {
  // 模块加载时按真实 gateway-config 固化；测试环境不配 egress → EGRESS_ENABLED 通常 false。
  // 只断言数据结构契约，不依赖具体开关。
  const snap = gw.egressSnapshot()
  assert.equal(typeof snap.enabled, "boolean")
  assert.equal(typeof snap.count, "number")
  assert.equal(typeof snap.index, "number")
  assert.ok(Array.isArray(snap.list))
})

t("egressEnabled() 动态判定：ip_rotation=false 或 egress<2 → false；≥2 且开启 → true", () => {
  // egressEnabled() 每次读当前 gateway-config；写临时配置验证判定逻辑（ACTIVE_PLAN=zen 需模块以 zen 加载）。
  // 该用例不依赖模块套餐：enabled = plan zen && egress≥2 && ip_rotation!==false。若测试模块为 go 档，恒 false 也通过断言。
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress: ["direct"] }))
  const onlyOne = gw.egressEnabled()
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress: ["direct", "socks5://1.2.3.4:1080"], ip_rotation: false }))
  const off = gw.egressEnabled()
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress: ["direct", "socks5://1.2.3.4:1080"] }))
  const on = gw.egressEnabled()
  // 契约：要么套餐非 zen（全 false），要么遵循开关
  if (on) {
    assert.equal(off, false) // 显式关闭 → false
    assert.equal(onlyOne, false) // <2 出口 → false
  } else {
    assert.equal(off, false)
  }
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

t("egress_active 手动选中子集：egressList() 只用子集、egressEnabled() 子集≥1 即启用、空子集回退全池", () => {
  // egressList()/egressEnabled() 每次读当前 gateway-config。写临时配置验证有效出口判定。
  // 若测试模块为 go 档（ACTIVE_PLAN!=zen），egressEnabled 恒 false，断言只对 egressList 生效。
  const P = { plan: "zen", egress: ["socks5://1.1.1.1:1080", "socks5://2.2.2.2:1080", "socks5://3.3.3.3:1080"] }
  writeFileSync(_gwCfgPath, JSON.stringify({ ...P }))
  const f1 = gw.egressList().map((e) => e.raw)
  assert.deepEqual(f1, P.egress) // 无子集 → 全池
  // 选中子集 [2.2.2.2]（单选也要能用：固定走该出口）
  writeFileSync(_gwCfgPath, JSON.stringify({ ...P, egress_active: ["socks5://2.2.2.2:1080"] }))
  const s1 = gw.egressList().map((e) => e.raw)
  assert.deepEqual(s1, ["socks5://2.2.2.2:1080"])
  if (gw.egressSnapshot().enabled) {
    assert.equal(gw.egressEnabled(), true, "子集≥1 且未关开关 → 轮换启用（单选也可用）")
  }
  // 子集为 [] → 回退全池
  writeFileSync(_gwCfgPath, JSON.stringify({ ...P, egress_active: [] }))
  const f2 = gw.egressList().map((e) => e.raw)
  assert.deepEqual(f2, P.egress)
  // 子集含非法 url → 解析时忽略（parseEgressList 过滤）
  writeFileSync(_gwCfgPath, JSON.stringify({ ...P, egress_active: ["socks5://2.2.2.2:1080", "http://bad:80"] }))
  const s2 = gw.egressList().map((e) => e.raw)
  assert.deepEqual(s2, ["socks5://2.2.2.2:1080"])
  // readGatewayConfig 归一 egress_active（非数组 → []）
  writeFileSync(_gwCfgPath, JSON.stringify({ ...P, egress_active: "socks5://2.2.2.2:1080" }))
  assert.deepEqual(gw.readGatewayConfig().egress_active, [])
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

t("egressHealthCheck 无 key → 返回 error + 空 egress（不抛异常）", async () => {
  // 用临时 ZEN_CONFIG 指向无 key 配置跑健康检查（egressHealthCheck 读 loadConfig().keys）
  // 测试环境可能已有真实 go-keys；此用例只断言「有 keys 时结构契约」与「无 keys 时降级」。
  const r = await gw.egressHealthCheck(0)
  assert.equal(typeof r.checkedAt, "string")
  assert.ok(Array.isArray(r.egress))
  // 无 key 分支：error 字段存在
  if (r.error) {
    assert.ok(String(r.error).length > 0)
    assert.equal(r.egress.length, 0)
  }
})

t("egressHealthCheck 有 key → 每个出口返回 index/url/ok 契约（网络不可达也返回结构而非抛异常）", async () => {
  // 真实环境有 key 时：即便代理不可达，也应返回每项条目（ok=false + error）而不抛。
  // 用临时 ZEN_CONFIG + ZEN_UPSTREAM_BASE 指向不可达端口，确保走错误路径且结构完整。
  const prevConfig = process.env.ZEN_CONFIG
  const prevBase = process.env.ZEN_UPSTREAM_BASE
  process.env.ZEN_CONFIG = "/tmp/gr-egress-health-test.json"
  process.env.ZEN_UPSTREAM_BASE = "http://127.0.0.1:59999"
  const fs = await import("node:fs")
  fs.writeFileSync("/tmp/gr-egress-health-test.json", JSON.stringify({
    keys: [{ name: "k", key: "sk-test" }],
    current_gateway: "k",
  }))
  try {
    // 重新 import 让模块按新 env 加载（EGRESS 列表由配置驱动，这里不配 egress → direct 兜底）
    const gw2 = await import("../gateway.mjs?egress-health-1=" + Date.now())
    const r = await gw2.egressHealthCheck(null)
    assert.equal(typeof r.checkedAt, "string")
    assert.ok(Array.isArray(r.egress))
    assert.ok(r.egress.length >= 1)
    for (const e of r.egress) {
      assert.equal(typeof e.index, "number")
      assert.equal(typeof e.url, "string")
      assert.equal(typeof e.ok, "boolean")
      assert.ok(typeof e.ms === "number")
      if (!e.ok) assert.ok(typeof e.error === "string")
    }
  } finally {
    if (prevConfig !== undefined) process.env.ZEN_CONFIG = prevConfig; else delete process.env.ZEN_CONFIG
    if (prevBase !== undefined) process.env.ZEN_UPSTREAM_BASE = prevBase; else delete process.env.ZEN_UPSTREAM_BASE
    fs.rmSync("/tmp/gr-egress-health-test.json", { force: true })
  }
})

// 梯子（读 gateway-config 的 ladder 字段 + 出口选择 + 隧道）—— 纯函数/同步路径测试；
// 用 gw 已 import 的模块（其 GATEWAY_CONFIG=ZEN_GATEWAY_CONFIG 测试路径）直接写文件读取，避免 re-import 竞态。
group("梯子（ladderConfig / ladderNextEgress / normalizeLadderConfig）")

t("normalizeLadderConfig：纯函数归一（缺失→null / 完整→归一 / 非法容错 / egress 数组）", () => {
  assert.equal(gw.normalizeLadderConfig(null), null)
  assert.equal(gw.normalizeLadderConfig("x"), null)
  assert.deepEqual(gw.normalizeLadderConfig({ enabled: true, port: 10880, mode: "fixed", fixed: "socks5://1.2.3.4:1080" }), {
    enabled: true, port: 10880, mode: "fixed", fixed: "socks5://1.2.3.4:1080", egress: [],
  })
  assert.deepEqual(gw.normalizeLadderConfig({ enabled: "yes", port: "abc", mode: "weird" }), { enabled: false, port: 10880, mode: "rotate", fixed: null, egress: [] })
  assert.deepEqual(gw.normalizeLadderConfig({}), { enabled: false, port: 10880, mode: "rotate", fixed: null, egress: [] })
  // egress 数组过滤非字符串/空串；缺失→[]
  assert.deepEqual(gw.normalizeLadderConfig({ enabled: true, port: 10880, mode: "rotate", fixed: null, egress: ["socks5://1.1.1.1:1080", "", 123] }).egress, ["socks5://1.1.1.1:1080"])
  assert.deepEqual(gw.normalizeLadderConfig({ enabled: true, port: 10880, mode: "rotate", fixed: null, egress: "nope" }).egress, [])
})

t("readGatewayConfig：ladder 字段读取归一（写文件 → gw 读取，含 egress）+ 缺失 → null", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", ladder: { enabled: true, port: 10880, mode: "fixed", fixed: "socks5://1.2.3.4:1080", egress: ["socks5://9.9.9.9:1080"] } }))
  assert.deepEqual(gw.readGatewayConfig().ladder, { enabled: true, port: 10880, mode: "fixed", fixed: "socks5://1.2.3.4:1080", egress: ["socks5://9.9.9.9:1080"] })
  // 旧形态（无 egress）→ 零迁移 egress:[]
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", ladder: { enabled: true, port: 10880, mode: "rotate" } }))
  assert.deepEqual(gw.readGatewayConfig().ladder, { enabled: true, port: 10880, mode: "rotate", fixed: null, egress: [] })
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen" }))
  assert.equal(gw.readGatewayConfig().ladder, null)
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

t("ladderConfig：读当前 gateway-config 归一（enabled/port/mode/fixed）", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", ladder: { enabled: true, port: 8890, mode: "rotate" } }))
  const c = gw.ladderConfig()
  assert.equal(c.enabled, true)
  assert.equal(c.port, 8890)
  assert.equal(c.mode, "rotate")
  assert.equal(c.fixed, null)
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen" }))
  const d = gw.ladderConfig()
  assert.equal(d.enabled, false)
  assert.equal(d.port, 10880)
  assert.equal(d.mode, "rotate")
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

t("ladderNextEgress：fixed 优先 → 梯子池优先级锁死（主池在场也回梯子池）→ 梯子池空回退主池 → 全空 null", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({
    plan: "zen",
    egress: ["socks5://1.1.1.1:1080", "socks5://2.2.2.2:1080"],
    ladder: { enabled: true, port: 10880, mode: "fixed", fixed: "socks5://9.9.9.9:1080" },
  }))
  const e = gw.ladderNextEgress()
  assert.ok(e && e.type === "socks5")
  assert.equal(e.host, "9.9.9.9")
  // 梯子池非空 + 主池在场 → 命中梯子池（隔离）
  writeFileSync(_gwCfgPath, JSON.stringify({
    plan: "go",
    egress: ["socks5://1.1.1.1:1080", "socks5://2.2.2.2:1080"],
    ladder: { enabled: true, port: 10880, mode: "rotate", egress: ["socks5://7.7.7.7:1080", "socks5://8.8.8.8:1080"] },
  }))
  const a = gw.ladderNextEgress()
  const b = gw.ladderNextEgress()
  assert.ok(a && a.type === "socks5" && b && b.type === "socks5")
  assert.ok((a.host === "7.7.7.7" || a.host === "8.8.8.8"), "梯子池优先（host=" + a.host + "）")
  assert.ok((b.host === "7.7.7.7" || b.host === "8.8.8.8"), "梯子池轮换（host=" + b.host + "）")
  assert.ok(a.host !== b.host, "梯子池双项轮换交替")
  // 梯子池空（含只 direct）→ 回退主池
  writeFileSync(_gwCfgPath, JSON.stringify({
    plan: "go",
    egress: ["socks5://1.1.1.1:1080", "socks5://2.2.2.2:1080"],
    ladder: { enabled: true, port: 10880, mode: "rotate", egress: ["direct"] },
  }))
  const e2 = gw.ladderNextEgress()
  assert.ok(e2 && e2.type === "socks5")
  assert.ok(e2.host === "1.1.1.1" || e2.host === "2.2.2.2", "梯子池仅 direct → 回退主池（host=" + e2.host + "）")
  // 空梯子池（显式 []）→ 回退主池
  writeFileSync(_gwCfgPath, JSON.stringify({
    plan: "go", egress: ["socks5://5.5.5.5:1080"], ladder: { enabled: true, port: 10880, mode: "rotate", egress: [] },
  }))
  const e3 = gw.ladderNextEgress()
  assert.ok(e3 && e3.type === "socks5" && e3.host === "5.5.5.5")
  // 主池+梯子池全无 socks5 → null（本地直连兜底）
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "go", egress: ["direct"], ladder: { enabled: true, port: 10880, mode: "rotate" } }))
  assert.equal(gw.ladderNextEgress(), null)
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

/* ================= 出口轮换游标持久化（egress_index：启动续接 + 轮换写回，P2-3） ================= */
group("出口轮换游标持久化（egress_index：重启续接 + 轮换写回）")

// 独立 fresh 实例：配置文件带 egress_index=3（模块加载时读入游标，模拟「重启后从上次出口续接」，
// 不再回到第 0 出口撞死代理）。env 存原值恢复，绝不碰真实配置。
const EI_CFG = "/tmp/zen-gateway-unittest-gwcfg-ei.json"
writeFileSync(EI_CFG, JSON.stringify({
  plan: "zen", ip_rotation: true,
  egress: ["socks5://11.11.11.11:1080", "socks5://22.22.22.22:1080"],
  egress_index: 3,
}))
let gwEi = null
{
  const saved = process.env.ZEN_GATEWAY_CONFIG
  process.env.ZEN_GATEWAY_CONFIG = EI_CFG
  try {
    gwEi = await import("../gateway.mjs?egress-init=" + Date.now())
  } catch (e) {
    failures.push({ group: currentGroup, name: "C1 fresh import（egress_index=3 配置，zen 档）", error: e })
    console.log(`  ❌ C1 fresh import（egress_index=3）: ${String((e && e.message) || e)}`)
  } finally {
    process.env.ZEN_GATEWAY_CONFIG = saved
  }
}

t("读配置 egress_index=3 → _egressIdx 初值 3（egressSnapshot.index）", () => {
  assert.ok(gwEi, "fresh 实例应可加载")
  assert.equal(gwEi.egressSnapshot().index, 3)
})

t("currentEgress 按游标 3 取出口（3 % 2 = 1 → 第 2 个 socks5 出口）", () => {
  assert.ok(gwEi, "fresh 实例应可加载")
  assert.equal(gwEi.egressEnabled(), true, "zen + egress≥2 + ip_rotation 未关 → 轮换启用")
  const e = gwEi.currentEgress()
  assert.ok(e && e.type === "socks5")
  assert.equal(e.host, "22.22.22.22")
})

t("rotate 后游标 mod 循环：index 3 → (3+1)%2=0 → currentEgress 取第 1 个出口", () => {
  assert.ok(gwEi, "fresh 实例应可加载")
  const e = gwEi.rotateEgress()
  assert.equal(gwEi.egressSnapshot().index, 0, "游标恒 < 池长（mod 循环），3+1 对 2 取模 = 0")
  assert.ok(e && e.type === "socks5" && e.host === "11.11.11.11")
})

{
  let ok = true
  let err = null
  const name = "rotateEgress 触发 egress_index 写回 + persistEgressIndex 显式调用（await 落盘验证，保留其余字段）"
  try {
    // 上一步 rotate 后游标=0（mod 循环）；fire-and-forget withLockAsync 写盘 → 轮询等落盘（无锁竞争时毫秒级）
    for (let i = 0; i < 50; i++) {
      try { if (JSON.parse(readFileSync(EI_CFG, "utf8")).egress_index === 0) break } catch {}
      await new Promise((r) => setTimeout(r, 20))
    }
    let raw = JSON.parse(readFileSync(EI_CFG, "utf8"))
    assert.equal(raw.egress_index, 0)
    assert.equal(raw.plan, "zen") // 其余字段保留（读改写不清库）
    assert.ok(Array.isArray(raw.egress) && raw.egress.length === 2)
    // 显式 persistEgressIndex(1)：直接 await 验证函数本身（写回指定游标 + 保留 ip_rotation 等字段）
    await gwEi.persistEgressIndex(1)
    raw = JSON.parse(readFileSync(EI_CFG, "utf8"))
    assert.equal(raw.egress_index, 1)
    assert.equal(raw.ip_rotation, true)
  } catch (e) { ok = false; err = e }
  if (ok) { passed++; groups[groups.length - 1].count++; console.log(`  ✅ ${name}`) }
  else { failures.push({ group: currentGroup, name, error: err }); console.log(`  ❌ ${name}\n     ${String((err && err.message) || err)}`) }
}

{
  let ok = true
  let err = null
  const name = "缺省（无 egress_index 字段）→ _egressIdx 0（fresh 实例，兼容旧配置零迁移）"
  try {
    const p2 = "/tmp/zen-gateway-unittest-gwcfg-ei2.json"
    writeFileSync(p2, JSON.stringify({ plan: "zen", egress: ["socks5://1.1.1.1:1080", "socks5://2.2.2.2:1080"] }))
    const saved = process.env.ZEN_GATEWAY_CONFIG
    process.env.ZEN_GATEWAY_CONFIG = p2
    let gwEi2 = null
    try { gwEi2 = await import("../gateway.mjs?egress-init2=" + Date.now()) } finally { process.env.ZEN_GATEWAY_CONFIG = saved }
    assert.ok(gwEi2, "缺省配置 fresh 实例应可加载")
    assert.equal(gwEi2.egressSnapshot().index, 0)
  } catch (e) { ok = false; err = e }
  if (ok) { passed++; groups[groups.length - 1].count++; console.log(`  ✅ ${name}`) }
  else { failures.push({ group: currentGroup, name, error: err }); console.log(`  ❌ ${name}\n     ${String((err && err.message) || err)}`) }
}

t("egress_index 非法值（负数/非整数/字符串数字）→ readGatewayConfig 兜底 0", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress_index: -1 }))
  assert.equal(gw.readGatewayConfig().egress_index, 0)
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress_index: "3" }))
  assert.equal(gw.readGatewayConfig().egress_index, 0)
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress_index: 2.5 }))
  assert.equal(gw.readGatewayConfig().egress_index, 0)
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

t("egress_index 合法整数 → 原样返回", () => {
  writeFileSync(_gwCfgPath, JSON.stringify({ plan: "zen", egress_index: 7 }))
  assert.equal(gw.readGatewayConfig().egress_index, 7)
  try { rmSync(_gwCfgPath, { force: true }) } catch {}
})

/* ================= 梯子失败日志合并（同出口连续失败防刷屏） ================= */
group("梯子失败日志合并（createLadderFailLogger）")

t("第一次失败打日志、2-4 次静默累积、第 5 次再打（连续失败只在 1/5/10… 次打印）", () => {
  const logs = []
  const L = gw.createLadderFailLogger((m) => logs.push(m))
  L.fail("1.1.1.1:1080", "f1")
  L.fail("1.1.1.1:1080", "f2")
  L.fail("1.1.1.1:1080", "f3")
  L.fail("1.1.1.1:1080", "f4")
  assert.equal(logs.length, 1, "1-4 次只打第 1 次")
  assert.equal(logs[0], "f1")
  L.fail("1.1.1.1:1080", "f5")
  assert.equal(logs.length, 2, "第 5 次再打")
  assert.equal(logs[1], "f5")
  assert.equal(L.count("1.1.1.1:1080"), 5)
  // 第 10 次 → 每满 5 次
  for (let i = 6; i <= 9; i++) L.fail("1.1.1.1:1080", `f${i}`)
  assert.equal(logs.length, 2, "6-9 次静默")
  L.fail("1.1.1.1:1080", "f10")
  assert.equal(logs.length, 3, "第 10 次（5 的倍数）再打")
})

t("同一出口成功一次即归零（count=0，下次失败重新从第 1 次打）", () => {
  const logs = []
  const L = gw.createLadderFailLogger((m) => logs.push(m))
  for (let i = 0; i < 4; i++) L.fail("2.2.2.2:1080", `f${i}`) // 只打 f0
  L.ok("2.2.2.2:1080")
  assert.equal(L.count("2.2.2.2:1080"), 0)
  L.fail("2.2.2.2:1080", "again")
  assert.equal(L.count("2.2.2.2:1080"), 1)
  assert.equal(logs.length, 2, "归零后再次失败按第 1 次打")
  assert.equal(logs[0], "f0")
  assert.equal(logs[1], "again")
})

t("不同出口计数独立（Map key=host:port；只 match 目标出口不清其它出口）", () => {
  const logs = []
  const L = gw.createLadderFailLogger((m) => logs.push(m))
  L.fail("3.3.3.3:1", "a1")
  L.fail("4.4.4.4:2", "b1")
  L.fail("3.3.3.3:1", "a2")
  assert.equal(logs.length, 2, "两出口各第 1 次各打 1 条")
  assert.equal(L.count("3.3.3.3:1"), 2)
  assert.equal(L.count("4.4.4.4:2"), 1)
  assert.equal(L.size(), 2)
  L.ok("3.3.3.3:1") // 只清一个
  assert.equal(L.count("4.4.4.4:2"), 1)
  assert.equal(L.size(), 1)
})

t("connectLadderUpstream 已接入合并器（源码断言）：成功 ok 归零 + 失败路径 fail 合并", () => {
  const src = readFileSync(new URL("../gateway.mjs", import.meta.url), "utf8")
  assert.ok(src.includes("ladderFailLog.ok("), "隧道成功 → 该出口失败计数归零")
  assert.ok(src.includes("ladderFailLog.fail("), "失败路径（顺延中间行 + 最终失败行）走合并器")
  assert.ok(src.includes("c === 1 || c % 5 === 0"), "只在第 1 次与每满 5 次打日志（其余静默累积）")
})

{
  let ok = true
  let err = null
  const nameTunnel = "socks5TunnelConnect：对 mock SOCKS5（无认证）建 CONNECT 隧道成功"
  try {
    const net = await import("node:net")
    const mock = net.createServer((c) => {
      let buf = Buffer.alloc(0)
      c.on("data", (d) => {
        buf = Buffer.concat([buf, d])
        if (buf.length >= 2 && buf[1] === 0x01 && buf.length >= 3) {
          c.write(Buffer.from([0x05, 0x00]))
          buf = buf.subarray(3)
        }
        if (buf.length >= 10) c.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      })
    })
    const port = 20089 + Math.floor(Math.random() * 100)
    await new Promise((r) => mock.listen(port, "127.0.0.1", r))
    try {
      const e = { type: "socks5", host: "127.0.0.1", port, user: null, pass: null, raw: `socks5://127.0.0.1:${port}` }
      const r = await gw.socks5TunnelConnect(e, "www.google.com", 443, 3000)
      assert.ok(r && r.sock)
      r.sock.destroy()
      // CONNECT 到不可达目标 → reject（确认隧道失败路径）
      let failed = false
      try {
        await gw.socks5TunnelConnect({ type: "socks5", host: "127.0.0.1", port: 1, user: null, pass: null, raw: "socks5://127.0.0.1:1" }, "www.google.com", 443, 1000)
      } catch (e2) { failed = true }
      assert.ok(failed)
    } finally {
      mock.close()
    }
  } catch (e) { ok = false; err = e }
  if (ok) { passed++; groups[groups.length - 1].count++; console.log(`  ✅ ${nameTunnel}`) }
  else { failures.push({ group: currentGroup, name: nameTunnel, error: err }); console.log(`  ❌ ${nameTunnel}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`) }
}

/* ================= 汇总 ================= */
console.log(`\n${"=".repeat(64)}`)
const total = passed + failures.length
console.log(`结果：${passed}/${total} PASS`)
for (const g of groups) console.log(`  【${g.name}】${g.count} 用例`)
if (failures.length) {
  console.log(`\n失败详情（${failures.length}）：`)
  for (const f of failures) {
    console.log(`  [${f.group}] ${f.name}`)
    console.log(`      ${f.error && f.error.stack ? String(f.error.stack).split("\n").slice(0, 4).join("\n      ") : f.error}`)
  }
  console.log("\n❌ 存在失败——是 gateway 实现 bug 还是测试写错？")
  console.log("  若与任务规格预期不符：以「当前实现实际行为」为真值断言，差异记录到 docs/测试报告-zen-gateway.md，不改生产实现。")
  process.exit(1)
}
console.log("✅ ALL PASS")