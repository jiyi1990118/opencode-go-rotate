/**
 * go-rotate 插件纯逻辑单元测试（bun 零依赖，node 内置 fs/child_process + bun:test）
 *
 * 运行：
 *   cd /Users/jary/serverTools/go-rotate && bun test tests/go-rotate-plugin.test.ts
 *
 * 隔离策略（务必理解）：
 *   - 插件全部配置/认证路径由模块级常量派生（homedir() → ~/.config/opencode/go-keys.json、
 *     ~/.local/share/opencode/auth.json）。bun 的 node:os homedir() 不尊重 $HOME（实测固定返回
 *     真实 home），因此 process.env.HOME 无法隔离——改用插件支持的显式覆盖环境变量：
 *     GOROTATE_CONFIG_FILE / GOROTATE_AUTH_FILE（go-rotate.ts 顶部，生产不设置则行为不变）。
 *   - 因此测试在 import 插件模块【之前】设置 GOROTATE_CONFIG_FILE / GOROTATE_AUTH_FILE 指向临时目录。
 *   - LOG_FILE 固定为 /tmp/opencode-go-rotate.log（模块常量，不可重定向）：测试运行会像
 *     任何一次插件加载一样向其追加少量日志行（日志本身 1MB 轮转归档），属可接受副作用，报告已注明。
 *   - 绝不触碰真实 ~/.config/opencode/go-keys.json 与 auth.json（测试前后 md5 校验见验证步骤）。
 *   - Web：不实际 bind 8899（真实 go-rotate web 在跑）。GoRotate() 调用前临时配置 auto_web:false，
 *     startWeb 会跳过绑定（日志可证），真实绑定路径不测，报告已注明。
 */

import { describe, test, expect, afterAll } from "bun:test"
import { spawn } from "node:child_process"
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  rmSync,
  utimesSync,
  chmodSync,
  unlinkSync,
  statSync,
} from "node:fs"
import path from "node:path"

const PLUGIN_PATH = path.resolve(import.meta.dir, "..", "go-rotate.ts")

// ---- 临时文件（先于 import 插件模块设置覆盖环境变量） ----
const TMP_ROOT = path.join("/tmp", `gort-plugin-test-${process.pid}-${Date.now()}`)
const HOME = path.join(TMP_ROOT, "home")
const CFG_DIR = path.join(HOME, ".config", "opencode")
const CFG_FILE = path.join(CFG_DIR, "go-keys.json")
const LOCK_FILE = CFG_FILE + ".lock"
const AUTH_DIR = path.join(HOME, ".local", "share", "opencode")
const AUTH_FILE = path.join(AUTH_DIR, "auth.json")

process.env.GOROTATE_CONFIG_FILE = CFG_FILE
process.env.GOROTATE_AUTH_FILE = AUTH_FILE
// 日志隔离：GOROTATE_LOG_FILE 指向临时文件（测试进程 log() 绝不写真实共享日志，
// 避免污染 /tmp/opencode-go-rotate.log 与 parseStatsLog 统计）
process.env.GOROTATE_LOG_FILE = path.join(TMP_ROOT, "go-rotate-test.log")
// 网关配置隔离：GOROTATE_GATEWAY_CONFIG 指向临时 gateway-config.json（测试写套餐/token
// 不碰真实 ~/.local/share/zen-gateway/gateway-config.json；import 前设，模块常量固化）
const GW_CONFIG_FILE = path.join(TMP_ROOT, "zen-gateway", "gateway-config.json")
process.env.GOROTATE_GATEWAY_CONFIG = GW_CONFIG_FILE
// 网关管理隔离：GOROTATE_GATEWAY_CTL 指向临时假脚本（真实启停绝不在测试里执行）；
// GOROTATE_GATEWAY_BASE 指向不可达端口，强制 gatewayStatus/gatewayLog 走降级/回退分支。
const FAKE_CTL = path.join(TMP_ROOT, "zen-gateway")
process.env.GOROTATE_GATEWAY_CTL = FAKE_CTL
process.env.GOROTATE_GATEWAY_BASE = "http://127.0.0.1:59999"
mkdirSync(CFG_DIR, { recursive: true })
mkdirSync(AUTH_DIR, { recursive: true })
writeFileSync(CFG_FILE, JSON.stringify({ provider_id: "opencode-go", cooldown_minutes: 300, current: "", keys: [], auto_web: false }))
writeFileSync(AUTH_FILE, JSON.stringify({}))

// ---- 动态 import（模块常量在此时经 homedir() 固化到临时 HOME） ----
const mod = await import(PLUGIN_PATH)

// ---- 工具 ----
const seed = (cfg: any) => writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2))
const readCfg = (): any => JSON.parse(readFileSync(CFG_FILE, "utf8"))
const seedAuth = (auth: any) => writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2))
const readAuth = (): any => JSON.parse(readFileSync(AUTH_FILE, "utf8"))
/** 断言 ISO 时间 ≈ now + minutes（容差 tolMs，默认 5s） */
const near = (iso: string, minutes: number, tolMs = 5000): boolean =>
  Math.abs(Date.parse(iso) - (Date.now() + minutes * 60_000)) <= tolMs
const twoKeys = (current = "a") => ({
  provider_id: "opencode-go",
  cooldown_minutes: 300,
  current,
  auto_web: false,
  keys: [
    { name: "a", key: "sk-aaa", cooldown_until: null },
    { name: "b", key: "sk-bbb", cooldown_until: null },
  ],
})

let hooks: any = null

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {}
})

/* ================= 1. 模块与 hooks 结构 ================= */

describe("模块与 hooks 结构", () => {
  test("GoRotate 导出且返回 chat.headers / event 钩子（临时 HOME + auto_web:false，不 bind 8899）", async () => {
    expect(typeof mod.GoRotate).toBe("function")
    seed({ ...twoKeys(), auto_web: false })
    hooks = await mod.GoRotate({ directory: HOME })
    expect(hooks).toBeTruthy()
    expect(typeof hooks["chat.headers"]).toBe("function")
    expect(typeof hooks.event).toBe("function")
    // 隔离确认：模块常量指向临时 HOME（写临时配置 → loadConfig 应读到它）
    expect(mod.loadConfig().provider_id).toBe("opencode-go")
    expect(mod.loadConfig().keys.length).toBe(2)
  })
})

