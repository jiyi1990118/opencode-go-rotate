#!/usr/bin/env node
/**
 * zen-gateway — opencode zen（Go 档）→ OpenAI 兼容网关
 *
 * 让 claude code / codex / cursor 等标准 OpenAI 客户端直接使用 opencode zen 免费模型。
 * 单文件、零 npm 依赖（Node ≥ 18 原生 http + fetch）。
 *
 * 核心能力：
 *   - POST /v1/chat/completions   OpenAI 兼容，stream:true 时 SSE 逐块透传（不缓冲）
 *   - POST /v1/messages           Anthropic Messages API 兼容（claude code 直连），双层协议转换
 *   - POST /v1/responses          OpenAI Responses API 兼容（新版 codex / cursor GPT-5 系），逐事件转换
 *   - GET  /v1/models              返回 zen Go 档可用模型清单（含别名）
 *   - GET  /healthz                健康检查
 *   - key 管理：复用 go-keys.json（与 go-rotate 同文件、同锁/原子写机制）
 *   - 自动轮换：请求遇 401/402/429 或配额类错误 → 当前 key 进冷却 → 切下一个 key → 重试一次
 *   - 模型映射：其它 agent 请求任意模型名 → 映射到 zen 实际模型（默认 hy3）
 *   - 日志：写 /tmp/opencode-go-rotate.log（与 go-rotate 同格式）
 *
 * 环境变量：
 *   ZEN_GATEWAY_PORT    （默认 18888）
 *   ZEN_GATEWAY_HOST    （默认 127.0.0.1，仅本地）
 *   ZEN_GATEWAY_TOKEN   （可选，设置后所有请求需 Authorization: Bearer <token>；优先级高于 gateway-config.json 的 token）
 *   ZEN_GATEWAY_CONFIG  （可选，gateway-config.json 路径覆盖，默认 ~/.local/share/zen-gateway/gateway-config.json）
 *   ZEN_CONFIG          （可选，go-keys.json 路径覆盖，默认 ~/.config/opencode/go-keys.json）
 *   ZEN_AUTH_FILE       （可选，auth.json 路径覆盖，默认 ~/.local/share/opencode/auth.json；测试/多实例隔离用）
 *   ZEN_DEFAULT_MODEL   （可选，未知名映射到的模型，默认随套餐 hy3 / hy3-free）
 *   ZEN_UPSTREAM_BASE   （可选，上游端点覆盖，默认随套餐 https://opencode.ai/zen/go/v1 / https://opencode.ai/zen/v1）
 *   ZEN_USAGE_FILE      （可选，用量持久化趋势文件覆盖，默认 ~/.local/share/zen-gateway/usage.jsonl）
 *   ZEN_NOTIFY          （可选，"0" 关闭轮换系统通知，默认开（仅 macOS））
 *   ZEN_PROBE_INTERVAL_MIN （可选，主动探测间隔分钟；>0 启用，0 或未设则不启用）
 *
 * 套餐（plan）：由 gateway-config.json 的 plan 字段决定（"go" 订阅档默认 / "zen" 免费档），
 * 优先级 env(ZEN_UPSTREAM_BASE/ZEN_DEFAULT_MODEL/ZEN_GATEWAY_TOKEN) > 文件(plan/token) > 内置默认(go)。
 * 同一 opencode key 双端点通用，切套餐只需换上游 base + 默认模型 + 内置模型表（hy3 ↔ hy3-free）。
 *
 * 启动：  node gateway.mjs   （Ctrl+C 停止）
 * 后台：  nohup node gateway.mjs >/tmp/zen-gateway.log 2>&1 &
 */
import http from "node:http"
import net from "node:net"
import tls from "node:tls"
import os from "node:os"
import path from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { Readable } from "node:stream"
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  openSync,
  closeSync,
  statSync,
} from "node:fs"

/* ---------------- 常量 ---------------- */

const DEFAULT_PORT = 18888
const DEFAULT_HOST = "127.0.0.1"
const DATA_DIR = path.join(os.homedir(), ".config", "opencode")
const CONFIG_FILE = process.env.ZEN_CONFIG || path.join(DATA_DIR, "go-keys.json")
const AUTH_FILE =
  process.env.ZEN_AUTH_FILE || path.join(os.homedir(), ".local", "share", "opencode", "auth.json")
const LOCK_FILE = CONFIG_FILE + ".lock"
const LOG_FILE =
  process.env.ZEN_LOG_FILE ||
  path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "opencode-go-rotate.log")
// 网关配置（套餐 + token）：默认 ~/.local/share/zen-gateway/gateway-config.json，ZEN_GATEWAY_CONFIG env 覆盖。
// 与 USAGE_FILE 同族（.local 数据目录）；优先级 env(ZEN_*) > 文件(plan/token) > 内置默认(go)。见下方 resolvePlan/resolveToken。
const GATEWAY_CONFIG =
  process.env.ZEN_GATEWAY_CONFIG ||
  path.join(os.homedir(), ".local", "share", "zen-gateway", "gateway-config.json")
// UPSTREAM_BASE / GO_API / MODELS_API / DEFAULT_MODEL 由 ACTIVE_PLAN 派生（见「套餐表」节），此处不再直接声明。
const DEFAULT_COOLDOWN_MIN = 300
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 15000
const LOG_MAX_BYTES = 1024 * 1024
const LOG_KEEP = 3
const PROBE_TIMEOUT_MS = 15000
const UPSTREAM_TIMEOUT_MS = 300000 // 流式可能持续较久，放宽到 5 分钟
const MAX_BODY_BYTES = 8 * 1024 * 1024 // 请求体上限 8MB（防内存 DoS）
const LOG_RING_MAX = 200 // 内存环形日志上限（/api/gateway/log 只读端点用）
// 上游 UA 自适配：优先 env ZEN_UPSTREAM_UA；否则探测本机 opencode 版本 → "opencode/<ver>"（官方白名单 UA，
// 实测非官方 UA 会被 opencode.ai 限流 429）；探测失败回退稳定默认。opencode 升级后无需手工改。
const UPSTREAM_UA_FALLBACK = "opencode/1.18.18"
function resolveUpstreamUA(execSyncImpl = execFileSync, env = process.env) {
  if (env.ZEN_UPSTREAM_UA) return env.ZEN_UPSTREAM_UA
  try {
    const out = String(execSyncImpl("opencode", ["--version"], { encoding: "utf8", timeout: 3000 }))
    const m = out.match(/(\d+\.\d+\.\d+[-\w.]*)/)
    if (m) return `opencode/${m[1]}`
  } catch {
    /* opencode 未安装 / 超时 → 回退稳定默认 */
  }
  return UPSTREAM_UA_FALLBACK
}
const UPSTREAM_UA = resolveUpstreamUA()
// 网关版本号：/api/gateway/status 只读端点的 version 字段（契约 docs/整合设计方案-渐进整合.md §5.3 承诺 "1.1.0"）
const GATEWAY_VERSION = "1.1.0"

/* 用量持久化趋势：usage.jsonl 追加日志（重启不清零，供 tail -f / 后续分析）。
 * 与 gateway 安装目录同族：~/.local/share/zen-gateway/ 不含 opencode 凭据。 */
const USAGE_FILE =
  process.env.ZEN_USAGE_FILE ||
  path.join(os.homedir(), ".local", "share", "zen-gateway", "usage.jsonl")
const USAGE_MAX_LINES = 5000 // 行数上限，超过后截断为保留后 1000 行
const USAGE_KEEP_LINES = 1000
const PROBE_MIN_INTERVAL_MIN = 30 // ZEN_PROBE_INTERVAL_MIN 的文档默认值（0/未设则不启用）
// 主动探测间隔（分钟）：仅在 ZEN_PROBE_INTERVAL_MIN 显式设置且 >0 时启用（保证不影响既有行为）
const PROBE_INTERVAL_MS = (() => {
  const raw = process.env.ZEN_PROBE_INTERVAL_MIN
  if (raw === undefined || raw === null || raw === "") return 0
  const v = Number(raw)
  return Number.isFinite(v) && v > 0 ? Math.max(1, Math.round(v * 60_000)) : 0
})()
// 系统通知开关（macOS only；ZEN_NOTIFY=0 关闭）
const NOTIFY_ENABLED = process.env.ZEN_NOTIFY !== "0"

/* ---------------- 日志（与 go-rotate 同文件同格式） ---------------- */

