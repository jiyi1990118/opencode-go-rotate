# go-rotate Web 管理界面使用文档

> 版本基线：2026-08-16（**Team A Web 增强之前**的基线，见文末「增强前基线」）
> 适用对象：插件内置 Web 管理界面（`go-rotate.ts` 的 `WEB_HTML` + `handleWeb()`），端口 **8899**。

## 1. 访问方式

| 方式 | 命令 / 操作 | 说明 |
|---|---|---|
| opencode 启动自动起 | 启动 opencode（自动加载插件 `~/.config/opencode/plugins/go-rotate.ts`） | 默认 `auto_web=true`，opencode 一启动就在 8899 起 Web |
| 独立启动（不开 opencode） | `go-rotate web` | 通过 `bun -e` 加载插件模块调用 `GoRotate()` 起 Web，Ctrl+C 停止 |
| 关闭自动启动 | `go-rotate web off` | 之后 opencode 启动不再占 8899（**轮换功能不受影响**） |
| 恢复自动启动 | `go-rotate web on` | 下次 opencode 启动时自动起 Web |

访问地址：**http://localhost:8899**（绑定 127.0.0.1，仅本机可访问）。

### Web 启动规则（startWeb）

- 端口绑定成功 → 日志 `🌐 Web 管理界面: http://localhost:8899`，`webStarted=true`。
- 端口被占用 → 请求 `http://127.0.0.1:8899/api/status` 健康检查：
  - 返回 200（是自家实例）→ 日志「检测到已有 go-rotate web 实例，不再重复启动」——**全系统只启动一个 Web**。
  - 非自家 → 日志「端口被其它程序占用，web 未启动」。
- `auto_web=false` 且未强制（`GOROTATE_FORCE_WEB=1`）→ 跳过启动，轮换仍可用。

## 2. 页面布局与功能说明

单页深色主题（暗色），自包含 HTML/CSS/JS，无外部依赖。自上而下三张卡片：

### 卡片 1：状态卡（stats + Web 开关）

| 元素 | 含义 |
|---|---|
| 当前 key | 当前生效 key 的 name（来自 `status.current`） |
| 可用 x/y | 可用数 / 总数（`availableCount` / `keyCount`），旁边小字 `total y` |
| 冷却窗口(min) | **全局**冷却窗口分钟数（`cooldown_minutes`） |
| Web 自动启动 | `auto_web` 开关状态（开启/关闭） |
| 关闭 Web（danger） | `confirm` 后调 `/api/web/off`：写 `auto_web=false` + 停止 server（300ms 后），页面提示重新启动方法。轮换功能不受影响 |
| 开启自动启动 | 调 `/api/web/on`：写 `auto_web=true` **并立即拉起**（若 server 未运行则 `startWeb()`，响应带 `restarted`；已在运行则仅写配置） |

### 卡片 2：key 管理表

- **新增 key**：名称 + 完整 `sk-` key → `/api/keys/add`。添加后**立即真实探测**该 key 健康（消耗约 1 token），提示「可用 / key 无效 / 余额不足 / 限流」。
- **手动操作行**：
  - **轮换**：`/api/rotate`，当前 key 进冷却（按独立窗口→全局→默认 300min）并切到下一个可用 key。
  - **检测所有 key**：`/api/keys/check`，逐个真实探测并写 `last_status`（见 §4 安全说明）。
- **表格列**：名称 / Key（masked，hover 显示完整值）/ 状态（徽章：可用 / 冷却 Xmin / 无效 / 余额不足 / 限流，当前 key 额外「当前」蓝徽章）/ 健康（探测结果 hover 详情）/ 操作。
- **行内操作按钮**：
  - 启用（非当前 key）→ `/api/current {name}`。
  - 冷却 / 清除冷却 → `/api/cooldown {name, minutes}`：清除=0；冷却=**全局** `cooldown_minutes`。
  - 窗口 / 清窗 → `/api/cooldown/window {name, minutes}`：设置/清除该 key **独立**冷却窗口（留空=清除回退全局）。
  - **编辑** → 两个 `prompt`（新名称可空=不改、新 key 值可空=不改）→ `POST /api/keys/update {name, patch:{key?,name?}}`；两者都留空则提示不调 API；编辑当前 key 的名称时 `current` 自动跟随（`updateKey` 逻辑）。
  - 删除（danger）→ `/api/keys/delete {name}`，`confirm` 确认后删除。

