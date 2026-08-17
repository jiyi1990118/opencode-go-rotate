/**
 * go-rotate：opencode-go 多 key 自动轮换插件 + Web 管理界面
 *
 * 功能：
 *   - chat.headers：对 opencode-go 的每次请求注入当前 key 的 Authorization
 *     （已用 spike 验证：该 header 会覆盖 SDK 自带 key，无需重启即可热切换）
 *   - event：监听 session.error，当 opencode-go 配额耗尽 / 401 / 402 / 429 时自动轮换
 *   - 冷却：按滚动窗口让用尽的 key 冷却（默认 300 分钟，可从错误消息解析 reset 时间）
 *   - 持久化：状态写入 go-keys.json，并同步写 auth.json，保证其它路径 / 重启后一致
 *   - Web UI：http://localhost:8899 动态配置 key（只启动一个实例，多 TUI 进程不会重复启动）
 *   - 并发安全：所有配置写入走跨进程文件锁 + 原子写（tmp+rename）
 *
 * 安装：~/.config/opencode/plugins/go-rotate.ts（自动加载）
 * 配置：~/.config/opencode/go-keys.json
 * 日志：/tmp/opencode-go-rotate.log
 * Web： http://localhost:8899
 */
import {
  homedir,
} from "node:os"
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
import path from "node:path"
// 同步执行管理脚本（zen-gateway start/stop/restart/logs）：管理操作低频，同步调用可被
// withLockSync 直接包裹（异步 execFile 无法在同步锁内）。bun 兼容 node:child_process。
import { execFileSync } from "node:child_process"
// 网关访问 token 生成（crypto.randomBytes(32) → 64 hex）；bun 兼容 node:crypto
import { randomBytes } from "node:crypto"

// 测试隔离：bun 的 homedir() 不尊重 $HOME（实测固定返回真实 home），故支持环境变量覆盖。
// 生产环境不设这两个变量，行为与之前完全一致。
const DATA_DIR = path.join(homedir(), ".config", "opencode")
const CONFIG_FILE = process.env.GOROTATE_CONFIG_FILE ?? path.join(DATA_DIR, "go-keys.json")
const AUTH_FILE = process.env.GOROTATE_AUTH_FILE ?? path.join(homedir(), ".local", "share", "opencode", "auth.json")
const LOG_FILE = process.env.GOROTATE_LOG_FILE || "/tmp/opencode-go-rotate.log"
const LOCK_FILE = CONFIG_FILE + ".lock"
// 固定端口用于保证"全系统只启动一个 web"（tui-control 占用 7792-7811，故避开）
// GOROTATE_WEB_PORT 仅供测试/隔离实例覆盖端口；非法值回退默认 8899（生产不设行为不变）
const WEB_PORT = Number(process.env.GOROTATE_WEB_PORT) || 8899
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`
const DEFAULT_COOLDOWN_MIN = 300
// 日志轮转：超过该大小即归档，最多保留 RETENTION 份，旧档删除（防止 /tmp 无限增长）
const LOG_MAX_BYTES = 1024 * 1024 // 1MB
const LOG_KEEP = 3
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 15000

type KeyEntry = {
  name: string
  key: string
  cooldown_until: string | null
  /** 该 key 的独立冷却窗口（分钟）；缺省回退全局 cfg.cooldown_minutes，再回退 DEFAULT_COOLDOWN_MIN */
  cooldown_minutes?: number
  /** 最近一次探测/轮换得到的健康状态：ok | invalid | nobalance | limited | error | null */
  last_status?: string | null
}
type Config = {
  provider_id: string
  cooldown_minutes: number
  current: string
  keys: KeyEntry[]
  /** 是否随 opencode 启动自动起 Web；false 时轮换仍可用，仅不占用端口 */
  auto_web?: boolean
}

/* ---------------- 日志 ---------------- */

/** 超大小则轮转归档，保留最近 LOG_KEEP 份，删除最旧的 */
function rotateLogIfNeeded() {
  try {
    if (!existsSync(LOG_FILE)) return
    if (statSync(LOG_FILE).size < LOG_MAX_BYTES) return
    // 移位归档：.log.2 -> .log.3 ... 删除超出保留份数的
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

const log = (m: string) => {
  try {
    rotateLogIfNeeded()
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${m}\n`)
  } catch {}
}

/* ---------------- 文件锁（跨进程，避免并发写竞态） ---------------- */

