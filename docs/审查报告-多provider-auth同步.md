# 审查报告：auth.json 多 provider 共存下 syncAuth 的写入行为

- 审计日期：2026-08-16
- 审计方式：只读代码审查 + 隔离模拟验证（全部临时 AUTH_FILE / CONFIG_FILE，真实文件仅只读盘点）
- 审计范围：go-rotate.ts（插件）、zen-gateway/gateway.mjs（网关）、go-rotate（CLI）三套实现的 `syncAuth` 写路径
- 结论摘要：**syncAuth 不会破坏其它 provider 条目**（三套实现均为「读全量 → 只改 opencode-go.key → 全量写回」），两次脏 key 污染与 syncAuth 无关。发现 **0 HIGH / 2 MEDIUM / 3 LOW**，详见 §7。

---

## 1. 写逻辑分析（审计项 1）：部分更新，非整体覆盖 ✅

三套实现合并语义完全一致，均为「读全量 → 只改 `data["opencode-go"].key`（或新建 `{type:"api",key}`）→ 全量 `JSON.stringify` 写回」，**其它 provider 条目原样保留**：

| 实现 | 位置 | 合并逻辑 | 异常处理 |
|---|---|---|---|
| 插件 go-rotate.ts | L176-185 | `data["opencode-go"]` 存在且为对象 → 只改 `.key`；否则新建 `{type:"api",key}` | **无 try/catch**（抛错外泄） |
| 网关 gateway.mjs | L307-317 | 同上 | 有 try/catch（L314-316 静默） |
| CLI go-rotate | L105-118 | `isinstance(auth, dict)` → 只改 `["key"]`；否则新建 | 无 try/catch（Python 异常外泄） |

关键行号证据：
- 插件：`const auth = data["opencode-go"]; if (auth && typeof auth === "object") auth.key = key; else data["opencode-go"] = { type: "api", key }`（L178-183）
- 网关：同结构（L310-312）
- CLI：`if isinstance(auth, dict): auth["key"] = key; else: data["opencode-go"] = {"type": "api", "key": key}`（L111-115）

不存在「整体覆盖 auth.json」的路径。

## 2. 并发 / 多次写（审计项 2）：锁覆盖完整，1 处差异

### 2.1 锁保护：三套实现统一 `go-keys.json.lock`（跨进程互斥）✅

| 实现 | 锁 | 锁文件 | syncAuth 调用点 |
|---|---|---|---|
| 插件 | `withLockSync`（L103） | `CONFIG_FILE + ".lock"`（L44） | `rotate` L288、`manualRotate` L302、`setCurrent` L313 —— 均在 `mutateConfig`（withLockSync 包裹，L188-196）**锁内** ✅ |
| 网关 | `withLockAsync`（L189） | `CONFIG_FILE + ".lock"`（L59） | `rotate` L403 —— 在 `withLockAsync`（L379）**锁内** ✅ |
| CLI | `_with_lock`（L53） | `CONFIG_FILE + ".lock"`（L48） | `do_set` L160、`do_next` L177 —— 整体在锁内（L695/701）✅；**`do_init` L285 在锁外** ⚠️（见 LOW-4） |

插件、网关、CLI 的锁文件都是同一个 `go-keys.json.lock` → **跨进程（插件 ↔ 网关 ↔ CLI）互斥成立**，auth.json 的写操作在锁内串行化。

### 2.2 原子写：插件/网关 ✅，CLI ⚠️

- 插件 `atomicWrite`（L138-142）：`.tmp` + `renameSync` 原子 ✅，mode 0o600
- 网关 `atomicWrite`（L256-261）：同上 ✅，mode 0o600
- CLI `save()`（L97-102）：`.tmp` + `os.replace` 原子 ✅；**但 `sync_auth`（L116）用 `open(AUTH_FILE,"w")` 直写，非原子** ⚠️（见 LOW-3）

### 2.3 无锁竞态最坏情况（绕过锁直调 syncAuth 模拟）

10 次并发直调 `syncAuth`（不经过锁，构造读-改-写竞态）：**其它 provider 条目不丢失**（每次写都是全量快照，丢的只会是并发写者之间对同一 `opencode-go.key` 字段的更新）；`codeplan`/`fox-aws`/`extra_note` 全部保留，仅 `opencode-go.key` 可能回退为旧值。→ 即使锁失效，多 provider 也安全。