### 卡片 3：运行日志

- 显示 `/tmp/opencode-go-rotate.log` 尾部 **300 行**（`logTail(300)`），每 8s 自动刷新。
- **清空日志**（danger）：`confirm` 后调 `/api/log/clear`，同时删除归档 `.1/.2/.3`。

页面 JS：`refresh()` 每 5s 轮询 `/api/status`；`refreshLog()` 每 8s 轮询 `/api/log`。

## 3. API 端点速查表

`handleWeb()` 路由，`POST` 统一收 JSON body。所有写操作返回 `{ok, status: statusPayload()}`（add 额外返回 `health`）。

| 方法 | 路径 | 参数(JSON) | 返回 | 说明 |
|---|---|---|---|---|
| GET | `/` 或 `/index.html` | - | HTML | 管理页面（自包含） |
| GET | `/api/status` | - | `{provider_id, cooldown_minutes, current, auto_web, keyCount, availableCount, keys[]}` | 状态；`keys[]` 每项含 `name/key/masked/state/remainMin/cooldown_until/cooldown_minutes/last_status/isCurrent` |
| GET | `/api/log` | - | 纯文本 | 日志尾部 300 行 |
| GET/POST | `/api/keys/check` | -（路由无方法判断，GET 亦可触发） | `{results:{name:{status,detail}}}` | **真实探测所有 key** + 写 `last_status`（消耗 ~1 token/key） |
| POST | `/api/keys/add` | `{name,key}` | `{ok,health,status}` | 新增并立即探测健康 |
| POST | `/api/keys/update` | `{name, patch:{key?,name?}}` | `{ok,status}` | 更新 key 值 / 改名；编辑当前 key 名称时 `current` 跟随 |
| POST | `/api/keys/delete` | `{name}` | `{ok,status}` | 删除 key |
| POST | `/api/current` | `{name}` | `{ok,status}` | 设为当前 |
| POST | `/api/cooldown` | `{name, minutes:number\|null}` | `{ok,status}` | 设置冷却（null/0=清除） |
| POST | `/api/rotate` | `{}` | `{ok,status}` | 手动轮换 |
| POST | `/api/web/off` | `{}` | `{ok,shutting_down,auto_web:false}` | `auto_web=false` + 300ms 后停 server |
| POST | `/api/web/on` | `{}` | `{ok,auto_web:true,restarted}` | 开自动启动 + **立即重启**（server 未运行时拉起；`restarted` 表示本次是否真的拉起） |
| POST | `/api/log/clear` | `{}` | `{ok,status}` | 清空日志 + 删归档 |
| 其它 | 任意未匹配 | - | 404 `{"error":"not found"}` | POST 处理抛错时 400 `{"error":msg}` |

所有写操作带**跨进程文件锁**（`withLockSync`：O_EXCL + 陈旧锁检测 + 5s 超时降级）与**原子写**（.tmp + rename），与 CLI / zen-gateway 同一套并发安全机制。

## 4. 安全说明

- **仅绑定 127.0.0.1**，默认只允许本机访问；**无任何 token / 鉴权**。切勿通过端口转发 / 代理把 8899 暴露到局域网或公网——任何能访问到它的人都能增删 key、改当前 key、清冷却。
- **`/api/keys/check` 与「新增 key」会真实探测（真实网络请求）**：每次探测消耗约 **1 token**（模型 `hy3` + `max_tokens:1`）。探测频率不高可忽略，但频繁点击会消耗配额；且 `check` 会把 `last_status` 写进 `go-keys.json`（非纯只读）。
- 页面 `hover` key 会显示**完整 key 值**（`title` 属性），小心截图 / 录屏泄露。
- 写操作会同步到 `~/.local/share/opencode/auth.json`（`syncAuth`），删除 / 轮换会直接影响当前会话的请求注入——操作前确认。

