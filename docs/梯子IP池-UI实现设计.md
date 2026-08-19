# 梯子 IP 池 — UI 实现设计

> 日期：2026-08-19　状态：设计定稿（只读分析，未改任何生产代码）
> 范围：Web 端（`go-rotate.ts` 的 `WEB_HTML` + 后端路由）为「梯子」新增**梯子专用出口池**（`gateway-config.json` 新增 `ladder.egress: string[]`），支持增删、健康检查（可用/限流429/不可用）、与现有 3 池（主 IP 池 `egress` / 限流池 `limited` / 不可用池 `dead`）互相转移。
> 约束：本设计**依赖架构设计定的后端契约**（§4 标 ⭐ 项需后端/网关先落地），**依赖项外的前端部分可独立先行**。

---

## 1. 现状基线（只读调研结论）

### 1.1 梯子当前为什么没有独立池

- 网关侧 `ladderNextEgress()` 轮换模式直接读**主 IP 池** `egressList()`（`gateway.mjs:996`），`ladderStatus().egressCount` 统计的也是主池 socks5 数（`gateway.mjs:982`）；`ladderConfig()` 只归一 `{enabled,port,mode,fixed}`（`gateway.mjs:969`）。
- 插件侧 `GatewayConfig.ladder` 类型同样只有 `{enabled,port,mode,fixed}`（`go-rotate.ts:1135-1140`），`readGatewayConfig`/`writeGatewayConfig`/`gatewayConfigPayload` 均不含 egress。
- 结论：现在「梯子」与网关 HTTP 轮换**共用一套出口池**，无独立管理入口。

### 1.2 四个池现有的 HTML / JS / 后端资产（复用基底）

| 池 | HTML 卡（go-rotate.ts） | 渲染函数 | 健康检查 | 转移/管理 |
|---|---|---|---|---|
| 主 IP 池 | `gw-egress-card` L2460-2478 | `renderEgressList` L3212 | `checkEgressHealth` L3258（`/egress/health` 全池） | `addEgress`/`delEgress`/`clearEgress`；单项 `moveToLimited(i)`/`moveToDead(i)`；批量 `moveAllDeadFromEgress` L3470；`toggleIpRotation` |
| 限流池 | `gw-limited-card` L2480-2492 | `renderLimitedList` L3275 | `checkLimitedHealth` L3337（逐项 `/egress/health {url}`） | 单项 `moveToDeadFromLimited` L3453；批量 `moveAllDeadFromLimited` L3487；`restoreSelectedLimited` L3375；`delLimited`；勾选 `limitedSel` |
| 不可用池 | `<details>#gw-dead-card` L2494-2512 | `renderDeadList` L3394 | `checkDeadHealth` L3507（逐项 `/egress/health {url}`） | 批量 `restoreSelectedDead` L3530；`delDead`；勾选 `deadSel`/`deadList`/`deadHealth` |
| 梯子 | `gw-ladder-card` L2560-2596 | `renderLadderState` L3711 + `refreshLadder` L3773 | `ladderSurfCheck` L3836（科学上网筛选 `/ladder/check`） | `ladderSave` L3796 / `ladderToggle` L3815 / `ladderCollectConfig` L3788 |

关键既有 helper：
- `api(path, body?)` L2613（带 body→POST+JSON，错误 throw）
- `esc(s)` L2627（XSS 转义，所有用户可控字段拼 innerHTML 前必过）
- `shortUrl(u)` L3749（`slice(indexOf("//")+2)`——**不要用 `replace(/^socks5:\/\//,"")`**，已被证明在模板字符串里 `\/` 会丢转义，见 2026-08-18 事故）
- 徽标 class：`b-available`（可用）/ `b-warn`（429 限流）/ `b-invalid`（不可用）/ `b-stopped`（未启用）；网格 `.proxy-grid` + 条目 `.proxy-item` + 工具栏 `.proxy-toolbar`（CSS L2069-2086，淘源卡重构产物，三池已复用）
- 消息区模式：每卡独立 `xxx-msg`，`setMsg(el, text)` 路径下用 `.msg` / `.msg err`（各渲染函数内联实现，无统一封装）；成功/失败均有 toast 兜底不需要，卡片内 msg 即够
- 刷新枢纽：`refreshGatewayConfig()` L3864 一次性拉 `/api/gateway/config` 并发 3 个渲染器 + `refreshLadder()` L3875

