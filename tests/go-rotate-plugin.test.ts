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
  test("addKey/updateKey 强制 sk- 前缀", () => {
    seed(twoKeys())
    expect(() => mod.addKey("bad", "nope123")).toThrow('必须以 "sk-" 开头')
    expect(() => mod.addKey("ok1", "sk-ok")).not.toThrow()
    expect(() => mod.updateKey("a", { key: "not-sk" })).toThrow('必须以 "sk-" 开头')
    expect(() => mod.updateKey("a", { key: "sk-ok" })).not.toThrow()
    expect(() => mod.updateKey("bad", { key: "sk-ok" })).toThrow('不存在')
    const cfg = mod.loadConfig()
    expect(cfg.keys.find((x) => x.name === "ok1")?.key).toBe("sk-ok")
    expect(cfg.keys.find((x) => x.name === "a")?.key).toBe("sk-ok")
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
    // 网关功能测试：按钮 + JS 处理函数 + 结果消息区 + 后端路由调用
    expect(html).toContain('id="gw-test" onclick="gwTest()"')
    expect(html).toContain("async function gwTest()")
    expect(html).toContain('id="gw-test-msg"')
    expect(html).toContain('api("/api/gateway/test", {})')
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

describe("网关功能测试路由（POST /api/gateway/test，测试 env 网关不可达 → 优雅降级）", () => {
  test("网关不可达 → {ok:false} detail 含失败原因，不抛异常，status 200 传输层", async () => {
    const req = new Request("http://127.0.0.1:8899/api/gateway/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    const res = await mod.handleWeb(req)
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(typeof j.detail).toBe("string")
    expect(j.detail.length).toBeGreaterThan(0)
  })
})

/* ================= go + zen 双套餐模型动态查看（Web 面板 + 路由，隔离不可达网关降级） ================= */


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
  test("genGatewayToken 返回 sk- + 48 hex（51 字符）", () => {
    const t = mod.genGatewayToken()
    expect(t).toMatch(/^sk-[0-9a-f]{48}$/)
    expect(mod.genGatewayToken()).not.toBe(t) // 随机性：两次不同
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
  test("writeGatewayConfig token 写入 + token_set_at 记录（tokens 数组同步 + legacy token 字段）", () => {
    const t = mod.genGatewayToken()
    const c = mod.writeGatewayConfig({ token: t })
    expect(c.token).toBe(t)
    expect(c.tokens).toEqual([t]) // 单值写 → tokens=[v]（新多 key 布局）
    expect(typeof c.token_set_at).toBe("string")
    const raw = JSON.parse(readFileSync(GW_CONFIG_FILE, "utf8"))
    expect(raw.token).toBe(t)
    expect(raw.tokens).toEqual([t])
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
    const plain = mod.genGatewayToken()
    const p = new Request("http://127.0.0.1:8899/api/gateway/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: plain }),
    })
    const pr = await mod.handleWeb(p)
    expect((await pr.json()).needsRestart).toBe(true)
    const raw = JSON.parse(readFileSync(GW_CONFIG_FILE, "utf8"))
    expect(raw.token).toBe(plain)
    expect(raw.tokens).toEqual([plain])
    const g = await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))
    const gj = await g.json()
    expect(gj.token).not.toContain(plain)
    expect(gj.token).toMatch(/^.{4}\.\.\..{4}$/) // 掩码（前 4…后 4，不要求 hex 前缀匹配）
    expect(gj.tokens.length).toBe(1)
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
  test("POST /api/gateway/token gen → sk- 前缀追加进 tokens[]；del 按下标删；clear 全清", async () => {
    // gen：sk- 前缀 + 返回值含明文一次（后续 GET 仅掩码）
    const gen = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "gen" }) }),
    )
    const gj = await gen.json()
    expect(gj.ok).toBe(true)
    expect(gj.plain).toMatch(/^sk-[0-9a-f]{48}$/)
    expect(gj.needsRestart).toBe(true)
    const cfg1 = mod.readGatewayConfig()
    expect(cfg1.tokens).toEqual([gj.plain])
    // GET 绝不返回明文
    const gcfg = await (await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))).json()
    expect(gcfg.tokens[0]).not.toContain(gj.plain)
    expect(gcfg.token).toMatch(/^.{4}\.\.\..{4}$/)
    // 再 gen 第 2 个 → 数组 2 项
    const gen2 = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "gen" }) }),
    )
    const gj2 = await gen2.json()
    expect(mod.readGatewayConfig().tokens.length).toBe(2)
    // del 下标 0 → 剩 1 项（为第 2 个 key）
    const del = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "del", index: 0 }) }),
    )
    expect((await del.json()).ok).toBe(true)
    expect(mod.readGatewayConfig().tokens).toEqual([gj2.plain])
    // 非法下标 → 400
    const bad = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "del", index: 9 }) }),
    )
    expect(bad.status).toBe(400)
    // clear → 全清、鉴权关
    const clr = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "clear" }) }),
    )
    const cj = await clr.json()
    expect(cj.ok).toBe(true)
    expect(mod.readGatewayConfig().tokens.length).toBe(0)
    const g2 = await (await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))).json()
    expect(g2.authEnabled).toBe(false)
    // 未知 action → 400
    const unk = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "boom" }) }),
    )
    expect(unk.status).toBe(400)
  })
  test("POST /api/gateway/token action=get 返回单个明文（复制用）；非法下标 400", async () => {
    mod.writeGatewayConfig({ tokens: ["sk-aaaa", "sk-bbbb"] })
    const ok = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "get", index: 1 }) }),
    )
    const j = await ok.json()
    expect(j.ok).toBe(true)
    expect(j.plain).toBe("sk-bbbb")
    // 列表仍只回掩码（GET 不可见明文）
    const cfg = await (await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/config"))).json()
    expect(cfg.tokens[1]).not.toContain("sk-bbbb")
    // 越界/非法 index → 400
    for (const badIdx of [9, -1, "x"]) {
      const r = await mod.handleWeb(
        new Request("http://127.0.0.1:8899/api/gateway/token", { method: "POST", body: JSON.stringify({ action: "get", index: badIdx }) }),
      )
      expect(r.status).toBe(400)
    }
  })
})