## 5. 与 zen-gateway 的端口区别

| 服务 | 端口 | 用途 | 绑定 |
|---|---|---|---|
| **go-rotate Web** | **8899** | opencode-go key 管理（增删/轮换/冷却/日志） | 127.0.0.1 |
| **zen-gateway** | **18888** | OpenAI/Anthropic/Responses 兼容网关（给 claude code/codex/cursor 用） | 默认 127.0.0.1 |

两者**共用 `go-keys.json` 与自动轮换**，但协议与端口完全独立。`zen-gateway` 的用量趋势在 `/api/usage`（内存计数）与 `usage.jsonl`（持久化），**不在** go-rotate Web 的 8899 上。

## 6. FAQ

**Q：Web 关了怎么开？**
三种方式：`go-rotate web`（立即起，当前进程 Ctrl+C 停）；页面/API 调 `/api/web/on`（写 `auto_web=true` **并立即重启**，无需等 opencode 重启）；`go-rotate web on` 后重启 opencode（自动起）。页面关闭后轮换功能不受影响。

**Q：为什么只启动一个实例 / 端口冲突？**
`startWeb` 绑定 8899 失败时会请求 `/api/status` 做健康检查：是自家实例就静默跳过（日志「不再重复启动」）；是其它程序则警告且不启动。`go-rotate web` 与 opencode 插件进程同时跑也只会有一个 Web。

**Q：端口被别的程序占了怎么办？**
默认端口 `8899`，可通过环境变量 **`GOROTATE_WEB_PORT`** 覆盖（`Number(...) || 8899`，非法值回退 8899；生产不设行为不变）——供测试/隔离实例用临时端口验证。需长期改端口仍建议改 `go-rotate.ts` 顶部常量并同步 README / 插件日志提示 / `startWeb` 健康检查三处（见项目 AGENTS.md「边界/易踩的坑」）。可以先用 `lsof -i :8899` 确认占用方。

**Q：能在 Web 上设置每 key 独立冷却窗口吗？**
可以。key 行内「窗口」按钮 → `prompt` 输入分钟（留空=清除回退全局）→ `POST /api/cooldown/window {name, minutes}`；也可用 CLI `go-rotate cooldown <name> window <min|clear>`。

**Q：Web 上能改 key 值 / 改名吗？**
可以。key 行内「编辑」按钮：两个 `prompt` 依次输入新名称（可空=不改）与新 key 值（可空=不改）→ `POST /api/keys/update {name, patch}`；都留空则提示不调 API。编辑当前 key 名称时 `current` 自动跟随。也可以直接用 CLI 或改 `go-keys.json`。

**Q：Web 与 CLI 会不会打架？**
不会。同一把跨进程文件锁 + 原子写，60 个并行写命令实测 JSON 无损、无锁残留（AGENTS.md 记录）。

## 7. 增强前基线（Team A 改动前的现状，供增强后对比）

> 冒烟时间 2026-08-16，代码 `go-rotate.ts`（git HEAD `0d4845e`），Web 正在 8899 运行（真实配置，仅含 key `test`）。

### 7.1 冒烟清单（真实执行，全部只读 GET）

