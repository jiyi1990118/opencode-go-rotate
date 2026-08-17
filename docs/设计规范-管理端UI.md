# go-rotate Web 管理端 · 设计规范（8899 UI）

> 日期：2026-08-17
> 性质：**UI/UX 设计规范文档（只输出设计，不写生产代码）**
> 范围：8899 Web 管理端（`go-rotate.ts` 的 `WEB_HTML` 内嵌 `<style>` 全部替换 + 为 IA 重构预留的新 class）
> 基线：`/tmp/gr-web.html`（649 行现状页）+ `docs/信息架构规划-管理端.md`（新 IA）+ `docs/审计报告-管理端现状基线.md`（白名单/缺陷）
> 约束：**深色主题延续；零外部依赖（纯 CSS，无 CDN/框架/图标库）；CSS 可落地不膨胀（37 规则 → 93 规则，含 4 条 at 规则）；现有 id/class 全兼容（JS 依赖不破坏）**

---

## 0. 设计目标与三条铁律

1. **延续深色**：不换肤，只打磨。现有 `#0f1115/#171a21/#e6e8eb/#4ade80/#fbbf24/#f87171/#60a5fa/#2563eb` 全部纳入新 token 体系（语义色 hex 不动，中性色微调），保证任何未提的旧样式不跳色。
2. **零依赖**：CSS-only。图标用「彩色圆点 + 文本」代替；loading 用纯 CSS spinner / skeleton；确认框继续用原生 `confirm()`（CSS 预留模态框样式，接线待后续 JS）。
3. **兼容优先**：`docs/审计报告-管理端现状基线.md` §7 白名单中的 class（`.card/.badge/.b-*/.nav-btn/.stat/.msg/.err/.row/.actions/.muted/.mono/.small/.model-list/.gr-tip/.stats/.wrap/.sub/.primary/.danger/.nav/.block`）**全部原样保留并增强**；新增 class 一律 `ov-`/`gw-`/`log-`/`keys-` 系或语义名（`.banner/.dot/.toast/.skeleton/.table-wrap/.gw-config-grid/.log-row/.ov-strip/.interactive/.ghost/.sm/.loading/.modal*`），全部为「纯样式」或「未来 JS 接线预留」，当前 JS 零依赖、零改动。

---

## 1. 设计 token

### 1.1 色板（CSS 变量，`:root`）

**中性色（背景 → 表面 → 边框 → 文本 4 级递进）**

| token | hex | 用途 |
|---|---|---|
| `--bg-0` | `#0b0d10` | 页面背景（比旧 `#0f1115` 更深一档，拉开卡片层次） |
| `--bg-1` | `#11151c` | 卡片 / 表面（替换旧 `#171a21`，更冷更沉） |
| `--bg-2` | `#181d26` | 抬升表面：按钮底、hover、readonly 输入 |
| `--bg-3` | `#202636` | 按压态 / toast / 悬浮层 |
| `--bd-1` | `#1e242e` | 卡片边框（极弱，靠底色分层） |
| `--bd-2` | `#2c3442` | 输入框 / 按钮边框 / 空态虚线 |
| `--bd-3` | `#3a4354` | hover 边框（提亮一档） |
| `--tx-1` | `#e8eaed` | 主文本（旧 `#e6e8eb` 微调） |
| `--tx-2` | `#9aa3ad` | 次级文本 / 徽标文字（沿用） |
| `--tx-3` | `#6b7280` | 弱文本 / 占位 / 表头（沿用） |

**品牌 + 语义色（hex 全部沿用现有，零跳色）**

| token | hex | 用途 |
|---|---|---|
| `--brand` | `#3b82f6` | 主按钮底 / 导航 active / focus ring |
| `--brand-strong` | `#2563eb` | 品牌 hover（沿用旧 primary） |
| `--link` | `#60a5fa` | 文字链接（沿用） |
| `--success` | `#4ade80` | 可用 / 运行中 / 成功消息 |
| `--warning` | `#fbbf24` | 冷却 / 限流 |
| `--danger` | `#f87171` | 错误 / 删除 / 异常 |
| `--info` | `#60a5fa` | 当前 key / 信息 |

**语义 soft 底（徽标底色，12% alpha 同色相）**