/* ================= 2. atomicWrite ================= */

describe("atomicWrite", () => {
  const f = path.join(TMP_ROOT, "aw.txt")
  test("写新文件内容正确", () => {
    mod.atomicWrite(f, "hello-rotate")
    expect(readFileSync(f, "utf8")).toBe("hello-rotate")
  })
  test("覆盖旧文件", () => {
    writeFileSync(f, "old-content")
    mod.atomicWrite(f, "new-content")
    expect(readFileSync(f, "utf8")).toBe("new-content")
  })
  test("写后无 .tmp 残留", () => {
    expect(existsSync(f + ".tmp")).toBe(false)
  })
})

/* ================= 3. loadConfig ================= */

describe("loadConfig", () => {
  test("文件不存在返回默认值", () => {
    const bak = CFG_FILE + ".bak"
    renameSync(CFG_FILE, bak)
    try {
      const def = mod.loadConfig()
      expect(def.provider_id).toBe("opencode-go")
      expect(def.cooldown_minutes).toBe(300)
      expect(def.current).toBe("")
      expect(def.keys).toEqual([])
      expect(def.auto_web).toBe(true)
    } finally {
      renameSync(bak, CFG_FILE)
    }
  })
  test("损坏 JSON 容错返回默认值", () => {
    writeFileSync(CFG_FILE, "{{{ not valid json ]")
    const def = mod.loadConfig()
    expect(def.provider_id).toBe("opencode-go")
    expect(def.cooldown_minutes).toBe(300)
    expect(def.keys).toEqual([])
  })
  test("keys 数组过滤非法条目（缺 name/key 丢弃）", () => {
    seed({
      keys: [
        { name: "a", key: "k1" },
        { name: "b" }, // 缺 key
        { name: "c", key: "k2" },
        42, // 非对象
        { key: "k3" }, // 缺 name
      ],
    })
    const cfg = mod.loadConfig()
    expect(cfg.keys.length).toBe(2)
    expect(cfg.keys.map((k: any) => k.name)).toEqual(["a", "c"])
  })
  test("provider_id / cooldown_minutes / current 从文件读取", () => {
    seed({ provider_id: "opencode-go-x", cooldown_minutes: 77, current: "a", keys: [{ name: "a", key: "k" }] })
    const cfg = mod.loadConfig()
    expect(cfg.provider_id).toBe("opencode-go-x")
    expect(cfg.cooldown_minutes).toBe(77)
    expect(cfg.current).toBe("a")
  })
})

/* ================= 4. saveConfig / mutateConfig ================= */