| # | 命令 | 结果 | 响应摘要 |
|---|---|---|---|
| 1 | `curl -s http://127.0.0.1:8899/` | **PASS** 200 | HTML 含 `<title>go-rotate · opencode-go keys</title>`，深色主题单页 |
| 2 | `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8899/index.html` | **PASS** 200 | 与 `/` 同一页面 |
| 3 | `curl -s http://127.0.0.1:8899/api/status` | **PASS** 200 | `{"provider_id":"opencode-go","cooldown_minutes":300,"current":"test","auto_web":true,"keyCount":1,"availableCount":1,"keys":[{...,"state":"available","remainMin":0,...,"isCurrent":true}]}` |
| 4 | `curl -s http://127.0.0.1:8899/api/log` | **PASS** 200 | 纯文本 299 行（`/tmp/opencode-go-rotate.log` 尾部 300 行），含轮换/冷却历史 |
| 5 | `curl -s http://127.0.0.1:8899/api/nonexistent` | **PASS** 404 | `{"error":"not found"}` |
| 6 | `curl -s -X POST http://127.0.0.1:8899/api/nonexistent` | **PASS** 404 | 同上 |
| 7 | `GET /api/keys/check` | **未执行** | 会真实探测 key（网络）+ 写 `last_status`，基线冒烟**跳过**（只读约束） |
| 8 | `go-rotate status` | **PASS** | `current key: test`、`cooldown: 300 min`、`test ... available`（CLI 只读视角） |

**隔离铁证**：冒烟前后真实配置 md5 一致——
`~/.config/opencode/go-keys.json` = `70aa1342709e6cfc4141dbfd5c374260`；`~/.local/share/opencode/auth.json` = `863176e6ea5f13a1f7b081828ef92b14`（只读 GET 未触发任何写路径）。
隔离实例验证（临时端口）**不可行**：`WEB_PORT` 是代码常量且 8899 已被真实实例占用，`startWeb` 不支持自定义端口；未改代码（只读约束），故以真实实例只读冒烟为准。

### 7.2 页面布局清单（增强前）

```
h1  go-rotate · opencode-go keys
sub 多 key 自动轮换 · 修改会自动同步到 auth.json 并立即生效
[卡片1 状态卡] 当前 key / 可用 x/y(total y) / 冷却窗口(min) / Web 自动启动
              + [关闭 Web(danger,confirm)] [开启自动启动]
[卡片2 key 管理] 新增行(name+key+按钮) → 手动操作行(轮换/检测所有 key)
              表: 名称 | Key(masked) | 状态徽章 | 健康(hover) | 操作(启用/冷却/清除冷却/删除)
[卡片3 日志] 运行日志 + 清空日志(danger,confirm) + pre#logview
JS: refresh() 5s 轮询 /api/status；refreshLog() 8s 轮询 /api/log
```

页面元素 id：`s-current` `s-avail` `s-total` `s-cooldown` `s-autoweb` `web-off-btn` `web-on-btn` `new-name` `new-key` `check-hint` `tbody` `msg` `clear-log-btn` `logview`。

### 7.3 API 清单（增强前）

见 §3 速查表：**10 个 POST 写端点**（add/update/delete/current/cooldown/rotate/web off/web on/log clear）+ 4 个 GET 读端点（`/`、`/api/status`、`/api/log`、`/api/keys/check`）。未知路由 404，POST 抛错 400。

### 7.4 已知限制（从代码确认，增强后应可对比）

1. **无每 key 冷却窗口 UI**：cooldown 按钮只传全局 `st.cooldown_minutes`（清除=0 / 冷却=全局分钟）；`key.cooldown_minutes` 在 `statusPayload` 有返回（`cooldown_minutes: k.cooldown_minutes ?? null`）但页面不展示、不设置——只能 CLI 设。
2. **无 key 编辑（update）UI**：`/api/keys/update` 后端存在（`handleWeb` 526 行），但 `WEB_HTML` 无任何调用入口（表内仅 启用/冷却/清除冷却/删除）。
3. **删除无确认弹窗**：`data-del` 按钮直接 `doOp(delete)`，无 `confirm()`（全页只有「关闭 Web」与「清空日志」有 confirm）。
4. **无统计 / 用量趋势**：页面无 usage/stats 卡片或图表（`stats` 仅是状态卡 CSS 类名）；用量分析只在 zen-gateway（`/api/usage`、`usage.jsonl`、`usage-report.mjs`）。
5. **无鉴权**：仅绑定 127.0.0.1，无 token 机制（见 §4）。
6. **端口硬编码 8899**：`WEB_PORT` 常量，无 env 覆盖；隔离实例无法用临时端口验证。
7. **`/api/keys/check` 非纯只读**：真实网络探测（~1 token/key）+ `mutateConfig` 写 `last_status`；且路由无方法判断，GET/POST 均可触发。
8. **`/api/web/on` 不立即重启**：只写 `auto_web=true`，需 opencode 下次启动或 `go-rotate web` 手动起。
9. **无 provider_id 编辑 UI**：`provider_id` 仅配置内可改。
10. **无每 key 独立「编辑冷却剩余时长」**：`/api/cooldown` 只能设整数分钟，无相对时间（如「+30min」）或精确到秒的 UI。

