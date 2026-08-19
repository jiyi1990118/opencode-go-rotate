# 梯子 IP 池设计（ladder.egress — 梯子专用独立出口池）

> 状态：**设计稿（只读，未改任何生产代码）**
> 日期：2026-08-19
> 服务对象：网关（zen-gateway/gateway.mjs）梯子模块 + 管理端（go-rotate.ts WEB_HTML）梯子卡 + 测试
> 关联：现有 `egress`（主 IP 池）/ `limited`（限流池）/ `dead`（不可用池）管理范式

---

## 1. 需求规格

### 1.1 现状与问题

梯子（本地 SOCKS5 透明代理）当前**与网关 egress 池完全共用**：

- `gateway.mjs` `ladderNextEgress()`（L996）rotate 模式直接吃 `egressList()`（= 网关 HTTP 出口池），无独立池。
- 梯子的出口可用性/健康度判断混在网关出口里，二者**没有分离的取舍**：用户想让「梯子用一批专门代理」（如专门挑能翻墙、地址干净的），目前做不到，只能把它们也塞进会参与 opencode 429 轮换的主池。
- 「科学上网筛选」（`ladderCheck`，测 CONNECT google/youtube + 出口归属）是对**全池**探测，无法只对「梯子专用那一批」筛。

### 1.2 本需求要解决

1. **隔离**：梯子可配**独立出口池**，不混入/不被混入网关 egress。梯子想要专门挑代理、避免与网关 HTTP 流量互相抢池、避免被 opencode 429 限流语义污染——各管各。
2. **独立管理**：梯子池有自己的一套——增删、健康检查（沿用科学上网筛选语义）、池间转移（进/出主池、限流池、不可用池）、批量操作。
3. **与现有三大池的统一**：梯子池做主/限流/不可用池之外的「第四个池」，转移关系参照现有 `limited`/`dead` 管理模式（`move-to-*` / `restore` / `set-*` 一套动作语言）。

### 1.3 典型使用场景

- **场景 A（专用梯子代理）**：用户有一批「专门能翻墙、延迟低」的 SOCKS5，只想给梯子用、不让它们进入参与 opencode 限流轮换。→ 填进梯子池，主 egress 完全无关。
- **场景 B（主 egress 空、梯子池工作）**：opencode 走本地直连（主池空），但浏览器/curl 走梯子池。→ 梯子池独立可用，梯子不退化直连。
- **场景 C（淘一淘，先入梯子池）**：刚从免费代理淘源/淘源卡筛出「能翻墙」的候选，先放进梯子池做真实 surf 验证，可用再考虑要不要共享给主池。
- **场景 D（转移整理）**：主池探测出「连通但被 opencode 429」→ 移限流池；「隧道挂了」→ 移不可用池；梯子池 surf 失败 → 移不可用池。反向：池子重新探测恢复 → 移回目标池。

---

## 2. 信息模型

### 2.1 存储位置（建议）：`gateway-config.json` → `ladder.egress`

沿用梯子配置整体塞进 `ladder` 对象（与 `enabled/port/mode/fixed` 同属梯子域），新增一个 `string[]` 字段：

```jsonc
{
  "plan": "zen",
  "egress": ["socks5://host1:1080", "socks5://host2:1080"],   // 主 IP 池（网关 HTTP 轮换，不变）
  "limited": ["socks5://..."],       // 限流池（共享 sink，不变）
  "dead": ["socks5://..."],          // 不可用池（共享 sink，不变）
  "ip_rotation": true,
  "ladder": {
    "enabled": true,
    "port": 10880,
    "mode": "rotate",                 // "rotate" = 梯子池轮换（池空回退主池）| "fixed" = 固定出口
    "fixed": "socks5://host2:1080",   // fixed 模式用（可选，可从任一池选）
    "egress": ["socks5://proxyA:1080", "socks5://proxyB:1080"]   // ★ 梯子专用池（新增，可选）
  }
}
```

**选型理由**：
- 与梯子生命周期绑定（apply / stop / status 都按整块 ladder 读），一次读写、一次 apply，最贴合现有 `normalizeLadderConfig` / `ladderConfig()`。
- **不新增顶层数组**，避免与 `egress/limited/dead` 平级的第四块顶层状态 + 额外 read/write/validate/透传成本。
- `ladder.egress` **缺省视为空数组** = 未配置梯子池 → 行为退化为现状（吃主池/直连），完全向后兼容。

### 2.2 池间关系 / 转移矩阵