### 1.3 现有后端写路径（转移动作全在 `/api/gateway/egress` 一个路由）

`POST /api/gateway/egress` 现有 action（`go-rotate.ts:1607-1764`）：
`add` / `del` / `clear` / `set` / `toggle` / `bulk-add` / `move-to-limited`(主池→限流) / `restore`(限流→主池) / `set-limited` / `move-to-dead`(主池∪限流→不可用) / `restore-dead`(不可用→主池) / `set-dead`。
全部走 `writeGatewayConfig(patch)`（锁 + 原子写），返回 `{ok, 变化池字段, needsRestart}`。

健康检查唯一事实源：`POST /api/gateway/egress/health`（插件代理 L1465 → 网关 `egressHealthCheck` `gateway.mjs:905`）。**已支持 `{url}` 指定单出口 `expectUrl` 模式**（限流/不可用池复用它），梯子池可直接复用，零新后端。结果 `{index,url,ok,status,ms,error}`，`ok=false && status===429` = 限流，其余 = 不可用。

---

## 2. UI 方案

### 2.1 结构层级：`gw-ladder-card` 内新增子区块「梯子 IP 池」

放在「保存并应用」行（L2586）之后、「梯子使用说明」`<details>`（L2590）之前，插入一段：

```
┌─ gw-ladder-card ────────────────────────────────────────────┐
│ 梯子（本地 SOCKS5 透明代理） [ladder-badge]                    │
│   [状态]  [ladder-toggle-btn 启用] [ladder-check-surf-btn]     │
│   [ladder-port] [ladder-mode]                                │
│   [ladder-fixed-row]                                         │
│   [保存并应用]                                                │
│ ┌─ 梯子 IP 池（专用出口） [ladder-pool-badge] ──────────────┐ │
│ │ row: [ladder-pool-input] [ladder-pool-add-btn ＋添加出口]  │ │
│ │      [ladder-pool-check-btn 健康检查]                     │ │
│ │      [ladder-pool-movedead-btn →转移不可用]               │ │
│ │      [<span>移回说明</span>]                              │ │
│ │ [ladder-pool-toolbar]: 全选 | 清空 | 已选 N |             │ │
│ │      [ladder-pool-restore-btn 移回主 IP 池]               │ │
│ │ [ladder-pool-list]  （.proxy-grid 网格）                  │ │
│ │ 提示行 + [ladder-pool-msg]                                │ │
│ └───────────────────────────────────────────────────────────┘
│ <details> 梯子使用说明 </details>                             │
└──────────────────────────────────────────────────────────────┘
```

复用现有三池的**子模块样式**：`.proxy-grid` / `.proxy-item`（网格 chip，多列 `minmax(250px,1fr)`）/ `.proxy-toolbar`，视觉与操作节奏完全一致。不需要新增 CSS 规则（若想与卡内其它内容分隔，可用现成 `border-top:1px solid var(--bd-2); margin-top:12px; padding-top:10px` 的既有行分隔惯例，直接写在块上）。

### 2.2 徽标（`ladder-pool-badge`）

- 有出口：`a-available` + 文案 `N 个专用出口`；梯子 running 时 `b-running` 徽标已在 `ladder-badge` 呈现，此处不重复。
- 无出口：`b-stopped` + `0 个（回退主池/直连）` —— 文案与空态一致（rotate 模式池空 → 网关回退主池或本地直连，见 §4.2）。

### 2.3 增删输入框

`ladder-pool-input`（placeholder `socks5://user:pass@host:port 或 direct`，同 `egress-input` L2468）+「＋ 添加出口」`ladder-pool-add-btn`。添加后清空输入并刷新梯子池渲染。去重与格式校验由后端 `validateEgressItem`（L1316）把关（重复/非法 → 400 + msg，不做前端二次校验，与 `addEgress` 一致）。

### 2.4 健康检查（每出口状态 可用/限流429/不可用）