## 8. Web 增强（2026-08-16 本会话交付）

> 代码 `go-rotate.ts`（git HEAD 之上，未提交），仅改 `go-rotate.ts` + 文档。**未改** `zen-gateway/gateway.mjs` / `go-rotate`（Python CLI）/ `install.sh`。

### 8.1 新增能力（对照 §7.4 基线限制）

| # | 基线限制 | 本会话解决 |
|---|---|---|
| 1 | 无每 key 冷却窗口 UI | ✅ key 行内「窗口」按钮（prompt 输入分钟，留空=清除回退全局）+「清窗」按钮（删除 `cooldown_minutes`）→ `POST /api/cooldown/window {name, minutes\|null}` |
| 3 | 删除无确认弹窗 | ✅ `data-del` 按钮先 `confirm('确定删除 key "name"？此操作不可恢复。')` |
| 4 | 无统计 / 用量趋势 | ✅ 新增**轮换统计卡片**（`GET /api/stats`，解析日志：总轮换数 + 每 key 被切到/进冷却/最近切换）+ **zen-gateway 状态卡片**（`GET /api/gateway`，跨进程展示 18888 healthz/usage，失败灰卡降级） |
| — | 全局冷却窗口只能 CLI 改 | ✅ 状态卡「冷却窗口(min) 编辑」→ prompt 输入 → `POST /api/settings {cooldown_minutes:N}`（非法 400） |
| — | 日志固定 8s 轮询 | ✅ 「自动刷新」开关（默认关，开则 3s 轮询）+「过滤关键字」输入框（前端过滤已拉取日志，不重新请求） |
| — | — | ✅ 轮询策略：`refresh()` 5s status；`refreshStats()` 10s；`refreshGateway()` 15s（gateway 带 2s 超时，独立异步不阻塞 status 轮询） |

本会话解决：**#2 key 编辑 UI、#6 端口 env 覆盖（`GOROTATE_WEB_PORT`）、#8 `/api/web/on` 立即重启** —— 见 §9「收尾三件套」。未解决（有意保留，非本任务范围）：#5 鉴权、#7 check 非纯只读、#9 provider_id 编辑、#10 相对时间。

### 8.2 新增 API（向后兼容，既有 API 未动）

| 方法/路径 | 参数(JSON) | 说明 |
|---|---|---|
| POST `/api/cooldown/window` | `{name, minutes}`（minutes 为 null 或空串=清除） | 设置/清除该 key 独立窗口（`k.cooldown_minutes`）；非法分钟/不存在 key → 400 |
| POST `/api/settings` | `{cooldown_minutes:N}` | 改全局窗口（`cfg.cooldown_minutes`，正整数校验，非法 400） |
| GET `/api/stats` | - | `{totalRotations, byKey:{name:{rotations,coolings,lastRotate}}}`，解析 `/tmp/opencode-go-rotate.log`（对齐 CLI `go-rotate stats` 正则：`轮换到 key "x"` / `key "x" 配额耗尽` + 行首 ISO 时间戳）；日志不存在 → `{totalRotations:0,byKey:{}}` |
| GET `/api/gateway` | - | `Promise.allSettled` fetch `http://127.0.0.1:18888/healthz` + `/api/usage`（`AbortSignal.timeout(2000)`）→ `{running:bool, healthz?, usage?, error?}`；失败 `running:false`（前端灰卡降级） |

