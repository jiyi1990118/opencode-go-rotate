# 梯子 IP 池 — 架构设计（只读分析，未改任何生产代码）

> 状态：设计稿（2026-08-19）。目标：为「梯子（ladder 本地 SOCKS5 透明代理）」新增**专用出口池** `ladder.egress`，支持增删 / 健康检查 / 与现有三池（主 egress・限流池・不可用池）双向转移，Web 一并管理。
> 基线：`go-rotate.ts`（4098 行）+ `zen-gateway/gateway.mjs`（2982 行）；gateway 单测 **257 PASS**、插件单测 **160 PASS（864 expect）** 实测全绿。
> 约束：本阶段只产出本设计文档。所有改动点仅作建议，实施需主线程按「需拍板决策」逐项确认后再动代码。

---

## 0. 现状速览（改动前必须理解）

| 件 | 位置 | 要点 |
|---|---|---|
| `GatewayConfig` 类型 | go-rotate.ts:1126-1141 | `egress/limited/dead` 顶层数组 + `ladder{enabled,port,mode,fixed}` 对象 + `ip_rotation` |
| `readGatewayConfig` | go-rotate.ts:1147-1185（ladder 归一 1170-1178）/ gateway.mjs:533-554（`normalizeLadderConfig` 521-529） | **两边语义必须一致**；gateway.mjs 版只归一网关运行时需要的字段（plan/token/tokens/egress/ip_rotation/ladder），**不含 limited/dead** |
| `writeGatewayConfig` | go-rotate.ts:1190-1281 | patch 白名单 `plan/token/tokens/egress/limited/dead/ladder/ip_rotation`；ladder 分支 1245-1258 用 patch 字段**重建** ladder 对象 |
| `validateEgressItem` | go-rotate.ts:1316-1328 | 四池统一格式：`"direct"` 或 `"socks5://[user:pass@]host:port"` |
| `gatewayConfigPayload` | go-rotate.ts:1296-1313 | `ladder: cfg.ladder` 原样透传（加字段自动可见，**无需新增顶层键**） |
| egress 路由 | go-rotate.ts:1607-1764 | 11 个 action：add/del/clear/set/toggle/bulk-add/move-to-limited/restore/set-limited/move-to-dead/restore-dead/set-dead |
| ladder 路由 | go-rotate.ts:1474-1509 + 网关 gateway.mjs:2588-2613 | `GET /api/gateway/ladder`（状态）、`POST ?action=set|apply|stop`、`POST /api/gateway/ladder/check`（科学上网筛选） |
| `ladderNextEgress` | gateway.mjs:996-1003 | **当前从 `egressList()`（主池）轮换 `_egressIdx`**；fixed 模式取 `c.fixed` |
| `egressHealthCheck` | gateway.mjs:905-952 | `(onlyIndex, expectUrl)` 单 URL 探测 → go-rotate.ts:858 `gatewayEgressHealthProxy(expectUrl)` 代理；CHK_CONC=5 并发 |
| Web 梯子卡 | go-rotate.ts:2560-2596 + `renderLadderState` 3711-3748 / `refreshLadder` 3773-3787 / `ladderCollectConfig` 3788-3795 / `ladderSave` 3796-3814 / `ladderToggle` 3815-3835 / `ladderSurfCheck` 3836-3863 | 全局 `ladderState = {enabled,port,mode,fixed,running}`（3710）；`ladderSurfCheck` 调 ladder/check 空 urls → 网关测**主池** |
| 四池管理 Web | go-rotate.ts:2460-2512（egress/limited/dead 卡）+ 3204-3560（各 render/check/transfer 函数） | `currentEgressList` 3206 / `deadList` 3211 / `deadHealth`/`limitedHealth` 按 url 缓存；单向转移按钮集已就位 |
| 测试 harness | 网关 run-tests.mjs `t()` 不 await（57 行），async 必须走顶层块真 await（plan-zen-map 模式 247-285 行示范）；插件测试直接 `await mod.handleWeb(...)` | 基线前已核实 |