describe("saveConfig / mutateConfig", () => {
  test("saveConfig 写文件后 JSON 合法且可往返", () => {
    const cfg = { provider_id: "opencode-go", cooldown_minutes: 120, current: "a", auto_web: true, keys: [{ name: "a", key: "k", cooldown_until: null }] }
    mod.saveConfig(cfg)
    expect(JSON.parse(readFileSync(CFG_FILE, "utf8"))).toEqual(cfg)
  })
  test("mutateConfig 锁内修改生效且写后 JSON 合法、无锁残留、无 .tmp", () => {
    seed(twoKeys())
    mod.mutateConfig((c: any) => {
      c.cooldown_minutes = 42
    })
    expect(readCfg().cooldown_minutes).toBe(42)
    expect(readCfg().keys.length).toBe(2) // JSON 无损
    expect(existsSync(LOCK_FILE)).toBe(false)
    expect(existsSync(CFG_FILE + ".tmp")).toBe(false)
  })
  test("mutateConfig 内 fn 抛异常 → 异常传播且锁释放、配置不变", () => {
    seed(twoKeys())
    expect(() => mod.setCurrent("nope")).toThrow()
    expect(existsSync(LOCK_FILE)).toBe(false)
    expect(readCfg().current).toBe("a")
  })
  test("addKey 重复名称抛异常且锁释放", () => {
    seed(twoKeys())
    expect(() => mod.addKey("a", "sk-dup")).toThrow()
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
  test("reconcileCurrent：current 指向不存在的 key 时回退到第一个", () => {
    seed(twoKeys())
    mod.mutateConfig((c: any) => {
      c.current = "zzz"
    })
    expect(readCfg().current).toBe("a")
    // 直接调用 reconcileCurrent
    const cfg = { current: "zzz", keys: [{ name: "a", key: "k" }, { name: "b", key: "k2" }] } as any
    mod.reconcileCurrent(cfg)
    expect(cfg.current).toBe("a")
  })
  test("updateKey 重命名当前 key → current 跟随新名称", () => {
    seed(twoKeys("a"))
    mod.updateKey("a", { name: "a-renamed" })
    const cfg = readCfg()
    expect(cfg.current).toBe("a-renamed")
    expect(cfg.keys.some((k: any) => k.name === "a")).toBe(false)
  })
  test("removeKey 删除当前 key → current 回退到第一个剩余 key", () => {
    seed(twoKeys("a"))
    mod.removeKey("a")
    const cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(cfg.keys.length).toBe(1)
  })
  test("currentKey：current 有效返回之，无效回退 keys[0]", () => {
    expect(mod.currentKey({ current: "b", keys: twoKeys().keys } as any)?.name).toBe("b")
    expect(mod.currentKey({ current: "zzz", keys: twoKeys().keys } as any)?.name).toBe("a")
    expect(mod.currentKey({ current: "", keys: [] } as any)).toBeUndefined()
  })
  test("setCooldown 设置/清除冷却", () => {
    seed(twoKeys("a"))
    mod.setCooldown("a", 60)
    expect(near(readCfg().keys[0].cooldown_until, 60)).toBe(true)
    mod.setCooldown("a", null)
    expect(readCfg().keys[0].cooldown_until).toBeNull()
  })
})

/* ================= 5. withLockSync ================= */

describe("withLockSync", () => {
  test("操作完成后锁文件被删除", () => {
    seed(twoKeys())
    mod.mutateConfig((c: any) => {
      c.current = "b"
    })
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
  test("陈旧锁（mtime >15s）被识别清除后继续执行", () => {
    seed(twoKeys("a"))
    writeFileSync(LOCK_FILE, "stale")
    const past = new Date(Date.now() - 20_000)
    utimesSync(LOCK_FILE, past, past)
    mod.mutateConfig((c: any) => {
      c.current = "b"
    })
    expect(readCfg().current).toBe("b")
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
})

/* ================= 6. 并发 ================= */

describe("并发安全", () => {
  test("单进程 10 次连续 mutateConfig 改不同字段 → JSON 无损、字段齐全、无锁残留、无 .tmp", () => {
    seed({ provider_id: "opencode-go", cooldown_minutes: 300, current: "", keys: [], auto_web: false })
    for (let i = 0; i < 10; i++) {
      const n = i
      mod.mutateConfig((c: any) => {
        c[`f${n}`] = n
      })
    }
    const cfg = readCfg()
    for (let i = 0; i < 10; i++) expect(cfg[`f${i}`]).toBe(i)
    expect(existsSync(LOCK_FILE)).toBe(false)
    expect(existsSync(CFG_FILE + ".tmp")).toBe(false)
  })

  test("跨进程 5 个子进程并发 addKey → 5 个 key 全在、JSON 合法、无锁残留", async () => {
    seed({ provider_id: "opencode-go", cooldown_minutes: 300, current: "", keys: [], auto_web: false })
    const spawnChild = (i: number) =>
      new Promise<{ ok: boolean; err: string }>((resolve) => {
        const script = `process.env.HOME=${JSON.stringify(HOME)};const m=await import(${JSON.stringify(PLUGIN_PATH)});m.addKey("k${i}","sk-x${i}")`
        const child = spawn("bun", ["-e", script], { env: { ...process.env, HOME } })
        let err = ""
        child.stderr.on("data", (d: Buffer) => (err += String(d)))
        child.on("close", (code) => resolve({ ok: code === 0, err }))
      })
    const results = await Promise.all([0, 1, 2, 3, 4].map(spawnChild))
    for (const r of results) expect(r.ok).toBe(true)
    const cfg = readCfg()
    expect(cfg.keys.length).toBe(5)
    const names = cfg.keys.map((k: any) => k.name).sort()
    expect(names).toEqual(["k0", "k1", "k2", "k3", "k4"])
    // JSON 无损：可解析（上面已解析）+ 每个 key 字段完整
    for (const k of cfg.keys) {
      expect(typeof k.name).toBe("string")
      expect(typeof k.key).toBe("string")
    }
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
})

/* ================= 7. cooldownUntilDefault 优先级 ================= */

describe("cooldownUntilDefault", () => {
  test("key 独立窗口（30min）优先于全局（120min）", () => {
    const cfg = { cooldown_minutes: 120 } as any
    const key = { name: "a", key: "k", cooldown_until: null, cooldown_minutes: 30 } as any
    expect(near(mod.cooldownUntilDefault(cfg, key), 30)).toBe(true)
  })
  test("key 无独立窗口 → 用全局窗口（120min）", () => {
    const cfg = { cooldown_minutes: 120 } as any
    const key = { name: "a", key: "k", cooldown_until: null } as any
    expect(near(mod.cooldownUntilDefault(cfg, key), 120)).toBe(true)
  })
  test("key 与全局都缺省 → 默认 300min", () => {
    const cfg = {} as any
    expect(near(mod.cooldownUntilDefault(cfg), 300)).toBe(true)
    const key = { name: "a", key: "k", cooldown_until: null } as any
    expect(near(mod.cooldownUntilDefault(cfg, key), 300)).toBe(true)
  })
})

/* ================= 8. parseResetTime 时区解析 ================= */

describe("parseResetTime", () => {
  test("+0800 偏移 → 正确 UTC（2026-08-16T00:00:00.000Z），不退化本地时区", () => {
    expect(mod.parseResetTime("reset at 2026-08-16 08:00:00 +0800 CST")).toBe("2026-08-16T00:00:00.000Z")
  })
  test("+08:00 冒号偏移 → 同样解析为 00:00Z（旧正则不捕获冒号格式）", () => {
    expect(mod.parseResetTime("reset at 2026-08-16 08:00:00 +08:00 CST")).toBe("2026-08-16T00:00:00.000Z")
  })
  test("Z 后缀 → 按 UTC 解析为 08:00Z（旧实现差 8 小时）", () => {
    expect(mod.parseResetTime("reset at 2026-08-16T08:00:00Z")).toBe("2026-08-16T08:00:00.000Z")
  })
  test("T 分隔 + 无冒号偏移（+0800）→ 00:00Z", () => {
    expect(mod.parseResetTime("reset at 2026-08-16T08:00:00+0800")).toBe("2026-08-16T00:00:00.000Z")
  })
  test("无偏移 → 按本地时区解释（与 Date.parse 本地解析一致，本机 +8）", () => {
    expect(mod.parseResetTime("reset at 2026-08-16 08:00:00")).toBe(new Date("2026-08-16T08:00:00").toISOString())
  })
  test("无效串返回 null", () => {
    expect(mod.parseResetTime("no reset time here")).toBeNull()
    expect(mod.parseResetTime("reset at not-a-date")).toBeNull()
    expect(mod.parseResetTime("")).toBeNull()
  })
})

/* ================= 9. pickNext ================= */

describe("pickNext", () => {
  test("跳过冷却 key，选下一个可用", () => {
    const cfg = twoKeys("a")
    cfg.keys[0].cooldown_until = new Date(Date.now() + 60_000).toISOString() // a 冷却
    expect(mod.pickNext(cfg)?.name).toBe("b")
  })
  test("冷却已过期视为可用", () => {
    const cfg = twoKeys("a")
    cfg.keys[0].cooldown_until = new Date(Date.now() - 1000).toISOString()
    expect(mod.pickNext(cfg)?.name).toBe("b")
  })
  test("全部冷却 → undefined", () => {
    const cfg = twoKeys("a")
    for (const k of cfg.keys) k.cooldown_until = new Date(Date.now() + 60_000).toISOString()
    expect(mod.pickNext(cfg)).toBeUndefined()
  })
  test("循环轮换回绕（current 是最后一个 → 回到第一个）", () => {
    const cfg = twoKeys("b")
    expect(mod.pickNext(cfg)?.name).toBe("a")
  })
  test("空 keys → undefined", () => {
    expect(mod.pickNext({ current: "", keys: [] } as any)).toBeUndefined()
  })
})

/* ================= 10. isQuotaError / classifyGoError / isGoError ================= */

describe("isQuotaError", () => {
  test("状态码 401/402/429 → true", () => {
    expect(mod.isQuotaError({ data: { statusCode: 401 } })).toBe(true)
    expect(mod.isQuotaError({ data: { statusCode: 402 } })).toBe(true)
    expect(mod.isQuotaError({ data: { statusCode: 429 } })).toBe(true)
  })
  test("状态码 500 → false", () => {
    expect(mod.isQuotaError({ data: { statusCode: 500 } })).toBe(false)
  })
  test("英文消息匹配 quota/insufficient/balance/rate limit/exceeded → true", () => {
    expect(mod.isQuotaError({ data: { message: "quota exceeded" } })).toBe(true)
    expect(mod.isQuotaError({ data: { message: "insufficient balance" } })).toBe(true)
    expect(mod.isQuotaError({ data: { message: "rate limit reached" } })).toBe(true)
    expect(mod.isQuotaError({ data: { message: "usage limit exceeded" } })).toBe(true)
  })
  test("中文配额/余额/限流/超出 → true（2026-08-16 与 gateway 对齐补中文）", () => {
    expect(mod.isQuotaError({ data: { message: "配额不足，请充值" } })).toBe(true)
    expect(mod.isQuotaError({ data: { message: "账户余额不足" } })).toBe(true)
    expect(mod.isQuotaError({ data: { message: "请求被限流" } })).toBe(true)
    expect(mod.isQuotaError({ data: { message: "超出每日用量上限" } })).toBe(true)
  })
  test("无配额特征 / null → false", () => {
    expect(mod.isQuotaError({ data: { message: "internal server error", statusCode: 500 } })).toBe(false)
    expect(mod.isQuotaError(null)).toBe(false)
    expect(mod.isQuotaError({})).toBe(false)
  })
})

describe("classifyGoError", () => {
  test("401 + invalid api key → invalid", () => {
    expect(mod.classifyGoError("invalid api key", 401)).toBe("invalid")
  })
  test("402 / insufficient|balance → nobalance", () => {
    expect(mod.classifyGoError("quota", 402)).toBe("nobalance")
    expect(mod.classifyGoError("insufficient balance", 200)).toBe("nobalance")
  })
  test("429 / quota|rate|limit|exceeded → limited", () => {
    expect(mod.classifyGoError("quota exceeded", 429)).toBe("limited")
    expect(mod.classifyGoError("rate limit", 200)).toBe("limited")
  })
  test("其它 → error", () => {
    expect(mod.classifyGoError("boom", 500)).toBe("error")
  })
})

describe("isGoError", () => {
  test("ProviderAuthError + providerID 含 opencode → true", () => {
    expect(mod.isGoError({ name: "ProviderAuthError", data: { providerID: "opencode-go" } })).toBe(true)
  })
  test("URL 匹配 opencode.ai/zen|go → true", () => {
    expect(mod.isGoError({ data: { metadata: { url: "https://opencode.ai/zen/go/v1" } } })).toBe(true)
    expect(mod.isGoError({ data: { metadata: { url: "https://opencode.ai/zen/v1" } } })).toBe(true)
    expect(mod.isGoError({ data: { url: "https://opencode.ai/zen/go/v1" } })).toBe(true)
  })
  test("responseBody 含 opencode 特征 → true", () => {
    expect(mod.isGoError({ data: { responseBody: '{"error":"opencode.ai/zen quota"}' } })).toBe(true)
  })
  test("其它 URL / null / 空 → false", () => {
    expect(mod.isGoError({ data: { metadata: { url: "https://other.com/v1" } } })).toBe(false)
    expect(mod.isGoError(null)).toBe(false)
    expect(mod.isGoError({})).toBe(false)
  })
})

/* ================= 11. rotate（直接调用） ================= */

describe("rotate", () => {
  test("解析 reset 时间写入 cooldown + 切换当前 + last_status + 同步 auth.json（保留其它 provider）", () => {
    seed(twoKeys("a"))
    seedAuth({ other: { type: "api", key: "keep-me" } })
    mod.rotate("quota exceeded: reset at 2026-08-16 08:00:00 +0800 CST", { data: { statusCode: 429, message: "quota exceeded" } })
    const cfg = readCfg()
    expect(cfg.keys[0].cooldown_until).toBe("2026-08-16T00:00:00.000Z") // 解析的 reset 时间
    expect(cfg.keys[0].last_status).toBe("limited")
    expect(cfg.current).toBe("b")
    expect(cfg.keys[1].last_status).toBeNull()
    const auth = readAuth()
    expect(auth["opencode-go"].key).toBe("sk-bbb") // 同步到临时 auth.json
    expect(auth["opencode-go"].type).toBe("api")
    expect(auth.other.key).toBe("keep-me") // 其它 provider 保留
  })
  test("消息无可解析时间 → 用该 key 独立冷却窗口（1min 而非全局 300）", () => {
    seed({ ...twoKeys("a"), keys: [{ name: "a", key: "sk-aaa", cooldown_until: null, cooldown_minutes: 1 }, { name: "b", key: "sk-bbb", cooldown_until: null }] })
    mod.rotate("quota", { data: { statusCode: 429 } })
    expect(near(readCfg().keys[0].cooldown_until, 1)).toBe(true)
    expect(readCfg().current).toBe("b")
  })
  test("全部冷却 → 不抛异常、current 不变", () => {
    const cfg = twoKeys("a")
    cfg.keys[0].cooldown_until = new Date(Date.now() + 60_000).toISOString()
    cfg.keys[1].cooldown_until = new Date(Date.now() + 60_000).toISOString()
    seed(cfg)
    expect(() => mod.rotate("quota", { data: { statusCode: 429 } })).not.toThrow()
    expect(readCfg().current).toBe("a")
  })
  test("401 invalid api key → last_status=invalid 并轮换", () => {
    seed(twoKeys("a"))
    mod.rotate("invalid api key", { data: { statusCode: 401, message: "invalid api key" } })
    const cfg = readCfg()
    expect(cfg.keys[0].last_status).toBe("invalid")
    expect(cfg.current).toBe("b")
  })
  test("manualRotate：不写冷却，仅切到下一可用 key", () => {
    seed(twoKeys("a"))
    mod.manualRotate()
    const cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(cfg.keys[0].cooldown_until).toBeNull()
  })
})

/* ================= 12. event 钩子驱动轮换（真实链路） ================= */

describe("event 钩子（session.error → rotate 全链路）", () => {
  test("配额错误（429 + opencode URL）→ 自动轮换", async () => {
    seed(twoKeys("a"))
    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s1",
          error: { name: "APIError", data: { message: "quota exceeded", statusCode: 429, metadata: { url: "https://opencode.ai/zen/go/v1" } } },
        },
      },
    })
    const cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(cfg.keys[0].cooldown_until).toBeTruthy()
    expect(cfg.keys[0].last_status).toBe("limited")
  })
  test("非 opencode 端点错误 → 不轮换", async () => {
    seed(twoKeys("a"))
    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s2",
          error: { name: "APIError", data: { message: "quota exceeded", statusCode: 429, metadata: { url: "https://other.com/v1" } } },
        },
      },
    })
    expect(readCfg().current).toBe("a")
  })
  test("非配额错误（500）→ 不轮换", async () => {
    seed(twoKeys("a"))
    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "s3",
          error: { name: "APIError", data: { message: "internal error", statusCode: 500, metadata: { url: "https://opencode.ai/zen/go/v1" } } },
        },
      },
    })
    expect(readCfg().current).toBe("a")
  })
  test("非 session.error 事件 → 忽略", async () => {
    seed(twoKeys("a"))
    await hooks.event({ event: { type: "session.updated", properties: {} } })
    expect(readCfg().current).toBe("a")
  })
  test("事件轮换后 chat.headers 注入新 key", async () => {
    seed(twoKeys("a"))
    // 先设 sid → pid 映射（与真实调用顺序一致：请求先于错误）
    const out1 = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "opencode-go" }, sessionID: "rot-sess" }, out1)
    expect(out1.headers.Authorization).toBe("Bearer sk-aaa")
    // 触发轮换
    await hooks.event({
      event: {
        type: "session.error",
        properties: {
          sessionID: "rot-sess",
          error: { name: "APIError", data: { message: "quota", statusCode: 429, metadata: { url: "https://opencode.ai/zen/go/v1" } } },
        },
      },
    })
    // 下一次请求注入新 key
    const out2 = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "opencode-go" }, sessionID: "rot-sess" }, out2)
    expect(out2.headers.Authorization).toBe("Bearer sk-bbb")
  })
})