describe("WEB_HTML 网关管理区块（主导航 + 套餐卡 + Token 卡）", () => {
  test("主导航区块（main-nav + 4 区块 id keys/tui/gateway/stats + switchNav + 主题按钮）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain('id="main-nav"')
    // 三域分离后 4 区块（关键管理/TUI/网关/统计）；原「3 区块」断言同步更新
    for (const b of ["keys", "tui", "gateway", "stats"]) {
      expect(html).toContain('data-nav="' + b + '"')
      expect(html).toContain('id="nav-' + b + '"')
    }
    expect(html).not.toContain('data-nav="overview"')
    expect(html).not.toContain('id="nav-settings"') // 原「网关与设置」区块已拆为 TUI + 网关
    expect(html).toContain("function switchNav(block)")
    expect(html).toContain('onclick="switchNav(\'keys\')"')
    /* 主题切换：右上角按钮 + 图标 + toggleTheme + localStorage 记忆 + 浅色变量覆盖 */
    expect(html).toContain('id="theme-btn"')
    expect(html).toContain('class="theme-toggle"')
    expect(html).toContain('class="page-head"')
    expect(html).toContain('id="theme-ico-sun"')
    expect(html).toContain('id="theme-ico-moon"')
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
  test("Token 管理卡（gw-token-card + token-list 多 key UI + 操作函数）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain('id="gw-token-card"')
    expect(html).toContain('id="token-badge"')
    // 多 key 列表容器 + 三个按钮（生成/设置/清空）
    expect(html).toContain('id="token-list"')
    expect(html).toContain('onclick="genGatewayToken()"')
    expect(html).toContain('onclick="setGatewayToken()"')
    expect(html).toContain('onclick="clearGatewayToken()"')
    expect(html).toContain("function renderTokenList(")
    expect(html).toContain("async function genGatewayToken()")
    expect(html).toContain("async function setGatewayToken()")
    expect(html).toContain("async function clearGatewayToken()")
    expect(html).toContain("async function delGatewayToken(") // 每行删除
    expect(html).toContain("async function copySessionPlain()") // 本次会话明文复制
    expect(html).toContain('onclick="copyGatewayToken(')       // 每个 key 行「复制」按钮
    expect(html).toContain("async function copyGatewayToken(") // 单 key 明文复制（action=get）
    // 操作走新多 key 后端 + 掩码列表 + 剪贴板
    expect(html).toContain('api("/api/gateway/token", { action: "gen" })')
    expect(html).toContain('api("/api/gateway/token", { action: "del", index:')
    expect(html).toContain('api("/api/gateway/token", { action: "clear" })')
    expect(html).toContain("renderTokenList(c.tokens || [])")
    expect(html).toContain("navigator.clipboard.writeText")
    // 旧单 token 输入框与旧生成函数已移除（不再引用不存在的元素）
    expect(html).not.toContain('id="token-input"')
    expect(html).not.toContain("crypto.getRandomValues")
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

  test("copySessionPlain 一步化（明文本会话持有即复制；旧「显示/隐藏」前置已移除）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("async function copySessionPlain()")
    // 明文只在本会话「生成/设置」后持有、一键复制，无先显示再复制的切换分支
    expect(html).not.toContain("async function copyToken()")
    expect(html).not.toContain("请先「显示/隐藏」查看明文后再复制")
  })

  test("概览只读化：冷却编辑下沉到 TUI 区块（s-cooldown 之后仍有去 TUI 跳链）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    const cooldown = html.indexOf('id="s-cooldown"')
    expect(cooldown).toBeGreaterThan(0)
    // 从 s-cooldown 位置往后搜 TUI 跳链（全局冷却窗口编辑已迁入 TUI zen 子区块）
    const after = html.indexOf(`onclick="switchNav('tui')"`, cooldown)
    expect(after).toBeGreaterThan(cooldown)
  })

  test("web 按钮迁移：web-on-btn 在网关区块（nav-gateway 之后）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html.indexOf('id="web-on-btn"')).toBeGreaterThan(html.indexOf('id="nav-gateway"'))
  })

  test("网关日志移入统计：gwlogview 在 nav-stats 之后", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    expect(html.indexOf('id="gwlogview"')).toBeGreaterThan(html.indexOf('id="nav-stats"'))
  })
})

/* =========================================================================
   网关使用方式 + 按钮双主题 —— Team A / B 并行改动协调断言（2026-08-17）
   -------------------------------------------------------------------------
   Team A：在 nav-settings 内 gw-usage-card 新增「使用方式」卡（id="gw-usage-card"），
           展示网关地址 + 三个配置块（curl / codex config.toml / claude code settings.json）
           + 每块复制按钮 + 复制函数（USAGE_TEXT / copyUsage(k) / copyText(txt,okMsg)）。
   Team B：为 :root 与 html[data-theme="light"] 引入按钮语义色变量（--btn-*），
           并将 button 规则改写为引用 var(--btn-...)，class 名 primary/danger/ghost/sm/loading 保持。

   本 describe 下四个 test 已全部【落地为活动断言】：
   - 前两个为契约锚点（类名保持 + 使用方式前置锚点），Team A/B 合入前后均稳定通过。
   - 后两个已按 Team A/B 实际实现命名对齐（2026-08-17 Team A/B 已合入 go-rotate.ts，
     命名核对：--btn-bd/--btn-fg/--btn-{primary,danger,success,ghost}-*、-hover- 前缀、
     spinner 用 --btn-*-spin/--btn-*-spin-top；copyUsage(k)/copyText/copyText、usage-*-text、
     占位 token "<ZEN_GATEWAY_TOKEN>"，codex 用 env_key 非 CODEX_HOME）。
   Paste-ready 版本见 docs/测试同步-网关使用方式与按钮主题.md §4。
   ========================================================================= */