**关键既有语义（必须保持）**：
- 梯子 rotate 每**连接**轮换、**不依赖** `ip_rotation`/`egressEnabled()`（当前直接读 `egressList()`）；fixed 模式完全绕过池。
- gateway.mjs `readGatewayConfig` 是**只读 + 归一**纯函数，绝不写文件。
- 四池项格式统一走 `validateEgressItem`；move 类动作「从源池移除 + 目标池去重加入」，源池无此项则跳过（见 move-to-dead:1713-1736）。

---

## 1. 数据模型演进

### 1.1 最终形态（推荐：扩展 ladder 对象，与用户建议一致）

```jsonc
// gateway-config.json（ladder 字段最终形态）
{
  "ladder": {
    "enabled": false,                 // 现状
    "port": 10880,                    // 现状
    "mode": "rotate",                 // 现状
    "fixed": "socks5://...",          // 现状，mode=fixed 时必填
    "egress": [                       // ★ 新增：梯子专用出口池
      "socks5://139.196.95.28:7890",
      "socks5://user:pass@1.2.3.4:1080"
    ]
  }
}
```

- **项格式**：与主池完全一致（`validateEgressItem`，允许 `"direct"`）。运行时 `ladderNextEgress` 过滤 `type==="socks5"`（`direct` 不留参与轮换）——保证「direct 可从主池无条件转移到梯子池、不产生写入失败」的转移矩阵一致性（见 §3）。
- **缺省 = `[]`**：`ladder.egress` 缺失 / 非数组 / `null` 一律归一为 `[]`（零迁移）。

### 1.2 为什么扩展 ladder 对象（而非顶层 `ladder_egress`）

1. **内聚**：梯子的一切（生命周期 + 出口池）收于一个对象；与
   `backend` 现状 `{enabled,port,mode,fixed}` 形同直线扩展。
2. **向后兼容天然**：旧配置 `{enabled,port,mode,fixed}` 只需读侧把
   缺失 `egress` 归一为 `[]`，**无需版本号、无启动重写、无 migration**。
3. **转移矩阵语义自然**：`from:"ladder"` 从 `cfg.ladder.egress` 取数，路径统一。
4. 顶层 `ladder_egress` 会把梯子概念劈成两半，且 `writeGatewayConfig` patch
   白名单要多一个顶层键，读写两侧归一更难保持一致。

### 1.3 读写两侧字段归一一致性方案

**gateway.mjs（`normalizeLadderConfig` 521-529 扩展）**：
```js
function normalizeLadderConfig(raw) {
  if (!raw || typeof raw !== "object") return null
  return {
    enabled: raw.enabled === true,
    port: Number.isInteger(raw.port) && raw.port > 0 ? raw.port : 10880,
    mode: raw.mode === "fixed" ? "fixed" : "rotate",
    fixed: typeof raw.fixed === "string" && raw.fixed ? raw.fixed : null,
    egress: Array.isArray(raw.egress)
      ? raw.egress.filter((e) => typeof e === "string" && e.length > 0)
      : [],                                   // ★ 新增：缺失/非数组 → []
  }
}
```
`readGatewayConfig`（533-554）与 `ladderConfig`（969-977）沿用即可自动带出。

**go-rotate.ts**：
- `GatewayConfig` 类型（1126-1141）：`ladder` 增加 `egress: string[]`。
- `defaultGatewayConfig`（1143-1145）：`ladder: null` 不变（null 分支天然无 egress）。
- `readGatewayConfig`（1170-1178）：ladder 归一对象增加
  `egress: Array.isArray(raw.ladder.egress) ? raw.ladder.egress.filter((e): e is string => typeof e === "string" && e.length > 0) : []`。
- `writeGatewayConfig` ladder 分支（1245-1258）三处改动：
  1. patch 类型加 `egress?: string[] | null`。
  2. **`l.egress === undefined` 时保留现值**（`cfg.ladder?.egress ?? []`）——这是
     Web 既有 `ladderSave()`（只发 `{enabled,port,mode,fixed}`）+ `action:"set"` 路径
     的**兼容红线**：不让「保存梯子设置」误清空梯子池。
  3. 显式 `egress` 时按 `validateEgressItem` 校验（同 egress/dead/limited 分支，
     非法 → throw，消息前缀 `ladder.` 命中 1487 路由的 400 正则）。