function rotateLogIfNeeded() {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < LOG_MAX_BYTES) return
    for (let i = LOG_KEEP; i >= 1; i--) {
      const from = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`
      const to = `${LOG_FILE}.${i}`
      if (i === LOG_KEEP) {
        if (existsSync(to)) unlinkSync(to)
      } else if (existsSync(from)) {
        renameSync(from, to)
      }
    }
  } catch {}
}

const _logRing = [] // 内存环形日志（只读端点 /api/gateway/log 用；launchd 下日志文件在 ~/Library/Logs 进程内不可靠，故维护内存副本）
let _logTotal = 0 // 自进程启动以来 log 调用累计条数（环形缓冲被截断后仍可看总量）

const log = (m) => {
  const line = `[${new Date().toISOString()}] [gateway] ${m}`
  _logRing.push(line)
  if (_logRing.length > LOG_RING_MAX) _logRing.shift()
  _logTotal++
  try {
    rotateLogIfNeeded()
    appendFileSync(LOG_FILE, line + "\n")
  } catch {}
}

/** 内存环形日志读取（只读端点用）：返回最近 max 条 + 累计条数。不读文件（仅内存副本）。 */
const getLogRing = (max = LOG_RING_MAX) => ({
  lines: _logRing.slice(-max),
  total: _logTotal,
})

/* ---------------- 用量持久化趋势（usage.jsonl） ----------------
 * 每次 sendWithRotation 完成后追加一行 JSON。零依赖、appendFileSync 简单可靠。
 * 行数上限：超过 USAGE_MAX_LINES 后截断为保留后 USAGE_KEEP_LINES 行，防无限膨胀。 */
let _usageCount = 0
function seedUsageCount() {
  try {
    if (!existsSync(USAGE_FILE)) return
    const data = readFileSync(USAGE_FILE, "utf8")
    _usageCount = data ? data.split("\n").filter((l) => l.trim()).length : 0
  } catch {}
}
function truncateUsageIfNeeded() {
  if (_usageCount <= USAGE_MAX_LINES) return
  try {
    const data = readFileSync(USAGE_FILE, "utf8")
    const lines = data.split("\n").filter((l) => l.trim())
    const keep = lines.slice(-USAGE_KEEP_LINES)
    writeFileSync(USAGE_FILE, keep.join("\n") + "\n")
    _usageCount = keep.length
    log(`🗜️  usage.jsonl 超过 ${USAGE_MAX_LINES} 行，已截断保留后 ${USAGE_KEEP_LINES} 行`)
  } catch {}
}
function appendUsage({ key, ok, model, rotated, endpoint }) {
  try {
    mkdirSync(path.dirname(USAGE_FILE), { recursive: true })
    const row = JSON.stringify({
      ts: new Date().toISOString(),
      key,
      ok: !!ok,
      model,
      rotated: !!rotated,
      endpoint,
    })
    appendFileSync(USAGE_FILE, row + "\n")
    _usageCount++
    if (_usageCount > USAGE_MAX_LINES && _usageCount % 100 === 0) truncateUsageIfNeeded()
  } catch {}
}

/* ---------------- 系统通知（macOS，静默失败） ----------------
 * 轮换成功后通过 osascript 弹系统通知。osascript 是系统命令，非 npm 依赖。
 * 非 macOS 或 ZEN_NOTIFY=0 时自动跳过。失败只 log 不 crash。 */
function notify(title, text) {
  if (!NOTIFY_ENABLED || process.platform !== "darwin") return
  const script = `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`
  log(`🔔  发送系统通知: ${title} — ${text}`)
  execFile("osascript", ["-e", script], (err) => {
    if (err) log(`🔔  系统通知失败（静默）: ${err.message}`)
  })
}

/* ---------------- 文件锁（跨进程，与 go-rotate 同款，避免并发写竞态） ----------------
 * C2：锁从同步阻塞（Atomics.wait 卡死事件循环）改为异步轮询（setTimeout 让出事件循环）。
 * withLockAsync 是唯一运行路径；withLockSync 保留仅供极少数需同步语义的旧调用方（标注 deprecated）。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function withLockAsync(fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, "wx")
      closeSync(fd)
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      try {
        const st = statSync(LOCK_FILE)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK_FILE)
          continue
        }
      } catch {}
      if (Date.now() > deadline) {
        log(`⚠️  获取文件锁超时，仍继续执行`)
        break
      }
      await sleep(100) // 让出事件循环，不阻塞并发 SSE 流
    }
  }
  try {
    return await fn()
  } finally {
    try {
      unlinkSync(LOCK_FILE)
    } catch {}
  }
}

/** @deprecated 同步阻塞锁（会卡死事件循环）。新代码一律用 withLockAsync。 */
function withLockSync(fn) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, "wx")
      closeSync(fd)
      break
    } catch (e) {
      if (e.code !== "EEXIST") throw e
      try {
        const st = statSync(LOCK_FILE)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          unlinkSync(LOCK_FILE)
          continue
        }
      } catch {}
      if (Date.now() > deadline) {
        log(`⚠️  获取文件锁超时，仍继续执行`)
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    return fn()
  } finally {
    try {
      unlinkSync(LOCK_FILE)
    } catch {}
  }
}

/* ---------------- 原子写 ---------------- */

function atomicWrite(file, data, mode) {
  const tmp = file + ".tmp"
  writeFileSync(tmp, data, { encoding: "utf8", mode })
  renameSync(tmp, file)
}

/* ---------------- 配置读写（与 go-rotate 完全兼容） ---------------- */

function loadConfig() {
  try {
    const raw = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : "{}"
    const cfg = JSON.parse(raw)
    const keys = (Array.isArray(cfg.keys) ? cfg.keys : []).filter(
      (k) => k && typeof k.name === "string" && typeof k.key === "string",
    )
    const current = cfg.current ?? ""
    // X2：reconcileCurrent 自愈（TUI 域 current + 网关域 current_gateway）——
    // 任一游标指向不存在的 name 时修正（内存修正即可；持久化由写路径 saveConfig 承担，避免读热路径写盘）
    const resolvedCurrent =
      current && keys.some((k) => k.name === current) ? current : keys[0]?.name ?? ""
    if (current && current !== resolvedCurrent) {
      log(`⚠️  current="${current}" 不存在于 go-keys.json，自愈为 "${resolvedCurrent}"`)
    }
    // 网关域游标：读侧兜底 `current_gateway ?? current`（旧配置零迁移）；指向不存在 → 兜底 TUI current 或 keys[0]
    const rawGateway = cfg.current_gateway ?? current
    const resolvedGateway =
      rawGateway && keys.some((k) => k.name === rawGateway)
        ? rawGateway
        : resolvedCurrent || (keys[0]?.name ?? "")
    if (rawGateway && rawGateway !== resolvedGateway) {
      log(`⚠️  current_gateway="${rawGateway}" 不存在于 go-keys.json，自愈为 "${resolvedGateway}"`)
    }
    return {
      provider_id: cfg.provider_id ?? "opencode-go",
      cooldown_minutes: cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN,
      current: resolvedCurrent,
      current_gateway: resolvedGateway,
      keys,
    }
  } catch (e) {
    log(`⚠️  loadConfig 失败（${CONFIG_FILE}），回退默认配置: ${e.message}`)
    return {
      provider_id: "opencode-go",
      cooldown_minutes: DEFAULT_COOLDOWN_MIN,
      current: "",
      current_gateway: "",
      keys: [],
    }
  }
}

function saveConfig(cfg) {
  mkdirSync(DATA_DIR, { recursive: true })
  atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

/** 读 go-keys.json 原始 JSON（不校验/过滤），供只读端点取 loadConfig 未透传的扩展字段（如 auto_web）。
 *  文件缺失/损坏 → null（调用方无需 try/catch）。绝不返回 key 值。 */
function readRawConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return null
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"))
  } catch {
    return null
  }
}

function syncAuth(key) {
  try {
    const data = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {}
    const auth = data["opencode-go"]
    if (auth && typeof auth === "object") auth.key = key
    else data["opencode-go"] = { type: "api", key }
    atomicWrite(AUTH_FILE, JSON.stringify(data, null, 2), 0o600)
  } catch (e) {
    log(`syncAuth 失败: ${e.message}`)
  }
}

function currentKey(cfg) {
  // 网关域：起点 = current_gateway（读侧兜底 current），与 pickNext 一致
  const gwCurrent = cfg.current_gateway ?? cfg.current
  return cfg.keys.find((k) => k.name === gwCurrent) ?? cfg.keys[0]
}

function cooldownUntilDefault(cfg) {
  return new Date(Date.now() + (cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN) * 60_000).toISOString()
}

/** 从配额错误消息解析 "reset at <time>"，含时区偏移（支持 +0800 / +08:00 / Z / 无偏移）；解析失败返回 null */
function parseResetTime(msg) {
  const m = String(msg).match(
    /reset\s+at\s+(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(Z|[+-]\d{2}:?\d{2})?/i,
  )
  if (!m) return null
  const date = m[1]
  const time = m[2]
  let tz = (m[3] || "").toUpperCase()
  // 偏移归一化：+0800 → +08:00；Z 保持 Z；无偏移则为空
  if (tz && tz !== "Z" && !tz.includes(":")) tz = tz.slice(0, 3) + ":" + tz.slice(3, 5)
  // 拼接标准 ISO：带偏移/Z 直接解析成 UTC；无偏移按本地时区解释（与 go-rotate 行为一致）
  const iso = tz ? `${date}T${time}${tz}` : `${date}T${time}`
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function isQuotaStatus(status) {
  return status === 401 || status === 402 || status === 429
}

/** 判断一条上游错误响应是否配额/鉴权类（触发轮换） */
function isQuotaError(status, body) {
  if (isQuotaStatus(status)) return true
  const msg = String(body?.error?.message ?? body?.message ?? "").toLowerCase()
  return /quota|insufficient|balance|rate.?limit|usage limit|exceeded|配额|余额|限流|超出/i.test(msg)
}

/** 是否触发轮换（自适配）：zen 免费档限流 FreeUsageLimitError 不轮换——同一账户组轮换无用，
 *  且会误冷却健康 key 300 分钟 + last_status=limited 污染展示；直接透传 429 让客户端自决。
 *  其余配额/鉴权类（401 key 失效 / 402/429 套餐配额耗尽）照旧触发轮换（刻意设计）。 */
function shouldRotateForError(status, body) {
  if (body?.error?.type === "FreeUsageLimitError") return false
  return isQuotaError(status, body)
}

/** 把上游错误分类为健康状态 —— 与 go-rotate 的 classifyGoError 契约逐条一致：
 *  返回枚举 ok | invalid | nobalance | limited | error（go-rotate Web / CLI 按此渲染徽章） */
function classifyGoError(msg, statusCode) {
  const s = String(msg ?? "").toLowerCase()
  if (statusCode === 401 && /invalid api key/i.test(s)) return "invalid"
  if (statusCode === 401 || statusCode === 402 || /insufficient|balance/i.test(s)) return "nobalance"
  if (statusCode === 429 || /quota|rate|limit|exceeded/i.test(s)) return "limited"
  return "error"
}

/** 选择下一个未冷却的 key（循环轮换，与 go-rotate pickNext 一致） */
function pickNext(cfg) {
  const now = Date.now()
  // 网关域：起点 = 网关域 current；冷却判定读 k.cooldown_until_gateway（null = 网关域干净起步）
  const gwCurrent = cfg.current_gateway ?? cfg.current
  const startIdx = cfg.keys.findIndex((k) => k.name === gwCurrent)
  for (let i = 1; i <= cfg.keys.length; i++) {
    const k = cfg.keys[(startIdx + i) % cfg.keys.length]
    if (!k) continue
    if (!k.cooldown_until_gateway || Date.parse(k.cooldown_until_gateway) <= now) return k
  }
  return undefined
}

/** 轮换（异步锁内执行）：失败的 key 进冷却，切到下一个可用 key，返回新配置 */
async function rotate(errBody, status, failedKeyName) {
  // zen 免费档自动轮换禁用（2026-08-18 用户实测：同设备 UA/频率限流与账号无关，切换 key 无效反而误伤冷却）。
  // go 付费档保留（配额耗尽轮换有效）。手动轮换走 CLI/Web（写 current_gateway），不经 rotate，不受影响。
  if (ACTIVE_PLAN.id === "zen") {
    log(`🚫  zen 免费档自动轮换已禁用（同设备 UA/频率限流与账号无关），跳过 rotate（status=${status}，key="${failedKeyName ?? "current"}"）`)
    return loadConfig()
  }
  return withLockAsync(() => {
    const cfg = loadConfig()
    const cur = failedKeyName
      ? cfg.keys.find((k) => k.name === failedKeyName)
      : currentKey(cfg)
    const msg = String(errBody?.error?.message ?? errBody?.message ?? "")
    if (cur) {
      cur.cooldown_until_gateway = parseResetTime(msg) ?? cooldownUntilDefault(cfg)
      // X1：与 go-rotate 契约一致，把失败 key 的健康状态写入 last_status（Web/CLI 按此渲染）
      cur.last_status = classifyGoError(msg, status)
      log(`⚠️  key "${cur.name}" 配额耗尽（status=${status} ${msg.slice(0, 120)}），进网关域冷却 until=${cur.cooldown_until_gateway}（last_status=${cur.last_status}）`)
    }
    const next = pickNext(cfg)
    if (!next) {
      // X1：无可用 key 也持久化（对齐 go-rotate 插件 mutateConfig 恒保存行为），
      // 否则失败 key 的 cooldown_until_gateway + last_status 只存在于内存、Web 看不到
      saveConfig(cfg)
      log(`❌  没有可用 key（网关域全部在冷却期），维持当前网关 key "${cfg.current_gateway}"`)
      return cfg
    }
    cfg.current_gateway = next.name
    const nk = currentKey(cfg)
    if (nk) nk.last_status = null // 与插件 rotate 一致：新当前 key 清空状态（视为未探测）
    saveConfig(cfg)
    // 🚨 域独立红线（双域独立轮换契约）：网关 rotate 绝不触碰 auth.json。
    // auth.json 单槽无法同时代表 TUI / 网关两域；auth.json 的 opencode-go.key 仅由 TUI 插件轮换维护，
    // 网关切 key 后 TUI 持久化凭据不变（TUI 重启后仍用自己域 key）。此前的 syncAuth(next.key) 已移除。
    log(`✅  轮换到 key "${next.name}"（网关域 current_gateway），不动 auth.json / TUI 域 current`)
    notify("zen-gateway 轮换", `已切换到 key "${next.name}"（配额耗尽自动轮换）`)
    return cfg
  })
}

/* ---------------- 模型映射 ---------------- */

// zen Go 档真实可用模型（线上 /v1/models 实测，2026-08-16）
const ZEN_MODELS = [
  "deepseek-v4-flash", "deepseek-v4-pro", "glm-5", "glm-5.1", "glm-5.2", "glm-5.3",
  "gpt-5.6-luna", "grok-4.5", "hy3", "hy3-preview",
  "kimi-k2.5", "kimi-k2.6", "kimi-k2.7-code", "kimi-k3",
  "mimo-v2-omni", "mimo-v2-pro", "mimo-v2.5", "mimo-v2.5-pro",
  "minimax-m2.5", "minimax-m2.7", "minimax-m3",
  "qwen3.5-plus", "qwen3.6-plus", "qwen3.7-max", "qwen3.7-plus", "qwen3.8-max",
]

// zen 免费档真实可用模型（官方定价表 / docs/zen-model-research.md §1.1 核实，2026-08-16）。
// 注意：免费名单会变，以 /v1/models 实时返回为准，内置表仅兜底。
const ZEN_MODELS_ZEN = [
  "big-pickle",
  "deepseek-v4-flash-free",
  "mimo-v2.5-free",
  "hy3-free",
  "laguna-s-2.1-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
]

/* ---------------- 套餐表 + 网关配置读取（gateway-config.json） ----------------
 * 优先级（高 → 低）：env(ZEN_UPSTREAM_BASE / ZEN_DEFAULT_MODEL / ZEN_GATEWAY_TOKEN)
 *   → gateway-config.json 的 plan/token → 内置默认（go 档）。
 * 同一 opencode key 双端点通用（research §2.1），切套餐只需换上游 base + 默认模型 +
 * 内置模型表（hy3 ↔ hy3-free），无需换 key。加载时固化一次，变更走「写配置 → 重启」生效。 */
const PLANS = {
  go: {
    id: "go",
    upstreamBase: "https://opencode.ai/zen/go/v1",
    defaultModel: "hy3",
    builtinModels: ZEN_MODELS,
  },
  zen: {
    id: "zen",
    upstreamBase: "https://opencode.ai/zen/v1",
    defaultModel: "hy3-free",
    builtinModels: ZEN_MODELS_ZEN,
  },
}

/** 读 gateway-config.json（ZEN_GATEWAY_CONFIG 覆盖路径）。缺失/损坏/非法 → {}（零迁移回退）。
 *  纯函数：只读文件 + JSON.parse + 字段归一，绝不写文件。 */
function readGatewayConfig() {
  try {
    if (!existsSync(GATEWAY_CONFIG)) return {}
    const raw = readFileSync(GATEWAY_CONFIG, "utf8")
    const cfg = JSON.parse(raw)
    if (!cfg || typeof cfg !== "object") return {}
    return {
      plan: cfg.plan,
      token: typeof cfg.token === "string" && cfg.token ? cfg.token : null,
      token_set_at: typeof cfg.token_set_at === "string" ? cfg.token_set_at : null,
      tokens: Array.isArray(cfg.tokens)
        ? cfg.tokens.filter((t) => typeof t === "string" && t.length > 0)
        : [],
      egress: Array.isArray(cfg.egress) ? cfg.egress.filter((e) => typeof e === "string") : [],
      ip_rotation: cfg.ip_rotation !== false, // 缺省开启；显式 false 关闭
    }
  } catch (e) {
    log(`⚠️  readGatewayConfig 失败（${GATEWAY_CONFIG}），回退默认: ${e.message}`)
    return {}
  }
}

/* ---------------- zen 免费档 IP 轮换（egress 出口池） ----------------
 * 背景：opencode.ai 免费档按 IP 限流（实测直连固定 IP 高频易 429，换出口 IP 可绕过）。
 * 方案：gateway-config.json 可选 `egress` 数组，每项 "direct"（本地直连）或 "socks5://[user:pass@]host:port"。
 *  egress.length<2 时不启用轮换（仅 direct，行为与旧版完全一致）。429 FreeUsageLimitError 时切下一出口重试。 */

/** 归一化出口配置 → 出口对象数组。非法项跳过；仅 direct → 单出口（不启用轮换）。
 *  纯函数：不读文件不碰全局，直接喂 gateway-config 的 egress 字段。 */
function parseEgressList(list) {
  const out = []
  if (!Array.isArray(list)) return out
  const seen = new Set()
  for (const raw of list) {
    if (typeof raw !== "string" || raw.length === 0) continue
    const e = raw === "direct" ? { type: "direct" } : parseSocks5Url(raw)
    if (!e || seen.has(String(raw))) continue
    out.push({ ...e, raw })
    seen.add(String(raw))
  }
  return out
}

/** 解析 "socks5://[user:pass@]host:port" → {type:'socks5', host, port, user?, pass?}；非法返回 null。 */
function parseSocks5Url(url) {
  let s = String(url)
  if (!s.startsWith("socks5://")) return null
  s = s.slice("socks5://".length)
  let user = null
  let pass = null
  const at = s.lastIndexOf("@")
  if (at >= 0) {
    const cred = s.slice(0, at)
    const sep = cred.indexOf(":")
    user = sep >= 0 ? cred.slice(0, sep) : cred
    pass = sep >= 0 ? cred.slice(sep + 1) : null
    s = s.slice(at + 1)
  }
  // 移除路径/斜杠残留（如尾斜杠）
  s = s.replace(/\/.*$/, "")
  const m = s.match(/^([^:\s]+):(\d{1,5})$/)
  if (!m) return null
  const port = Number(m[2])
  if (!(port >= 1 && port <= 65535)) return null
  return { type: "socks5", host: m[1], port, user: user || null, pass: pass || null }
}

/** Socks5 出口请求：手写 SOCKS5 握手 + CONNECT 隧道 → TLS → HTTP/1.1。
 *  纯逻辑接口（零依赖）：返回与 fetch Response 兼容的对象 {status, headers(Map), ok, text(), body(WebStream)}。
 *  opts: { method, path, headers:{name:value}, body(String), targetHost, targetPort, timeoutMs, signal }
 *  body 是 Web ReadableStream（实时透传流式 SSE；非流式由上层 text() 聚合）。 */
async function socks5Request(egress, targetHost, targetPort, opts) {
  const { method = "POST", path = "/", headers = {}, body = "", timeoutMs = UPSTREAM_TIMEOUT_MS, signal, secure = true } = opts
  return new Promise((resolve, reject) => {
    const sock = net.connect(egress.port, egress.host)
    let stage = 0 // 0=握手 1=CONNECT 2=隧道建立 3=HTTP 头收集 4=体流
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; sock.destroy(); reject(new Error(`socks5 tunnel timeout (${egress.host}:${egress.port})`)) }
    }, timeoutMs)
    const cleanup = () => clearTimeout(timer)
    const fail = (err) => {
      if (settled) return
      settled = true; cleanup(); sock.destroy(); reject(err)
    }
    const onAbort = () => fail(new Error("client aborted"))
    if (signal) {
      if (signal.aborted) { fail(new Error("client aborted")); return }
      signal.addEventListener("abort", onAbort, { once: true })
    }
    sock.on("error", (e) => fail(new Error(`socks5 connect error: ${e.message}`)))
    sock.on("connect", () => {
      const noAuth = !egress.user
      const methods = noAuth ? [0x00] : [0x00, 0x02]
      sock.write(Buffer.from([0x05, methods.length, ...methods]))
    })
    sock.on("data", (buf) => {
      if (stage === 0) {
        if (buf.length < 2) return
        const chosen = buf[1]
        if (chosen === 0xff) { fail(new Error("socks5 auth not accepted")); return }
        if (chosen === 0x02 && egress.user) {
          const u = Buffer.from(egress.user, "utf8")
          const p = Buffer.from(egress.pass || "", "utf8")
          if (u.length > 255 || p.length > 255) { fail(new Error("socks5 user/pass too long")); return }
          sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
          stage = 0x10
          return
        }
        if (chosen === 0x00) {
          sock.write(makeConnectReq(targetHost, targetPort))
          stage = 1
          return
        }
        fail(new Error(`socks5 unexpected auth method ${chosen}`))
        return
      }
      if (stage === 0x10) {
        if (buf.length < 2 || buf[1] !== 0x00) { fail(new Error("socks5 user-pass auth failed")); return }
        sock.write(makeConnectReq(targetHost, targetPort))
        stage = 1
        return
      }
      if (stage === 1) {
        if (buf.length < 2 || buf[1] !== 0x00) {
          fail(new Error(`socks5 CONNECT failed (reply code ${buf[1]})`))
          return
        }
        stage = 2
        // SOCKS5 CONNECT 回复长度按 ATYP 变化：VER REP RSV ATYP(1B) + 地址 + 端口。
        // ATYP=0x01 IPv4(4B)、0x04 IPv6(16B)、0x03 域名(1B 长度 + N)。用缓冲正确切出 rest（可能带代理早期返回的数据）。
        const atyp = buf.length >= 4 ? buf[3] : null
        let connLen = 4
        if (atyp === 0x01) connLen += 4 + 2
        else if (atyp === 0x04) connLen += 16 + 2
        else if (atyp === 0x03) connLen += 1 + (buf.length > 4 ? buf[4] : 0) + 2
        const rest = buf.length > connLen ? buf.subarray(connLen) : Buffer.alloc(0)
        // 上游加密（HTTPS）→ 套 TLS；明文（HTTP）→ 直接用原始 socket
        const beginHttp = (conn, restBuf) => {
          const hdrs = Object.entries(headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n")
          conn.write(
            `${method} ${path} HTTP/1.1\r\nHost: ${targetHost}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${hdrs}\r\n\r\n${body}`
          )
          // ---- HTTP 响应解析（流式）----
          let headBuf = restBuf && restBuf.length ? restBuf : Buffer.alloc(0)
          let bodyOut = null
          let resolved = false
          let bodyBuf = Buffer.alloc(0) // chunked 专用缓冲
          const feed = (data) => {
            if (!data || data.length === 0) return
            if (stage === 3) {
              headBuf = headBuf.length ? Buffer.concat([headBuf, data]) : data
              const idx = headBuf.indexOf("\r\n\r\n")
              if (idx < 0) return
              const parsed = parseHead(headBuf.slice(0, idx).toString("utf8"))
              if (!parsed) { fail(new Error("bad http status line")); return }
              stage = 4
              const enc = parsed.headers.get("transfer-encoding")
              const isChunked = enc && enc.toLowerCase().includes("chunked")
              const clen = Number(parsed.headers.get("content-length") || "0")
              bodyOut = new Readable({ read() {} })
              let gotLen = 0
              const feedBody = (d) => {
                if (!d || d.length === 0 || bodyOut.destroyed) return
                if (isChunked) {
                  bodyBuf = bodyBuf.length ? Buffer.concat([bodyBuf, d]) : d
                  for (;;) {
                    const eol = bodyBuf.indexOf("\r\n")
                    if (eol < 0) return
                    const size = parseInt(bodyBuf.slice(0, eol).toString("utf8"), 16)
                    if (isNaN(size)) { bodyOut.destroy(new Error("bad chunk size")); return }
                    const chunkEnd = eol + 2 + size
                    if (bodyBuf.length < chunkEnd + 2) return
                    if (size > 0) bodyOut.push(bodyBuf.slice(eol + 2, eol + 2 + size))
                    bodyBuf = bodyBuf.slice(chunkEnd + 2)
                    if (size === 0) { bodyOut.push(null); return }
                  }
                } else if (clen > 0) {
                  const need = clen - gotLen
                  const take = Math.min(need, d.length)
                  bodyOut.push(d.subarray(0, take))
                  gotLen += take
                  if (gotLen >= clen) bodyOut.push(null)
                } else {
                  bodyOut.push(d)
                }
              }
              // 头后的残留体数据立即喂入
              feedBody(headBuf.slice(idx + 4))
              cleanup(); if (signal) signal.removeEventListener("abort", onAbort)
              resolved = true
              const resObj = {
                status: parsed.status,
                ok: parsed.status >= 200 && parsed.status < 300,
                headers: parsed.headers,
                body: Readable.toWeb(bodyOut),
                text: async () => {
                  let s = ""
                  for await (const c of bodyOut) s += c.toString()
                  return s
                },
                _raw: bodyOut,
              }
              conn.removeAllListeners("error")
              conn.on("data", (c) => feedBody(c))
              conn.on("end", () => { if (!bodyOut.destroyed) bodyOut.push(null) })
              conn.on("error", () => { if (!bodyOut.destroyed) bodyOut.destroy() })
              resolve(resObj)
              return
            }
            if (stage === 4 && bodyOut) feedBody(data)
          }
          conn.on("data", feed)
        }
        if (secure) {
          const tlsSock = tls.connect({ socket: sock, servername: targetHost })
          tlsSock.on("error", (e) => fail(new Error(`tls handshake error: ${e.message}`)))
          tlsSock.on("secureConnect", () => {
            stage = 3
            beginHttp(tlsSock, rest)
          })
        } else {
          stage = 3
          beginHttp(sock, rest)
        }
        return
      }
    })
  })
}

function makeConnectReq(host, port) {
  const hostBuf = Buffer.from(host, "ascii")
  const header = Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length])
  const portBuf = Buffer.from([port >> 8, port & 0xff])
  return Buffer.concat([header, hostBuf, portBuf])
}

/** 解析 HTTP/1.1 响应头 → {status, headers(Map)}（纯函数） */
function parseHead(head) {
  const lines = head.split("\r\n")
  const statusLine = lines[0].match(/^HTTP\/1\.[01] (\d{3})/)
  if (!statusLine) return null
  const status = Number(statusLine[1])
  const headers = new Map()
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].indexOf(":")
    if (c < 0) continue
    headers.set(lines[i].slice(0, c).trim().toLowerCase(), lines[i].slice(c + 1).trim())
  }
  return {
    status,
    headers: { get: (k) => headers.get(String(k).toLowerCase()) || null },
  }
}


/** 解析套餐 → ACTIVE_PLAN{id, upstreamBase, defaultModel, builtinModels}。
 *  config：readGatewayConfig() 的返回值（plan 字段）；env：显式覆盖（缺省 process.env）。
 *  非法/缺失 plan → 回退 go 档；env 的 ZEN_UPSTREAM_BASE / ZEN_DEFAULT_MODEL 优先于文件/默认。 */
function resolvePlan(config, env) {
  env = env || process.env
  const planId = config && config.plan === "zen" ? "zen" : "go"
  const p = PLANS[planId]
  return {
    id: planId,
    upstreamBase: env.ZEN_UPSTREAM_BASE || p.upstreamBase,
    defaultModel: env.ZEN_DEFAULT_MODEL || p.defaultModel,
    builtinModels: p.builtinModels,
  }
}

/** 解析网关访问 token → ACTIVE_TOKEN（string | null）。env ZEN_GATEWAY_TOKEN 优先（向后兼容），
 *  其次文件 token；空串/缺省 → null（鉴权关闭，与现状一致）。 */
function resolveToken(config, env) {
  env = env || process.env
  const envToken = env.ZEN_GATEWAY_TOKEN
  if (envToken !== undefined && envToken !== null && envToken !== "") return envToken
  const fileToken = config && config.token
  return typeof fileToken === "string" && fileToken ? fileToken : null
}

/** 解析网关访问 token 列表 → string[]（支持多 key 鉴权）。env ZEN_GATEWAY_TOKEN 优先（单值向后兼容）；
 *  其次文件 tokens 数组；再回退单 token；全部缺省 → []（鉴权关闭）。 */
function resolveTokens(config, env) {
  env = env || process.env
  const envToken = env.ZEN_GATEWAY_TOKEN
  if (envToken !== undefined && envToken !== null && envToken !== "") return [envToken]
  if (config && Array.isArray(config.tokens) && config.tokens.length > 0) return config.tokens
  const fileToken = config && config.token
  return typeof fileToken === "string" && fileToken ? [fileToken] : []
}

// 模块加载时固化当前套餐与 token 列表（变更走重启生效，不做热切换）
const _GW_CFG = readGatewayConfig()
const ACTIVE_PLAN = resolvePlan(_GW_CFG, process.env)
const ACTIVE_TOKENS = resolveTokens(_GW_CFG, process.env)
const ACTIVE_TOKEN = ACTIVE_TOKENS.length > 0 ? ACTIVE_TOKENS[0] : null

// 由 ACTIVE_PLAN 派生既有常量（保持下游引用不变：upstreamOnce / refreshDynamicModels / mapModel / status 等）
const UPSTREAM_BASE = ACTIVE_PLAN.upstreamBase
const GO_API = UPSTREAM_BASE + "/chat/completions"
const MODELS_API = UPSTREAM_BASE + "/models"

/* ---------------- zen 档 IP 轮换（egress 出口池）运行时状态 ----------------
 * 仅在 zen 套餐且 gateway-config 配置了 egress 数组（≥2 出口）且 ip_rotation!==false 时启用；否则零开销、行为与旧版完全一致。
 * 出口选择：FreeUsageLimitError 时切到下一出口重试一次（成功固化）；平时固定在当前健康出口，不无脑轮换。
 * 开关 / 列表均「按需读当前配置」动态判定——Web 改 ip_rotation 或 egress 后无需重启即时生效。 */
const EGRESS_LIST_INIT = parseEgressList(_GW_CFG && _GW_CFG.egress)
let _egressIdx = 0
let _egressOk = true // 当前出口是否健康（429 → false 触发切换）

/** 动态出口表：从当前 gateway-config 实时解析（增删/开关即时生效）。 */
function egressList() {
  return parseEgressList(readGatewayConfig().egress)
}

/** IP 轮换是否启用（动态）：zen 套餐 + egress≥2 + ip_rotation 未显式关闭。 */
function egressEnabled() {
  if (ACTIVE_PLAN.id !== "zen") return false
  const cfg = readGatewayConfig()
  if (cfg.ip_rotation === false) return false
  return parseEgressList(cfg.egress).length >= 2
}

/** 取当前出口；egressEnabled() 时才轮换（否则恒 direct=null）。 */
function currentEgress() {
  if (!egressEnabled()) return null
  const L = egressList()
  if (!L.length) return null
  const e = L[_egressIdx % L.length]
  return e && e.type === "direct" ? null : e || null
}

/** 标记当前出口 429 → 切到下一出口（mod 循环）；记录日志。 */
function rotateEgress() {
  if (!egressEnabled()) return null
  const L = egressList()
  if (!L.length) return null
  const prev = L[_egressIdx % L.length] || { type: "direct" }
  _egressIdx = (_egressIdx + 1) % L.length
  const next = L[_egressIdx]
  log(`🔁  zen 档出口轮换: ${prev.raw || "direct"} → ${next ? next.raw : "direct"}`)
  return currentEgress()
}

/** 请求成功后调用：确认当前出口健康（egressOk 复位，避免连续成功仍误判）。 */
function egressSucceeded() {
  if (!egressEnabled()) return
  _egressOk = true
}

/** 当前出口健康状态（测试/状态端点用） */
 function egressSnapshot() {
   const L = egressList()
   return {
     enabled: egressEnabled(),
     count: L.length,
     index: _egressIdx,
     current: L[_egressIdx % Math.max(L.length, 1)] ? L[_egressIdx % L.length].raw : "direct",
     list: L.map((e) => e.raw),
   }
 }

 /** 出口池健康检查：对每个出口（或指定 index / 自定义 url 列表）发一次真实最小探测，判断「隧道是否通 + 该出口 IP 是否被上游限流」。
 *  串行执行（避免瞬时并发雪崩与配额浪费），每项 PROBE_TIMEOUT_MS 超时。不轮换、不冷却、不改 current —— 纯只读探测。
 *  出口列表默认取「当前配置文件」（readGatewayConfig 实时），Web 端添加后无需重启即可探测；
 *  传入 expectUrl 时从配置 egress 列表中查找该 url（用于限流池探测时把某项纳入）。
 *  返回 { checkedAt, egress: [{index, url, ok, status, ms, error}] }；ok=false 时 status 可能缺失。 */
 async function egressHealthCheck(onlyIndex = null, expectUrl = null) {
   const cfg = loadConfig()
   const key = currentKey(cfg)
   if (!key) return { checkedAt: new Date().toISOString(), error: "no key in go-keys.json", egress: [] }
   let list = parseEgressList(readGatewayConfig().egress)
   if (list.length === 0) list.push({ type: "direct", raw: "direct" })
   // 限流池探测：把期望的 url（可能在 egress 池中 index 越界）单独作为探测对象
   if (expectUrl) {
     const only = parseEgressList([expectUrl])
     if (only.length) list = only
   }
   const probe = { model: DEFAULT_MODEL, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }
   const probeBody = JSON.stringify(probe)
   // 并发探测（CHK_CONCURRENCY 并发上限，防雪崩 + 提速——避免 N 个超时项串行吃满 N×15s）
   const CHK_CONC = 5
   const targets = []
   for (let i = 0; i < list.length; i++) {
     if (onlyIndex != null && i !== onlyIndex) continue
     targets.push({ e: list[i], index: i })
   }
   const out = []
   for (let base = 0; base < targets.length; base += CHK_CONC) {
     const batch = targets.slice(base, base + CHK_CONC)
     const res = await Promise.all(batch.map(async ({ e, index }) => {
       const start = Date.now()
       const entry = { index, url: e.raw }
       try {
         const r = await upstreamOnce(key.key, probeBody, false, PROBE_TIMEOUT_MS, null,
           e.type === "socks5" ? e : null)
         entry.ms = Date.now() - start
         entry.status = r.res.status
         entry.ok = r.res.ok
         if (!r.res.ok) {
           const t = parseErrorBody(r.bodyText)?.error?.type || ""
           entry.error = `HTTP ${r.res.status}${t ? " (" + t + ")" : ""}`
         }
       } catch (err) {
         entry.ms = Date.now() - start
         entry.ok = false
         entry.error = err.message
       }
       return entry
     }))
     // 保持原顺序
     out.push(...res.sort((a, b) => a.index - b.index))
   }
   return { checkedAt: new Date().toISOString(), egress: out }
 }

 const DEFAULT_MODEL = ACTIVE_PLAN.defaultModel

// 其它 agent 常请求的模型名 → zen 模型。未命中 → 默认模型。
// 注意：hy3 是推理模型（会先输出 reason，需要预留 max_tokens 余量）。
// 工具密集/agentic 场景若想避免推理开销，可把默认映射到非推理模型（如 deepseek-v4-flash）。
const MODEL_ALIAASES = {
  // grok 系
  "grok-code": "hy3",
  "grok-3": "hy3",
  "grok-3-mini": "hy3",
  "grok-4": "grok-4.5",
  // claude 系 → 默认
  "claude-3-5-sonnet-20241022": DEFAULT_MODEL,
  "claude-3-7-sonnet": DEFAULT_MODEL,
  "claude-sonnet-4": DEFAULT_MODEL,
  "claude-opus-4": DEFAULT_MODEL,
  "claude-haiku-4-5": DEFAULT_MODEL,
  // gpt 系
  "gpt-4o": "glm-5.2",
  "gpt-4o-mini": "deepseek-v4-flash",
  "gpt-5": DEFAULT_MODEL,
  // 其它
  "deepseek-chat": "deepseek-v4-pro",
  "deepseek-reasoner": "hy3",
  "qwen-max": "qwen3.7-max",
  "gemini-2.5-pro": DEFAULT_MODEL,
}

// 别名表之上：运行时动态模型表（M3：启动/手动 refresh 从上游 /v1/models 拉取，合并进 mapModel 判定）。
// go / zen 双套餐各自一张动态表——同一 opencode key 双端点通用（research §2.1），一次拉齐两档，
// 供 Web「动态查看 go + zen 全部模型」（或任一档拉取失败只影响该档，其余不受影响）。
// 请求路由判定用「当前套餐」的动态表（语义与旧单一表逐字节等价）。
let DYNAMIC_GO = []
let DYNAMIC_ZEN = []
const dynamicFor = (planId) => (planId === "zen" ? DYNAMIC_ZEN : DYNAMIC_GO)

/** 拉取单套餐上游模型清单（失败/超时静默降级返回 null，该档动态表保持上次结果，不影响另一档）。 */
async function fetchPlanModels(planId, key) {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 3000)
    const r = await fetch(`${PLANS[planId].upstreamBase}/models`, {
      headers: { authorization: `Bearer ${key}`, "user-agent": UPSTREAM_UA },
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (!r.ok) throw new Error(`upstream /v1/models → ${r.status}`)
    const j = await r.json()
    const list = Array.isArray(j?.data) ? j.data.map((m) => m?.id).filter(Boolean) : []
    if (list.length === 0) throw new Error("empty model list")
    return list
  } catch (e) {
    log(`⚠️  [${planId}] 模型表拉取失败（保留既有动态表/内置兜底）: ${e.message}`)
    return null
  }
}

/** 拉取 go + zen 双套餐上游模型清单并入各自动态表。返回当前套餐动态表数量（与旧行为兼容）。 */
async function refreshDynamicModels() {
  const cfg = loadConfig()
  const key = currentKey(cfg)
  if (!key) return 0
  const [goList, zenList] = await Promise.all([
    fetchPlanModels("go", key.key),
    fetchPlanModels("zen", key.key),
  ])
  if (goList) DYNAMIC_GO = goList
  if (zenList) DYNAMIC_ZEN = zenList
  log(
    `✅  模型表更新：go 动态 ${DYNAMIC_GO.length} 个 / zen 动态 ${DYNAMIC_ZEN.length} 个` +
      `（套餐=${ACTIVE_PLAN.id}，内置 go ${PLANS.go.builtinModels.length} / zen ${PLANS.zen.builtinModels.length} 兜底）`,
  )
  return dynamicFor(ACTIVE_PLAN.id).length
}

function mapModel(requested) {
  if (!requested) return ACTIVE_PLAN.defaultModel
  const r = String(requested).toLowerCase()
  if (dynamicFor(ACTIVE_PLAN.id).includes(r)) return r        // 动态表（当前套餐上游最新）
  if (ACTIVE_PLAN.builtinModels.includes(r)) return r        // 内置真实模型（当前套餐）
  const alias = MODEL_ALIAASES[r]
  if (alias) {
    // 别名目标必须属于当前套餐内置表；否则（如 zen 免费档命中付费别名）回退套餐默认
    if (ACTIVE_PLAN.builtinModels.includes(alias)) return alias
    return ACTIVE_PLAN.defaultModel
  }
  // 未知名 → 默认；若该模型存在于另一档动态表，提示（自适配排查：帮助理解"为什么模型被回退"）
  const otherPlan = ACTIVE_PLAN.id === "zen" ? "go" : "zen"
  if (dynamicFor(otherPlan).includes(r)) {
    log(`⚠️  模型 "${requested}" 属于 ${otherPlan} 档，当前套餐 ${ACTIVE_PLAN.id} 不支持，已回退默认 ${ACTIVE_PLAN.defaultModel}`)
  }
  return ACTIVE_PLAN.defaultModel                             // 未知名 → 默认
}

/* ---------------- Anthropic Messages API 兼容层（claude code 走 /v1/messages） ---------------- */

/**
 * Anthropic 请求 → OpenAI 请求（双层协议转换第 1 层）。
 * 只拷贝已知字段；`thinking` / `stop_sequences` / `metadata` / `top_k` 等忽略，
 * 避免它们把上游（OpenAI 格式）打 400。
 */
function anthropicToOpenAI(body) {
  const messages = []
  // system：string 或 content 数组 → 首条 role:"system"
  const sys = body.system
  if (sys != null) {
    let sysText = ""
    if (typeof sys === "string") sysText = sys
    else if (Array.isArray(sys)) sysText = sys.map((s) => (s && s.text) || "").filter(Boolean).join("\n")
    if (sysText) messages.push({ role: "system", content: sysText })
  }
  // messages：content 支持 string 或 [{type:text|image|tool_result}]
  const source = Array.isArray(body.messages) ? body.messages : []
  for (const m of source) {
    const role = m.role
    const c = m.content
    if (typeof c === "string") {
      messages.push({ role, content: c })
      continue
    }
    if (!Array.isArray(c)) continue
    const textParts = []
    const imageParts = []
    const toolMsgs = []
    const toolCalls = []
    for (const block of c) {
      if (!block || typeof block !== "object") continue
      if (block.type === "text") {
        if (block.text) textParts.push(block.text)
      } else if (block.type === "image") {
        const src = block.source
        if (src && src.type === "base64" && src.data) {
          imageParts.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } })
        } else if (src && src.type === "url" && src.url) {
          imageParts.push({ type: "image_url", image_url: { url: src.url } })
        }
      } else if (block.type === "tool_use") {
        // assistant tool_use → OpenAI tool_calls（往返对称，防上游 400「tool messages must follow assistant tool_calls」）
        toolCalls.push({
          id: block.id || "call_" + rand(),
          type: "function",
          function: { name: block.name || "function", arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === "tool_result") {
        // tool_result → OpenAI role:"tool"（紧跟在前面的 assistant tool_calls 之后）
        let tc = ""
        if (typeof block.content === "string") tc = block.content
        else if (Array.isArray(block.content)) tc = block.content.map((t) => (t && t.text) || "").filter(Boolean).join("\n")
        toolMsgs.push({ role: "tool", tool_call_id: block.tool_use_id || "", content: tc })
      }
    }
    if (textParts.length || imageParts.length) {
      const content = imageParts.length
        ? [...textParts.map((t) => ({ type: "text", text: t })), ...imageParts]
        : textParts.join("\n")
      messages.push({ role, content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) })
    } else if (toolCalls.length) {
      messages.push({ role, content: null, tool_calls: toolCalls })
    }
    for (const tm of toolMsgs) messages.push(tm)
  }
  const out = { model: body.model, messages }
  if (body.max_tokens != null) out.max_tokens = body.max_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stream) out.stream = true
  // tools：{name,input_schema} → OpenAI {type:"function",function:{...}}
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || "",
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    }))
  }
  // tool_choice：Anthropic {type:auto|any|tool,name?} → OpenAI "auto"|"required"|{type:function,...}
  if (body.tool_choice != null) {
    const tc = body.tool_choice
    if (tc && tc.type === "any") out.tool_choice = "required"
    else if (tc && tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } }
    else out.tool_choice = "auto"
  }
  return out
}

/** OpenAI 非流式响应 → Anthropic message（粘合层第 2 层） */
function openAIToAnthropic(openai, model) {
  const choice = (openai && openai.choices && openai.choices[0]) || {}
  const msg = choice.message || {}
  const content = []
  // 推理模型坑：content 可能为 null，但 reasoning_content 存在 → 转成 text 输出
  let text = msg.content
  if (text == null && msg.reasoning_content) text = msg.reasoning_content
  if (text != null && text !== "") content.push({ type: "text", text: String(text) })
  // OpenAI tool_calls → Anthropic tool_use
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  for (const tc of toolCalls) {
    let input = {}
    try { input = JSON.parse(tc.function && tc.function.arguments ? tc.function.arguments : "{}") } catch {}
    content.push({ type: "tool_use", id: tc.id || "toolu_zen", name: (tc.function && tc.function.name) || "function", input })
  }
  let stopReason = "end_turn"
  if (choice.finish_reason === "length") stopReason = "max_tokens"
  else if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
  // content 为空（如 max_tokens 被推理吃完）→ 至少给一个空 text 块 + max_tokens
  if (content.length === 0) {
    content.push({ type: "text", text: "" })
    if (stopReason === "end_turn") stopReason = "max_tokens"
  }
  const usage = (openai && openai.usage) || {}
  const id = openai && openai.id ? String(openai.id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) : "zen"
  return {
    id: "msg_" + (id || "zen"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0 },
  }
}

function sendAnthropicError(res, status, message) {
  sendJson(res, status, { type: "error", error: { type: "api_error", message: String(message) } })
}

/**
 * 逐事件转换 OpenAI SSE 流 → Anthropic SSE 事件流（双层协议转换第 2 层，流式）。
 * 不缓冲整段响应；只保留一个块内的小缓冲（SSE 行拼装 + tool_calls 参数分片透传）。
 * 事件时序：message_start → content_block_start(text) → content_block_delta(text_delta)
 * → content_block_stop → message_delta(stop_reason) → message_stop。
 */
async function streamAnthropic(res, upstream, model) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let started = false
  let activeBlock = null // null | "text" | "tool"
  let activeToolIndex = -1
  let blockIndex = -1
  let stopReason = "end_turn"
  let inputTokens = 0
  let outputTokens = 0

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

  const closeBlock = () => {
    if (activeBlock !== null) {
      send("content_block_stop", { type: "content_block_stop", index: blockIndex })
      activeBlock = null
    }
  }

  const emitMessageStart = () => {
    send("message_start", {
      type: "message_start",
      message: {
        id: "msg_zen_" + Math.random().toString(16).slice(2, 10),
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
  }

  const handleChunk = (chunk) => {
    const choice = chunk && chunk.choices && chunk.choices[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (chunk.usage) {
      if (chunk.usage.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens
      if (chunk.usage.completion_tokens != null) outputTokens = chunk.usage.completion_tokens
    }
    if (!started) { emitMessageStart(); started = true }
    // text 内容 → text_delta
    if (typeof delta.content === "string" && delta.content !== "") {
      if (activeBlock !== "text") {
        closeBlock()
        blockIndex++
        send("content_block_start", { type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } })
        activeBlock = "text"
      }
      send("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "text_delta", text: delta.content } })
    }
    // tool_calls（参数会分片，先开 tool_use 块再逐片 input_json_delta）
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const args = tc.function && tc.function.arguments
        if (activeBlock !== "tool" || activeToolIndex !== idx) {
          closeBlock()
          blockIndex++
          send("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: { type: "tool_use", id: tc.id || "toolu_zen", name: (tc.function && tc.function.name) || "function", input: {} },
          })
          activeBlock = "tool"
          activeToolIndex = idx
        }
        if (args) send("content_block_delta", { type: "content_block_delta", index: blockIndex, delta: { type: "input_json_delta", partial_json: args } })
      }
    }
    if (choice.finish_reason) {
      if (choice.finish_reason === "length") stopReason = "max_tokens"
      else if (choice.finish_reason === "tool_calls") stopReason = "tool_use"
      else stopReason = "end_turn"
    }
  }

  const finalize = () => {
    closeBlock()
    if (!started) { emitMessageStart(); started = true }
    send("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } })
    send("message_stop", { type: "message_stop" })
    res.end()
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const t = line.trim()
        if (!t) continue
        if (t.startsWith(":")) { res.write(line + "\n"); continue } // keep-alive 注释透传
        if (!t.startsWith("data:")) continue
        const payload = t.slice(5).trim()
        if (!payload) continue
        if (payload === "[DONE]") { finalize(); return }
        let chunk
        try { chunk = JSON.parse(payload) } catch { continue }
        handleChunk(chunk)
      }
    }
    // 冲刷解码器剩余字节（流末尾一次）
    buf += dec.decode()
    const t = buf.trim()
    if (t.startsWith("data:")) {
      const payload = t.slice(5).trim()
      if (payload && payload !== "[DONE]") {
        try { handleChunk(JSON.parse(payload)) } catch {}
      }
    }
    finalize()
  } catch (e) {
    // E1：客户端断开 → res 已不可写，直接销毁，不发错误帧
    if (res.destroyed || res.writableEnded) {
      try { res.destroy() } catch {}
      return
    }
    // E2：流中段上游报错 → 发一个 Anthropic error 事件让客户端感知
    try {
      send("error", { type: "error", error: { type: "api_error", message: "upstream stream interrupted", detail: String(e && e.message || e) } })
    } catch {}
    try { res.destroy() } catch {}
  }
}

async function handleMessages(req, res) {
  const raw = await readBody(req, res)
  if (raw === null) return
  let bodyObj
  try { bodyObj = raw ? JSON.parse(raw) : {} } catch { return sendAnthropicError(res, 400, "invalid JSON body") }
  const isStream = !!bodyObj.stream
  const openaiBody = anthropicToOpenAI(bodyObj)
  // E1：客户端断开 → abort 上游 fetch（防资源泄漏）
  const ac = new AbortController()
  res.on("close", () => ac.abort())
  const out = await safeSend(openaiBody, isStream, ac.signal, "messages")
  if (out.error) {
    const m = out.error.body && ((out.error.body.error && out.error.body.error.message) || out.error.body.message)
    return sendAnthropicError(res, out.error.status, m || "upstream error")
  }
  const upstream = out.res
  const model = out.mappedModel
  if (isStream) {
    if (upstream.ok) return streamAnthropic(res, upstream, model)
    const err = parseErrorBody(out.bodyText)
    return sendAnthropicError(res, upstream.status, (err.error && err.error.message) || err.message || "upstream error")
  }
  // 非流式错误路径：body 已被 upstreamOnce 消费，直接用 out.bodyText（不能再 .text()）
  if (!upstream.ok) {
    const err = parseErrorBody(out.bodyText)
    return sendAnthropicError(res, upstream.status, (err.error && err.error.message) || err.message || "upstream error")
  }
  const text = out.bodyText || (await upstream.text())
  let openaiRes
  try { openaiRes = JSON.parse(text) } catch { return sendAnthropicError(res, 502, "bad upstream response") }
  return sendJson(res, 200, openAIToAnthropic(openaiRes, model))
}

/* ---------------- 上游请求与轮换 ---------------- */

/** 合并两个 AbortSignal（超时 + 客户端断开）。Node 18 无 AbortSignal.any，手动桥接。任一先触发即 abort。 */
function combineSignals(signalA, signalB) {
  if (!signalA) return signalB
  if (!signalB) return signalA
  const ac = new AbortController()
  const fire = () => ac.abort()
  if (signalA.aborted || signalB.aborted) {
    ac.abort()
  } else {
    signalA.addEventListener("abort", fire, { once: true })
    signalB.addEventListener("abort", fire, { once: true })
    ac.signal.addEventListener("abort", () => {
      signalA.removeEventListener("abort", fire)
      signalB.removeEventListener("abort", fire)
    }, { once: true })
  }
  return ac.signal
}

/** 发送一次上游请求（不重试），返回 {res, bodyText}（stream 时 bodyText 可能未读完）
 *  clientSignal：客户端断开 signal，触发时取消上游 fetch（E1，防资源泄漏）。 */
async function upstreamOnce(key, bodyStr, isStream, timeoutMs, clientSignal, egress = null) {
  // egress=null → 本地直连（默认，行为不变）；egress.socks5 → 走 SOCKS5 隧道（zen 档 IP 轮换）。
  const targetURL = new URL(GO_API)
  const commonHeaders = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
    "user-agent": UPSTREAM_UA,
  }
  if (egress && egress.type === "socks5") {
    const res = await socks5Request(
      { host: egress.host, port: egress.port, user: egress.user, pass: egress.pass },
      targetURL.hostname,
      Number(targetURL.port || (targetURL.protocol === "https:" ? 443 : 80)),
      {
        method: "POST",
        path: targetURL.pathname + targetURL.search,
        headers: commonHeaders,
        body: bodyStr,
        timeoutMs,
        signal: combineSignals(AbortSignal.timeout(timeoutMs), clientSignal),
        secure: targetURL.protocol === "https:",
      }
    )
    if (res.ok) return { res, bodyText: "" }
    const bodyText = await res.text()
    return { res, bodyText }
  }
  const res = await fetch(GO_API, {
    method: "POST",
    headers: commonHeaders,
    body: bodyStr,
    signal: combineSignals(AbortSignal.timeout(timeoutMs), clientSignal),
  })
  if (res.ok) return { res, bodyText: "" }
  // 非 2xx：读完整响应体（错误 JSON），供解析 / 轮换判断
  const bodyText = await res.text()
  return { res, bodyText }
}

function parseErrorBody(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { error: { message: text } }
  }
}

/**
 * 带轮换的发送：
 *   - 用当前 key 发一次
 *   - 若上游 401/402/429 或配额类错误 → 轮换 → 用新 key 重试一次
 *   - 仍失败则返回最后一次结果（不无限重试）
 * 返回 { res, bodyText, upstreamBody(passthrough), mappedModel }
 */
/* 使用量统计（内存计数，重启清零；持久化趋势留给后续）
 * 每 key：success=成功请求数（非配额错误的响应），rotated=该 key 作为失败方触发轮换的次数
 * 全局：totalRequests / rotations / startedAt */
const usageStats = { totalRequests: 0, rotations: 0, startedAt: Date.now(), perKey: {} }

function usageInc(name, field) {
  const s = (usageStats.perKey[name] ??= { success: 0, rotated: 0 })
  if (field === "success") s.success++
  else if (field === "rotated") s.rotated++
}

function usageSnapshot(cfg) {
  const now = Date.now()
  const perKey = {}
  for (const k of cfg.keys) {
    const s = usageStats.perKey[k.name] ?? { success: 0, rotated: 0 }
    perKey[k.name] = {
      success: s.success,
      rotated: s.rotated,
      cooldown_until: k.cooldown_until ?? null,
    }
  }
  return { totalRequests: usageStats.totalRequests, rotations: usageStats.rotations, uptimeSec: Math.floor((now - usageStats.startedAt) / 1000), perKey }
}

async function safeSend(bodyObj, isStream, clientSignal, endpoint = "chat") {
  try {
    return await sendWithRotation(bodyObj, isStream, clientSignal, endpoint)
  } catch (err) {
    log(`❌  sendWithRotation(${endpoint}) 异常: ${err && err.name} ${err && err.message}`)
    return { error: { status: 502, body: { error: { message: `gateway internal: ${err && err.message || err}` } } } }
  }
}

/**
 * 推理模型截断判定（纯函数）：上游成功但 content 为空 + finish_reason=max_tokens（reasoning 占满预算，
 * 如 hy3-free 配小 max_tokens）→ 返回放大后的 max_tokens；不满足返回 null。
 * 放大策略 max(原×2, 4096)，上限 131072。
 */
function truncationRetryPlan(bodyText, bodyObj) {
  if (process.env.ZEN_AUTO_MAX_TOKENS === "0") return null
  let j = null
  try {
    j = JSON.parse(bodyText)
  } catch {
    return null
  }
  const c = j?.choices?.[0]
  if (!c || c.finish_reason !== "max_tokens") return null
  const content = c.message?.content
  if (typeof content === "string" && content.length > 0) return null
  const orig = Number(bodyObj.max_tokens)
  const next = Math.min(Math.max(orig > 0 ? orig * 2 : 4096, 4096), 131072)
  if (next === orig) return null
  return next
}

/** 推理模型截断自适配（非流式）：判定成立时放大 max_tokens 重发一次，返回新 bodyText；失败返回 null。 */
async function retryTruncatedContent(bodyText, bodyObj, mappedModel, key, timeoutMs, clientSignal, egress = null) {
  const next = truncationRetryPlan(bodyText, bodyObj)
  if (next == null) return null
  log(`⚠️  推理模型 content 截断（finish=max_tokens），自动放大至 ${next} 重试一次${egress ? `（出口 ${egress}）` : ""}`)
  const retry = await upstreamOnce(
    key,
    JSON.stringify({ ...bodyObj, model: mappedModel, max_tokens: next }),
    false,
    timeoutMs,
    clientSignal,
    egress,
  )
  if (retry.res.ok) return await retry.res.text()
  log(`⚠️  截断重试仍失败（status=${retry.res.status}），透传原始响应`)
  return null
}

async function sendWithRotation(bodyObj, isStream, clientSignal, endpoint = "chat") {
  usageStats.totalRequests++
  const key = currentKey(loadConfig())
  if (!key) {
    log(`❌  go-keys.json 无可用 key（${CONFIG_FILE}），请先 go-rotate add/init`)
    return { error: { status: 500, body: { error: { message: "no key configured in go-keys.json" } } } }
  }
  const mappedModel = mapModel(bodyObj.model)
  const bodyStr = JSON.stringify({ ...bodyObj, model: mappedModel })
  const timeoutMs = isStream ? UPSTREAM_TIMEOUT_MS : PROBE_TIMEOUT_MS

  // 第 1 次（用当前出口；egressEnabled() 时初始即走 egress）
  let { res, bodyText } = await upstreamOnce(key.key, bodyStr, isStream, timeoutMs, clientSignal, currentEgress())

  // zen 档 IP 轮换：FreeUsageLimitError（免费档按 IP 限流）且启用出口池 → 切下一出口重试一次。
  if (egressEnabled() && !res.ok && parseErrorBody(bodyText)?.error?.type === "FreeUsageLimitError") {
    log(`🔁  zen 档当前出口 429（FreeUsageLimit），切出口重试（key="${key.name}"）`)
    const nextEgress = rotateEgress()
    const retry = await upstreamOnce(key.key, bodyStr, isStream, timeoutMs, clientSignal, nextEgress)
    if (retry.res.ok) {
      egressSucceeded()
      usageInc(key.name, "success")
      let retBody = retry.bodyText
      if (!isStream) {
        const full = retry.bodyText || (await retry.res.text())
        const auto = await retryTruncatedContent(full, bodyObj, mappedModel, key.key, timeoutMs, clientSignal, nextEgress)
        if (auto) {
          log(`✅  出口切换后截断重试成功`)
          appendUsage({ key: key.name, ok: true, model: mappedModel, rotated: false, endpoint })
          return { res: new Response(null, { status: 200 }), bodyText: auto, upstreamBody: auto, mappedModel }
        }
        if (full) retBody = full
      }
      appendUsage({ key: key.name, ok: true, model: mappedModel, rotated: false, endpoint })
      return { res: retry.res, bodyText: retBody, upstreamBody: retBody, mappedModel }
    }
    // 出口切换后仍失败：透传（不无限重试；保留新出口，下次请求再判）
    log(`⚠️  出口切换后仍失败（status=${retry.res.status}），透传`)
    appendUsage({ key: key.name, ok: false, model: mappedModel, rotated: false, endpoint })
    return { res: retry.res, bodyText: retry.bodyText, upstreamBody: retry.bodyText, mappedModel }
  }

  if (res.ok || !shouldRotateForError(res.status, parseErrorBody(bodyText))) {
    if (res.ok) {
      egressSucceeded()
      usageInc(key.name, "success")
      if (!isStream) {
        // 非流式：读取上游 body（供截断判定 + handler 透传；upstreamOnce 成功时 bodyText=""）
        const full = await res.text()
        const auto = await retryTruncatedContent(full, bodyObj, mappedModel, key.key, timeoutMs, clientSignal, currentEgress())
        if (auto) {
          log(`✅  截断重试成功（放大 max_tokens 后返回完整内容）`)
          appendUsage({ key: key.name, ok: true, model: mappedModel, rotated: false, endpoint })
          return { res: new Response(null, { status: 200 }), bodyText: auto, upstreamBody: auto, mappedModel }
        }
        if (full) bodyText = full
      }
    }
    appendUsage({ key: key.name, ok: res.ok, model: mappedModel, rotated: false, endpoint })
    return { res, bodyText, upstreamBody: bodyText, mappedModel }
  }
  // 配额错误 → 轮换 + 重试一次（冷却实际失败的 key，避免并发 401 误伤刚切过去的好 key）
  const errBody = parseErrorBody(bodyText)
  if (ACTIVE_PLAN.id === "zen") {
    // zen 免费档：非 FreeUsageLimit 的配额错误与账号/UA 相关，轮换出口无意义 → 不轮换不计数直接透传
    log(`🚫  zen 免费档自动轮换已禁用（同设备 UA/频率限流与账号无关），透传上游错误 status=${res.status}（key="${key.name}"）`)
    appendUsage({ key: key.name, ok: false, model: mappedModel, rotated: false, endpoint })
    return { res, bodyText, upstreamBody: bodyText, mappedModel }
  }
  log(`🔁  检测到配额/鉴权错误（status=${res.status}），触发轮换并重试一次`)
  usageStats.rotations++
  usageInc(key.name, "rotated")
  const cfg = await rotate(errBody, res.status, key.name)
  const newKey = currentKey(cfg)
  if (newKey && newKey.name !== key.name) {
    const retry = await upstreamOnce(newKey.key, bodyStr, isStream, timeoutMs, clientSignal)
    if (retry.res.ok || !shouldRotateForError(retry.res.status, parseErrorBody(retry.bodyText))) {
      if (retry.res.ok) usageInc(newKey.name, "success")
      appendUsage({ key: newKey.name, ok: retry.res.ok, model: mappedModel, rotated: true, endpoint })
      return { ...retry, mappedModel }
    }
    log(`⚠️  重试后仍失败（status=${retry.res.status}），返回上游错误`)
    appendUsage({ key: newKey.name, ok: false, model: mappedModel, rotated: true, endpoint })
    return retry
  }
  // 没有可用的新 key，返回原错误
  appendUsage({ key: key.name, ok: false, model: mappedModel, rotated: true, endpoint })
  return { res, bodyText, upstreamBody: bodyText, mappedModel }
}

/* ---------------- HTTP 服务 ---------------- */

function gatewayAuth(req) {
  const tokens = ACTIVE_TOKENS
  if (!tokens || tokens.length === 0) return true
  const h = req.headers.authorization || ""
  if (h.startsWith("Bearer ")) {
    const bearer = h.slice(7)
    if (tokens.includes(bearer)) return true
  }
  // claude code 会发 x-api-key（ANTHROPIC_API_KEY）。设 token 时接受 x-api-key 等于任一 token。
  const xk = req.headers["x-api-key"]
  return typeof xk === "string" && tokens.includes(xk)
}

/** 掩码 token 用于日志/启动输出（绝不打印明文） */
function maskToken(t) {
  if (!t || t.length < 8) return "****"
  return t.slice(0, 4) + "****" + t.slice(-4)
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(body)
}

/** 流式透传：把上游 res.body 逐块写给客户端，不缓冲。
 *  E1：客户端断开（upstream 已被上层 clientSignal abort）→ reader 抛 AbortError → 清理。
 *  E2：流中段上游报错 → 尽量发一个 SSE 错误帧让客户端感知，而非静默截断。 */
async function pipeStream(res, upstream) {
  const h = {
    "content-type": upstream.headers.get("content-type") || "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  }
  res.writeHead(upstream.status, h)
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(value)
    }
    res.end()
  } catch (e) {
    // 客户端已断开（res 已不可写）→ 直接销毁，不发错误帧（无接收方）
    if (res.destroyed || res.writableEnded) {
      try { res.destroy() } catch {}
      return
    }
    try {
      res.write(
        "data: " +
          JSON.stringify({ error: { message: "upstream stream interrupted", detail: String(e && e.message || e) } }) +
          "\n\n",
      )
    } catch {}
    try { res.destroy() } catch {}
  }
}

/** 读取请求体（限制大小防 DoS）；超限返回 null */
async function readBody(req, res) {
  let raw = ""
  for await (const chunk of req) {
    raw += chunk
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      sendJson(res, 413, { error: { message: "request body too large" } })
      return null
    }
  }
  return raw
}

async function handleChatCompletions(req, res) {
  const raw = await readBody(req, res)
  if (raw === null) return
  let bodyObj
  try {
    bodyObj = raw ? JSON.parse(raw) : {}
  } catch {
    return sendJson(res, 400, { error: { message: "invalid JSON body" } })
  }
  // cursor GPT-5 系模型坑：会把 Responses 形状的 body（含 `input`、无 `messages`）POST 到
  // `/v1/chat/completions`。检测到即复用 Responses 转换逻辑，响应也转回 Responses 格式（cursor 期待）。
  if (bodyObj.input != null && bodyObj.messages == null) {
    log(`↪️  /v1/chat/completions 收到 Responses 形状 body（cursor GPT-5 路径），转 Responses 处理`)
    return handleResponsesBody(res, bodyObj)
  }
  const isStream = !!bodyObj.stream
  // E1：客户端断开 → abort 上游 fetch（防资源泄漏）
  const ac = new AbortController()
  res.on("close", () => ac.abort())
  const out = await safeSend(bodyObj, isStream, ac.signal, "chat")
  if (out.error) return sendJson(res, out.error.status, out.error.body)
  const upstream = out.res
  if (isStream) {
    if (upstream.ok) return pipeStream(res, upstream)
    // 上游非 2xx（重试后仍失败）：返回错误 JSON
    return sendJson(res, upstream.status, parseErrorBody(out.bodyText))
  }
  // 非流式：透传上游 JSON（含 usage / choices）；body 已由 sendWithRotation 读取（截断自适配），优先用 out.bodyText
  // 错误路径：body 已被 upstreamOnce 消费，直接返回错误（不能再 .text()）
  if (!upstream.ok) {
    const err = parseErrorBody(out.bodyText)
    return sendJson(res, upstream.status, err.error && err.error.message ? err : { error: { message: String(out.bodyText).slice(0, 300) } })
  }
  const text = out.bodyText || (await upstream.text())
  let bodyText = text
  try {
    const parsed = JSON.parse(text)
    const choice = parsed && parsed.choices && parsed.choices[0]
    const msg = choice && choice.message
    // M1：推理模型（hy3）content:null 但 reasoning_content 存在 → 兜底填充，避免客户端收到空内容
    if (msg && msg.content == null && msg.reasoning_content != null) {
      msg.content = msg.reasoning_content
      msg._reasoning_only = true
      bodyText = JSON.stringify(parsed)
    }
  } catch {}
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
  })
  res.end(bodyText)
}

/* ---------------- OpenAI Responses API 兼容层（codex / cursor GPT-5 系模型） ---------------- */

const rand = () => Math.random().toString(16).slice(2, 10)

/**
 * Responses 请求 → OpenAI Chat Completions 请求。
 * 只拷贝已知字段；`previous_response_id` / `store` / `metadata` / `reasoning` 等忽略（不影响上游）。
 * 推理模型（hy3）的 reasoning 由上游原样产生，网关不额外处理。
 */
function responsesToOpenAI(body) {
  const messages = []
  // instructions：string 或 content 数组 → 第一条 role:"system"
  const instr = body.instructions
  if (instr != null) {
    let txt = ""
    if (typeof instr === "string") txt = instr
    else if (Array.isArray(instr)) txt = instr.map((i) => (i && i.text) || "").filter(Boolean).join("\n")
    if (txt) messages.push({ role: "system", content: txt })
  }
  // input：string，或数组（含 type:"message" 与 type:"function_call_output"）
  const input = body.input
  if (typeof input === "string") {
    messages.push({ role: "user", content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue
      const type = item.type
      if (type === "message" || item.role) {
        const role = item.role || "user"
        const content = item.content
        let text = ""
        if (typeof content === "string") text = content
        else if (Array.isArray(content)) {
          text = content
            .map((c) => {
              if (!c || typeof c !== "object") return ""
              if (c.type === "input_text" || c.type === "output_text" || c.type === "text") return c.text || ""
              return ""
            })
            .filter(Boolean)
            .join("\n")
        }
        if (text) messages.push({ role, content: text })
      } else if (type === "function_call_output") {
        // 工具调用结果 → role:"tool"
        let out = item.output
        if (typeof out !== "string") {
          try { out = JSON.stringify(out) } catch { out = String(out) }
        }
        messages.push({ role: "tool", tool_call_id: item.call_id || item.id || "", content: out })
      }
      // 其它 input 项（function_call 追问等）忽略，够用
    }
  }
  const out = { model: body.model, messages }
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens
  if (body.temperature != null) out.temperature = body.temperature
  if (body.top_p != null) out.top_p = body.top_p
  if (body.stream) out.stream = true
  // tools：{type:"function",name,description,parameters} → OpenAI {type,function:{name,description,parameters}}
  if (Array.isArray(body.tools) && body.tools.length) {
    out.tools = body.tools.map((t) => {
      const fn = t.function || {}
      return {
        type: "function",
        function: {
          name: fn.name || t.name || "",
          description: fn.description || t.description || "",
          parameters: fn.parameters || t.parameters || { type: "object", properties: {} },
        },
      }
    })
  }
  if (body.tool_choice != null) out.tool_choice = body.tool_choice
  return out
}

/**
 * OpenAI 非流式响应 → Responses 响应（object:"response"）。
 * 推理模型坑：content:null（max_tokens 被 reasoning 吃完）→ 空 output_text 块 + status:"incomplete"。
 */
function openAIToResponse(openai, model, requestedModel) {
  const choice = (openai && openai.choices && openai.choices[0]) || {}
  const msg = choice.message || {}
  const usage = (openai && openai.usage) || {}
  const inputTokens = usage.prompt_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? 0
  let status = "completed"
  if (choice.finish_reason === "length") status = "incomplete"
  const output = []
  // 文本（含推理模型 content:null → reasoning 兜底）
  let text = msg.content
  if (text == null && msg.reasoning_content) text = msg.reasoning_content
  // tool_calls 先统计：纯 tool_calls 响应（content:null）不应被误判为截断
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  if (text != null && text !== "") {
    output.push({
      type: "message",
      id: "msg_" + rand(),
      status,
      role: "assistant",
      content: [{ type: "output_text", text: String(text), annotations: [] }],
    })
  } else if (toolCalls.length === 0) {
    // content:null（max_tokens 被推理吃完）且无 tool_calls → 空 output_text 块 + incomplete
    output.push({
      type: "message",
      id: "msg_" + rand(),
      status: "incomplete",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [] }],
    })
    if (status === "completed") status = "incomplete"
  }
  // tool_calls → function_call 输出项
  for (const tc of toolCalls) {
    const cid = tc.id || "call_" + rand()
    output.push({
      type: "function_call",
      id: cid,
      call_id: cid,
      name: (tc.function && tc.function.name) || "function",
      arguments: (tc.function && tc.function.arguments) || "",
      status,
    })
  }
  return {
    id: "resp_" + rand(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: requestedModel || model,
    output,
    parallel_tool_calls: true,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      input_tokens_details: {
        cached_tokens: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ?? 0,
      },
      output_tokens_details: {
        reasoning_tokens: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) ?? 0,
      },
    },
  }
}

/**
 * 逐事件转换 OpenAI SSE 流 → Responses API SSE 事件流。
 * 不缓冲整段响应，只保留一个块内的小缓冲（SSE 行拼装 + text/arguments 累计）。
 * 事件序列（文本）：response.created → response.in_progress → response.output_item.added(message)
 * → response.content_part.added → response.output_text.delta（逐块）→ response.output_text.done
 * → response.content_part.done → response.output_item.done → response.completed(+[DONE])。
 * 工具调用：response.output_item.added(function_call) → response.function_call_arguments.delta（分片）
 * → response.function_call_arguments.done → response.output_item.done。
 * 推理模型（hy3）的 reasoning_content 忽略不转发；content:null → 空文本块 + status:"incomplete"。
 */
async function streamResponses(res, upstream, model, requestedModel) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  })
  const reader = upstream.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let started = false
  let activeItem = null // {kind:"text"|"tool", id, index, text/args, name, toolIndex}
  let outputIndex = -1
  let inputTokens = 0
  let outputTokens = 0
  let status = "completed"
  const respId = "resp_" + rand()
  const created = Math.floor(Date.now() / 1000)
  const baseResp = {
    id: respId,
    object: "response",
    created_at: created,
    status: "in_progress",
    model: requestedModel || model,
    output: [],
    parallel_tool_calls: true,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const itemStatus = () => (status === "incomplete" ? "incomplete" : "completed")

  const openItem = (kind, id, name) => {
    if (activeItem) closeItem()
    outputIndex++
    if (kind === "text") {
      send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "message", id, status: "in_progress", role: "assistant", content: [] },
      })
      send("response.content_part.added", {
        type: "response.content_part.added",
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      })
    } else {
      send("response.output_item.added", {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: { type: "function_call", id, status: "in_progress", name, arguments: "" },
      })
    }
    activeItem = { kind, id, index: outputIndex, text: "", args: "", name: name || "", toolIndex: -1 }
  }

  const closeItem = () => {
    if (!activeItem) return
    if (activeItem.kind === "text") {
      send("response.output_text.done", {
        type: "response.output_text.done",
        item_id: activeItem.id,
        output_index: activeItem.index,
        content_index: 0,
        text: activeItem.text,
      })
      send("response.content_part.done", {
        type: "response.content_part.done",
        item_id: activeItem.id,
        output_index: activeItem.index,
        content_index: 0,
        part: { type: "output_text", text: activeItem.text, annotations: [] },
      })
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: activeItem.index,
        item: {
          type: "message",
          id: activeItem.id,
          status: itemStatus(),
          role: "assistant",
          content: [{ type: "output_text", text: activeItem.text, annotations: [] }],
        },
      })
    } else {
      send("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: activeItem.id,
        output_index: activeItem.index,
        arguments: activeItem.args,
      })
      send("response.output_item.done", {
        type: "response.output_item.done",
        output_index: activeItem.index,
        item: {
          type: "function_call",
          id: activeItem.id,
          status: itemStatus(),
          name: activeItem.name,
          arguments: activeItem.args,
        },
      })
    }
    activeItem = null
  }

  const appendText = (delta) => {
    if (!activeItem || activeItem.kind !== "text") openItem("text", "msg_" + rand())
    activeItem.text += delta
    send("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: activeItem.id,
      output_index: activeItem.index,
      content_index: 0,
      delta,
    })
  }

  const appendArgs = (delta) => {
    if (!activeItem || activeItem.kind !== "tool") openItem("tool", "call_" + rand(), "function")
    activeItem.args += delta
    send("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: activeItem.id,
      output_index: activeItem.index,
      delta,
    })
  }

  const handleChunk = (chunk) => {
    const choice = chunk && chunk.choices && chunk.choices[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (chunk.usage) {
      if (chunk.usage.prompt_tokens != null) inputTokens = chunk.usage.prompt_tokens
      if (chunk.usage.completion_tokens != null) outputTokens = chunk.usage.completion_tokens
    }
    if (choice.finish_reason === "length") status = "incomplete"
    if (!started) {
      send("response.created", { type: "response.created", response: { ...baseResp } })
      send("response.in_progress", { type: "response.in_progress", response: { ...baseResp } })
      started = true
    }
    // 文本分片（推理 content 之外的正式输出）
    if (typeof delta.content === "string" && delta.content !== "") {
      if (activeItem && activeItem.kind === "tool") closeItem()
      appendText(delta.content)
    }
    // tool_calls 分片（id/name 在首个 chunk，arguments 任意位置分片）
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        const fn = tc.function || {}
        if (activeItem && activeItem.kind === "text") closeItem()
        if (!activeItem || activeItem.kind !== "tool" || activeItem.toolIndex !== idx) {
          openItem("tool", tc.id || "call_" + rand(), fn.name || "function")
          activeItem.toolIndex = idx
        }
        if (typeof fn.arguments === "string" && fn.arguments) appendArgs(fn.arguments)
      }
    }
  }

  const finalize = () => {
    if (!started) {
      send("response.created", { type: "response.created", response: { ...baseResp } })
      send("response.in_progress", { type: "response.in_progress", response: { ...baseResp } })
      started = true
    }
    closeItem()
    send("response.completed", {
      type: "response.completed",
      response: {
        id: respId,
        object: "response",
        created_at: created,
        status,
        model: requestedModel || model,
        output: [],
        parallel_tool_calls: true,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })
    res.write("data: [DONE]\n\n")
    res.end()
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const t = line.trim()
        if (!t) continue
        if (t.startsWith(":")) { res.write(line + "\n"); continue } // keep-alive 注释透传
        if (!t.startsWith("data:")) continue
        const payload = t.slice(5).trim()
        if (!payload) continue
        if (payload === "[DONE]") { finalize(); return }
        let chunk
        try { chunk = JSON.parse(payload) } catch { continue }
        handleChunk(chunk)
      }
    }
    buf += dec.decode()
    finalize()
  } catch (e) {
    // E2（主线程合并）：流中段上游报错 → 发 response.failed 事件让客户端感知（客户端已断开则销毁跳过）
    if (res.destroyed || res.writableEnded) {
      try { res.destroy() } catch {}
      return
    }
    try {
      send("response.failed", {
        type: "response.failed",
        response: {
          id: respId,
          object: "response",
          created_at: created,
          status: "failed",
          model: requestedModel || model,
          output: [],
          error: { code: "upstream_stream_interrupted", message: String(e && e.message || e) },
        },
      })
    } catch {}
    try { res.destroy() } catch {}
  }
}

function sendResponsesError(res, status, _body, message) {
  sendJson(res, status, { error: { type: "api_error", message: String(message || "upstream error") } })
}

/** 共享逻辑：把 Responses 形状的 bodyObj 上游发送 + 响应转回 Responses 格式（/v1/responses 与 cursor 检测分支复用） */
async function handleResponsesBody(res, bodyObj) {
  const requestedModel = bodyObj.model
  const isStream = !!bodyObj.stream
  const openaiBody = responsesToOpenAI(bodyObj)
  const out = await safeSend(openaiBody, isStream, undefined, "responses")
  if (out.error) {
    const m = out.error.body && ((out.error.body.error && out.error.body.error.message) || out.error.body.message)
    return sendResponsesError(res, out.error.status, out.error.body, m || "no key configured")
  }
  const upstream = out.res
  const mappedModel = out.mappedModel
  if (isStream) {
    if (upstream.ok) return streamResponses(res, upstream, mappedModel, requestedModel)
    const err = parseErrorBody(out.bodyText)
    return sendResponsesError(res, upstream.status, err, (err.error && err.error.message) || err.message || "upstream error")
  }
  if (!upstream.ok) {
    const err = parseErrorBody(out.bodyText)
    return sendResponsesError(res, upstream.status, err, (err.error && err.error.message) || err.message || "upstream error")
  }
  const text = out.bodyText || (await upstream.text())
  let openaiRes
  try { openaiRes = JSON.parse(text) } catch { return sendResponsesError(res, 502, null, "bad upstream response") }
  return sendJson(res, 200, openAIToResponse(openaiRes, mappedModel, requestedModel))
}

async function handleResponses(req, res) {
  const raw = await readBody(req, res)
  if (raw === null) return
  let bodyObj
  try { bodyObj = raw ? JSON.parse(raw) : {} } catch { return sendResponsesError(res, 400, null, "invalid JSON body") }
  return handleResponsesBody(res, bodyObj)
}

const allModelIds = () =>
  [...new Set([...dynamicFor(ACTIVE_PLAN.id), ...ACTIVE_PLAN.builtinModels])].sort()

const handleModels = (res) =>
  sendJson(res, 200, {
    object: "list",
    data: allModelIds().map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "opencode-zen-gateway",
    })),
  })

const handleModelsRefresh = async (res) => {
  const n = await refreshDynamicModels()
  return sendJson(res, 200, {
    ok: true,
    dynamic: dynamicFor(ACTIVE_PLAN.id).length,
    builtin: ACTIVE_PLAN.builtinModels.length,
    added: n,
    go: DYNAMIC_GO.length,
    zen: DYNAMIC_ZEN.length,
  })
}

const handleUsage = (res) => {
  const cfg = loadConfig()
  return sendJson(res, 200, usageSnapshot(cfg))
}

/** GET /api/usage/trend — 从持久化 usage.jsonl 聚合历史趋势（与 /api/usage 内存计数互补）。
 * query: ?days=N（默认 7，仅聚合近 N 天；非法回退 7，上限 3650 防内存滥用）、?key=NAME（可选筛选）。
 * 文件不存在 → 空结构 200（不是 404）。每次请求实时重读（文件 ≤5000 行，同步读开销可忽略）。 */
const handleUsageTrend = (res, url) => {
  const rawDays = url.searchParams.get("days")
  let days = 7
  if (rawDays !== null && rawDays !== "") {
    const n = Number(rawDays)
    days = Number.isInteger(n) && n > 0 ? Math.min(n, 3650) : 7
  }
  const key = url.searchParams.get("key") || undefined
  const lines = readUsageFile(USAGE_FILE)
  return sendJson(res, 200, aggregateUsage(lines, { days, key }))
}

const server = http.createServer(async (req, res) => {
  if (!gatewayAuth(req)) {
    log(`⛔  鉴权失败 ${req.method} ${req.url}`)
    return sendJson(res, 401, { error: { message: "unauthorized" } })
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const route = url.pathname
  const method = req.method

  if (method === "GET" && route === "/healthz") {
    const cfg = loadConfig()
    return sendJson(res, 200, {
      ok: true,
      keys: cfg.keys.length,
      available: cfg.keys.filter((k) => !k.cooldown_until_gateway || Date.parse(k.cooldown_until_gateway) <= Date.now()).length,
      current: cfg.current_gateway ?? cfg.current,
      defaultModel: DEFAULT_MODEL,
      rotations: usageStats.rotations,
    })
  }
  if ((method === "GET" || method === "OPTIONS") && route === "/v1/models") {
    if (method === "OPTIONS") return res.writeHead(204).end()
    return handleModels(res)
  }
  if (method === "POST" && route === "/v1/models/refresh") {
    return handleModelsRefresh(res)
  }
  if (method === "GET" && route === "/api/usage") {
    return handleUsage(res)
  }
  if (method === "GET" && route === "/api/usage/trend") {
    return handleUsageTrend(res, url)
  }
  if (method === "GET" && route === "/api/gateway/status") {
    return sendJson(res, 200, gatewayStatusSummary(loadConfig()))
  }
  if (method === "GET" && route === "/api/gateway/log") {
    return sendJson(res, 200, getLogRing())
  }
  if (method === "GET" && route === "/api/gateway/models") {
    return sendJson(res, 200, gatewayModelsSummary())
  }
  if (method === "GET" && route === "/api/gateway/config") {
    return sendJson(res, 200, gatewayConfigSummary(loadConfig(), readRawConfig()))
  }
  if (method === "POST" && route === "/api/gateway/egress/health") {
    // 出口池健康检查：真实最小探测每出口（HTTP 状态可判别限流；不改配置/不轮换）。?index=N 只测单个 / ?url=xxx 测指定出口。
    let onlyIndex = null
    const idx = url.searchParams.get("index")
    if (idx != null) {
      onlyIndex = Number(idx)
      if (!Number.isInteger(onlyIndex) || onlyIndex < 0) onlyIndex = null
    }
    const expectUrl = url.searchParams.get("url")
    try {
      return sendJson(res, 200, await egressHealthCheck(onlyIndex, expectUrl))
    } catch (e) {
      log(`⚠️  egress 健康检查失败: ${e.message}`)
      return sendJson(res, 500, { error: e.message })
    }
  }
  if (method === "POST" && route === "/v1/chat/completions") {
    log(`➡️  POST /v1/chat/completions`)
    return handleChatCompletions(req, res)
  }
  if (method === "POST" && route === "/v1/messages") {
    log(`➡️  POST /v1/messages`)
    return handleMessages(req, res)
  }
  if (method === "POST" && route === "/v1/responses") {
    log(`➡️  POST /v1/responses`)
    return handleResponses(req, res)
  }
  if (method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    })
    return res.end()
  }
  return sendJson(res, 404, { error: { message: `not found: ${method} ${route}` } })
})

/* ---------------- 主动探测（尽力而为的配额保活） ----------------
 * opencode zen 无公开配额 API，只能发最小请求探测当前 key 是否仍可用。
 * 仅 ZEN_PROBE_INTERVAL_MIN 显式设置且 >0 时启用（0/未设 = 完全关闭，不影响既有行为）。
 * 与请求路径并发安全：rotate() 内部已有 withLockAsync 锁。探测失败静默（只 log 不轮换，除非配额错误）。 */
let _probeRunning = false
async function probeCurrentKey() {
  if (_probeRunning) return
  _probeRunning = true
  try {
    const cfg = loadConfig()
    const key = currentKey(cfg)
    if (!key) {
      log(`⏱️  主动探测：无可用 key，跳过`)
      return
    }
    const probeModel = ACTIVE_PLAN.defaultModel // 探测模型随套餐变（go 档 hy3 / zen 档 hy3-free，research §1.2 别混用）
    const probeBody = JSON.stringify({
      model: probeModel,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    })
    log(`⏱️  主动探测 key "${key.name}"（model=${probeModel} max_tokens=1）...`)
    const { res, bodyText } = await upstreamOnce(key.key, probeBody, false, PROBE_TIMEOUT_MS)
    if (res.ok) {
      log(`⏱️  主动探测 key "${key.name}" 正常（status=${res.status}）`)
      return
    }
    if (isQuotaError(res.status, parseErrorBody(bodyText))) {
      const errBody = parseErrorBody(bodyText)
      log(`⏱️  主动探测 key "${key.name}" 配额耗尽（status=${res.status}），触发轮换`)
      const cfg2 = await rotate(errBody, res.status, key.name)
      const newKey = currentKey(cfg2)
      if (newKey && newKey.name !== key.name) log(`⏱️  主动探测后已轮换到 key "${newKey.name}"`)
      else log(`⏱️  主动探测轮换未完成（无可用新 key）`)
      return
    }
    log(`⏱️  主动探测 key "${key.name}" 非配额错误（status=${res.status}），不轮换`)
  } catch (e) {
    log(`⏱️  主动探测异常（静默）: ${e.message}`)
  } finally {
    _probeRunning = false
  }
}
function startActiveProbe() {
  if (!PROBE_INTERVAL_MS) {
    if (process.env.ZEN_PROBE_INTERVAL_MIN) {
      log(`⏱️  主动探测已关闭（ZEN_PROBE_INTERVAL_MIN=0）`)
    }
    return
  }
  log(`⏱️  主动探测已启用：每 ${PROBE_INTERVAL_MS / 1000}s 探测当前 key`)
  setInterval(probeCurrentKey, PROBE_INTERVAL_MS)
}

/* ---------------- 启动 ---------------- */

const PORT = Number(process.env.ZEN_GATEWAY_PORT || DEFAULT_PORT)
const HOST = process.env.ZEN_GATEWAY_HOST || DEFAULT_HOST

// S6：非 loopback 且未设 token → 拒绝启动（避免成为内网开放代理烧配额）。
// 空串 token 视为未设置（S2 语义）。ZEN_ALLOW_OPEN_NOSEC=1 可显式绕过（有风险）。
const isLoopback = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1" || HOST === "::" || HOST === "0:0:0:0:0:0:0:1"
if (!isLoopback && !ACTIVE_TOKEN && process.env.ZEN_ALLOW_OPEN_NOSEC !== "1") {
  const msg =
    `zen-gateway: 拒绝启动 —— HOST=${HOST} 非回环地址且未设置 ZEN_GATEWAY_TOKEN。` +
    `内网开放必须设置鉴权 token，否则任何内网主机都能消耗你的 key 配额。` +
    `如确需无鉴权开放（有风险），可设 ZEN_ALLOW_OPEN_NOSEC=1 显式绕过。`
  console.error(msg)
  log(`⛔  拒绝启动：非 loopback HOST=${HOST} 且未设 token`)
  process.exit(1)
}

// ZEN_TEST=1（单元测试）时跳过 listen，仅导出纯函数供测试 import；正常启动路径完全不变
if (!process.env.ZEN_TEST) {
  server.listen(PORT, HOST, () => {
    const cfg = loadConfig()
    log(
      `🚀  zen-gateway 启动 http://${HOST}:${PORT}  默认模型=${DEFAULT_MODEL}  key数=${cfg.keys.length}  ` +
        `当前=${cfg.current_gateway}  config=${CONFIG_FILE}  auth=${AUTH_FILE}`,
    )
    console.log(`zen-gateway listening on http://${HOST}:${PORT}`)
    console.log(`  POST /v1/chat/completions   POST /v1/messages   POST /v1/responses   GET /v1/models   GET /healthz`)
    console.log(`  default model: ${DEFAULT_MODEL}   keys: ${cfg.keys.length}   current: ${cfg.current_gateway}`)
    if (ACTIVE_TOKEN) console.log(`  auth: Bearer ${maskToken(ACTIVE_TOKEN)}（已掩码）`)
    else console.log(`  auth: none (仅绑定 ${HOST})`)
    // M3：启动即异步拉取上游模型表（失败静默降级为内置表，不阻塞启动）
    refreshDynamicModels()
    seedUsageCount()
    log(`📊  用量趋势文件: ${USAGE_FILE}`)
    startActiveProbe()
  })
}