### 8.3 验证矩阵（真实执行，隔离配置 `GOROTATE_CONFIG_FILE/GOROTATE_AUTH_FILE` → `/tmp/gr-web-test/`）

**A. 静态检查**

| # | 检查 | 结果 |
|---|---|---|
| 1 | `bun build go-rotate.ts` | **PASS**（49.95 KB，exit 0） |
| 2 | `bun -e 'import(...)'` 加载 + `GoRotate()` | **PASS**（exports 齐全，hooks 返回 chat.headers/event，未 bind 真实 8899——端口被真实实例占用静默跳过） |
| 3 | 内嵌 JS 语法（提取 `<script>` → `node --check`） | **PASS**（修复 1 处模板转义：`WEB_HTML` 模板字符串里 `"\n"` 被转成真实换行 → 改 `"\\n"`） |
| 4 | 现有插件单测 `tests/go-rotate-plugin.test.ts` | **PASS** 65/65（163 expect） |

**B. API 级验证（假 Request 喂 `handleWeb`，隔离配置，40 项全 PASS）**

| 路由 | 期望 | 实际 |
|---|---|---|
| `GET /` | 200 + HTML 含 `gateway-card`/`stats-tbody`/`st-total`/`gw-badge`/`log-auto`/`log-filter`/`data-window` + 删除 confirm | ✅ 全含 |
| `GET /api/status` | 结构不变，keys 2 项，act2 `cooldown_minutes=60` | ✅ |
| `parseStatsLog` 造文本 | 总轮换=3（b×2+c×1）、a 冷却 2、b lastRotate=时间戳、空日志=0/{} | ✅ 全对 |
| `GET /api/stats` | 200 + `{totalRotations,byKey}` | ✅（真实日志 total=50） |
| `POST /api/cooldown/window {act2,90}` | 200 + 配置 `cooldown_minutes=90` | ✅ |
| `POST /api/cooldown/window {act2,null}` | 200 + 字段删除（undefined） | ✅ |
| `POST /api/cooldown/window {act2,"abc"}` / 不存在 key | 400 | ✅ |
| `POST /api/settings {120}` | 200 + 全局=120 | ✅ |
| `POST /api/settings {-5}` / `{0}` | 400 | ✅ |
| `GET /api/gateway` | 200 + `running:true`（18888 在跑）+ healthz.current + usage.totalRequests，耗时 25ms | ✅ |
| `gatewayStatus` 不可达端口（`GOROTATE_GATEWAY_BASE=http://127.0.0.1:59999`） | `running:false` + error，34ms | ✅ 降级 |
| `/api/current` / `/api/cooldown` 回归 | 200 | ✅ |
| 未知路由 | 404 | ✅ |

**C. 真实 HTTP 端到端（临时端口 18999 + `Bun.serve({fetch:handleWeb})` + curl，隔离配置）**

| 路由 | 结果 |
|---|---|
| `GET /` 含 6 个新元素 id | ✅ |
| `GET /api/status` global=120 / act2.window=None | ✅ |
| `POST /api/cooldown/window` 设 90 → status 显示 90 → 清 null → None | ✅ |
| `POST /api/settings {120}` → global=120；`{-1}` → **400** | ✅ |
| `GET /api/stats` `{totalRotations:62, byKey:{actB:{rotations:1,coolings:1,...}}}`（真实日志） | ✅ |
| `GET /api/gateway` `running:True, current:test, totalRequests:1`（真实 18888） | ✅ |
| 未知路由 404 | ✅ |

**D. 隔离铁证**