**两侧一致性要求**：main pool 读侧 go-rotate.ts:1161-1163 只 filter 非空字符串不校验格式；
梯子池两端同样只 filter 非空字符串（**格式校验只在写入端 writeGatewayConfig/ladder 分支做**），
与 egress/limited/dead 行为完全对齐。gateway.mjs 侧无写端、天然只归一不校验。

---

## 2. 后端 API 清单（精确契约）

### 2.1 网关侧（gateway.mjs，运行时）—— 改动最小

| 项 | 建议 | 说明 |
|---|---|---|
| `normalizeLadderConfig` + `ladderConfig` | 加 `egress` 归一（§1.3） | 梯子池成为旋转数据源 |
| `ladderNextEgress` | 重写优先级链（§4） | **绝对核心改动** |
| `let _ladderIdx = 0` | 新增模块级计数器 | 与 `_egressIdx`（845）隔离，梯子轮换不扰动网关 HTTP 轮换序列（理由见 §4） |
| `ladderStatus`（980-992） | 响应加 `egress: currentLadderPool`（归一后的梯子池项） | 可观测性；go-rotate 侧仍以读配置为准，此项仅 E2E/未来网关直查 |
| `egressHealthCheck`（905-952） | 签名扩为 `(onlyIndex=null, expectUrl=null, explicitList=null)`；`explicitList` 非空 → `list = parseEgressList(explicitList)` | 供「按任意列表探测」（梯子池/勾选项批量）复用，**无需新健康端点** |
| `POST /api/gateway/egress/health`（2572-2587） | body `{urls?: string[]}` → 传给 explicitList | 当 body urls 存在时优先于 query url/index |
| 启动自动拉起梯子 | 2728-2730 不变 | 梯子池动态读，无需重启 |

**不新增任何网关路由**。科学上网筛选 `POST /api/gateway/ladder/check` 保持（§5 说明与健康检查的职责分工）。

### 2.2 Web 代理侧（go-rotate.ts）路由契约

#### A. `GET /api/gateway/config`（既有，1296-1313）
`ladder` 字段自动包含 `egress: string[]`（readGatewayConfig 归一后透传）。**无新增顶层键**，既有断言全保持。

#### B. `GET /api/gateway/ladder`（既有，1474-1476 / 893-904）
响应**追加**（additive，非破坏）：
```jsonc
{
  "ok": true,
  "enabled": false, "port": 10880, "mode": "rotate", "fixed": null,
  "running": false, "conns": 0,
  "egress": ["socks5://139.196.95.28:7890"],   // ★新增：梯子池（配置侧权威，readGatewayConfig().ladder?.egress ?? []）
  "egressCount": 2                              // 语义不变：网关侧 socks5 计数（含回退链，见 §4）
}
```
（`egressCount` 字段名保留避免破坏既有 `ladderState.egressCount` 消费；Web 改用 `egress.length` 展示梯子池大小。）

#### C. `POST /api/gateway/ladder`（既有，1477-1500）
- `{action:"set", ladder:}`：**既有行为不动**（只发四字段时梯子池保留现值，见 §1.3）。
- `{action:"stop"}` / `{action:"apply"}`（缺省）：不变。

#### D. `POST /api/gateway/egress` —— 梯子池管理 + 四池转移（核心）

**`pool` 判别子字段**（沿用 `/api/current {domain}`、`/api/cooldown {domain}`
同款风格）：既有动作 `add/bulk-add/del/clear/set` 增加可选
`pool?: "egress"|"limited"|"dead"|"ladder"`（**缺省 `"egress"` = 现状零变化**）。

