/**
 * go-rotate：opencode-go 多 key 自动轮换插件 + Web 管理界面
 *
 * 功能：
 *   - chat.headers：对 opencode-go 的每次请求注入当前 key 的 Authorization
 *     （已用 spike 验证：该 header 会覆盖 SDK 自带 key，无需重启即可热切换）
 *   - event：监听 session.error，当 opencode-go 配额耗尽 / 401 / 402 / 429 时自动轮换
 *   - 冷却：按滚动窗口让用尽的 key 冷却（默认 300 分钟，可从错误消息解析 reset 时间）
 *   - 持久化：状态写入 go-keys.json，并同步写 auth.json，保证其它路径 / 重启后一致
 *   - Web UI：http://localhost:7793 动态配置 key（只启动一个实例，多 TUI 进程不会重复启动）
 *   - 并发安全：所有配置写入走跨进程文件锁 + 原子写（tmp+rename）
 *
 * 安装：~/.config/opencode/plugins/go-rotate.ts（自动加载）
 * 配置：~/.config/opencode/go-keys.json
 * 日志：/tmp/opencode-go-rotate.log
 * Web： http://localhost:7793
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

const DATA_DIR = path.join(homedir(), ".config", "opencode")
const CONFIG_FILE = path.join(DATA_DIR, "go-keys.json")
const AUTH_FILE = path.join(homedir(), ".local", "share", "opencode", "auth.json")
const LOG_FILE = "/tmp/opencode-go-rotate.log"
const LOCK_FILE = CONFIG_FILE + ".lock"
// 固定端口用于保证"全系统只启动一个 web"（tui-control 占用 7792-7811，故避开）
const WEB_PORT = 8899
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`
const DEFAULT_COOLDOWN_MIN = 300
// 日志轮转：超过该大小即归档，最多保留 RETENTION 份，旧档删除（防止 /tmp 无限增长）
const LOG_MAX_BYTES = 1024 * 1024 // 1MB
const LOG_KEEP = 3
const LOCK_TIMEOUT_MS = 5000
const LOCK_STALE_MS = 15000

type KeyEntry = { name: string; key: string; cooldown_until: string | null }
type Config = {
  provider_id: string
  cooldown_minutes: number
  current: string
  keys: KeyEntry[]
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
    return {
      provider_id: cfg.provider_id ?? "opencode-go",
      cooldown_minutes: cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN,
      current: cfg.current ?? "",
      keys,
    }
  } catch (e) {
    log(`loadConfig error: ${(e as Error).message}`)
    return { provider_id: "opencode-go", cooldown_minutes: DEFAULT_COOLDOWN_MIN, current: "", keys: [] }
  }
}

function saveConfig(cfg: Config) {
  mkdirSync(DATA_DIR, { recursive: true })
  atomicWrite(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

function syncAuth(key: string) {
  const data = existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, "utf8")) : {}
  const auth = data["opencode-go"]
  if (auth && typeof auth === "object") {
    auth.key = key
  } else {
    data["opencode-go"] = { type: "api", key }
  }
  atomicWrite(AUTH_FILE, JSON.stringify(data, null, 2), 0o600)
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

function cooldownUntilDefault(cfg: Config): string {
  return new Date(Date.now() + (cfg.cooldown_minutes ?? DEFAULT_COOLDOWN_MIN) * 60_000).toISOString()
}

/** 从配额错误消息解析 "reset at <time>"，含时区偏移；解析失败返回 null */
function parseResetTime(msg: string): string | null {
  const m = String(msg).match(/reset at\s+(\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}(?:\s*[+-]\d{4})?)/i)
  if (!m) return null
  // 优先带偏移；无偏移则按本地时区解释
  let t = Date.parse(m[1])
  if (Number.isNaN(t) && !/\+|-/.test(m[1].slice(10))) {
    t = Date.parse(m[1].replace(" ", "T"))
  }
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

function isQuotaError(err: any): boolean {
  if (!err) return false
  const data = err.data ?? {}
  const msg = String(data.message ?? "").toLowerCase()
  const status = data.statusCode
  const quotaWords = /quota|insufficient|balance|rate.?limit|usage limit|exceeded/i
  const quotaStatus = status === 401 || status === 402 || status === 429
  return quotaStatus || quotaWords.test(msg)
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
function rotate(errMsg: string): Config {
  return mutateConfig((cfg) => {
    const cur = currentKey(cfg)
    if (cur) {
      cur.cooldown_until = parseResetTime(errMsg) ?? cooldownUntilDefault(cfg)
      log(`⚠️  key "${cur.name}" 配额耗尽，进入冷却 until=${cur.cooldown_until}`)
    }
    const next = pickNext(cfg)
    if (!next) {
      log(`❌  没有可用 key（全部在冷却期），维持当前 key "${cfg.current}"`)
      return
    }
    cfg.current = next.name
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
      isCurrent: k.name === cfg.current,
    }
  })
  return {
    provider_id: cfg.provider_id,
    cooldown_minutes: cfg.cooldown_minutes,
    current: cfg.current,
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
        if (route === "/api/rotate") return manualRotate()
        if (route === "/api/log/clear") return clearLog()
        return null
      }
      const res = run()
      if (res === null) return json({ error: "unknown route" }, 404)
      return json({ ok: res === true || !!res, status: statusPayload() })
    } catch (e: any) {
      return json({ error: e.message }, 400)
    }
  }
  return json({ error: "not found" }, 404)
}