| token | 值 | 用途 |
|---|---|---|
| `--success-soft` | `rgba(74,222,128,.12)` | `.b-available/.b-running` 底 |
| `--warning-soft` | `rgba(251,191,36,.12)` | `.b-cooling` 底 |
| `--danger-soft` | `rgba(248,113,113,.12)` | `.b-error` / danger 按钮底 |
| `--info-soft` | `rgba(96,165,250,.12)` | `.b-current` 底 / 当前行高亮 |

> 设计说明：深色管理端（Linear 系）的层次靠「底色亮度差 + 1px 边框」而非阴影；soft 底 = 语义色 12% alpha，比实心底更通透，是本次视觉升级的核心手法。

### 1.2 字体

| token | 值 |
|---|---|
| `--font-sans` | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`（补中文回退） |
| `--font-mono` | `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace` |

**字号 / 字重 / 行高规范**

| 层级 | 字号 | 字重 | 行高 | 用途 |
|---|---|---|---|---|
| Display | 24px | 600 | 1.2 | `.stat .v` 状态大数字（tabular-nums） |
| 标题 | 20px | 600 | 1.3 | `h1` 页头 |
| 正文 | 14px | 400 | 1.5 | body / 表格单元格 |
| 按钮 | 13px | 500 | 1 | `button` |
| 小字 | 12px | 400 | 1.5 | `.small/.muted/.badge/表头/th` |
| 日志 | 12px | 400 | 1.6 | `pre/code` 等宽 |

规则：字号仅用 12/13/14/20/24 五档；字重仅用 400/500/600 三档（700 禁用，深色 UI 700 发糊）；大数字开 `font-variant-numeric: tabular-nums` 防止轮询刷新时数字跳动。

### 1.3 间距 / 圆角 / 边框 / 阴影

**间距（4px 基数）**

| token | 值 | 典型用途 |
|---|---|---|
| `--sp-1` | 4px | 徽标内距、点与文字间隙 |
| `--sp-2` | 8px | 按钮 gap、卡片内元素行距 |
| `--sp-3` | 12px | 区块内子块间距 |
| `--sp-4` | 16px | 卡片 padding、卡片间距、双列 gap |
| `--sp-5` | 20px | 页头与导航间距 |
| `--sp-6` | 24px | 概览状态条格间距 |

**圆角**

| token | 值 | 用途 |
|---|---|---|
| `--r-sm` | 6px | 按钮 / 输入框 / 徽标底 / banner / pre |
| `--r-md` | 10px | 卡片（沿用旧值） |
| `--r-lg` | 14px | 模态框 |
| `--r-pill` | 999px | 徽标胶囊 / 状态点 |

**边框**：全部 1px；按钮/输入用 `--bd-2`，卡片用 `--bd-1`，hover 升 `--bd-3`。空状态用 `1px dashed`。

**阴影层级（深色 UI 阴影克制，主打 focus ring）**

| token | 值 | 用途 |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.3)` | 卡片默认（几乎不可见，仅压浮） |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.3)` | 卡片 hover 上浮 / 骨架层 |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,.45)` | toast / 模态框 |
| `--ring` | `0 0 0 3px rgba(59,130,246,.35)` | 键盘 focus 环（输入 / 按钮） |

**动效**