| action | 请求体 | 语义 | 响应 |
|---|---|---|---|
| `add` (既有扩展) | `{url, pool?}` | 单项加入指定池（已存在 → 400） | `{ok:true, pool, items:[...], needsRestart:false}` |
| `bulk-add` (既有扩展) | `{urls, pool?}` | 批量去重加入（非法/已存在 skipped 报告） | `{ok:true, added, skipped:{url,reason}[], pool, items}` |
| `del` (既有扩展) | `{index, pool?}` | 按下标删（越界 → 400） | `{ok:true, pool, items}` |
| `clear` (既有扩展) | `{pool?}` | 清空指定池 | `{ok:true, pool, items:[]}` |
| `set` (既有扩展) | `{list, pool?}` | 整池重设（=set-limited/set-dead 通用版；web 删除单项场景用） | `{ok:true, pool, items}` |
| ★`transfer` | `{from, to, urls}` | **四池间定向批量转移**（矩阵见 §3） | `{ok:true, moved, skipped, from, to, poolCounts:{...}}` |

`toggle` 不动（仅 ip_rotation）。`move-to-limited/restore/set-limited/move-to-dead/restore-dead/set-dead`
**原样保留**（现有 3 池 UI + 测试零改动），可视为 transfer 的固化别名。

**响应统一规则**：受影响池列表以 `items`（梯子池）/既有键 `egress/limited/dead` 双写
（既有 FE 读 `r.limited` 等继续工作）；必要时 FE 重新 `GET /api/gateway/config` 拿权威态
（现有 moveToLimited 已如此）。

#### E. `POST /api/gateway/egress/health`（既有，1464-1472 / go-rotate.ts 代理 858-877）
请求体增加 `{urls?: string[]}`：
- 无 urls → 现状（全主池或 `{url}` 单项）。
- 有 urls → **按该列表探测**（网关注入 explicitList）。梯子池「健康检查」与勾选批量复测走这。

---

## 3. 转移矩阵（四池互转）

### 3.1 支持方向

```
                ┌────────────┐
                │  梯子池      │  ladder.egress
                └─────┬──────┘
              transfer│    ↑
        ┌─────────────┼───────────────┐
        ▼             ▼               ▼
   ┌─────────┐  ┌─────────┐   ┌──────────┐
   │ 主 egress│  │ 限流池   │   │ 不可用池   │
   └─────────┘  └─────────┘   └──────────┘
```

`transfer {from, to, urls}` 覆盖全部 **4 × 3 = 12 条**有向边，`from ≠ to`。

### 3.2 语义（移植 move-to-dead 1713-1736 的既有约定）

1. 每个 url 过 `validateEgressItem` → 非法**跳过**（计入 skipped，reason:"格式非法"）。
2. url 不在 `from` 池 → **跳过**（reason:"不在源池"，不凭空造）；项去重（Set）。
3. 在源池 → 从 `from` 移除；若 `to` 池已含 → 不重复加入（目标池天然去重）。
4. 任一池为空数组即可作为合法 from/to（`[]` 不报错，moved=[]）。
5. `from === to` → 400 `"from 不能等于 to"`。
6. 写锁：**单次** `writeGatewayConfig` 原子完成「多池同更」（与 move-to-dead 单锁多字段同款）。
7. 非数组/空 urls → 400（对齐现有 move 类）。

### 3.3 返回

```jsonc
{ "ok": true, "from":"egress", "to":"ladder",
  "moved": ["socks5://..."], "skipped": [{"url":"http://bad:80","reason":"格式非法"}, {"url":"socks5://7.7.7.7:1080","reason":"不在源池"}],
  "poolCounts": { "egress":4, "ladder":2, "limited":0, "dead":1 },
  "needsRestart": false }
```

### 3.4 写实现（参考，归属 /api/gateway/egress 路由内的私有 helper）

```ts
function ladderPatchFor(list: string[]): any {
  const cur = readGatewayConfig()
  const l = cur.ladder ?? { enabled: false, port: 10880, mode: "rotate", fixed: null }
  return { ladder: { ...l, egress: list } }      // 保留 enabled/port/mode/fixed
}
// transfer 内部按 from/to 组装，用 Set 读四池现值，一次 writeGatewayConfig 写合并后的多个池
```

---

## 4. 梯子出口选择优先级链（ladderNextEgress 新逻辑）

