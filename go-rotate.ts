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

// 测试隔离：bun 的 homedir() 不尊重 $HOME（实测固定返回真实 home），故支持环境变量覆盖。
// 生产环境不设这两个变量，行为与之前完全一致。
const DATA_DIR = path.join(homedir(), ".config", "opencode")
const CONFIG_FILE = process.env.GOROTATE_CONFIG_FILE ?? path.join(DATA_DIR, "go-keys.json")
const AUTH_FILE = process.env.GOROTATE_AUTH_FILE ?? path.join(homedir(), ".local", "share", "opencode", "auth.json")
const LOG_FILE = "/tmp/opencode-go-rotate.log"
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
 * 未就绪回退 zen-gateway logs 300（bash 脚本只读命令）。失败容错，不抛异常。 */
async function gatewayLog(): Promise<{ ok: boolean; text: string; source: string }> {
  try {
    const r = await fetch(GATEWAY_BASE + "/api/gateway/log", { signal: AbortSignal.timeout(2000) })
    if (r.ok) {
      const text = await r.text()
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
    return new Response(WEB_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
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
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "SF Pro Text", "Segoe UI", sans-serif; margin: 0; background: #0f1115; color: #e6e8eb; }
  .wrap { max-width: 860px; margin: 0 auto; padding: 24px 16px 80px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9aa3ad; font-size: 13px; margin-bottom: 20px; }
  .card { background: #171a21; border: 1px solid #242a33; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  .stats { display: flex; gap: 24px; flex-wrap: wrap; }
  .stat .v { font-size: 22px; font-weight: 600; }
  .stat .l { font-size: 12px; color: #9aa3ad; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #242a33; }
  th { color: #9aa3ad; font-weight: 500; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 12px; }
  .b-available { background: #1b3a2a; color: #4ade80; }
  .b-cooling { background: #3a2f1b; color: #fbbf24; }
  .b-current { background: #1e3a5f; color: #60a5fa; margin-left: 6px; }
  .b-running { background: #1b3a2a; color: #4ade80; }
  .b-stopped { background: #333b46; color: #9aa3ad; }
  .b-error { background: #3b1d1d; color: #f87171; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  button:disabled:hover { background: #242a33; }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  .small { font-size: 12px; }
  .model-list { font-size: 12px; color: #9aa3ad; word-break: break-all; }
  button { background: #242a33; color: #e6e8eb; border: 1px solid #333b46; border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 13px; }
  button:hover { background: #2e3642; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  button.danger { background: #3b1d1d; border-color: #7f1d1d; color: #fca5a5; }
  input { background: #0f1115; border: 1px solid #333b46; border-radius: 6px; padding: 6px 8px; color: #e6e8eb; font-size: 13px; width: 100%; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row input { flex: 1; }
  .actions { display: flex; gap: 6px; }
  .msg { color: #4ade80; font-size: 13px; min-height: 18px; margin-top: 8px; }
  .err { color: #f87171; }
  pre { background: #0c0e12; border: 1px solid #242a33; border-radius: 8px; padding: 12px; font-size: 12px; overflow: auto; max-height: 260px; color: #9ceba8; }
  .muted { color: #6b7280; font-size: 12px; }
  .gr-tip { cursor: help; border-bottom: 1px dotted #7a8494; }
</style>
</head>
<body>
<div class="wrap">
  <h1>go-rotate · opencode-go keys</h1>
  <div class="sub">多 key 自动轮换 · 修改会自动同步到 auth.json 并立即生效</div>

  <div class="card">
    <div class="stats">
      <div class="stat"><div class="v" id="s-current">-</div><div class="l">当前 key</div></div>
      <div class="stat"><div class="v" id="s-avail">-</div><div class="l">可用 &nbsp;<span class="muted" id="s-total"></span></div></div>
      <div class="stat"><div class="v" id="s-cooldown">-</div><div class="l">冷却窗口(min) <a href="javascript:void(0)" onclick="editGlobalWindow()" style="color:#60a5fa">编辑</a></div></div>
      <div class="stat"><div class="v" id="s-autoweb">-</div><div class="l">Web 自动启动</div></div>
    </div>
    <div class="row" style="margin-top:12px">
      <span class="muted">关闭后本页面会立即停止，且 opencode 启动时不再自动起 Web（轮换功能不受影响）。</span>
      <button id="web-off-btn" class="danger" onclick="webOff()">关闭 Web</button>
      <button id="web-on-btn" onclick="webOn()">开启自动启动</button>
    </div>
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:10px"><input id="new-name" placeholder="名称，如 act2">&nbsp;<input id="new-key" placeholder="sk-xxxx 完整的 API key"><button class="primary" onclick="addKey()">新增 key</button></div>
    <div class="row" style="margin-bottom:10px"><span class="muted">手动操作：</span><button onclick="rotate()">轮换</button><button onclick="checkKeys()">检测所有 key</button><span class="muted" id="check-hint"></span></div>
    <table>
      <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>健康</th><th>操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="msg" id="msg"></div>
  </div>

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

  <div class="card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <b>网关日志</b>
      <div class="row">
        <span class="muted" id="gwlog-src"></span>
        <button onclick="refreshGwLog()">刷新</button>
      </div>
    </div>
    <pre id="gwlogview"></pre>
  </div>

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
</div>

<script>
async function api(path, body) {
  const opts = body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}
  const r = await fetch(path, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
var health = {}
async function refresh() {
  try {
    const st = await api("/api/status")
    document.getElementById("s-current").textContent = st.current || "(none)"
    document.getElementById("s-avail").textContent = st.availableCount + "/" + st.keyCount
    document.getElementById("s-total").textContent = "total " + st.keyCount
    document.getElementById("s-cooldown").textContent = st.cooldown_minutes
    document.getElementById("s-autoweb").textContent = st.auto_web ? "开启" : "关闭"
    document.getElementById("web-off-btn").disabled = !st.auto_web
    document.getElementById("web-on-btn").disabled = st.auto_web
    const tb = document.getElementById("tbody")
    tb.innerHTML = ""
    for (const k of st.keys) {
      const tr = document.createElement("tr")
      // 状态徽章：优先显示健康状态（余额不足/无效/限流），其次冷却/可用
      const statusLabel = { ok:'可用', invalid:'key 无效', nobalance:'余额不足', limited:'限流', error:'异常' }
      const statusHint = { invalid:'该 key 无效', nobalance:'余额不足，需充值', limited:'请求被限流', error:'探测异常' }
      const tip = (text, hint) => hint ? '<span class="badge b-cooling gr-tip" title="' + hint + '">' + text + '</span>' : '<span class="badge b-cooling">' + text + '</span>'
      let badge
      if (k.last_status && k.last_status !== "ok") {
        badge = tip(statusLabel[k.last_status] || k.last_status, statusHint[k.last_status] || k.last_status)
        if (k.state === "cooling") badge += '<span class="badge b-cooling">冷却 ' + k.remainMin + 'min</span>'
      } else {
        badge = k.state === "cooling" ? '<span class="badge b-cooling">冷却 ' + k.remainMin + 'min</span>' : '<span class="badge b-available">可用</span>'
      }
      if (k.isCurrent) badge += '<span class="badge b-current">当前</span>'
      const h = health[k.name]
      let hcell = '<span class="muted">-</span>'
      if (h) {
        // 详情只作为 hover 浮窗展示，不直接内联
        hcell = tip(statusLabel[h.status] || h.status, h.detail.replace(/"/g, "&quot;"))
      }
      tr.innerHTML =
        '<td>' + k.name + '</td>' +
        '<td class="muted" title="' + k.key + '">' + k.masked + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + hcell + '</td>' +
        '<td><div class="actions">' +
          (k.isCurrent ? '' : '<button data-set="' + k.name + '">启用</button>') +
          (k.state === "cooling"
            ? '<button data-cooldown="' + k.name + '" data-min="0">清除冷却</button>'
            : '<button data-cooldown="' + k.name + '" data-min="' + st.cooldown_minutes + '">冷却</button>') +
          '<button data-window="' + k.name + '" title="设置该 key 独立冷却窗口（分钟，留空清除回退全局）">窗口</button>' +
          (k.cooldown_minutes ? '<button data-window-clear="' + k.name + '" title="清除独立窗口，回退全局">清窗</button>' : '') +
          '<button data-edit="' + k.name + '" title="编辑名称 / key 值">编辑</button>' +
          '<button class="danger" data-del="' + k.name + '">删除</button>' +
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
function showErr(m) { const el = document.getElementById("msg"); el.textContent = m; el.className = "msg err"; setTimeout(() => showMsg(""), 3000) }
function showMsg(m) { const el = document.getElementById("msg"); el.textContent = m; el.className = "msg" }

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
  try {
    const st = await api("/api/stats")
    document.getElementById("st-total").textContent = st.totalRotations
    const tb = document.getElementById("stats-tbody")
    const names = Object.keys(st.byKey || {})
    if (!names.length) { tb.innerHTML = '<tr><td colspan="4" class="muted">暂无轮换记录</td></tr>'; return }
    tb.innerHTML = ""
    names.sort().forEach(name => {
      const k = st.byKey[name]
      const tr = document.createElement("tr")
      tr.innerHTML = '<td>' + name + '</td><td>' + k.rotations + '</td><td>' + k.coolings +
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
        setBtns(false, false)
        document.getElementById("gw-body").innerHTML =
          '<span class="muted">未检测到 zen-gateway 管理脚本' +
          '（<code>~/.local/bin/zen-gateway</code>）。可用 <code>bash install.sh zen-gateway</code> 安装。</span>'
      } else {
        badge.innerHTML = '<span class="badge b-stopped">未运行</span>'
        setBtns(false, true)
        document.getElementById("gw-body").innerHTML =
          '<span class="muted">zen-gateway 服务未运行' + (g.error ? '（' + g.error + '）' : '') +
          '。点「启动」拉起 launchd 服务。</span>'
      }
      return
    }
    card.style.opacity = "1"
    badge.innerHTML = '<span class="badge b-running">运行中</span>'
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
        html += '<tr><td>' + n + '</td><td>' + (s.success ?? 0) + '</td><td>' + (s.rotated ?? 0) + '</td></tr>'
      })
      html += '</tbody></table>'
    }
    // 模型列表：小字显示数量 + 前几个，details 展开看全部
    const models = g.models || []
    if (models.length) {
      const preview = models.slice(0, 4).join(", ") + (models.length > 4 ? " …" : "")
      html += '<details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">' +
        '模型（' + models.length + '）：' + preview + '</summary>' +
        '<div class="model-list" style="margin-top:4px">' + models.join("<br>") + '</div></details>'
    }
    document.getElementById("gw-body").innerHTML = html
  } catch (e) {
    card.style.opacity = "0.55"
    badge.innerHTML = '<span class="badge b-error">状态获取失败</span>'
    setDash()
    setBtns(false, false)
    document.getElementById("gw-body").innerHTML = '<span class="muted">获取失败：' + e.message + '</span>'
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

/* ---- 网关日志（/api/gateway/log，只读文本 + 手动刷新） ---- */
async function refreshGwLog() {
  const pre = document.getElementById("gwlogview")
  pre.textContent = "加载中…"
  try {
    const r = await api("/api/gateway/log")
    document.getElementById("gwlog-src").textContent =
      r.source === "gateway" ? "来源: gateway /api/gateway/log" :
      r.source === "zen-gateway logs" ? "来源: zen-gateway logs 300" : ""
    pre.textContent = r.text || "(空)"
    pre.style.color = r.ok ? "" : "#f87171"
  } catch (e) {
    pre.textContent = "获取失败: " + e.message
    pre.style.color = "#f87171"
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
refresh(); refreshLog(); refreshStats(); refreshGateway(); refreshGwLog();
setInterval(refresh, 5000);
setInterval(refreshStats, 10000);
// gateway 拉取带 2s 超时，独立异步刷新避免阻塞 status 轮询
setInterval(refreshGateway, 15000);
document.getElementById("log-auto").onchange = e => { setLogAuto(e.target.checked); if (e.target.checked) refreshLog() }
document.getElementById("log-filter").oninput = applyLogFilter;
</script>
</body>
</html>`

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
  handleWeb,
}