describe("WEB_HTML Team A/B 并行断言（网关使用方式 + 按钮主题）", () => {
  test("按钮主题契约：语义类名保持（primary/danger/ghost/sm/loading）+ 变量基线", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    // Team B 契约：class 名不更名（只改配色实现，改按钮 CSS 主体不删类）
    for (const cls of [".primary", ".danger", ".ghost", ".sm", ".loading"]) {
      expect(html).toContain("button" + cls)
    }
    // 按钮通用规则（类无关）与语义变量体系基线：
    //   Team B 平移为 --btn-* 前，按钮底色/文字引用既有语义变量（--brand/--danger-soft/--tx-*/--bg-*），
    //   断言"是否引用 var(--" 前缀以确认按钮走收口变量而非硬编码色值。
    expect(html).toContain("button { font: inherit;")
    expect(html).toContain(":root")
    expect(html).toContain("--brand:")
    expect(html).toContain("button:hover {")
    expect(html).toContain("button:disabled, button[disabled] {")
  })

  test("使用方式前置锚点：网关地址 127.0.0.1:18888 + gw-config-grid 容器（Team A 插入点）", async () => {
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    // 网关地址已在内嵌管理页展示（网关管理卡行首）；Team A 的使用方式卡会再次复用该地址
    expect(html).toContain("127.0.0.1:18888")
    // 使用方式卡插入锚点：nav-gateway 内 gw-config-grid 之后
    // 注意：CSS 类规则 ".gw-config-grid {...}" 在 <head>（nav-gateway 之前），故用 DOM 类属性做位置匹配
    expect(html).toContain('class="gw-config-grid"')
    // 锚点关系：gw-config-grid 的 DOM 容器在 nav-gateway 块内（位置契约，Team A 不改序时不破坏既有定位断言）
    expect(html.indexOf('class="gw-config-grid"')).toBeGreaterThan(html.indexOf('id="nav-gateway"'))
  })

  test("使用方式配置展示卡（gw-usage-card + 三配置块 + 复制函数 + 位置）", async () => {
    // 契约命名核对（2026-08-17 已对齐 Team A 实际实现）：
    //   id="gw-usage-card" / USAGE_TEXT / copyUsage(k) / copyText(txt,okMsg) /
    //   usage-curl/codex/claude-text / 占位 token "<ZEN_GATEWAY_TOKEN>"
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    // 卡片 id
    expect(html).toContain('id="gw-usage-card"')
    // 网关地址（使用方式块与网关管理卡均复用 127.0.0.1:18888）
    expect(html).toContain("127.0.0.1:18888")
    // 三个配置块关键字（对应 docs/zen-gateway-clients.md）
    expect(html).toContain("curl")
    expect(html).toContain("config.toml")      // codex 客户端配置
    expect(html).toContain("settings.json")    // claude code 客户端配置
    expect(html).toContain('id="usage-curl-text"')
    expect(html).toContain('id="usage-codex-text"')
    expect(html).toContain('id="usage-claude-text"')
    // 客户端接入变量 / codex wire_api=responses（clients 指南关键项，无 CODEX_HOME 这个键）
    expect(html).toContain("ANTHROPIC_BASE_URL")
    expect(html).toContain("env_key")
    // 每块复制按钮 + 复制函数 + 占位 token（绝不拼真实 key/token）
    expect(html).toContain("function copyUsage(")
    expect(html).toContain("async function copyText(")
    expect(html).toContain("navigator.clipboard.writeText")
    expect(html).toContain("Bearer <ZEN_GATEWAY_TOKEN>")
    // 位置断言：使用方式卡在 nav-gateway 内（gw-token-card 之后、web-on-btn 之前）
    const settings = html.indexOf('id="nav-gateway"')
    const usage = html.indexOf('id="gw-usage-card"')
    const webOn = html.indexOf('id="web-on-btn"')
    expect(settings).toBeGreaterThan(0)
    expect(usage).toBeGreaterThan(settings)
    expect(usage).toBeGreaterThan(html.indexOf('id="gw-token-card"'))
    expect(usage).toBeLessThan(webOn)
  })

  test("按钮双主题变量（--btn-* 深/浅两套 + 按钮规则引用 var(--btn-...)）", async () => {
    // 契约命名核对（2026-08-17 已对齐 Team B 实际实现）：
    //   基础 --btn-bg/--btn-bd/--btn-fg（+ -hover），语义 --btn-{primary,danger,success,ghost}-*
    //   hover 用前缀 -hover-*（非后缀），spinner 用 --btn-*-spin / --btn-*-spin-top（非 --btn-spinner-*）
    const mod = await import("../go-rotate.ts")
    const html: string = (mod as any).WEB_HTML
    // 深色 :root 定义 --btn-* 变量族（核心语义色平移为按钮专用名）
    expect(html).toContain("--btn-bg:")
    expect(html).toContain("--btn-fg:")
    expect(html).toContain("--btn-bd:")
    expect(html).toContain("--btn-primary-bg:")
    // 浅色 html[data-theme="light"] 覆盖同一变量名（次序：:root 在前、light 覆盖在后）
    const root = html.indexOf(":root")
    const light = html.indexOf('html[data-theme="light"]')
    expect(root).toBeGreaterThan(0)
    expect(light).toBeGreaterThan(root)
    // 按钮规则不再硬编码色值，引用 var(--btn-...)（含基础/语义/hover/spinner）
    expect(html).toContain("button { font: inherit;")
    expect(html).toContain("var(--btn-bg)")
    expect(html).toContain("var(--btn-primary-bg)")
    expect(html).toContain("var(--btn-danger-fg)")
    expect(html).toContain("--btn-primary-hover-bg:")
    // 类名契约保持
    for (const cls of [".primary", ".danger", ".ghost", ".sm", ".loading"]) {
      expect(html).toContain("button" + cls)
    }
  })
})