/* ================= 13. chat.headers 注入 ================= */

describe("chat.headers", () => {
  test("providerID 含 opencode → 注入 Authorization（当前 key）", async () => {
    seed(twoKeys("a"))
    const out = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "opencode-go" }, sessionID: "h1" }, out)
    expect(out.headers.Authorization).toBe("Bearer sk-aaa")
  })
  test("providerID 为 opencode（免费档前缀）→ 注入", async () => {
    seed(twoKeys("b"))
    const out = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "opencode" }, sessionID: "h2" }, out)
    expect(out.headers.Authorization).toBe("Bearer sk-bbb")
  })
  test("其它 provider（codeplan）→ 不注入，原 headers 保留", async () => {
    seed(twoKeys("a"))
    const out = { headers: { "x-existing": "1" } }
    await hooks["chat.headers"]({ model: { providerID: "codeplan" }, sessionID: "h3" }, out)
    expect(out.headers.Authorization).toBeUndefined()
    expect(out.headers["x-existing"]).toBe("1")
  })
  test("缺 sessionID → 不注入", async () => {
    seed(twoKeys("a"))
    const out = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "opencode-go" } }, out)
    expect(out.headers.Authorization).toBeUndefined()
  })
  test("无 key（空配置）→ 不注入也不抛异常", async () => {
    seed({ provider_id: "opencode-go", cooldown_minutes: 300, current: "", keys: [], auto_web: false })
    const out = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: "opencode-go" }, sessionID: "h5" }, out)
    expect(out.headers.Authorization).toBeUndefined()
  })
})