单个按钮「健康检查」`ladder-pool-check-btn` → `checkLadderPoolHealth()`：
- 逐项调既有 `POST /api/gateway/egress/health {url}`（复用 `checkLimitedHealth`/`checkDeadHealth` L3348/L3517 逐项串行的同一模式，零新后端）。
- 结果写入 `ladderPoolHealth[url] = {ok,status,ms,error}`，按同语义渲染徽标：`ok=true` → `b-available 健康 ·Nms`；`status===429` → `b-warn IP 被限流 429`；否则 → `b-invalid 不可用`。未探测 → `b-stopped 未探测`。
- 完成摘要文案：`检查完成：N 项，X 个可用，Y 个仍限流，Z 个不可用`（对齐 `checkAllHealth` L3373 的统计口径）。

### 2.5 勾选批量操作（`ladder-pool-toolbar`，仅 list 非空时 `display:flex`）

- 全选 `ladderPoolSelAllToggle()` / 清空 `clearLadderPoolSel()` / 已选计数 `ladder-pool-selcount`（完全复刻不可用池 `deadSelAllToggle`/`clearDeadSel`/`updateDeadSelCount` L3430-3428）。
- 「移回主 IP 池」`ladder-pool-restore-btn` → `restoreSelectedLadder()`（勾选项 → `ladder.egress` 移入主池，复用 `restoreSelectedDead` L3530 的确认/刷新节奏）。

### 2.6 转移按钮（进出双向往）

**出梯子池**（在 `ladder-pool-list` 每一条目上，按健康状态出现，同主池 L3244/L3248）：
- 该项健康检查 `status===429` → 「→ 限流池」`moveLadderToLimited(i)`
- 该项健康检查不可用（非 429）→ 「→ 不可用池」`moveLadderToDead(i)`
- 批量「→ 转移不可用」`ladder-pool-movedead-btn` → `moveAllLadderDead()`（把健康检查非 ok 且非 429 的全部移入不可用池，复刻 `moveAllDeadFromEgress` L3470 语义）
- 未探测项不显示转移按钮（与主池一致，需要先健康检查）。

**进梯子池**（三个既有池各自补一个入口，完全镜像 `moveToLimited`/`moveToDead` 的单项按钮模式）：
- 主 IP 池条目新增「→ 梯子池」`moveToLadderFromEgress(i)`（健康检查 `ok=true` 时显示；或恒显示，随实现取舍——建议恒显示，初始化方便）
- 限流池条目新增「→ 梯子池」`moveToLadderFromLimited(i)`（未探测/429 状态项上显示）
- 不可用池条目新增「→ 梯子池」`moveToLadderFromDead(i)`

> 转移后刷新：统一拉一次 `/api/gateway/config` → `renderEgressList` + `renderLimitedList` + `renderDeadList` + `renderLadderPool` 四池联动（对应响应里的 `egress/limited/dead/ladder.egress` 字段）。

### 2.7 空态

- 池空：`ladder-pool-list.textContent = "未配置梯子专用出口（梯子将回退主 IP 池或本地直连）。"`（与 `renderEgressList` L3227-3232 的空态引导同风格）。
- 首屏加载中：`加载中…`（同 `egress-list`）。

### 2.8 默认折叠 or 展开：**默认展开**

- 依据：梯子是**使用方**（rotate 模式的真实消费池），角色与「主 IP 池」对等（主池卡默认展开）；不可用池默认折叠是因为它是**垃圾桶**（低使用频率）。梯子池高频增删调参，折叠会增加操作成本。
- 折中：池空时可即时收起文案不必要；若后续嫌卡变长，改 `<details>` 只需动一处容器标签，不牵 JS。

### 2.9 不做的事（v1 明确排除）

- 不做「科学上网筛选」作用于梯子池的改造（§4.2 遗留：`/ladder/check` 支持 `{urls}`，v1 可直接从梯子池传 `urls`，0 网关改动，属一行增强，可顺带做）。
- 不做梯子池自动轮询刷新（与三池一致：仅 config 加载 + 手动操作后刷新）。
- 不把梯子池并入「检查所有 IP 健康度」（`checkAllHealth` L3361 保持主/限/死三池，梯子池有独立「健康检查」按钮；合并会导致一次点击同时探测 4 池、耗时长且雪崩面大——可由用户确认后二期加）。
- 不做条目标签（name）功能（四池均无）。
- 不做拖拽排序 / 池内去重迁移（主池现有项是否需要自动复制进梯子池，见 §4.2 架构决策，v1 由用户手动添加或转移）。