| token | 值 |
|---|---|
| `--dur` | `150ms` |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` |

统一过渡属性：`background / border-color / color / box-shadow / transform / opacity` 六项，`transition` 一律写 `150ms cubic-bezier(.2,.8,.2,1)`。

---

## 2. 组件规范

### 2.1 按钮

| 变体 | 形态 | 用途 |
|---|---|---|
| 默认（secondary） | `bg-2` 底 + `bd-2` 边 + 主文本 | 「轮换 / 检测 / 启动 / 编辑 / 刷新」等中频操作 |
| `.primary` | 品牌蓝实底白字 | 「新增 key / 切换并重启 / 导航 active」核心操作 |
| `.danger` | `danger-soft` 底 + 深红边 + 浅红字 | 「删除 / 清空日志 / 关闭 Web / 清除 token」破坏性操作 |
| `.ghost`（新增） | 透明底无边 + 弱文本 | 低权重行内动作（预留） |
| `.sm`（新增） | 高 26px / 字号 12px | 表格行内操作按钮紧凑化（`.actions button` 自动应用） |
| `.loading`（新增） | 前置 CSS spinner + 半透明 | 长操作进行中（`gwManage` 的「启动中…」可接线） |
| `:disabled` | `opacity:.45` + `pointer-events:none` | 状态互斥（web 开关 / 网关启停矩阵） |

```css
button { font:inherit; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 12px; border-radius:var(--r-sm); border:1px solid var(--bd-2);
  background:var(--bg-2); color:var(--tx-1); cursor:pointer; font-size:13px; font-weight:500;
  white-space:nowrap; transition:background var(--dur) var(--ease), border-color var(--dur) var(--ease),
  color var(--dur) var(--ease), transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
button:hover { background:var(--bg-3); border-color:var(--bd-3); }
button:active { transform:translateY(.5px); }
button:focus-visible { outline:none; box-shadow:var(--ring); }
button:disabled, button[disabled] { opacity:.45; cursor:not-allowed; pointer-events:none; }
button.primary { background:var(--brand); border-color:var(--brand); color:#fff; }
button.primary:hover { background:var(--brand-strong); border-color:var(--brand-strong); }
button.danger { background:var(--danger-soft); border-color:rgba(127,29,29,.9); color:#fca5a5; }
button.danger:hover { background:rgba(248,113,113,.22); border-color:#7f1d1d; }
button.ghost { background:transparent; border-color:transparent; color:var(--tx-2); }
button.ghost:hover { background:var(--bg-2); color:var(--tx-1); }
button.sm, .actions button { height:26px; padding:0 8px; font-size:12px; border-radius:5px; }
button.loading { pointer-events:none; opacity:.75; }
button.loading::before { content:""; width:12px; height:12px; border:2px solid rgba(255,255,255,.35);
  border-top-color:#fff; border-radius:50%; animation:spin .6s linear infinite; flex:none; }
button.danger.loading::before { border-color:rgba(252,165,165,.35); border-top-color:#fca5a5; }
@keyframes spin { to { transform:rotate(360deg) } }
```

### 2.2 徽标（badge）+ 状态点（dot）

**徽标**：胶囊形 `pill`、12px/500、语义 soft 底 + 语义字。沿用 `.b-*` 五类 + 新增三别名（供 JS 未来按健康状态分色，当前 JS 只发 `b-cooling` 时不破坏）。

```css
.badge { display:inline-flex; align-items:center; gap:5px; padding:2px 8px;
  border-radius:var(--r-pill); font-size:12px; font-weight:500; line-height:1.5; white-space:nowrap; }
.b-available, .b-running  { background:var(--success-soft); color:var(--success); }
.b-cooling,  .b-warn      { background:var(--warning-soft); color:var(--warning); }
.b-current,  .b-info      { background:var(--info-soft);    color:var(--info); }
.b-stopped,  .b-neutral   { background:rgba(154,163,173,.12); color:var(--tx-2); }
.b-error,    .b-invalid   { background:var(--danger-soft);  color:var(--danger); }
```

**状态点**：8px 圆点，语义色 + 微光晕，用于「key 健康 / 网关运行态」的视觉锚点（配合文本，色盲安全——点 + 字双通道）。

```css
.dot { width:8px; height:8px; border-radius:50%; display:inline-block;
  background:var(--tx-3); flex:none; }
.dot.ok  { background:var(--success); box-shadow:0 0 6px rgba(74,222,128,.5); }
.dot.warn{ background:var(--warning); box-shadow:0 0 6px rgba(251,191,36,.5); }
.dot.err { background:var(--danger);  box-shadow:0 0 6px rgba(248,113,113,.5); }
```

**健康状态 → 视觉色映射表（CSS 已就绪；JS 改色属 B 组增强，当前不强制）**

| 状态 | 建议视觉 | 现 JS 渲染（`/tmp/gr-web.html` L225-233） |
|---|---|---|
| ok / 可用 | `dot.ok` + `.b-available`（绿） | `.b-available` ✅ |
| cooling | `dot.warn` + `.b-cooling`（琥珀） | `.b-cooling` ✅ |
| current | `.b-current`（蓝） | `.b-current` ✅ |
| invalid / nobalance / error | `dot.err` + `.b-invalid`（红） | 现全部 `.b-cooling`（琥珀，**语义不符**，待 B 组修） |
| limited | `dot.warn` + `.b-warn`（琥珀） | 现 `.b-cooling`（同色，可接受） |
| running / stopped / 鉴权 | `.b-running`（绿）/ `.b-stopped`（灰）/ `.b-current`（蓝） | ✅ 已按态分色 |

### 2.3 输入框

```css
input { font:inherit; width:100%; height:30px; padding:4px 10px;
  background:var(--bg-0); border:1px solid var(--bd-2); border-radius:var(--r-sm);
  color:var(--tx-1); transition:border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease); }
input::placeholder { color:var(--tx-3); }
input:focus { outline:none; border-color:var(--brand); box-shadow:var(--ring); }
input[readonly] { background:var(--bg-2); color:var(--tx-2); }
input[type="checkbox"], input[type="radio"] { width:auto; height:auto;
  accent-color:var(--brand); margin:0 4px 0 0; }
```

说明：输入底比卡片更深（`bg-0`），保持「内凹」视觉；token 明文输入框 readonly 用 `bg-2` 区分；checkbox/radio 用 `accent-color` 染品牌蓝（零成本现代感）。

### 2.4 卡片

```css
.card { background:var(--bg-1); border:1px solid var(--bd-1); border-radius:var(--r-md);
  padding:var(--sp-4); margin-bottom:var(--sp-4); box-shadow:var(--shadow-sm);
  transition:border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
  transform var(--dur) var(--ease); }
.card:hover { border-color:var(--bd-2); }                     /* 全局：仅提亮边框 */
.card.interactive:hover { border-color:var(--bd-3); box-shadow:var(--shadow-md); transform:translateY(-1px); }
```

- 全局 `.card:hover` 只提亮边框（安全，不打扰降级灰卡）；
- `.interactive`（新 class）才上浮 1px + 阴影（用于「可点卡片」如空态引导，由未来 JS/HTML 按需加）；
- `#gateway-card` 降级灰卡由 JS 内联 `opacity:.55` 驱动，CSS 不干预。

### 2.5 表格

```css
.table-wrap { overflow-x:auto; border-radius:var(--r-sm); }   /* 横向滚动容器（IA A5 加 wrapper） */
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--bd-1); vertical-align:middle; }
th { color:var(--tx-3); font-weight:500; font-size:12px; white-space:nowrap; }
tbody tr { transition:background var(--dur) var(--ease); }
tbody tr:hover { background:rgba(255,255,255,.02); }
tbody tr:last-child td { border-bottom:none; }
tbody tr:has(.b-current) { background:var(--info-soft); }      /* 当前 key 行淡蓝高亮（:has 降级无害） */
```

- 表头 12px 弱文本、单元格 14px；行 hover 仅 2% 白（克制）；
- 「当前 key」行用 `:has(.b-current)` 淡蓝底（现代浏览器可用，旧浏览器静默降级）；
- 行内操作按钮经 `.actions button`（§2.1）自动紧凑化。

### 2.6 导航

```css
.nav { display:flex; gap:6px; margin-bottom:var(--sp-4); flex-wrap:wrap; }
.nav-btn { height:32px; padding:0 14px; border-radius:var(--r-sm);
  background:transparent; border-color:transparent; color:var(--tx-2); font-size:13px; font-weight:500; }
.nav-btn:hover { background:var(--bg-2); color:var(--tx-1); }
.nav-btn.active { background:var(--brand); border-color:var(--brand); color:#fff; }
.nav-btn.active:hover { background:var(--brand-strong); }
```

active 保持实心品牌蓝（强语义，与旧一致）；hover 灰底不抢 active。

### 2.7 状态面板格（stat + 概览状态条）

```css
.stats { display:flex; gap:var(--sp-6); flex-wrap:wrap; }
.stat .v { font-size:24px; font-weight:600; line-height:1.2;
  font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
.stat .l { font-size:12px; color:var(--tx-2); margin-top:2px; }
.ov-strip .stat { flex:1 1 0; min-width:110px; }               /* 概览 6 格均分 */
.ov-strip .stat + .stat { border-left:1px solid var(--bd-1); padding-left:var(--sp-6); }
#s-current { color:var(--link); }                               /* 当前 key 品牌蓝强调 */
```

- 大数字 24px/600/tabular-nums（轮询刷新不跳动）；
- 概览 6 格加细分隔线，Linear 式「一行仪表」；
- **首屏焦点**：`#s-current` 直接 CSS 锁定品牌蓝 + 网关徽标（§2.2 `.b-running`）高亮——零 JS。

### 2.8 空状态横幅（banner）

```css
.banner { display:flex; align-items:flex-start; gap:var(--sp-2); padding:10px 14px;
  border:1px dashed var(--bd-2); border-radius:var(--r-sm); background:var(--bg-0);
  color:var(--tx-2); font-size:13px; line-height:1.6; }
.banner b { color:var(--tx-1); font-weight:500; }
```

虚线框 + 深底 + 弱文本 = 「占位区」语义；用于 0 key / 网关未装 / token 未设三处（IA D7）与概览引导条（`ov-hint`，`①②③` 序号用 `<b>` 加粗）。

### 2.9 消息 msg / err + toast

```css
.msg { color:var(--success); font-size:13px; min-height:18px; margin-top:var(--sp-2);
  animation:fadeIn var(--dur) var(--ease); }
.err { color:var(--danger); }
@keyframes fadeIn { from { opacity:0; transform:translateY(-2px); } to { opacity:1; transform:none; } }
/* toast：固定右下角胶囊，未来 copyToken/操作反馈用（JS 加 .show 触发） */
.toast { position:fixed; right:24px; bottom:24px; z-index:100; max-width:320px;
  padding:10px 16px; border-radius:var(--r-sm); background:var(--bg-3);
  border:1px solid var(--bd-2); color:var(--tx-1); font-size:13px; box-shadow:var(--shadow-lg);
  opacity:0; transform:translateY(8px); pointer-events:none;
  transition:opacity .2s var(--ease), transform .2s var(--ease); }
.toast.show { opacity:1; transform:none; }
.toast.success { border-color:rgba(74,222,128,.4); }
.toast.error { border-color:rgba(248,113,113,.4); }
```

- `.msg` 保持绿/红双态（`showMsg/showErr` 只切 `.err`，零 JS 改动）；新增 fadeIn 入场；
- toast 预留：复制成功（B4）、破坏性操作完成等未来接线（当前复制仍走 `token-msg` 内联，不破坏）。

### 2.10 日志 pre / 行内 code

```css
pre { margin:0; background:var(--bg-0); border:1px solid var(--bd-1); border-radius:var(--r-sm);
  padding:12px; font-family:var(--font-mono); font-size:12px; line-height:1.6;
  overflow:auto; max-height:260px; color:#9ceba8; }
code { font-family:var(--font-mono); font-size:12px; background:var(--bg-2);
  border:1px solid var(--bd-1); border-radius:4px; padding:1px 5px; color:var(--tx-1); }
.model-list { font-size:12px; color:var(--tx-2); word-break:break-all; line-height:1.7; }
details summary { cursor:pointer; color:var(--tx-2); font-size:12px; }
details summary:hover { color:var(--tx-1); }
```

### 2.11 骨架屏 / 模态框（预留，非当前）

```css
.skeleton { background:linear-gradient(90deg,var(--bg-2) 25%,var(--bg-3) 50%,var(--bg-2) 75%);
  background-size:200% 100%; animation:shimmer 1.4s linear infinite; border-radius:4px; }
@keyframes shimmer { to { background-position:-200% 0 } }
.modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,.55);
  display:flex; align-items:center; justify-content:center; z-index:200; }
.modal { width:min(420px, calc(100vw - 32px)); background:var(--bg-1);
  border:1px solid var(--bd-2); border-radius:var(--r-lg); padding:var(--sp-5); box-shadow:var(--shadow-lg); }
```

> 当前确认框仍用原生 `confirm()`（零依赖约束）；`.modal*` 与 `.skeleton` 为 P2-6（加载态）与自定义确认（可选）预留，JS 接线时直接可用。

---

## 3. 页面视觉布局预览

### 3.1 桌面（≥720px，`max-width: 1060px`）—— 按新 IA（信息架构规划 §3.1）

```
┌─ wrap (max-width 1060px, padding 24px 20px 80px) ─────────────────────────────┐
│  go-rotate · opencode-go keys          ← h1 20px/600                         │
│  多 key 自动轮换 · 修改会自动同步…       ← .sub 13px muted                     │
│  ┌────────────────────────────────────────────────────────┐                  │
│  │ [概览●] [Key 管理] [网关管理] [统计] [设置]              │ ← .nav  active 实心蓝│
│  └────────────────────────────────────────────────────────┘                  │
│                                                                              │
│  ▓ 概览 · 只读状态面板（.card + .ov-strip，一行 6 格带分隔线）                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  当前 key     可用        网关        最近轮换     冷却窗口    Web 自动 │   │
│  │   test       1/2        ● 运行中      10:32:04    300 min    开启     │   │
│  │  （品牌蓝强调） （大数字） （绿点+徽标） （弱文本）  （只读+去设置跳链）      │   │
│  │  ─ 首上手引导条（0 key 时显示）：① 添加 key → Key 管理　② 启动网关 → 网关…│   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ▓ Key 管理 · 主操作区                                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  [名称____][sk-xxxx…][+ 新增 key]      ← primary 实心蓝                 │   │
│  │  （空态虚线横幅：还没有 key → 粘贴第一个 opencode-go key…）               │   │
│  │  [轮换] [检测所有 key]  检测中…        ← secondary 灰                    │   │
│  │  ┌──────────────────────────────────────────────────────────┐         │   │
│  │  │ 名称  Key          状态                    健康  操作    │         │   │
│  │  │ act1  sk-epy…80  ●可用 [当前]（淡蓝行）      ●可用 冷却…  │         │   │
│  │  │ act2  sk-epy…11  ●冷却 12min               -      启用…  │         │   │
│  │  └────────────────────────────────────────────── 行 hover 2%白 ┘         │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ▓ 网关管理 · 状态主卡 2/3 + 配置子区 1/3（.gw-config-grid）                  │
│  ┌──────────────────────────┬──────────────────────────────────────────┐    │
│  │  状态卡（主，高频）        │  套餐卡（配置）                            │    │
│  │  ●运行中 v1.1.0 127.0.0.1:18888 │  ◉ Go 订阅  ◯ Zen 免费              │    │
│  │  当前key 可用 轮换 请求 模型（大数字×5）│  [切换并重启]  plan-meta       │    │
│  │  [启动][停止][重启]       │  ─────────────────────────────────    │    │
│  │  用量 perKey 表 + 模型 details │  Token 卡（配置）                     │    │
│  │   （降级态：整卡 opacity .55 灰） │  ●鉴权开启 · token 输入 + 5 按钮     │    │
│  └──────────────────────────┴──────────────────────────────────────────┘    │
│                                                                              │
│  ▓ 统计 · 分析与日志（.log-row 双列）                                         │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  轮换统计：总轮换 12（品牌蓝大数字）· 每 key 被切到/进冷却/最近切换        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│  ┌────────────────────────────┬─────────────────────────────────────────┐   │
│  │  运行日志                    │  网关日志                                │   │
│  │  ☐自动刷新 [过滤____][清空]  │  来源: gateway [刷新]                   │   │
│  │  ┌─ pre（12px mono 绿字）─┐ │  ┌─ pre ──────────────────────────────┐ │   │
│  │  │ 2026-08-17 10:32:04 … │ │  │ 2026-08-17 10:31:58 …              │ │   │
│  └────────────────────────────┴─────────────────────────────────────────┘   │
│                                                                              │
│  ▓ 设置 · 全局配置                                                           │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  全局冷却窗口：300 分钟 [编辑]   Web 自动启动：开启 [开启][关闭]        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 移动（<720px，单列堆叠）

```
┌─ 页头 ────────────────┐
│ go-rotate · opencode  │
│ [概览][Key管理][网关][统计][设置]   ← .nav 横向滚动（nowrap + 隐藏滚动条）
├───────────────────────┤
│ ▓ 概览（2 列网格）     │
│ 当前key│可用           │
│ 网关●│最近轮换         │
│ 冷却│Web             │
│ ─ 引导条 ─            │
├───────────────────────┤
│ ▓ Key 管理            │
│ 新增行（纵向堆叠）     │
│ 表格 → .table-wrap 横向滚动（min-width 720px）
│ 操作按钮 flex-wrap     │
├───────────────────────┤
│ ▓ 网关（状态卡 → 套餐 → Token 顺序堆叠）
│ ▓ 统计（轮换统计 → 运行日志 → 网关日志堆叠）
│ ▓ 设置                │
└───────────────────────┘
```

### 3.3 首屏焦点引导（视觉层级规则）

| 层级 | 手法 | 实现 |
|---|---|---|
| 第一眼 | 当前 key（品牌蓝大数字）+ 网关运行徽标（绿点） | `#s-current` CSS 锁定 + `.b-running` 徽标 |
| 第二眼 | 概览 6 格状态条（分隔线 + 大数字） | `.ov-strip` |
| 引导 | 0 key 时横幅引导（①②③ 线性步骤） | `.banner` |
| 主动作 | Key 管理「新增 key」primary 实心蓝 | `.primary` |
| 次级 | 其它卡片统一灰面 1px 边框，hover 才提亮 | `.card:hover` |

---

## 4. 交互与微动效

| 元素 | hover | active | focus | loading | 成功/失败反馈 |
|---|---|---|---|---|---|
| 按钮 | 底 `bg-2→bg-3` + 边升 `bd-3` | `translateY(.5px)` 按压 | `--ring` 蓝环（键盘） | `.loading` 前置 spinner + `pointer-events:none` | — |
| 导航 | 灰底 `bg-2` | 同按钮 | 同按钮 | — | active 实心蓝 |
| 卡片 | 边框 `bd-1→bd-2`；`.interactive` 再上浮 1px + 阴影 | — | — | 未来 skeleton 内嵌 | 网关降级整卡 `opacity:.55`（JS 已有） |
| 表格行 | 2% 白底 | — | — | 初始 `加载中…` 弱文本 | 当前 key 行淡蓝（`:has`） |
| 输入框 | 边框 `bd-2` | — | `border` 品牌蓝 + `--ring` | — | 校验错误红字（`showErr`） |
| 消息 | — | — | — | — | 成功绿 `msg` / 失败红 `err`（fadeIn 入场，3s 后清空沿用） |
| toast | — | — | — | — | 固定右下角，`.show` 淡入上移，2s 后移除（未来接线） |

**状态可视化（双通道：圆点 + 文本）**
- key 健康：`●可用`（绿） / `●冷却 12min`（琥珀） / `●无效`（红，待 B 组改色） / `●限流`（琥珀）；
- 网关运行态：`●运行中`（绿徽标）/ `●未运行`（灰）/ `●未安装`（灰）/ `●状态获取失败`（红）；
- 鉴权态：`●鉴权开启`（蓝 info）/ `●鉴权关闭`（灰）。

**轮询刷新不打扰（动效约束）**
- 大数字 `tabular-nums` + 不加动画——轮询 5s 刷新时数字不跳、不闪；
- 表格 5s 重建期间行 hover/点击被打断属既有架构问题（审计 P2-2），本轮 CSS 不做 diff 渲染（那是 JS 重构），仅保证 hover 过渡 150ms 视觉平滑；
- 消息 fadeIn 150ms，不放大动效——管理端以「稳定」为第一优先，动画全部 ≤200ms。

**确认弹窗**：保持原生 `confirm()`（零依赖）；`.modal*` 样式已预留，未来自定义确认（含警告图标位）接线即用。

---

## 5. 响应式方案

| 断点 | 行为 |
|---|---|
| ≥720px（桌面） | `.wrap` 1060px 单栏主卡 + 双列网格：`.gw-config-grid`（状态 2/3 + 配置 1/3）、`.log-row`（运行/网关日志 1/2+1/2） |
| <720px（移动） | 全部单列堆叠；`.ov-strip` 转 2 列网格（去分隔线）；`.nav` 横向滚动（nowrap + 隐藏滚动条）；`.table-wrap table` `min-width:720px` 横向滚动；`pre` 高度 260→160px；`.stats` gap 收窄 |

```css
@media (max-width:720px){
  .wrap { padding:16px 12px 64px; }
  .nav { flex-wrap:nowrap; overflow-x:auto; padding-bottom:2px;
    -webkit-overflow-scrolling:touch; scrollbar-width:none; }
  .nav::-webkit-scrollbar { display:none; }
  .gw-config-grid, .log-row { grid-template-columns:1fr; }
  .ov-strip { display:grid; grid-template-columns:repeat(2,1fr); gap:var(--sp-3) var(--sp-4); }
  .ov-strip .stat { min-width:0; }
  .ov-strip .stat + .stat { border-left:none; padding-left:0; }
  .stats { gap:var(--sp-4); }
  pre { max-height:160px; }
  .table-wrap table { min-width:720px; }
}
```

> 注：`nav` 移动端 nowrap 横向滚动（IA 任务要求）；`flex-wrap` 桌面保留（5 个按钮 1060px 内放得下）。`.table-wrap` 包装器由 IA A5 在 HTML 侧添加；在此之前移动端表格溢出由页面横向滚动兜底，行为与现状一致。

---

## 6. 完整 CSS 代码块（可直接替换 `WEB_HTML` 内 `<style>`）

> 93 规则（89 条普通规则 + 4 条 `@keyframes/@media`）/ 约 205 行；零外部依赖；与 §1-§5 一致。替换后现有 JS（`.block` 切换、`.b-*` 徽章、`showMsg/showErr`、网关灰卡降级、行内按钮）全部兼容；IA 重构的新 class（`.banner/.gw-config-grid/.log-row/.ov-strip/.table-wrap/.dot/.toast/.skeleton/.interactive/.ghost/.sm/.loading/.modal*`）已就绪。

```html
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
  .gw-config-grid { display: grid; grid-template-columns: 2fr 1fr; gap: var(--sp-4); align-items: start; }
  .log-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-4); align-items: start; }
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
  .card:hover { border-color: var(--bd-2); }
  .card.interactive:hover { border-color: var(--bd-3); box-shadow: var(--shadow-md);
                            transform: translateY(-1px); }

  /* ============ 状态面板 ============ */
  .stats { display: flex; gap: var(--sp-6); flex-wrap: wrap; }
  .stat .v { font-size: 24px; font-weight: 600; line-height: 1.2;
             font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
  .stat .l { font-size: 12px; color: var(--tx-2); margin-top: 2px; }
  .ov-strip .stat { flex: 1 1 0; min-width: 110px; }
  .ov-strip .stat + .stat { border-left: 1px solid var(--bd-1); padding-left: var(--sp-6); }
  #s-current { color: var(--link); }

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
</style>
```

---

## 7. 核心视觉决策总结

1. **深色不换肤，用「底色亮度差」代替阴影做层次**：背景 `#0b0d10` → 卡片 `#11151c` → 抬升 `#181d26` → 按压 `#202636` 四级递进，卡片仅 1px 极弱边框 + 微阴影——Linear 式克制分层，同时延续旧色系零跳色。
2. **状态可视化 = 彩色圆点 + 文本双通道**：key 健康 / 网关运行态 / 鉴权态统一用语义色圆点（含微光晕）锚定视觉，色盲友好（点 + 字）；为 invalid/nobalance/error 预置 `.b-invalid` 红徽标（现 JS 误统一为琥珀冷却色，CSS 已就绪待 B 组接线）。
3. **首屏焦点由纯 CSS 达成**：`#s-current` 品牌蓝 + 概览 6 格分隔状态条 + 网关徽标，零 JS 即实现「当前 key 与网关运行态」第一眼可见（呼应 IA「概览=只读 glance」）。
4. **微交互全部 ≤200ms 且克制**：按钮按压 0.5px、卡片 hover 提亮（`.interactive` 才上浮）、表格行 2% 白、大数字 tabular-nums 防轮询跳动——管理端以稳定优先，动效只是反馈不是表演。
5. **零依赖落地**：图标用圆点/徽标替代，loading 用纯 CSS spinner + skeleton，确认框保持原生 confirm（模态框样式预留），toast 样式就绪待 B4 接线——不引入任何 CDN/框架/图标库。
6. **兼容即安全**：全部既有 class/id 原样保留（审计白名单逐项核对），新增 class 纯样式零 JS 依赖；93 规则 / 约 205 行，一次替换 `<style>` 即可上线，IA 重构（A5 加 `.table-wrap/.gw-config-grid/.log-row/.banner`）时 CSS 已全部就绪。

---

## 附：与两份规划文档的对应关系

| 规划要求 | 本规范落点 |
|---|---|
| IA D8 桌面双列 1060px | §2.5/§6 `.gw-config-grid`（2fr+1fr）、`.log-row`（1fr+1fr）、`.wrap` 1060px |
| IA 3.3 视觉层级（主/次/从/空态） | §3.3 层级表 + §2.4 卡片 + §2.8 banner |
| IA 5.3 新增元素 | `.banner/.gw-config-grid/.log-row/.ov-strip` 全部有样式；`#ov-gw-state`（绿点）、`#ov-last-rotate`（弱文本）随 `.stat .v/.l` 自动生效 |
| 审计 P2-4 响应式缺失 | §5 720px 断点：导航横滚、表格横滚容器、状态条 2 列、pre 降高 |
| 审计 P2-6 无加载态 | §2.11 `.skeleton` + §2.1 `button.loading`（预留，JS 接线即用） |
| 审计 §7 白名单 | §2 全部组件保留旧 class 名并增强，零改名 |
| 审计 P1-1 XSS 修复 | CSS 不参与；XSS 属 JS innerHTML 转义/`textContent` 改造（B 组），本规范不越界 |