function withLockSync<T>(fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = openSync(LOCK_FILE, "wx")
      closeSync(fd)
      break
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e
      // 检查是否陈旧锁（持有进程崩溃后残留）
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

function atomicWrite(file: string, data: string, mode?: number) {
  const tmp = file + ".tmp"
  writeFileSync(tmp, data, { encoding: "utf8", mode })
  renameSync(tmp, file)
}

/* ---------------- 配置读写 ---------------- */

function loadConfig(): Config {
  try {
    const raw = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : "{}"
    const cfg = JSON.parse(raw)
    const keys = (Array.isArray(cfg.keys) ? cfg.keys : []).filter(
      (k: any) => k && typeof k.name === "string" && typeof k.key === "string",
    )
    const out: any = {
      provider_id: cfg.provider_id ?? "opencode-go",
      cooldown_minutes: cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN,
      current: cfg.current ?? "",
      keys,
      auto_web: cfg.auto_web !== false,
    }
    // 保留其它扩展字段（mutateConfig 往返不能丢自定义顶层字段）
    for (const k of Object.keys(cfg)) {
      if (!(k in out)) out[k] = cfg[k]
    }
    return out
  } catch (e) {
    log(`loadConfig error: ${(e as Error).message}`)
    return { provider_id: "opencode-go", cooldown_minutes: DEFAULT_COOLDOWN_MIN, current: "", keys: [], auto_web: true }
  }
}

function saveConfig(cfg: Config) {
  mkdirSync(DATA_DIR, { recursive: true })
  atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function syncAuth(key: string) {
  try {
    const data = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {}
    const auth = data["opencode-go"]
    if (auth && typeof auth === "object" && !Array.isArray(auth)) {
      auth.key = key
    } else {
      data["opencode-go"] = { type: "api", key }
    }
    atomicWrite(AUTH_FILE, JSON.stringify(data, null, 2), 0o600)
  } catch (e: any) {
    log(`⚠️  syncAuth 失败（auth.json 损坏？）: ${e.message}`)
  }
}

/** 在锁内执行一次配置变更，返回新的配置 */
function mutateConfig(fn: (cfg: Config) => void): Config {
  return withLockSync<Config>(() => {
    const cfg = loadConfig()
    fn(cfg)
    reconcileCurrent(cfg)
    saveConfig(cfg)
    return cfg
  })
}

/** 自愈：若 current 指向不存在的 name，则回退到第一个 key */
function reconcileCurrent(cfg: Config) {
  if (!cfg.keys.some((k) => k.name === cfg.current)) {
    cfg.current = cfg.keys[0]?.name ?? ""
  }
}

function currentKey(cfg: Config): KeyEntry | undefined {
  return cfg.keys.find((k) => k.name === cfg.current) ?? cfg.keys[0]
}

/** 计算冷却到期时间：key 有独立窗口用它的，否则用全局窗口，再回退 DEFAULT_COOLDOWN_MIN */
function cooldownUntilDefault(cfg: Config, key?: KeyEntry): string {
  const minutes = key?.cooldown_minutes ?? cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN
  return new Date(Date.now() + minutes * 60_000).toISOString()
}

/** 从配额错误消息解析 "reset at <time>"，含时区偏移；解析失败返回 null */
function parseResetTime(msg: string): string | null {
  // 偏移支持 +0800 / +08:00 / Z；无偏移按本地时区解释（保持既有行为）。
  // 2026-08-16 修复：旧正则只捕获 [+-]\d{4}，+08:00 与 Z 会被剥离后按本地时区
  // 解析（非 +8 时区或 Z 后缀会解析错 8 小时），改为显式捕获 Z | ±HH:MM 并原样传给 Date.parse。
  const m = String(msg).match(
    /reset at\s+(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})(?:\s*(Z|[+-]\d{2}:?\d{2}))?/i,
  )
  if (!m) return null
  const t = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}`)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function isQuotaError(err: any): boolean {
  if (!err) return false
  const data = err.data ?? {}
  const msg = String(data.message ?? "").toLowerCase()
  const status = data.statusCode
  const quotaWords = /quota|insufficient|balance|rate.?limit|usage limit|exceeded|配额|余额|限流|超出/i
  const quotaStatus = status === 401 || status === 402 || status === 429
  return quotaStatus || quotaWords.test(msg)
}

/** 把 opencode-go 错误分类为健康状态：ok | invalid | nobalance | limited | error */
function classifyGoError(msg: string, statusCode?: number): string {
  const s = String(msg).toLowerCase()
  if (statusCode === 401 && /invalid api key/i.test(s)) return "invalid"
  if (statusCode === 401 || statusCode === 402 || /insufficient|balance/i.test(s)) return "nobalance"
  if (statusCode === 429 || /quota|rate|limit|exceeded/i.test(s)) return "limited"
  return "error"
}

/** 判断错误是否来自 opencode-go 端点（避免误伤其它 provider） */
function isGoError(err: any): boolean {
  if (!err) return false
  const data = err.data ?? {}
  if (err.name === "ProviderAuthError" && String(data.providerID ?? "").includes("opencode")) return true
  const url = String(data.metadata?.url ?? data.url ?? "")
  if (/opencode\.ai\/(zen|go)/i.test(url) || /zen\/go/i.test(url)) return true
  // responseBody 是 API 原始响应，仅当其中明确出现 opencode go 端点特征才判定
  const body = String(data.responseBody ?? "")
  return /"opencode/i.test(body) || /opencode\.ai\/zen/i.test(body)
}

function pickNext(cfg: Config): KeyEntry | undefined {
  const now = Date.now()
  const ordered = cfg.keys
  const startIdx = ordered.findIndex((k) => k.name === cfg.current)
  for (let i = 1; i <= ordered.length; i++) {
    const k = ordered[(startIdx + i) % ordered.length]
    if (!k) continue
    if (!k.cooldown_until || Date.parse(k.cooldown_until) <= now) return k
  }
  return undefined
}

/** 轮换（锁内执行）：当前 key 进冷却，切换到下一个可用 key */
function rotate(errMsg: string, err?: any): Config {
  return mutateConfig((cfg) => {
    const cur = currentKey(cfg)
    if (cur) {
      cur.cooldown_until = parseResetTime(errMsg) ?? cooldownUntilDefault(cfg, cur)
      cur.last_status = classifyGoError(errMsg, err?.data?.statusCode)
      log(`⚠️  key "${cur.name}" 配额耗尽（${cur.last_status}），进入冷却 until=${cur.cooldown_until}`)
    }
    const next = pickNext(cfg)
    if (!next) {
      log(`❌  没有可用 key（全部在冷却期），维持当前 key "${cfg.current}"`)
      return
    }
    cfg.current = next.name
    const nk = currentKey(cfg)
    if (nk) nk.last_status = null
    syncAuth(next.key)
    log(`✅  轮换到 key "${next.name}"，已同步 auth.json`)
  })
}

/** 手动轮换到下一个可用 key（web/CLI 用） */
function manualRotate(): Config {
  return mutateConfig((cfg) => {
    const next = pickNext(cfg)
    if (!next) {
      log(`❌  手动轮换：没有可用 key，保持当前`)
      return
    }
    cfg.current = next.name
    syncAuth(next.key)
    log(`🔄  手动轮换到 key "${next.name}"`)
  })
}

/** 设置当前 key（web/CLI 用） */
function setCurrent(name: string): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    cfg.current = k.name
    syncAuth(k.key)
    log(`🎯  手动设置当前 key 为 "${k.name}"`)
  })
}

/** 新增 key */
function addKey(name: string, key: string): Config {
  return mutateConfig((cfg) => {
    if (cfg.keys.some((x) => x.name === name)) throw new Error(`key "${name}" 已存在`)
    cfg.keys.push({ name, key, cooldown_until: null })
    log(`➕  添加 key "${name}"`)
  })
}

/** 更新 key（可改 key 值或名称） */
function updateKey(name: string, patch: { key?: string; name?: string }): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    if (patch.name && patch.name !== name) {
      if (cfg.keys.some((x) => x.name === patch.name)) throw new Error(`key "${patch.name}" 已存在`)
      const wasCurrent = k.name === cfg.current
      k.name = patch.name
      if (wasCurrent) cfg.current = patch.name
    }
    if (patch.key) k.key = patch.key
    log(`✏️  更新 key "${name}"`)
  })
}

/** 删除 key；若删除的是当前 key，则回退到下一个可用 */
function removeKey(name: string): Config {
  return mutateConfig((cfg) => {
    const idx = cfg.keys.findIndex((x) => x.name === name)
    if (idx < 0) throw new Error(`key "${name}" 不存在`)
    cfg.keys.splice(idx, 1)
    log(`🗑️  删除 key "${name}"`)
  })
}

/** 设置/清除冷却 */
function setCooldown(name: string, minutes: number | null): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    if (minutes === null) {
      k.cooldown_until = null
      log(`🧊  清除 key "${name}" 冷却`)
    } else {
      k.cooldown_until = new Date(Date.now() + minutes * 60_000).toISOString()
      log(`🧊  key "${name}" 进入冷却 ${minutes} 分钟`)
    }
  })
}

/** 设置/清除某 key 的独立冷却窗口（分钟）；minutes=null 删除字段，回退全局窗口 */
function setCooldownWindow(name: string, minutes: number | null): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    if (minutes === null) {
      delete k.cooldown_minutes
      log(`🧊  清除 key "${name}" 独立冷却窗口（回退全局 ${cfg.cooldown_minutes} 分钟）`)
    } else {
      if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("独立冷却窗口必须是正整数分钟")
      k.cooldown_minutes = minutes
      log(`🧊  key "${name}" 独立冷却窗口设为 ${minutes} 分钟`)
    }
  })
}

/** 设置全局冷却窗口（分钟），必须为正整数 */
function setGlobalCooldown(minutes: number): Config {
  return mutateConfig((cfg) => {
    if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("冷却窗口必须是正整数分钟")
    cfg.cooldown_minutes = minutes
    log(`🧊  全局冷却窗口设为 ${minutes} 分钟`)
  })
}

/* ---------------- 状态视图（给 web/日志用） ---------------- */

function statusPayload() {
  const cfg = loadConfig()
  const now = Date.now()
  const keys = cfg.keys.map((k) => {
    let state: string
    let remainMin = 0
    if (k.cooldown_until) {
      const t = Date.parse(k.cooldown_until)
      if (t > now) {
        state = "cooling"
        remainMin = Math.ceil((t - now) / 60_000)
      } else {
        state = "available"
      }
    } else {
      state = "available"
    }
    return {
      name: k.name,
      key: k.key,
      masked: k.key.slice(0, 8) + "…" + k.key.slice(-4),
      state,
      remainMin,
      cooldown_until: k.cooldown_until,
      cooldown_minutes: k.cooldown_minutes ?? null,
      last_status: k.last_status ?? null,
      isCurrent: k.name === cfg.current,
    }
  })
  return {
    provider_id: cfg.provider_id,
    cooldown_minutes: cfg.cooldown_minutes,
    current: cfg.current,
    auto_web: cfg.auto_web !== false,
    keyCount: cfg.keys.length,
    availableCount: keys.filter((k) => k.state === "available").length,
    keys,
  }
}

function logTail(n = 200): string {
  try {
    if (!existsSync(LOG_FILE)) return "(no log)"
    return readFileSync(LOG_FILE, "utf8").split("\n").slice(-n).join("\n")
  } catch {
    return "(log unavailable)"
  }
}

/** 清空当前日志并删除归档（web 手动清理用） */
function clearLog() {
  try {
    if (existsSync(LOG_FILE)) writeFileSync(LOG_FILE, "")
    for (let i = 1; i <= LOG_KEEP; i++) {
      const f = `${LOG_FILE}.${i}`
      if (existsSync(f)) unlinkSync(f)
    }
    log("🧹 日志已手动清空")
    return true
  } catch {
    return false
  }
}

/* ---------------- 轮换统计（对齐 CLI `go-rotate stats` 正则，纯函数便于测试） ----------------
 * 注意：只统计主日志文件（/tmp/opencode-go-rotate.log），归档轮转文件不计；
 * 日志保留窗口有限，统计是「近期」而非全历史（与 CLI stats 一致）。
 */
function parseStatsLog(text: string): {
  totalRotations: number
  byKey: Record<string, { rotations: number; coolings: number; lastRotate: string | null }>
} {
  const byKey: Record<string, { rotations: number; coolings: number; lastRotate: string | null }> = {}
  let totalRotations = 0
  const rotRe = /轮换到 key "([^"]+)"/g
  const coolRe = /key "([^"]+)" 配额耗尽/g
  const tsRe = /^\[([^\]]+)\]/
  let m: RegExpExecArray | null
  rotRe.lastIndex = 0
  while ((m = rotRe.exec(text))) {
    const name = m[1]
    const k = (byKey[name] ??= { rotations: 0, coolings: 0, lastRotate: null })
    k.rotations++
    totalRotations++
    // 时间戳取自匹配所在行的行首 [ISO]
    const lineStart = text.lastIndexOf("\n", m.index - 1) + 1
    const lineEnd = text.indexOf("\n", m.index)
    const line = lineEnd < 0 ? text.slice(lineStart) : text.slice(lineStart, lineEnd)
    const t = tsRe.exec(line)
    if (t) k.lastRotate = t[1]
  }
  coolRe.lastIndex = 0
  while ((m = coolRe.exec(text))) {
    const name = m[1]
    const k = (byKey[name] ??= { rotations: 0, coolings: 0, lastRotate: null })
    k.coolings++
  }
  return { totalRotations, byKey }
}

/* ---------------- zen-gateway 跨进程状态（只读，2s 超时，失败优雅降级） ---------------- */

// 生产默认 18888；测试可用 GOROTATE_GATEWAY_BASE 指向不可达端口验证降级
const GATEWAY_BASE = process.env.GOROTATE_GATEWAY_BASE ?? "http://127.0.0.1:18888"
// zen-gateway 管理脚本（bash）。GOROTATE_GATEWAY_CTL 仅供测试隔离覆盖（生产不设行为不变）
const GATEWAY_CTL = process.env.GOROTATE_GATEWAY_CTL ?? path.join(homedir(), ".local", "bin", "zen-gateway")
// 管理操作（start 含 15s 健康等待）与日志读取的超时
const GATEWAY_CTL_TIMEOUT_MS = 20000
// 网关运行时配置（套餐 + token）：独立文件，与 go-keys.json 职责分离（低频静态配置 + 敏感凭据隔离）。
// 文件缺失回退默认（go / 无 token）；GOROTATE_GATEWAY_CONFIG 仅供测试隔离覆盖（生产不设行为不变）
const GATEWAY_CONFIG_FILE =
  process.env.GOROTATE_GATEWAY_CONFIG ??
  path.join(homedir(), ".local", "share", "zen-gateway", "gateway-config.json")
// 套餐元数据（go 订阅 / zen 免费）。modelCount = 内置兜底模型表数量（运行时模型以 /v1/models 为准；
// 免费名单会变，内置表仅兜底）。同一 opencode key 双端点通用，切换只需换上游 base + 默认模型。
const GATEWAY_PLANS = [
  { id: "go", name: "Go 订阅", upstreamBase: "https://opencode.ai/zen/go/v1", defaultModel: "hy3", modelCount: 26 },
  { id: "zen", name: "Zen 免费", upstreamBase: "https://opencode.ai/zen/v1", defaultModel: "hy3-free", modelCount: 7 },
]

/** zen-gateway 管理脚本是否存在（区分「未安装」与「已安装未运行」，供前端灰卡/按钮禁用） */
function gatewayCtlExists(): boolean {
  return existsSync(GATEWAY_CTL)
}

/** 同步执行 zen-gateway 管理脚本（start/stop/restart/logs）。走 withLockSync 跨进程锁，
 * 避免与插件轮换 / CLI 并发写配置。脚本不存在 / 执行失败均容错返回 {ok:false, output}。 */
function runGatewayCtl(args: string[], timeoutMs = GATEWAY_CTL_TIMEOUT_MS): { ok: boolean; output: string } {
  if (!gatewayCtlExists()) {
    return {
      ok: false,
      output: `zen-gateway 管理脚本不存在: ${GATEWAY_CTL}（未安装？用 bash install.sh zen-gateway 安装）`,
    }
  }
  try {
    const out = execFileSync(GATEWAY_CTL, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ok: true, output: String(out).trim() }
  } catch (e: any) {
    const detail = e?.stderr ? String(e.stderr) : String(e?.message ?? e)
    return { ok: false, output: detail.trim() }
  }
}

/** 网关管理操作：start / stop / restart（真实启停 launchd 服务），withLockSync 保护 */
function gatewayManage(action: "start" | "stop" | "restart"): { ok: boolean; output: string } {
  return withLockSync(() => {
    const r = runGatewayCtl([action])
    log(`🛠️  [gateway] ${action} ${r.ok ? "成功" : "失败"}: ${(r.output || "(no output)").slice(0, 200)}`)
    return r
  })
}

/** 网关日志（只读）：优先 gateway 新端点 /api/gateway/log（并行团队已加则直接用），
 * 未就绪回退 zen-gateway logs 300（bash 脚本只读命令）。失败容错，不抛异常。
 * gateway 端点返回 {lines:string[], total}：解析后把 lines join 成纯文本 text（前端直接可读），
 * 同时透传 lines/total 供前端逐行渲染；回退脚本路径 text 本身即纯文本。 */
async function gatewayLog(): Promise<{ ok: boolean; text: string; source: string; lines?: string[]; total?: number }> {
  try {
    const r = await fetch(GATEWAY_BASE + "/api/gateway/log", { signal: AbortSignal.timeout(2000) })
    if (r.ok) {
      const j: any = await r.json().catch(() => null)
      if (j && Array.isArray(j.lines)) {
        const lines = j.lines.map((l: any) => String(l ?? ""))
        return {
          ok: true,
          text: lines.join("\n"),
          lines,
          total: typeof j.total === "number" ? j.total : lines.length,
          source: "gateway",
        }
      }
      // 旧网关/非 {lines,total} 形态：原样纯文本返回（兼容）
      const text = await r.text().catch(() => "")
      if (text && text.length > 0) return { ok: true, text, source: "gateway" }
    }
  } catch {}
  // 回退：管理脚本 logs <n>（只读 tail，默认 100 行，传 300 取更多）
  const r = runGatewayCtl(["logs", "300"], 5000)
  return { ok: r.ok, text: r.output, source: r.ok ? "zen-gateway logs" : "none" }
}

async function gatewayStatus(): Promise<{
  running: boolean
  ctlExists: boolean
  healthz?: any
  usage?: any
  models?: string[]
  modelCount?: number
  version?: string
  error?: string
}> {
  const [h, u, m, s] = await Promise.allSettled([
    fetch(GATEWAY_BASE + "/healthz", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    fetch(GATEWAY_BASE + "/api/usage", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    fetch(GATEWAY_BASE + "/v1/models", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    // 网关只读状态端点：透传 version（旧网关无此端点/字段时缺失，前端容错显示 '—'）
    fetch(GATEWAY_BASE + "/api/gateway/status", { signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
  ])
  const out: any = { running: h.status === "fulfilled", ctlExists: gatewayCtlExists() }
  if (h.status === "fulfilled") out.healthz = h.value
  if (u.status === "fulfilled") out.usage = u.value
  if (m.status === "fulfilled" && Array.isArray(m.value?.data)) {
    out.models = m.value.data.map((x: any) => x?.id).filter(Boolean)
    out.modelCount = out.models.length
  }
  if (s.status === "fulfilled" && typeof s.value?.version === "string") out.version = s.value.version
  if (h.status === "rejected") out.error = String(h.reason?.message ?? h.reason)
  return out
}

/* ---------------- 网关配置（gateway-config.json：套餐 + token） ----------------
 * 独立于 go-keys.json：低频静态配置 + 敏感凭据隔离。写路径走 withLockSync（跨进程锁）
 * + atomicWrite（tmp+rename）+ 0600；只落盘不重启（重启由前端显式调 /api/gateway/restart，
 * 职责分离：用户可先改多个配置项再一次性重启）。
 */
type GatewayConfig = { plan: string; token: string | null; token_set_at: string | null }

function defaultGatewayConfig(): GatewayConfig {
  return { plan: "go", token: null, token_set_at: null }
}

function readGatewayConfig(): GatewayConfig {
  try {
    if (!existsSync(GATEWAY_CONFIG_FILE)) return defaultGatewayConfig()
    const raw = JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf8"))
    return {
      plan: raw.plan === "zen" ? "zen" : "go",
      token: typeof raw.token === "string" && raw.token ? raw.token : null,
      token_set_at: typeof raw.token_set_at === "string" ? raw.token_set_at : null,
    }
  } catch (e) {
    log(`readGatewayConfig error: ${(e as Error).message}`)
    return defaultGatewayConfig()
  }
}

/** 写网关配置（plan / token 至少给一个；token:null = 清除关鉴权）。返回写后配置。 */
function writeGatewayConfig(patch: { plan?: string; token?: string | null }): GatewayConfig {
  return withLockSync<GatewayConfig>(() => {
    const cfg = readGatewayConfig()
    if (patch.plan !== undefined) {
      if (patch.plan !== "go" && patch.plan !== "zen")
        throw new Error(`plan 必须是 "go" 或 "zen"，收到: ${patch.plan}`)
      cfg.plan = patch.plan
    }
    if (patch.token !== undefined) {
      if (patch.token !== null && typeof patch.token !== "string")
        throw new Error("token 必须是字符串或 null（清除）")
      cfg.token = patch.token === null ? null : patch.token
      if (cfg.token === "") throw new Error("token 不能为空字符串（清除请传 null）")
      cfg.token_set_at = new Date().toISOString()
    }
    mkdirSync(path.dirname(GATEWAY_CONFIG_FILE), { recursive: true })
    atomicWrite(GATEWAY_CONFIG_FILE, JSON.stringify(cfg, null, 2), 0o600)
    return cfg
  })
}

/** 掩码 token（前4…后4，复用 maskToken 语义）；空/短串全掩码 */
function maskGatewayToken(t: string): string {
  if (!t) return ""
  if (t.length <= 8) return `${t.slice(0, 2)}...${t.slice(-2)}`
  return `${t.slice(0, 4)}...${t.slice(-4)}`
}

/** 生成网关访问 token：crypto.randomBytes(32).toString("hex") = 64 hex */
function genToken(): string {
  return randomBytes(32).toString("hex")
}

/** GET /api/gateway/config 载荷：token 一律掩码返回，绝不返回明文 */
function gatewayConfigPayload() {
  const cfg = readGatewayConfig()
  return {
    plan: cfg.plan,
    token: cfg.token ? maskGatewayToken(cfg.token) : null,
    authEnabled: !!cfg.token,
    tokenSetAt: cfg.token_set_at,
    needsRestart: false, // GET 只读；needsRestart:true 仅由 POST 写操作返回
  }
}

/** GET /api/gateway/plans 载荷：两档套餐元数据 + 当前套餐 */
function gatewayPlansPayload() {
  return { plans: GATEWAY_PLANS, current: readGatewayConfig().plan }
}

/* ---------------- 每 key 健康探测 ----------------
 * opencode-go 无公开额度查询 API，只能通过发一个最小请求判断 key 是否可用。
 * 注意：每次探测会消耗极少量额度（1 token）。
 */

const GO_API = "https://opencode.ai/zen/go/v1/chat/completions"

async function probeKey(key: string): Promise<{ status: string; detail: string }> {
  try {
    const res = await fetch(GO_API, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "hy3",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15000),
    })
    const text = await res.text()
    if (res.ok) return { status: "ok", detail: "可用" }
    let msg = text
    try {
      msg = JSON.parse(text)?.error?.message ?? text
    } catch {}
    const s = String(msg).toLowerCase()
    if (res.status === 401 && /invalid api key/i.test(s)) return { status: "invalid", detail: msg }
    if (res.status === 401 || res.status === 402 || /insufficient|balance/i.test(s))
      return { status: "nobalance", detail: msg }
    if (res.status === 429 || /quota|rate|limit|exceeded/i.test(s)) return { status: "limited", detail: msg }
    return { status: "error", detail: `${res.status}: ${msg}` }
  } catch (e: any) {
    return { status: "error", detail: `网络错误: ${e.message}` }
  }
}

/** 探测所有 key 的健康状态（只读，不写配置） */
async function checkAllKeys() {
  const cfg = loadConfig()
  const results: Record<string, { status: string; detail: string }> = {}
  for (const k of cfg.keys) {
    results[k.name] = await probeKey(k.key)
  }
  // 持久化探测结果到 last_status，便于状态列展示
  mutateConfig((c) => {
    for (const k of c.keys) {
      const r = results[k.name]
      if (r) k.last_status = r.status
    }
  })
  return results
}

/* ---------------- Web 管理界面 ---------------- */

const json = (obj: any, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } })

let webStarted = false

async function handleWeb(req: any): Promise<Response> {
  const url = new URL(req.url)
  const route = url.pathname
  const method = req.method

  if (method === "GET" && (route === "/" || route === "/index.html")) {
    return new Response(WEB_HTML, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } })
  }
  if (method === "GET" && route === "/api/status") return json(statusPayload())
  if (method === "GET" && route === "/api/log") {
    return new Response(logTail(300), { headers: { "content-type": "text/plain; charset=utf-8" } })
  }
  if (method === "GET" && route === "/api/stats") {
    let text = ""
    try {
      text = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8") : ""
    } catch {}
    return json(parseStatsLog(text))
  }
  if (method === "GET" && route === "/api/gateway") return json(await gatewayStatus())
  if (method === "GET" && route === "/api/gateway/log") return json(await gatewayLog())
  if (method === "GET" && route === "/api/gateway/plans") return json(gatewayPlansPayload())
  if (method === "GET" && route === "/api/gateway/config") return json(gatewayConfigPayload())
  // key 健康探测：仅 POST（GET 会意外触发真实探测消耗配额，防呆 405/404）
  if (method === "POST" && route === "/api/keys/check") {
    return json({ results: await checkAllKeys() })
  }
  // Web 开关：/api/web/off 关闭并停止 server；/api/web/on 开启自动启动
  if (route === "/api/web/off") {
    setAutoWeb(false)
    const res = json({ ok: true, shutting_down: true, auto_web: false })
    // 先让响应发出，再停止 server（否则客户端收不到响应）
    setTimeout(() => stopWeb(), 300)
    return res
  }
  if (route === "/api/web/on") {
    setAutoWeb(true)
    // 基线 ⑧：不仅写 auto_web，若当前 server 未运行则立即拉起（restarted=true）；
    // 端口被其它实例占用时 startWeb 内部健康检查会记录日志且不重复启动（webStarted 仍 false）
    const wasRunning = webStarted
    if (!webStarted) await startWeb()
    return json({ ok: true, auto_web: true, restarted: !wasRunning && webStarted })
  }
  if (method === "POST") {
    try {
      let body: any = {}
      try {
        body = await req.json()
      } catch {}
      const run = () => {
        if (route === "/api/keys/add") return addKey(String(body.name), String(body.key))
        if (route === "/api/keys/update") return updateKey(String(body.name), body.patch ?? {})
        if (route === "/api/keys/delete") return removeKey(String(body.name))
        if (route === "/api/current") return setCurrent(String(body.name))
        if (route === "/api/cooldown")
          return setCooldown(String(body.name), body.minutes === null ? null : Number(body.minutes))
        if (route === "/api/cooldown/window")
          return setCooldownWindow(
            String(body.name),
            body.minutes === null || body.minutes === "" ? null : Number(body.minutes),
          )
        if (route === "/api/settings") return setGlobalCooldown(Number(body.cooldown_minutes))
        if (route === "/api/rotate") return manualRotate()
        if (route === "/api/log/clear") return clearLog()
        // 网关管理：start/stop/restart → {ok, output}，透传不套统一包装
        if (route === "/api/gateway/start") return gatewayManage("start")
        if (route === "/api/gateway/stop") return gatewayManage("stop")
        if (route === "/api/gateway/restart") return gatewayManage("restart")
        // 网关配置（套餐/token）：只写 gateway-config.json 不重启（重启由前端显式调 restart）
        if (route === "/api/gateway/config") {
          if (body.plan === undefined && body.token === undefined)
            throw new Error("至少提供 plan 或 token 之一")
          writeGatewayConfig({
            plan: body.plan === undefined ? undefined : String(body.plan),
            token: body.token === undefined ? undefined : body.token,
          })
          return { ok: true, needsRestart: true }
        }
        return null
      }
      const res = run()
      if (res === null) return json({ error: "unknown route" }, 404)
      // 网关管理返回 {ok, output}，直接透传（含失败信息供前端展示）
      if (route.startsWith("/api/gateway/")) return json(res)
      // 添加 key 后立即探测其状态，返回给前端
      if (route === "/api/keys/add") {
        const health = await probeKey(String(body.key))
        return json({ ok: true, health, status: statusPayload() })
      }
      return json({ ok: res === true || !!res, status: statusPayload() })
    } catch (e: any) {
      return json({ error: e.message }, 400)
    }
  }
  return json({ error: "not found" }, 404)
}

/** 设置是否随 opencode 自动起 Web（web/CLI 用） */
function setAutoWeb(on: boolean): Config {
  return mutateConfig((cfg) => {
    cfg.auto_web = !!on
    log(`🌐 Web 自动启动已${on ? "开启" : "关闭"}（轮换功能不受影响）`)
  })
}

let server: any = null

async function startWeb(force = false) {
  if (webStarted) return
  // 未强制 且 auto_web 关闭 且 未显式强制(GOROTATE_FORCE_WEB) 时，跳过自动启动（轮换仍可用）
  const forced = force || process.env.GOROTATE_FORCE_WEB === "1"
  if (!forced && loadConfig().auto_web === false) {
    log(`🌐 auto_web 已关闭，跳过 Web 启动（轮换功能仍可用）`)
    return
  }
  try {
    // 端口绑定失败即认为已有实例在跑（满足"web 只启动一个"）
    server = Bun.serve({ port: WEB_PORT, fetch: handleWeb })
    webStarted = true
    log(`🌐 Web 管理界面: http://localhost:${WEB_PORT}`)
  } catch {
    // 端口被占用：若占用方是"另一个 go-rotate 的 web"，则静默跳过（只保留一个）
    // 否则是其它程序占用，提示用户处理
    log(`🌐 Web 端口 ${WEB_PORT} 被占用，尝试确认是否为本插件的另一实例…`)
    try {
      const health = await fetch(WEB_BASE + "/api/status")
      if (health.ok) log(`🌐 检测到已有 go-rotate web 实例（http://localhost:${WEB_PORT}），不再重复启动`)
      else log(`⚠️  端口 ${WEB_PORT} 被其它程序占用，web 未启动`)
    } catch {
      log(`⚠️  端口 ${WEB_PORT} 被其它程序占用，web 未启动`)
    }
  }
}