---

## 3. JS 函数清单（新增/改造）

### 3.1 新状态变量（放 `ladderState` 旁，L3710 附近）

```js
var ladderPool = []        // 当前渲染的梯子池列表（渲染时从 config 拉取，避免与 ladderHealth 键序漂移）
var ladderPoolHealth = {}  // { [url]: {ok,status,ms,error} }
var ladderPoolSel = {}     // { index: true }
```

### 3.2 新增函数（逐个）

| 函数 | 职责 | 复用/仿照 |
|---|---|---|
| `renderLadderPool()` | 渲染 `ladder-pool-list`（网格 chip：checkbox + `shortUrl` 短显 + title 全名）+ `ladder-pool-badge`（N 个/0 个）+ `ladder-pool-toolbar` 显隐 + 空态 + `updateLadderPoolSelCount()` | `renderDeadList` L3394 几乎逐行镜像；`esc`/`shortUrl`/`b-available`/`b-warn`/`b-invalid`/`b-stopped` |
| `checkLadderPoolHealth()` | 逐项 `POST /api/gateway/egress/health {url}` → `ladderPoolHealth` → 重渲染 + 摘要文案；按钮「检查中…」防重 | `checkDeadHealth` L3507 |
| `addLadderEgress()` | 读 `ladder-pool-input` → `POST /api/gateway/ladder/egress {action:"add", url}` → 清输入 + 刷新 4 池 | `addEgress` L3561 |
| `delLadderEgress(i)` | `{action:"del", index}` → 刷新（含清掉该 url 的 health 缓存） | `delLimited` L3323 / `delDead` L3547 |
| `clearLadderEgress()` | `{action:"clear"}` → 刷新（v1 可放工具栏最右，类 `clearEgress`） | `clearEgress` L3581 |
| `moveLadderToLimited(i)` | 单项 429 → `{action:"move-to-limited", urls:[url]}` | `moveToLimited` L3310 |
| `moveLadderToDead(i)` | 单项不可用 → `{action:"move-to-dead", urls:[url]}` | `moveToDead` L3439 |
| `moveAllLadderDead()` | 批量：health 非 ok 非 429 项 → `{action:"move-to-dead", urls}`；无命中报引导文案 | `moveAllDeadFromEgress` L3470 |
| `restoreSelectedLadder()` | 勾选项 → `{action:"restore", urls}`（梯子池→主池）；清勾选 + 清 health + 刷新 4 池 | `restoreSelectedDead` L3530 |
| `moveToLadderFromEgress(i)` | 主池单项 → `{action:"move-to-ladder", urls:[当前主池该项]}` | `moveToLimited` L3310 |
| `moveToLadderFromLimited(i)` / `moveToLadderFromDead(i)` | 限流/不可用池单项 → `{action:"move-to-ladder", urls}` | `moveToDeadFromLimited` L3453 |
| `ladderPoolSelAllToggle()` / `clearLadderPoolSel()` / `updateLadderPoolSelCount()` | 勾选控制 | `deadSelAllToggle`/`clearDeadSel`/`updateDeadSelCount` L3430-3428 |
| `refreshLadderPool()`（轻量） | 拉 `/api/gateway/config` → `ladderPool = c.ladder?.egress ?? c.ladderEgress ?? []` → `renderLadderPool()`；失败静默进 `ladder-pool-msg`（网关不可达时三池同款降级） | `refreshLadder` L3773 的模式 |

### 3.3 改造既有函数（小改）