```js
let _ladderIdx = 0                        // 新增独立计数器（与 _egressIdx 隔离）

function ladderNextEgress() {
  const c = ladderConfig()                // 现含 egress（§1.3 归一）
  if (c.mode === "fixed" && c.fixed) return parseSocks5Url(c.fixed)   // 固定出口永远优先，绕过一切池
  const ladder = parseEgressList(c.egress || []).filter((e) => e.type === "socks5")
  const main = egressList().filter((e) => e.type === "socks5")
  const pool = ladder.length ? ladder : main                            // 优先级：梯子池 → 主池
  if (!pool.length) return null                                         // 都空 → 直连兜底（现状 1156-1166）
  _ladderIdx = (_ladderIdx + 1) % pool.length
  return pool[_ladderIdx]
}
```

**为什么独立 `_ladderIdx`（不能继续共享 `_egressIdx`）**：
- 梯子每连接调用一次 → 高频推进计数器；若与网关 HTTP 出口轮换共用 `_egressIdx`，
  梯子流量会**打乱主池轮换的有序性**（429 后 `rotateEgress` 期望「下一出口」，却被梯子先消耗掉），
  且主池/梯子池为不同长度时下标语义错乱。独立计数值得两套轮换互不干扰，行为可测、可控。
  （AGENTS 记录的「共享 _egressIdx」原设计只有在单池时才合理，梯子池引入后必须拆分。）

**行为保持**：
- fixed 模式完全不变（不 consult 任何池）——梯子池仅影响 rotate 模式。
- **不依赖** `egressEnabled()`/`ip_rotation`（与现状一致：梯子在各套餐下都直接读池）。
- 回退主池为空时积分 `connectLadderUpstream` 1150-1193 的「直连兜底 + 坏出口顺延 ≤3 次」
  链路原样工作（ladderNextEgress 每次 attempt 重算，池内轮换天然提供「顺延下一出口」）。

**边界用例（实施者自测）**：
- `ladder.egress=["direct"]` → 过滤后空 → 回退主池。
- 梯子池有项但全是不可达 → 顺延链在**梯子池内**轮换（不会跳去主池）；池 >1 才开启顺延（现状 1184）。
- 梯子池项数=1 + 主池项数=3 → rotate 恒返回唯一梯子项，不回退主池（池非空即锁死优先级）。

---

## 5. 健康检查复用（不新增端点）

### 5.1 职责划分

| 探测类型 | 现在 | 梯子池后 | 语义 |
|---|---|---|---|
| **轻量健康检查**（隧道通 + 上游限流判别，~1 token/项） | `POST /api/gateway/egress/health`（`{url}` 单项或 `?index`） | **复用同一端点 + `{urls}` 列表** | 「检查所有 IP 健康度」「梯子池健康检查」等 Web 批量按钮 |
| **科学上网筛选**（google/youtube CONNECT + ip-api 出口归属，慢、零 token） | `POST /api/gateway/ladder/check` | 不变，允许 `{urls: 梯子池}` | 「可科学上网/归属地」此类墙外能力判别 |

### 5.2 复用改造点（最小）

1. gateway `egressHealthCheck` 增加第三参 `explicitList`：
   `explicitList != null && explicitList.length > 0` → `list = parseEgressList(explicitList)`，
   覆盖默认「主池 / 单 URL」两个旧入口；**CHK_CONC=5 并发、顺序保持、超时语义全部沿用**。
2. gateway 路由 `POST /api/gateway/egress/health`：读 body `urls` → 传 explicitList。
3. go-rotate.ts `gatewayEgressHealthProxy(expectUrl?, urls?)`（858-877）透传 body `{urls}`；
   Web `checkAllHealth()` 可加 pool 参数复用同一函数。

### 5.3 Web 展示

梯子池健康结果缓存 `ladderEgressHealth = { [url]: {ok,status,ms,error} }`（对应 429 → 徽标「仍限流 429」，与 limited/dead 卡一致），可勾选批量转移。

---

## 6. 兼容红线（地块不可破坏）