/** 停止当前运行的 web server（web 页面"关闭 Web"用） */
function stopWeb(): boolean {
  try {
    if (server) {
      server.stop(true) // 关闭并断开活动连接
      server = null
      webStarted = false
      log(`🛑 Web 已关闭（端口 ${WEB_PORT} 已释放）`)
      return true
    }
    return false
  } catch {
    return false
  }
}

/* ---------------- 插件主体 ---------------- */

export const GoRotate = async (ctx: any) => {
  log(`go-rotate loaded, dir=${ctx?.directory ?? "?"}`)
  await startWeb()

  // sessionID -> 最近一次使用的 providerID（用于 session.error 时判断是否 go 会话）
  const sessionProvider = new Map<string, string>()
  const PRUNE = () => {
    if (sessionProvider.size > 500) {
      const it = sessionProvider.keys()
      for (let i = 0; i < 200; i++) it.next()
      sessionProvider.delete(it.next().value as string)
    }
  }

  return {
    "chat.headers": async (input: any, output: any) => {
      const pid = typeof input?.model?.providerID === "string" ? input.model.providerID : ""
      const sid = input?.sessionID
      if (!pid || !sid) return
      sessionProvider.set(sid, pid)
      PRUNE()
      if (!pid.includes("opencode")) return
      const key = currentKey(loadConfig())
      if (!key) return
      output.headers = { ...output.headers, Authorization: `Bearer ${key.key}` }
    },
    event: async ({ event }: any) => {
      if (event?.type === "session.deleted") {
        sessionProvider.delete(event?.properties?.sessionID)
        return
      }
      if (event?.type !== "session.error") return
      const props = event?.properties ?? {}
      const err = props?.error
      if (!err) return
      if (!isGoError(err)) return
      if (!isQuotaError(err)) return

      const sid = props?.sessionID
      const sessionIsGo = sid ? sessionProvider.get(sid)?.includes("opencode") : false
      if (!sessionIsGo && !isGoError(err)) return

      const msg = err.data?.message ?? err.message ?? ""
      log(`🔁  检测到配额/鉴权错误: ${String(msg).slice(0, 200)}`)
      log(`    sessionID=${sid ?? "?"} statusCode=${err.data?.statusCode ?? "?"}`)
      const cfg = rotate(String(msg), err)
      log(`    now current=${cfg.current}`)
    },
  }
}