/* ================= 14. 日志 / Web（不实际 bind 8899） ================= */

describe("日志与 Web（只读，不 bind 8899）", () => {
  test("logTail 存在且包含 GoRotate 加载与 auto_web 跳过日志（隔离证据）", () => {
    const tail = mod.logTail()
    expect(typeof tail).toBe("string")
    expect(tail).toContain("go-rotate loaded")
    expect(tail).toContain("auto_web 已关闭")
  })
  test("statusPayload 反映临时配置（auto_web=false / 当前 key / 冷却状态）", () => {
    seed(twoKeys("b"))
    const st = mod.statusPayload()
    expect(st.auto_web).toBe(false)
    expect(st.current).toBe("b")
    expect(st.keyCount).toBe(2)
    expect(st.availableCount).toBe(2)
    expect(st.keys[0].isCurrent).toBe(false)
    expect(st.keys[1].isCurrent).toBe(true)
    // 冷却中的 key 状态为 cooling
    seed({ ...twoKeys("a"), keys: [{ name: "a", key: "sk-aaa", cooldown_until: new Date(Date.now() + 60_000).toISOString() }, { name: "b", key: "sk-bbb", cooldown_until: null }] })
    const st2 = mod.statusPayload()
    expect(st2.keys[0].state).toBe("cooling")
    expect(st2.keys[0].remainMin).toBeGreaterThan(0)
    expect(st2.availableCount).toBe(1)
  })
  test("WEB_HTML 含 key 编辑 UI（data-edit 按钮 + editKey 函数 + /api/keys/update 调用）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(typeof html).toBe("string")
    // 行内「编辑」按钮（data-edit 挂 key 名）
    expect(html).toContain('data-edit="')
    expect(html).toContain("title=\"编辑名称 / key 值\"")
    // editKey 函数：两个 prompt（名称/key 可空）+ patch 组装 + 双空不调 API + update 调用
    expect(html).toContain("function editKey")
    expect(html).toContain('修改 key "')
    expect(html).toContain("留空 = 不改")
    expect(html).toContain("未修改：名称与 key 值均为空")
    expect(html).toContain('api("/api/keys/update", { name, patch })')
    // webOn 显示 restarted（基线 ⑧ 立即重启）
    expect(html).toContain("r.restarted ? \"Web 已重新启动（立即生效）\" : \"已开启 Web 自动启动\"")
  })
})