server.on("error", (e) => {
  log(`❌  zen-gateway 启动失败: ${e.message}`)
  console.error(`zen-gateway failed to start: ${e.message}`)
  process.exit(1)
})

// 兜底：任何未捕获的异步异常（如上游超时 AbortError 外泄）只记日志，绝不崩进程
process.on("unhandledRejection", (err) => {
  log(`⚠️  unhandledRejection: ${err && err.name} ${err && err.message}`)
})
process.on("uncaughtException", (err) => {
  log(`⚠️  uncaughtException: ${err && err.name} ${err && err.message}`)
})

/* ---------------- 测试导出钩子 ----------------
 * 说明：本文件是 ESM（.mjs），`module.exports` 会抛 ReferenceError（已实测），
 * 因此用顶层命名 export。直接运行 `node gateway.mjs` 时导出是惰性的、不影响行为；
 * `ZEN_TEST=1` 时跳过 listen（见上），测试可 import 这些纯函数且不启动服务器。
 * 纯函数实现一律未改动；`__setDynamicModels` 是唯一新增的测试钩子（重置运行时动态模型表）。 */

/* ---------------- /api/gateway/* 只读管理端点组装纯函数 ----------------
 * 路由只负责 sendJson；组装逻辑全部是纯函数（opts/raw 可注入，单测确定性）。
 * 铁律：绝不返回 key 明文（密钥只存在于 loadConfig 内部，config 摘要仅透出 name/cooldown_until）。 */