/* ---------------- Web 页面 ---------------- */

const WEB_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>go-rotate · opencode-go keys</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='7' fill='%233b82f6'/><circle cx='8' cy='8' r='3' fill='%230b0d10'/></svg>">
<style>
  /* ============ go-rotate 管理端设计系统 v1.0（深色 · 零依赖） ============ */
  :root {
    color-scheme: dark;
    /* 中性色：背景→表面→边框→文本 */
    --bg-0: #0b0d10;  --bg-1: #11151c;  --bg-2: #181d26;  --bg-3: #202636;
    --bd-1: #1e242e;  --bd-2: #2c3442;  --bd-3: #3a4354;
    --tx-1: #e8eaed;  --tx-2: #9aa3ad;  --tx-3: #6b7280;
    /* 品牌 + 语义色 */
    --brand: #3b82f6;  --brand-strong: #2563eb;  --link: #60a5fa;
    --success: #4ade80;  --warning: #fbbf24;  --danger: #f87171;  --info: #60a5fa;
    --success-soft: rgba(74,222,128,.12);
    --warning-soft: rgba(251,191,36,.12);
    --danger-soft: rgba(248,113,113,.12);
    --info-soft: rgba(96,165,250,.12);
    /* 字体 */
    --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI",
                 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    /* 间距（4px 基数） */
    --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;
    /* 圆角 */
    --r-sm: 6px; --r-md: 10px; --r-lg: 14px; --r-pill: 999px;
    /* 阴影 / 焦点环 */
    --shadow-sm: 0 1px 2px rgba(0,0,0,.3);
    --shadow-md: 0 4px 12px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.3);
    --shadow-lg: 0 8px 24px rgba(0,0,0,.45);
    --ring: 0 0 0 3px rgba(59,130,246,.35);
    /* 动效 */
    --dur: 150ms;
    --ease: cubic-bezier(.2,.8,.2,1);
  }

  /* ============ 基础 ============ */
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg-0); color: var(--tx-1);
         font-family: var(--font-sans); font-size: 14px; line-height: 1.5; }
  ::selection { background: rgba(59,130,246,.35); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--bd-2); border-radius: 5px;
                              border: 2px solid transparent; background-clip: padding-box; }
  ::-webkit-scrollbar-thumb:hover { background: var(--bd-3); }

  /* ============ 布局 / 工具 ============ */
  .wrap { max-width: 1060px; margin: 0 auto; padding: 24px 20px 80px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { color: var(--tx-2); font-size: 13px; margin-bottom: var(--sp-5); }
  .muted { color: var(--tx-3); font-size: 12px; }
  .mono { font-family: var(--font-mono); }
  .small { font-size: 12px; }
  .row { display: flex; gap: var(--sp-2); align-items: center; }
  .row input { flex: 1; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  /* 单列堆叠：网关配置两块与日志双卡纵向排列，避免并排时内容宽度不足导致布局错乱 */
  .gw-config-grid { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
  .log-row { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
  /* 单列下 pre 不再受 grid 双列挤压，仍保留 max-width 兜底（超长行 overflow-x 滚动，不撑爆容器） */
  .log-row > .card, .gw-config-grid > .card { min-width: 0; }
  .log-row pre { max-width: 100%; }
  .gr-tip { cursor: help; border-bottom: 1px dotted var(--tx-3); }

  /* ============ 导航 ============ */
  .nav { display: flex; gap: 6px; margin-bottom: var(--sp-4); flex-wrap: wrap; }
  .nav-btn { height: 32px; padding: 0 14px; border-radius: var(--r-sm);
             background: transparent; border-color: transparent; color: var(--tx-2);
             font-size: 13px; font-weight: 500; }
  .nav-btn:hover { background: var(--bg-2); color: var(--tx-1); }
  .nav-btn.active { background: var(--brand); border-color: var(--brand); color: #fff; }
  .nav-btn.active:hover { background: var(--brand-strong); }

  /* ============ 卡片 ============ */
  .card { background: var(--bg-1); border: 1px solid var(--bd-1); border-radius: var(--r-md);
          padding: var(--sp-4); margin-bottom: var(--sp-4); box-shadow: var(--shadow-sm);
          transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
                      transform var(--dur) var(--ease); }
  /* P3-3：网关未运行灰卡降级（opacity 0.55）加过渡，视觉不突兀 */
  #gateway-card { transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
                  transform var(--dur) var(--ease), opacity .3s var(--ease); }
  .card:hover { border-color: var(--bd-2); }
  .card.interactive:hover { border-color: var(--bd-3); box-shadow: var(--shadow-md);
                            transform: translateY(-1px); }

  /* ============ 状态面板 ============ */
  .stats { display: flex; gap: var(--sp-6); flex-wrap: wrap; }
  .stat .v { font-size: 24px; font-weight: 600; line-height: 1.2;
             font-variant-numeric: tabular-nums; letter-spacing: -.01em;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
             max-width: 100%; }
  .stat .l { font-size: 12px; color: var(--tx-2); margin-top: 2px; }
  .ov-strip .stat { flex: 1 1 0; min-width: 0; }
  .ov-strip .stat + .stat { border-left: 1px solid var(--bd-1); padding-left: var(--sp-6); }
  #s-current { color: var(--link); }
  /* key 名称截断：概览当前 key / Key 表格名称列，超长省略号 + title 悬浮全名 */
  .td-name { max-width: 260px; overflow: hidden; text-overflow: ellipsis;
             white-space: nowrap; word-break: keep-all; }

  /* ============ 按钮 ============ */
  button { font: inherit; display: inline-flex; align-items: center; justify-content: center;
           gap: 6px; height: 30px; padding: 0 12px; border-radius: var(--r-sm);
           border: 1px solid var(--bd-2); background: var(--bg-2); color: var(--tx-1);
           cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap;
           transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
                       color var(--dur) var(--ease), transform var(--dur) var(--ease),
                       box-shadow var(--dur) var(--ease); }
  button:hover { background: var(--bg-3); border-color: var(--bd-3); }
  button:active { transform: translateY(.5px); }
  button:focus-visible { outline: none; box-shadow: var(--ring); }
  button:disabled, button[disabled] { opacity: .45; cursor: not-allowed; pointer-events: none; }
  button.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
  button.primary:hover { background: var(--brand-strong); border-color: var(--brand-strong); }
  button.danger { background: var(--danger-soft); border-color: rgba(127,29,29,.9); color: #fca5a5; }
  button.danger:hover { background: rgba(248,113,113,.22); border-color: #7f1d1d; }
  button.ghost { background: transparent; border-color: transparent; color: var(--tx-2); }
  button.ghost:hover { background: var(--bg-2); color: var(--tx-1); }
  button.sm, .actions button { height: 26px; padding: 0 8px; font-size: 12px; border-radius: 5px; }
  button.loading { pointer-events: none; opacity: .75; }
  button.loading::before { content: ""; width: 12px; height: 12px;
                           border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
                           border-radius: 50%; animation: spin .6s linear infinite; flex: none; }
  button.danger.loading::before { border-color: rgba(252,165,165,.35); border-top-color: #fca5a5; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ============ 徽标 / 状态点 ============ */
  .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px;
           border-radius: var(--r-pill); font-size: 12px; font-weight: 500;
           line-height: 1.5; white-space: nowrap; }
  .b-available, .b-running { background: var(--success-soft); color: var(--success); }
  .b-cooling,   .b-warn     { background: var(--warning-soft); color: var(--warning); }
  .b-current,   .b-info     { background: var(--info-soft);    color: var(--info); }
  .b-stopped,   .b-neutral  { background: rgba(154,163,173,.12); color: var(--tx-2); }
  .b-error,     .b-invalid  { background: var(--danger-soft);  color: var(--danger); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block;
         background: var(--tx-3); flex: none; }
  .dot.ok   { background: var(--success); box-shadow: 0 0 6px rgba(74,222,128,.5); }
  .dot.warn { background: var(--warning); box-shadow: 0 0 6px rgba(251,191,36,.5); }
  .dot.err  { background: var(--danger);  box-shadow: 0 0 6px rgba(248,113,113,.5); }

  /* ============ 输入框 ============ */
  input { font: inherit; width: 100%; height: 30px; padding: 4px 10px;
          background: var(--bg-0); border: 1px solid var(--bd-2); border-radius: var(--r-sm);
          color: var(--tx-1);
          transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
  input::placeholder { color: var(--tx-3); }
  input:focus { outline: none; border-color: var(--brand); box-shadow: var(--ring); }
  input[readonly] { background: var(--bg-2); color: var(--tx-2); }
  input[type="checkbox"], input[type="radio"] { width: auto; height: auto;
    accent-color: var(--brand); margin: 0 4px 0 0; }

  /* ============ 表格 ============ */
  .table-wrap { overflow-x: auto; border-radius: var(--r-sm); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--bd-1);
           vertical-align: middle; }
  th { color: var(--tx-3); font-weight: 500; font-size: 12px; white-space: nowrap; }
  tbody tr { transition: background var(--dur) var(--ease); }
  tbody tr:hover { background: rgba(255,255,255,.02); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:has(.b-current) { background: var(--info-soft); }

  /* ============ 空状态横幅 ============ */
  .banner { display: flex; align-items: flex-start; gap: var(--sp-2); padding: 10px 14px;
            border: 1px dashed var(--bd-2); border-radius: var(--r-sm);
            background: var(--bg-0); color: var(--tx-2); font-size: 13px; line-height: 1.6; }
  .banner b { color: var(--tx-1); font-weight: 500; }

  /* ============ 消息 / toast ============ */
  .msg { color: var(--success); font-size: 13px; min-height: 18px; margin-top: var(--sp-2);
         animation: fadeIn var(--dur) var(--ease); }
  .err { color: var(--danger); }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(-2px); }
                      to   { opacity: 1; transform: none; } }
  .toast { position: fixed; right: 24px; bottom: 24px; z-index: 100; max-width: 320px;
           padding: 10px 16px; border-radius: var(--r-sm); background: var(--bg-3);
           border: 1px solid var(--bd-2); color: var(--tx-1); font-size: 13px;
           box-shadow: var(--shadow-lg); opacity: 0; transform: translateY(8px);
           pointer-events: none; transition: opacity .2s var(--ease), transform .2s var(--ease); }
  .toast.show { opacity: 1; transform: none; }
  .toast.success { border-color: rgba(74,222,128,.4); }
  .toast.error { border-color: rgba(248,113,113,.4); }

  /* ============ 日志 / 代码 ============ */
  pre { margin: 0; background: var(--bg-0); border: 1px solid var(--bd-1);
        border-radius: var(--r-sm); padding: 12px; font-family: var(--font-mono);
        font-size: 12px; line-height: 1.6; overflow: auto; max-height: 260px; color: #9ceba8; }
  code { font-family: var(--font-mono); font-size: 12px; background: var(--bg-2);
         border: 1px solid var(--bd-1); border-radius: 4px; padding: 1px 5px; color: var(--tx-1); }
  .model-list { font-size: 12px; color: var(--tx-2); word-break: break-all; line-height: 1.7; }
  details summary { cursor: pointer; color: var(--tx-2); font-size: 12px; }
  details summary:hover { color: var(--tx-1); }

  /* ============ 骨架屏 / 模态框（预留） ============ */
  .skeleton { background: linear-gradient(90deg, var(--bg-2) 25%, var(--bg-3) 50%, var(--bg-2) 75%);
              background-size: 200% 100%; animation: shimmer 1.4s linear infinite; border-radius: 4px; }
  @keyframes shimmer { to { background-position: -200% 0; } }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.55);
                    display: flex; align-items: center; justify-content: center; z-index: 200; }
  .modal { width: min(420px, calc(100vw - 32px)); background: var(--bg-1);
           border: 1px solid var(--bd-2); border-radius: var(--r-lg);
           padding: var(--sp-5); box-shadow: var(--shadow-lg); }

  /* ============ 响应式（<720px 单列） ============ */
  @media (max-width: 720px) {
    .wrap { padding: 16px 12px 64px; }
    .nav { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px;
           -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .nav::-webkit-scrollbar { display: none; }
    .gw-config-grid, .log-row { grid-template-columns: 1fr; }
    .ov-strip { display: grid; grid-template-columns: repeat(2, 1fr);
                gap: var(--sp-3) var(--sp-4); }
    .ov-strip .stat { min-width: 0; }
    .ov-strip .stat + .stat { border-left: none; padding-left: 0; }
    .stats { gap: var(--sp-4); }
    pre { max-height: 160px; }
    .table-wrap table { min-width: 720px; }
  }
  /* P3-4 修复：断点提到 780px 才去 .ov-strip 分隔线，消除 721-780px 区间 flex wrap 后第二行首格残留 border-left */
  @media (max-width: 780px) {
    .ov-strip .stat + .stat { border-left: none; padding-left: 0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>go-rotate · opencode-go keys</h1>
  <div class="sub">多 key 自动轮换 · 修改会自动同步到 auth.json 并立即生效</div>

  <div class="nav" id="main-nav">
    <button class="nav-btn active" data-nav="overview" onclick="switchNav('overview')">概览</button>
    <button class="nav-btn" data-nav="keys" onclick="switchNav('keys')">Key 管理</button>
    <button class="nav-btn" data-nav="gateway" onclick="switchNav('gateway')">网关管理</button>
    <button class="nav-btn" data-nav="stats" onclick="switchNav('stats')">统计</button>
    <button class="nav-btn" data-nav="settings" onclick="switchNav('settings')">设置</button>
  </div>

  <!-- ============ 概览：只读状态面板（编辑动作下沉到设置 / Key 管理） ============ -->
  <div class="block" id="nav-overview">
  <div class="card">
    <div class="stats ov-strip">
      <div class="stat"><div class="v" id="s-current">-</div><div class="l">当前 key</div></div>
      <div class="stat"><div class="v" id="s-avail">-</div><div class="l">可用 &nbsp;<span class="muted" id="s-total"></span></div></div>
      <div class="stat"><div class="v" id="ov-gw-state">-</div><div class="l">网关</div></div>
      <div class="stat"><div class="v" id="ov-last-rotate">-</div><div class="l">最近轮换</div></div>
      <div class="stat"><div class="v" id="s-cooldown">-</div><div class="l">冷却窗口(min) <a href="javascript:void(0)" onclick="switchNav('settings')" style="color:#60a5fa">去设置</a></div></div>
      <div class="stat"><div class="v" id="s-autoweb">-</div><div class="l">Web 自动启动 <a href="javascript:void(0)" onclick="switchNav('settings')" style="color:#60a5fa">去设置</a></div></div>
    </div>
    <div class="muted banner" id="ov-hint" style="margin-top:12px">
      <span id="ov-hint-full"><b>①</b> 添加 key → <a href="javascript:void(0)" onclick="switchNav('keys')" style="color:#60a5fa">Key 管理</a>　<b>②</b> （可选）启动网关 → <a href="javascript:void(0)" onclick="switchNav('gateway')" style="color:#60a5fa">网关管理</a>　<b>③</b> （可选）生成 token → 网关管理</span>
      <span id="ov-hint-min" style="display:none">当前状态健康。</span>
    </div>
  </div>
  </div>

  <!-- ============ Key 管理：主操作区（新增卡 + 表格卡） ============ -->
  <div class="block" id="nav-keys" style="display:none">
  <div class="card" id="keys-add-card">
    <div class="row" style="margin-bottom:10px"><input id="new-name" placeholder="名称，如 act2">&nbsp;<input id="new-key" placeholder="sk-xxxx 完整的 API key"><button class="primary" onclick="addKey()">新增 key</button></div>
    <div class="muted banner" id="keys-empty" style="display:none">还没有 key：粘贴第一个 opencode-go key，添加后自动探测健康。</div>
    <div class="row" style="margin-bottom:10px"><span class="muted">手动操作：</span><button onclick="rotate()">轮换</button><button onclick="checkKeys()">检测所有 key</button><span class="muted" id="check-hint"></span></div>
  </div>
  <div class="card" id="keys-table-card">
    <div class="table-wrap">
    <table style="min-width:720px">
      <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>健康</th><th>操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    </div>
    <div class="muted" style="margin-top:8px">每 key 独立冷却窗口行内设置；全局冷却窗口见 <a href="javascript:void(0)" onclick="switchNav('settings')" style="color:#60a5fa">设置</a>。</div>
    <div class="msg" id="msg"></div>
  </div>
  </div>

  <!-- ============ 统计 · 分析与日志（轮换统计 + 运行日志 + 网关日志，双列） ============ -->
  <div class="block" id="nav-stats" style="display:none">
  <div class="card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <b>轮换统计</b>
      <span class="muted" id="stats-hint">统计自运行日志（近期，非全历史）</span>
    </div>
    <div class="stats" style="margin-bottom:8px">
      <div class="stat"><div class="v" id="st-total">-</div><div class="l">总轮换次数</div></div>
    </div>
    <table>
      <thead><tr><th>Key</th><th>被切到</th><th>进冷却</th><th>最近切换</th></tr></thead>
      <tbody id="stats-tbody"><tr><td colspan="4" class="muted">加载中…</td></tr></tbody>
    </table>
  </div>

  <div class="log-row">
  <div class="card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b>运行日志</b>
      <div class="row" style="flex-wrap:wrap">
        <label class="muted" style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="log-auto" style="width:auto"> 自动刷新</label>
        <input id="log-filter" placeholder="过滤关键字（如 key 名 / 轮换 / 冷却）" style="width:200px">
        <button class="danger" id="clear-log-btn" onclick="clearLog()">清空日志</button>
      </div>
    </div>
    <pre id="logview"></pre>
  </div>
  <div class="card" id="an-gwlog-card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <b>网关日志</b>
      <div class="row">
        <span class="muted" id="gwlog-src"></span>
        <button onclick="refreshGwLog()">刷新</button>
      </div>
    </div>
    <pre id="gwlogview"></pre>
  </div>
  </div>
  </div>

  <!-- ============ 网关管理：状态主卡（首位）+ 配置子区（套餐 / Token 并排） ============ -->
  <div class="block" id="nav-gateway" style="display:none">
  <div class="card" id="gateway-card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <b>网关管理 <span id="gw-badge"></span></b>
      <span class="muted">127.0.0.1:18888 <span id="gw-version" class="muted"></span></span>
    </div>
    <div class="stats" style="margin-bottom:8px">
      <div class="stat"><div class="v" id="gw-current">-</div><div class="l">当前 key</div></div>
      <div class="stat"><div class="v" id="gw-avail">-</div><div class="l">可用 / key 数</div></div>
      <div class="stat"><div class="v" id="gw-rot">-</div><div class="l">轮换数</div></div>
      <div class="stat"><div class="v" id="gw-req">-</div><div class="l">总请求</div></div>
      <div class="stat"><div class="v" id="gw-mcount">-</div><div class="l">模型数</div></div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <span class="muted" style="flex:1">管理操作（启停 launchd 服务，走跨进程锁）：</span>
      <button id="gw-start" onclick="gwManage('start')">启动</button>
      <button id="gw-stop" onclick="gwManage('stop')">停止</button>
      <button id="gw-restart" onclick="gwManage('restart')">重启</button>
    </div>
    <div id="gw-body"><span class="muted">加载中…</span></div>
    <div id="gw-ctl-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <div class="gw-config-grid">
  <div class="card" id="gw-plan-card">
    <b>上游套餐</b>
    <div class="row" style="margin-top:10px">
      <label style="display:flex;align-items:center;gap:4px;margin-right:12px"><input type="radio" name="plan" value="go" id="plan-go"> Go 订阅</label>
      <label style="display:flex;align-items:center;gap:4px"><input type="radio" name="plan" value="zen" id="plan-zen"> Zen 免费</label>
      <button id="plan-apply" class="primary" style="margin-left:auto" onclick="saveGatewayPlan()">切换并重启</button>
    </div>
    <div class="muted" id="plan-meta" style="margin-top:8px">加载中…</div>
    <div class="muted" style="margin-top:6px">提示：Zen 免费档数据可能被用于训练，敏感代码请勿使用（个人自用合规）。切换后需重启网关生效。</div>
    <div id="plan-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <div class="card" id="gw-token-card">
    <b>网关访问 Token <span id="token-badge"></span></b>
    <div class="row" style="margin-top:10px">
      <input id="token-input" readonly placeholder="未设置（鉴权关闭）" class="mono">
      <button onclick="genGatewayToken()">生成</button>
      <button onclick="setGatewayToken()">编辑</button>
      <button onclick="copyToken()">复制</button>
      <button onclick="toggleTokenMask()">显示/隐藏</button>
      <button class="danger" onclick="clearGatewayToken()">清除</button>
    </div>
    <div class="muted" style="margin-top:6px">其它 agent 连网关时用此 token（curl -H "Authorization: Bearer &lt;token&gt;"）。生成/编辑后可直接「复制」。</div>
    <div id="token-msg" class="msg" style="margin-top:6px"></div>
  </div>
  </div>
  </div>

  <!-- ============ 设置：全局配置（冷却窗口 + Web 自动启动，唯一可操作点） ============ -->
  <div class="block" id="nav-settings" style="display:none">
  <div class="card">
    <b>设置</b>
    <div class="row" style="margin-top:10px">
      <span style="flex:1">全局冷却窗口：<b id="set-cooldown">-</b> 分钟</span>
      <button onclick="editGlobalWindow()">编辑</button>
    </div>
    <div class="row" style="margin-top:10px">
      <span style="flex:1">Web 自动启动：<b id="set-autoweb">-</b></span>
      <button id="web-on-btn" onclick="webOn()">开启</button>
      <button id="web-off-btn" class="danger" onclick="webOff()">关闭</button>
    </div>
    <div class="muted" style="margin-top:8px">套餐切换与网关 token 见「网关管理」区块；每 key 独立冷却窗口在 Key 表格内联。</div>
  </div>
  </div>
</div>

<div class="toast" id="gtoast"></div>

<script>
async function api(path, body) {
  const opts = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}
  const r = await fetch(path, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
var health = {}
/* P1-1 XSS 修复：统一转义 HTML 特殊字符（用户可控字段拼 innerHTML / 属性前必须过 esc） */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}
async function refresh() {
  try {
    const st = await api("/api/status")
    const el = document.getElementById("s-current")
    el.textContent = st.current || "(none)"
    el.title = st.current || "(none)"
    document.getElementById("s-avail").textContent = st.availableCount + "/" + st.keyCount
    document.getElementById("s-total").textContent = "total " + st.keyCount
    document.getElementById("s-cooldown").textContent = st.cooldown_minutes
    document.getElementById("s-autoweb").textContent = st.auto_web ? "开启" : "关闭"
    document.getElementById("set-cooldown").textContent = st.cooldown_minutes
    document.getElementById("set-autoweb").textContent = st.auto_web ? "开启" : "关闭"
    document.getElementById("web-off-btn").disabled = !st.auto_web
    document.getElementById("web-on-btn").disabled = st.auto_web
    /* IA B3：空状态横幅（0 key 引导 / 概览折叠为一行健康，健康文案按可用 key 数动态判定 P2-2） */
    document.getElementById("keys-empty").style.display = st.keys.length ? "none" : "block"
    document.getElementById("ov-hint-full").style.display = st.keys.length ? "none" : "inline"
    const hintEl = document.getElementById("ov-hint-min")
    if (st.keys.length) {
      hintEl.textContent = st.availableCount > 0
        ? st.availableCount + " 个 key 可用，轮换正常。"
        : "全部 key 冷却中，轮换暂不可用。"
      hintEl.style.display = "inline"
    } else {
      hintEl.style.display = "none"
    }
    const tb = document.getElementById("tbody")
    tb.innerHTML = ""
    for (const k of st.keys) {
      const tr = document.createElement("tr")
      // 状态徽章：优先显示健康状态（余额不足/无效/限流），其次冷却/可用
      const statusLabel = { ok:'可用', invalid:'key 无效', nobalance:'余额不足', limited:'限流', error:'异常' }
      const statusHint = { invalid:'该 key 无效', nobalance:'余额不足，需充值', limited:'请求被限流', error:'探测异常' }
      const tip = (status, text, hint) => { const cls = (status === "invalid" || status === "nobalance" || status === "error") ? "b-invalid" : (status === "limited" ? "b-warn" : "b-cooling"); return hint ? '<span class="badge ' + cls + ' gr-tip" title="' + esc(hint) + '">' + esc(text) + '</span>' : '<span class="badge ' + cls + '">' + esc(text) + '</span>' }
      let badge
      if (k.last_status && k.last_status !== "ok") {
        badge = tip(k.last_status, statusLabel[k.last_status] || k.last_status, statusHint[k.last_status] || k.last_status)
        if (k.state === "cooling") badge += '<span class="badge b-cooling">冷却 ' + esc(k.remainMin) + 'min</span>'
      } else {
        badge = k.state === "cooling" ? '<span class="badge b-cooling">冷却 ' + esc(k.remainMin) + 'min</span>' : '<span class="badge b-available">可用</span>'
      }
      if (k.isCurrent) badge += '<span class="badge b-current">当前</span>'
      const h = health[k.name]
      let hcell = '<span class="muted">-</span>'
      if (h) {
        // 详情只作为 hover 浮窗展示，不直接内联（P1-1：h.detail 经 esc 转义，防属性注入）
        hcell = tip(h.status, statusLabel[h.status] || h.status, h.detail)
      }
      const n = esc(k.name), key = esc(k.key), masked = esc(k.masked)
      tr.innerHTML =
        '<td class="td-name" title="' + n + '">' + n + '</td>' +
        '<td class="muted" title="' + key + '">' + masked + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + hcell + '</td>' +
        '<td><div class="actions">' +
          (k.isCurrent ? '' : '<button data-set="' + n + '">启用</button>') +
          (k.state === "cooling"
            ? '<button data-cooldown="' + n + '" data-min="0">清除冷却</button>'
            : '<button data-cooldown="' + n + '" data-min="' + esc(st.cooldown_minutes) + '">冷却</button>') +
          '<button data-window="' + n + '" title="设置该 key 独立冷却窗口（分钟，留空清除回退全局）">窗口</button>' +
          (k.cooldown_minutes ? '<button data-window-clear="' + n + '" title="清除独立窗口，回退全局">清窗</button>' : '') +
          '<button data-edit="' + n + '" title="编辑名称 / key 值">编辑</button>' +
          '<button class="danger" data-del="' + n + '">删除</button>' +
        '</div></td>'
      tb.appendChild(tr)
    }
    tb.querySelectorAll("[data-set]").forEach(b => b.onclick = () => doOp(() => api("/api/current", { name: b.dataset.set })))
    tb.querySelectorAll("[data-cooldown]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown", { name: b.dataset.cooldown, minutes: Number(b.dataset.min) })))
    tb.querySelectorAll("[data-window]").forEach(b => b.onclick = () => editKeyWindow(b.dataset.window))
    tb.querySelectorAll("[data-window-clear]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown/window", { name: b.dataset.windowClear, minutes: null })))
    tb.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editKey(b.dataset.edit))
    tb.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
      if (!confirm('确定删除 key "' + b.dataset.del + '"？此操作不可恢复。')) return
      doOp(() => api("/api/keys/delete", { name: b.dataset.del }))
    })
  } catch (e) { showErr(e.message) }
}
async function addKey() {
  const name = document.getElementById("new-name").value.trim()
  const key = document.getElementById("new-key").value.trim()
  if (!name || !key) return showErr("名称和 key 不能为空")
  try {
    const r = await fetch("/api/keys/add", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, key }) })
    const j = await r.json()
    if (!r.ok) throw new Error(j.error || r.statusText)
    document.getElementById("new-name").value=""; document.getElementById("new-key").value=""
    if (j.health) {
      const map = { ok:'可用', invalid:'key 无效', nobalance:'余额不足', limited:'限流', error:'异常' }
      const label = map[j.health.status] || j.health.status
      showMsg('已添加 "' + name + '" → ' + label + (label==='可用' ? '' : '（详情 hover 查看）'))
    } else { showMsg('已添加 "' + name + '"') }
    refresh()
  } catch (e) { showErr(e.message) }
}
async function rotate() { try { await api("/api/rotate", {}); refresh() } catch (e) { showErr(e.message) } }
async function webOff() {
  if (!confirm("确认关闭 Web？关闭后本页面立即停止，且 opencode 启动时不再自动起 Web（轮换功能不受影响）。")) return
  try {
    await api("/api/web/off", {})
    /* P1-2 修复：body 整体替换前清理全部定时器，避免残留 interval 对已删除 DOM 的 TypeError 风暴 */
    for (const k in timers) { clearInterval(timers[k]) }
    if (logTimer) { clearInterval(logTimer); logTimer = null }
    document.body.innerHTML = '<div style="padding:40px;text-align:center;color:#9aa3ad">Web 已关闭。<br><br>需要时用 <code>go-rotate web</code> 重新启动，或 <code>go-rotate web on</code> 恢复自动启动。</div>'
  } catch (e) { showErr(e.message) }
}
async function webOn() {
  try {
    const r = await api("/api/web/on", {})
    showMsg(r.restarted ? "Web 已重新启动（立即生效）" : "已开启 Web 自动启动")
    refresh()
  } catch (e) { showErr(e.message) }
}
async function checkKeys() {
  const hint = document.getElementById("check-hint")
  hint.textContent = "检测中…"
  try {
    // 探测会真实消耗配额（~1 token/key）：显式 POST（api 带 body 即 POST），避免 GET 意外触发
    const j = await api("/api/keys/check", {})
    health = j.results || {}
    hint.textContent = "检测完成（每次消耗约 1 token）"
    refresh()
  } catch (e) { hint.textContent = ""; showErr(e.message) }
}
async function doOp(p) { try { await p(); refresh() } catch (e) { showErr(e.message) } }
/* P1-3 修复：错误同时写 #msg（Key 管理卡）与全局 toast（任何区块可见）；3s 后自动清除 */
function showErr(m) {
  const el = document.getElementById("msg"); el.textContent = m; el.className = "msg err"
  toast(m, "error")
  setTimeout(() => { const e2 = document.getElementById("msg"); if (e2) { e2.textContent = ""; e2.className = "msg" } }, 3000)
}
function showMsg(m) { const el = document.getElementById("msg"); el.textContent = m; el.className = "msg"; toast(m, "success") }
function toast(m, type) {
  const t = document.getElementById("gtoast")
  if (!t) return
  t.textContent = m
  t.className = "toast show" + (type === "error" ? " error" : " success")
  clearTimeout(t._h)
  t._h = setTimeout(() => { t.className = "toast" }, 3000)
}