/* ================= 网关管理（Web 面板 + 管理路由，隔离假脚本，绝不真实启停） ================= */

const FAKE_CTL_BODY = "#!/bin/sh\n# fake zen-gateway for isolated tests (never touches real launchd)\necho \"fake zen-gateway $*\"\n"

describe("网关管理 UI（WEB_HTML 内嵌）", () => {
  test("WEB_HTML 含网关管理卡片元素：管理按钮 / 状态徽标 / 模型数 / 管理消息 / 网关日志区", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("网关管理")
    expect(html).toContain('id="gw-badge"')
    expect(html).toContain('id="gw-mcount"')
    expect(html).toContain('id="gw-version"')
    expect(html).toContain('id="gw-start" onclick="gwManage(\'start\')"')
    expect(html).toContain('id="gw-stop" onclick="gwManage(\'stop\')"')
    expect(html).toContain('id="gw-restart" onclick="gwManage(\'restart\')"')
    expect(html).toContain('id="gw-ctl-msg"')
    // 网关日志区（独立卡片 + 刷新按钮 + 只读 pre）
    expect(html).toContain("网关日志")
    expect(html).toContain('onclick="refreshGwLog()"')
    expect(html).toContain('id="gwlogview"')
    // 管理 JS：gwManage 调 /api/gateway/<action>，成功后 800ms 刷新状态
    expect(html).toContain("async function gwManage(action)")
    expect(html).toContain('api("/api/gateway/" + action, {})')
    expect(html).toContain("setTimeout(refreshGateway, 800)")
    expect(html).toContain("async function refreshGwLog()")
    // 徽标三态样式（running 绿 / stopped 灰 / error 红）
    expect(html).toContain(".b-running")
    expect(html).toContain(".b-stopped")
    expect(html).toContain(".b-error")
    // 启动序列包含 refreshGwLog
    expect(html).toContain("refresh(); refreshLog(); refreshStats(); refreshGateway(); refreshGwLog();")
  })
})