/* ================= 使用方式卡（gw-usage-card，2026-08-17）================= */
describe("WEB_HTML 使用方式卡（gw-usage-card：地址 + 三配置块 + 一键复制）", () => {
  test("gw-usage-card 位于网关区块（nav-gateway 内、gw-config-grid 之后、设置卡之前）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain('id="gw-usage-card"')
    expect(html).toContain('id="usage-curl-text"')
    expect(html).toContain('id="usage-codex-text"')
    expect(html).toContain('id="usage-claude-text"')
    const usage = html.indexOf('id="gw-usage-card"')
    expect(usage).toBeGreaterThan(html.indexOf('id="nav-gateway"'))
    expect(usage).toBeGreaterThan(html.indexOf('id="gw-token-card"'))
    // 设置卡 <b>设置</b> 在使用方式卡之后
    expect(html.indexOf("<b>设置</b>", usage)).toBeGreaterThan(usage)
  })

  test("复制函数与示例常量存在（copyText/copyUsage/USAGE_TEXT），token 用占位符", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("var USAGE_TEXT")
    expect(html).toContain("function copyUsage(")
    expect(html).toContain("async function copyText(")
    expect(html).toContain("navigator.clipboard.writeText")
    expect(html).toContain("document.execCommand(\"copy\")") // 降级复制
    // 示例内一律用占位 token，绝不拼真实 key / 真实 token 值
    expect(html).toContain("Bearer <ZEN_GATEWAY_TOKEN>")
  })

  test("使用方式卡内容走 textContent 填充（无 innerHTML 拼接用户可控数据 = XSS 红线）", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("el.textContent = USAGE_TEXT[k]")
    expect(html).toContain("onclick=\"copyUsage('curl')\"")
    expect(html).toContain("onclick=\"copyUsage('claude')\"")
  })
})