1. **既有 3 池 UI + 梯子卡测试零改动可过**：所有既有 id / 函数名 / action 路由原样保留；
   新增均是 additive（响应加字段、action 加可选 pool、ladder 对象加 egress）。
2. **零迁移**：旧 `ladder:{enabled,port,mode,fixed}` → 读侧 `egress: []`，无版本号、无启动重写、无安装脚本改动。
3. **`ladderSave()/ladderToggle()` 不改也能保住梯子池**：`writeGatewayConfig` 梯子分支
   `l.egress === undefined → 保留现值`（§1.3 关键点，必须有回归测试锁死）。
4. `gatewayConfigPayload` 不新增顶层键；`GET /api/gateway/ladder` 只增 `egress` 字段。
5. `writeGatewayConfig` 错误消息保持 `ladder.` 前缀（路由 1487 的 400 正则依赖）。
6. **测试铁律**：一切写路径测试走 `GOROTATE_CONFIG_FILE/GOROTATE_GATEWAY_CONFIG/ZEN_GATEWAY_CONFIG`
   临时隔离；网关新用例必须遵守「`t()` 只收同步 fn，async 用顶层块真 await + 手动 passed++ 计数」
   harness 规矩（run-tests.mjs:247-285 为范本）。
7. gateway.mjs `readGatewayConfig` 仍为纯只读函数（不改其「绝不写文件」契约）。

---

## 7. 测试计划

### 7.1 网关单测（zen-gateway/tests/run-tests.mjs，当前 257 → 预计 +13 ~ +15）

用现有「写临时 `_gwCfgPath` → 读」模式（参考 2156-2201）：

| 组 | 用例 | 类型 |
|---|---|---|
| normalizeLadderConfig | egress 数组归一 / 非数组→[] / 缺失→[] / 含空串过滤 / 含 garbage 混合 | t() 同步 |
| readGatewayConfig/ladderConfig | ladder.egress 读归一；旧形态 zero-migration → egress [] | t() 同步 |
| ladderNextEgress 优先级链 | ①梯子池非空命中梯子池（主池在场也回梯子）②梯子池空回退主池 ③全空→null ④fixed 字段存在绕过池 ⑤`["direct"]` 梯子池 ≈ 空 ⑥双项轮换交替（独立 `_ladderIdx`，断言两次调用分别命中两项 / 主池项绝不出现） | t() 同步（纯读配置） |
| _ladderIdx 隔离 | 连续调用后 `egressSnapshot().index` 不动（未扰动主池计数器） | t() 同步 |
| egressHealthCheck explicitList | 传 third param 列表 → 返回条目与列表一一对应（临时 ZEN_CONFIG 无 key 时按现有错误路径断言结构） | `t()` 同步 或顶层块（若需 await import 用真 await 顶层块） |
| applyLadder 回归 | 不变（梯子池不影响启动） | 既有组补 1 |

### 7.2 插件单测（tests/go-rotate-plugin.test.ts，当前 160 → 预计 +9 ~ +11）

全部 `await mod.handleWeb(...)`，配置走临时 `GW_CONFIG_FILE`：

| 用例 |
|---|
| `writeGatewayConfig({ladder:{...,egress:[...]}})` 持久化 + `readGatewayConfig` roundtrip + `GET /api/gateway/config` payload 的 `ladder.egress` |
| **`action:"set"` ladder 不带 egress → 梯子池保留**（兼容红线，锁死 #6） |
| `action:"set" ladder {egress:null}` → 清池；`ladder:null` → 整体清 | 
| ladder patch egress 含非法项 → 400（错误消息 `ladder.egress` 前缀） |
| `egress {action:"add",pool:"ladder"}` / `bulk-add`（非法+已存在 skipped）/ `del` 越界 400 / `clear` / `set` 整池重设 |
| `egress {action:"transfer", from:"egress"→"ladder" | "limited"→"ladder" | "dead"→"ladder" | "ladder"→"egress" | "ladder"→"dead"}` 全向抽查；from===to→400；urls 非数组→400；不在源池跳过；目标池去重 |
| `egress/health` body `{urls}` 透传（网关不可达 → `{ok:false,error}` 不抛） |
| WEB_HTML 断言：梯子池卡 id（如 `ladder-egress-list` / `ladder-egress-health-btn` / `ladder-egress-add-btn`）+ 新函数（`renderLadderEgress` / `ladderEgressHealthCheck` / `ladderEgressTransfer` / `ladderEgressTransferSel` 等）+ 已有梯子卡 9 个断言（1333-1348）不回归 |