describe("网关管理路由（POST /api/gateway/start|stop|restart，假脚本隔离）", () => {
  test("有管理脚本时 start/stop/restart 均返回 {ok:true, output}（假脚本 echo）", async () => {
    // 写假脚本（import 前已设 GOROTATE_GATEWAY_CTL=FAKE_CTL 固化 GATEWAY_CTL）
    writeFileSync(FAKE_CTL, FAKE_CTL_BODY, { mode: 0o755 })
    chmodSync(FAKE_CTL, 0o755)
    for (const action of ["start", "stop", "restart"]) {
      const req = new Request(`http://127.0.0.1:8899/api/gateway/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      const res = await mod.handleWeb(req)
      expect(res.status).toBe(200)
      const j = await res.json()
      expect(j.ok).toBe(true)
      expect(j.output).toBe(`fake zen-gateway ${action}`)
      expect(j.status).toBeUndefined() // 管理路由透传 {ok,output}，不套统一包装
    }
  })
  test("无管理脚本（未安装）→ {ok:false} 且 output 提示脚本不存在，不抛异常", async () => {
    unlinkSync(FAKE_CTL) // 模拟未安装：删除脚本
    expect(mod.gatewayCtlExists()).toBe(false)
    const req = new Request("http://127.0.0.1:8899/api/gateway/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(j.output).toContain("不存在")
    expect(j.output).toContain("install.sh zen-gateway")
  })
  test("脚本存在但 18888 不可达 → GET /api/gateway 降级 running=false + ctlExists=true", async () => {
    writeFileSync(FAKE_CTL, FAKE_CTL_BODY, { mode: 0o755 })
    const req = new Request("http://127.0.0.1:8899/api/gateway")
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.running).toBe(false)
    expect(j.ctlExists).toBe(true)
    expect(typeof j.error).toBe("string") // fetch 59999 失败的错误原因
  })
  test("GET /api/gateway/log 有响应：fetch 不可达回退假脚本 logs（source=zen-gateway logs）", async () => {
    const req = new Request("http://127.0.0.1:8899/api/gateway/log")
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.source).toBe("zen-gateway logs")
    expect(j.text).toContain("fake zen-gateway logs 300")
  })
  test("未安装（无脚本）时 GET /api/gateway/log 回退也失败，text 提示脚本不存在", async () => {
    unlinkSync(FAKE_CTL)
    const req = new Request("http://127.0.0.1:8899/api/gateway/log")
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(j.text).toContain("不存在")
  })
  test("未知网关 POST 路由 → 404 unknown route", async () => {
    const req = new Request("http://127.0.0.1:8899/api/gateway/frobnicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(404)
    const j = await res.json()
    expect(j.error).toBe("unknown route")
  })
})

describe("key 健康探测路由（/api/keys/check 仅 POST，防呆）", () => {
  test("GET → 404 不触发探测；POST → 正常返回 results（空 keys 零网络请求）", async () => {
    // 空 key 配置：checkAllKeys 不循环、不探测、不写 last_status，零真实网络请求
    seed({ provider_id: "opencode-go", cooldown_minutes: 300, current: "", keys: [], auto_web: false })
    // GET：防呆——不得进入探测逻辑（404 not found）
    const g = new Request("http://127.0.0.1:8899/api/keys/check")
    const gr = await mod.handleWeb(g)
    expect(gr.status).toBe(404)
    const gj = await gr.json()
    expect(gj.error).toBe("not found")
    // POST：正常探测路径，返回 {results}
    const p = new Request("http://127.0.0.1:8899/api/keys/check", { method: "POST", body: "{}" })
    const pr = await mod.handleWeb(p)
    expect(pr.status).toBe(200)
    const pj = await pr.json()
    expect(pj.results).toBeDefined()
    expect(Object.keys(pj.results).length).toBe(0)
  })
})

/* ================= 网关配置（gateway-config.json：套餐 + token，GOROTATE_GATEWAY_CONFIG 隔离） ================= */

describe("网关配置（gateway-config.json：套餐 + token）", () => {
  test("genToken 返回 64 hex（0-9a-f）", () => {
    const t = mod.genToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(mod.genToken()).not.toBe(t) // 随机性：两次不同
  })
  test("readGatewayConfig 文件缺失回退默认（go / 无 token）", () => {
    try { unlinkSync(GW_CONFIG_FILE) } catch {}
    const c = mod.readGatewayConfig()
    expect(c.plan).toBe("go")
    expect(c.token).toBeNull()
    expect(c.token_set_at).toBeNull()
  })
  test("writeGatewayConfig 写 plan + 0600 权限 + 无锁残留 + 无 .tmp", () => {
    const c = mod.writeGatewayConfig({ plan: "zen" })
    expect(c.plan).toBe("zen")
    const raw = JSON.parse(readFileSync(GW_CONFIG_FILE, "utf8"))
    expect(raw.plan).toBe("zen")
    const st = statSync(GW_CONFIG_FILE)
    expect(st.mode & 0o777).toBe(0o600) // 敏感凭据文件 0600
    expect(existsSync(LOCK_FILE)).toBe(false)
    expect(existsSync(GW_CONFIG_FILE + ".tmp")).toBe(false)
  })
  test("writeGatewayConfig token 写入 + token_set_at 记录", () => {
    const t = mod.genToken()
    const c = mod.writeGatewayConfig({ token: t })
    expect(c.token).toBe(t)
    expect(typeof c.token_set_at).toBe("string")
    const raw = JSON.parse(readFileSync(GW_CONFIG_FILE, "utf8"))
    expect(raw.token).toBe(t)
    expect(typeof raw.token_set_at).toBe("string")
  })
  test("writeGatewayConfig 非法 plan 抛异常且锁释放、文件不变", () => {
    mod.writeGatewayConfig({ plan: "go" })
    const before = readFileSync(GW_CONFIG_FILE, "utf8")
    expect(() => mod.writeGatewayConfig({ plan: "turbo" })).toThrow('"go"')
    expect(readFileSync(GW_CONFIG_FILE, "utf8")).toBe(before)
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
  test("writeGatewayConfig 空 token 抛异常", () => {
    expect(() => mod.writeGatewayConfig({ token: "" })).toThrow()
    expect(existsSync(LOCK_FILE)).toBe(false)
  })
})

describe("网关配置路由（/api/gateway/plans + /api/gateway/config）", () => {
  test("GET /api/gateway/plans 返回两档套餐 + current", async () => {
    mod.writeGatewayConfig({ plan: "zen" })
    const req = new Request("http://127.0.0.1:8899/api/gateway/plans")
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.plans.length).toBe(2)
    expect(j.plans.map((p: any) => p.id)).toEqual(["go", "zen"])
    expect(j.plans[0].name).toBe("Go 订阅")
    expect(j.plans[0].upstreamBase).toBe("https://opencode.ai/zen/go/v1")
    expect(j.plans[0].defaultModel).toBe("hy3")
    expect(j.plans[1].defaultModel).toBe("hy3-free")
    expect(j.current).toBe("zen")
  })
  test("POST /api/gateway/config {plan} 写文件 + needsRestart:true + 透传不套统一包装", async () => {
    const req = new Request("http://127.0.0.1:8899/api/gateway/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: "go" }),
    })
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(true)
    expect(j.needsRestart).toBe(true)
    expect(j.status).toBeUndefined() // 网关路由透传 {ok,...}，不套统一包装
    expect(JSON.parse(readFileSync(GW_CONFIG_FILE, "utf8")).plan).toBe("go")
  })
  test("POST {token} 明文落盘 + GET 掩码返回（绝不返回明文）", async () => {
    const plain = mod.genToken()
    const p = new Request("http://127.0.0.1:8899/api/gateway/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: plain }),
    })
    const pr = await mod.handleWeb(p)
    expect((await pr.json()).needsRestart).toBe(true)
    expect(JSON.parse(readFileSync(GW_CONFIG_FILE, "utf8")).token).toBe(plain)
    const g = await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))
    const gj = await g.json()
    expect(gj.token).not.toContain(plain)
    expect(gj.token).toMatch(/^[0-9a-f]{4}\.\.\.[0-9a-f]{4}$/)
    expect(gj.authEnabled).toBe(true)
    expect(typeof gj.tokenSetAt).toBe("string")
  })
  test("POST {token:null} 清除（关鉴权）", async () => {
    const p = new Request("http://127.0.0.1:8899/api/gateway/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: null }),
    })
    const pr = await mod.handleWeb(p)
    expect((await pr.json()).needsRestart).toBe(true)
    const g = await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))
    const gj = await g.json()
    expect(gj.token).toBeNull()
    expect(gj.authEnabled).toBe(false)
  })
  test("POST 空 body（无 plan/token）→ 400", async () => {
    const p = new Request("http://127.0.0.1:8899/api/gateway/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    const res = await mod.handleWeb(p)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("至少提供")
  })
  test("GET /api/gateway/config 无 token → token null + authEnabled false + plan 正确", async () => {
    mod.writeGatewayConfig({ plan: "zen" })
    const g = await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))
    const gj = await g.json()
    expect(gj.plan).toBe("zen")
    expect(gj.token).toBeNull()
    expect(gj.authEnabled).toBe(false)
    expect(gj.needsRestart).toBe(false)
  })
})

describe("WEB_HTML 网关管理区块（主导航 + 套餐卡 + Token 卡）", () => {
  test("主导航区块（main-nav + 3 区块 id + switchNav + 主题按钮）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain('id="main-nav"')
    for (const b of ["keys", "settings", "stats"]) {
      expect(html).toContain('data-nav="' + b + '"')
      expect(html).toContain('id="nav-' + b + '"')
    }
    expect(html).not.toContain('data-nav="overview"')
    expect(html).not.toContain('data-nav="gateway"')
    expect(html).toContain("function switchNav(block)")
    expect(html).toContain('onclick="switchNav(\'keys\')"')
    /* 主题切换：按钮 + toggleTheme + localStorage 记忆 + 浅色变量覆盖 */
    expect(html).toContain('id="theme-btn"')
    expect(html).toContain("function toggleTheme()")
    expect(html).toContain('localStorage.getItem("gr-theme")')
    expect(html).toContain('html[data-theme="light"]')
  })
  test("套餐切换卡（gw-plan-card + 单选 + 保存函数 + plans 拉取）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain('id="gw-plan-card"')
    expect(html).toContain('id="plan-go"')
    expect(html).toContain('id="plan-zen"')
    expect(html).toContain('id="plan-apply"')
    expect(html).toContain('id="plan-meta"')
    expect(html).toContain('onclick="saveGatewayPlan()"')
    expect(html).toContain("async function saveGatewayPlan()")
    expect(html).toContain('api("/api/gateway/plans")')
    expect(html).toContain("async function refreshPlans()")
    expect(html).toContain('api("/api/gateway/restart", {})') // 保存后显式重启
  })
  test("Token 管理卡（gw-token-card + 5 操作函数 + 掩码/复制/清除）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain('id="gw-token-card"')
    expect(html).toContain('id="token-input"')
    expect(html).toContain('id="token-badge"')
    expect(html).toContain('onclick="genGatewayToken()"')
    expect(html).toContain('onclick="setGatewayToken()"')
    expect(html).toContain('onclick="copyToken()"')
    expect(html).toContain('onclick="toggleTokenMask()"')
    expect(html).toContain('onclick="clearGatewayToken()"')
    expect(html).toContain("async function refreshGatewayConfig()")
    expect(html).toContain("async function genGatewayToken()")
    expect(html).toContain("async function setGatewayToken()")
    expect(html).toContain("async function clearGatewayToken()")
    expect(html).toContain("async function copyToken()")
    expect(html).toContain("function toggleTokenMask()")
    expect(html).toContain('api("/api/gateway/config"')
    expect(html).toContain("crypto.getRandomValues") // 浏览器端 64 hex 生成
    expect(html).toContain("navigator.clipboard.writeText")
  })
})

describe("WEB_HTML 重构（IA + 设计系统 + P1 修复，2026-08-17）", () => {
  test("CSP 响应头存在（handleWeb 加固）", async () => {
    const mod = await import("../go-rotate.ts")
    const res = await (mod as any).handleWeb(new Request("http://127.0.0.1:8899/"))
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp.length).toBeGreaterThan(0)
    // 内联脚本/样式需要保留，但 base-uri/form-action/frame-ancestors 应禁
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
  })

  test("XSS 转义函数 esc 存在且旧拼接消失", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("function esc(") // 统一转义 &<>\"'
    expect(html).not.toContain("'<td>' + k.name + '</td>'") // 旧 innerHTML 拼接消失
  })

  test("空状态横幅 keys-empty 存在", async () => {
    const mod = await import("../go-rotate.ts")
    expect((mod as any).WEB_HTML).toContain('id="keys-empty"')
  })

  test("概览引导条 ov-hint 存在", async () => {
    const mod = await import("../go-rotate.ts")
    expect((mod as any).WEB_HTML).toContain('id="ov-hint"')
  })

  test("双列布局 class gw-config-grid + log-row 存在", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("gw-config-grid")
    expect(html).toContain("log-row")
  })

  test("网关日志卡容器 an-gwlog-card 存在", async () => {
    const mod = await import("../go-rotate.ts")
    expect((mod as any).WEB_HTML).toContain('id="an-gwlog-card"')
  })

  test("响应式媒体查询 @media 存在", async () => {
    const mod = await import("../go-rotate.ts")
    expect((mod as any).WEB_HTML).toContain("@media")
  })

  test("copyToken 一步化（旧「先显示」分支移除）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("async function copyToken()")
    expect(html).not.toContain("请先「显示/隐藏」查看明文后再复制")
  })

  test("概览只读化：冷却编辑下沉到设置（s-cooldown 之后仍有去设置跳链）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    const cooldown = html.indexOf('id="s-cooldown"')
    expect(cooldown).toBeGreaterThan(0)
    // 导航按钮的 switchNav 在顶部，概览区跳链在 s-cooldown 之后——从 s-cooldown 位置往后搜
    const after = html.indexOf(`onclick="switchNav('settings')"`, cooldown)
    expect(after).toBeGreaterThan(cooldown)
  })

  test("web 按钮迁移：web-on-btn 在设置区块（nav-settings 之后）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html.indexOf('id="web-on-btn"')).toBeGreaterThan(html.indexOf('id="nav-settings"'))
  })

  test("网关日志移入统计：gwlogview 在 nav-stats 之后", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html.indexOf('id="gwlogview"')).toBeGreaterThan(html.indexOf('id="nav-stats"'))
  })
})