1. **`refreshLadder()`**（L3773）：末尾追加 `await refreshLadderPool()`（或读取 config 时顺带填 `ladderState.egress = c.ladder?.egress ?? []`）。ladder 状态与梯子池数据同源（都从 `/api/gateway/config` 来），避免二次请求。
2. **`ladderCollectConfig()`**（L3788）：返回对象**必须携带 `egress: ladderPool`**。否则 `ladderSave`/`ladderToggle`（`{action:"set", ladder: cfg}`）会用 `{enabled,port,mode,fixed}` 整体替换 `cfg.ladder`，**把 ladder.egress 洗掉**——这是本功能最大集成坑（`writeGatewayConfig` L1245-1258 是全量替换语义）。
3. **`renderLadderState()`**（L3711）fixed 下拉：现用 `currentEgressList.concat(deadList)`（L3738）；梯子池独立后建议改为 `ladderPool.concat(currentEgressList, deadList)` 并去重（fixed 优先从梯子池取，池空再回退主池/不可用池），保证固定模式可选到梯子池专用项。
4. **`renderEgressList` → `renderLimitedList` → `renderDeadList`**：各自条目内新增「→ 梯子池」按钮 + inline onclick 调新函数（HTML 字符串拼，`esc` 转义入口即可，url 已 esc）。

### 3.4 复用的既有 helper 清单

`api` / `esc` / `shortUrl` / `.proxy-grid` / `.proxy-item` / `.proxy-toolbar` / `.badge b-*` / `b-available/b-warn/b-invalid/b-stopped` / `gw-*msg` 消息区模式；后端 `validateEgressItem`（L1316）与 `/egress/health` 的 `{url}` 单出口探测模式（限流/不可用池已验证可用）。

---

## 4. 前端调用契约（依赖架构设计定的后端契约）

> ⭐ 标记 = **需要后端/网关先行落地**（本设计提案，未实现）；无 ⭐ = **现有端点直接复用**，前端可独立先行。

### 4.1 健康检查（无 ⭐，直接复用）

```
POST /api/gateway/egress/health      body: { url }            // 单出口 expectUrl 模式（限流/不可用池已在用）
返回 { ok, checkedAt, egress: [{index,url,ok,status,ms,error}] }
```
对梯子池每项循环调用一次。`index` 无意义忽略；用 `url` 作为 `ladderPoolHealth` 键。

### 4.2 ⭐ 新增 / 扩展端点

**新路由 `POST /api/gateway/ladder/egress`**（操作 `ladder.egress`，完全镜像现有 `/api/gateway/egress` 的动作语义，全部走 `writeGatewayConfig` 锁 + 原子写）：

| action | body | 返回 | 说明 |
|---|---|---|---|
| `add` | `{url}` | `{ok, egress: ladderEgress, needsRestart}` | 校验 `validateEgressItem`，已存在报错 |
| `del` | `{index}` | 同上 | index 越界 → 400 |
| `clear` | `{}` | 同上 | 清空 |
| `set` | `{list: string[]}` | 同上 | 重设/删除用 |
| `bulk-add` | `{urls: string[]}` | `{ok, added, skipped, egress}` | 批量 + 去重（仿 `bulk-add` L1644） |
| `move-to-limited` | `{urls}` | `{ok, moved, limited, egress}` | `ladder.egress`→`limited`（429 出池） |
| `move-to-dead` | `{urls}` | `{ok, moved, dead, egress}` | `ladder.egress`→`dead`（不可用出池） |
| `restore` | `{urls}` | `{ok, restored, egress, ladderEgress}` | `ladder.egress`→主池（勾选移回） |

**扩展既有 `POST /api/gateway/egress`**：
| action | body | 说明 |
|---|---|---|
| `move-to-ladder` | `{urls}` | 从主池/限流池/不可用池 → `ladder.egress`（三池并集抽取，仿 `move-to-dead` L1713 的多集合并扣除逻辑） |

**`gatewayConfigPayload()`（L1296）**：`ladder` 对象内含 `egress`（schema 加字段后自然携带）；为兼容旧网关缓存建议**额外加顶层 `ladderEgress: cfg.ladder?.egress ?? []`**（与 `egress/limited/dead` 平级，前端统一读该字段）。

**前端读：`/api/gateway/config`** → `{ ..., ladderEgress: string[] }`。

### 4.3 ⭐ 网关侧（`zen-gateway/gateway.mjs`）契约

