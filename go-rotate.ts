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
// Webshare 代理导入 + 候选连通性验证（SOCKS5 握手 + CONNECT，与 gateway.mjs 同一思路，纯 JS 零依赖）
import net from "node:net"
import { lookup, Resolver } from "node:dns"
import https from "node:https"

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

/** 三域模型：zen（opencode 免费档 provider `opencode`）/ go（套餐 provider `opencode-go`）/ gateway（网关 upstream go 档） */
type Domain = "zen" | "go" | "gateway"

type KeyEntry = {
  name: string
  key: string
  cooldown_until: string | null
  /** 该 key 的独立冷却窗口（分钟）；缺省回退全局 cfg.cooldown_minutes，再回退 DEFAULT_COOLDOWN_MIN */
  cooldown_minutes?: number
  /** 最近一次探测/轮换得到的健康状态：ok | invalid | nobalance | limited | error | null（zen 域） */
  last_status?: string | null
  /** 网关域冷却记录（双域独立轮换）：null = 网关域无冷却。TUI 域冷却仍用 cooldown_until */
  cooldown_until_gateway?: string | null
  /** go 套餐域冷却记录（三域独立轮换）：null = go 域无冷却。读侧兜底缺省 null */
  cooldown_until_go?: string | null
  /** go 套餐域健康状态（双端点探测，zen→last_status / go→last_status_go） */
  last_status_go?: string | null
  /** zen 端点最近探测时间（ISO）；go 端点用 last_checked_go */
  last_checked_zen?: string | null
  last_checked_go?: string | null
}
type Config = {
  provider_id: string
  cooldown_minutes: number
  current: string
  /** 网关域游标（双域独立轮换）：读侧兜底 `current_gateway ?? current` */
  current_gateway?: string
  /** go 套餐域游标（三域独立轮换）：读侧兜底 `current_go ?? current` */
  current_go?: string
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
    const keys = (Array.isArray(cfg.keys) ? cfg.keys : [])
    .filter((k: any) => k && typeof k.name === "string" && typeof k.key === "string")
    // 归一化：每 key 显式携带三域冷却 + 健康字段（null = 该域无冷却/未探测，schema 一致；向后兼容）
    .map((k: any) => ({
      ...k,
      cooldown_until_gateway: k.cooldown_until_gateway ?? null,
      cooldown_until_go: k.cooldown_until_go ?? null,
      last_status_go: k.last_status_go ?? null,
      last_checked_zen: k.last_checked_zen ?? null,
      last_checked_go: k.last_checked_go ?? null,
    }))
    const out: any = {
      provider_id: cfg.provider_id ?? "opencode-go",
      cooldown_minutes: cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN,
      current: cfg.current ?? "",
      // 网关域游标：读侧兜底 current_gateway ?? current（旧配置无网关域字段=干净起步用 TUI 当前 key）
      current_gateway: cfg.current_gateway ?? cfg.current ?? "",
      // go 套餐域游标：读侧兜底 current_go ?? current（旧配置无 go 域字段=干净起步用 zen 当前 key）
      current_go: cfg.current_go ?? cfg.current ?? "",
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
    return { provider_id: "opencode-go", cooldown_minutes: DEFAULT_COOLDOWN_MIN, current: "", current_gateway: "", current_go: "", keys: [], auto_web: true }
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

/** 自愈：TUI 域若 current 指向不存在的 name，则回退到第一个 key；
 *  网关域若 current_gateway 指向不存在的 name，则兜底 current 或 keys[0]（同语义但作用网关域字段） */
function reconcileCurrent(cfg: Config) {
  if (!cfg.keys.some((k) => k.name === cfg.current)) {
    cfg.current = cfg.keys[0]?.name ?? ""
  }
  const next = () => (cfg.keys.some((k) => k.name === cfg.current) ? cfg.current : (cfg.keys[0]?.name ?? ""))
  // go 套餐域自愈：指向不存在 name → 兜底 zen 当前（或 keys[0]）
  if (!cfg.keys.some((k) => k.name === (cfg.current_go ?? cfg.current))) {
    cfg.current_go = next()
  }
  // 网关域自愈
  if (!cfg.keys.some((k) => k.name === cfg.current_gateway)) {
    cfg.current_gateway = next()
  }
}

function currentKey(cfg: Config, domain: "zen" | "go" = "zen"): KeyEntry | undefined {
  return cfg.keys.find((k) => k.name === domainCurrent(cfg, domain)) ?? cfg.keys[0]
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

/** go 套餐 provider 判定：`opencode-go`（或以此为后缀的形态）。真实环境 providerID 若带上下文后缀也能命中 */
function isGoProvider(pid: string): boolean {
  return pid === "opencode-go" || pid.endsWith("opencode-go")
}

/** zen 免费档 provider 判定：含 "opencode" 但非 go 套餐（`opencode` 免费层 / 其它含 opencode 前缀形态） */
function isZenProvider(pid: string): boolean {
  return String(pid).includes("opencode") && !isGoProvider(pid)
}

/** 该域游标（读侧兜底：go → current_go ?? current；gateway → current_gateway ?? current；zen → current） */
function domainCurrent(cfg: Config, domain: "zen" | "go" | "gateway" = "zen"): string {
  if (domain === "go") return cfg.current_go ?? cfg.current ?? ""
  if (domain === "gateway") return cfg.current_gateway ?? cfg.current ?? ""
  return cfg.current ?? ""
}

function pickNext(cfg: Config, domain: "zen" | "go" | "gateway" = "zen"): KeyEntry | undefined {
  const now = Date.now()
  const ordered = cfg.keys
  const startIdx = ordered.findIndex((k) => k.name === domainCurrent(cfg, domain))
  const coolField = domain === "go" ? "cooldown_until_go" : domain === "gateway" ? "cooldown_until_gateway" : "cooldown_until"
  for (let i = 1; i <= ordered.length; i++) {
    const k = ordered[(startIdx + i) % ordered.length]
    if (!k) continue
    const c = (k as any)[coolField]
    if (!c || Date.parse(c) <= now) return k
  }
  return undefined
}

/** 轮换（锁内执行）：当前 key 进冷却，切换到下一个可用 key。
 *  domain="zen"（默认，现状字段不变）写 cooldown_until/last_status/current 并 syncAuth；
 *  domain="go" 写 cooldown_until_go/last_status_go/current_go，且【不写 auth.json】——auth.json
 *  单槽仅由 zen 免费档域维护（go 套餐域与网关域一样，轮换不碰 auth.json）。 */
function rotate(errMsg: string, err?: any, domain: "zen" | "go" = "zen"): Config {
  return mutateConfig((cfg) => {
    const isGo = domain === "go"
    const cur = currentKey(cfg, domain)
    if (cur) {
      const cooldownVal = parseResetTime(errMsg) ?? cooldownUntilDefault(cfg, cur)
      const st = classifyGoError(errMsg, err?.data?.statusCode)
      if (isGo) {
        cur.cooldown_until_go = cooldownVal
        cur.last_status_go = st
      } else {
        cur.cooldown_until = cooldownVal
        cur.last_status = st
      }
      log(`⚠️  key "${cur.name}" 配额耗尽（${st}），进入${isGo ? "go 域" : "zen 域"}冷却 until=${cooldownVal}`)
    }
    const next = pickNext(cfg, domain)
    if (!next) {
      log(`❌  ${isGo ? "go 域" : "zen 域"}没有可用 key（全部在冷却期），维持当前 key "${domainCurrent(cfg, domain)}"`)
      return
    }
    if (isGo) cfg.current_go = next.name
    else cfg.current = next.name
    const nk = currentKey(cfg, domain)
    if (nk) { if (isGo) nk.last_status_go = null; else nk.last_status = null }
    if (!isGo) syncAuth(next.key)
    log(isGo
      ? `✅  go 域轮换到 key "${next.name}"（go 域不写 auth.json）`
      : `✅  轮换到 key "${next.name}"，已同步 auth.json`)
  })
}

/** 手动轮换到下一个可用 key（web/CLI 用）。domain 缺省 zen；go/gateway 域不写 auth.json。 */
function manualRotate(domain: "zen" | "go" | "gateway" = "zen"): Config {
  return mutateConfig((cfg) => {
    const next = pickNext(cfg, domain === "go" ? "go" : domain === "gateway" ? "gateway" : "zen")
    const label = domain === "go" ? "go 域" : domain === "gateway" ? "网关域" : "zen 域"
    if (!next) {
      log(`❌  手动轮换（${label}）：没有可用 key，保持当前`)
      return
    }
    if (domain === "go") cfg.current_go = next.name
    else if (domain === "gateway") cfg.current_gateway = next.name
    else cfg.current = next.name
    if (domain === "zen") syncAuth(next.key) // 网关/go 域绝不写 auth.json（双域独立轮换红线）
    log(`🔄  ${label}手动轮换到 key "${next.name}"${domain === "zen" ? "" : "（不写 auth.json）"}`)
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
    if (!key.startsWith("sk-")) throw new Error(`key 必须以 "sk-" 开头（当前值被拒绝）`)
    cfg.keys.push({ name, key, cooldown_until: null, cooldown_until_gateway: null, cooldown_until_go: null })
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
      const wasGatewayCurrent = k.name === cfg.current_gateway
      const wasGoCurrent = k.name === cfg.current_go
      k.name = patch.name
      if (wasCurrent) cfg.current = patch.name
      if (wasGatewayCurrent) cfg.current_gateway = patch.name
      if (wasGoCurrent) cfg.current_go = patch.name
    }
    if (patch.key) {
      if (!patch.key.startsWith("sk-")) throw new Error(`key 必须以 "sk-" 开头（当前值被拒绝）`)
      k.key = patch.key
    }
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

/** 设置网关域当前 key（web 用，domain="gateway"）。绝不 syncAuth（双域独立：网关域轮换不影响 auth.json） */
function setGatewayCurrent(name: string): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    cfg.current_gateway = k.name
    log(`🎯  手动设置网关域当前 key 为 "${k.name}"`)
  })
}

/** 设置 go 套餐域当前 key（web/API 用，domain="go"）。绝不 syncAuth（go 域轮换不碰 auth.json） */
function setGoCurrent(name: string): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    cfg.current_go = k.name
    log(`🎯  手动设置 go 套餐域当前 key 为 "${k.name}"`)
  })
}

/** 设置/清除 go 套餐域冷却（cooldown_until_go；zen 域冷却用 setCooldown，网关域用 setGatewayCooldown） */
function setGoCooldown(name: string, minutes: number | null): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    if (minutes === null) {
      k.cooldown_until_go = null
      log(`🧊  清除 key "${name}" go 域名冷却`)
    } else {
      k.cooldown_until_go = new Date(Date.now() + minutes * 60_000).toISOString()
      log(`🧊  key "${name}" go 域进入冷却 ${minutes} 分钟`)
    }
  })
}

/** 设置/清除网关域冷却（cooldown_until_gateway；TUI 域冷却用 setCooldown） */
function setGatewayCooldown(name: string, minutes: number | null): Config {
  return mutateConfig((cfg) => {
    const k = cfg.keys.find((x) => x.name === name)
    if (!k) throw new Error(`key "${name}" 不存在`)
    if (minutes === null) {
      k.cooldown_until_gateway = null
      log(`🧊  清除 key "${name}" 网关域冷却`)
    } else {
      k.cooldown_until_gateway = new Date(Date.now() + minutes * 60_000).toISOString()
      log(`🧊  key "${name}" 网关域进入冷却 ${minutes} 分钟`)
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
      cooldown_until_go: k.cooldown_until_go ?? null,
      cooldown_until_gateway: k.cooldown_until_gateway ?? null,
      cooldown_minutes: k.cooldown_minutes ?? null,
      last_status: k.last_status ?? null,
      last_status_go: k.last_status_go ?? null,
      last_checked_zen: k.last_checked_zen ?? null,
      last_checked_go: k.last_checked_go ?? null,
      isCurrent: k.name === cfg.current,
      isCurrentGo: k.name === (cfg.current_go ?? cfg.current),
      isCurrentGateway: k.name === (cfg.current_gateway ?? cfg.current),
    }
  })
  return {
    provider_id: cfg.provider_id,
    cooldown_minutes: cfg.cooldown_minutes,
    current: cfg.current,
    current_go: cfg.current_go ?? cfg.current ?? "",
    current_gateway: cfg.current_gateway ?? cfg.current ?? "",
    auto_web: cfg.auto_web !== false,
    keyCount: cfg.keys.length,
    availableCount: keys.filter((k) => k.state === "available").length,
    egressEnabled: gatewayEgressEnabled(cfg),
    keys,
  }
}

/* egress 是否启用（P0-2 系统健康聚合用，动态读配置与开关） */
function gatewayEgressEnabled(cfg: any): boolean {
  const g = readGatewayConfig()
  if (g.ip_rotation === false) return false
  const list = (g.egress ?? []).filter((u: string) => u && u !== "direct")
  return list.length >= 2
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

/** 网关鉴权头：读 gateway-config.json 里的 token（若设置）→ fetch 18888 时附带 Bearer。
 *  网关设了 token 时所有端点都要鉴权（实测无 Bearer 一律 401），不带则 Web 读不到模型/用量/日志。 */
function gatewayAuthHeaders(): Record<string, string> {
  try {
    const cfg = readGatewayConfig()
    const t = cfg.tokens.length > 0 ? cfg.tokens[0] : cfg.token
    return t ? { authorization: `Bearer ${t}` } : {}
  } catch {
    return {}
  }
}
// 网关运行时配置（套餐 + token）：独立文件，与 go-keys.json 职责分离（低频静态配置 + 敏感凭据隔离）。
// 文件缺失回退默认（go / 无 token）；GOROTATE_GATEWAY_CONFIG 仅供测试隔离覆盖（生产不设行为不变）
const GATEWAY_CONFIG_FILE =
  process.env.GOROTATE_GATEWAY_CONFIG ??
  path.join(homedir(), ".local", "share", "zen-gateway", "gateway-config.json")
// 出口健康检查结果本地缓存（与 gateway-config 同目录独立文件，勿污染 gateway-config schema）。
// 每次健康检查成功后写入；页面加载时读回渲染健康徽标（无需重探）。
const EGRESS_HEALTH_FILE = path.join(path.dirname(GATEWAY_CONFIG_FILE), "egress-health.json")
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
    const r = await fetch(GATEWAY_BASE + "/api/gateway/log", { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) })
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

/** 用量趋势（只读代理）：把网关 GET /api/usage/trend?days=N 透传给 Web（go-rotate.ts 不落盘聚合，
 *  网关已按日聚合返回 {total, byKey, byDay, byEndpoint, badLines, window}）。
 *  带网关鉴权头 + 2s 超时；网关不可达 / 非 JSON / 非 200 一律降级 {ok:false, error}（不抛异常）。 */