## 3. 多 provider 场景模拟验证（审计项 3）：3 组全 PASS ✅

构造 `auth.json`（codeplan + fox-aws + opencode-go 三 provider，codeplan 带扩展字段 `extra_note`）+ `go-keys.json`（act1/act2/act3 三 key）→ 各实现独立隔离执行：

| 模拟 | 执行 | 结果 |
|---|---|---|
| 插件 `setCurrent('act2')` | bun，GOROTATE_CONFIG_FILE/GOROTATE_AUTH_FILE 隔离 | opencode-go.key→act2；codeplan/fox-aws/extra_note 保留 ✅ |
| 插件 `rotate(429)` | 同上 | opencode-go.key→act3（act1 冷却、act2 为当前被冷却 → pickNext 选 act3，符合预期）；其它保留 ✅ |
| 网关 `syncAuth` 直调 + `rotate(429,'act1')` | node，ZEN_CONFIG/ZEN_AUTH_FILE 隔离 | opencode-go.key→act2；其它保留，权限 600 ✅ |
| CLI `set act2` + `next` | HOME 隔离 | opencode-go.key→act2→act3；其它保留，权限 600 ✅ |
| 并发 8×setCurrent（锁内） | bun | 三 provider 保留、key ∈ {act1,act2,act3} ✅ |
| 边界：`opencode-go` 条目为字符串 | bun | 正确重建为 `{type:"api",key}`，codeplan 保留 ✅ |

## 4. 真实 auth.json 盘点（审计项 4）

```
MD5: e4e9a727d22bc1535129f1b62fc9237c
顶层条目数: 1
  'opencode-go': type='api' key=sk-epyPd...bMx5   （掩码）
```

- 当前真实 auth.json **只有 opencode-go 一个 provider**，无 codeplan/fox-aws 共存（共存安全性由 §3 模拟验证）。
- 真实 go-keys.json：仅 `test` 一个 key（sk-epyPd...bMx5，current，无冷却/无 last_status），**无脏条目**（两次污染均已清理）。

## 5. 污染事件关联（审计项 5）：与 syncAuth 无关 ✅

两次脏 key 事件（name 为 opencode `Client` 对象、含 `serverUrl:http://localhost:4096/`、`worktree`）：

1. **结构不可能**：syncAuth 的输出永远是 `{"opencode-go": {"type":"api","key":"sk-..."}}` 或对现有 `opencode-go.key` 的字符串赋值——永不写顶层 `name` 字段、永不产生对象值条目、永不写其它 provider。脏条目（name=对象、无 key 字段）与 syncAuth 任何输出形态都不匹配。
2. **载体不同**：两次污染均发生在 **go-keys.json 的 keys 数组**（AGENTS.md 记录），syncAuth 只写 auth.json。
3. **写路径不同**：插件 addKey/updateKey 经 `loadConfig` 过滤（go-rotate.ts L150-152 `typeof k.name === "string" && typeof k.key === "string"`），网关同样过滤（gateway.mjs L270-272）→ 脏条目即使混入也被过滤，不参与轮换/注入，无实际危害；且插件/网关任何一次 saveConfig 写回都会**物理清除**脏条目（写过滤后结构）——污染持续存在说明写入方绕过插件直接写文件，疑似 opencode 环境把上下文对象序列化进配置（外部因素，非本项目代码）。

## 6. md5 铁证（模拟全程后真实文件）

```
auth.json    = e4e9a727d22bc1535129f1b62fc9237c  （模拟前一致 ✅，= §4 当前值）
go-keys.json = 70aa1342709e6cfc4141dbfd5c374260  （模拟前一致 ✅）
```

全部模拟使用隔离 env（GOROTATE_CONFIG_FILE/GOROTATE_AUTH_FILE / ZEN_CONFIG/ZEN_AUTH_FILE / HOME），真实文件未发生任何字节变化。临时目录 `/tmp/go-rotate-audit/` 审计后可清理。

## 7. 发现项分级

### 0 HIGH

无「破坏其它 provider / 数据损坏」类缺陷——核心结论：多 provider 共存下 syncAuth 安全。