/* ================= 双域独立轮换（TUI / 网关）— 2026-08-17 ================= */
describe("双域独立轮换（current_gateway / cooldown_until_gateway 域分离）", () => {
  test("setGatewayCurrent 写 current_gateway 不动 current；setCurrent 反向", () => {
    seed(twoKeys("a"))
    seedAuth({})
    // 网关域 set 绝不 syncAuth（网关域不碰 auth.json）：auth 保持初始空对象
    mod.setGatewayCurrent("b")
    let cfg = readCfg()
    expect(cfg.current).toBe("a")          // TUI 域不动
    expect(cfg.current_gateway).toBe("b")   // 网关域跟随
    expect(readAuth()).toEqual({})           // 铁证：网关 set 不动 auth.json
    // TUI 域 set 正常 syncAuth
    mod.setCurrent("b")
    cfg = readCfg()
    expect(cfg.current).toBe("b")          // TUI 域跟随
    expect(cfg.current_gateway).toBe("b")   // 网关域保持（不反向覆盖）
    expect(readAuth()["opencode-go"].key).toBe("sk-bbb") // TUI set 同步 auth
  })

  test("setGatewayCooldown 写 cooldown_until_gateway 不动 cooldown_until；null 清除各自域", () => {
    seed({ ...twoKeys("a"), current_gateway: "b" })
    mod.setGatewayCooldown("b", 60)
    let cfg = readCfg()
    expect(near(cfg.keys[1].cooldown_until_gateway!, 60)).toBe(true)
    expect(cfg.keys[1].cooldown_until).toBeNull() // TUI 域不动
    // TUI 域冷却独立
    mod.setCooldown("a", 30)
    cfg = readCfg()
    expect(near(cfg.keys[0].cooldown_until!, 30)).toBe(true)
    expect(cfg.keys[0].cooldown_until_gateway).toBeNull() // 网关域不动
    // 各自 clear
    mod.setCooldown("a", null)
    mod.setGatewayCooldown("b", null)
    cfg = readCfg()
    expect(cfg.keys[0].cooldown_until).toBeNull()
    expect(cfg.keys[1].cooldown_until_gateway).toBeNull()
  })

  test("loadConfig 旧配置（无 current_gateway）读侧兜底 current", () => {
    // twoKeys("b") 只写 current，无 current_gateway（旧配置形态）
    seed(twoKeys("b"))
    expect(mod.loadConfig().current_gateway).toBe("b")
    // 写回时保留（mutateConfig 往返不丢）并携网关域字段
    mod.mutateConfig((c: any) => { c.provider_id = "opencode-go" })
    const cfg = readCfg()
    expect(cfg.current_gateway).toBe("b")
  })

  test("reconcileCurrent 网关域自愈：current_gateway 指向不存在 → 兜底 current 后 keys[0]", () => {
    // 网关域越界（不像 TUI current）：回退 current
    const cfg0 = { current: "a", current_gateway: "zzz", keys: [{ name: "a", key: "k" }, { name: "b", key: "k2" }] } as any
    mod.reconcileCurrent(cfg0)
    expect(cfg0.current_gateway).toBe("a")
    // 网关域越界 且 TUI current 也越界 → 回退 keys[0]
    const cfg1 = { current: "zzz", current_gateway: "yyy", keys: [{ name: "a", key: "k" }, { name: "b", key: "k2" }] } as any
    mod.reconcileCurrent(cfg1)
    expect(cfg1.current).toBe("a")
    expect(cfg1.current_gateway).toBe("a")
  })

  test("statusPayload 含 current_gateway / isCurrentGateway / cooldown_until_gateway", () => {
    seed({ ...twoKeys("a"), current_gateway: "b" })
    const st = mod.statusPayload()
    expect(st.current).toBe("a")
    expect(st.current_gateway).toBe("b")
    expect(st.keys[0].isCurrent).toBe(true)
    expect(st.keys[0].isCurrentGateway).toBe(false)
    expect(st.keys[1].isCurrent).toBe(false)
    expect(st.keys[1].isCurrentGateway).toBe(true)
    // 每 key 暴露两个域冷却字段
    seed({ ...twoKeys("a"), current_gateway: "b", keys: [
      { name: "a", key: "sk-aaa", cooldown_until: new Date(Date.now() + 60_000).toISOString(), cooldown_until_gateway: null },
      { name: "b", key: "sk-bbb", cooldown_until: null, cooldown_until_gateway: new Date(Date.now() + 120_000).toISOString() },
    ] })
    const st2 = mod.statusPayload()
    expect(st2.keys[0].cooldown_until_gateway).toBeNull()
    expect(st2.keys[0].cooldown_until).toBeTruthy()
    expect(st2.keys[1].cooldown_until_gateway).toBeTruthy()
    expect(st2.keys[1].cooldown_until).toBeNull()
  })

  test("Web API：/api/current domain=gateway 写磁盘 current_gateway；缺省 domain 走 TUI 域", async () => {
    seed({ ...twoKeys("a") })
    // domain=gateway
    const gwReq = new Request("http://127.0.0.1:8899/api/current", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "b", domain: "gateway" }),
    })
    const gwRes = await mod.handleWeb(gwReq)
    expect(gwRes.status).toBe(200)
    let cfg = readCfg()
    expect(cfg.current).toBe("a")
    expect(cfg.current_gateway).toBe("b")
    // 缺省 domain（TUI 域，= 无 domain 参数，向后兼容）
    const tuiReq = new Request("http://127.0.0.1:8899/api/current", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a" }),
    })
    await mod.handleWeb(tuiReq)
    cfg = readCfg()
    expect(cfg.current).toBe("a")
    expect(cfg.current_gateway).toBe("b") // TUI set 不覆盖网关域
  })

  test("Web API：/api/cooldown domain=gateway 写磁盘 cooldown_until_gateway；null 清除各域", async () => {
    seed({ ...twoKeys("a"), current_gateway: "b" })
    const gw = async (minutes: number | null) =>
      await mod.handleWeb(new Request("http://127.0.0.1:8899/api/cooldown", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "b", minutes, domain: "gateway" }),
      }))
    await gw(60)
    let cfg = readCfg()
    expect(near(cfg.keys[1].cooldown_until_gateway, 60)).toBe(true)
    expect(cfg.keys[1].cooldown_until).toBeNull()
    // TUI 域（缺省 domain）
    await mod.handleWeb(new Request("http://127.0.0.1:8899/api/cooldown", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", minutes: 30 }),
    }))
    cfg = readCfg()
    expect(near(cfg.keys[0].cooldown_until, 30)).toBe(true)
    expect(cfg.keys[0].cooldown_until_gateway).toBeNull()
    // null 清除各域
    await mod.handleWeb(new Request("http://127.0.0.1:8899/api/cooldown", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", minutes: null }),
    }))
    await gw(null)
    cfg = readCfg()
    expect(cfg.keys[0].cooldown_until).toBeNull()
    expect(cfg.keys[1].cooldown_until_gateway).toBeNull()
  })

  test("WEB_HTML 三域 UI：Zen/Go/网关当前按钮 + 各自冷却 + 三域徽标 + 检查按钮", () => {
    const html: string = (mod as any).WEB_HTML
    // 「当前」拆三枚：Zen 使用（data-set，缺省 domain）/ Go 使用（data-set-go + domain:go）/ 网关使用（data-set-gw + domain:gateway）
    expect(html).toContain('data-set="')
    expect(html).toContain("Zen 使用")
    expect(html).toContain('data-set-go="')
    expect(html).toContain("Go 使用")
    expect(html).toContain('api("/api/current", { name: b.dataset.setGo, domain: "go" })')
    expect(html).toContain('data-set-gw="')
    expect(html).toContain("网关使用")
    expect(html).toContain('api("/api/current", { name: b.dataset.setGw, domain: "gateway" })')
    // 冷却三域：data-cooldown（zen）+ data-cooldown-go（domain=go）+ data-cooldown-gw（domain=gateway）
    expect(html).toContain("Zen 冷却")
    expect(html).toContain("Zen 清冷却")
    expect(html).toContain('data-cooldown-go="')
    expect(html).toContain('api("/api/cooldown", { name: b.dataset.cooldownGo, minutes: Number(b.dataset.min), domain: "go" })')
    expect(html).toContain('data-cooldown-gw="')
    expect(html).toContain('api("/api/cooldown", { name: b.dataset.cooldownGw, minutes: Number(b.dataset.min), domain: "gateway" })')
    // 徽标区分三域当前
    expect(html).toContain(">Zen 当前</span>")
    expect(html).toContain(">Go 当前</span>")
    expect(html).toContain(">网关当前</span>")
    // 徽标域色化：Zen 蓝 / Go 紫 / 网关青
    expect(html).toContain('badge b-zen">Zen 当前')
    expect(html).toContain('badge b-go">Go 当前')
    expect(html).toContain('badge b-gw">网关当前')
    // 健康列 ✓ 域色（zen 蓝 / go 紫）
    expect(html).toContain('healthCell(k.last_status, k.last_checked_zen, "b-zen")')
    expect(html).toContain('healthCell(k.last_status_go, k.last_checked_go, "b-go")')
    // 按钮分组（.grp 分隔线）与域色/语义色 class
    expect(html).toContain("actions .row .grp + .grp { padding-left: 9px; border-left: 1px solid var(--bd-2);")
    expect(html).toContain('<div class="actions">')
    expect(html).toContain('<div class="row">')
    expect(html).toContain('<button class="primary" data-check=')
    expect(html).toContain('<button class="zen" data-set=')
    expect(html).toContain('<button class="go" data-set-go=')
    expect(html).toContain('<button class="gw" data-set-gw=')
    expect(html).toContain('<button class="warn" data-cooldown=')
    expect(html).toContain('<button class="success" data-cooldown-go=')
    expect(html).toContain('<button class="ghost" data-window=')
    // 语义化按钮名：冷却窗口 / 清除窗口
    expect(html).toContain(">冷却窗口</button>")
    expect(html).toContain(">清除窗口</button>")
    // 域色按钮与徽标 CSS 变量（深/浅双主题）
    expect(html).toContain("--btn-zen-bg: rgba(96,165,250,.12)")
    expect(html).toContain("--btn-go-bg: rgba(167,139,250,.12)")
    expect(html).toContain("--btn-gw-bg: rgba(34,211,238,.12)")
    expect(html).toContain("--btn-warn-bg: rgba(251,191,36,.12)")
    expect(html).toContain("--btn-zen-bg: #e8f1fd")
    expect(html).toContain("--btn-go-bg: #f0ecfd")
    expect(html).toContain("--btn-gw-bg: #e5f9fc")
    expect(html).toContain("--btn-warn-bg: #fdf4e3")
    expect(html).toContain("button.zen { background: var(--btn-zen-bg);")
    expect(html).toContain("button.go { background: var(--btn-go-bg);")
    expect(html).toContain("button.gw { background: var(--btn-gw-bg);")
    expect(html).toContain("button.warn { background: var(--btn-warn-bg);")
    expect(html).toContain(".b-zen { background: var(--info-soft); color: var(--info); }")
    expect(html).toContain(".b-go  { background: var(--go-soft);    color: var(--go); }")
    expect(html).toContain(".b-gw  { background: var(--gw-soft);    color: var(--gw); }")
    // 双套餐健康列 + 每 key 检查按钮（domain:"all"）
    expect(html).toContain(">Zen 健康</th>")
    expect(html).toContain(">Go 健康</th>")
    expect(html).toContain('data-check="')
    expect(html).toContain('api("/api/keys/check", { name: b.dataset.check, domain: "all" })')
    // 手动轮换支持 domain（rotateDomain）：zen/go
    expect(html).toContain('onclick="rotateDomain(\'zen\')"')
    expect(html).toContain('onclick="rotateDomain(\'go\')"')
    expect(html).toContain('api("/api/rotate", { domain })')
    // 网关卡 gw-current 显示 statusPayload 网关域字段
    expect(html).toContain("(st && st.current_gateway)")
  })
})