1. `readGatewayConfig()`（L533）→ `normalizeLadderConfig`（L521）返回增加 `egress: string[]`（过滤非字符串项）。两端（go-rotate.ts L1170-1178 与 gateway.mjs）schema 必须同步。
2. `ladderConfig()`（L969）返回 `egress`；`ladderStatus().egressCount`（L990）**改为统计 `ladder.egress` 的 socks5 数**（不再数主池）。
3. `ladderNextEgress()`（L996）：rotate 模式**优先读 `ladder.egress`**；`ladder.egress` 为空时**回退主池 `egressList()`**（向后兼容：老用户没配梯子池时梯子行为不突变）；两池都空 → `null`（本地直连兜底，现状不变）。fixed 模式不变。
4. `ladderCheck(urls)`（L1226）：`urls` 参数已存在，前端可传梯子池；**v1 顺带让 Web「科学上网筛选」从 `ladder-pool` 列表收集 `urls` 传入**（0 网关改动，让筛选结果反映梯子真实出口）。不做 → 维持现状可接受（筛主池）。

### 4.4 响应消费约定

前端 `restoreSelectedLadder` / `moveAllLadderDead` / `moveToLadder*` 转移后：拉一次 `/api/gateway/config` → `renderEgressList` + `renderLimitedList` + `renderDeadList` + `renderLadderPool` 全刷新（与 `moveToLimited` L3315-3318 单池刷新的写法不同——因为转移涉及多池，统一走 config 全量刷新最简单且不漂移）。

---

## 5. 测试（WEB_HTML 断言清单）

在 `tests/go-rotate-plugin.test.ts` 现有「WEB_HTML 梯子卡片」测试（L1331-1353）后追加一组 toContain 断言（`as any` 读 `mod.WEB_HTML`）：

**容器/输入/徽标**
- `id="ladder-pool"`（子区块包裹 div）
- `id="ladder-pool-badge"`
- `id="ladder-pool-input"`
- `id="ladder-pool-list"`
- `id="ladder-pool-msg"`
- `id="ladder-pool-toolbar"`
- 文案包含 `梯子 IP 池`

**按钮**
- `id="ladder-pool-add-btn"` + `onclick="addLadderEgress()"`
- `id="ladder-pool-check-btn"` + `onclick="checkLadderPoolHealth()"`
- `id="ladder-pool-movedead-btn"` + `onclick="moveAllLadderDead()"`
- `id="ladder-pool-restore-btn"` + `onclick="restoreSelectedLadder()"`
- 三池「→ 梯子池」：`onclick="moveToLadderFromEgress(` / `onclick="moveToLadderFromLimited(` / `onclick="moveToLadderFromDead(`

**函数声明**
- `function renderLadderPool(`
- `async function checkLadderPoolHealth()`
- `async function addLadderEgress()`
- `async function delLadderEgress(`
- `async function moveLadderToLimited(`
- `async function moveLadderToDead(`
- `async function moveAllLadderDead()`
- `async function restoreSelectedLadder()`
- `function ladderPoolSelAllToggle()`
- `function updateLadderPoolSelCount()`
- 改造确认：`ladderCollectConfig()` 内 `egress: ladderPool`（防洗库回归）；`renderLadderState()` 内 `ladderPool.concat(`

**action 串（后端契约不同则同步更新）**
- `api("/api/gateway/ladder/egress", { action: "add", url`
- `api("/api/gateway/ladder/egress", { action: "del", index:`
- `api("/api/gateway/ladder/egress", { action: "move-to-limited", urls`（若后端放 `egress` 路由则改路径串）
- `api("/api/gateway/egress", { action: "move-to-ladder", urls`
- `api("/api/gateway/egress/health", { url`（复用标识）
- `renderLadderPool("梯子池" 空态文案) → toContain("未配置梯子专用出口")`

> 测试铁律：只对 `WEB_HTML` 字符串断言 + 路由用假 `Request` 喂 `handleWeb`（已有多组先例），全程 `GOROTATE_CONFIG_FILE`/`GOROTATE_AUTH_FILE` 隔离，绝不碰真实配置。

---

## 6. 关键集成点 / 坑（实现前必读）