四池：**梯子池(ladder.egress) / 主 IP 池(egress) / 限流池(limited) / 不可用池(dead)**。
`limited` / `dead` 是**共享 sink**：一个出口对梯子不可用，大概率对网关也不可用，复用同一 sink 避免维护两套（见 §5 取舍）。

| 源 \ 目的 | 梯子池 | 主 IP 池 | 限流池 | 不可用池 |
|---|---|---|---|---|
| **梯子池** | — | ✅ 手动单移 / 批量移回 | ✅ 手动单一/批量 | surf 失败 → 自动归类就位，一键移入 |
| **主 IP 池** | ✅ 一键入梯子池 | — | 429 → 限流 | 探测失败 → 不可用 |
| **限流池** | ✅ 入梯子池 | ✅ 解限 → 恢复 | — | 探测仍挂 → 不可用 |
| **不可用池** | ✅ 入梯子池（复活后当梯子出口） | ✅ 恢复 | 探测 429 → 转限流（可选） | — |

转移语义规则（与现有 `move-to-limited`/`move-to-dead` 一致）：
- **移出即删**：从源池移除后加入目标池，同一出口**永不跨池重复存在**（`Set` 去重；单出口一次只属于一个池）。
- **单向原子写**：单次 `withLock`/`writeGatewayConfig` 一次更新涉及的池数组，防止中间态。
- **「direct」不参与**：梯子池只收 / 只转 socks5（`direct` 是主池直连占位，梯子用不到）。

---

## 3. 转移功能设计（后端动作）

### 3.1 复用现有动作语言，挂到 `/api/gateway/egress`（池代数字面）

梯子属「池」的增删移转，与 `/api/gateway/ladder`（启停 / apply / 写 ladder 配置）职责分开，但**头尾写配置都是 `ladder.egress`**。新增如下 actions（命名对齐现有 `set-limited/set-dead/move-to-dead/restore-dead`）：

| action | 语义 | 输入 | 对应现有同类 |
|---|---|---|---|
| `set-ladder` | 整体重设梯子池（删除单项 / 清空） | `{list: string[]}` | `set-limited` / `set-dead` |
| `add-ladder` | 单条加入（去重，已在池/非法拒绝） | `{url}` | `add`（主池） |
| `move-to-ladder` | 从**主池/限流池/不可用池**移入梯子池 | `{urls: string[]}` | （跨源，新增） |
| `ladder-to-egress` | 从梯子池移回主 IP 池 | `{urls: string[]}` | `restore` |
| `ladder-to-limited` | 从梯子池移入限流池（手动） | `{urls: string[]}` | `move-to-limited` |
| `ladder-to-dead` | 从梯子池移入不可用池（surf 失败归类/手动） | `{urls: string[]}` | `move-to-dead` |

复用同一 `validateEgressItem`（只收 `direct` / `socks5://...`，但 `direct` 入梯子池拒绝）；全部经 `writeGatewayConfig({ ladder: { ...当前, egress } })` 原子落盘；均返回 `needsRestart:false`（梯子池是**动态读当前配置**，与主池 `egress` 一样无需重启即时生效——见 §5）。

> 说明：implement 时仅需扩 `handleWeb` 的 `/api/gateway/egress` case 分支 + 对应 `writeGatewayConfig` patch 支持 `ladder.egress`。梯子池不持久化独立 index / health 缓存（跟随内存态，参考 `limitedHealth`/`deadHealth` 前端缓存）。

### 3.2 健康检查 + 自动归类入口

梯子池自身的「健康检查」**复用现有科学上网筛选 `ladderCheck`**，但支持 `{scope:"ladder"}` 或 `{urls}` 限定只测梯子池条目（避免每回扫全池）。按结果自动预归类（前端就地渲染，配合一键移入）：

- `ok`（google✓ + youtube✓）→ 「可科学上网」徽标，可一键加入主池。
- `ok:false` → 「不可用」徽标 + 数据行内「→ 不可用池」按钮 / 批量「→ 移入不可用池」。
- 限流池对梯子无自然语义（限流是 opencode 429 概念），故梯子池 surf 失败**一律归类「不可用」**；「→ 限流池」仅提供**手动**入口（用户确知该出口被某源限流时）。

**自动归类入口（一键）**：梯子池工具条「检查池健康」后，若勾选了失败项，「→ 转移不可用」一键批量移入 dead；反向「→ 主池」一键把全部可用项并入 egress。

---

## 4. Web UI 交互

### 4.1 位置与视觉

在现有 **`gw-ladder-card`**（go-rotate.ts L2560）内、模式行 / fixed 行之下、「保存并应用」之上，插入一块 **「梯子 IP 池（专用出口）」** 子区；**视觉与 `gw-limited-card`/`gw-dead-card` 一致**（`.proxy-grid` 网格 + `.proxy-item` chip + `.badge b-*` + 勾选工具条）。样式全走既有类，零新 CSS 族。