/** GET /api/gateway/status 响应组装：网关运行态 + 模型清单（不含任何 key 值）。
 *  running 默认 true（端点能被请求到即网关在跑）；port 默认模块 PORT，可注入便于单测。
 *  扩展字段：plan（"go"/"zen" 当前套餐）、authEnabled（ACTIVE_TOKEN 非空 = 鉴权开）。 */
function gatewayStatusSummary(cfg, opts = {}) {
  return {
    running: opts.running !== false,
    version: GATEWAY_VERSION,
    port: opts.port ?? PORT,
    plan: ACTIVE_PLAN.id,
    defaultModel: ACTIVE_PLAN.defaultModel,
    authEnabled: ACTIVE_TOKENS.length > 0,
    tokenCount: ACTIVE_TOKENS.length,
    modelCount: ACTIVE_PLAN.builtinModels.length,
    keys: Array.isArray(cfg?.keys) ? cfg.keys.length : 0,
    current: cfg?.current_gateway ?? cfg?.current ?? "",
    usageFile: USAGE_FILE,
    upstreamBase: ACTIVE_PLAN.upstreamBase,
    models: [...ACTIVE_PLAN.builtinModels],
  }
}

/** 模型 ID 排序去重合并（动态 ∪ 内置）。 */
function sortedModelUnion(dyn, built) {
  return [
    ...new Set([...(Array.isArray(dyn) ? dyn : []), ...(Array.isArray(built) ? built : [])]),
  ].sort()
}