### 7.3 复验链（实施后执行）

1. `cd zen-gateway/tests && node run-tests.mjs` → 全 PASS
2. `bun test tests/go-rotate-plugin.test.ts` → 全 PASS
3. `bun build go-rotate.ts` + 渲染后内嵌 JS `node --check`（**必须 bun 求值 WEB_HTML 提取 script**，勿 grep 源码）
4. `node --check zen-gateway/gateway.mjs`
5. 真实配置 md5 隔离铁证（测试前后 `~/.local/share/zen-gateway/gateway-config.json` 逐字节一致）

---

## 8. Web UI（实施建议，go-rotate.ts WEB_HTML）

沿用现有卡样式、`esc()`、`proxy-item`/`proxy-grid` 组件、勾选工具栏模式：

- **梯子卡（gw-ladder-card）内新增「梯子 IP 池」区**：
  `＋ 添加出口`（`ladder-add`）、`健康检查`（`egress/health {urls:ladderEgress}`）、
  `科学上网筛选`（`ladder/check {urls:ladderEgress}`）、复选框 + `→ IP 池`（transfer ladder→egress）/
  `→ 限流池` / `→ 不可用池`、单删（`set {list}`）、空态文案、
  提示「池为空时梯子回退主 egress 池，再空则直连」。
- **主 IP 池/限流池/不可用池**：每项加 `→ 梯子池` 按钮（transfer to:"ladder"）；
  egress 卡顶部“检查所有 IP 健康度”可加勾选范围扩到梯子池。
- **`ladderSurfCheck`**：目标池改为「梯子池非空 ? 梯子池 : 主池」，`{urls}` 显式传入。
- 全局 `ladderState` 增加 `egress:[]`；新增 `ladderEgress` / `ladderEgressHealth` / `ladderEgressSel`。

---

## 9. 需主线程拍板的决策

1. **梯子池内部 `direct` 是否允许写入**：本文方案「允许写但运行时过滤」以保四池格式统一、
   转移矩阵无需特判。若倾向「梯子池拒绝 direct」，需在 `ladder-*` 写路径单独校验（多一组规则与测试）。
2. **池操作入口归属**：本文把梯子池增删改走 `/api/gateway/egress`（pool 判别），
   而非 `/api/gateway/ladder` 新 action 组——因既有 limited/dead 即在该路由管理、风格一致。
   若主线程偏好隔离，改为 `/api/gateway/ladder {action:"egress",op:...}` 亦可（契约改路由前缀，语义不变）。
3. **`transfer` 通用动作 vs 12 个具名动作**：本文选「1 个通用 transfer + 既有动作保留」；
   反对 12 具名（12 个 handler = 12 组测试 = 漂移面大）。若坚持「与现有 move-to-limited 平级命名」，
   最低限度需补 `move-to-ladder`（egress+limited→ladder）与 `restore-from-ladder`（ladder→egress）两个，
   但**无法覆盖 dead→ladder** 等全部象限（转移矩阵会缺角）。
4. **`needsRestart` 语义**：梯子池操作返回 `needsRestart:false`（ladderNextEgress 每连接动态读配置，
   即时生效；与既有 egress 动作返回 true 的陈旧文案**不一致**）。建议新 UI 文案「即时生效」并保持
   既有 egress 行为不动（避免动旧测试）。
5. **网关 `ladderStatus` 是否加 `egress` 字段**：加法成本 1 行；不做也不影响 Web（Web 读配置）。
6. **梯子池健康检查 badge 是否区分 429**：建议与 limited 卡一致（429 → 「仍限流 429」徽标，
   可一键 transfer to:"limited"），实施在 FE 侧，无后端新逻辑。