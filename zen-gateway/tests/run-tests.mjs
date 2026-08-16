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
process.env.ZEN_USAGE_FILE = "/tmp/zen-gateway-unittest-usage.jsonl"
delete process.env.ZEN_GATEWAY_HOST // 默认 127.0.0.1，避免 S6 拒绝启动
delete process.env.ZEN_GATEWAY_TOKEN
delete process.env.ZEN_PROBE_INTERVAL_MIN
delete process.env.ZEN_UPSTREAM_BASE

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
  assert.equal(gw.mapModel("gpt-4o"), "glm-5.2")
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
t("跳过冷却中的 key", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1" },
      { name: "b", key: "2", cooldown_until: new Date(Date.now() + 999999).toISOString() },
      { name: "c", key: "3" },
    ],
  }
  assert.equal(gw.pickNext(cfg).name, "c")
})
t("冷却已过期 → 视为可用", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1" },
      { name: "b", key: "2", cooldown_until: new Date(Date.now() - 1000).toISOString() },
    ],
  }
  assert.equal(gw.pickNext(cfg).name, "b")
})
t("全部冷却 → undefined", () => {
  const cfg = {
    current: "a",
    keys: [
      { name: "a", key: "1", cooldown_until: new Date(Date.now() + 999999).toISOString() },
      { name: "b", key: "2", cooldown_until: new Date(Date.now() + 999999).toISOString() },
    ],
  }
  assert.equal(gw.pickNext(cfg), undefined)
})
t("current 不在 keys → 从 keys[0] 起找可用", () => {
  const cfg = {
    current: "ghost",
    keys: [
      { name: "a", key: "1", cooldown_until: new Date(Date.now() + 999999).toISOString() },
      { name: "b", key: "2" },
    ],
  }
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
    writeFileSync(
      cfgPath,
      JSON.stringify(
        {
          provider_id: "opencode-go",
          current: "bad",
          keys: [
            { name: "bad", key: "sk-fake-bad" },
            { name: "good", key: "sk-fake-good" },
          ],
        },
        null,
        2,
      ),
    )
    // 预置临时 auth.json 为「旧 key 内容」，验证 rotate 会覆盖为轮换后的新 key
    writeFileSync(gwA.AUTH_FILE, JSON.stringify({ "opencode-go": { type: "api", key: "sk-old-before-rotate" } }, null, 2))
    const cfg2 = await gwA.rotate(
      { error: { message: "quota exceeded, reset at 2026-08-16 08:00:00 +0800 CST" } },
      429,
      "bad",
    )
    assert.equal(cfg2.current, "good")
    const savedCfg = JSON.parse(readFileSync(cfgPath, "utf8"))
    assert.equal(savedCfg.current, "good")
    assert.equal(savedCfg.keys[0].cooldown_until, "2026-08-16T00:00:00.000Z")
    const authAfter = JSON.parse(readFileSync(gwA.AUTH_FILE, "utf8"))
    assert.equal(authAfter["opencode-go"].key, "sk-fake-good")
    const realAfter = existsSync(realAuthPath) ? readFileSync(realAuthPath, "utf8") : null
    assert.equal(realAfter, realAuthBefore, "真实 auth.json 必须字节不变")
  } catch (e) {
    ok = false
    err = e
  }
  const name = "rotate() 全链路隔离：假 key 429 → 临时 config 切换 + 临时 auth 更新 + 真实 auth 字节不变"
  if (ok) {
    passed++
    groups[groups.length - 1].count++
    console.log(`  ✅ ${name}`)
  } else {
    failures.push({ group: currentGroup, name, error: err })
    console.log(`  ❌ ${name}\n     ${String((err && err.message) || err).split("\n").join("\n     ")}`)
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

t("基本字段齐全：running/port/defaultModel/modelCount/keys/current/usageFile/upstreamBase/models", () => {
  const s = gw.gatewayStatusSummary(_statusCfg)
  assert.equal(s.running, true)
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

t("空/损坏 cfg 容错：keys=0 current='' 不抛错", () => {
  assert.equal(gw.gatewayStatusSummary({}).keys, 0)
  assert.equal(gw.gatewayStatusSummary({}).current, "")
  assert.equal(gw.gatewayStatusSummary(null).keys, 0)
})

group("gatewayConfigSummary（/api/gateway/config 摘要不泄漏 key）")

t("keys 仅含 name/cooldown_until 两键（无 key 明文字段）", () => {
  const c = gw.gatewayConfigSummary(_statusCfg)
  assert.equal(c.keys.length, 2)
  for (const k of c.keys) assert.deepEqual(Object.keys(k).sort(), ["cooldown_until", "name"])
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