/** GET /api/gateway/models 响应组装：go + zen 双套餐模型（各自动态 ∪ 内置）+ 别名映射（拷贝，防污染模块常量）。
 *  models 字段保持向后兼容 = 当前套餐合并清单（旧客户端不破坏）；plans 为新增双套餐明细（Web 动态查看用）。 */
function gatewayModelsSummary() {
  return {
    active: ACTIVE_PLAN.id,
    models: sortedModelUnion(dynamicFor(ACTIVE_PLAN.id), ACTIVE_PLAN.builtinModels),
    aliases: { ...MODEL_ALIAASES },
    plans: {
      go: { id: "go", dynamic: [...DYNAMIC_GO], builtin: [...ZEN_MODELS], models: sortedModelUnion(DYNAMIC_GO, ZEN_MODELS) },
      zen: { id: "zen", dynamic: [...DYNAMIC_ZEN], builtin: [...ZEN_MODELS_ZEN], models: sortedModelUnion(DYNAMIC_ZEN, ZEN_MODELS_ZEN) },
    },
  }
}

/** GET /api/gateway/config 响应组装：只读配置摘要。keys 仅含 name/cooldown_until_gateway（网关域冷却，与 current 域一致；绝不含 key 明文）。
 *  raw 为 go-keys.json 原始 JSON（readRawConfig），用于透传 loadConfig 未携带的扩展字段 auto_web。 */