/* ---- 独立冷却窗口 / 全局窗口编辑 ---- */
async function editKey(name) {
  const newName = prompt('修改 key "' + name + '" 的名称（留空 = 不改）', "")
  if (newName === null) return
  const newKey = prompt('修改 key "' + name + '" 的 key 值（留空 = 不改）', "")
  if (newKey === null) return
  const patch = {}
  if (newName.trim()) patch.name = newName.trim()
  if (newKey.trim()) patch.key = newKey.trim()
  if (!patch.name && !patch.key) return showMsg('未修改：名称与 key 值均为空')
  try {
    await api("/api/keys/update", { name, patch })
    showMsg('已更新 key "' + name + '"' + (patch.name ? ' → "' + patch.name + '"' : ""))
    refresh()
  } catch (e) { showErr(e.message) }
}
async function editKeyWindow(name) {
  const v = prompt('设置 key "' + name + '" 的独立冷却窗口（分钟，正整数；留空或取消 = 清除，回退全局窗口）', "")
  if (v === null) return
  const minutes = v.trim() === "" ? null : Number(v.trim())
  try {
    if (minutes !== null && (!Number.isInteger(minutes) || minutes <= 0)) throw new Error("请输入正整数分钟")
    await api("/api/cooldown/window", { name, minutes })
    showMsg(minutes === null ? '已清除 "' + name + '" 独立窗口（回退全局）' : '已设置 "' + name + '" 独立窗口 = ' + minutes + ' 分钟')
    refresh()
  } catch (e) { showErr(e.message) }
}
async function editGlobalWindow() {
  const cur = document.getElementById("s-cooldown").textContent
  const v = prompt("设置全局冷却窗口（分钟，正整数）", cur)
  if (v === null) return
  try {
    const minutes = Number(v.trim())
    if (!Number.isInteger(minutes) || minutes <= 0) throw new Error("请输入正整数分钟")
    await api("/api/settings", { cooldown_minutes: minutes })
    showMsg("全局冷却窗口已设为 " + minutes + " 分钟")
    refresh()
  } catch (e) { showErr(e.message) }
}