结构（新增 id，全部可被 JS 引用）：

```
[梯子 IP 池（专用出口）]  <span id="ladder-pool-badge">
[输入框 ladder-pool-input] [＋添加出口 ladder-pool-add-btn]
[检查池健康 ladder-pool-check-btn] [→转移不可用 ladder-pool-movedead-btn] [→并入主池 ladder-pool-merge-btn]
[勾选工具条 ladder-pool-toolbar: 全选/清空/已选N]
[列表 ladder-pool-list  (proxy-grid)]
[说明 muted：梯子 rotate 优先走本池；池空回退主池；再空本地直连]
[消息区 ladder-pool-msg]
```

### 4.2 列表项渲染（`renderLadderPoolList`）

每项沿用 `limited`/`dead` 的 `<label class="proxy-item">` 结构：

```
☑ <code>host:port</code>  <surf 徽标>  [→主池][→限流池][→不可用池]  删除
```

- 徽标按 surf 结果：可科学上网 → `b-available`；不可用 → `b-invalid`；未探测 → `b-stopped`。
- `ladder-pool-badge`：`N 个专用出口`（空为 `0 个`，b-stopped）。
- 生命周期 JS：`refreshLadder` 读 `cfg.ladder.egress`；`renderLadderPoolList` 渲染；`checkLadderPoolHealth()` 调 scoped surf check；`*PoolMove/Add/Del` 调 §3.1 actions。
- **数据联动**：池操作成功后刷新 `cfg.ladder.egress` + `ladderStatus().egressCount`；同时刷新 fixed 下拉（`ladder-fixed` 选项并入梯子池条目）。

### 4.3 状态徽标与空态

- 梯子卡大徽标 `ladder-badge` 保持现状（启用/停用）；新增池徽标独立显示数量。
- 空态：`未配置梯子池（rotate 将回退主 IP 池）`——明确告知退化行为，引导到 §5。
- 三点确权均与现有池一致：加池合法项、去重、非法 400；成功用 `showMsg`/`toast` 反馈。

---

## 5. 边界与取舍（关键决策）

### 5.1 梯子池为空 / 未配置时梯子如何走（rotate）

**决策：梯子池 → 主池 → 本地直连，三级回退。**

```
ladderNextEgress() rotate:
  1) 若 mode=fixed && fixed → parse(fixed)（可选任一池条目）
  2) 若 ladder.egress 有 socks5 → 独立下标 _ladderEgressIdx 轮换（★ 与 _egressIdx 隔离）
  3) 否则回退主池 egressList().socks5（现状行为，向后兼容）
  4) 都无 → null → 本地直连（现状兜底）
```

理由：
- **向后兼容**：用户只配了主池、没配梯子池 → 梯子照旧吃主池，一处不坏。
- **可用性优先**：梯子池配了但**空/全坏**时，退主池能继续用（不至于因忘了填梯子池就梯子全挂）。
- **隔离语义**：只要梯子池**非空**，rotate 就**只用梯子池**（主池完全被旁路），满足「分离」。用户若要严格隔离 = 填满梯子池即可。

> 可再进一步（v1 不做）：若未来要「梯子池非空也必须百分百隔离、不许回退主池」，可加 `ladder.isolate: boolean`。当前默认「非空即隔离 + 空则回退」已覆盖绝大多数场景，属最小正确解。

### 5.2 fixed 模式能否选梯子池出口

**能。** fixed 只是一个裸字符串出口，来自哪池都行。UI 的 `ladder-fixed` 下拉选项 = 主池 ∪ 梯子池 ∪ 已保存 fixed（去重、`Option` 去 direct）。fixed 优先解析（不参与任何池轮换），语义不变。

### 5.3 限流/不可用 sink 是否梯子独立

**决策：v1 复用共享 `dead` sink（不新增 `ladder.dead`/`ladder.limited`）。**
理由：一个出口隧道挂了，对梯子与网关都不可用，用一份 dead 避免两套漂移与双份转移代码；这也正是「参考现有 limited/dead 管理模式」的最小化。若未来确实需要「梯子独享不可用库」（如出口只对 google 通、对 opencode 通），再拆 `ladder.dead`——标记为可选增强、不做。

### 5.4 动态生效 vs 重启