function gatewayConfigSummary(cfg, raw = null) {
  const keys = Array.isArray(cfg?.keys)
    ? cfg.keys.map((k) => ({ name: k.name, cooldown_until_gateway: k.cooldown_until_gateway ?? null }))
    : []
  const autoWeb =
    raw && typeof raw === "object" && typeof raw.auto_web === "boolean" ? raw.auto_web : undefined
  return {
    cooldownMinutes: cfg?.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN,
    current: cfg?.current_gateway ?? cfg?.current ?? "",
    keys,
    ...(autoWeb !== undefined ? { autoWeb } : {}),
  }
}

/* ---------------- /api/usage/trend 聚合纯函数 ----------------
 * 与 usage-report.mjs 同语义（UTC 归日 / 坏行跳过 / 空行不算坏行），供 HTTP 端点与单测共用。
 * 纯函数：不读文件、不碰全局，`opts.now` 可注入保证测试确定性。 */

/** ISO 日期字符串 → UTC 日期键 "YYYY-MM-DD"（Date 归一，兼容带时区偏移的 ISO，如 +08:00 自动折算） */
function utcDateKey(isoStr) {
  return new Date(isoStr).toISOString().slice(0, 10)
}

/** 生成近 N 天（含今天）的 UTC 日期键数组，升序 */
function windowDays(days, now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const out = []
  for (let i = days - 1; i >= 0; i--) out.push(new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10))
  return out
}