/* ---- 轮换统计（/api/stats） ---- */
async function refreshStats() {
  /* P2-4：统计区块隐藏时不轮询（10s 常驻 interval 守卫），切到该区块时 switchNav 手动触发 */
  const navStats = document.getElementById("nav-stats")
  if (!navStats || navStats.style.display !== "block") return
  try {
    const st = await api("/api/stats")
    document.getElementById("st-total").textContent = st.totalRotations
    /* IA B1：概览「最近轮换」= byKey 中最近 lastRotate（时间），无记录显示 - */
    let last = ""
    for (const n in (st.byKey || {})) {
      const lt = st.byKey[n].lastRotate
      if (lt && (!last || new Date(lt) > new Date(last))) last = lt
    }
    document.getElementById("ov-last-rotate").textContent = last ? new Date(last).toLocaleTimeString() : "-"
    const tb = document.getElementById("stats-tbody")
    const names = Object.keys(st.byKey || {})
    if (!names.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">暂无轮换记录</td></tr>'; return }
    tb.innerHTML = ""
    names.sort().forEach(name => {
      const k = st.byKey[name]
      const tr = document.createElement("tr")
      /* P1-1：name 为 key 名（用户可控），拼 innerHTML 前转义 */
      tr.innerHTML = '<td class="td-name" title="' + esc(name) + '">' + esc(name) + '</td><td>' + esc(k.rotations) + '</td><td>' + esc(k.coolings) +
        '</td><td class="muted">' + (k.lastRotate ? new Date(k.lastRotate).toLocaleString() : '-') + '</td>'
      tb.appendChild(tr)
    })
  } catch (e) { document.getElementById("st-total").textContent = "n/a" }
}

/* ---- zen-gateway 网关管理（/api/gateway + 管理路由，失败灰卡降级） ---- */
async function refreshGateway() {
  const card = document.getElementById("gateway-card")
  const badge = document.getElementById("gw-badge")
  const setDash = () => {
    document.getElementById("gw-current").textContent = "-"
    document.getElementById("gw-avail").textContent = "-"
    document.getElementById("gw-rot").textContent = "-"
    document.getElementById("gw-req").textContent = "-"
    document.getElementById("gw-mcount").textContent = "-"
    document.getElementById("gw-version").textContent = "—"
  }
  /* IA B2：概览「网关」格 = 双通道（圆点 + 文本） */
  const ovGw = (cls, text) => {
    document.getElementById("ov-gw-state").innerHTML =
      '<span class="dot ' + cls + '" style="margin-right:6px"></span>' + esc(text)
  }
  // 管理按钮：start 在未运行且已安装时可用；stop/restart 在运行中可用
  const setBtns = (running, installed) => {
    document.getElementById("gw-start").disabled = running || !installed
    document.getElementById("gw-stop").disabled = !running || !installed
    document.getElementById("gw-restart").disabled = !running || !installed
  }
  try {
    const g = await api("/api/gateway")
    const installed = !!g.ctlExists
    if (!g.running) {
      card.style.opacity = "0.55"
      setDash()
      if (!installed) {
        badge.innerHTML = '<span class="badge b-stopped">未安装</span>'
        ovGw("", "未安装")
        setBtns(false, false)
        document.getElementById("gw-body").innerHTML =
          '<span class="muted">未检测到 zen-gateway 管理脚本' +
          '（<code>~/.local/bin/zen-gateway</code>）。可用 <code>bash install.sh zen-gateway</code> 安装。</span>'
      } else {
        badge.innerHTML = '<span class="badge b-stopped">未运行</span>'
        ovGw("", "未运行")
        setBtns(false, true)
        document.getElementById("gw-body").innerHTML =
          '<span class="muted">zen-gateway 服务未运行' + (g.error ? '（' + esc(g.error) + '）' : '') +
          '。点「启动」拉起 launchd 服务。</span>'
      }
      return
    }
    card.style.opacity = "1"
    badge.innerHTML = '<span class="badge b-running">运行中</span>'
    ovGw("ok", "运行中")
    setBtns(true, true)
    const h = g.healthz || {}
    const u = g.usage || {}
    document.getElementById("gw-current").textContent = h.current || "-"
    document.getElementById("gw-avail").textContent = (h.available ?? "-") + "/" + (h.keys ?? "-")
    document.getElementById("gw-rot").textContent = h.rotations ?? "-"
    document.getElementById("gw-req").textContent = u.totalRequests ?? "-"
    document.getElementById("gw-mcount").textContent = g.modelCount ?? "-"
    // 网关版本：旧网关无 /api/gateway/status 端点/字段时容错显示 '—'
    document.getElementById("gw-version").textContent = g.version ? "v" + g.version : "—"
    const pk = u.perKey || {}
    const names = Object.keys(pk)
    let html = '<span class="muted">暂无用量记录</span>'
    if (names.length) {
      html = '<table><thead><tr><th>Key</th><th>成功</th><th>轮换</th></tr></thead><tbody>'
      names.sort().forEach(n => {
        const s = pk[n]
        /* P1-1：n 为 key 名（用户可控），转义后拼表 */
        html += '<tr><td>' + esc(n) + '</td><td>' + esc(s.success ?? 0) + '</td><td>' + esc(s.rotated ?? 0) + '</td></tr>'
      })
      html += '</tbody></table>'
    }
    // 模型列表：小字显示数量 + 前几个，details 展开看全部（模型名非用户直接可控，防御性转义）
    const models = g.models || []
    if (models.length) {
      const preview = models.slice(0, 4).map(esc).join(", ") + (models.length > 4 ? " …" : "")
      html += '<details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">' +
        '模型（' + models.length + '）：' + preview + '</summary>' +
        '<div class="model-list" style="margin-top:4px">' + models.map(esc).join("<br>") + '</div></details>'
    }
    document.getElementById("gw-body").innerHTML = html
  } catch (e) {
    card.style.opacity = "0.55"
    badge.innerHTML = '<span class="badge b-error">状态获取失败</span>'
    ovGw("err", "获取失败")
    setDash()
    setBtns(false, false)
    document.getElementById("gw-body").innerHTML = '<span class="muted">获取失败：' + esc(e.message) + '</span>'
  }
}
/* 管理操作：start/stop/restart（真实启停）。成功后 800ms 刷新状态（launchd 拉起有延迟）。 */
async function gwManage(action) {
  const btn = document.getElementById("gw-" + action)
  const msg = document.getElementById("gw-ctl-msg")
  const label = { start: "启动", stop: "停止", restart: "重启" }[action] || action
  btn.disabled = true
  msg.textContent = label + "中（可能需数秒）…"
  msg.className = "msg"
  try {
    const r = await api("/api/gateway/" + action, {})
    msg.textContent = r.ok ? (r.output || label + "成功") : (r.output || label + "失败")
    msg.className = r.ok ? "msg" : "msg err"
    showMsg("网关" + label + (r.ok ? "完成" : "失败"))
    setTimeout(refreshGateway, 800)
  } catch (e) {
    msg.textContent = e.message
    msg.className = "msg err"
    btn.disabled = false
  }
}

/* ---- 网关日志（/api/gateway/log，只读文本 + 手动刷新；已移入「统计 · 分析与日志」区块） ---- */
async function refreshGwLog() {
  const pre = document.getElementById("gwlogview")
  pre.textContent = "加载中…"
  try {
    const r = await api("/api/gateway/log")
    document.getElementById("gwlog-src").textContent =
      r.source === "gateway" ? "来源: gateway /api/gateway/log" :
      r.source === "zen-gateway logs" ? "来源: zen-gateway logs 300" : ""
    // 优先逐行渲染（gateway 端点 {lines,total} 形态）：lines 数组 join 为每行一行；
    // 回退纯文本 text（旧网关 / zen-gateway logs 脚本路径）。textContent 赋值天然转义
    // < > & 等字符（不解析 HTML，防 XSS / 防破坏 pre 布局）。空列表显示空状态。
    let lines = Array.isArray(r.lines) ? r.lines.map(String) : null
    if (!lines && typeof r.text === "string" && r.text.length > 0) lines = r.text.split("\\n")
    pre.textContent = lines && lines.length > 0 ? lines.join("\\n") : "暂无网关日志"
    pre.style.color = r.ok ? "" : "#f87171"
  } catch (e) {
    pre.textContent = "获取失败: " + e.message
    pre.style.color = "#f87171"
  }
}

/* ---- 主导航：区块切换（CSS display，全部区块常驻 DOM 避免重复拉取） ---- */
function switchNav(block) {
  document.querySelectorAll(".block").forEach(b => { b.style.display = "none" })
  document.getElementById("nav-" + block).style.display = "block"
  document.querySelectorAll(".nav-btn").forEach(b => { b.classList.toggle("active", b.dataset.nav === block) })
  /* P2-4：统计区块轮询已被守卫暂停，切入时手动触发一次，避免等下一个 interval 才出数 */
  if (block === "stats") {
    refreshStats()
    refreshGwLog()
  }
}

/* ---- 网关套餐 / Token（/api/gateway/plans + /api/gateway/config，写后显式调 restart 生效） ---- */
var gwToken = { masked: "", plain: "", showPlain: false }
function tokenBadge(on) {
  document.getElementById("token-badge").innerHTML =
    on ? '<span class="badge b-running">鉴权开启</span>' : '<span class="badge b-stopped">鉴权关闭</span>'
}
async function refreshPlans() {
  try {
    const p = await api("/api/gateway/plans")
    const meta = (p.plans || []).map(x =>
      x.name + "：" + x.defaultModel + "（" + x.upstreamBase + "，内置 " + x.modelCount + " 模型）").join("  |  ")
    document.getElementById("plan-meta").textContent = meta || "暂无套餐数据"
  } catch (e) { document.getElementById("plan-meta").textContent = "套餐信息获取失败：" + e.message }
}
async function refreshGatewayConfig() {
  try {
    const c = await api("/api/gateway/config")
    document.getElementById("plan-go").checked = c.plan === "go"
    document.getElementById("plan-zen").checked = c.plan === "zen"
    tokenBadge(!!c.authEnabled)
    gwToken.masked = c.token || ""
    gwToken.plain = ""   // GET 只返回掩码；明文仅在本次会话生成/编辑后持有
    gwToken.showPlain = false
    document.getElementById("token-input").value = c.token ? c.token : "未设置（鉴权关闭）"
  } catch (e) { showTokenMsg("配置读取失败：" + e.message, true) }
}
function showTokenMsg(m, isErr) {
  const el = document.getElementById("token-msg")
  el.textContent = m
  el.className = isErr ? "msg err" : "msg"
}
async function saveGatewayPlan() {
  const plan = document.getElementById("plan-go").checked ? "go" : "zen"
  const msg = document.getElementById("plan-msg")
  msg.className = "msg"
  msg.textContent = "保存套餐 " + plan + " 并重启网关…"
  try {
    const r = await api("/api/gateway/config", { plan })
    // API 只落盘不重启；显式调 restart 生效（复用幂等重启 + 健康等待）
    if (r.needsRestart) {
      const rr = await api("/api/gateway/restart", {})
      msg.textContent = rr.ok
        ? "已切换 " + (plan === "go" ? "Go 订阅" : "Zen 免费") + " 并重启网关"
        : "配置已保存，但重启失败：" + (rr.output || "")
      msg.className = rr.ok ? "msg" : "msg err"
    }
    refreshGateway(); refreshPlans(); refreshGatewayConfig()
  } catch (e) { msg.className = "msg err"; msg.textContent = e.message }
}
async function genGatewayToken() {
  // 浏览器端生成 64 hex（与后端 genToken() 同格式：crypto.randomBytes(32) 等价，hex 全集 0-9a-f）
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  const token = Array.from(b, x => x.toString(16).padStart(2, "0")).join("")
  try {
    const r = await api("/api/gateway/config", { token })
    gwToken.plain = token
    gwToken.masked = token.slice(0, 4) + "..." + token.slice(-4)
    gwToken.showPlain = false
    document.getElementById("token-input").value = gwToken.masked
    tokenBadge(true)
    showTokenMsg(r.needsRestart ? "Token 已生成并保存（重启网关后生效）" : "Token 已生成")
  } catch (e) { showTokenMsg(e.message, true) }
}
async function setGatewayToken() {
  const v = prompt("输入新的网关访问 token（64 位 hex；留空取消）", "")
  if (v === null) return
  const token = v.trim()
  if (!token) return showTokenMsg("已取消（token 为空）", true)
  try {
    const r = await api("/api/gateway/config", { token })
    gwToken.plain = token
    gwToken.masked = token.slice(0, 4) + "..." + token.slice(-4)
    gwToken.showPlain = false
    document.getElementById("token-input").value = gwToken.masked
    tokenBadge(true)
    showTokenMsg(r.needsRestart ? "Token 已更新（重启网关后生效）" : "Token 已更新")
  } catch (e) { showTokenMsg(e.message, true) }
}
async function clearGatewayToken() {
  if (!confirm("确定清除网关访问 token（关闭鉴权）？清除后任何本机进程都可直连网关。")) return
  try {
    const r = await api("/api/gateway/config", { token: null })
    gwToken = { masked: "", plain: "", showPlain: false }
    document.getElementById("token-input").value = "未设置（鉴权关闭）"
    tokenBadge(false)
    showTokenMsg(r.needsRestart ? "Token 已清除（重启网关后生效）" : "Token 已清除")
  } catch (e) { showTokenMsg(e.message, true) }
}
/* IA B4：生成/编辑后明文在本会话持有，直接复制明文，去掉「先显示/隐藏」前置步骤 */
async function copyToken() {
  const val = gwToken.plain
  if (!val) return showTokenMsg("当前会话未持有明文（token 由外部设置），请先「生成」或「编辑」后再复制", true)
  try {
    await navigator.clipboard.writeText(val)
    showTokenMsg("已复制到剪贴板")
  } catch (e) { showTokenMsg("复制失败（浏览器剪贴板权限被拒），请手动复制", true) }
}
function toggleTokenMask() {
  const input = document.getElementById("token-input")
  if (!gwToken.masked && !gwToken.plain) return showTokenMsg("当前未设置 token", true)
  gwToken.showPlain = !gwToken.showPlain
  if (gwToken.showPlain) {
    if (!gwToken.plain) {
      // GET 只返回掩码：明文仅在本次会话生成/编辑后可用（设计 §6.2）
      gwToken.showPlain = false
      return showTokenMsg("明文不可见（token 由外部设置，当前会话未持有），请重新「生成」或「编辑」后查看", true)
    }
    input.value = gwToken.plain
  } else {
    input.value = gwToken.masked
  }
}

/* ---- 日志：自动刷新开关 + 关键字过滤 ---- */
let logText = ""
async function refreshLog() {
  try {
    const r = await fetch("/api/log")
    logText = await r.text()
    applyLogFilter()
  } catch {}
}
function applyLogFilter() {
  const kw = document.getElementById("log-filter").value.trim().toLowerCase()
  document.getElementById("logview").textContent = kw
    ? (logText.split("\\n").filter(l => l.toLowerCase().includes(kw)).join("\\n") || "(无匹配)")
    : logText
}
let logTimer = null
function setLogAuto(on) {
  if (logTimer) { clearInterval(logTimer); logTimer = null }
  if (on) logTimer = setInterval(refreshLog, 3000)
}
async function clearLog() {
  if (!confirm("确认清空日志？")) return
  try { await api("/api/log/clear", {}); refreshLog(); showMsg("日志已清空") }
  catch (e) { showErr(e.message) }
}
refresh(); refreshLog(); refreshStats(); refreshGateway(); refreshGwLog(); switchNav("overview");
refreshPlans(); refreshGatewayConfig();
/* P1-2：定时器句柄存入 timers 对象，webOff() 可整体清理 */
var timers = {}
timers.refresh = setInterval(refresh, 5000);
timers.stats = setInterval(refreshStats, 10000);
// gateway 拉取带 2s 超时，独立异步刷新避免阻塞 status 轮询
timers.gateway = setInterval(refreshGateway, 15000);
timers.plans = setInterval(refreshPlans, 30000);
document.getElementById("log-auto").onchange = e => { setLogAuto(e.target.checked); if (e.target.checked) refreshLog() }
document.getElementById("log-filter").oninput = applyLogFilter;
</script>
</body>
</html>
`

/* ---------------- 测试导出（2026-08-16 追加，仅命名导出不改变行为；供 tests/go-rotate-plugin.test.ts 使用） ---------------- */
export {
  atomicWrite,
  WEB_HTML,
  loadConfig,
  saveConfig,
  mutateConfig,
  withLockSync,
  cooldownUntilDefault,
  parseResetTime,
  pickNext,
  rotate,
  manualRotate,
  isGoError,
  isQuotaError,
  classifyGoError,
  syncAuth,
  currentKey,
  reconcileCurrent,
  statusPayload,
  logTail,
  addKey,
  updateKey,
  removeKey,
  setCurrent,
  setCooldown,
  setCooldownWindow,
  setGlobalCooldown,
  parseStatsLog,
  gatewayStatus,
  gatewayManage,
  gatewayLog,
  gatewayCtlExists,
  genToken,
  readGatewayConfig,
  writeGatewayConfig,
  maskGatewayToken,
  gatewayConfigPayload,
  gatewayPlansPayload,
  GATEWAY_PLANS,
  handleWeb,
}