梯子池随 `readGatewayConfig()` **按需动态读当前配置**（与主池 egress 同一机制），Web 增删移转 + `applyLadder()` 后**无需重启网关即时生效**。因此所有写池 action 返回 `needsRestart:false`；梯子服务本身启停仍走既有 `apply`/`stop`。

### 5.5 并发与锁

梯子池写操作汇聚到 `/api/gateway/egress` 同一 `withLockSync`/`writeGatewayConfig` 原子路径，与主池/限流/不可用池共用一把锁，跨池转移天然一致（单次读写多数组）。

---

## 6. 跨模块契约（主线程实施注意）

| 文件 | 改动面 | 要点 |
|---|---|---|
| `gateway.mjs` | `normalizeLadderConfig` 透传 `ladder.egress`（filter string[]，缺省 []）；`ladderConfig()` / `ladderStatus()` 暴露 `egressCount`（梯子池 socks5 数）；`ladderNextEgress()` 加梯子池优先 + 独立 `_ladderEgressIdx` + 主池回退；`connectLadderUpstream` 失败重试的 `pool` 用「实际消费的池」（梯子池或回退主池），不要再硬取 `egressList()`；`ladderCheck` 支持 scope 限定梯子池 | 出口是梯子池时不自增共享 `_egressIdx` |
| `go-rotate.ts` | `GatewayConfig.ladder` 增 `egress?: string[]`；`readGatewayConfig` 归一；`writeGatewayConfig` patch 支持 `ladder.egress` 校验；`gatewayConfigPayload` 透传 `cfg.ladder.egress`；`handleWeb /api/gateway/egress` 增 §3.1 六个 action；WEB_HTML 梯子池子区 + `renderLadderPoolList`/`checkLadderPoolHealth`/池操作函数；`renderLadderState`/`refreshLadder`/`ladderCollectConfig` 接 `ladder.egress`；`ladder-fixed` 下拉并入梯子池选项 | 所有池动作共用 `validateEgressItem`；`direct` 拒绝入梯子池 |
| 测试 | `zen-gateway/tests/run-tests.mjs`：normalizeLadderConfig egress、ladderNextEgress 梯子池优先/回退/隔离 `_ladderEgressIdx`、mock SOCKS5 走梯子池、ladderCheck scope；`tests/go-rotate-plugin.test.ts`：writeGatewayConfig ladder.egress 校验、ladder pool 六 action、WEB_HTML 梯子池卡断言 | ⚠️ gateway `t()` harness **不 await async fn**，新增的 async 梯子池用例必须用「顶层块真 await」（`const x = await ...`）防读完 mock 未就绪/竞态 |
| 文档 | `docs/Web界面使用.md` §3 API 表（+4 池动作 / ladder 状态增 egressCount）；`zen-gateway/README.md`「梯子」节补 `ladder.egress` 示例 + 三级回退说明 | — |

---

## 7. 验收清单

- [ ] **向后兼容**：无 `ladder.egress` 的既有配置，梯子 rotate 仍回退主池；服务/Web 均无需改配置即可用。
- [ ] **加池/删除/清空**：Web 添加合法 socks5 → `ladder.egress` 落盘并即时生效；重复/非法（含 `direct`）被拒 400。
- [ ] **rotate 优先 + 隔离**：`mode=rotate` 且 `ladder.egress` 有 ≥2 → 每次新连接从梯子池轮换，**不改动网关 `_egressIdx`**；梯子池 1 个时固定用它不回主池。
- [ ] **回退链**：梯子池空 → 回退主池 ≥2 项轮换；主池也空 → 本地直连。
- [ ] **fixed 可选任一池**：fixed = 梯子池条目也能选中并走固定出口。
- [ ] **跨池转移矩阵**：`move-to-ladder`（主/限流/不可用 → 梯子）/ `ladder-to-egress` / `ladder-to-limited` / `ladder-to-dead` / `set-ladder` 全体走通，单出口绝不重复存在。
- [ ] **健康检查 + 自动归类**：scoped surf check 只测梯子池；失败项徽标 + 一键「→转移不可用」；可用项一键「→并入主池」。
- [ ] **动态生效**：池操作后「无需重启网关」即时生效（`needsRestart:false`）。
- [ ] **Web 一致性**：梯子池子区视觉与限流/不可用池一致（`.proxy-grid`/`.proxy-item`/badge）、批量勾选工具条、空态/联动刷新 fixed 下拉。
- [ ] **单测**：gateway 新增用例（normalize egress / ladderNextEgress 三级 / ladderCheck scope / mock 梯子池隧道）全 PASS；插件新增（writeGatewayConfig ladder.egress / 六 action / WEB_HTML 断言）全 PASS；async 用例走「顶层块真 await」。