/**
 * 聚合 usage.jsonl 行 → 趋势结构。坏行（非 JSON / 缺 key/ts / 时间不可解析）跳过计 badLines；
 * 空行跳过不计坏行（文件末尾换行属正常）。days 窗口只统计近 N 天；key 精确筛选（可省）。
 * 返回 { total, byKey:{name:{requests,success,fail,rotated,lastTs}}, byDay:{YYYY-MM-DD:{requests,success,rotated}},
 *         byEndpoint:{endpoint:{requests,ok}}, badLines, window:{days,startUtc,endUtc} }
 */
function aggregateUsage(lines, opts = {}) {
  const days = Number.isInteger(opts.days) && opts.days > 0 ? Math.min(opts.days, 3650) : 7
  const keyFilter = typeof opts.key === "string" && opts.key ? opts.key : null
  const window = windowDays(days, opts.now || new Date())
  const daySet = new Set(window)
  const result = { total: 0, byKey: {}, byDay: {}, byEndpoint: {}, badLines: 0, window: { days, startUtc: window[0] + "T00:00:00.000Z", endUtc: window[window.length - 1] + "T23:59:59.999Z" } }
  for (const raw of lines) {
    const line = String(raw).trim()
    if (!line) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      result.badLines++
      continue
    }
    if (!rec || typeof rec !== "object" || typeof rec.key !== "string" || typeof rec.ts !== "string") {
      result.badLines++
      continue
    }
    if (keyFilter && rec.key !== keyFilter) continue
    const d = new Date(rec.ts)
    if (Number.isNaN(d.getTime())) {
      result.badLines++
      continue
    }
    const day = utcDateKey(rec.ts)
    if (!daySet.has(day)) continue // days 窗口过滤
    const ok = rec.ok === true
    const rotated = rec.rotated === true
    result.total++
    const k = (result.byKey[rec.key] ??= { requests: 0, success: 0, fail: 0, rotated: 0, lastTs: null })
    k.requests++
    if (ok) k.success++
    else k.fail++
    if (rotated) k.rotated++
    if (rec.ts > (k.lastTs ?? "")) k.lastTs = rec.ts // ISO 字符串字典序即时间序
    const dd = (result.byDay[day] ??= { requests: 0, success: 0, rotated: 0 })
    dd.requests++
    if (ok) dd.success++
    if (rotated) dd.rotated++
    const ep = (result.byEndpoint[rec.endpoint || "unknown"] ??= { requests: 0, ok: 0 })
    ep.requests++
    if (ok) ep.ok++
  }
  return result
}