/* ================= 三域分离 + 双套餐健康检查（2026-08-17）================= */
describe("provider 判定（isGoProvider / isZenProvider，注入分流核心）", () => {
  test("go 套餐：精确 opencode-go 或以其为后缀", () => {
    expect(mod.isGoProvider("opencode-go")).toBe(true)
    expect(mod.isGoProvider("xz/opencode-go")).toBe(true) // 带上下文前缀形态
    expect(mod.isGoProvider("opencode")).toBe(false)
    expect(mod.isGoProvider("codeplan")).toBe(false)
    expect(mod.isGoProvider("")).toBe(false)
  })
  test("zen 免费档：含 opencode 但非 go 套餐", () => {
    expect(mod.isZenProvider("opencode")).toBe(true)
    expect(mod.isZenProvider("opencode-free")).toBe(true)
    expect(mod.isZenProvider("opencode-go")).toBe(false)
    expect(mod.isZenProvider("codeplan")).toBe(false)
  })
})

describe("chat.headers 三域分流（zen/go/非 opencode）", () => {
  async function inject(pid: string) {
    const out = { headers: {} }
    await hooks["chat.headers"]({ model: { providerID: pid }, sessionID: "d3-" + Math.random() }, out)
    return out.headers.Authorization
  }
  test("go 套餐 -> 注入 go 域 current_go（current_go 与 current 不同时仍用 go 域）", async () => {
    seed({ ...twoKeys("a"), current_go: "b" })
    expect(await inject("opencode-go")).toBe("Bearer sk-bbb")
    expect(await inject("xz/opencode-go")).toBe("Bearer sk-bbb")
  })
  test("zen 免费档 -> 注入 zen 域 current（opencode / opencode-free）", async () => {
    seed({ ...twoKeys("a"), current_go: "b" })
    expect(await inject("opencode")).toBe("Bearer sk-aaa")
    expect(await inject("opencode-free")).toBe("Bearer sk-aaa")
  })
  test("非 opencode provider -> 不注入（红线），原 headers 保留", async () => {
    seed(twoKeys("a"))
    const out = { headers: { "x": "1" } }
    await hooks["chat.headers"]({ model: { providerID: "codeplan" }, sessionID: "d3c" }, out)
    expect(out.headers.Authorization).toBeUndefined()
    expect(out.headers.x).toBe("1")
  })
  test("go 域 current_go 缺省 -> 读侧兜底 current", async () => {
    seed(twoKeys("b")) // 无 current_go（旧配置形态）
    expect(await inject("opencode-go")).toBe("Bearer sk-bbb") // current_go ?? current = b
  })
})

describe("rotate 按域（zen 轮换不动 current_go；go 域不写 auth.json md5 铁证）", () => {
  test("go 域 rotate：写 cooldown_until_go/last_status_go/current_go，zen 域字段不动，auth 不写", () => {
    seed({ ...twoKeys("a"), current_go: "a" })
    seedAuth({ other: { type: "api", key: "keep" } })
    const authBefore = readFileSync(AUTH_FILE, "utf8")
    mod.rotate("quota exceeded: reset at 2026-08-16 08:00:00 +0800 CST", { data: { statusCode: 429, message: "quota" } }, "go")
    const cfg = readCfg()
    expect(cfg.current_go).toBe("b")                        // go 域切换
    expect(cfg.current).toBe("a")                            // zen 域不动
    expect(cfg.keys[0].cooldown_until_go).toBe("2026-08-16T00:00:00.000Z") // go 冷却写 go 域字段
    expect(cfg.keys[0].cooldown_until).toBeNull()            // zen 冷却不动
    expect(cfg.keys[0].last_status_go).toBe("limited")
    expect(cfg.keys[0].last_status ?? null).toBeNull() // zen 域健康字段未被写（缺省未归一化 = undefined/null）
    // md5 铁证：auth.json 逐字节不变（go 域不写 auth.json）
    expect(readFileSync(AUTH_FILE, "utf8")).toBe(authBefore)
  })
  test("zen 域 rotate：写 cooldown_until/current 并 syncAuth，go 域字段不动", () => {
    seed({ ...twoKeys("a"), current_go: "b" })
    seedAuth({})
    mod.rotate("quota", { data: { statusCode: 429 } }, "zen")
    const cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(cfg.current_go).toBe("b") // 预设不动
    expect(cfg.keys[0].cooldown_until).toBeTruthy()
    expect(cfg.keys[0].cooldown_until_go).toBeNull()
    expect(readAuth()["opencode-go"].key).toBe("sk-bbb") // zen 域写 auth
  })
  test("manualRotate 按域：go 域切 current_go 不写 auth；zen 域切 current 写 auth", () => {
    seed({ ...twoKeys("a"), current_go: "a" })
    seedAuth({})
    const authBefore = readFileSync(AUTH_FILE, "utf8")
    mod.manualRotate("go")
    let cfg = readCfg()
    expect(cfg.current_go).toBe("b")
    expect(cfg.current).toBe("a")
    expect(readFileSync(AUTH_FILE, "utf8")).toBe(authBefore) // go 域不写 auth
    mod.manualRotate() // zen 缺省
    cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(readAuth()["opencode-go"].key).toBe("sk-bbb")
  })
  test("pickNext 按域冷却字段筛选（cooldown_until_go 不阻塞 zen 域选择）", () => {
    const cfg = { current: "a", current_go: "a", keys: [
      { name: "a", key: "sk-aaa", cooldown_until_go: new Date(Date.now() + 60000).toISOString(), cooldown_until: null },
      { name: "b", key: "sk-bbb", cooldown_until: new Date(Date.now() + 60000).toISOString(), cooldown_until_go: null },
    ] } as any
    // zen 域：a 在 go 域冷却但 zen 域没冷却 -> 先看 b（zen 冷却）跳过，回绕到 a（zen 域可用）
    expect(mod.pickNext(cfg, "zen")?.name).toBe("a")
    // go 域：a 在 go 域冷却 -> 选 b（go 域可用）
    expect(mod.pickNext(cfg, "go")?.name).toBe("b")
  })
})