### MEDIUM

**M-1 插件 event 钩子调用 rotate 无 try/catch + syncAuth 无 try/catch（go-rotate.ts L176-185 + L825）**
- 证据：`syncAuth` 直接 `JSON.parse`（L177）无保护；event 钩子 L825 `const cfg = rotate(...)` 无 try/catch。
- 实测：auth.json 损坏时插件 `rotate` 抛 `JSON Parse error`，异常外泄到 opencode 钩子；go-keys.json 不保存（saveConfig 在 mutateConfig 的 fn 之后）→ 轮换失效但两文件保持一致（保守回滚，属防御性）。
- 影响：auth.json 损坏/被并发写坏（罕见）时轮换静默失效 + 钩子异常；不影响其它 provider。
- 建议：syncAuth 包 try/catch（与网关对齐），rotate 内记录告警日志；event 钩子 L825 加 try/catch 防异常外泄。

**M-2 网关 rotate 中 syncAuth 失败静默且位于 saveConfig 之后（gateway.mjs L402-403 + L314-316）**
- 证据：L402 `saveConfig(cfg)` → L403 `syncAuth(next.key)`；syncAuth 内部 try/catch 静默（L314-316）。
- 实测：auth.json 损坏时网关 `rotate` 不抛错，go-keys.json 已保存新 current、auth.json 保持旧 key → **两文件短期不一致且无告警**（下次轮换/重启修正）。
- 影响：轮换当时实际未生效（opencode 仍用旧 key）；不一致是短期的。与插件路径（抛错回滚保一致）语义相反，两套实现行为不对称。
- 建议：syncAuth 失败时记 WARN 级日志（含「auth.json 与 go-keys.json 不一致」提示）；或改为先 syncAuth 后 saveConfig（与插件一致的全有或全无语义）。

### LOW

**L-3 CLI `sync_auth` 非原子写（go-rotate L116 `open(AUTH_FILE,"w")` 直写）**
- 与 CLI 自身 `save()`（L99-102 .tmp+os.replace）不一致；写中断（进程被杀）可能损坏 auth.json。单次小文件 write 在 macOS 基本原子，概率极低。
- 建议：改用 .tmp + os.replace 与 save() 对齐。

**L-4 CLI `do_init` 的 `sync_auth` 在 `_with_lock` 外（go-rotate L283-285）**
- L283 锁内只包 `save(cfg)`，L285 `sync_auth` 在锁外。初始化一次性场景，无并发窗口，风险极低。
- 建议：将 L283-285 合并进同一个 `_with_lock` 回调。

**L-5 `opencode-go` 条目为数组时 syncAuth 的边界行为**
- `typeof [] === "object"` 为 true → `auth.key = key` 会给数组对象加 `.key` 属性（不报错、不破坏其它条目，但后续读取得到「数组 + key 属性」怪异结构）；字符串/数字/null 会正确重建。
- 建议：条件改为 `auth && typeof auth === "object" && !Array.isArray(auth)`。

## 8. 审计建议汇总

1. （M-1）插件 `syncAuth` 加 try/catch + event 钩子 rotate 调用加 try/catch —— 对齐网关容错，防钩子异常外泄。
2. （M-2）统一两套实现的「syncAuth 失败语义」：或网关先 syncAuth 后 saveConfig，或失败时告警日志标明不一致。
3. （L-3/L-4）CLI 原子写 + init 锁范围修正 —— 一行级改动。
4. （L-5）数组边界防御 —— 一行级改动。
5. 建议为 auth.json 增加「写前备份」或「写后校验」（可选，非必需——atomicWrite + 锁已提供基本保护）。

## 附：审计验证证据文件

- 隔离模拟目录：`/tmp/go-rotate-audit/`（plugin/run.ts、gateway/run.mjs、plugin/concurrent.ts、三套 auth/go-keys 模板）
- 复现命令：`bun /tmp/go-rotate-audit/plugin/run.ts`、`node /tmp/go-rotate-audit/gateway/run.mjs`、`bun /tmp/go-rotate-audit/plugin/concurrent.ts`、`HOME=/tmp/go-rotate-audit/cli/home python3 go-rotate set act2`