- 真实 `~/.config/opencode/go-keys.json` md5：**前后一致 `70aa1342709e6cfc4141dbfd5c374260`**（所有写操作走 `GOROTATE_CONFIG_FILE`）。
- 真实 `~/.local/share/opencode/auth.json`：**内容语义零变化**（唯一真实 key `sk-***` 与 JSON 结构始终一致）；md5 在测试期间被**并行进程**（zen-gateway launchd KeepAlive 反复重启 / opencode 活动）重写而漂移。**隔离有效性已实验证明**：隔离 env 下调用会触发 `syncAuth` 的 `/api/current`，临时 auth.json 被写入 act2 key，真实 auth.json md5 前后不变（`e4e9a727…`→`e4e9a727…`）。
- 临时文件（`/tmp/gr-web-test/`、`/tmp/gr-web-test2/`、build 产物）测后已清理；**未触碰真实 8899**（全程未 bind，`startWeb` 因端口被真实实例占用自动跳过）。

### 8.4 测试环境变量（新增）

- `GOROTATE_GATEWAY_BASE`：覆盖 gateway 探测地址（默认 `http://127.0.0.1:18888`），**仅供测试**（指向不可达端口验证降级）；生产不设行为不变。
- 既有 `GOROTATE_CONFIG_FILE` / `GOROTATE_AUTH_FILE`（插件测试隔离）继续有效。

## 9. 收尾三件套（2026-08-16 本会话交付）

> 对照 §7.4 基线限制：**⑥ 端口硬编码 → `GOROTATE_WEB_PORT` env 覆盖；⑧ `/api/web/on` 不立即重启 → 立即拉起 + `restarted`；② 无 key 编辑 UI → 行内「编辑」按钮**。仅改 `go-rotate.ts` + `tests/go-rotate-plugin.test.ts` + 本文档；未碰 `zen-gateway/gateway.mjs` / `go-rotate` / `install.sh`。

### 9.1 改动清单（go-rotate.ts）

| 改动 | 位置 | 说明 |
|---|---|---|
| `WEB_PORT = Number(process.env.GOROTATE_WEB_PORT) \|\| 8899` | 顶部常量 | 测试/隔离实例覆盖端口；非法值回退 8899；生产不设行为不变；`WEB_BASE` 同步跟随 |
| `/api/web/on` 立即重启 | `handleWeb` 路由 | `setAutoWeb(true)` + `!webStarted` 时 `await startWeb()`；返回 `{ok, auto_web:true, restarted}`（`restarted = 本次真的拉起`）；端口被其它实例占用时 `startWeb` 内部健康检查不重复启动 |
| key 行内「编辑」按钮 | `WEB_HTML` 表格 | `data-edit` 按钮 → `editKey(name)`：两个 `prompt`（新名称/新 key 值，可空=不改）→ 双空提示不调 API → `POST /api/keys/update {name, patch}` |
| `webOn()` 展示 restarted | `WEB_HTML` JS | `r.restarted ? "Web 已重新启动（立即生效）" : "已开启 Web 自动启动"` |
| 导出 `WEB_HTML` | 测试导出块 | 供单测断言 UI 内容（仅命名导出，不改变行为） |

### 9.2 验证矩阵（真实执行）

**A. 静态检查**

| # | 检查 | 结果 |
|---|---|---|
| 1 | `bun build go-rotate.ts` | **PASS**（exit 0） |
| 2 | 内嵌 JS 语法（提取 `<script>` → `node --check`） | **PASS**（12120 bytes，exit 0） |
| 3 | 插件单测 `bun test tests/go-rotate-plugin.test.ts` | **PASS** **65 → 66 用例**（新增 1 条「WEB_HTML 含 key 编辑 UI」，172 expect） |

**B. 隔离实例 E2E（`GOROTATE_CONFIG_FILE/GOROTATE_AUTH_FILE` → `/tmp/gr-e2e/`，2 假 key，`GOROTATE_WEB_PORT=18998`，`GOROTATE_GATEWAY_BASE=59999` 降级）**