describe("event 钩子按域轮换（sessionProvider 记录 pid 判域）", () => {
  test("opencode 会话配额错误 -> zen 域轮换（current 变，current_go 不动）", async () => {
    seed({ ...twoKeys("a"), current_go: "b" })
    // 先注册 opencode（zen）会话
    await hooks["chat.headers"]({ model: { providerID: "opencode" }, sessionID: "ev-zen" }, { headers: {} })
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "ev-zen", error: { name: "APIError", data: { message: "quota", statusCode: 429, metadata: { url: "https://opencode.ai/zen/v1" } } } } } })
    const cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(cfg.current_go).toBe("b") // go 域不动
    expect(cfg.keys[0].cooldown_until).toBeTruthy()
    expect(cfg.keys[0].cooldown_until_go).toBeNull()
  })
  test("opencode-go 会话配额错误 -> go 域轮换，auth.json 铁证", async () => {
    seed({ ...twoKeys("a"), current_go: "a" })
    seedAuth({})
    const authBefore = readFileSync(AUTH_FILE, "utf8")
    await hooks["chat.headers"]({ model: { providerID: "opencode-go" }, sessionID: "ev-gos" }, { headers: {} })
    await hooks.event({ event: { type: "session.error", properties: { sessionID: "ev-gos", error: { name: "APIError", data: { message: "quota", statusCode: 429, metadata: { url: "https://opencode.ai/zen/go/v1" } } } } } })
    const cfg = readCfg()
    expect(cfg.current_go).toBe("b")
    expect(cfg.current).toBe("a")
    expect(readFileSync(AUTH_FILE, "utf8")).toBe(authBefore) // go 域轮换不碰 auth
  })
})

describe("probeKey 双端点 / checkAllKeys 双域写字段", () => {
  test("probeKey go 端点 hy3、zen 端点 hy3-free；200 -> ok", async () => {
    const calls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = async (url: any, opts: any) => {
      calls.push(String(url) + "|" + JSON.parse(String(opts.body)).model)
      return new Response(JSON.stringify({ choices: [] }), { status: 200 })
    }
    try {
      await mod.probeKey("sk-x", "go")
      await mod.probeKey("sk-x", "zen")
    } finally { globalThis.fetch = orig }
    expect(calls).toContain("https://opencode.ai/zen/go/v1/chat/completions|hy3")
    expect(calls).toContain("https://opencode.ai/zen/v1/chat/completions|hy3-free")
  })
  test("checkAllKeys 双端点写对应域 last_status + last_checked（mock fetch）", async () => {
    const orig = globalThis.fetch
    let n = 0
    globalThis.fetch = async () => {
      n++;
      if (n % 2 === 1) return new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 })
      return new Response(JSON.stringify({ choices: [] }), { status: 200 })
    }
    seed(twoKeys("a"))
    try {
      const res = await mod.checkAllKeys("all")
      expect(res["a"].zen?.status).toBe("limited")  // 第 1 次调用（zen）429
      expect(res["a"].go?.status).toBe("ok")        // 第 2 次调用（go）200
    } finally { globalThis.fetch = orig }
  })
})

describe("statusPayload 三域", () => {
  test("current_go / current_gateway + 每 key 三域字段", () => {
    seed({ ...twoKeys("a"), current_go: "b", current_gateway: "b", keys: [
      { name: "a", key: "sk-aaa", cooldown_until: null, cooldown_until_go: new Date(Date.now() + 60000).toISOString(), cooldown_until_gateway: null, last_status: null, last_status_go: "nobalance", last_checked_zen: null, last_checked_go: "2026-08-17T00:00:00.000Z" },
      { name: "b", key: "sk-bbb", cooldown_until: null, cooldown_until_go: null, cooldown_until_gateway: null, last_status_go: null },
    ] })
    const st = mod.statusPayload()
    expect(st.current).toBe("a")
    expect(st.current_go).toBe("b")
    expect(st.current_gateway).toBe("b")
    const a = st.keys.find((x: any) => x.name === "a")
    const bb = st.keys.find((x: any) => x.name === "b")
    expect(a.isCurrent).toBe(true)
    expect(a.isCurrentGo).toBe(false)
    expect(a.isCurrentGateway).toBe(false)
    expect(bb.isCurrentGo).toBe(true)
    expect(bb.isCurrentGateway).toBe(true)
    expect(a.cooldown_until_go).toBeTruthy()
    expect(a.last_status_go).toBe("nobalance")
    expect(a.last_checked_go).toBe("2026-08-17T00:00:00.000Z")
    expect(a.last_checked_zen).toBeNull()
  })
})