async function startWeb() {
  if (webStarted) return
  try {
    // 端口绑定失败即认为已有实例在跑（满足"web 只启动一个"）
    Bun.serve({ port: WEB_PORT, fetch: handleWeb })
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
      const cfg = rotate(String(msg))
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
      <div class="stat"><div class="v" id="s-cooldown">-</div><div class="l">冷却窗口(min)</div></div>
    </div>
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:10px"><input id="new-name" placeholder="名称，如 act2">&nbsp;<input id="new-key" placeholder="sk-xxxx 完整的 API key"><button class="primary" onclick="addKey()">新增 key</button></div>
    <div class="row" style="margin-bottom:10px"><span class="muted">手动轮换到下一个可用 key：</span><button onclick="rotate()">轮换</button></div>
    <table>
      <thead><tr><th>名称</th><th>Key</th><th>状态</th><th>操作</th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="msg" id="msg"></div>
  </div>

  <div class="card">
    <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between">
      <b>运行日志</b>
      <button class="danger" id="clear-log-btn" onclick="clearLog()">清空日志</button>
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
async function refresh() {
  try {
    const st = await api("/api/status")
    document.getElementById("s-current").textContent = st.current || "(none)"
    document.getElementById("s-avail").textContent = st.availableCount + "/" + st.keyCount
    document.getElementById("s-total").textContent = "total " + st.keyCount
    document.getElementById("s-cooldown").textContent = st.cooldown_minutes
    const tb = document.getElementById("tbody")
    tb.innerHTML = ""
    for (const k of st.keys) {
      const tr = document.createElement("tr")
      let badge = k.state === "cooling" ? '<span class="badge b-cooling">冷却 ' + k.remainMin + 'min</span>' : '<span class="badge b-available">可用</span>'
      if (k.isCurrent) badge += '<span class="badge b-current">当前</span>'
      tr.innerHTML =
        '<td>' + k.name + '</td>' +
        '<td class="muted" title="' + k.key + '">' + k.masked + '</td>' +
        '<td>' + badge + '</td>' +
        '<td><div class="actions">' +
          (k.isCurrent ? '' : '<button data-set="' + k.name + '">启用</button>') +
          (k.state === "cooling"
            ? '<button data-cooldown="' + k.name + '" data-min="0">清除冷却</button>'
            : '<button data-cooldown="' + k.name + '" data-min="' + st.cooldown_minutes + '">冷却</button>') +
          '<button class="danger" data-del="' + k.name + '">删除</button>' +
        '</div></td>'
      tb.appendChild(tr)
    }
    tb.querySelectorAll("[data-set]").forEach(b => b.onclick = () => doOp(() => api("/api/current", { name: b.dataset.set })))
    tb.querySelectorAll("[data-cooldown]").forEach(b => b.onclick = () => doOp(() => api("/api/cooldown", { name: b.dataset.cooldown, minutes: Number(b.dataset.min) })))
    tb.querySelectorAll("[data-del]").forEach(b => b.onclick = () => doOp(() => api("/api/keys/delete", { name: b.dataset.del })))
  } catch (e) { showErr(e.message) }
}
async function addKey() {
  const name = document.getElementById("new-name").value.trim()
  const key = document.getElementById("new-key").value.trim()
  if (!name || !key) return showErr("名称和 key 不能为空")
  try { await api("/api/keys/add", { name, key }); document.getElementById("new-name").value=""; document.getElementById("new-key").value=""; refresh() }
  catch (e) { showErr(e.message) }
}
async function rotate() { try { await api("/api/rotate", {}); refresh() } catch (e) { showErr(e.message) } }
async function doOp(p) { try { await p(); refresh() } catch (e) { showErr(e.message) } }
function showErr(m) { const el = document.getElementById("msg"); el.textContent = m; el.className = "msg err"; setTimeout(() => showMsg(""), 3000) }
function showMsg(m) { const el = document.getElementById("msg"); el.textContent = m; el.className = "msg" }
async function refreshLog() {
  try { const r = await fetch("/api/log"); document.getElementById("logview").textContent = await r.text() } catch {}
}
async function clearLog() {
  if (!confirm("确认清空日志？")) return
  try { await api("/api/log/clear", {}); refreshLog(); showMsg("日志已清空") }
  catch (e) { showErr(e.message) }
}
refresh(); refreshLog(); setInterval(refresh, 5000); setInterval(refreshLog, 8000);
</script>
</body>
</html>`