/** 读取 usage.jsonl → 行数组；文件不存在/不可读返回空数组（不抛错，调用方无需 try/catch） */
function readUsageFile(filePath) {
  try {
    if (!existsSync(filePath)) return []
    const data = readFileSync(filePath, "utf8")
    return data ? data.split("\n") : []
  } catch {
    return []
  }
}

// 测试钩子：重置运行时动态模型表（mapModel / allModelIds 依赖的模块顶层 let，仅测试用）。
// planId 缺省 = 同时设置两套餐（沿用旧语义）；指定 "go"/"zen" 只设置该套餐（测双档差异化）。
const __setDynamicModels = (list, planId = null) => {
  const l = Array.isArray(list) ? list : []
  if (planId === "go") {
    DYNAMIC_GO = l
    return
  }
  if (planId === "zen") {
    DYNAMIC_ZEN = l
    return
  }
  DYNAMIC_GO = l
  DYNAMIC_ZEN = l
}

export {
  parseResetTime,
  isQuotaStatus,
  isQuotaError,
  shouldRotateForError,
  resolveUpstreamUA,
  truncationRetryPlan,
  classifyGoError,
  mapModel,
  pickNext,
  currentKey,
  cooldownUntilDefault,
  maskToken,
  resolveTokens,
  gatewayAuth,
  parseErrorBody,
  combineSignals,
  anthropicToOpenAI,
  openAIToAnthropic,
  responsesToOpenAI,
  openAIToResponse,
  allModelIds,
  aggregateUsage,
  readUsageFile,
  utcDateKey,
  windowDays,
  rotate,
  syncAuth,
  AUTH_FILE,
  __setDynamicModels,
  log,
  getLogRing,
  LOG_RING_MAX,
  gatewayStatusSummary,
  gatewayConfigSummary,
  gatewayModelsSummary,
  sortedModelUnion,
  dynamicFor,
  DYNAMIC_GO,
  DYNAMIC_ZEN,
  loadConfig,
  readRawConfig,
  readGatewayConfig,
  resolvePlan,
  resolveToken,
  ACTIVE_PLAN,
  ACTIVE_TOKEN,
  PLANS,
  GATEWAY_CONFIG,
  ZEN_MODELS_ZEN,
  parseEgressList,
  parseSocks5Url,
  socks5Request,
  parseHead,
  currentEgress,
  rotateEgress,
  egressSucceeded,
  egressSnapshot,
  egressHealthCheck,
  egressEnabled,
  egressList,
}