| # | 步骤 | 结果（真实输出） |
|---|---|---|
| 1 | 导入插件 + `GoRotate()`（config `auto_web:false` → 不绑定） | ✅ 无绑定 |
| 2 | 进程内 `handleWeb` `POST /api/web/on` | ✅ `200 {"ok":true,"auto_web":true,"restarted":true}` |
| 3 | 再次 `POST /api/web/on`（已在运行） | ✅ `200 {"ok":true,"auto_web":true,"restarted":false}` |
| 4 | 进程内 fetch `http://127.0.0.1:18998/api/status` | ✅ `keyCount=2 current=a auto_web=true`（**证明端口 env 覆盖生效**：若未生效会尝试 8899 被真实实例占用而失败） |
| 5 | curl `GET /` | ✅ 含 `data-edit="`、`function editKey`、`api("/api/keys/update", { name, patch })`、`未修改：名称与 key 值均为空` |
| 6 | curl `POST /api/keys/update` 改名 a→a2 + 改 key | ✅ `{"ok":true,...}` → status `current=a2`、keys `[('a2','sk-aaa2…aaa2',True),('b','sk-bbb…-bbb',False)]`（**当前 key 改名跟随**） |
| 7 | curl `POST /api/keys/update` 仅改 key（a2→sk-aaa3） | ✅ masked `sk-aaa3…aaa3` |
| 8 | curl `POST /api/keys/update` 改名 b→b2（非当前） | ✅ keys `[('a2',...),('b2',...)]`、current 仍 a2 |
| 9 | curl `POST /api/keys/update` 不存在 key | ✅ **400** |
| 10 | 进程内 `POST /api/web/off` → 等 600ms → `POST /api/web/on`（**先停后开**） | ✅ `OFF 200 {"ok":true,"shutting_down":true,"auto_web":false}` → `ON2 200 {"ok":true,"auto_web":true,"restarted":true}` |
| 11 | 重启后进程内 fetch `/api/status` | ✅ `REBOUND status keyCount=2 current=a2 auto_web=true`（server 重新绑定） |

**C. 隔离铁证**

- 真实 `~/.config/opencode/go-keys.json` md5：**`ae596e0e0a880bdb0f8c4c8ad1f2393e`（前后一致）**。
- 真实 `~/.local/share/opencode/auth.json` md5：**`e4e9a727d22bc1535129f1b62fc9237c`（前后一致）**。
- 真实 8899 未碰（`lsof -i :8899` → opencode 20126 LISTEN，未杀未动）；临时文件 `/tmp/gr-e2e/` 测后已清理；e2e 进程无残留。

### 9.3 设计取舍与遗留

- **`/api/web/on` 的 `restarted` 语义**：以进程内 `webStarted` 为准（server 已跑 → `false` 仅写配置；未跑 → `startWeb()` 拉起 → `true`）。端口被其它实例占用的边界复用 `startWeb` 既有健康检查（记录日志不重复起）。
- **HTTP 路径下「先停后开」的真实可达性**：`/api/web/off` 会停掉页面所在 server，客户端无法再 POST `/api/web/on`（300ms 窗口竞态不可靠）；故 `restarted:true` 的完整路径（停→开）在隔离实例内以进程内 `handleWeb` 验证（E2E #10/#11），真实场景中「页面关闭后再开」走 `go-rotate web` / opencode 重启。
- **UI 编辑采用双 `prompt`**（非行内表单）：与既有「窗口/清窗」交互风格一致，零新 DOM/样式；编辑当前 key 名称时 `current` 跟随由后端 `updateKey` 已有逻辑保证（E2E #6 验证）。
- **单测新增 1 条**（65→66）：仅断言 `WEB_HTML` 内容（纯读、不 bind 端口、不触发网络），保持「不实际 bind 8899」铁律；`GOROTATE_WEB_PORT` 生效性由 E2E #4 真实验证。
- 遗留（非阻塞）：`GOROTATE_WEB_PORT` 与 AGENTS.md「改端口记得同步 README 和 web 提示」约定——README 默认端口 8899 不变无需改；页面 JS 无内嵌端口提示（端口由启动端决定）。