describe("Web API domain 矩阵（current/cooldown/rotate/check）", () => {
  const post = (route: string, body: any) => mod.handleWeb(new Request("http://127.0.0.1:8899" + route, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }))
  test("/api/current domain=go 写 current_go 不写 current 不写 auth；domain=gateway 写 current_gateway", async () => {
    seed({ ...twoKeys("a") }); seedAuth({})
    await post("/api/current", { name: "b", domain: "go" })
    let cfg = readCfg()
    expect(cfg.current).toBe("a")
    expect(cfg.current_go).toBe("b")
    expect(readAuth()).toEqual({}) // go 域不写 auth
    await post("/api/current", { name: "b", domain: "gateway" })
    cfg = readCfg()
    expect(cfg.current_gateway).toBe("b")
    // 缺省 domain -> zen
    await post("/api/current", { name: "a" })
    cfg = readCfg()
    expect(cfg.current).toBe("a")
    expect(cfg.current_go).toBe("b")
  })
  test("/api/cooldown domain=go 写 cooldown_until_go；null 清除各域", async () => {
    seed({ ...twoKeys("a"), current_go: "b" })
    await post("/api/cooldown", { name: "b", minutes: 60, domain: "go" })
    let cfg = readCfg()
    expect(near(cfg.keys[1].cooldown_until_go, 60)).toBe(true)
    expect(cfg.keys[1].cooldown_until).toBeNull()
    await post("/api/cooldown", { name: "b", minutes: null, domain: "go" })
    cfg = readCfg()
    expect(cfg.keys[1].cooldown_until_go).toBeNull()
  })
  test("/api/rotate domain=go 手动轮换 go 域；缺省 zen 轮换 zen 域（auth 仅 zen 写）", async () => {
    seed({ ...twoKeys("a"), current_go: "a" }); seedAuth({})
    const authBefore = readFileSync(AUTH_FILE, "utf8")
    await post("/api/rotate", { domain: "go" })
    let cfg = readCfg()
    expect(cfg.current_go).toBe("b")
    expect(cfg.current).toBe("a")
    expect(readFileSync(AUTH_FILE, "utf8")).toBe(authBefore)
    await post("/api/rotate", {})
    cfg = readCfg()
    expect(cfg.current).toBe("b")
    expect(readAuth()["opencode-go"].key).toBe("sk-bbb")
  })
})

describe("loadConfig 迁移兜底 / updateKey 三域跟随", () => {
  test("旧配置（无 current_go/cooldown_until_go/last_status_go）读侧归一化 + 兜底 current", () => {
    seed({
      provider_id: "opencode-go", cooldown_minutes: 300, current: "a", auto_web: false,
      keys: [{ name: "a", key: "sk-aaa", cooldown_until: null }],
    })
    const cfg = mod.loadConfig()
    expect(cfg.current_go).toBe("a") // 读侧兜底 current
    expect(cfg.keys[0].cooldown_until_go).toBeNull()
    expect(cfg.keys[0].last_status_go).toBeNull()
    expect(cfg.keys[0].last_checked_zen).toBeNull()
    expect(cfg.keys[0].last_checked_go).toBeNull()
    // mutateConfig 往返保留（写回不丢）
    mod.mutateConfig((c: any) => { c.provider_id = "opencode-go" })
    const cfg2 = readCfg()
    expect(cfg2.current_go).toBe("a")
  })
  test("updateKey 改名时 current_go 跟随（三域）", () => {
    seed({ ...twoKeys("a"), current_go: "a", current_gateway: "a" })
    mod.updateKey("a", { name: "a-renamed" })
    const cfg = readCfg()
    expect(cfg.current).toBe("a-renamed")
    expect(cfg.current_go).toBe("a-renamed")
    expect(cfg.current_gateway).toBe("a-renamed")
  })
  test("setGoCurrent 写 current_go 不动 current，不写 auth", () => {
    seed(twoKeys("a")); seedAuth({})
    mod.setGoCurrent("b")
    const cfg = readCfg()
    expect(cfg.current).toBe("a")
    expect(cfg.current_go).toBe("b")
    expect(readAuth()).toEqual({})
  })
  test("reconcileCurrent go 域自愈：current_go 指向不存在 -> 兜底 zen current 后 keys[0]", () => {
    const cfg0 = { current: "a", current_go: "zzz", keys: [{ name: "a", key: "k" }, { name: "b", key: "k2" }] } as any
    mod.reconcileCurrent(cfg0)
    expect(cfg0.current_go).toBe("a")
    const cfg1 = { current: "zzz", current_go: "yyy", keys: [{ name: "a", key: "k" }, { name: "b", key: "k2" }] } as any
    mod.reconcileCurrent(cfg1)
    expect(cfg1.current).toBe("a")
    expect(cfg1.current_go).toBe("a")
  })
})


describe("go + zen 双套餐模型动态查看（WEB_HTML 内嵌 + 路由降级）", () => {
  test("WEB_HTML 含双套餐模型渲染：Go/Zen plans 两栏 + 刷新按钮 + refreshGwModels", () => {
    const html: string = (mod as any).WEB_HTML
    expect(html).toContain("模型清单（go 与 zen 全部模型动态查看）")
    expect(html).toContain('onclick="refreshGwModels()"')
    expect(html).toContain('id="gw-models-refresh"')
    expect(html).toContain("function refreshGwModels()")
    expect(html).toContain('api("/api/gateway/models/refresh", {})')
    // 双套餐各自渲染分支（Go 订阅 / Zen 免费 + 当前套餐徽标）
    expect(html).toContain("Go 订阅")
    expect(html).toContain("Zen 免费")
    expect(html).toContain("当前套餐")
    expect(html).toContain("g.gwModels") // 渲染数据来自 gatewayStatus() 的 gwModels.plans
  })
  test("GET /api/gateway 不可达网关仍降级 running=false（gwModels/models 缺失）", async () => {
    const res = await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway"))
    const j = await res.json()
    expect(j.running).toBe(false)
    expect(j.gwModels).toBeUndefined() // 网关不可达 → /api/gateway/models 无 plans 结构
  })
  test("GET /api/gateway/models 网关不可达 → {ok:false, error}", async () => {
    const res = await mod.handleWeb(new Request("http://127.0.0.1:8899/api/gateway/models"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(typeof j.error).toBe("string")
  })
  test("POST /api/gateway/models/refresh 网关不可达 → {ok:false, error}（不抛异常）", async () => {
    const res = await mod.handleWeb(
      new Request("http://127.0.0.1:8899/api/gateway/models/refresh", { method: "POST", body: "{}" }),
    )
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.ok).toBe(false)
    expect(typeof j.error).toBe("string")
  })
})