1. **`ladderSave`/`ladderToggle` 会洗掉 egress**：`writeGatewayConfig` 的 `ladder` patch 是全量替换（L1245-1258），`ladderCollectConfig` 必须带上 `egress: ladderPool`，否则保存一次梯子配置 = 梯子池清空。这是最高优先级风险。
2. **`esc` 全覆盖**：`shortUrl(url)` / 状态 title / error 提示拼接 innerHTML 前必须过 `esc`（XSS 红线，管理页 P1-1 已修，勿回归）。
3. **短路显示用 `indexOf("//")+2` 而非正则**：模板字符串里 `replace(/^socks5:\/\//,"")` 渲染后会丢 `\/` 转义 → SyntaxError（2026-08-18 已踩）。
4. **e.g. `ladderStatus().egressCount` 语义变化**：网关改「梯子池 socks5 数」后，`refreshLadder`（L3781 读到 egressCount）与 `gatewayLadderStatus`（L900，插件侧兜底仍读主池）**两端口径必须一致**，否则 Web 徽标与实际不符。架构方案里建议统一：有 `ladder.egress` 字段 → 数梯子池；否则数主池。
5. **消息区**：梯子池操作反馈写 `ladder-pool-msg`，成功 `.msg` / 失败 `.msg err`，不在 `ladder-msg` 混写（避免与「保存并应用」消息互相覆盖）。
6. **批量转移无命中引导**：`moveAllLadderDead` 无不可用项时给引导文案（同 `moveAllDeadFromEgress` L3477），避免静默。

---

## 7. UI 优先级（最小可用第一版）

**P0（本版本必须交付）**
- [ ] 子区块「梯子 IP 池」HTML（2.1）+ badge（2.2）+ 空态（2.7）+ 默认展开（2.8）
- [ ] 增删：`ladder-pool-input` + `addLadderEgress` / `delLadderEgress` / toolbar 全选清空计数
- [ ] 健康检查：`checkLadderPoolHealth`（逐项 `/egress/health {url}`）+ 三态徽标渲染
- [ ] 出池转移：单项「→ 限流池」「→ 不可用池」 + 批量「→ 转移不可用」 + 勾选「移回主 IP 池」
- [ ] 入池转移：主/限/死三池各加「→ 梯子池」单项按钮
- [ ] `ladderCollectConfig` 带 `egress` 防洗库 + `renderLadderState` fixed 下拉并入梯子池
- [ ] 测试断言（§5 全量）
- [ ] ⭐ 后端契约落地：schema + `/api/gateway/ladder/egress` 路由 + `move-to-ladder` action + payload 字段 + gateway.mjs 三处（§4.2 / §4.3）

**P1（紧随其后，仍属本需求）**
- [ ] 「科学上网筛选」v1 改为把梯子池 `urls` 传给 `/ladder/check`（0 网关改动）
- [ ] `bulk-add` 到梯子池（淘源卡加「＋ 梯子池」批量入口）—— 复用淘源卡选中集合，低开发量，体感强

**不做（明确推迟）**
- 梯子池并入「检查所有 IP 健康度」一键；池间自动同步/迁移主池现有项；条目标签/排序；pool 独立定时轮询。

---

## 8. 复验建议（后端落地后）

1. `bun test tests/go-rotate-plugin.test.ts` 全绿（156 → 含新断言数）
2. `bun build go-rotate.ts` + 渲染后内嵌 JS `node --check`（模板转义/语法）
3. 隔离实例（`GOROTATE_WEB_PORT` 临时端口 + 假 `Request` 喂 `handleWeb`）走一遍 `{action:"add"}`→`set ladder`（确认 egress 保留）→`move-to-dead`→`restore`→`move-to-ladder` 全链路 + `md5` 铁证
4. gateway 测试：`normalizeLadderConfig` 加 egress 字段断言 + `ladderNextEgress` 梯子池优先/回退主池两条
5. 真机：Web 浏览器实测梯子卡子区块、三态徽标、四池转移按钮联动、保存并应用后 `gateway-config.json` 的 `ladder.egress` 保留；`socks5://127.0.0.1:10880` 经梯子池出口卷一次 google 验证 rotate 走新池