async function gatewayUsageTrend(days?: string | null): Promise<any> {
  try {
    let q = "?days=7"
    const n = Number(days)
    if (days !== undefined && days !== null && days !== "" && Number.isInteger(n) && n > 0) q = "?days=" + encodeURIComponent(String(n))
    const r = await fetch(GATEWAY_BASE + "/api/usage/trend" + q, { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) })
    if (!r.ok) return { ok: false, error: "gateway HTTP " + r.status }
    const j: any = await r.json().catch(() => null)
    if (!j || typeof j !== "object") return { ok: false, error: "gateway 返回非 JSON" }
    return { ok: true, ...j }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

async function gatewayStatus(): Promise<{
  running: boolean
  ctlExists: boolean
  healthz?: any
  usage?: any
  models?: string[]
  modelCount?: number
  gwModels?: any
  version?: string
  error?: string
}> {
  const [h, u, m, s, gm] = await Promise.allSettled([
    fetch(GATEWAY_BASE + "/healthz", { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    fetch(GATEWAY_BASE + "/api/usage", { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    fetch(GATEWAY_BASE + "/v1/models", { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    // 网关只读状态端点：透传 version（旧网关无此端点/字段时缺失，前端容错显示 '—'）
    fetch(GATEWAY_BASE + "/api/gateway/status", { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
    // go + zen 双套餐模型明细（动态 ∪ 内置），供 Web「动态查看全部模型」
    fetch(GATEWAY_BASE + "/api/gateway/models", { headers: gatewayAuthHeaders(), signal: AbortSignal.timeout(2000) }).then((r) => r.json()),
  ])
  const out: any = { running: h.status === "fulfilled", ctlExists: gatewayCtlExists() }
  if (h.status === "fulfilled") out.healthz = h.value
  if (u.status === "fulfilled") out.usage = u.value
  if (m.status === "fulfilled" && Array.isArray(m.value?.data)) {
    out.models = m.value.data.map((x: any) => x?.id).filter(Boolean)
    out.modelCount = out.models.length
  }
  if (gm.status === "fulfilled" && gm.value && typeof gm.value?.plans === "object") {
    // 新网关双套餐结构：以 plans 为准（当前套餐合并清单 `models` 同步派生，旧渲染兼容）
    out.gwModels = gm.value
    const ap = gm.value.plans?.[gm.value.active]
    if (ap && Array.isArray(ap.models)) {
      out.models = ap.models
      out.modelCount = ap.models.length
    }
  }
  if (s.status === "fulfilled" && typeof s.value?.version === "string") out.version = s.value.version
  if (h.status === "rejected") out.error = String(h.reason?.message ?? h.reason)
  return out
}

/** 网关功能测试（真实端到端）：经网关发一条最小 chat 请求验证全链路（网关进程 → 上游 opencode → 模型返回）。
 *  healthz 只证明网关进程在；本测试证明「当前网关配置 + 当前 key + 上游」真的能出结果。
 *  - 模型取当前套餐默认（go→hy3 / zen→hy3-free），由网关负责别名/回退
 *  - 上游可能慢（推理模型/限流），超时取 20s
 *  - 返回 { ok, status?, ms?, model?, detail }；ok=false 时 detail 含可展示原因分类
 */
async function gatewayTest(): Promise<{
  ok: boolean
  status?: number
  ms?: number
  model?: string
  detail: string
}> {
  const plan = readGatewayConfig().plan === "zen" ? "zen" : "go"
  const model = plan === "zen" ? "hy3-free" : "hy3"
  const headers: Record<string, string> = { "content-type": "application/json", ...gatewayAuthHeaders() }
  const t0 = Date.now()
  try {
    const r = await fetch(GATEWAY_BASE + "/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with exactly: OK" }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(20000),
    })
    const ms = Date.now() - t0
    const text = await r.text().catch(() => "")
    if (r.ok) {
      // 200：网关 + 上游链路通（读到 choices 更稳）。如果 body 不可解析仍视为 ok（上游非 JSON 分支少见）
      try {
        const j = JSON.parse(text)
        const c = j?.choices?.[0]?.message?.content
        const reason = String(j?.choices?.[0]?.finish_reason ?? "")
        const snippet = typeof c === "string" && c.trim() ? c.trim().slice(0, 60) : "(无文本，推理模型截断属正常)"
        return { ok: true, status: r.status, ms, model, detail: `HTTP ${r.status} ${ms}ms · 模型 ${model} 响应: ${snippet}（finish_reason=${reason || "-"}）` }
      } catch {
        return { ok: true, status: r.status, ms, model, detail: `HTTP ${r.status} ${ms}ms · 模型 ${model} 响应（body 非 JSON，链路通）` }
      }
    }
    // 失败：分类上游错误
    let msg = text
    let errType = ""
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message ?? text
      errType = String(j?.error?.type ?? "")
    } catch {}
    const why = `${r.status} ${String(msg).slice(0, 120)}`
    if (r.status === 429 && /FreeUsageLimit/i.test(errType))
      return { ok: false, status: r.status, ms, model, detail: `免费档限流（FreeUsageLimitError，按 UA/频率限流，非 key 问题）: ${why}` }
    if (r.status === 401 || r.status === 402 || /insufficient|balance/i.test(String(msg)))
      return { ok: false, status: r.status, ms, model, detail: `配额/鉴权（402/401）: ${why}` }
    if (r.status === 429 || /quota|rate|limit|exceeded/i.test(String(msg)))
      return { ok: false, status: r.status, ms, model, detail: `上游限流（429）: ${why}` }
    return { ok: false, status: r.status, ms, model, detail: `网关返回错误: ${why}` }
  } catch (e: any) {
    return { ok: false, detail: `网关不可达/请求失败: ${String(e?.message ?? e)}` }
  }
}

/** 出口健康检查结果本地缓存：读（损坏/缺失回退 {}）。不含敏感信息，纯 {url:{ok,status,ms,error,checkedAt}}。 */
function readEgressHealthCache(): Record<string, any> {
  try {
    if (!existsSync(EGRESS_HEALTH_FILE)) return {}
    const raw = JSON.parse(readFileSync(EGRESS_HEALTH_FILE, "utf8"))
    return raw && typeof raw === "object" ? raw : {}
  } catch (e) {
    log(`readEgressHealthCache error: ${(e as Error).message}`)
    return {}
  }
}

/** 出口健康检查结果本地缓存：原子写（.tmp + rename），写失败仅 log 不阻断调用链。 */
function writeEgressHealthCache(map: Record<string, any>) {
  try {
    mkdirSync(path.dirname(EGRESS_HEALTH_FILE), { recursive: true })
    atomicWrite(EGRESS_HEALTH_FILE, JSON.stringify(map, null, 2), 0o600)
  } catch (e) {
    log(`writeEgressHealthCache error: ${(e as Error).message}`)
  }
}

/** 出口池健康检查代理：转发到网关 POST /api/gateway/egress/health（真实最小探测每出口）。
 *  网关不可达 → {ok:false, error}；可达则返回 {ok:true, checkedAt, egress:[{index,url,ok,status,ms,error}]}。
 *  expectUrl 可选：只探测指定出口（限流池移回前验证是否解限）。成功结果写入本地缓存（刷新页面后健康徽标仍在）。 */
async function gatewayEgressHealthProxy(expectUrl?: string): Promise<any> {
  try {
    // 超时按池大小动态计算：网关并发 5 探测、每项最坏 15s → 最坏 ⌈N/5⌉×15s；再兜底 +10s
    // 全池=0 项也按 1 项算（单 url 探测 15s+F 余量）；上限 150s 防极端池拖死 FE。
    const poolN = expectUrl ? 1 : (readGatewayConfig().egress ?? []).length
    const worst = Math.ceil(Math.max(poolN, 1) / 5) * 15000 + 10000
    const timeoutMs = Math.min(worst, 150000)
    const q = expectUrl ? "?url=" + encodeURIComponent(expectUrl) : ""
    const r = await fetch(GATEWAY_BASE + "/api/gateway/egress/health" + q, {
       method: "POST",
       headers: gatewayAuthHeaders(),
       signal: AbortSignal.timeout(timeoutMs), // 并发探测所有出口，按池大小给足时间
     })
     const j: any = await r.json().catch(() => null)
     if (!r.ok || !j) return { ok: false, error: j?.error?.message ?? `网关健康检查失败 HTTP ${r.status}` }
     // 成功：把本次探测结果合并写入本地缓存（含 checkedAt 时间戳，供页面加载回显 / 陈旧提示）
     const egress = j.egress ?? []
     if (Array.isArray(egress) && egress.length) {
       const cache = readEgressHealthCache()
       for (const x of egress) {
         if (x?.url) cache[x.url] = { ok: x.ok, status: x.status, ms: x.ms, error: x.error, checkedAt: j.checkedAt ?? new Date().toISOString() }
       }
       writeEgressHealthCache(cache)
     }
     return { ok: true, checkedAt: j.checkedAt, egress }
   } catch (e: any) {
     return { ok: false, error: String(e?.message ?? e) }
   }
 }

/* ---------------- 梯子（本地 SOCKS5 透明代理）Web 集成 ----------------
 * 梯子 = 网关在 127.0.0.1:<port> 起的本地 SOCKS5 服务，其它应用（浏览器/curl/git）指向它即可
 * 科学上网；每个 CONNECT 隧道经出口池轮换（rotate）或固定出口（fixed）转发到目标。
 * 配置写 gateway-config.json 的 ladder 字段（writeGatewayConfig 负责校验 + 锁），
 * 写后调网关 apply 即时启动/停止（无需重启网关）。 */

async function gatewayLadderFetch(url: string, init?: any): Promise<any> {
  const r = await fetch(GATEWAY_BASE + url, init)
  const j: any = await r.json().catch(() => null)
  if (!r.ok) return { ok: false, running: false, error: j?.error?.message ?? `网关 HTTP ${r.status}` }
  return { ok: true, ...(j ?? {}) }
}

/** 梯子状态（读 config 字段 + 网关运行态合并；网关不可达时给配置侧信息 + running:false）。 */
async function gatewayLadderStatus(): Promise<any> {
  const cfg = readGatewayConfig().ladder ?? { enabled: false, port: 10880, mode: "rotate", fixed: null }
  try {
    const g = await gatewayLadderFetch("/api/gateway/ladder", {
      headers: gatewayAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    })
    return { ok: g.ok !== false, enabled: cfg.enabled, port: cfg.port, mode: cfg.mode, fixed: cfg.fixed, running: g.running === true, egressCount: g.egressCount ?? (readGatewayConfig().egress ?? []).length, conns: g.conns ?? 0, error: g.error }
  } catch (e: any) {
    return { ok: false, enabled: cfg.enabled, port: cfg.port, mode: cfg.mode, fixed: cfg.fixed, running: false, egressCount: (readGatewayConfig().egress ?? []).length, error: String(e?.message ?? e) }
  }
}

/** 通知网关根据当前配置应用梯子（启用→启动；停用→停止）。 */
async function gatewayLadderApply(): Promise<any> {
  try {
    const g = await gatewayLadderFetch("/api/gateway/ladder?action=apply", {
      method: "POST",
      headers: { ...gatewayAuthHeaders(), "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    })
    return g.ok === false ? { ok: false, error: g.error } : { ok: true, running: g.running === true, port: g.port ?? 10880, mode: g.mode, enabled: g.enabled }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 强制停止梯子服务。 */
async function gatewayLadderControl(action: "stop"): Promise<any> {
  try {
    const g = await gatewayLadderFetch("/api/gateway/ladder?action=" + action, {
      method: "POST",
      headers: { ...gatewayAuthHeaders(), "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(4000),
    })
    return g.ok === false ? { ok: false, error: g.error } : { ok: true, running: g.running === true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 梯子科学上网筛选（代理到网关：探测每出口能否 CONNECT 被墙站点 + 出口 IP 归属）。 */
async function gatewayLadderCheck(urls?: string[]): Promise<any> {
  try {
    const r = await fetch(GATEWAY_BASE + "/api/gateway/ladder/check", {
      method: "POST",
      headers: { ...gatewayAuthHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ urls: urls ?? null }),
      signal: AbortSignal.timeout(60000), // 每出口最多 google+youtube+ip-api 三个探测，并发 5 → 池大时给足 60s
    })
    const j: any = await r.json().catch(() => null)
    if (!r.ok || !j) return { ok: false, error: j?.error ?? `网关 HTTP ${r.status}` }
    return { ok: true, ...j }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/* ---------------- Webshare 代理导入 + 连通性验证（Web「IP 池」卡，零依赖） ----------------
 * 支持两种凭据：① Download Link（面板「Download」生成的下载链接，短时效、含水敏 token）
 *              ② API Token Key（面板长期有效的 api key）。
 * mode=link  → 直接 GET 下载链接返回纯文本（每行 host:port:user:pass 或 socks5://）
 * mode=token → GET /api/v2/proxy/list/?mode=direct&page_size=100 + Authorization: Token <key> → JSON results
 * 解析为 socks5://user:pass@host:port → 逐个做完整 SOCKS5 握手 + CONNECT 隧道到 opencode.ai:443，
 * 返回 {url, ok, ms, err} 供前端展示状态。 */

const PROBE_HOST = "opencode.ai"
const PROBE_PORT = 443

/** Webshare API 域名在本机 DNS 可能被污染（GFW 返回错误 IP），用固定公开解析器（8.8.8.8/1.1.1.1）绕过。 */
const WEBSHARE_HOST = "proxy.webshare.io"
const WEBSHARE_RESOLVERS = ["8.8.8.8", "1.1.1.1"]

/** 用公开解析器解析 host → IPv4 列表（绕过系统 DNS 污染）。失败返回 []。 */
function webshareDnsResolve(hostname: string): Promise<string[]> {
  return new Promise((resolve) => {
    const r = new Resolver()
    r.setServers(WEBSHARE_RESOLVERS)
    r.resolve4(hostname, (err, addrs) => {
      try { r.cancel() } catch {}
      resolve(err || !addrs.length ? [] : addrs)
    })
  })
}

/** 对 Webshare Host 发起 HTTPS GET（自定义 lookup 用公开解析器 + SNI 保持真实域名）。 */
function webshareHttpsGet(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: WEBSHARE_HOST,
      port: 443,
      lookup: (h: string, opts: any, cb: any) => {
        webshareDnsResolve(h).then((addrs) => {
          if (!addrs.length) return cb(new Error("dns empty"))
          if (opts.all) return cb(null, addrs.map((address) => ({ address, family: 4 })))
          cb(null, addrs[0], 4)
        })
      },
      servername: WEBSHARE_HOST,
      headers: { host: WEBSHARE_HOST, "user-agent": "Mozilla/5.0", ...headers },
      path,
      method: "GET",
      timeout: 15000,
    }, (res) => {
      let b = ""
      res.on("data", (c) => (b += c))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.on("error", (e) => resolve({ status: 0, body: String(e.message) }))
    req.end()
  })
}

/** 解析 Webshare 下载链接返回的文本 → socks5://user:pass@host:port 唯一列表。
 *  容忍行格式：host:port / host:port:user:pass / socks5://...@host:port；# 注释跳过。 */
function parseWebshareDownloadText(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split("\n")) {
    let line = raw.trim()
    if (!line || line.startsWith("#")) continue
    if (line.startsWith("socks5://")) line = line.slice("socks5://".length)
    // 格式：host:port / host:port:user:pass（用户/密码可能含 :，取前两段为 host/port）
    const parts = line.split(":")
    if (parts.length < 2) continue
    const host = parts[0]
    const port = Number(parts[1])
    if (!host || !(port >= 1 && port <= 65535)) continue
    const rest = parts.slice(2)
    const url = rest.length >= 2 ? `socks5://${rest[0]}:${rest.slice(1).join(":")}@${host}:${port}` : `socks5://${host}:${port}`
    if (!seen.has(url)) seen.add(url)
  }
  return [...seen]
}

/** 对单个 socks5 代理做连通性验证：TCP → SOCKS5 握手(无认证/user-pass) → CONNECT 到 opencode.ai:443。
 *  返回 {ok, ms, err}；任一步失败 ok=false + err。目标主机先本地 DNS 解析为 IPv4（代理只做隧道转发）。 */
function probeSocks5(url: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; err?: string }> {
  const m = url.match(/^socks5:\/\/(?:(.*)@)?([^:]+):(\d{1,5})$/)
  if (!m) return Promise.resolve({ ok: false, ms: 0, err: "url 非法" })
  const [, cred, host, portStr] = m
  const port = Number(portStr)
  const [user, pass] = cred ? cred.split(":") : [null, null]
  return new Promise((resolve) => {
    const t0 = Date.now()
    lookup(PROBE_HOST, { family: 4 }, (dnsErr, ip) => {
      if (dnsErr) return resolve({ ok: false, ms: 0, err: `dns: ${dnsErr.message}` })
      const sock = net.connect(port, host)
      let stage = 0 // 0=握手 1=user-pass 认证 2=CONNECT
      let settled = false
      let buf = Buffer.alloc(0)
      const timer = setTimeout(() => fail(`timeout ${timeoutMs}ms`), timeoutMs)
      const cleanup = () => clearTimeout(timer)
      const fail = (err: string) => {
        if (settled) return
        settled = true; cleanup(); sock.destroy()
        resolve({ ok: false, ms: Date.now() - t0, err })
      }
      const sendConnect = (targetIp: string) => {
        stage = 2
        const req = Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, 0x01]),
          Buffer.from(targetIp.split(".").map(Number)),
          Buffer.from([(PROBE_PORT >> 8) & 0xff, PROBE_PORT & 0xff]),
        ])
        sock.write(req)
      }
      sock.on("error", (e) => fail(`conn: ${e.message}`))
      sock.on("connect", () => {
        const methods = user ? [0x00, 0x02] : [0x00]
        sock.write(Buffer.from([0x05, methods.length, ...methods]))
      })
      sock.on("data", (chunk: Buffer) => {
        if (settled) return
        buf = Buffer.concat([buf, chunk])
        if (stage === 0) {
          if (buf.length < 2) return
          const ver = buf[0], method = buf[1]
          buf = buf.subarray(2)
          if (ver !== 0x05) return fail("握手版本错误")
          if (method === 0x00) sendConnect(ip)
          else if (method === 0x02 && user) {
            stage = 1
            const ub = Buffer.from(user, "utf8"), pb = Buffer.from(pass || "", "utf8")
            sock.write(Buffer.concat([Buffer.from([0x01, ub.length]), ub, Buffer.from([pb.length]), pb]))
          } else fail("握手方法不被接受")
        } else if (stage === 1) {
          if (buf.length < 2) return
          if (buf[1] !== 0x00) return fail("user-pass 认证失败")
          buf = buf.subarray(2)
          sendConnect(ip)
        } else if (stage === 2) {
          if (buf.length < 10) return
          cleanup()
          if (buf[1] === 0x00) {
            settled = true; sock.destroy()
            resolve({ ok: true, ms: Date.now() - t0 })
          } else {
            fail(`CONNECT 拒绝 code=${buf[1]}`)
          }
        }
      })
    })
  })
}

/** 拉取 Webshare 代理列表（mode=link 下载链接 / mode=token API Key）→ 候选去重 → 并发连通验证（限制并发 20）。
 *  返回 {ok, total, checked, candidates:[{url, ok, ms, err}]}；凭据错误/网络失败返回 {ok:false, error}。 */
async function fetchWebshareProxies(mode: string, value: string, limit = 200, timeoutMs = 5000): Promise<any> {
  const input: string[] = []
  const v = String(value ?? "").trim()
  if (!v) return { ok: false, error: "缺少凭据：下载链接 或 API Token Key" }
  if (mode === "token") {
    const r = await webshareHttpsGet("/api/v2/proxy/list/?mode=direct&page_size=100", { authorization: `Token ${v}` })
    if (r.status !== 200) return { ok: false, error: `Webshare API 请求失败 HTTP ${r.status}（凭据无效或已过期）: ${r.body.slice(0, 120)}` }
    let j: any
    try { j = JSON.parse(r.body) } catch (e) { return { ok: false, error: `Webshare API 返回非法 JSON: ${String(e)}` } }
    const results: any[] = Array.isArray(j?.results) ? j.results : []
    for (const it of results) {
      const u = String(it?.username ?? ""), pw = String(it?.password ?? ""), host = String(it?.proxy_address ?? ""), port = it?.port
      if (u && pw && host && Number(port) >= 1) input.push(`socks5://${u}:${pw}@${host}:${port}`)
    }
  } else {
    // link：value=完整下载链接 → 取 path+query 拼接请求
    let u: URL
    try { u = new URL(v) } catch { return { ok: false, error: "下载链接格式无效" } }
    const r = await webshareHttpsGet(u.pathname + u.search, {})
    if (r.status !== 200) return { ok: false, error: `下载链接请求失败 HTTP ${r.status}（链接已过期，请重新生成）: ${r.body.slice(0, 120)}` }
    input.push(...parseWebshareDownloadText(r.body))
  }
  const seen = new Set<string>()
  const pool = input.filter((u) => (seen.has(u) ? false : (seen.add(u), true)))
  const limited = pool.slice(0, limit)
  const results: any[] = []
  const queue = [...limited]
  const workers = Array.from({ length: Math.min(20, limited.length || 1) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (!item) break
      const st = await probeSocks5(item, timeoutMs)
      results.push({ url: item, ok: st.ok, ms: st.ms, err: st.err ?? null })
    }
  })
  await Promise.allSettled(workers)
  results.sort((a, b) => Number(b.ok) - Number(a.ok) || (a.ms || 1e9) - (b.ms || 1e9))
  return { ok: true, total: pool.length, checked: results.length, candidates: results }
}

/** GET /api/gateway/models 透传：网关 go + zen 双套餐模型清单（各自动态 ∪ 内置）+ 别名。
 *  网关不可达/失败 → {ok:false, error}，前端降级显示。 */
async function gatewayModelsProxy(): Promise<any> {
  try {
    const r = await fetch(GATEWAY_BASE + "/api/gateway/models", {
      headers: gatewayAuthHeaders(),
      signal: AbortSignal.timeout(2000),
    })
    const j: any = await r.json().catch(() => null)
    if (!r.ok || !j) return { ok: false, error: j?.error?.message ?? `网关无响应 HTTP ${r.status}` }
    return { ok: true, ...j }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 触发网关重拉 go + zen 双套餐上游模型表（gateway /v1/models/refresh）。网关不可达/失败 → {ok:false, error}。 */
async function gatewayModelsRefresh(): Promise<any> {
  try {
    const r = await fetch(GATEWAY_BASE + "/v1/models/refresh", {
      method: "POST",
      headers: gatewayAuthHeaders(),
      signal: AbortSignal.timeout(6000),
    })
    const j: any = await r.json().catch(() => null)
    if (!r.ok) return { ok: false, error: j?.error?.message ?? `网关刷新失败 HTTP ${r.status}` }
    return { ok: true, ...(j && typeof j === "object" ? j : {}) }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/* ---------------- 网关配置（gateway-config.json：套餐 + token） ----------------
 * 独立于 go-keys.json：低频静态配置 + 敏感凭据隔离。写路径走 withLockSync（跨进程锁）
 * + atomicWrite（tmp+rename）+ 0600；只落盘不重启（重启由前端显式调 /api/gateway/restart，
 * 职责分离：用户可先改多个配置项再一次性重启）。
 */
type GatewayConfig = {
  plan: string
  token: string | null
  token_set_at: string | null
  tokens: string[]
  egress: string[]
  egress_active: string[] // 手动选中的轮换子集（非空时网关只用它轮换；空=全池；由「启用选中」写入）
  limited: string[] // 已被上游限流（429）的出口，从主池移出单独管理（不参与轮换）
  dead: string[] // 已确认不可用的出口（探测失败/超时），从主池/限流池移出单独管理（不参与轮换）
  ip_rotation: boolean // IP 轮换总开关（默认 true；false = 即使有出口池也直接走本地直连）
  auto_rotate_keys: boolean // 网关 key 自动轮换开关（默认 false；zen 免费档默认禁用，开启后配额耗尽也轮换 key）
  egress_index: number // 网关 HTTP 出口轮换游标（重启后续接；由网关 persistEgressIndex 写入，插件只读透传）
  ladder: {
    enabled: boolean
    port: number
    mode: "rotate" | "fixed"
    fixed: string | null
    egress: string[] // 梯子专用出口池（第四池）：rotate 模式优先走本池，池空回退主 egress 池
  } | null // 梯子（本地 SOCKS5 透明代理）：供其它应用科学上网使用；rotate=轮换出口池 / fixed=固定出口
}

function defaultGatewayConfig(): GatewayConfig {
  return { plan: "go", token: null, token_set_at: null, tokens: [], egress: [], egress_active: [], limited: [], dead: [], ip_rotation: true, auto_rotate_keys: false, egress_index: 0, ladder: null }
}

function readGatewayConfig(): GatewayConfig {
  try {
    if (!existsSync(GATEWAY_CONFIG_FILE)) return defaultGatewayConfig()
    const raw = JSON.parse(readFileSync(GATEWAY_CONFIG_FILE, "utf8"))
    const tokens = Array.isArray(raw.tokens)
      ? raw.tokens.filter((t: unknown): t is string => typeof t === "string" && t.length > 0)
      : typeof raw.token === "string" && raw.token
        ? [raw.token]
        : []
    return {
      plan: raw.plan === "zen" ? "zen" : "go",
      token: tokens.length > 0 ? tokens[0] : null,
      token_set_at: typeof raw.token_set_at === "string" ? raw.token_set_at : null,
      tokens,
      egress: Array.isArray(raw.egress)
        ? raw.egress.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
        : [],
      egress_active: Array.isArray(raw.egress_active)
        ? raw.egress_active.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
        : [],
      limited: Array.isArray(raw.limited)
        ? raw.limited.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
        : [],
      dead: Array.isArray(raw.dead)
        ? raw.dead.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
        : [],
      ladder:
        raw.ladder && typeof raw.ladder === "object"
          ? {
              enabled: raw.ladder.enabled === true,
              port: Number.isInteger(raw.ladder.port) && (raw.ladder.port as number) > 0 ? (raw.ladder.port as number) : 10880,
              mode: raw.ladder.mode === "fixed" ? "fixed" : "rotate",
              fixed: typeof raw.ladder.fixed === "string" && raw.ladder.fixed ? raw.ladder.fixed : null,
              egress: Array.isArray((raw.ladder as any).egress)
                ? (raw.ladder as any).egress.filter((e: unknown): e is string => typeof e === "string" && e.length > 0)
                : [],
            }
          : null,
      ip_rotation: raw.ip_rotation !== false, // 缺省开启；显式 false 关闭
      auto_rotate_keys: raw.auto_rotate_keys === true, // 缺省关闭（zen 免费档默认禁用自动轮换；显式 true 开启）
      egress_index: Number.isInteger(raw.egress_index) && (raw.egress_index as number) >= 0 ? (raw.egress_index as number) : 0,
    }
  } catch (e) {
    log(`readGatewayConfig error: ${(e as Error).message}`)
    return defaultGatewayConfig()
  }
}

/** 写网关配置（plan / tokens / egress 至少给一个；tokens:null = 清空关鉴权）。token 单值写兼容 → tokens=[v]。
 *  旧字段 token 始终同步为 tokens[0]（旧版网关只读 token 也能用第一个 key）。egress=IP 轮换出口池（zen 免费档），
 *  "direct" / "socks5://[user:pass@]host:port"，≥2 项启用轮换。返回写后配置。 */
function writeGatewayConfig(patch: {
  plan?: string
  token?: string | null
  tokens?: string[] | null
  egress?: string[] | null
  egress_active?: string[] | null
  limited?: string[] | null
  dead?: string[] | null
  ladder?: {
    enabled?: boolean
    port?: number
    mode?: "rotate" | "fixed"
    fixed?: string | null
} | null
  ip_rotation?: boolean
  auto_rotate_keys?: boolean
  egress_index?: number
}): GatewayConfig {
  return withLockSync<GatewayConfig>(() => {
    const cfg = readGatewayConfig()
    if (patch.plan !== undefined) {
      if (patch.plan !== "go" && patch.plan !== "zen")
        throw new Error(`plan 必须是 "go" 或 "zen"，收到: ${patch.plan}`)
      cfg.plan = patch.plan
    }
    if (patch.ip_rotation !== undefined) {
      cfg.ip_rotation = patch.ip_rotation === true // 严格布尔；非 true 视为关闭
    }
    if (patch.auto_rotate_keys !== undefined) {
      cfg.auto_rotate_keys = patch.auto_rotate_keys === true // 严格布尔；非 true 视为关闭
    }
    if (patch.egress_index !== undefined) {
      if (!Number.isInteger(patch.egress_index) || (patch.egress_index as number) < 0)
        throw new Error("egress_index 必须是非负整数")
      cfg.egress_index = patch.egress_index
    }
    if (patch.limited !== undefined) {
      if (patch.limited !== null && !Array.isArray(patch.limited))
        throw new Error("limited 必须是字符串数组或 null（清空）")
      cfg.limited =
        patch.limited === null
          ? []
          : patch.limited.filter((e) => typeof e === "string" && e.length > 0)
      if (cfg.limited.some((e) => e !== "direct" && !e.startsWith("socks5://")))
        throw new Error(`limited 只支持 "direct" 或 "socks5://host:port"（收到: ${cfg.limited.join(", ")}）`)
    }
    if (patch.egress !== undefined) {
      if (patch.egress !== null && !Array.isArray(patch.egress))
        throw new Error("egress 必须是字符串数组或 null（清空）")
      cfg.egress =
        patch.egress === null
          ? []
          : patch.egress.filter((e) => typeof e === "string" && e.length > 0)
      if (cfg.egress.some((e) => e !== "direct" && !e.startsWith("socks5://")))
        throw new Error(`egress 只支持 "direct" 或 "socks5://host:port"（收到: ${cfg.egress.join(", ")}）`)
      // 池被修改（增删/清空/转移）时，手动选中子集同步裁剪——已不在池中的选中项自动释放
      cfg.egress_active = cfg.egress_active.filter((e) => cfg.egress.includes(e))
    }
    if (patch.egress_active !== undefined) {
      // 手动选中的轮换子集：为空/null 清空（回退全池）；非空校验为 egress 池成员子集
      if (patch.egress_active !== null && !Array.isArray(patch.egress_active))
        throw new Error("egress_active 必须是字符串数组或 null（清空）")
      cfg.egress_active =
        patch.egress_active === null
          ? []
          : patch.egress_active.filter((e) => typeof e === "string" && e.length > 0)
      const pool = new Set(cfg.egress)
      if (cfg.egress_active.some((e) => !pool.has(e)))
        throw new Error(`egress_active 只能从当前 IP 池（egress）中选取（收到: ${cfg.egress_active.join(", ")}）`)
    }
    if (patch.dead !== undefined) {
      if (patch.dead !== null && !Array.isArray(patch.dead))
        throw new Error("dead 必须是字符串数组或 null（清空）")
      cfg.dead =
        patch.dead === null
          ? []
          : patch.dead.filter((e) => typeof e === "string" && e.length > 0)
      if (cfg.dead.some((e) => e !== "direct" && !e.startsWith("socks5://")))
        throw new Error(`dead 只支持 "direct" 或 "socks5://host:port"（收到: ${cfg.dead.join(", ")}）`)
    }
    if (patch.ladder !== undefined) {
      if (patch.ladder === null) {
        cfg.ladder = null
      } else if (typeof patch.ladder === "object") {
        const l = patch.ladder
        const port = Number.isInteger(l.port) && (l.port as number) > 0 ? (l.port as number) : 10880
        if (!(port >= 1 && port <= 65535)) throw new Error(`ladder.port 非法: ${l.port}`)
        const mode = l.mode === "fixed" ? "fixed" : "rotate"
        const fixed = typeof l.fixed === "string" && l.fixed ? l.fixed : null
        if (mode === "fixed" && !fixed) throw new Error("ladder.mode=fixed 时必须指定 ladder.fixed 出口")
        if (fixed && validateEgressItem(fixed) === null) throw new Error(`ladder.fixed 出口格式非法: ${fixed}`)
        // egress=梯子专用出口池（第四池）。undefined → 保留现值（Web 保存梯子设置时不能误清池）；
        // null → 清池；数组 → 校验（复用 validateEgressItem，同 egress/limited/dead 语义）
        let egress = (cfg.ladder?.egress ?? []).slice()
        if (l.egress !== undefined) {
          if (l.egress === null) egress = []
          else if (!Array.isArray(l.egress)) throw new Error("ladder.egress 必须是字符串数组或 null（清空）")
          else {
            if (l.egress.some((e) => validateEgressItem(String(e)) === null))
              throw new Error(`ladder.egress 只支持 "direct" 或 "socks5://host:port"（收到: ${l.egress.join(", ")}）`)
            egress = l.egress.filter((e) => typeof e === "string" && e.length > 0)
          }
        }
        cfg.ladder = { enabled: l.enabled === true, port, mode, fixed, egress }
      }
    }
    if (patch.tokens !== undefined) {
      if (patch.tokens !== null && !Array.isArray(patch.tokens))
        throw new Error("tokens 必须是字符串数组或 null（清空）")
      cfg.tokens =
        patch.tokens === null
          ? []
          : patch.tokens.filter((t) => typeof t === "string" && t.length > 0)
      if (cfg.tokens.some((t) => t === "")) throw new Error("tokens 不能包含空字符串")
      cfg.token = cfg.tokens.length > 0 ? cfg.tokens[0] : null
      cfg.token_set_at = new Date().toISOString()
    } else if (patch.token !== undefined) {
      if (patch.token !== null && typeof patch.token !== "string")
        throw new Error("token 必须是字符串或 null（清除）")
      cfg.tokens = patch.token === null ? [] : [patch.token]
      if (cfg.tokens.some((t) => t === "")) throw new Error("token 不能为空字符串（清除请传 null）")
      cfg.token = cfg.tokens.length > 0 ? cfg.tokens[0] : null
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

/** 生成网关访问 key：sk- + 24 字节 hex（48 hex，共 51 字符），满足 sk- 前缀约定 */
function genGatewayToken(): string {
  return "sk-" + randomBytes(24).toString("hex")
}

/** GET /api/gateway/config 载荷：token 一律掩码返回，绝不返回明文；egress 出口池原样列出 */
function gatewayConfigPayload() {
  const cfg = readGatewayConfig()
  return {
    plan: cfg.plan,
    token: cfg.tokens.length > 0 ? maskGatewayToken(cfg.tokens[0]) : null,
    tokens: cfg.tokens.map((t) => maskGatewayToken(t)),
    tokenCount: cfg.tokens.length,
    authEnabled: cfg.tokens.length > 0,
    tokenSetAt: cfg.token_set_at,
    egress: cfg.egress,
    limited: cfg.limited,
    dead: cfg.dead,
    ladder: cfg.ladder,
    egressActive: cfg.egress_active,        // 手动选中的轮换子集（[]=全池轮换）
    ipRotation: cfg.ip_rotation,               // 总开关（false = 关闭，走本地直连）
    autoRotateKeys: cfg.auto_rotate_keys,       // 网关 key 自动轮换开关（zen 免费档默认关闭）
    egressEnabled: cfg.ip_rotation && (cfg.egress_active.length ? cfg.egress_active.length >= 1 : cfg.egress.length >= 2), // 实际轮换启用（子集≥1 / 全池≥2）
    needsRestart: false, // GET 只读；needsRestart:true 仅由 POST 写操作返回
  }
}

/** 校验单个 egress 项：只接受 "direct" 或 "socks5://[user:pass@]host:port"。非法返回 null。 */
function validateEgressItem(raw: string): string | null {
  const s = String(raw).trim()
  if (!s) return null
  if (s === "direct") return "direct"
  if (!s.startsWith("socks5://")) return null
  const rest = s.slice("socks5://".length)
  // user:pass@host:port 或 host:port；host 可为域名或 IP；port 必须 1-65535
  const m = rest.match(/^(?:[^/@]+@)?([^/:@]+):(\d{1,5})[\/]?$/)
  if (!m) return null
  const port = Number(m[2])
  if (!(port >= 1 && port <= 65535)) return null
  return s
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
const ZEN_API = "https://opencode.ai/zen/v1/chat/completions"

async function probeKey(key: string, domain: "zen" | "go" = "go"): Promise<{ status: string; detail: string }> {
  const api = domain === "go" ? GO_API : ZEN_API
  const model = domain === "go" ? "hy3" : "hy3-free"
  try {
    const res = await fetch(api, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
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

/** 探测所有 key 的健康状态（只读探测，仅回调 mutateConfig 持久化结果）。
 *  domain: "all"（双端点，默认）| "zen" | "go"；name 仅探测单个 key（可选）。
 *  写各自域状态 + 探测时间：zen→last_status/last_checked_zen，go→last_status_go/last_checked_go。
 */
async function checkAllKeys(domain: "zen" | "go" | "all" = "all", name?: string) {
  const cfg = loadConfig()
  const targets = name ? cfg.keys.filter((k) => k.name === name) : cfg.keys
  const results: Record<string, { zen?: { status: string; detail: string }; go?: { status: string; detail: string } }> = {}
  for (const k of targets) {
    if (domain === "all" || domain === "zen") results[k.name] = { ...(results[k.name] ?? {}), zen: await probeKey(k.key, "zen") }
    if (domain === "all" || domain === "go") results[k.name] = { ...(results[k.name] ?? {}), go: await probeKey(k.key, "go") }
  }
  const now = new Date().toISOString()
  // 持久化探测结果到对应域 last_status + 探测时间，便于状态列展示
  mutateConfig((c) => {
    for (const k of c.keys) {
      const r = results[k.name]
      if (!r) continue
      if (r.zen) { k.last_status = r.zen.status; k.last_checked_zen = now }
      if (r.go) { k.last_status_go = r.go.status; k.last_checked_go = now }
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
  if (method === "GET" && route === "/api/gateway/usage/trend") return json(await gatewayUsageTrend(url.searchParams.get("days")))
  if (method === "GET" && route === "/api/gateway/models") return json(await gatewayModelsProxy())
  if (method === "GET" && route === "/api/gateway/plans") return json(gatewayPlansPayload())
  if (method === "GET" && route === "/api/gateway/config") return json(gatewayConfigPayload())
  // key 健康探测：仅 POST（GET 会意外触发真实探测消耗配额，防呆 404/405）。
  // body: { name?, domain?: "zen"|"go"|"all" }，默认 all=双端点，name 可选单 key 探测。
  if (method === "POST" && route === "/api/keys/check") {
    let body: any = {}
    try { body = await req.json() } catch {}
    const domain: any = body?.domain === "go" ? "go" : (body?.domain === "zen" ? "zen" : "all")
    const one = typeof body?.name === "string" && body.name ? String(body.name) : undefined
    return json({ results: await checkAllKeys(domain, one) })
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
  // 手动刷新 go + zen 双套餐模型清单（异步调网关 /v1/models/refresh，先于通用 POST 块处理）
  if (method === "POST" && route === "/api/gateway/models/refresh") {
    return json(await gatewayModelsRefresh())
  }
  // 网关功能测试（真实端到端：经网关发最小 chat 请求，验证网关→上游→模型全链路）
  if (method === "POST" && route === "/api/gateway/test") {
    return json(await gatewayTest())
  }
  // 出口池健康检查（代理到网关真实最小探测，判别隧道 + 该出口 IP 是否被上游限流）。body.url 可选：只测指定出口（限流池用）
  if (method === "POST" && route === "/api/gateway/egress/health") {
    let wantUrl: string | undefined
    try {
      const b: any = await req.json()
      if (typeof b?.url === "string" && b.url) wantUrl = b.url
    } catch {}
    return json(await gatewayEgressHealthProxy(wantUrl))
  }
  // 出口健康检查结果本地缓存读取（页面加载回显用；GET 幂等只读）
  if (method === "GET" && route === "/api/gateway/egress/health/cache") {
    return json({ ok: true, checkedAt: null, cache: readEgressHealthCache() })
  }
  // 梯子（本地 SOCKS5 透明代理）状态/管理/科学上网筛选
  if (method === "GET" && route === "/api/gateway/ladder") {
    return json(await gatewayLadderStatus())
  }
  if (method === "POST" && route === "/api/gateway/ladder") {
    // {action:"set", ladder:{...}} 写配置 → 通知网关 apply（启动/停止即时生效）；
    // {action:"apply"} 仅通知网关；{action:"stop"} 强制停止
try {
    const b: any = await req.json().catch(() => ({}))
    const action = String(b?.action || "apply")
    if (action === "set") {
      writeGatewayConfig({ ladder: b?.ladder ?? null }) // 校验失败 throw → 下方 400
      // 配置已落盘（主操作成功）；apply 失败不阻断 —— 前端可提示「已保存，网关未收到启停信号」
      const ap = await gatewayLadderApply()
      return json({ ok: true, written: true, running: ap.running === true, applyError: ap.error || null })
    }
    if (action === "stop") {
      return json(await gatewayLadderControl("stop"))
    }
    const ap = await gatewayLadderApply()
    return json({ ok: true, running: ap.running === true, applyError: ap.error || null })
  } catch (e: any) {
    // 写配置校验失败 → 400；其余（apply 网络异常）→ 200 + ok:false
    if (/^(ladder\.|ladder 必须| ladder)/.test(e?.message ?? ""))
      return json({ ok: false, error: String(e?.message ?? e) }, 400)
    return json({ ok: false, error: String(e?.message ?? e) })
  }
  }
  if (method === "POST" && route === "/api/gateway/ladder/check") {
    // 梯子科学上网筛选：{urls?: string[]} 探测每出口能否 CONNECT 被墙站点 + 出口 IP 归属
    try {
      const b: any = await req.json().catch(() => ({}))
      return json(await gatewayLadderCheck(Array.isArray(b?.urls) ? b.urls : undefined))
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) })
    }
  }
  // Webshare 代理导入（下载链接 mode=link / API Token Key mode=token）→ 拉取清单 → 连通性验证 → 带状态候选列表
  if (method === "POST" && route === "/api/gateway/proxies/webshare") {
    try {
      let body: any = {}
      try { body = await req.json() } catch {}
      const limit = Math.max(1, Math.min(Number(body?.limit) || 200, 500))
      const timeout = Math.max(1, Math.min(Number(body?.timeout) || 5000, 15000))
      return json(await fetchWebshareProxies(String(body?.mode || "token"), String(body?.value || ""), limit, timeout))
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) })
    }
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
        // 三域：body.domain 缺省 = "zen"（现状 TUI 免费档，行为不变）；"go" 写 go 域字段；"gateway" 写网关域字段
        if (route === "/api/current") {
          const d = body.domain ?? "zen"
          if (d === "gateway") return setGatewayCurrent(String(body.name))
          if (d === "go") return setGoCurrent(String(body.name))
          return setCurrent(String(body.name))
        }
        if (route === "/api/cooldown") {
          const minutes = body.minutes === null ? null : Number(body.minutes)
          const d = body.domain ?? "zen"
          if (d === "gateway") return setGatewayCooldown(String(body.name), minutes)
          if (d === "go") return setGoCooldown(String(body.name), minutes)
          return setCooldown(String(body.name), minutes)
        }
        if (route === "/api/cooldown/window")
          return setCooldownWindow(
            String(body.name),
            body.minutes === null || body.minutes === "" ? null : Number(body.minutes),
          )
        if (route === "/api/settings") return setGlobalCooldown(Number(body.cooldown_minutes))
        if (route === "/api/rotate") {
          const d = body.domain === "go" ? "go" : body.domain === "gateway" ? "gateway" : "zen"
          return manualRotate(d)
        }
        if (route === "/api/log/clear") return clearLog()
        // 网关管理：start/stop/restart → {ok, output}，透传不套统一包装
        if (route === "/api/gateway/start") return gatewayManage("start")
        if (route === "/api/gateway/stop") return gatewayManage("stop")
        if (route === "/api/gateway/restart") return gatewayManage("restart")
// 网关配置（套餐/token）：只写 gateway-config.json 不重启（重启由前端显式调 restart）
         if (route === "/api/gateway/config") {
           if (body.plan === undefined && body.token === undefined && body.tokens === undefined && body.auto_rotate_keys === undefined)
             throw new Error("至少提供 plan / token / tokens / auto_rotate_keys 之一")
           writeGatewayConfig({
             plan: body.plan === undefined ? undefined : String(body.plan),
             token: body.token === undefined ? undefined : body.token,
             tokens: body.tokens === undefined ? undefined : body.tokens,
             auto_rotate_keys: body.auto_rotate_keys === undefined ? undefined : body.auto_rotate_keys === true,
           })
           return { ok: true, needsRestart: true }
         }
         // 网关访问 key 管理：生成/删除/清空（token 明文仅生成时返回一次，落盘后掩码）
         if (route === "/api/gateway/token") {
           const action = String(body.action || "")
           if (action === "gen") {
             const key = genGatewayToken()
             writeGatewayConfig({ tokens: [...readGatewayConfig().tokens, key] })
             return {
               ok: true,
               plain: key,
               masked: maskGatewayToken(key),
               tokenCount: readGatewayConfig().tokens.length,
               needsRestart: true,
             }
           }
           // 获取单个 key 明文（仅复制用途；列表仍只显示掩码，点「复制」才下发单个明文）
           if (action === "get") {
             const idx = Number(body.index)
             const cfg = readGatewayConfig()
             if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.tokens.length)
               throw new Error(`index 越界（当前 ${cfg.tokens.length} 个 key）`)
             log(`📋  [gateway] 复制访问 key #${idx} 明文（Web 管理页）`)
             return { ok: true, plain: cfg.tokens[idx] }
           }
           if (action === "del") {
             const idx = Number(body.index)
             const cfg = readGatewayConfig()
             if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.tokens.length)
               throw new Error(`index 越界（当前 ${cfg.tokens.length} 个 key）`)
             writeGatewayConfig({ tokens: cfg.tokens.filter((_, i) => i !== idx) })
             return { ok: true, needsRestart: true }
           }
if (action === "clear") {
              writeGatewayConfig({ tokens: null })
              return { ok: true, needsRestart: true }
            }
            throw new Error(`未知 action: ${action || "(空)"}（支持 gen/del/clear）`)
          }
          // 网关 IP 池（egress 出口轮换）管理：add/del/clear/set。仅 zen 免费档用于绕过按 IP 限流。
          if (route === "/api/gateway/egress") {
            const action = String(body.action || "")
            const list = () => readGatewayConfig().egress
            if (action === "add") {
              const e = validateEgressItem(String(body.url || ""))
              if (!e) throw new Error("出口格式非法：仅支持 \"direct\" 或 \"socks5://[user:pass@]host:port\"")
              const cfg = readGatewayConfig()
              if (cfg.egress.includes(e)) throw new Error(`出口已存在: ${e}`)
              writeGatewayConfig({ egress: [...cfg.egress, e] })
              return { ok: true, egress: list(), needsRestart: true }
            }
            if (action === "del") {
              const idx = Number(body.index)
              const cfg = readGatewayConfig()
              if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.egress.length)
                throw new Error(`index 越界（当前 ${cfg.egress.length} 个出口）`)
              writeGatewayConfig({ egress: cfg.egress.filter((_, i) => i !== idx) })
              return { ok: true, egress: list(), needsRestart: true }
            }
            if (action === "clear") {
              writeGatewayConfig({ egress: null })
              return { ok: true, egress: [], needsRestart: true }
            }
            if (action === "activate") {
              // 把选中的 IP 池成员设为当前轮换子集（非空）→ 网关只在这些出口间轮换；同时打开总开关「立马启动」。
              // 未选中项保留在 egress 全池里（不删除，子集可随时「恢复全池」）。
              // 选中项前置到池列表头部：前台刷新后「用得最多的」排在前面，看得见的列表顺序 = 实际使用顺序。
              const selected = (Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []).filter(Boolean)
              if (!selected.length) throw new Error("urls 不能为空（先勾选要启用的出口）")
              const cfg0 = readGatewayConfig()
              const poolSet = new Set(cfg0.egress)
              if (selected.some((u) => !poolSet.has(u)))
                throw new Error(`选中的出口不在当前 IP 池（请刷新后重试）: ${selected.filter((u) => !poolSet.has(u)).join(", ")}`)
              const uniq: string[] = []
              const seen = new Set<string>()
              for (const u of selected) if (!seen.has(u)) { seen.add(u); uniq.push(u) }
              const rest = cfg0.egress.filter((e) => !seen.has(e)) // 保留原有顺序的未选中项
              writeGatewayConfig({ egress: [...uniq, ...rest], egress_active: uniq, ip_rotation: true }) // 启动轮换：无论之前开关状态，激活即开启
              const cfg = readGatewayConfig()
              return {
                ok: true,
                egressActive: cfg.egress_active,
                egress: cfg.egress,
                limited: cfg.limited,
                dead: cfg.dead,
                ipRotation: cfg.ip_rotation,
                enabled: cfg.ip_rotation && cfg.egress_active.length >= 1,
                needsRestart: false, // 网关 egressList()/egressEnabled() 动态读配置，无需重启
              }
            }
            if (action === "deactivate") {
              // 恢复全池轮换：清空手动选中子集 → 网关回退到整个 egress 池
              writeGatewayConfig({ egress_active: null })
              const cfg = readGatewayConfig()
              return {
                ok: true,
                egressActive: [],
                egress: cfg.egress,
                limited: cfg.limited,
                dead: cfg.dead,
                ipRotation: cfg.ip_rotation,
                enabled: cfg.ip_rotation && cfg.egress.length >= 2,
                needsRestart: false,
              }
            }
            if (action === "set") {
              const arr = Array.isArray(body.list) ? body.list.map((x: unknown) => String(x)) : []
              if (arr.length === 0) throw new Error("list 不能为空")
              const valid = arr.map((x) => validateEgressItem(x))
              if (valid.some((v) => v === null)) throw new Error("出口格式非法（只支持 direct / socks5://host:port）")
              writeGatewayConfig({ egress: valid as string[] })
              return { ok: true, egress: list(), needsRestart: true }
            }
            if (action === "toggle") {
              // IP 轮换总开关：开→关→开。关闭时即使有出口池也走本地直连（网关动态判定，无需重启）
              const on = readGatewayConfig().ip_rotation
              writeGatewayConfig({ ip_rotation: !on })
              return { ok: true, ipRotation: !on, egress: list(), needsRestart: false }
            }
            if (action === "bulk-add") {
              // 批量加入 + 去重：一次写锁加入多个出口，已存在/非法项跳过并报告。
              // Webshare 导入卡「添加选中」走这里（避免 N 次单条写锁）。
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const add = []
              const skipped: { url: string; reason: string }[] = []
              const seen = new Set(cfg.egress)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) { skipped.push({ url: u, reason: "格式非法" }); continue }
                if (seen.has(e)) { skipped.push({ url: e, reason: "已在 IP 池" }); continue }
                seen.add(e)
                add.push(e)
              }
              if (add.length > 0) writeGatewayConfig({ egress: [...cfg.egress, ...add] })
              return { ok: true, added: add, skipped, egress: list(), needsRestart: true }
            }
            if (action === "move-to-limited") {
              // 健康检查发现被限流的出口（429）→ 从主池移到「限流池」单独管理（不参与轮换）
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const moved: string[] = []
              const egressSet = new Set(cfg.egress)
              const limitedSet = new Set(cfg.limited)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (egressSet.has(e)) egressSet.delete(e) // 从主池移除
                if (!limitedSet.has(e)) limitedSet.add(e)  // 加入限流池
                if (!moved.includes(e)) moved.push(e)
              }
              writeGatewayConfig({
                egress: [...egressSet],
                limited: [...limitedSet],
              })
              return { ok: true, moved, egress: list(), limited: [...limitedSet], needsRestart: true }
            }
            if (action === "restore") {
              // 限流池出口重新探测发现可用 → 移回主池
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const restored: string[] = []
              const egressSet = new Set(cfg.egress)
              const limitedSet = new Set(cfg.limited)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (limitedSet.has(e)) limitedSet.delete(e)
                if (!egressSet.has(e)) egressSet.add(e)
                if (!restored.includes(e)) restored.push(e)
              }
              writeGatewayConfig({
                egress: [...egressSet],
                limited: [...limitedSet],
              })
              return { ok: true, restored, egress: list(), limited: [...limitedSet], needsRestart: true }
            }
            if (action === "set-limited") {
              // 直接重设限流池（删除单项/清空）
              const arr = Array.isArray(body.list) ? body.list.map((x: unknown) => String(x)) : []
              const valid = arr.map((x) => validateEgressItem(x))
              if (valid.some((v) => v === null)) throw new Error("list 格式非法（只支持 direct / socks5://host:port）")
              writeGatewayConfig({ limited: valid as string[] })
              return { ok: true, limited: valid as string[], needsRestart: true }
            }
            if (action === "move-to-dead") {
              // 健康检查确认不可用（探测失败/超时）→ 从主池/限流池移到「不可用池」（不参与轮换）
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const moved: string[] = []
              const egressSet = new Set(cfg.egress)
              const limitedSet = new Set(cfg.limited)
              const deadSet = new Set(cfg.dead)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (egressSet.has(e)) egressSet.delete(e)
                if (limitedSet.has(e)) limitedSet.delete(e)
                if (!deadSet.has(e)) deadSet.add(e)
                if (!moved.includes(e)) moved.push(e)
              }
              writeGatewayConfig({
                egress: [...egressSet],
                limited: [...limitedSet],
                dead: [...deadSet],
              })
              return { ok: true, moved, egress: list(), limited: [...limitedSet], dead: [...deadSet], needsRestart: true }
            }
            if (action === "restore-dead") {
              // 不可用池出口重新探测发现可用 → 移回主池
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const restored: string[] = []
              const egressSet = new Set(cfg.egress)
              const deadSet = new Set(cfg.dead)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (deadSet.has(e)) deadSet.delete(e)
                if (!egressSet.has(e)) egressSet.add(e)
                if (!restored.includes(e)) restored.push(e)
              }
              writeGatewayConfig({ egress: [...egressSet], dead: [...deadSet] })
              return { ok: true, restored, egress: list(), dead: [...deadSet], needsRestart: true }
            }
            if (action === "set-dead") {
              // 直接重设不可用池（删除单项/清空）
              const arr = Array.isArray(body.list) ? body.list.map((x: unknown) => String(x)) : []
              const valid = arr.map((x) => validateEgressItem(x))
              if (valid.some((v) => v === null)) throw new Error("list 格式非法（只支持 direct / socks5://host:port）")
              writeGatewayConfig({ dead: valid as string[] })
              return { ok: true, dead: valid as string[], needsRestart: true }
            }
            // ---- 梯子专用出口池（第四池 ladder.egress）：与三池同语义，needsRestart:false（梯子每连接动态读配置即时生效） ----
            const ladderList = () => readGatewayConfig().ladder?.egress ?? []
            const ladderPatch = (egressArr: string[]) => {
              const cur = readGatewayConfig().ladder ?? { enabled: false, port: 10880, mode: "rotate", fixed: null }
              writeGatewayConfig({ ladder: { ...cur, egress: egressArr } }) // 保留 enabled/port/mode/fixed
            }
            if (action === "set-ladder") {
              // 直接重设梯子池（删除单项/清空）
              const arr = Array.isArray(body.list) ? body.list.map((x: unknown) => String(x)) : []
              const valid = arr.map((x) => validateEgressItem(x))
              if (valid.some((v) => v === null)) throw new Error("list 格式非法（只支持 direct / socks5://host:port）")
              ladderPatch(valid as string[])
              return { ok: true, egress: ladderList(), needsRestart: false }
            }
            if (action === "add-ladder") {
              const e = validateEgressItem(String(body.url || ""))
              if (!e) throw new Error("出口格式非法：仅支持 \"direct\" 或 \"socks5://[user:pass@]host:port\"")
              const cur = ladderList()
              if (cur.includes(e)) throw new Error(`出口已存在: ${e}`)
              ladderPatch([...cur, e])
              return { ok: true, egress: ladderList(), needsRestart: false }
            }
            if (action === "move-to-ladder") {
              // 从主池/限流池/不可用池并集抽取 → 梯子池（跨三源，去重）
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const moved: string[] = []
              const egressSet = new Set(cfg.egress)
              const limitedSet = new Set(cfg.limited)
              const deadSet = new Set(cfg.dead)
              const ladderSet = new Set(cfg.ladder?.egress ?? [])
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                const inSrc = egressSet.delete(e) || limitedSet.delete(e) || deadSet.delete(e)
                if (!inSrc) continue
                if (!ladderSet.has(e)) ladderSet.add(e)
                if (!moved.includes(e)) moved.push(e)
              }
              writeGatewayConfig({ egress: [...egressSet], limited: [...limitedSet], dead: [...deadSet] })
              ladderPatch([...ladderSet])
              return {
                ok: true,
                moved,
                egress: list(),
                limited: [...limitedSet],
                dead: [...deadSet],
                ladderEgress: ladderList(),
                needsRestart: false,
              }
            }
            if (action === "ladder-to-egress") {
              // 梯子池 → 主池（勾选移回）
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const restored: string[] = []
              const ladderSet = new Set(cfg.ladder?.egress ?? [])
              const egressSet = new Set(cfg.egress)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (ladderSet.delete(e)) {
                  if (!egressSet.has(e)) egressSet.add(e)
                  if (!restored.includes(e)) restored.push(e)
                }
              }
              ladderPatch([...ladderSet])
              writeGatewayConfig({ egress: [...egressSet] })
              return { ok: true, restored, egress: list(), ladderEgress: ladderList(), needsRestart: false }
            }
            if (action === "ladder-to-limited") {
              // 梯子池 → 限流池
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const moved: string[] = []
              const ladderSet = new Set(cfg.ladder?.egress ?? [])
              const limitedSet = new Set(cfg.limited)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (ladderSet.delete(e)) {
                  if (!limitedSet.has(e)) limitedSet.add(e)
                  if (!moved.includes(e)) moved.push(e)
                }
              }
              ladderPatch([...ladderSet])
              writeGatewayConfig({ limited: [...limitedSet] })
              return { ok: true, moved, limited: [...limitedSet], ladderEgress: ladderList(), needsRestart: false }
            }
            if (action === "ladder-to-dead") {
              // 梯子池 → 不可用池（surf 失败归类/手动）
              const raw = Array.isArray(body.urls) ? body.urls.map((x: unknown) => String(x)) : []
              if (raw.length === 0) throw new Error("urls 不能为空")
              const cfg = readGatewayConfig()
              const moved: string[] = []
              const ladderSet = new Set(cfg.ladder?.egress ?? [])
              const deadSet = new Set(cfg.dead)
              for (const u of raw) {
                const e = validateEgressItem(u)
                if (!e) continue
                if (ladderSet.delete(e)) {
                  if (!deadSet.has(e)) deadSet.add(e)
                  if (!moved.includes(e)) moved.push(e)
                }
              }
              ladderPatch([...ladderSet])
              writeGatewayConfig({ dead: [...deadSet] })
              return { ok: true, moved, dead: [...deadSet], ladderEgress: ladderList(), needsRestart: false }
            }
            throw new Error(`未知 action: ${action || "(空)"}（支持 add/del/clear/activate/deactivate/set/toggle/bulk-add/move-to-limited/restore/set-limited/move-to-dead/restore-dead/set-dead/set-ladder/add-ladder/move-to-ladder/ladder-to-egress/ladder-to-limited/ladder-to-dead）`)
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
    // idleTimeout 放宽到 120s：egress 健康检查串行探测所有出口最坏 ~90s，默认 10s 会被掐断。
    // hostname 必须锁定 127.0.0.1：管理页无鉴权，绑定 * 会让局域网/公网可访问（安全前提是仅本机）。
    server = Bun.serve({ port: WEB_PORT, hostname: "127.0.0.1", fetch: handleWeb, idleTimeout: 120 })
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
      // 红线：非 opencode provider 一律不注入（绝不影响 codeplan/fox-aws 等）
      if (!isGoProvider(pid) && !isZenProvider(pid)) return
      // 三域分流：go 套餐 provider（opencode-go）→ 注入 go 域 current（current_go ?? current）；
      // zen 免费档 provider（opencode / 其它含 opencode 前缀非 go）→ 注入 zen 域 current（current）
      const cfg = loadConfig()
      const isGo = isGoProvider(pid)
      const key = isGo
        ? cfg.keys.find((k) => k.name === (cfg.current_go ?? cfg.current)) ?? cfg.keys[0]
        : cfg.keys.find((k) => k.name === cfg.current) ?? cfg.keys[0]
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
      const pid = sid ? sessionProvider.get(sid) : undefined
      // 按 session 记录的 pid 判定所属域（三域独立）：go 套餐 provider → go 域；
      // zen provider → zen 域。pid 未知（真实会话必经 chat.headers 注册 pid，理论不出现）
      // 兜底默认 zen 免费档域（现状语义，避免误切 go 域破坏既有行为）。
      let domain: "zen" | "go" = "zen"
      if (pid) {
        if (isGoProvider(pid)) domain = "go"
        else if (isZenProvider(pid)) domain = "zen"
      }

      const msg = err.data?.message ?? err.message ?? ""
      log(`🔁  检测到${domain === "go" ? "go 套餐" : "zen 免费档"}配额/鉴权错误: ${String(msg).slice(0, 200)}`)
      log(`    sessionID=${sid ?? "?"} statusCode=${err.data?.statusCode ?? "?"} pid=${pid ?? "?"}`)
      const cfg = rotate(String(msg), err, domain)
      log(`    now ${domain}域 current=${domain === "go" ? cfg.current_go : cfg.current}`)
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
<script>
/* 主题防闪烁：渲染前按 localStorage 设置 data-theme（默认深色） */
try {
  var grTheme = localStorage.getItem("gr-theme") || "dark"
  document.documentElement.setAttribute("data-theme", grTheme)
} catch (e) {}
</script>
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
    /* 用量趋势图表色（成功/失败；canvas 需真实色值，drawTrendChart 经 getComputedStyle 取） */
    --ok: #34d399;  --err: #f87171;
    --success-soft: rgba(74,222,128,.12);
    --warning-soft: rgba(251,191,36,.12);
    --danger-soft: rgba(248,113,113,.12);
    --info-soft: rgba(96,165,250,.12);
    /* 按钮语义色（双主题，随 :root / html[data-theme="light"] 联动） */
    /* 中性 */
    --btn-bg: #181d26;  --btn-bd: #2c3442;  --btn-fg: #e8eaed;
    --btn-bg-hover: #202636;  --btn-bd-hover: #3a4354;  --btn-fg-hover: #e8eaed;
    /* primary：品牌蓝底白字，hover 深一档 */
    --btn-primary-bg: #3b82f6;  --btn-primary-bd: #3b82f6;  --btn-primary-fg: #ffffff;
    --btn-primary-hover-bg: #2563eb;  --btn-primary-hover-bd: #2563eb;  --btn-primary-hover-fg: #ffffff;
    /* danger：红 soft 底 + 亮红字，hover 提亮 */
    --btn-danger-bg: rgba(248,113,113,.12);  --btn-danger-bd: rgba(248,113,113,.28);  --btn-danger-fg: #fca5a5;
    --btn-danger-hover-bg: rgba(248,113,113,.22);  --btn-danger-hover-bd: rgba(248,113,113,.45);  --btn-danger-hover-fg: #fecaca;
    /* success：绿 soft 底 + 亮绿字（预留，供将来 success 按钮使用） */
    --btn-success-bg: rgba(74,222,128,.12);  --btn-success-bd: rgba(74,222,128,.28);  --btn-success-fg: #4ade80;
    --btn-success-hover-bg: rgba(74,222,128,.22);  --btn-success-hover-bd: rgba(74,222,128,.45);  --btn-success-hover-fg: #86efac;
    /* ghost：透明底灰字，hover 浅灰底 */
    --btn-ghost-fg: #9aa3ad;  --btn-ghost-hover-bg: #181d26;  --btn-ghost-hover-fg: #e8eaed;
    /* 加载 spinner（按语义色区分边框 + 顶边） */
    --btn-spin: rgba(232,234,237,.30);  --btn-spin-top: #e8eaed;
    --btn-primary-spin: rgba(255,255,255,.35);  --btn-primary-spin-top: #ffffff;
    --btn-danger-spin: rgba(252,165,165,.35);  --btn-danger-spin-top: #fca5a5;
    --btn-success-spin: rgba(74,222,128,.35);  --btn-success-spin-top: #4ade80;
    /* 域色按钮（zen 蓝 / go 紫 / 网关青，soft 底 + 亮字，hover 提亮） */
    --btn-zen-bg: rgba(96,165,250,.12);  --btn-zen-bd: rgba(96,165,250,.30);  --btn-zen-fg: #93c5fd;
    --btn-zen-hover-bg: rgba(96,165,250,.22);  --btn-zen-hover-bd: rgba(96,165,250,.48);  --btn-zen-hover-fg: #bfdbfe;
    --btn-go-bg: rgba(167,139,250,.12);  --btn-go-bd: rgba(167,139,250,.30);  --btn-go-fg: #c4b5fd;
    --btn-go-hover-bg: rgba(167,139,250,.22);  --btn-go-hover-bd: rgba(167,139,250,.48);  --btn-go-hover-fg: #ddd6fe;
    --btn-gw-bg: rgba(34,211,238,.12);  --btn-gw-bd: rgba(34,211,238,.30);  --btn-gw-fg: #67e8f9;
    --btn-gw-hover-bg: rgba(34,211,238,.22);  --btn-gw-hover-bd: rgba(34,211,238,.48);  --btn-gw-hover-fg: #a5f3fc;
    /* 冷却（warn）：琥珀 soft，表示"进入冷却"操作 */
    --btn-warn-bg: rgba(251,191,36,.12);  --btn-warn-bd: rgba(251,191,36,.30);  --btn-warn-fg: #fcd34d;
    --btn-warn-hover-bg: rgba(251,191,36,.22);  --btn-warn-hover-bd: rgba(251,191,36,.48);  --btn-warn-hover-fg: #fde68a;
    /* 域色徽标（三域当前/健康列 ✓） */
    --go: #a78bfa;  --go-soft: rgba(167,139,250,.12);
    --gw: #22d3ee;  --gw-soft: rgba(34,211,238,.12);
    /* 运行日志前景（深色下偏绿，浅色下深绿） */
    --log: #9ceba8;
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

  /* ============ 浅色主题（html[data-theme="light"] 覆盖，默认深色不变） ============ */
  html[data-theme="light"] {
    color-scheme: light;
    --bg-0: #f4f6f8;  --bg-1: #ffffff;  --bg-2: #eef1f4;  --bg-3: #e3e8ed;
    --bd-1: #d9dee4;  --bd-2: #c2c9d2;  --bd-3: #a6afba;
    --tx-1: #16181c;  --tx-2: #525c68;  --tx-3: #8a94a0;
    --success-soft: rgba(22,163,74,.10);
    --warning-soft: rgba(202,138,4,.12);
    --danger-soft: rgba(220,38,38,.08);
    --info-soft: rgba(37,99,235,.10);
    /* 用量趋势图表色（浅色加深保证白底对比） */
    --ok: #059669;  --err: #dc2626;
    /* 按钮语义色（浅色覆盖：中性白底灰框深字；primary 深蓝底白字；danger 浅红底深红字） */
    --btn-bg: #ffffff;  --btn-bd: #c2c9d2;  --btn-fg: #16181c;
    --btn-bg-hover: #f1f4f7;  --btn-bd-hover: #a6afba;  --btn-fg-hover: #16181c;
    --btn-primary-bg: #2563eb;  --btn-primary-bd: #2563eb;  --btn-primary-fg: #ffffff;
    --btn-primary-hover-bg: #1d4ed8;  --btn-primary-hover-bd: #1d4ed8;  --btn-primary-hover-fg: #ffffff;
    --btn-danger-bg: #fdecec;  --btn-danger-bd: #f3c1c1;  --btn-danger-fg: #b91c1c;
    --btn-danger-hover-bg: #f9dddd;  --btn-danger-hover-bd: #ec9c9c;  --btn-danger-hover-fg: #991b1b;
    --btn-success-bg: #e7f6ec;  --btn-success-bd: #b9e4cb;  --btn-success-fg: #15803d;
    --btn-success-hover-bg: #d7efe0;  --btn-success-hover-bd: #93d7ae;  --btn-success-hover-fg: #166534;
    --btn-ghost-fg: #525c68;  --btn-ghost-hover-bg: #eef1f4;  --btn-ghost-hover-fg: #16181c;
    --btn-spin: rgba(22,24,28,.20);  --btn-spin-top: #16181c;
    --btn-primary-spin: rgba(255,255,255,.35);  --btn-primary-spin-top: #ffffff;
    --btn-danger-spin: rgba(185,28,28,.25);  --btn-danger-spin-top: #b91c1c;
    --btn-success-spin: rgba(21,128,61,.25);  --btn-success-spin-top: #15803d;
    /* 域色按钮（浅色：淡彩底 + 深字） */
    --btn-zen-bg: #e8f1fd;  --btn-zen-bd: #b6d2f6;  --btn-zen-fg: #1d4ed8;
    --btn-zen-hover-bg: #d9e9fb;  --btn-zen-hover-bd: #8db8ef;  --btn-zen-hover-fg: #1e40af;
    --btn-go-bg: #f0ecfd;  --btn-go-bd: #cfc2f5;  --btn-go-fg: #6d28d9;
    --btn-go-hover-bg: #e5ddfa;  --btn-go-hover-bd: #b39fe9;  --btn-go-hover-fg: #5b21b6;
    --btn-gw-bg: #e5f9fc;  --btn-gw-bd: #aee8f1;  --btn-gw-fg: #0e7490;
    --btn-gw-hover-bg: #d3f2f8;  --btn-gw-hover-bd: #7fd8e6;  --btn-gw-hover-fg: #155e75;
    --btn-warn-bg: #fdf4e3;  --btn-warn-bd: #eed9a6;  --btn-warn-fg: #b45309;
    --btn-warn-hover-bg: #faeccc;  --btn-warn-hover-bd: #e3c684;  --btn-warn-hover-fg: #92400e;
    /* 域色徽标（浅色） */
    --go: #7c3aed;  --go-soft: #ede9fe;
    --gw: #0891b2;  --gw-soft: #cffafe;
    --log: #1a7f37;
    --shadow-sm: 0 1px 2px rgba(16,24,40,.08);
    --shadow-md: 0 4px 12px rgba(16,24,40,.10), 0 1px 2px rgba(16,24,40,.06);
    --shadow-lg: 0 8px 24px rgba(16,24,40,.12);
    --ring: 0 0 0 3px rgba(59,130,246,.25);
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
  .actions { display: flex; flex-direction: column; gap: 5px; }
  /* 操作按钮两行布局：行1 = 检查 + 设为当前(三域)，行2 = 冷却(三域) + 管理 */
  .actions .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  /* 操作按钮分组：组间细分隔线 + 留白，按域/管理分块（每行行首组无边框） */
  .actions .grp { display: inline-flex; gap: 6px; align-items: center; }
  .actions .row .grp + .grp { padding-left: 9px; border-left: 1px solid var(--bd-2); margin-left: 3px; }
  /* 单列堆叠：网关配置两块与日志双卡纵向排列，避免并排时内容宽度不足导致布局错乱 */
  .gw-config-grid { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
  .log-row { display: grid; grid-template-columns: 1fr; gap: var(--sp-4); align-items: start; }
  /* 单列下 pre 不再受 grid 双列挤压，仍保留 max-width 兜底（超长行 overflow-x 滚动，不撑爆容器） */
  .log-row > .card, .gw-config-grid > .card { min-width: 0; }
  .log-row pre { max-width: 100%; }
  .gr-tip { cursor: help; border-bottom: 1px dotted var(--tx-3); }

  /* Webshare 导入：多列网格紧凑布局 + 勾选项 */
  .proxy-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .proxy-toolbar .hint { flex: 1; min-width: 140px; }
  .proxy-grid { margin-top: 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 6px; }
  .proxy-item {
    display: flex; align-items: center; gap: 7px; padding: 5px 8px;
    border: 1px solid var(--bd-2); border-radius: var(--r-sm); background: var(--bg-1);
    min-width: 0;
  }
  .proxy-item:hover { border-color: var(--primary); }
  .proxy-item input[type="checkbox"] { flex: none; accent-color: var(--primary); }
  .proxy-item .pm-proto { flex: none; font-size: 10px; color: var(--tx-3); }
  .proxy-item code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proxy-item .pm-ms { flex: none; font-size: 11px; color: var(--tx-3); }
  .proxy-item .pm-err { flex: 1; min-width: 0; font-size: 10px; color: var(--tx-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .proxy-item.off { opacity: 0.55; }
  .proxy-item.off input[type="checkbox"] { pointer-events: none; }
  .proxy-item.inpool { opacity: 0.45; }
  .proxy-item.inpool input[type="checkbox"] { pointer-events: none; }

  /* 页头：标题区 + 右上角主题切换（参考常见站点右上角白天/黑夜切换） */
  .page-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
  .theme-toggle {
    display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px;
    border-radius: 999px; background: var(--bg-2); border: 1px solid var(--bd-2);
    color: var(--tx-2); font-size: 13px; cursor: pointer;
    transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease), background var(--dur) var(--ease);
  }
  .theme-toggle:hover { color: var(--tx-1); border-color: var(--bd-3); background: var(--bg-3); }
  .theme-toggle:active { transform: translateY(0.5px); }
  #theme-ico-moon, .theme-label-light { display: none; }
  html[data-theme="light"] #theme-ico-sun { display: none; }
  html[data-theme="light"] #theme-ico-moon { display: inline-block; }
  html[data-theme="light"] .theme-label-dark { display: none; }
  html[data-theme="light"] .theme-label-light { display: inline; }
  .theme-ico { flex: none; }

  /* ============ 导航 ============ */
  .nav { display: flex; gap: 6px; margin-bottom: var(--sp-4); flex-wrap: wrap; }
  .nav-btn { height: 32px; padding: 0 14px; border-radius: var(--r-sm);
             background: transparent; border-color: transparent; color: var(--tx-2);
             font-size: 13px; font-weight: 500; }
  .nav-btn:hover { background: var(--bg-2); color: var(--tx-1); }
  .nav-btn.active { background: var(--btn-primary-bg); border-color: var(--btn-primary-bd); color: var(--btn-primary-fg); }
  .nav-btn.active:hover { background: var(--btn-primary-hover-bg); border-color: var(--btn-primary-hover-bd); color: var(--btn-primary-hover-fg); }

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
           border: 1px solid var(--btn-bd); background: var(--btn-bg); color: var(--btn-fg);
           cursor: pointer; font-size: 13px; font-weight: 500; white-space: nowrap;
           transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease),
                       color var(--dur) var(--ease), transform var(--dur) var(--ease),
                       box-shadow var(--dur) var(--ease); }
  button:hover { background: var(--btn-bg-hover); border-color: var(--btn-bd-hover); color: var(--btn-fg-hover); }
  button:active { transform: translateY(.5px); }
  button:focus-visible { outline: none; box-shadow: var(--ring); }
  button:disabled, button[disabled] { opacity: .45; cursor: not-allowed; pointer-events: none; }
  button.primary { background: var(--btn-primary-bg); border-color: var(--btn-primary-bd); color: var(--btn-primary-fg); }
  button.primary:hover { background: var(--btn-primary-hover-bg); border-color: var(--btn-primary-hover-bd); color: var(--btn-primary-hover-fg); }
  button.danger { background: var(--btn-danger-bg); border-color: var(--btn-danger-bd); color: var(--btn-danger-fg); }
  button.danger:hover { background: var(--btn-danger-hover-bg); border-color: var(--btn-danger-hover-bd); color: var(--btn-danger-hover-fg); }
  button.success { background: var(--btn-success-bg); border-color: var(--btn-success-bd); color: var(--btn-success-fg); }
  button.success:hover { background: var(--btn-success-hover-bg); border-color: var(--btn-success-hover-bd); color: var(--btn-success-hover-fg); }
  button.ghost { background: transparent; border-color: transparent; color: var(--btn-ghost-fg); }
  button.ghost:hover { background: var(--btn-ghost-hover-bg); color: var(--btn-ghost-hover-fg); }
  /* 域色按钮：zen 蓝 / go 紫 / 网关青（soft 底 + 亮字） */
  button.zen { background: var(--btn-zen-bg); border-color: var(--btn-zen-bd); color: var(--btn-zen-fg); }
  button.zen:hover { background: var(--btn-zen-hover-bg); border-color: var(--btn-zen-hover-bd); color: var(--btn-zen-hover-fg); }
  button.go { background: var(--btn-go-bg); border-color: var(--btn-go-bd); color: var(--btn-go-fg); }
  button.go:hover { background: var(--btn-go-hover-bg); border-color: var(--btn-go-hover-bd); color: var(--btn-go-hover-fg); }
  button.gw { background: var(--btn-gw-bg); border-color: var(--btn-gw-bd); color: var(--btn-gw-fg); }
  button.gw:hover { background: var(--btn-gw-hover-bg); border-color: var(--btn-gw-hover-bd); color: var(--btn-gw-hover-fg); }
  /* 冷却操作：琥珀，表示将 key 置入冷却 */
  button.warn { background: var(--btn-warn-bg); border-color: var(--btn-warn-bd); color: var(--btn-warn-fg); }
  button.warn:hover { background: var(--btn-warn-hover-bg); border-color: var(--btn-warn-hover-bd); color: var(--btn-warn-hover-fg); }
  button.sm, .actions button { height: 26px; padding: 0 8px; font-size: 12px; border-radius: 5px; }
  button.loading { pointer-events: none; opacity: .75; }
  button.loading::before { content: ""; width: 12px; height: 12px;
                           border: 2px solid var(--btn-spin); border-top-color: var(--btn-spin-top);
                           border-radius: 50%; animation: spin .6s linear infinite; flex: none; }
  button.primary.loading::before { border-color: var(--btn-primary-spin); border-top-color: var(--btn-primary-spin-top); }
  button.danger.loading::before { border-color: var(--btn-danger-spin); border-top-color: var(--btn-danger-spin-top); }
  button.success.loading::before { border-color: var(--btn-success-spin); border-top-color: var(--btn-success-spin-top); }
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
  /* 域色徽标：zen 蓝（沿用 info）/ go 紫 / 网关青 */
  .b-zen { background: var(--info-soft); color: var(--info); }
  .b-go  { background: var(--go-soft);    color: var(--go); }
  .b-gw  { background: var(--gw-soft);    color: var(--gw); }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block;
         background: var(--tx-3); flex: none; }
  .dot.ok   { background: var(--success); box-shadow: 0 0 6px rgba(74,222,128,.5); }
  .dot.warn { background: var(--warning); box-shadow: 0 0 6px rgba(251,191,36,.5); }
  .dot.err  { background: var(--danger);  box-shadow: 0 0 6px rgba(248,113,113,.5); }
  /* 用量趋势图例色块 */
  .trend-legend { width: 14px; height: 3px; border-radius: 2px; display: inline-block; }
  #trend-days { width: auto; height: 28px; padding: 0 6px; }

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
        font-size: 12px; line-height: 1.6; overflow: auto; max-height: 260px; color: var(--log); }
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
    .table-wrap table { min-width: 860px; }
  }
  /* P3-4 修复：断点提到 780px 才去 .ov-strip 分隔线，消除 721-780px 区间 flex wrap 后第二行首格残留 border-left */
  @media (max-width: 780px) {
    .ov-strip .stat + .stat { border-left: none; padding-left: 0; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="page-head">
    <div>
      <h1>go-rotate · opencode-go keys</h1>
      <div class="sub">多 key 自动轮换 · 修改会自动同步到 auth.json 并立即生效</div>
    </div>
    <button class="theme-toggle" id="theme-btn" onclick="toggleTheme()" title="切换深色/浅色主题">
      <svg class="theme-ico" id="theme-ico-sun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/></svg>
      <svg class="theme-ico" id="theme-ico-moon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>
      <span id="theme-btn-label" class="theme-label-dark">浅色</span>
      <span class="theme-label-light">深色</span>
    </button>
  </div>

  <div class="nav" id="main-nav">
    <button class="nav-btn active" data-nav="keys" onclick="switchNav('keys')">Key 管理</button>
    <button class="nav-btn" data-nav="tui" onclick="switchNav('tui')">TUI</button>
    <button class="nav-btn" data-nav="gateway" onclick="switchNav('gateway')">网关</button>
    <button class="nav-btn" data-nav="stats" onclick="switchNav('stats')">统计</button>
  </div>

  <!-- ============ Key 管理：健康总览条（zen/go/网关）+ 主操作区（新增卡 + 表格卡） ============ -->
  <div class="block" id="nav-keys">
  <div class="card">
    <div class="stats ov-strip">
      <div class="stat"><div class="v" id="s-current">-</div><div class="l">Zen 当前 key</div></div>
      <div class="stat"><div class="v" id="s-current-go">-</div><div class="l">Go 当前 key</div></div>
      <div class="stat"><div class="v" id="s-avail">-</div><div class="l">可用 &nbsp;<span class="muted" id="s-total"></span></div></div>
      <div class="stat"><div class="v" id="ov-gw-state">-</div><div class="l">网关</div></div>
      <div class="stat"><div class="v" id="ov-last-rotate">-</div><div class="l">最近轮换</div></div>
      <div class="stat"><div class="v" id="s-cooldown">-</div><div class="l">冷却窗口(min) <a href="javascript:void(0)" onclick="switchNav('tui')" style="color:#60a5fa">去 TUI</a></div></div>
      <div class="stat"><div class="v" id="s-autoweb">-</div><div class="l">Web 自动启动 <a href="javascript:void(0)" onclick="switchNav('gateway')" style="color:#60a5fa">去网关</a></div></div>
      <div class="stat"><div class="v" id="sys-health"><span class="dot" style="margin-right:6px"></span>健康</div><div class="l">系统健康总览 <span class="muted" id="sys-health-report"></span></div></div>
    </div>
    <div class="muted banner" id="ov-hint" style="margin-top:12px">
      <span id="ov-hint-full"><b>①</b> 添加 key → 下方输入框　<b>②</b> 按钮设当前 key（Zen/Go/网关三域）　<b>③</b> 每 key 「检查」双套餐健康　<b>④</b> 各域手动轮换见 <a href="javascript:void(0)" onclick="switchNav('tui')" style="color:#60a5fa">TUI</a>，网关见 <a href="javascript:void(0)" onclick="switchNav('gateway')" style="color:#60a5fa">网关</a></span>
      <span id="ov-hint-min" style="display:none">当前状态健康。</span>
    </div>
  </div>
  <div class="card" id="keys-add-card">
    <div class="row" style="margin-bottom:10px"><input id="new-name" placeholder="名称，如 act2">&nbsp;<input id="new-key" placeholder="sk-xxxx 完整的 API key"><button class="primary" onclick="addKey()">新增 key</button></div>
    <div class="muted banner" id="keys-empty" style="display:none">还没有 key：粘贴第一个 opencode-go key，添加后自动探测健康。</div>
    <div class="row" style="margin-bottom:10px"><span class="muted">手动操作：</span><button onclick="rotateDomain('zen')">Zen 轮换</button><button onclick="rotateDomain('go')">Go 轮换</button><button onclick="rotateDomain('gateway')">网关轮换</button><button onclick="checkKeys()">检测所有 key</button><span class="muted" id="check-hint"></span></div>
  </div>
  <div class="card" id="keys-table-card">
    <div class="table-wrap">
    <table style="min-width:1120px">
      <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>Zen 健康</th><th>Go 健康</th><th>操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    </div>
    <div class="muted" style="margin-top:8px">每 key 独立冷却窗口行内设置；Zen 当前 = opencode 免费档，Go 当前 = 套餐；健康列为「检查」结果（zen/go 双端点，可 hover 看探测时间与详情）。</div>
    <div class="msg" id="msg"></div>
  </div>
  </div>

  <!-- ============ TUI：zen / go 两个子区块（当前 key、冷却列表、手动轮换、冷却设置） ============ -->
  <div class="block" id="nav-tui" style="display:none">
  <div class="card" id="tui-zen-card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b>Zen 免费档（provider <code>opencode</code>） <span id="tui-zen-badge"></span></b>
      <div class="actions">
        <button id="tui-zen-rotate" onclick="rotateDomain('zen')">手动轮换</button>
        <button onclick="editGlobalWindow()">全局冷却窗口设置</button>
      </div>
    </div>
    <div class="row" style="margin-bottom:8px"><span class="muted">当前 key：</span><b id="tui-zen-cur">-</b></div>
    <div class="muted" id="tui-zen-note">Zen 免费档轮换会同步写入 auth.json（免费档主用）。冷却中 key：</div>
    <pre id="tui-zen-list">(无)</pre>
  </div>
  <div class="card" id="tui-go-card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b>Go 套餐（provider <code>opencode-go</code>） <span id="tui-go-badge"></span></b>
      <button id="tui-go-rotate" onclick="rotateDomain('go')">手动轮换</button>
    </div>
    <div class="row" style="margin-bottom:8px"><span class="muted">当前 key：</span><b id="tui-go-cur">-</b></div>
    <div class="muted" id="tui-go-note">Go 套餐域与网关域一样，轮换不写 auth.json（auth.json 单槽仅维护 zen 免费档）。冷却中 key：</div>
    <pre id="tui-go-list">(无)</pre>
  </div>
  </div>

  <!-- ============ 统计 · 分析与日志（用量趋势 + 轮换统计 + 运行日志 + 网关日志，双列） ============ -->
  <div class="block" id="nav-stats" style="display:none">
  <div class="card" id="gw-usage-trend-card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <b>用量趋势</b>
      <div class="row" style="flex-wrap:wrap">
        <span class="muted" style="display:flex;align-items:center;gap:4px">近
          <select id="trend-days" onchange="refreshUsageTrend()">
            <option value="7" selected>7</option>
            <option value="30">30</option>
          </select> 天</span>
        <button onclick="refreshUsageTrend()">刷新</button>
      </div>
    </div>
    <div class="stats" style="margin-bottom:10px">
      <div class="stat"><div class="v" id="tr-total">-</div><div class="l">总请求</div></div>
      <div class="stat"><div class="v" id="tr-ok">-</div><div class="l">成功</div></div>
      <div class="stat"><div class="v" id="tr-fail">-</div><div class="l">失败</div></div>
      <div class="stat"><div class="v" id="tr-rot">-</div><div class="l">轮换次数</div></div>
    </div>
    <div style="position:relative">
      <canvas id="trend-canvas" style="width:100%;height:220px;display:block"></canvas>
      <div id="trend-empty" class="muted" style="position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;text-align:center;pointer-events:none">图表数据不足</div>
    </div>
    <div style="margin-top:10px" class="row" style="flex-wrap:wrap">
      <span style="display:inline-flex;align-items:center;gap:5px;margin-right:14px"><i class="trend-legend" style="background:var(--ok,#34d399)"></i>成功</span>
      <span style="display:inline-flex;align-items:center;gap:5px"><i class="trend-legend" style="background:var(--err,#f87171)"></i>失败</span>
      <span class="muted" id="trend-hint" style="margin-left:auto;text-align:right"></span>
    </div>
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

  <!-- ============ 网关：网关状态主卡 + 配置子区 + 使用方式 + 全局设置（web on/off） ============ -->
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
      <div class="stat"><div class="v" id="gw-mcount">-</div><div class="l">模型数 go+zen</div></div>
    </div>
    <div class="row" style="margin-bottom:10px">
      <span class="muted" style="flex:1">管理操作（启停 launchd 服务，走跨进程锁）：</span>
      <button id="gw-start" onclick="gwManage('start')">启动</button>
      <button id="gw-stop" onclick="gwManage('stop')">停止</button>
      <button id="gw-restart" onclick="gwManage('restart')">重启</button>
    </div>
    <div class="row" style="margin-bottom:10px">
      <span class="muted" style="flex:1">功能测试（真实发一条请求验证网关→上游→模型全链路）：</span>
      <button id="gw-test" onclick="gwTest()">网关功能测试</button>
    </div>
    <div id="gw-test-msg" class="msg" style="margin-top:6px"></div>
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
    <div class="row" style="margin-top:10px">
      <span class="muted" style="display:flex;align-items:center;gap:8px;flex:1">网关 key 自动轮换：
        <button id="auto-rotate-btn" class="" onclick="toggleAutoRotate()"></button>
      </span>
    </div>
    <div class="muted" style="margin-top:4px">配额耗尽（401/402/429）时自动切到下一个可用 opencode key。Zen 免费档默认关闭（UA/频率限流与账号无关，轮换无效）；go 套餐恒开启。关闭时仍可手动「网关轮换」。切换后需重启网关生效。</div>
    <div id="plan-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <div class="card" id="gw-token-card">
    <b>网关访问 Key <span id="token-badge"></span></b>
    <div class="row" style="margin-top:10px">
      <button class="primary" onclick="genGatewayToken()">＋ 生成新 Key</button>
      <button onclick="setGatewayToken()">设置单个</button>
      <button class="danger" onclick="clearGatewayToken()">清空全部</button>
    </div>
    <div id="token-list" class="muted" style="margin-top:10px">加载中…</div>
    <div class="muted" style="margin-top:6px">生成/设置后需「重启网关」生效。其它 agent 连网关时用任一 key（curl -H "Authorization: Bearer &lt;key&gt;"）。</div>
    <div id="token-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <div class="card" id="gw-egress-card">
    <b>IP 池（轮换出口） <span id="egress-badge"></span></b>
    <div class="row" style="margin-top:10px">
      <span class="muted" style="display:flex;align-items:center;gap:8px;flex:1">IP 轮换总开关：
        <button id="ip-rotation-btn" class="primary" onclick="toggleIpRotation()">开启</button>
      </span>
    </div>
    <div class="row" style="margin-top:10px">
      <input id="egress-input" type="text" placeholder="socks5://user:pass@host:port 或 direct" style="flex:1;min-width:0" />
      <button class="primary" onclick="addEgress()">＋ 添加出口</button>
      <button id="egress-check-btn" onclick="checkEgressHealth()">检查出口</button>
      <button id="egress-checkall-btn" class="primary" onclick="checkAllHealth()">检查所有 IP 健康度</button>
      <button id="egress-movedead-btn" onclick="moveAllDeadFromEgress()">→ 转移不可用</button>
      <button id="egress-prune-btn" class="primary" onclick="pruneEgress()">一键整理</button>
      <button class="danger" onclick="clearEgress()">清空全部</button>
    </div>
    <div id="egress-toolbar" class="proxy-toolbar" style="display:none">
      <button class="small" onclick="egressSelAllToggle()">全选</button>
      <button class="small" onclick="clearEgressSel()">清空</button>
      <span class="muted" style="margin-left:8px">已选 <span id="egress-selcount">0</span></span>
      <button id="egress-activate-btn" class="primary" onclick="activateEgressSel()">启用选中为轮换（立即启动）</button>
      <button id="egress-deactivate-btn" class="small" onclick="deactivateEgressActive()">恢复全池轮换</button>
      <span class="muted" style="margin-left:8px;flex:1">勾选 1~N 个出口作为轮换子集，点「启用选中」立即生效（其余保留在池中不参与轮换）。</span>
    </div>
    <div id="egress-list" class="muted" style="margin-top:10px">加载中…</div>
    <div class="muted" style="margin-top:6px">zen 免费档按 IP 限流（429 FreeUsageLimit）；配置 <b>≥2</b> 个出口后网关在被限时自动切到下一个出口。修改后需「重启网关」生效；「检查出口」逐项真实最小探测（每项消耗 ~1 token）。</div>
    <div id="egress-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <div class="card" id="gw-limited-card">
    <b>限流池（被上游限流的出口） <span id="limited-badge"></span></b>
    <div class="row" style="margin-top:10px">
      <button id="limited-check-btn" onclick="checkLimitedHealth()">健康检查</button>
      <button id="limited-movedead-btn" onclick="moveAllDeadFromLimited()">→ 转移不可用</button>
      <button id="limited-restore-btn" onclick="restoreSelectedLimited()">移回 IP 池</button>
      <span class="muted" style="margin-left:8px;flex:1">429 被限流的出口移到这里单独管理，不参与轮换；重新探测解限后可移回主池。</span>
    </div>
    <div id="limited-toolbar" class="proxy-toolbar" style="display:none"></div>
    <div id="limited-list" class="proxy-grid muted" style="margin-top:10px">无被限流的出口。</div>
    <div class="muted" style="margin-top:6px">「健康检查」对每个限流出口做真实最小探测——状态变为可用即解除限流，勾选后「移回 IP 池」。</div>
    <div id="limited-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <details class="card" id="gw-dead-card" style="margin-top:12px">
    <summary style="cursor:pointer;user-select:none">
      <b>不可用池（探测失败的出口） <span id="dead-badge"></span></b>
      <span class="muted" style="margin-left:8px">▼ 展开 / 收起（正常情况收缩，有不可用出口时展开处理）</span>
    </summary>
    <div class="row" style="margin-top:10px">
      <button id="dead-check-btn" onclick="checkDeadHealth()">健康检查</button>
      <button id="dead-restore-btn" onclick="restoreSelectedDead()">移回 IP 池</button>
      <span class="muted" style="margin-left:8px;flex:1">不可用（探测失败/超时）的出口移到这里单独管理，不参与轮换；重新探测恢复后可移回主池。</span>
    </div>
    <div id="dead-toolbar" class="proxy-toolbar" style="display:none">
      <button class="small" onclick="deadSelAllToggle()">全选</button>
      <button class="small" onclick="clearDeadSel()">清空</button>
      <span class="muted" style="margin-left:8px">已选 <span id="dead-selcount">0</span></span>
    </div>
    <div id="dead-list" class="proxy-grid muted" style="margin-top:10px">无不可用出口。</div>
    <div class="muted" style="margin-top:6px">「健康检查」对每个不可用出口做真实最小探测——状态变为可用即勾选「移回 IP 池」。</div>
    <div id="dead-msg" class="msg" style="margin-top:6px"></div>
  </details>

  <div class="card" id="gw-proxy-card">
    <b>Webshare 导入 <span id="proxy-badge"></span></b>
    <div class="row" style="margin-top:10px">
      <select id="proxy-mode" style="width:150px">
        <option value="token">API Token Key</option>
        <option value="link">下载链接</option>
      </select>
      <input id="proxy-input" type="text" placeholder="Token Key 或 下载链接 URL" style="flex:1;min-width:0" />
      <button class="primary" id="proxy-fetch-btn" onclick="fetchWebshareProxies()">导入</button>
    </div>
    <div class="muted" style="margin-top:6px;flex:1">Webshare 官方 API 拉取代理清单，逐个做 SOCKS5 连通验证（opencode.ai:443），勾选有效项后一键加入 IP 池。Token Key 长期有效；下载链接几分钟内有效，过期需重新生成。</div>
    <div class="proxy-toolbar" id="proxy-toolbar" style="display:none">
      <button class="small" id="proxy-toggleall-btn" onclick="toggleProxyAll()">全选有效</button>
      <button class="small" onclick="clearProxySel()">清空</button>
      <button class="small primary" id="proxy-addsel-btn" onclick="addSelectedProxies()">＋ 添加选中（<span id="proxy-selcount">0</span>）</button>
      <span class="muted hint" id="proxy-toolbar-hint"></span>
    </div>
    <div id="proxy-list" class="proxy-grid muted" style="margin-top:10px">未导入。粘贴 Token Key 或下载链接，点「导入」拉取 Webshare 代理。</div>
    <div id="proxy-msg" class="msg" style="margin-top:6px"></div>
  </div>
  </div>

  <div class="card" id="gw-usage-card">
    <b>使用方式</b>
    <div class="row" style="margin-top:10px">
      <span class="muted" style="flex:1">本地网关地址（OpenAI / Anthropic / Responses 三协议，默认仅 127.0.0.1 监听）：</span>
      <code class="mono">127.0.0.1:18888</code>
    </div>
    <div class="muted" style="margin-top:6px">
      鉴权默认关闭；若设了 <code>ZEN_GATEWAY_TOKEN</code>，请求需带 <code>Authorization: Bearer &lt;ZEN_GATEWAY_TOKEN&gt;</code>。测前先 <code>curl http://127.0.0.1:18888/healthz</code> 确认网关在跑。
    </div>
    <details open style="margin-top:10px">
      <summary>curl 直连（OpenAI Chat Completions）</summary>
      <pre style="margin-top:8px"><code id="usage-curl-text"></code></pre>
      <div style="margin-top:6px" class="actions"><button onclick="copyUsage('curl')">复制</button></div>
    </details>
    <details style="margin-top:6px">
      <summary>codex CLI（Responses）—— ~/.codex/config.toml</summary>
      <pre style="margin-top:8px"><code id="usage-codex-text"></code></pre>
      <div class="muted" style="margin-top:6px">坑：顶层 <code>web_search = "disabled"</code> 必须保留，否则 codex 会发 web_search 工具触发网关 400。</div>
      <div style="margin-top:6px" class="actions"><button onclick="copyUsage('codex')">复制</button></div>
    </details>
    <details style="margin-top:6px">
      <summary>claude code（Anthropic Messages）—— ~/.claude/settings.json env 块</summary>
      <pre style="margin-top:8px"><code id="usage-claude-text"></code></pre>
      <div class="muted" style="margin-top:6px">坑：只要 <code>ANTHROPIC_AUTH_TOKEN</code> 存在，claude code 就忽略 <code>ANTHROPIC_BASE_URL</code> 直连上游——切网关前必须移除。</div>
      <div style="margin-top:6px" class="actions"><button onclick="copyUsage('claude')">复制</button></div>
    </details>
  </div>

  <div class="card" id="gw-ladder-card">
    <b>梯子（本地 SOCKS5 透明代理） <span id="ladder-badge"></span></b>
    <div class="row" style="margin-top:10px">
      <span class="muted" style="align-items:center;display:flex;flex:1;gap:8px">状态：
        <span id="ladder-state">-</span>
      </span>
      <button id="ladder-toggle-btn" class="primary" onclick="ladderToggle()">启用</button>
      <button id="ladder-check-surf-btn" onclick="ladderSurfCheck()">科学上网筛选</button>
    </div>
    <div class="row" style="margin-top:10px">
      <label class="muted" style="align-items:center;display:flex;gap:6px">本地端口 <input id="ladder-port" type="number" value="10880" min="1" max="65535" style="width:90px" /></label>
      <label class="muted" style="align-items:center;display:flex;gap:6px">模式
        <select id="ladder-mode" onchange="renderLadderState()">
          <option value="rotate">轮换（出口池自动换 IP）</option>
          <option value="fixed">指定固定出口</option>
        </select>
      </label>
    </div>
    <div id="ladder-fixed-row" class="row" style="margin-top:8px;display:none">
      <label class="muted" style="align-items:center;display:flex;flex:1;gap:6px">固定出口
        <select id="ladder-fixed" style="flex:1;min-width:0"></select>
      </label>
    </div>
    <div class="row" style="margin-top:8px">
      <button class="primary" onclick="ladderSave()">保存并应用</button>
      <span class="muted" style="margin-left:8px;flex:1">保存后网关即时启动/停止本地 SOCKS5（无需重启网关）。</span>
    </div>
    <div id="ladder-pool" class="block" style="border-top:1px solid var(--bd-2);margin-top:12px;padding-top:10px">
      <b>梯子 IP 池（专用出口） <span id="ladder-pool-badge"></span></b>
      <div class="row" style="margin-top:10px">
        <input id="ladder-pool-input" type="text" placeholder="socks5://user:pass@host:port" style="flex:1;min-width:0" />
        <button id="ladder-pool-add-btn" onclick="addLadderEgress()">＋ 添加出口</button>
        <button id="ladder-pool-check-btn" onclick="checkLadderPoolHealth()">健康检查</button>
        <button id="ladder-pool-movedead-btn" onclick="moveAllLadderDead()">→ 转移不可用</button>
        <button id="ladder-pool-restore-btn" onclick="restoreSelectedLadder()">移回主 IP 池</button>
      </div>
      <div id="ladder-pool-toolbar" class="proxy-toolbar" style="display:none">
        <button class="small" onclick="ladderPoolSelAllToggle()">全选</button>
        <button class="small" onclick="clearLadderPoolSel()">清空</button>
        <span class="muted" style="margin-left:8px">已选 <span id="ladder-pool-selcount">0</span></span>
      </div>
      <div id="ladder-pool-list" class="proxy-grid muted" style="margin-top:10px">未配置梯子专用出口（梯子将回退主 IP 池或本地直连）。</div>
      <div class="muted" style="margin-top:6px">「健康检查」对梯子池每个出口做真实最小探测（可用/限流 429/不可用）；梯子 rotate 优先走本池，池空自动回退主 IP 池。「→ 转移不可用」一键把检测失败项移入不可用池；勾选后「移回主 IP 池」。</div>
      <div id="ladder-pool-msg" class="msg" style="margin-top:6px"></div>
    </div>
    <div class="muted" style="margin-top:6px">
      提供 <code>socks5://127.0.0.1:<span id="ladder-port-hint">10880</span></code> 本地 SOCKS5 端口，任何应用（浏览器/curl/git/系统代理）指向它即可科学上网——每个连接经出口池智能换 IP（轮换模式）或固定出口转发。
    </div>
    <details style="margin-top:10px">
      <summary>梯子使用说明</summary>
      <pre style="margin-top:8px" id="ladder-usage-text"></pre>
    </details>
    <div id="ladder-surf-result" class="muted" style="margin-top:8px"></div>
    <div id="ladder-msg" class="msg" style="margin-top:6px"></div>
  </div>

  <div class="card">
    <b>设置</b>
    <div class="row" style="margin-top:10px">
      <span style="flex:1">Web 自动启动：<b id="set-autoweb">-</b></span>
      <button id="web-on-btn" onclick="webOn()">开启</button>
      <button id="web-off-btn" class="danger" onclick="webOff()">关闭</button>
    </div>
    <div class="muted" style="margin-top:8px">全局冷却窗口/每 key 独立窗口见 <a href="javascript:void(0)" onclick="switchNav('tui')" style="color:#60a5fa">TUI</a> 与 Key 表格；套餐切换与网关 token 见上方网关卡片。</div>
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
/* P0-2 系统健康聚合：网关运行态由 refreshGateway 写入，egress 健康由 egressHealth 缓存 */
var gwRunning = null
var lastHealthLevel = "" // 三角色翻转检测（绿→黄/红 时触发一次桌面通知）
/* P2-3：Key 表格渲染签名缓存（5s 轮询全量重建守卫） */
var lastKeysSig = ""
/* P1-1 XSS 修复：统一转义 HTML 特殊字符（用户可控字段拼 innerHTML / 属性前必须过 esc） */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))
}
/* P0-2 系统健康聚合：key 状态枚举中文名（与表格 tip 命名一致） */
function statusErrLabel(s) {
  return { ok: "可用", invalid: "key 无效", nobalance: "余额不足", limited: "限流", error: "异常" }[s] || s
}
async function refresh() {
  try {
    const st = await api("/api/status")
    const el = document.getElementById("s-current")
    el.textContent = st.current || "(none)"
    el.title = st.current || "(none)"
    const eg = document.getElementById("s-current-go")
    eg.textContent = st.current_go || "(none)"
    eg.title = st.current_go || "(none)"
    document.getElementById("s-avail").textContent = st.availableCount + "/" + st.keyCount
    document.getElementById("s-total").textContent = "total " + st.keyCount
    document.getElementById("s-cooldown").textContent = st.cooldown_minutes
    document.getElementById("s-autoweb").textContent = st.auto_web ? "开启" : "关闭"
    const sec = document.getElementById("set-autoweb"); if (sec) sec.textContent = st.auto_web ? "开启" : "关闭"
    document.getElementById("web-off-btn").disabled = !st.auto_web
    document.getElementById("web-on-btn").disabled = st.auto_web
    /* TUI 子区块：zen/go 各自当前 key + 冷却列表 + 运行徽标 */
    const setCur = (id, cur) => { const x = document.getElementById(id); x.textContent = cur || "(none)" }
    setCur("tui-zen-cur", st.current)
    setCur("tui-go-cur", st.current_go)
    const zenBadge = document.getElementById("tui-zen-badge")
    zenBadge.innerHTML = st.current ? '<span class="badge b-running">运行中</span>' : '<span class="badge b-stopped">未设置</span>'
    const goBadge = document.getElementById("tui-go-badge")
    goBadge.innerHTML = st.current_go ? '<span class="badge b-running">运行中</span>' : '<span class="badge b-stopped">未设置</span>'
    const coolList = (field) => st.keys
      .filter(k => k[field] && Date.parse(k[field]) > Date.now())
      .map(k => k.name + " (剩余 " + Math.ceil((Date.parse(k[field]) - Date.now()) / 60000) + "min)")
      .join(", ") || "(无冷却中 key)"
    document.getElementById("tui-zen-list").textContent = coolList("cooldown_until")
    document.getElementById("tui-go-list").textContent = coolList("cooldown_until_go")
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
    /* P0-2 系统健康总览：聚合 key/网关/出口池 → 绿(正常)/黄(降级)/红(告警) + 原因清单。
     * 三角色翻转（非正常首次出现）时触发一次桌面通知（Notification API，未授权静默跳过）。 */
    const problems = []
    if (!st.keys.length) problems.push("未配置 key")
    if (st.keys.length && st.availableCount === 0) problems.push("全部 key 冷却/不可用")
    const badKey = st.keys.find(k => k.last_status && k.last_status !== "ok")
    if (badKey) problems.push("存在异常 key: " + badKey.name + " (" + (statusErrLabel(badKey.last_status)) + ")")
    if (gwRunning === false) problems.push("网关未运行")
    if (st.egressEnabled && Object.keys(egressHealth).length > 0) {
      const alive = Object.values(egressHealth).filter((h) => h.ok).length
      if (alive === 0) problems.push("IP 轮换开启但出口池全不可用（降级直连）")
    }
    let level = problems.some(p => p.startsWith("未配置") || p.startsWith("全部 key") || p.startsWith("网关未运行")
      || p.indexOf("出口池全不可用") >= 0) ? "red" : (problems.length ? "yellow" : "green")
    const dot = document.getElementById("sys-health")
    const dotColor = level === "red" ? "#ef4444" : level === "yellow" ? "#f59e0b" : "#22c55e"
    dot.innerHTML = '<span class="dot" style="background:' + dotColor + ';margin-right:6px"></span>' +
      (level === "green" ? "健康" : level === "yellow" ? "降级" : "告警")
    document.getElementById("sys-health-report").textContent = problems.join("；") || "各组件正常"
    if (lastHealthLevel !== level) {
      lastHealthLevel = level
      if (level !== "green") {
        try {
          if ("Notification" in window && Notification.permission === "granted") {
            const d = new Notification("go-rotate 系统告警·" + (level === "red" ? "告警" : "降级"), {
              body: problems.join("；"),
              tag: "gr-health",
            })
            d.onclick = () => { window.focus() }
          }
        } catch (e) { /* 桌面通知非必要路径，静默 */ }
      }
    }
    /* P0-3 陈旧探测提示：有 key 健康标记异常但探测时间过老（>24h）→ 提示建议重检 */
    const STALE_MS = 24 * 3600 * 1000
    const nowT = Date.now()
    const staleKeys = st.keys.filter(k =>
      (k.last_status && k.last_status !== "ok") &&
      (!k.last_checked_zen || nowT - Date.parse(k.last_checked_zen) > STALE_MS) &&
      (!k.last_checked_go || nowT - Date.parse(k.last_checked_go) > STALE_MS))
    if (staleKeys.length) {
      const el0 = document.getElementById("check-hint")
      el0.textContent = "⚠️ " + staleKeys.map(k => k.name).join("/") + " 的异常健康标记已超过 24h 未复验，建议点击「检测所有 key」"
    }
    /* P2-3：表格增量守卫——三域字段（健康/冷却/当前/探测时间）无变化时跳过 5s 全量重建 */
    const sig = JSON.stringify(st.keys.map(k =>
      [k.name, k.state, k.cooldown_until, k.cooldown_until_go, k.cooldown_until_gateway,
       k.last_status, k.last_status_go, k.last_checked_zen, k.last_checked_go,
       k.isCurrent, k.isCurrentGo, k.isCurrentGateway, k.masked]))
    const tb = document.getElementById("tbody")
    if (sig !== lastKeysSig) {
      lastKeysSig = sig
      tb.innerHTML = ""
    for (const k of st.keys) {
      const tr = document.createElement("tr")
      // 状态徽章：优先显示 zen 健康状态（余额不足/无效/限流），其次冷却/可用
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
      if (k.isCurrent) badge += '<span class="badge b-zen">Zen 当前</span>'
      if (k.isCurrentGo) badge += '<span class="badge b-go">Go 当前</span>'
      if (k.isCurrentGateway) badge += '<span class="badge b-gw">网关当前</span>'
      /* 双套餐健康列：zen:✓/✗（last_status）+ go:✓/✗（last_status_go），title 含探测时间；- = 未探测；✓ 用域色区分列 */
      const healthCell = (status, checked, okCls) => {
        if (!status || status === "ok")
          return '<span class="badge ' + okCls + ' gr-tip" title="' + esc(checked ? "探测时间 " + checked : "未探测") + '">✓</span>'
        const cls = (status === "invalid" || status === "nobalance" || status === "error") ? "b-invalid" : "b-warn"
        return '<span class="badge ' + cls + ' gr-tip" title="' + esc((statusHint[status] || status) + (checked ? " · 探测 " + checked : "")) + '">✗ ' + esc(statusLabel[status] || status) + '</span>'
      }
      const n = esc(k.name), key = esc(k.key), masked = esc(k.masked)
      const zenCooling = k.state === "cooling"
      const goCooling = !!(k.cooldown_until_go && Date.parse(k.cooldown_until_go) > Date.now())
      /* 操作列两行分组：行1 检查(主)+设为当前(三域色)；行2 冷却(琥珀进入/绿清除)+管理(ghost+danger) */
      tr.innerHTML =
        '<td class="td-name" title="' + n + '">' + n + '</td>' +
        '<td class="muted" title="' + key + '">' + masked + '</td>' +
        '<td>' + badge + '</td>' +
        '<td>' + healthCell(k.last_status, k.last_checked_zen, "b-zen") + '</td>' +
        '<td>' + healthCell(k.last_status_go, k.last_checked_go, "b-go") + '</td>' +
        '<td><div class="actions">' +
          '<div class="row">' +
            '<button class="primary" data-check="' + n + '" title="探测该 key 双套餐健康（consumes ~1 token/端点）">检查</button>' +
            '<span class="grp">' +
              (k.isCurrent ? '' : '<button class="zen" data-set="' + n + '" title="设为 zen 免费档当前（同步 auth.json）">Zen 使用</button>') +
              (k.isCurrentGo ? '' : '<button class="go" data-set-go="' + n + '" title="设为 go 套餐当前（不写 auth.json）">Go 使用</button>') +
              (k.isCurrentGateway ? '' : '<button class="gw" data-set-gw="' + n + '" title="设为网关当前（不写 auth.json）">网关使用</button>') +
            '</span>' +
          '</div>' +
          '<div class="row">' +
            '<span class="grp">' +
              (zenCooling
                ? '<button class="success" data-cooldown="' + n + '" data-min="0">Zen 清冷却</button>'
                : '<button class="warn" data-cooldown="' + n + '" data-min="' + esc(st.cooldown_minutes) + '">Zen 冷却</button>') +
              (goCooling
                ? '<button class="success" data-cooldown-go="' + n + '" data-min="0">Go 清冷却</button>'
                : '<button class="warn" data-cooldown-go="' + n + '" data-min="' + esc(st.cooldown_minutes) + '">Go 冷却</button>') +
              '<button class="success" data-cooldown-gw="' + n + '" data-min="0" title="清除网关域冷却">网关清冷却</button>' +
            '</span>' +
            '<span class="grp">' +
              '<button class="ghost" data-window="' + n + '" title="设置该 key 独立冷却窗口（分钟，留空清除回退全局）">冷却窗口</button>' +
              (k.cooldown_minutes ? '<button class="ghost" data-window-clear="' + n + '" title="清除独立窗口，回退全局">清除窗口</button>' : '') +
              '<button class="ghost" data-edit="' + n + '" title="编辑名称 / key 值">编辑</button>' +
              '<button class="danger" data-del="' + n + '">删除</button>' +
            '</span>' +
          '</div>' +
        '</div></td>'
      tb.appendChild(tr)
      }
      tb.querySelectorAll("[data-check]").forEach(b => b.onclick = () => { b.classList.add("loading"); doOp(() => api("/api/keys/check", { name: b.dataset.check, domain: "all" })) })
      tb.querySelectorAll("[data-set]").forEach(b => b.onclick = () => doOp(() => api("/api/current", { name: b.dataset.set })))
      tb.querySelectorAll("[data-set-go]").forEach(b => b.onclick = () => doOp(() => api("/api/current", { name: b.dataset.setGo, domain: "go" })))
      tb.querySelectorAll("[data-set-gw]").forEach(b => b.onclick = () => doOp(() => api("/api/current", { name: b.dataset.setGw, domain: "gateway" })))
      tb.querySelectorAll("[data-cooldown]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown", { name: b.dataset.cooldown, minutes: Number(b.dataset.min) })))
      tb.querySelectorAll("[data-cooldown-go]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown", { name: b.dataset.cooldownGo, minutes: Number(b.dataset.min), domain: "go" })))
      tb.querySelectorAll("[data-cooldown-gw]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown", { name: b.dataset.cooldownGw, minutes: Number(b.dataset.min), domain: "gateway" })))
      tb.querySelectorAll("[data-window]").forEach(b => b.onclick = () => editKeyWindow(b.dataset.window))
      tb.querySelectorAll("[data-window-clear]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown/window", { name: b.dataset.windowClear, minutes: null })))
      tb.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => editKey(b.dataset.edit))
      tb.querySelectorAll("[data-del]").forEach(b => b.onclick = () => {
        if (!confirm('确定删除 key "' + b.dataset.del + '"？此操作不可恢复。')) return
        doOp(() => api("/api/keys/delete", { name: b.dataset.del }))
      })
    }
  } catch (e) { pollErr(e.message) }
}
/* P2-5：轮询失败节流——同一条错误消息 30s 内只提示一次，避免 5s 轮询失败 toast 风暴 */
var lastPollErr = { msg: "", at: 0 }
function pollErr(m) {
  const now = Date.now()
  if (m === lastPollErr.msg && now - lastPollErr.at < 30000) return
  lastPollErr = { msg: m, at: now }
  toast(m, "error")
}
/* 主题切换：深色/浅色，localStorage 记忆（默认深色，head 防闪烁脚本已预置 data-theme；图标/文本由 CSS 驱动） */
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark"
  const next = cur === "light" ? "dark" : "light"
  document.documentElement.setAttribute("data-theme", next)
  try { localStorage.setItem("gr-theme", next) } catch (e) {}
  /* 用量趋势：切换主题后用缓存的 lastTrend 重绘（canvas 取色随主题变，免重新拉取） */
  if (lastTrend) { try { renderTrend(lastTrend) } catch (e) {} }
}
async function addKey() {
  const name = document.getElementById("new-name").value.trim()
  const key = document.getElementById("new-key").value.trim()
  if (!name || !key) return showErr("名称和 key 不能为空")
  if (!key.startsWith("sk-")) return showErr('key 必须以 "sk-" 开头')
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
async function rotateDomain(domain) {
  try { await api("/api/rotate", { domain }); refresh() }
  catch (e) { showErr(e.message) }
}
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
    // 探测会真实消耗配额（~1 token/端点/key）：显式 POST + domain:"all" 双端点（api 带 body 即 POST）
    const j = await api("/api/keys/check", { domain: "all" })
    health = j.results || {}
    hint.textContent = "检测完成（每次消耗约 1 token/端点）"
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
  if (newKey.trim()) {
    if (!newKey.trim().startsWith("sk-")) return showErr('key 必须以 "sk-" 开头')
    patch.key = newKey.trim()
  }
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
  /* 用量趋势：并入同一 10s 轮询。放这里而非函数尾部——尾部在「无轮换记录」分支有早退，
   * 会导致趋势卡永远不刷新（真实场景 stats-tbody 常为空）。独立 fire-and-forget，互不阻塞。 */
  refreshUsageTrend()
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
    gwRunning = !!g.running
    const installed = !!g.ctlExists
    // 双域：网关卡「当前 key」走本地 statusPayload 网关域字段（current_gateway），
    // 不用 graft 的 healthz current（网关域名）。失败回退 healthz.current 兜底显示。
    const st = await api("/api/status").catch(() => null)
    const gwCur = (st && st.current_gateway) || (g.healthz && g.healthz.current) || "-"
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
    document.getElementById("gw-current").textContent = gwCur || "-"
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
    // 模型清单：go + zen 双套餐动态查看（动态 = 上游实时 /v1/models，内置 = 兜底表）。
    // gwModels 来自网关 /api/gateway/models（go-rotate 服务端带 Bearer 读鉴权网关）。
    const gm = g.gwModels
    const plans = gm && gm.plans && typeof gm.plans === "object" ? gm.plans : null
    if (plans) {
      const planMeta = { go: "Go 订阅", zen: "Zen 免费" }
      const uniq = new Set()
      let ph = ""
      ;["go", "zen"].forEach(pid => {
        const p = plans[pid]
        if (!p || !Array.isArray(p.models)) return
        p.models.forEach(x => { if (typeof x === "string") uniq.add(x) })
        const all = p.models
        const preview = all.slice(0, 4).map(esc).join(", ") + (all.length > 4 ? " …" : "")
        const dyn = Array.isArray(p.dynamic) ? p.dynamic.length : 0
        const builtin = Array.isArray(p.builtin) ? p.builtin.length : 0
        const curTag = gm.active === pid ? ' <span class="badge b-running">当前套餐</span>' : ""
        const src = dyn > 0 ? "动态 " + dyn + " 个 · 内置兜底 " + builtin + " 个" : "内置 " + builtin + " 个（上游动态拉取不可用）"
        ph += '<details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">' +
          esc(planMeta[pid] || pid) + '（' + all.length + '）' + curTag + ' · ' + src +
          '：' + preview + '</summary>' +
          '<div class="model-list" style="margin-top:4px">' + all.map(esc).join("<br>") + '</div></details>'
      })
      document.getElementById("gw-mcount").textContent = String(uniq.size)
      html += '<div style="margin-top:8px;display:flex;align-items:center;gap:8px">' +
        '<span class="muted" style="flex:1">模型清单（go 与 zen 全部模型动态查看）</span>' +
        '<button id="gw-models-refresh" onclick="refreshGwModels()">刷新模型</button></div>' + ph
    } else {
      // 旧网关/降级：只有单套餐合并清单时，沿用原「模型（N）」折叠展示
      const models = g.models || []
      if (models.length) {
        const preview = models.slice(0, 4).map(esc).join(", ") + (models.length > 4 ? " …" : "")
        html += '<details class="small" style="margin-top:6px"><summary class="muted" style="cursor:pointer">' +
          '模型（' + models.length + '）：' + preview + '</summary>' +
          '<div class="model-list" style="margin-top:4px">' + models.map(esc).join("<br>") + '</div></details>'
      }
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
/* 手动刷新 go + zen 双套餐动态模型表（调网关 /v1/models/refresh 重拉上游），成功后刷新状态卡 */
async function refreshGwModels() {
  const btn = document.getElementById("gw-models-refresh")
  if (btn) btn.disabled = true
  try {
    const r = await api("/api/gateway/models/refresh", {})
    if (r.ok) {
      showMsg("模型清单已刷新：go 动态 " + (r.go ?? "-") + " 个 / zen 动态 " + (r.zen ?? "-") + " 个")
    } else {
      showErr("模型刷新失败：" + (r.error || "网关无响应"))
    }
  } catch (e) {
    showErr("模型刷新失败：" + e.message)
  }
  if (btn) setTimeout(() => { btn.disabled = false }, 800)
  refreshGateway()
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
/* 网关功能测试：真实端到端（经网关发最小 chat 请求），结果写 gw-test-msg */
async function gwTest() {
  const btn = document.getElementById("gw-test")
  const msg = document.getElementById("gw-test-msg")
  if (btn) btn.disabled = true
  msg.textContent = "测试中…（真实请求上游，可能需几秒）"
  msg.className = "msg"
  try {
    const r = await api("/api/gateway/test", {})
    msg.textContent = (r.ok ? "✅ " : "⚠️ ") + (r.detail || (r.ok ? "网关功能正常" : "测试失败"))
    msg.className = r.ok ? "msg" : "msg err"
  } catch (e) {
    msg.textContent = "测试失败：" + e.message
    msg.className = "msg err"
  }
  if (btn) setTimeout(() => { btn.disabled = false }, 1000)
  setTimeout(refreshGateway, 1500)
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

/* ---- 用量趋势（/api/gateway/usage/trend 代理 + Canvas 零依赖折线图） ----
 * 数据源：网关 /api/usage/trend 实时聚合 usage.jsonl → {total, byKey, byDay, byEndpoint},
 * byDay[date] = {requests, success, rotated}（无 fail 字段，失败 = requests - success）。
 * 刷新节奏：并入 refreshStats（nav-stats 可见时 10s 一次）+ 天数切换/手动刷新 + 主题切换重绘（cache 免请求）。 */
var lastTrend = null // 最近一次成功数据缓存（主题切换 / 10s 内复用，避免重复拉取）

/** 从 computed style 取 CSS 变量色值（canvas 不能直接用 var()，需真实色值；主题切换后取到新值） */
function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fb
  } catch (e) { return fb }
}

/** Y 轴最大值取「向上取整的整数」：1/2/5×10^k 阶梯，保证网格刻度干净 */
function niceCeil(v) {
  const val = Number(v)
  if (!Number.isFinite(val) || val <= 0) return 1
  if (val === 1) return 1
  const p = Math.pow(10, Math.floor(Math.log10(val)))
  const m = val / p
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10
  return step * p
}

/** 空态/失败态：清空摘要与画布，显示提示文字（覆盖层）。 */
function setTrendEmpty(msg) {
  lastTrend = null
  const canvas = document.getElementById("trend-canvas")
  if (canvas) { const c = canvas.getContext("2d"); if (c) c.clearRect(0, 0, canvas.width, canvas.height) }
  const ids = ["tr-total", "tr-ok", "tr-fail", "tr-rot"]
  for (let i = 0; i < ids.length; i++) { const el = document.getElementById(ids[i]); if (el) el.textContent = "-" }
  const hint = document.getElementById("trend-hint")
  if (hint) hint.textContent = ""
  const emptyEl = document.getElementById("trend-empty")
  if (emptyEl) { emptyEl.textContent = msg; emptyEl.style.display = "flex" }
}

/** 拉取 + 渲染。网关不可达/失败 → 卡片降级「网关未运行」；无数据 → 「数据不足」。 */
async function refreshUsageTrend() {
  const navStats = document.getElementById("nav-stats")
  if (!navStats || navStats.style.display !== "block") return
  const daysSel = document.getElementById("trend-days")
  const days = daysSel && /^\\d+$/.test(daysSel.value) ? parseInt(daysSel.value, 10) : 7
  try {
    const d = await api("/api/gateway/usage/trend?days=" + days)
    if (!d || d.ok === false) { setTrendEmpty("网关未运行（用量接口不可达，开启 zen-gateway 后自动恢复）"); return }
    lastTrend = d
    renderTrend(d)
  } catch (e) {
    setTrendEmpty("加载失败：" + (e && e.message ? e.message : e))
  }
}

/** 渲染：摘要数字 + Canvas 折线（成功/失败两色，X 轴日期、Y 轴请求数）。 */
function renderTrend(d) {
  const byDay = d.byDay || {}
  const keys = Object.keys(byDay).filter(kk => byDay[kk] && byDay[kk].requests > 0).sort()
  const emptyEl = document.getElementById("trend-empty")
  const hintEl = document.getElementById("trend-hint")
  if (!keys.length) { setTrendEmpty("数据不足（近 " + (d.window && d.window.days ? d.window.days : 7) + " 天暂无请求记录）"); return }
  const n = keys.length
  let total = 0, ok = 0, fail = 0, rot = 0
  for (let i = 0; i < n; i++) {
    const dd = byDay[keys[i]] || {}
    total += dd.requests || 0
    ok += dd.success || 0
    fail += Math.max(0, (dd.requests || 0) - (dd.success || 0))
    rot += dd.rotated || 0
  }
  document.getElementById("tr-total").textContent = String(total)
  document.getElementById("tr-ok").textContent = String(ok)
  document.getElementById("tr-fail").textContent = String(fail)
  document.getElementById("tr-rot").textContent = String(rot)
  const byKey = d.byKey || {}
  if (hintEl) hintEl.textContent = "近 " + (d.window && d.window.days ? d.window.days : n) + " 天 · UTC 按日聚合 · " + Object.keys(byKey).length + " 个 key 有记录"
  const canvas = document.getElementById("trend-canvas")
  if (!canvas || typeof canvas.getContext !== "function") { if (emptyEl) emptyEl.style.display = "none"; return }
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth || 320
  const H = 220
  canvas.width = Math.round(W * dpr)
  canvas.height = Math.round(H * dpr)
  const ctx = canvas.getContext("2d")
  if (!ctx) { if (emptyEl) emptyEl.style.display = "none"; return }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const padL = 42, padR = 14, padT = 12, padB = 26
  const plotW = W - padL - padR
  const plotH = H - padT - padB
  const tx = cssVar("--tx-3", "#6b7280")
  const grid = cssVar("--bd-2", "#2c3442")
  const okColor = cssVar("--ok", "#34d399")
  const errColor = cssVar("--err", "#f87171")
  const xFor = (i) => n === 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW
  let maxV = 0
  for (let i = 0; i < n; i++) { const v = byDay[keys[i]].requests || 0; if (v > maxV) maxV = v }
  const niceMax = niceCeil(maxV)
  ctx.font = "11px system-ui, sans-serif"
  ctx.textAlign = "right"
  ctx.textBaseline = "middle"
  ctx.strokeStyle = grid
  ctx.fillStyle = tx
  for (let g = 0; g <= 4; g++) {
    const y = padT + plotH - (g / 4) * plotH
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke()
    ctx.fillText(String(Math.round(niceMax * g / 4)), padL - 6, y)
  }
  ctx.textAlign = "center"
  ctx.textBaseline = "top"
  const step = Math.max(1, Math.ceil(n / 5))
  for (let i = 0; i < n; i++) {
    const x = xFor(i)
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke()
    if (i === 0 || i === n - 1 || i % step === 0) ctx.fillText(String(keys[i]).slice(5), x, padT + plotH + 7)
  }
  const toPts = (pick) => {
    const pts = []
    for (let i = 0; i < n; i++) {
      const dd = byDay[keys[i]] || {}
      const v = Math.min(Math.max(0, pick(dd)), niceMax)
      pts.push([xFor(i), padT + plotH - (v / niceMax) * plotH])
    }
    return pts
  }
  const drawLine = (pts, color) => {
    if (!pts.length) return
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = 1.6
    ctx.lineJoin = "round"
    ctx.lineCap = "round"
    ctx.beginPath()
    for (let i = 0; i < pts.length; i++) { if (i === 0) ctx.moveTo(pts[i][0], pts[i][1]); else ctx.lineTo(pts[i][0], pts[i][1]) }
    ctx.stroke()
    for (let i = 0; i < pts.length; i++) { ctx.beginPath(); ctx.arc(pts[i][0], pts[i][1], 2.4, 0, Math.PI * 2); ctx.fill() }
  }
  drawLine(toPts(dd => (dd.requests || 0) - (dd.success || 0)), errColor)
  drawLine(toPts(dd => dd.success || 0), okColor)
  if (emptyEl) { emptyEl.style.display = "none"; emptyEl.textContent = "" }
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
var gwToken = { plain: "" } // 本会话「生成/设置」过的明文（GET 只回掩码，明文不进 token-list）
/* token 列表多 key 渲染：每行掩码 + 复制 + 删除按钮；本会话明文存在时前置「复制明文」行。
 * 掩码列表来自 /api/gateway/config（服务端只回掩码，零明文泄漏）；每项「复制」走 /api/gateway/token
 * action=get 取单个明文（列表仍只显示掩码）；esc 防御性转义。 */
function renderTokenList(tokens) {
  const el = document.getElementById("token-list")
  if (!Array.isArray(tokens) || !tokens.length) {
    el.textContent = "\u672a\u8bbe\u7f6e\uff08\u9274\u6743\u5173\u95ed\uff09"
    return
  }
  let html = ""
  if (gwToken.plain) {
    html += '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--bd-2)">' +
      '<span class="muted" style="flex:1">本会话明文（仅本次可复制）</span>' +
      '<button class="small" onclick="copySessionPlain()">\u590d\u5236\u660e\u6587</button></div>'
  }
  html += tokens.map((t, i) =>
    '<div style="display:flex;align-items:center;gap:8px;padding:3px 0">' +
      '<code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(t) + '</code>' +
      '<button class="small" onclick="copyGatewayToken(' + i + ')">\u590d\u5236</button>' +
      '<button class="small" onclick="delGatewayToken(' + i + ')">\u5220\u9664</button></div>').join("")
  el.innerHTML = html
}
function tokenBadge(on) {
  document.getElementById("token-badge").innerHTML =
    on ? '<span class="badge b-running">鉴权开启</span>' : '<span class="badge b-stopped">鉴权关闭</span>'
}
var egressHealth = {} // 出口健康检查结果缓存：{ [url]: {ok,status,ms,error} }
var ipRotationOn = true // IP 轮换总开关（false = 走本地直连）
var autoRotateOn = false // 网关 key 自动轮换开关（zen 免费档默认关闭；go 恒开）
var currentEgressList = [] // 当前渲染的 egress 列表（供 moveToLimited 按下标操作）
var egressActiveList = [] // 手动选中的轮换子集（[]=全池轮换；来自 config.egressActive）
var egressSel = {} // 主池勾选状态：{ index: true }
var limitedHealth = {} // 限流池健康检查结果缓存：{ [url]: {ok,status,ms,error} }
var limitedSel = {} // 限流池勾选状态：{ index: true }
var deadHealth = {} // 不可用池健康检查结果缓存：{ [url]: {ok,status,ms,error} }
var deadSel = {} // 不可用池勾选状态：{ index: true }
var deadList = [] // 当前渲染的 dead 列表
function renderEgressList(egress, enabled, ipRotation) {
  const el = document.getElementById("egress-list")
  const badge = document.getElementById("egress-badge")
  const toolbar = document.getElementById("egress-toolbar")
  ipRotation = ipRotation === undefined ? ipRotationOn : ipRotation
  ipRotationOn = ipRotation
  const btn = document.getElementById("ip-rotation-btn")
  if (btn) {
    btn.textContent = ipRotation ? "开启" : "关闭"
    btn.className = ipRotation ? "primary" : ""
  }
  if (toolbar) toolbar.style.display = Array.isArray(egress) && egress.length ? "flex" : "none"
  const activeN = (egressActiveList || []).length
  badge.innerHTML = !ipRotation
    ? '<span class="badge b-stopped">IP 轮换已关闭（直连）</span>'
    : (activeN > 0
        ? '<span class="badge b-go">轮换子集 ' + activeN + "/" + (Array.isArray(egress) ? egress.length : 0) + '</span><span class="badge b-running">轮换已启用</span>'
        : (enabled
            ? '<span class="badge b-running">IP 轮换已启用</span>'
            : '<span class="badge b-stopped">未启用（需 ≥2 个出口）</span>'))
  if (!Array.isArray(egress) || !egress.length) {
    currentEgressList = egressActiveList = []
    el.textContent = !ipRotation
      ? "IP 轮换已关闭，所有请求走本地直连。开启后可用下方出口池换 IP。"
      : "未配置出口（直连）。zen 免费档被限流时添加 SOCKS5 代理出口可换 IP。"
    return
  }
  currentEgressList = egress
  el.innerHTML = egress.map((e, i) => {
    let h = ""
    const st = egressHealth[e]
    let limitedBtn = ""
    let deadBtn = ""
    if (st) {
      if (st.ok) h = '<span class="badge b-available" title="' + esc(healthTitle(st, st.ms + "ms")) + '">健康 ' + st.status + '</span>'
      else if (st.status === 429) {
        h = '<span class="badge b-warn" title="' + esc(st.error || "") + '">IP 被限流 429</span>'
        limitedBtn = '<button class="small" onclick="moveToLimited(' + i + ')">→ 限流池</button>'
      }
      else {
        h = '<span class="badge b-invalid" title="' + esc(st.error || "") + '">不可用</span>'
        deadBtn = '<button class="small" onclick="moveToDead(' + i + ')">→ 不可用池</button>'
      }
    }
    const inActive = activeN > 0 && (egressActiveList || []).includes(e)
    // 勾选三态：显式勾选优先（egressSel[i] 已定义即用其值）；未显式操作时按「是否在轮换子集」展示勾选
    const isChecked = egressSel[i] === undefined ? inActive : !!egressSel[i]
    const curBadge = i === 0 && activeN === 0 ? '<span class="badge b-go">当前</span>' : "" // 用子集时列表头即轮换中子集，不再标「当前」
    return '<div style="display:flex;align-items:center;gap:8px;padding:3px 0;border-bottom:1px solid var(--bd-2)">' +
      '<input type="checkbox" ' + (isChecked ? "checked" : "") +
        ' onchange="egressSel[' + i + ']=this.checked;updateEgressSelCount()" title="勾选为轮换子集">' +
      '<code style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(e) + '</code>' +
      (inActive ? '<span class="badge b-go">轮换中</span>' : "") +
      h + limitedBtn + deadBtn +
      '<button class="small" onclick="moveToLadderFromEgress(' + i + ')">→ 梯子池</button>' +
      curBadge +
      '<button class="small" onclick="delEgress(' + i + ')">删除</button></div>'
  }).join("")
  updateEgressSelCount()
}
function updateEgressSelCount() {
  const c = document.getElementById("egress-selcount")
  if (!c) return
  // 勾选数 = 手动勾选（egressSel）∪ 当前轮换子集（egressActiveList，激活后保持勾选展示）
  const n = currentEgressList.filter((e, i) => egressSel[i] || (egressActiveList || []).includes(e)).length
  c.textContent = n
}
function egressSelAllToggle() {
  const allOn = currentEgressList.some((e, i) => egressSel[i] || (egressActiveList || []).includes(e))
  currentEgressList.forEach((_, i) => { egressSel[i] = !allOn })
  renderEgressList(currentEgressList, ipRotationOn)
}
function clearEgressSel() {
  egressSel = {}
  renderEgressList(currentEgressList, ipRotationOn)
}
async function activateEgressSel() {
  // 选中 N 个出口 → 设为轮换子集并立即启动（网关动态读配置，无需重启）
  const msg = document.getElementById("egress-msg")
  const urls = currentEgressList.filter((e, i) => egressSel[i] || (egressActiveList || []).includes(e) ? e : false).filter(Boolean)
  // 若全部取消勾选（已没有任何选中/在子集中）→ 提示
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "未勾选任何出口（先勾选要作为轮换子集的出口）"; return }
  const btn = document.getElementById("egress-activate-btn")
  if (btn) { btn.disabled = true; btn.textContent = "启动中…" }
  try {
    const r = await api("/api/gateway/egress", { action: "activate", urls })
    egressActiveList = r.egressActive || []
    egressSel = {} // 手动勾选已消费；子集状态由 egressActiveList 驱动勾选展示
    ipRotationOn = !!r.ipRotation
    renderEgressList(r.egress || [], !!r.enabled, ipRotationOn)
    msg.className = "msg"
    msg.textContent = "已启用轮换子集（" + urls.length + " 个出口，立即生效，无需重启），已移到列表头部：" + urls.join(", ")
  } catch (e) { msg.className = "msg err"; msg.textContent = "启用失败：" + e.message }
  finally { if (btn) { btn.disabled = false; btn.textContent = "启用选中为轮换（立即启动）" } }
}
async function deactivateEgressActive() {
  // 恢复全池轮换：清空手动选中子集 → 回到整个 egress 池
  const msg = document.getElementById("egress-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "deactivate" })
    egressActiveList = []
    ipRotationOn = !!r.ipRotation
    renderEgressList(r.egress || [], !!r.enabled, ipRotationOn)
    msg.className = "msg"
    msg.textContent = "已恢复全池轮换（原" + (r.egress || []).length + " 个出口全部参与；立即生效，无需重启）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "恢复失败：" + e.message }
}
async function checkEgressHealth(progressMsg) {
  // 逐个出口实时探测：侧边实时显示每个 IP 的状态（不是一次全部等完才出结果）。
  // 限制并发（CHK_CONC=4）避免打爆网关；每完成一项立即更新该行徽标 + 进度文案。
  const msg = progressMsg || document.getElementById("egress-msg")
  const btn = document.getElementById("egress-check-btn")
  if (btn) { btn.textContent = "检查中…"; btn.disabled = true }
  const CHK_CONC = 4
  try {
    const c = await api("/api/gateway/config")
    const list = c.egress || []
    if (!list.length) { msg.className = "msg"; msg.textContent = "出口池为空"; return }
    const alive = (u) => egressHealth[u] && egressHealth[u].ok
    egressHealth = {}
    renderEgressList(list, !!c.egressEnabled, !!c.ipRotation)
    let done = 0
    const total = list.length
    const upd = () => { msg.className = "msg"; msg.textContent = "检查中 " + done + "/" + total + "…" }
    // 并发滑窗：用完即补，4 条并行
    let next = 0
    const worker = async () => {
      while (next < list.length) {
        const url = list[next++]
        try {
          const r = await api("/api/gateway/egress/health", { url })
          const got = (r.egress || [])[0]
          if (got) egressHealth[url] = { ok: got.ok, status: got.status, ms: got.ms, error: got.error }
        } catch (e) {
          egressHealth[url] = { ok: false, error: e.message }
        }
        done++
        upd()
        renderEgressList(list, !!c.egressEnabled, !!c.ipRotation)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CHK_CONC, total) }, () => worker()))
    const good = list.filter(alive).length
    msg.className = "msg"
    msg.textContent = "检查完成：" + good + "/" + total + " 个出口可用（" + new Date().toISOString() + "）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "检查失败：" + e.message }
  if (btn) { btn.textContent = "检查出口"; btn.disabled = false }
}
function renderLimitedList(limited) {
  const el = document.getElementById("limited-list")
  const badge = document.getElementById("limited-badge")
  badge.innerHTML = limited && limited.length
    ? '<span class="badge b-warn">' + limited.length + " 个被限流</span>"
    : '<span class="badge b-stopped">0 个</span>'
  const toolbar = document.getElementById("limited-toolbar")
  if (toolbar) toolbar.style.display = limited && limited.length ? "flex" : "none"
  if (!limited || !limited.length) { el.textContent = "无被限流的出口。"; return }
  el.innerHTML = limited.map((e, i) => {
    const st = limitedHealth[e]
    const isSel = !!limitedSel[i]
    let h = ""
    if (st) {
      if (st.ok) h = '<span class="badge b-available" title="' + esc(healthTitle(st, (st.ms || 0) + "ms")) + '">已解除 ' + st.status + '</span>'
      else if (st.status === 429) h = '<span class="badge b-warn">仍限流 429</span>'
      else h = '<span class="badge b-invalid">不可用</span>'
    } else {
      h = '<span class="badge b-stopped">未探测</span>'
    }
    return '<label class="proxy-item">' +
      '<input type="checkbox" ' + (isSel ? "checked" : "") +
        ' onchange="limitedSel[' + i + ']=this.checked;updateLimitedSelCount()">' +
      '<code title="' + esc(e) + '">' + esc(e.indexOf("//") >= 0 ? e.slice(e.indexOf("//") + 2) : e) + '</code>' +
      h +
      (st && !st.ok && st.status !== 429 ? '<button class="small" onclick="moveToDeadFromLimited(' + i + ')">→ 不可用池</button>' : "") +
      '<button class="small" onclick="moveToLadderFromLimited(' + i + ')">→ 梯子池</button>' +
      '<button class="small" onclick="delLimited(' + i + ')">删除</button>' +
      '</label>'
  }).join("")
  updateLimitedSelCount()
}
function updateLimitedSelCount() {
  const c = document.getElementById("limited-selcount")
  if (c) c.textContent = Object.keys(limitedSel).filter((k) => limitedSel[k]).length
}
async function moveToLimited(i) {
  const url = currentEgressList[i]
  if (!url) return
  const msg = document.getElementById("egress-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-limited", urls: [url] })
    renderLimitedList(r.limited || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已移入限流池：" + url + "（重启网关后生效，不再参与轮换）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function delLimited(i) {
  const cfg = await api("/api/gateway/config")
  const limited = cfg.limited || []
  const target = limited[i]
  if (!target) return
  const msg = document.getElementById("limited-msg")
  try {
    const after = limited.filter((_, ix) => ix !== i)
    await api("/api/gateway/egress", { action: "set-limited", list: after })
    if (limitedHealth[target]) delete limitedHealth[target]
    renderLimitedList(after)
    msg.className = "msg"; msg.textContent = "已删除限流出口：" + target
  } catch (e) { msg.className = "msg err"; msg.textContent = "删除失败：" + e.message }
}
async function checkLimitedHealth(progressMsg) {
  const msg = progressMsg || document.getElementById("limited-msg")
  const btn = document.getElementById("limited-check-btn")
  if (btn) { btn.textContent = "检查中…"; btn.disabled = true }
  try {
    const cfg = await api("/api/gateway/config")
    const limited = cfg.limited || []
    if (!limited.length) { msg.className = "msg"; msg.textContent = "限流池为空"; return }
    // 逐个真实最小探测（网关 egress/health?url= 对指定出口探 429 是否解除），实时显示每项
    limitedHealth = {}
    let done = 0
    for (const url of limited) {
      const r = await api("/api/gateway/egress/health", { url })
      const got = (r.egress || [])[0]
      if (got) limitedHealth[url] = { ok: got.ok, status: got.status, ms: got.ms, error: got.error }
      done++
      msg.className = "msg"
      msg.textContent = "限流池检查中 " + done + "/" + limited.length + "…"
      renderLimitedList(limited)
    }
    const restored = Object.keys(limitedHealth).filter((u) => limitedHealth[u] && limitedHealth[u].ok).length
    msg.className = "msg"
    msg.textContent = "检查完成：限流池 " + done + " 项，" + (limited.length - restored) + " 个仍限流，" + restored + " 个已解除（勾选可移回 IP 池）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "检查失败：" + e.message }
  finally { if (btn) { btn.textContent = "健康检查"; btn.disabled = false } }
}
async function checkAllHealth() {
  // IP 池「检查所有 IP 健康度」：主池 egress + 限流池 limited + 不可用池 dead 全部出口健康检查。
  // 整体进度统一显示在 egress-msg（主池按钮旁），每池内部逐项实时更新徽标。
  const btn = document.getElementById("egress-checkall-btn")
  const msg = document.getElementById("egress-msg")
  if (btn) { btn.textContent = "检查中…"; btn.disabled = true }
  if (msg) { msg.className = "msg"; msg.textContent = "正在检查主池 egress…" }
  try {
    await checkEgressHealth(msg)
    if (msg) { msg.textContent = "主池完成，正在检查限流池…" }
    await checkLimitedHealth(msg)
    if (msg) { msg.textContent = "限流池完成，正在检查不可用池…" }
    await checkDeadHealth(msg)
    if (msg) { msg.className = "msg"; msg.textContent = "全池健康检查完成（主池 / 限流池 / 不可用池）" }
  } catch (e) {
    if (msg) { msg.className = "msg err"; msg.textContent = "检查失败：" + e.message }
  }
  if (btn) { btn.textContent = "检查所有 IP 健康度"; btn.disabled = false }
}
async function restoreSelectedLimited() {
  const cfg = await api("/api/gateway/config")
  const limited = cfg.limited || []
  const urls = limited.filter((_, i) => limitedSel[i])
  const msg = document.getElementById("limited-msg")
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "未勾选任何出口（先健康检查，勾选已解除的）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "restore", urls })
    // 清勾选 + 刷新两池
    limitedSel = {}
    limitedHealth = {}
    renderLimitedList(r.limited || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已移回 IP 池：" + (r.restored || []).join(", ") + "（重启网关后生效）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "移回失败：" + e.message }
}
/* ================= 不可用池（探测失败的出口） ================= */
function renderDeadList(dead) {
  const el = document.getElementById("dead-list")
  const badge = document.getElementById("dead-badge")
  dead = Array.isArray(dead) ? dead : []
  deadList = dead
  badge.innerHTML = dead.length
    ? '<span class="badge b-invalid">' + dead.length + " 个不可用</span>"
    : '<span class="badge b-stopped">0 个</span>'
  const toolbar = document.getElementById("dead-toolbar")
  if (toolbar) toolbar.style.display = dead.length ? "flex" : "none"
  if (!dead.length) { el.textContent = "无不可用出口。"; return }
  el.innerHTML = dead.map((e, i) => {
    const st = deadHealth[e]
    const isSel = !!deadSel[i]
    let h = ""
    if (st) {
      if (st.ok) h = '<span class="badge b-available" title="' + esc(healthTitle(st, (st.ms || 0) + "ms")) + '">已恢复 ' + st.status + '</span>'
      else if (st.status === 429) h = '<span class="badge b-warn">限流 429</span>'
      else h = '<span class="badge b-invalid">仍不可用</span>'
    } else {
      h = '<span class="badge b-stopped">未探测</span>'
    }
    return '<label class="proxy-item">' +
      '<input type="checkbox" ' + (isSel ? "checked" : "") +
        ' onchange="deadSel[' + i + ']=this.checked;updateDeadSelCount()">' +
      '<code title="' + esc(e) + '">' + esc(e.indexOf("//") >= 0 ? e.slice(e.indexOf("//") + 2) : e) + '</code>' +
      h +
      '<button class="small" onclick="moveToLadderFromDead(' + i + ')">→ 梯子池</button>' +
      '<button class="small" onclick="delDead(' + i + ')">删除</button>' +
      '</label>'
  }).join("")
  updateDeadSelCount()
}
function updateDeadSelCount() {
  const c = document.getElementById("dead-selcount")
  if (c) c.textContent = Object.keys(deadSel).filter((k) => deadSel[k]).length
}
function deadSelAllToggle() {
  const allOn = Object.keys(deadSel).some((k) => deadSel[k])
  deadList.forEach((_, i) => { deadSel[i] = !allOn })
  renderDeadList(deadList)
}
function clearDeadSel() {
  deadSel = {}
  renderDeadList(deadList)
}
async function moveToDead(i) {
  // 主池单项 → 不可用池
  const url = currentEgressList[i]
  if (!url) return
  const msg = document.getElementById("egress-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-dead", urls: [url] })
    renderDeadList(r.dead || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已移入不可用池：" + url + "（重启网关后生效，不再参与轮换）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function moveToDeadFromLimited(i) {
  // 限流池单项（探测不可用非 429）→ 不可用池
  const cfg = await api("/api/gateway/config")
  const limited = cfg.limited || []
  const url = limited[i]
  if (!url) return
  const msg = document.getElementById("limited-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-dead", urls: [url] })
    renderDeadList(r.dead || [])
    renderLimitedList(r.limited || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已移入不可用池：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function moveAllDeadFromEgress() {
  // IP 池「一键转移不可用」：把健康检查结果为不可用（非 429）的出口全部移入不可用池
  const msg = document.getElementById("egress-msg")
  const urls = currentEgressList.filter((u) => {
    const st = egressHealth[u]
    return st && !st.ok && st.status !== 429
  })
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "没有探测为「不可用」的出口（先点「检查出口」，非 429 失败项才会被转移）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-dead", urls })
    renderDeadList(r.dead || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已转移 " + (r.moved || []).length + " 个不可用出口到不可用池：" + (r.moved || []).join(", ")
  } catch (e) { msg.className = "msg err"; msg.textContent = "转移失败：" + e.message }
}
async function pruneEgress() {
  // IP 池「一键整理」：把健康检查结果分类——429 被限流 → 限流池、不可用（非 429）→ 不可用池，
  // 主池只保留健康项；未探测项跳过不转移（等先跑「检查所有 IP 健康度」）。复用 move-to-dead/move-to-limited 各一次。
  const msg = document.getElementById("egress-msg")
  if (!currentEgressList.length) { msg.className = "msg err"; msg.textContent = "主池为空，无需整理"; return }
  const classified = currentEgressList.filter((u) => egressHealth[u])
  if (!classified.length) {
    msg.className = "msg err"
    msg.textContent = "还没有健康检查数据（先点「检查所有 IP 健康度」再整理）"
    return
  }
  const limitedUrls = []
  const deadUrls = []
  const unknown = []
  for (const u of currentEgressList) {
    const st = egressHealth[u]
    if (!st) { unknown.push(u); continue }
    if (st.ok) continue
    if (st.status === 429) limitedUrls.push(u)
    else deadUrls.push(u)
  }
  if (!limitedUrls.length && !deadUrls.length) {
    msg.className = "msg"
    msg.textContent = "已整理：主池 " + currentEgressList.length + " 个出口全部健康，无需转移"
    return
  }
  try {
    let toLimited = 0
    let toDead = 0
    let deadAfter = []
    let limitedAfter = []
    if (deadUrls.length) {
      const r = await api("/api/gateway/egress", { action: "move-to-dead", urls: deadUrls })
      toDead = (r.moved || []).length
      deadAfter = r.dead || []
    }
    if (limitedUrls.length) {
      const r2 = await api("/api/gateway/egress", { action: "move-to-limited", urls: limitedUrls })
      toLimited = (r2.moved || []).length
      limitedAfter = r2.limited || []
    }
    renderDeadList(deadAfter)
    renderLimitedList(limitedAfter)
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    const left = (c.egress || []).length
    let hint = ""
    if (unknown.length) hint = "（" + unknown.length + " 项未探测已跳过）"
    msg.className = "msg"
    msg.textContent = "已整理：" + toLimited + " 移入限流池，" + toDead + " 移入不可用池，主池剩 " + left + " 可用" + hint
  } catch (e) { msg.className = "msg err"; msg.textContent = "整理失败：" + e.message }
}
async function moveAllDeadFromLimited() {
  // 限流池「一键转移不可用」：把探测为不可用（非 429）的出口全部移入不可用池
  const msg = document.getElementById("limited-msg")
  const cfg = await api("/api/gateway/config")
  const limited = cfg.limited || []
  const urls = limited.filter((u) => {
    const st = limitedHealth[u]
    return st && !st.ok && st.status !== 429
  })
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "没有探测为「不可用」的出口（先点「健康检查」，非 429 失败项才会被转移）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-dead", urls })
    renderDeadList(r.dead || [])
    renderLimitedList(r.limited || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已转移 " + (r.moved || []).length + " 个不可用出口到不可用池"
  } catch (e) { msg.className = "msg err"; msg.textContent = "转移失败：" + e.message }
}
async function checkDeadHealth(progressMsg) {
  const msg = progressMsg || document.getElementById("dead-msg")
  const btn = document.getElementById("dead-check-btn")
  if (btn) { btn.textContent = "检查中…"; btn.disabled = true }
  try {
    const cfg = await api("/api/gateway/config")
    const dead = cfg.dead || []
    if (!dead.length) { msg.className = "msg"; msg.textContent = "不可用池为空"; return }
    deadHealth = {}
    let done = 0
    for (const url of dead) {
      const r = await api("/api/gateway/egress/health", { url })
      const got = (r.egress || [])[0]
      if (got) deadHealth[url] = { ok: got.ok, status: got.status, ms: got.ms, error: got.error }
      done++
      msg.className = "msg"
      msg.textContent = "不可用池检查中 " + done + "/" + dead.length + "…"
      renderDeadList(dead)
    }
    const restored = Object.keys(deadHealth).filter((u) => deadHealth[u] && deadHealth[u].ok).length
    msg.className = "msg"
    msg.textContent = "检查完成：不可用池 " + done + " 项，" + (dead.length - restored) + " 个仍不可用，" + restored + " 个已恢复（勾选可移回 IP 池）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "检查失败：" + e.message }
  finally { if (btn) { btn.textContent = "健康检查"; btn.disabled = false } }
}
async function restoreSelectedDead() {
  const cfg = await api("/api/gateway/config")
  const dead = cfg.dead || []
  const urls = dead.filter((_, i) => deadSel[i])
  const msg = document.getElementById("dead-msg")
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "未勾选任何出口（先健康检查，勾选已恢复的）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "restore-dead", urls })
    deadSel = {}
    deadHealth = {}
    renderDeadList(r.dead || [])
    const c = await api("/api/gateway/config")
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    msg.className = "msg"
    msg.textContent = "已移回 IP 池：" + (r.restored || []).join(", ") + "（重启网关后生效）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "移回失败：" + e.message }
}
async function delDead(i) {
  const cfg = await api("/api/gateway/config")
  const dead = cfg.dead || []
  const target = dead[i]
  if (!target) return
  const msg = document.getElementById("dead-msg")
  try {
    const after = dead.filter((_, ix) => ix !== i)
    await api("/api/gateway/egress", { action: "set-dead", list: after })
    if (deadHealth[target]) delete deadHealth[target]
    renderDeadList(after)
    msg.className = "msg"; msg.textContent = "已删除不可用出口：" + target
  } catch (e) { msg.className = "msg err"; msg.textContent = "删除失败：" + e.message }
}
async function addEgress() {
  const input = document.getElementById("egress-input")
  const url = (input.value || "").trim()
  const msg = document.getElementById("egress-msg")
  if (!url) { msg.className = "msg err"; msg.textContent = "请输入出口（direct 或 socks5://host:port）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "add", url })
    input.value = ""
    renderEgressList(r.egress || [], (r.egress || []).length >= 2)
    msg.className = "msg"; msg.textContent = "已添加出口（重启网关后生效）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "添加失败：" + e.message }
}
async function delEgress(i) {
  const msg = document.getElementById("egress-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "del", index: i })
    renderEgressList(r.egress || [], (r.egress || []).length >= 2)
    msg.className = "msg"; msg.textContent = "已删除出口（重启网关后生效）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "删除失败：" + e.message }
}
async function clearEgress() {
  const msg = document.getElementById("egress-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "clear" })
    renderEgressList(r.egress || [], false)
    msg.className = "msg"; msg.textContent = "已清空出口池（重启网关后生效）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "清空失败：" + e.message }
}
async function toggleIpRotation() {
  const msg = document.getElementById("egress-msg")
  const btn = document.getElementById("ip-rotation-btn")
  const old = btn.textContent
  try {
    const r = await api("/api/gateway/egress", { action: "toggle" })
    ipRotationOn = !!r.ipRotation
    renderEgressList(r.egress || [], r.egress && r.egress.length >= 2, ipRotationOn)
    msg.className = "msg"
    msg.textContent = ipRotationOn ? "IP 轮换已开启（即时生效）" : "IP 轮换已关闭，所有请求走本地直连（即时生效）"
  } catch (e) {
    msg.className = "msg err"; msg.textContent = "切换失败：" + e.message
    btn.textContent = old
  }
}
function renderAutoRotateBtn(on) {
  autoRotateOn = on
  const btn = document.getElementById("auto-rotate-btn")
  if (!btn) return
  btn.textContent = on ? "开启" : "关闭"
  btn.className = on ? "primary" : ""
}
async function toggleAutoRotate() {
  const msg = document.getElementById("plan-msg")
  const btn = document.getElementById("auto-rotate-btn")
  const newOn = !autoRotateOn // 翻转当前态
  const oldText = btn.textContent
  try {
    const r = await api("/api/gateway/config", { auto_rotate_keys: newOn })
    msg.className = "msg"
    if (r.needsRestart) {
      const rr = await api("/api/gateway/restart", {})
      msg.textContent = rr.ok
        ? "网关 key 自动轮换已" + (newOn ? "开启" : "关闭") + "，并已重启网关"
        : "配置已保存，但重启失败：" + (rr.output || "")
      msg.className = rr.ok ? "msg" : "msg err"
    } else {
      msg.textContent = "网关 key 自动轮换已" + (newOn ? "开启" : "关闭") + "（即时生效）"
    }
    renderAutoRotateBtn(newOn)
    refreshGateway(); refreshGatewayConfig()
  } catch (e) { btn.textContent = oldText; msg.className = "msg err"; msg.textContent = "切换失败：" + e.message }
}
var proxyCandidates = [] // Webshare 导入候选缓存：{url, ok, ms, err, inPool}
var proxySel = {} // 勾选状态：{ index: true }
async function fetchWebshareProxies() {
  const btn = document.getElementById("proxy-fetch-btn")
  const msg = document.getElementById("proxy-msg")
  const mode = document.getElementById("proxy-mode").value
  const value = document.getElementById("proxy-input").value.trim()
  if (!value) { msg.className = "msg err"; msg.textContent = "先粘贴 Token Key 或下载链接"; return }
  const old = btn.textContent
  btn.textContent = "导入中…（拉取 + 连通验证）"; btn.disabled = true
  try {
    const r = await api("/api/gateway/proxies/webshare", { mode, value, limit: 200, timeout: 5000 })
    if (!r.ok) throw new Error(r.error || "导入失败")
    // 拉当前池用于标记已存在项（去重灰置）
    let inPool = new Set()
    try { inPool = new Set((await api("/api/gateway/config")).egress || []) } catch {}
    proxyCandidates = (r.candidates || []).map((c) => Object.assign({}, c, { inPool: inPool.has(c.url) }))
    // 默认自动勾选所有「有效且不在池中」的项
    proxySel = {}
    proxyCandidates.forEach((c, i) => { if (c.ok && !c.inPool) proxySel[i] = true })
    renderProxyList()
    const good = proxyCandidates.filter((c) => c.ok).length
    msg.className = "msg"
    msg.textContent = "共 " + r.total + " 个代理，验证 " + r.checked + " 个，可用 " + good + " 个（已自动勾选可添加项）"
  } catch (e) {
    msg.className = "msg err"; msg.textContent = "导入失败：" + e.message
  }
  btn.textContent = old; btn.disabled = false
}
function renderProxyList() {
  const el = document.getElementById("proxy-list")
  const badge = document.getElementById("proxy-badge")
  const good = proxyCandidates.filter((c) => c.ok).length
  const addable = proxyCandidates.filter((c) => c.ok && !c.inPool).length
  badge.innerHTML = proxyCandidates.length
    ? '<span class="badge b-' + (good ? "available" : "stopped") + '">' + good + "/" + proxyCandidates.length + " 可用</span>"
    : ""
  const toolbar = document.getElementById("proxy-toolbar")
  if (toolbar) toolbar.style.display = proxyCandidates.length ? "flex" : "none"
  if (!proxyCandidates.length) { el.textContent = "未导入。粘贴 Token Key 或下载链接，点「导入」拉取 Webshare 代理。"; return }
  el.innerHTML = proxyCandidates.map((c, i) => {
    const isSel = !!proxySel[i]
    const disable = !c.ok || c.inPool
    const cls = (c.inPool ? "inpool" : "") + (c.ok ? "" : " off")
    return '<label class="proxy-item ' + cls + '">' +
      '<input type="checkbox" ' + (isSel ? "checked" : "") + (disable ? " disabled" : "") +
        ' onchange="proxySel[' + i + ']=this.checked;updateProxySelCount()">' +
      '<code title="' + esc(c.url) + '">' + esc(c.url.indexOf("//") >= 0 ? c.url.slice(c.url.indexOf("//") + 2) : c.url) + '</code>' +
      (c.ok
        ? '<span class="pm-ms">' + (c.ms != null ? c.ms + "ms" : "-") + '</span>'
        : '<span class="pm-err" title="' + esc(c.err || "") + '">' + esc(c.err || "") + '</span>') +
      (c.inPool ? '<span class="badge b-stopped">池中</span>' : (c.ok ? '<span class="badge b-available">可用</span>' : "")) +
      '</label>'
  }).join("")
  updateProxySelCount()
  refreshEgressBadgeAfterToolbar()
}
function updateProxySelCount() {
  const el = document.getElementById("proxy-selcount")
  if (el) el.textContent = Object.keys(proxySel).filter((k) => proxySel[k]).length
}
function toggleProxyAll() {
  const allOn = Object.keys(proxySel).some((k) => proxySel[k])
  proxyCandidates.forEach((c, i) => { proxySel[i] = (!allOn && c.ok && !c.inPool) ? true : false })
  renderProxyList()
}
function clearProxySel() {
  proxySel = {}
  renderProxyList()
}
function refreshEgressBadgeAfterToolbar() {
  const hint = document.getElementById("proxy-toolbar-hint")
  if (!hint) return
  const pool = proxyCandidates.filter((c) => c.inPool).length
  hint.textContent = pool > 0 ? "已在池中 " + pool + " 项已灰置（去重）" : ""
}
async function addSelectedProxies() {
  const msg = document.getElementById("proxy-msg")
  const urls = proxyCandidates.filter((c, i) => proxySel[i]).map((c) => c.url)
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "未勾选任何出口"; return }
  const btn = document.getElementById("proxy-addsel-btn")
  const old = btn.textContent
  btn.disabled = true
  try {
    const r = await api("/api/gateway/egress", { action: "bulk-add", urls })
    if (!r.ok) throw new Error(r.error || "批量添加失败")
    msg.className = "msg"
    msg.textContent = "已加入 " + (r.added || []).length + " 个出口（" +
      (r.added || []).join(", ") + "）；重复/非法 " + (r.skipped || []).length + " 个已跳过。重启网关后生效。"
    // 刷新 IP 池卡
    const cfg = await api("/api/gateway/config")
    renderEgressList(cfg.egress || [], !!cfg.egressEnabled, !!cfg.ipRotation)
    // 候选标记已入池并清空勾选
    const addedSet = new Set(r.added || [])
    proxyCandidates.forEach((c, i) => { if (addedSet.has(c.url)) { c.inPool = true; proxySel[i] = false } })
    renderProxyList()
  } catch (e) {
    msg.className = "msg err"; msg.textContent = "添加失败：" + e.message
  }
  btn.disabled = false; btn.textContent = old
}
async function refreshPlans() {
  try {
    const p = await api("/api/gateway/plans")
    const meta = (p.plans || []).map(x =>
      x.name + "：" + x.defaultModel + "（" + x.upstreamBase + "，内置 " + x.modelCount + " 模型）").join("  |  ")
    document.getElementById("plan-meta").textContent = meta || "暂无套餐数据"
  } catch (e) { document.getElementById("plan-meta").textContent = "套餐信息获取失败：" + e.message }
}
var ladderState = { enabled: false, port: 10880, mode: "rotate", fixed: null, running: false, egress: [] }
var ladderEgressHealth = {} // 梯子池健康检查结果缓存：{ [url]: {ok,status,ms,error} }
var ladderEgressSel = {} // 梯子池勾选状态：{ index: true }
var ladderEgressList = [] // 当前渲染的梯子池列表
function renderLadderState() {
  const el = document.getElementById("ladder-state")
  if (!el) return
  el.innerHTML = ladderState.running && ladderState.enabled
    ? '<span class="badge b-running">运行中 · 127.0.0.1:' + ladderState.port + '</span>'
    : ladderState.enabled
      ? '<span class="badge b-stopped">已启用未启动</span>'
      : '<span class="badge b-stopped">已停用</span>'
  const badge = document.getElementById("ladder-badge")
  if (badge) badge.innerHTML = ladderState.enabled
    ? '<span class="badge b-running">启用</span>'
    : '<span class="badge b-stopped">停用</span>'
  const btn = document.getElementById("ladder-toggle-btn")
  if (btn) {
    btn.textContent = ladderState.enabled ? "停用" : "启用"
    btn.className = ladderState.enabled ? "danger" : "primary"
  }
  const hint = document.getElementById("ladder-port-hint")
  if (hint) hint.textContent = ladderState.port
  const portEl = document.getElementById("ladder-port")
  if (portEl) portEl.value = ladderState.port
  const modeEl = document.getElementById("ladder-mode")
  if (modeEl) modeEl.value = ladderState.mode
  const fixedRow = document.getElementById("ladder-fixed-row")
  if (fixedRow) fixedRow.style.display = ladderState.mode === "fixed" ? "flex" : "none"
  const fixedEl = document.getElementById("ladder-fixed")
  if (fixedEl && fixedEl.options.length === 0) {
    const pools = ladderEgressList.concat(currentEgressList, (deadList || []))
    ;(new Set(pools.concat([ladderState.fixed].filter(Boolean)))).forEach((u) => {
      if (u && u !== "direct") fixedEl.add(new Option(shortUrl(u), u, u === ladderState.fixed, u === ladderState.fixed))
    })
  }
  if (fixedEl && ladderState.fixed && ![...fixedEl.options].some((o) => o.value === ladderState.fixed)) {
    fixedEl.add(new Option(shortUrl(ladderState.fixed), ladderState.fixed, true, true))
  }
  if (fixedEl) fixedEl.value = ladderState.fixed || fixedEl.options[0]?.value || ""
  renderLadderUsage()
}
function shortUrl(u) {
  return u && u.indexOf("//") >= 0 ? u.slice(u.indexOf("//") + 2) : u
}
/** 健康徽标 title：附加探测时间（来自本地缓存 checkedAt；无则省略）。 */
function healthTitle(st, msText) {
  let t = msText || (st && st.ms != null ? st.ms + "ms" : "")
  if (st && st.checkedAt) {
    const hm = String(st.checkedAt).replace("T", " ").slice(5, 16) // MM-DD HH:MM（UTC）
    t += t ? " · 探测 " + hm : "探测 " + hm
  }
  return t || ""
}
function renderLadderUsage() {
  const el = document.getElementById("ladder-usage-text")
  if (!el) return
  const addr = "socks5://127.0.0.1:" + ladderState.port
  el.textContent =
    "一、系统全局代理（macOS 系统设置 → 网络 → 高级 → 代理：开启 SOCKS 代理）：\\n" +
    "   服务器: 127.0.0.1   端口: " + ladderState.port + "\\n\\n" +
    "二、命令行临时使用（curl）：\\n" +
    "   curl --proxy " + addr + " https://www.google.com\\n\\n" +
    "三、git 走梯子（拉取 GitHub 等）：\\n" +
    "   git config --global http.proxy " + addr + "\\n" +
    "   git config --global https.proxy " + addr + "\\n" +
    "   （取消：git config --global --unset http.proxy / --unset https.proxy）\\n\\n" +
    "四、浏览器扩展（SwitchyOmega 等）新建代理：\\n" +
    "   协议 SOCKS5 / 服务器 127.0.0.1 / 端口 " + ladderState.port + "\\n\\n" +
    "五、其它应用（终端代理 / 下载工具）：把 SOCKS5 代理指到 127.0.0.1:" + ladderState.port + " 即可。\\n\\n" +
    "模式说明：\\n" +
    "   · 轮换模式 —— 每个新连接自动换一个出口 IP（出口池 ≥2 项才有效），适合被按 IP 限流的场景\\n" +
    "   · 固定模式 —— 始终走你指定的那个出口（适合需要固定出口 IP 的场景）\\n\\n" +
    "注意：梯子走的是上方「IP 池（轮换出口）」的 socks5 出口；若池为空或已停用则退化为本地直连。"
}
async function refreshLadder() {
  try {
    const cfg = (await api("/api/gateway/config")) || {}
    ladderState.enabled = !!(cfg.ladder && cfg.ladder.enabled)
    ladderState.port = (cfg.ladder && cfg.ladder.port) || 10880
    ladderState.mode = (cfg.ladder && cfg.ladder.mode) || "rotate"
    ladderState.fixed = (cfg.ladder && cfg.ladder.fixed) || null
    ladderState.egress = (cfg.ladder && cfg.ladder.egress) || (cfg.ladderEgress) || []
    const st = await api("/api/gateway/ladder")
    if (st && st.ok !== false) { ladderState.running = !!st.running; if (st.egressCount != null) ladderState.egressCount = st.egressCount }
    renderLadderState()
    renderLadderEgress()
  } catch (e) {
    const msg = document.getElementById("ladder-msg")
    if (msg) { msg.className = "msg err"; msg.textContent = "梯子状态读取失败：" + e.message }
  }
}
function ladderCollectConfig() {
  const port = Number(document.getElementById("ladder-port").value)
  const mode = document.getElementById("ladder-mode").value
  const fixed = mode === "fixed" ? document.getElementById("ladder-fixed").value : null
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("端口非法（1-65535）")
  if (mode === "fixed" && !fixed) throw new Error("固定模式必须选择一个出口")
  return { enabled: ladderState.enabled, port, mode, fixed, egress: ladderEgressList }
}
async function ladderSave() {
  const msg = document.getElementById("ladder-msg")
  try {
    const cfg = ladderCollectConfig()
    msg.className = "msg"
    msg.textContent = "保存并应用梯子…"
    const r = await api("/api/gateway/ladder", { action: "set", ladder: cfg })
    if (r.ok === false) throw new Error(r.error || "应用失败")
    ladderState.enabled = cfg.enabled
    ladderState.port = cfg.port
    ladderState.mode = cfg.mode
    ladderState.fixed = cfg.fixed
    ladderState.running = !!r.running
    renderLadderState()
    msg.textContent = r.running
      ? "梯子已启动：" + (r.port || cfg.port) + "（即时生效，无需重启网关）"
      : "梯子已停用（配置已保存）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "保存失败：" + e.message }
}
async function ladderToggle() {
  const msg = document.getElementById("ladder-msg")
  try {
    // 切换 enabled 并保存应用
    const cfg = ladderCollectConfig()
    cfg.enabled = !ladderState.enabled
    msg.className = "msg"
    msg.textContent = "正在切换梯子…"
    const r = await api("/api/gateway/ladder", { action: "set", ladder: cfg })
    if (r.ok === false) throw new Error(r.error || "应用失败")
    ladderState.enabled = cfg.enabled
    ladderState.port = cfg.port
    ladderState.mode = cfg.mode
    ladderState.fixed = cfg.fixed
    ladderState.running = !!r.running
    renderLadderState()
    msg.textContent = r.running
      ? "梯子已启动（127.0.0.1:" + (r.port || cfg.port) + "）"
      : "梯子已停用"
  } catch (e) { msg.className = "msg err"; msg.textContent = "切换失败：" + e.message }
}

/* ================= 梯子专用出口池（ladder.egress · 第四池） ================= */
function renderLadderEgress() {
  const el = document.getElementById("ladder-pool-list")
  const badge = document.getElementById("ladder-pool-badge")
  if (!el || !badge) return
  const list = ladderState.egress || []
  ladderEgressList = list
  badge.innerHTML = list.length
    ? '<span class="badge b-available">' + list.length + " 个专用出口</span>"
    : '<span class="badge b-stopped">0 个（回退主池/直连）</span>'
  const toolbar = document.getElementById("ladder-pool-toolbar")
  if (toolbar) toolbar.style.display = list.length ? "flex" : "none"
  if (!list.length) { el.textContent = "未配置梯子专用出口（梯子将回退主 IP 池或本地直连）。"; return }
  el.innerHTML = list.map((e, i) => {
    const st = ladderEgressHealth[e]
    const isSel = !!ladderEgressSel[i]
    let h = ""
    if (st) {
      if (st.ok) h = '<span class="badge b-available" title="' + esc(healthTitle(st, (st.ms || 0) + "ms")) + '">健康 ' + (st.status || "") + '</span>'
      else if (st.status === 429) h = '<span class="badge b-warn">限流 429</span>'
      else h = '<span class="badge b-invalid">不可用</span>'
    } else {
      h = '<span class="badge b-stopped">未探测</span>'
    }
    return '<label class="proxy-item">' +
      '<input type="checkbox" ' + (isSel ? "checked" : "") +
        ' onchange="ladderEgressSel[' + i + ']=this.checked;updateLadderEgressSelCount()">' +
      '<code title="' + esc(e) + '">' + esc(shortUrl(e)) + '</code>' +
      h +
      (st && st.status === 429 ? '<button class="small" onclick="moveLadderToLimited(' + i + ')">→ 限流池</button>' : "") +
      (st && !st.ok && st.status !== 429 ? '<button class="small" onclick="moveLadderToDead(' + i + ')">→ 不可用池</button>' : "") +
      '<button class="small" onclick="delLadderEgress(' + i + ')">删除</button>' +
      '</label>'
  }).join("")
  updateLadderEgressSelCount()
}
function updateLadderEgressSelCount() {
  const c = document.getElementById("ladder-pool-selcount")
  if (c) c.textContent = Object.keys(ladderEgressSel).filter((k) => ladderEgressSel[k]).length
}
function ladderPoolSelAllToggle() {
  const allOn = Object.keys(ladderEgressSel).some((k) => ladderEgressSel[k])
  ladderEgressList.forEach((_, i) => { ladderEgressSel[i] = !allOn })
  renderLadderEgress()
}
function clearLadderPoolSel() {
  ladderEgressSel = {}
  renderLadderEgress()
}
async function addLadderEgress() {
  const input = document.getElementById("ladder-pool-input")
  const url = (input.value || "").trim()
  const msg = document.getElementById("ladder-pool-msg")
  if (!url) { msg.className = "msg err"; msg.textContent = "请输入出口（socks5://host:port）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "add-ladder", url })
    input.value = ""
    ladderState.egress = r.egress || []
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已添加梯子池出口（即时生效，无需重启）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "添加失败：" + e.message }
}
async function delLadderEgress(i) {
  const url = ladderEgressList[i]
  if (url === undefined) return
  const msg = document.getElementById("ladder-pool-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "set-ladder", list: ladderEgressList.filter((_, ix) => ix !== i) })
    ladderState.egress = r.egress || []
    if (ladderEgressHealth[url]) delete ladderEgressHealth[url]
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已删除梯子池出口：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "删除失败：" + e.message }
}
async function checkLadderPoolHealth() {
  const msg = document.getElementById("ladder-pool-msg")
  const btn = document.getElementById("ladder-pool-check-btn")
  if (btn) { btn.textContent = "检查中…"; btn.disabled = true }
  try {
    const list = ladderEgressList
    if (!list.length) { msg.className = "msg"; msg.textContent = "梯子池为空（先添加出口）"; return }
    ladderEgressHealth = {}
    let done = 0
    for (const url of list) {
      const r = await api("/api/gateway/egress/health", { url })
      const got = (r.egress || [])[0]
      if (got) ladderEgressHealth[url] = { ok: got.ok, status: got.status, ms: got.ms, error: got.error }
      done++
    }
    renderLadderEgress()
    const okCount = Object.keys(ladderEgressHealth).filter((u) => ladderEgressHealth[u].ok).length
    const limCount = Object.keys(ladderEgressHealth).filter((u) => ladderEgressHealth[u].status === 429).length
    const deadCount = done - okCount - limCount
    msg.className = "msg"
    msg.textContent = "检查完成：" + done + " 项，" + okCount + " 个可用，" + limCount + " 个限流，" + deadCount + " 个不可用"
  } catch (e) { msg.className = "msg err"; msg.textContent = "检查失败：" + e.message }
  finally { if (btn) { btn.textContent = "健康检查"; btn.disabled = false } }
}
async function moveLadderToLimited(i) {
  const url = ladderEgressList[i]
  if (!url) return
  const msg = document.getElementById("ladder-pool-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "ladder-to-limited", urls: [url] })
    ladderState.egress = r.ladderEgress || []
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已移入限流池：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function moveLadderToDead(i) {
  const url = ladderEgressList[i]
  if (!url) return
  const msg = document.getElementById("ladder-pool-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "ladder-to-dead", urls: [url] })
    ladderState.egress = r.ladderEgress || []
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已移入不可用池：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function moveAllLadderDead() {
  const msg = document.getElementById("ladder-pool-msg")
  const urls = ladderEgressList.filter((u) => {
    const st = ladderEgressHealth[u]
    return st && !st.ok && st.status !== 429
  })
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "没有探测为「不可用」的出口（先点「健康检查」，非 429 失败项才会被转移）"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "ladder-to-dead", urls })
    ladderState.egress = r.ladderEgress || []
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"
    msg.textContent = "已转移 " + (r.moved || []).length + " 个不可用出口到不可用池"
  } catch (e) { msg.className = "msg err"; msg.textContent = "转移失败：" + e.message }
}
async function restoreSelectedLadder() {
  const msg = document.getElementById("ladder-pool-msg")
  const urls = ladderEgressList.filter((_, i) => ladderEgressSel[i])
  if (!urls.length) { msg.className = "msg err"; msg.textContent = "未勾选任何出口"; return }
  try {
    const r = await api("/api/gateway/egress", { action: "ladder-to-egress", urls })
    ladderEgressSel = {}
    ladderEgressHealth = {}
    ladderState.egress = r.ladderEgress || []
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"
    msg.textContent = "已移回主 IP 池：" + (r.restored || []).join(", ") + "（即时生效）"
  } catch (e) { msg.className = "msg err"; msg.textContent = "移回失败：" + e.message }
}
async function moveToLadderFromEgress(i) {
  const url = currentEgressList[i]
  if (!url) return
  const msg = document.getElementById("egress-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-ladder", urls: [url] })
    ladderState.egress = r.ladderEgress || []
    if (r.egress) renderEgressList(r.egress, (r.egress || []).length >= 2, ipRotationOn)
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已移入梯子池：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function moveToLadderFromLimited(i) {
  const cfg = await api("/api/gateway/config")
  const url = (cfg.limited || [])[i]
  if (!url) return
  const msg = document.getElementById("limited-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-ladder", urls: [url] })
    ladderState.egress = r.ladderEgress || []
    if (r.limited) renderLimitedList(r.limited)
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已移入梯子池：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function moveToLadderFromDead(i) {
  const cfg = await api("/api/gateway/config")
  const url = (cfg.dead || [])[i]
  if (!url) return
  const msg = document.getElementById("dead-msg")
  try {
    const r = await api("/api/gateway/egress", { action: "move-to-ladder", urls: [url] })
    ladderState.egress = r.ladderEgress || []
    if (r.dead) renderDeadList(r.dead)
    renderLadderEgress(); renderLadderState()
    msg.className = "msg"; msg.textContent = "已移入梯子池：" + url
  } catch (e) { msg.className = "msg err"; msg.textContent = "移入失败：" + e.message }
}
async function ladderSurfCheck() {
  const resultEl = document.getElementById("ladder-surf-result")
  const msg = document.getElementById("ladder-msg")
  if (resultEl) resultEl.textContent = "科学上网筛选进行中（对每个 socks5 出口测 google/youtube 隧道 + 出口归属，请稍候）…"
  try {
    // 梯子池非空则筛梯子池（反映梯子真实出口），否则筛主池
    const urls = ladderEgressList.length ? { urls: ladderEgressList } : {}
    const r = await api("/api/gateway/ladder/check", urls)
    if (r.ok === false) throw new Error(r.error || "筛选失败")
    msg.className = "msg"; msg.textContent = "筛选完成（" + new Date(r.checkedAt).toLocaleTimeString() + "）"
    if (!resultEl) return
    const list = r.egress || []
    if (!list.length) { resultEl.textContent = "无 socks5 出口可测（先在 IP 池添加出口）。"; return }
    resultEl.innerHTML = list.map((x) =>
      '<div class="proxy-item" style="align-items:center;display:flex;gap:8px;border-bottom:1px solid var(--bd-2);padding:3px 0">' +
      '<code style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(x.url) + '">' + esc(shortUrl(x.url)) + '</code>' +
      (x.ok
        ? '<span class="badge b-available">可科学上网 ' + x.ms + "ms</span>"
        : '<span class="badge b-invalid">不可用</span>') +
      '<span class="muted" style="white-space:nowrap">google ' + (x.google ? '<span style="color:var(--ok,#34d399)">✓</span>' : '<span style="color:var(--err,#f87171)">✗</span>') +
      ' youtube ' + (x.youtube ? '<span style="color:var(--ok,#34d399)">✓</span>' : '<span style="color:var(--err,#f87171)">✗</span>') + '</span>' +
      (x.exitIp ? '<span class="badge b-go" title="' + esc(x.org || "") + '">' + esc(x.country + (x.city ? "/" + x.city : "")) + " · " + esc(x.exitIp) + '</span>' : '') +
      (x.error ? '<span class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px" title="' + esc(x.error) + '">' + esc(x.error) + "</span>" : "") +
      '</div>'
    ).join("")
  } catch (e) {
    msg.className = "msg err"; msg.textContent = "筛选失败：" + e.message
    if (resultEl) resultEl.textContent = ""
  }
}
async function refreshGatewayConfig() {
  try {
    const c = await api("/api/gateway/config")
    document.getElementById("plan-go").checked = c.plan === "go"
    document.getElementById("plan-zen").checked = c.plan === "zen"
    renderAutoRotateBtn(!!c.autoRotateKeys)
    tokenBadge(!!c.authEnabled)
    renderTokenList(c.tokens || []) // 多 key 掩码列表（明文仅本会话生成/编辑后持有，GET 永不明文）
    egressActiveList = c.egressActive || [] // 轮换子集（[]=全池）
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation) // IP 轮换出口池 + 启用徽标
    renderLimitedList(c.limited || []) // 限流池
    renderDeadList(c.dead || []) // 不可用池（默认折叠，badge 显示数量）
    await loadEgressHealthCache(c) // 回显上次健康检查结果（不用重探；填充后重渲染三池 + 梯子池）
    renderEgressList(c.egress || [], !!c.egressEnabled, !!c.ipRotation)
    renderLimitedList(c.limited || [])
    renderDeadList(c.dead || [])
    renderLadderEgress()
  } catch (e) { showTokenMsg("配置读取失败：" + e.message, true) }
  refreshLadder() // 梯子状态（异步，不阻塞配置渲染）
}
async function loadEgressHealthCache(c) {
  // 读取本地缓存的健康检查结果（上次探测），按各池成员 url 填充对应 health map → 刷新后徽标仍在。
  try {
    const r = await api("/api/gateway/egress/health/cache")
    if (!r || !r.cache) return
    // 只保留仍在对应池里的 url（避免过期项残留徽标）
    const poolUrls = new Set((c?.egress || []).concat(c?.limited || []).concat(c?.dead || []).concat((c?.ladder && c.ladder.egress) || []))
    egressHealth = {}; limitedHealth = {}; deadHealth = {}; ladderEgressHealth = {}
    for (const url of Object.keys(r.cache)) {
      if (!poolUrls.has(url)) continue
      const entry = r.cache[url]
      if ((c?.egress || []).includes(url)) egressHealth[url] = entry
      if ((c?.limited || []).includes(url)) limitedHealth[url] = entry
      if ((c?.dead || []).includes(url)) deadHealth[url] = entry
      if (c?.ladder && (c.ladder.egress || []).includes(url)) ladderEgressHealth[url] = entry
    }
  } catch (e) { /* 缓存读失败静默（不阻塞页面） */ }
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
  try {
    // 后端生成（sk- + 24 字节 hex），只在 gen 响应中回一次明文；追加进 tokens[] 多 key 列表
    const r = await api("/api/gateway/token", { action: "gen" })
    gwToken.plain = r.plain || ""
    tokenBadge(true)
    showTokenMsg(
      (r.needsRestart ? "已生成新 Key 并保存（重启网关后生效）" : "已生成新 Key") +
        (r.plain ? "，明文仅本次会话可复制（列表显示掩码）。" : "。"),
    )
    refreshGatewayConfig()
  } catch (e) { showTokenMsg(e.message, true) }
}
async function setGatewayToken() {
  const v = prompt("输入自定义网关访问 token（建议以 sk- 开头；留空取消）", "")
  if (v === null) return
  const token = v.trim()
  if (!token) return showTokenMsg("已取消（token 为空）", true)
  try {
    const r = await api("/api/gateway/config", { token })
    gwToken.plain = token
    tokenBadge(true)
    showTokenMsg(r.needsRestart ? "已设置单个 token（重启网关后生效）" : "已设置成功")
    refreshGatewayConfig()
  } catch (e) { showTokenMsg(e.message, true) }
}
async function clearGatewayToken() {
  if (!confirm("确定清除网关全部访问 token（关闭鉴权）？清除后任何本机进程都可直连网关。")) return
  try {
    const r = await api("/api/gateway/token", { action: "clear" })
    gwToken.plain = ""
    tokenBadge(false)
    showTokenMsg(r.needsRestart ? "Token 已全部清除（重启网关后生效）" : "Token 已清除")
    refreshGatewayConfig()
  } catch (e) { showTokenMsg(e.message, true) }
}
/* 删除指定下标的访问 key（后端 /api/gateway/token action=del） */
async function delGatewayToken(i) {
  if (!confirm("删除第 " + (Number(i) + 1) + " 个网关访问 key？")) return
  try {
    const r = await api("/api/gateway/token", { action: "del", index: Number(i) })
    showTokenMsg(r.needsRestart ? "已删除（重启网关后生效）" : "已删除")
    refreshGatewayConfig()
  } catch (e) { showTokenMsg(e.message, true) }
}
/* 复制指定下标的访问 key 明文（列表只显示掩码，点复制走 action=get 取单个明文进剪贴板） */
async function copyGatewayToken(i) {
  try {
    const r = await api("/api/gateway/token", { action: "get", index: Number(i) })
    if (!r.plain) return showTokenMsg("未获取到明文", true)
    await navigator.clipboard.writeText(r.plain)
    showTokenMsg("已复制第 " + (Number(i) + 1) + " 个 Key 到剪贴板")
  } catch (e) { showTokenMsg("复制失败：" + e.message, true) }
}
/* 一次「生成/设置」后明文在本会话持有，一键复制（去「先显示/隐藏」前置步骤） */
async function copySessionPlain() {
  const val = gwToken.plain
  if (!val) return showTokenMsg("当前会话未持有明文（token 由外部设置，服务端只回掩码），请先「生成新 Key」再复制", true)
  try {
    await navigator.clipboard.writeText(val)
    showTokenMsg("已复制到剪贴板")
  } catch (e) { showTokenMsg("复制失败（浏览器剪贴板权限被拒），请手动复制", true) }
}

/* ---- 使用方式卡：示例配置常量 + 一键复制（XSS 安全：纯静态常量 + textContent 填充，无用户可控数据） ---- */
var USAGE_TEXT = {
  curl: "curl http://127.0.0.1:18888/v1/chat/completions -H \\"Content-Type: application/json\\" -H \\"Authorization: Bearer <ZEN_GATEWAY_TOKEN>\\" -d '{\\"model\\":\\"hy3\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"你好\\"}]}'",
  codex: "model_provider = \\"zen\\"\\nmodel = \\"hy3\\"\\nweb_search = \\"disabled\\"  # 必须！否则 codex 会发 web_search 工具触发网关 400\\n\\n[model_providers.zen]\\nname = \\"zen-gateway\\"\\nbase_url = \\"http://127.0.0.1:18888/v1\\"  # 以 /v1 结尾、无尾斜杠\\nenv_key = \\"ZEN_GATEWAY_TOKEN\\"  # 网关未设 token 时不配\\nwire_api = \\"responses\\"",
  claude: "{\\n  \\"env\\": {\\n    \\"ANTHROPIC_BASE_URL\\": \\"http://127.0.0.1:18888\\",\\n    \\"ANTHROPIC_AUTH_TOKEN\\": \\"<ZEN_GATEWAY_TOKEN>\\",\\n    \\"ANTHROPIC_DEFAULT_SONNET_MODEL\\": \\"hy3\\"\\n  }\\n}"
}
function hydrateUsage() {
  for (const k in USAGE_TEXT) {
    const el = document.getElementById("usage-" + k + "-text")
    if (el) el.textContent = USAGE_TEXT[k]
  }
}
/* onClick 入口：复制静态示例（常量为唯一数据源，绝不拼接用户输入） */
function copyUsage(k) {
  if (!USAGE_TEXT[k]) return
  const label = k === "curl" ? "curl 示例" : k === "codex" ? "codex 配置" : "claude 配置"
  copyText(USAGE_TEXT[k], "已复制 " + label)
}
/* 通用复制：navigator.clipboard 优先，权限被拒降级 execCommand，成功/失败均 toast */
async function copyText(txt, okMsg) {
  try {
    await navigator.clipboard.writeText(txt)
    toast(okMsg || "已复制到剪贴板", "success")
    return
  } catch (e) {}
  const ta = document.createElement("textarea")
  ta.value = txt
  ta.style.position = "fixed"; ta.style.left = "-9999px"; ta.style.top = "0"; ta.style.opacity = "0"
  document.body.appendChild(ta)
  ta.select(); ta.setSelectionRange(0, txt.length)
  let ok = false
  try { ok = document.execCommand("copy") } catch (e2) {}
  document.body.removeChild(ta)
  if (ok) toast(okMsg || "已复制到剪贴板", "success")
  else toast("复制失败（浏览器剪贴板权限被拒），请手动复制", "error")
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
hydrateUsage(); refresh(); refreshLog(); refreshStats(); refreshGateway(); refreshGwLog(); switchNav("keys");
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
  setGoCurrent,
  setCooldown,
  setGoCooldown,
  setGatewayCurrent,
  setGatewayCooldown,
  setCooldownWindow,
  setGlobalCooldown,
  parseStatsLog,
  gatewayStatus,
  gatewayManage,
  gatewayLog,
  gatewayUsageTrend,
  gatewayTest,
  gatewayEgressHealthProxy,
  gatewayCtlExists,
  fetchWebshareProxies,
  parseWebshareDownloadText,
  genGatewayToken,
  readGatewayConfig,
  writeGatewayConfig,
  validateEgressItem,
  readEgressHealthCache,
  writeEgressHealthCache,
  EGRESS_HEALTH_FILE,
  maskGatewayToken,
  gatewayConfigPayload,
  gatewayPlansPayload,
  GATEWAY_PLANS,
  handleWeb,
  /* 三域模型（2026-08-17 新增导出，供单测断言） */
  isGoProvider,
  isZenProvider,
  domainCurrent,
  probeKey,
  checkAllKeys,
}