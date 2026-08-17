# AGENTS.md — go-rotate

> 本文件供后续维护 / 开发时快速恢复上下文。改动代码前请先读它，完成后同步更新。

## 项目是什么

opencode 的 **opencode-go 多 key 自动轮换**插件 + CLI + Web 管理界面。
当一个 opencode-go 订阅账号配额用尽（/ 401 / 402 / 429）时，自动热切换到下一个可用 key，**无需重启 opencode、不中断当前会话**。

- 仓库：`https://github.com/jiyi1990118/opencode-go-rotate`
- 开发目录：`/Users/jary/serverTools/go-rotate/`
- 本地安装位置：插件 `~/.config/opencode/plugins/go-rotate.ts`，CLI `~/.local/bin/go-rotate`

## 核心原理（务必理解，别改坏）

opencode 每次调用 LLM 前都会触发插件钩子，我们的方案绕开了"SDK 启动时烘焙 key"的缓存：

1. **`chat.headers` 钩子（热切换关键）**：像 tui-control 一样，这是 opencode 源码 `session/llm/request.ts` 里 `prepare()` 的 per-request 钩子。插件返回的 headers 是**最后 spread** 的：
   ```ts
   headers: { ...opencodeHeaders, ...input.model.headers, ...headers }  // 插件 headers 最后 → 可覆盖 Authorization
   ```
   所以每次请求注入 `Authorization: Bearer <当前key>` 就能覆盖 SDK 自带的 key，**进程不用重启**。
   — 已用本地 echo server + 真实请求双重验证过覆盖生效。

2. **`event` 钩子（检测）**：监听 `session.error`，其中的 `error` 是 `APIError{statusCode,message,metadata.url}` 或 `ProviderAuthError{providerID}`。据此判断是否 opencode-go 端点 + 是否配额类错误再触发轮换。

3. **为什么不能靠改 auth.json 热切换**：provider 的 `provider.key` 在启动时被烘焙进 SDK 实例（`provider.ts:1720` 缓存）。所以核心机制是 `chat.headers`，写 auth.json 只是**持久化同步**（保证非插件路径 / 重启后一致）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `go-rotate.ts` | 插件本体（Node 内置模块，零外部依赖；运行在 bun 环境，可用 `Bun.serve`） |
| `go-rotate` | CLI（纯 Python 单文件，继承 `go-keys.json`） |
| `install.sh` | 一键安装（本地复制 + `curl\|bash` 从 `BASE_URL` 拉取两种路径） |
| `README.md` | 文档 |
| `.gitignore` | 忽略 OS/编辑器/缓存 |

## 运行时文件（用户机器上）

| 路径 | 说明 |
|---|---|
| `~/.config/opencode/go-keys.json` | **唯一配置**（插件/CLI/Web 共用） |
| `~/.local/share/opencode/auth.json` | opencode 凭据，`opencode-go.key` 被我们同步（**卸载时不动它**） |
| `/tmp/opencode-go-rotate.log` | 运行日志 |
| `go-keys.json.lock` | 跨进程写锁（`/tmp/...` 旁的锁文件） |

## 配置 Schema（go-keys.json）

```jsonc
{
  "provider_id": "opencode-go",   // 命中的 providerID 前缀匹配（includes "opencode"）
  "cooldown_minutes": 300,        // 默认冷却窗口（分钟）
  "current": "act1",              // 当前 key 的 name
  "keys": [
    { "name": "act1", "key": "sk-...", "cooldown_until": null, "cooldown_minutes": 30 }  // cooldown_minutes 可选：该 key 独立冷却窗口，缺省回退全局
  ]
}
```

## 关键常量（go-rotate.ts 顶部）

- `WEB_PORT = 8899` —— 避开 tui-control 的 7792-7811 区间（当时 7792-7795 全被占）。**改端口记得同步 README 和 web 提示。**
- `DEFAULT_COOLDOWN_MIN = 300`
- `LOCK_FILE = go-keys.json.lock`，`LOCK_TIMEOUT_MS = 5000`，`LOCK_STALE_MS = 15000`
- `provider_id` 匹配用 `pid.includes("opencode")`（覆盖 `opencode` 免费层和 `opencode-go`）

## 架构与数据流

### 请求注入（每次请求）
```
LLM 请求 → chat.headers 钩子(providerID=sid map + 注入 Authorization) → opencode 发请求
```

### 自动轮换（配额耗尽）
```
session.error 事件
  → isGoError(err)？   // URL 匹配 opencode.ai/zen|go 或 ProviderAuthError.providerID 含 opencode
  → isQuotaError(err)？// statusCode 401/402/429 或 msg 匹配 quota|insufficient|balance|rate limit|exceeded
  → 双保险：sessionProvider[sessionID] 是否为 go
  → rotate()：
      当前 key 进冷却（优先解析错误里 "reset at <time>" 含时区偏移，否则用该 key 独立窗口 `cooldown_minutes`，再回退全局）
      → pickNext() 选下一个未冷却 key（循环轮换）
      → 更新 go-keys.json + 同步 auth.json
```

### 并发安全
- 所有配置写入走 `withLockSync()`：`openSync(lock,'wx')` 跨进程互斥 + 陈旧锁检测 + 超时（5s）降级。
- `atomicWrite()`：写 `.tmp` 再 `rename`，防中断损坏。
- 单进程内多 TUI：每个 TUI 进程各自加载插件，但都读同一份磁盘配置，保持一致。

### Web 只启一个
- 固定端口 8899 + 健康检查：第二个实例 bind 失败 → fetch `/api/status` 确认是自家 web → 跳过（日志"不再重复启动"）。

## Web API 端点

| 方法/路径 | 参数(JSON) | 说明 |
|---|---|---|
| GET `/` | - | 管理页面（自包含 HTML，无外部依赖） |
| GET `/api/status` | - | 当前配置 + 各 key 状态/冷却剩余 |
| GET `/api/log` | - | 日志尾部文本 |
| POST `/api/keys/add` | `{name,key}` | 新增 |
| POST `/api/keys/update` | `{name,patch:{key?,name?}}` | 编辑 |
| POST `/api/keys/delete` | `{name}` | 删除 |
| POST `/api/current` | `{name}` | 设为当前 |
| POST `/api/cooldown` | `{name,minutes}` | minutes=null 清除冷却 |
| POST `/api/rotate` | `{}` | 手动轮换 |

> **Web 增强前基线（2026-08-16，Team 冒烟，只读未改生产）**：详见 `docs/Web界面使用.md`（§7 增强前基线）。要点：真实 8899 只读冒烟全 PASS（`/`、`/index.html`、`/api/status`、`/api/log`、404 路由；`/api/keys/check` 未执行——真实网络探测+写 last_status）；冒烟前后真实 go-keys.json/auth.json md5 一致（70aa1342… / 863176e6…）。基线限制（增强后对比用）：① 无每 key 冷却窗口 UI（按钮只传全局 minutes，CLI `cooldown <name> window` 才有）；② `/api/keys/update` 后端有但页面无编辑入口；③ 删除 key 无 confirm 弹窗；④ 无统计/用量图表；⑤ 无鉴权（仅 127.0.0.1）；⑥ `WEB_PORT=8899` 硬编码无 env 覆盖（隔离实例无法临时端口验证）；⑦ `/api/keys/check` 非纯只读（探测+写 last_status，GET/POST 均可触发）；⑧ `/api/web/on` 只开 auto_web 不立即重启。

> **✅ Web 管理界面全量增强已交付（2026-08-16，dev team）**：详见 `docs/Web界面使用.md`（§8）。仅改 `go-rotate.ts`（开发目录）+ README + docs，未碰 gateway.mjs / CLI / install.sh。
> **新增 4 后端**：`setCooldownWindow(name, minutes|null)`（写 `k.cooldown_minutes`，非正整数 400）/ `setGlobalCooldown(minutes)`（写 `cfg.cooldown_minutes`，非正整数 400）/ `parseStatsLog(text)`（纯函数，对齐 CLI stats 正则 `轮换到 key "x"` + `key "x" 配额耗尽` + 行首 ISO 时间戳，日志不存在→`{totalRotations:0,byKey:{}}`）/ `gatewayStatus()`（`Promise.allSettled` fetch 18888 healthz+usage，`AbortSignal.timeout(2000)`，失败 `running:false`）。
> **新增 4 路由**（向后兼容，旧 API 未动）：`POST /api/cooldown/window {name,minutes|null}` / `POST /api/settings {cooldown_minutes}` / `GET /api/stats` / `GET /api/gateway`。
> **前端 7 项**：key 行「窗口/清窗」按钮（prompt 输入，留空清除）、状态卡「冷却窗口 编辑」（prompt→settings）、轮换统计卡片（stats-tbody/st-total）、zen-gateway 状态卡片（gateway-card/gw-badge，未运行灰卡降级 `opacity:0.55`）、删除 key confirm、日志「自动刷新」开关（默认关，开则 3s）+「过滤关键字」（前端过滤已拉取文本 `split("\\n")`——**注意 WEB_HTML 是模板字符串，JS 里换行转义必须写 `\\n`**）、轮询 `refresh 5s / refreshStats 10s / refreshGateway 15s`（gateway 独立异步不阻塞 status）。
> **新增测试 env**：`GOROTATE_GATEWAY_BASE`（覆盖 18888，仅供测试降级；生产不设行为不变）。
> **验证**：bun build PASS；插件单测 65/65 PASS；API 级矩阵 40/40 PASS（假 Request 喂 handleWeb + 隔离配置）；真实 HTTP E2E（临时端口 18999 + Bun.serve + curl）8 项全 PASS（含 `/api/settings {-1}`→400）；gateway 降级（`GOROTATE_GATEWAY_BASE=http://127.0.0.1:59999` → running:false + error，34ms）PASS；内嵌 JS 语法 `node --check` PASS（修复 1 处模板转义 `"\n"`→`"\\n"`）。
> **🚨 事故与处置（2026-08-16 16:33）**：真实 `~/.config/opencode/go-keys.json` 曾被写入一个 `name` 为 openai Client 对象的脏 key（无 key 字段，含 `serverUrl:http://localhost:4096/`=opencode 上下文），**与本次测试无关**（隔离实验铁证：隔离 env 下调用全部写路径，真实 go-keys.json md5 前后不变；且隔离测试期间 16:0x-16:2x md5 始终 70aa1342 一致，污染出现在 16:33 前后）。最大嫌疑：**并行 Team B 的 zen-gateway 安装副本**（`~/.local/share/zen-gateway/gateway.mjs` mtime 16:04:52 已更新含 usage 代码，与仓库 8963936e 不同 a31a02d8；gateway.mjs CONFIG_FILE 用 os.homedir()=真实路径）或 opencode 环境活动。**已修复**：python 过滤 name/key 非字符串 key 恢复唯一 `test`，**md5 恢复基线 `70aa1342709e6cfc4141dbfd5c374260`**（逐字节一致，auth.json 内容语义不变）。**待主线程关注**：① 并行 Team B 若在 gateway.mjs 写配置需复查；② go-rotate.ts 安装副本（`~/.config/opencode/plugins/go-rotate.ts`）未同步本次 Web 增强（`baadde3d` vs 开发 `ea69619c`），集成时需 install/拷贝。
> **✅ 主线程集成复验（2026-08-16）**：真实 go-keys.json 仅含 `test`（md5 70aa1342 与基线一致）、auth.json key=真实 key（md5 漂移由 zen-gateway 重启原子写所致，内容语义不变）；bun build ✅ + 插件单测 65/65 + CLI 单测 52/52 + gateway 单测 **144/144**（Team B 新增 `/api/usage/trend` 聚合 16 用例：`aggregateUsage`/`readUsageFile`/`utcDateKey`/`windowDays` 纯函数，`?days=N`/`?key=` 筛选，文件不存在→空结构 200）+ 隔离 md5 铁证；安装副本已同步（go-rotate.ts `ea69619c`、gateway.mjs `8963936e` 与开发一致）并 restart；真实 18888 `/api/usage/trend`（total 21 / byKey act1+test / 7 天窗口）+ chat 回归 OK；Web 增强隔离实例 18999 全验证 PASS（`/` 含新卡片、stats、gateway、cooldown/window、settings）；**真实 8899 的 Web 增强待 opencode 重启生效**（当前 8899 由 opencode 进程 20126 加载旧插件，未强杀用户会话）。
> **✅ Web 收尾三件套已交付（2026-08-16，dev team）**：详见 `docs/Web界面使用.md`（§9）。解决基线 ⑥⑧②：① `WEB_PORT = Number(process.env.GOROTATE_WEB_PORT) || 8899`（非法值回退、生产不设行为不变；`WEB_BASE` 同步）；② `/api/web/on` 改为 `setAutoWeb(true)` + `!webStarted` 时 `await startWeb()` 立即拉起，返回 `{ok, auto_web:true, restarted}`（端口被占复用 startWeb 健康检查不重复起）；③ key 行内「编辑」按钮（`editKey`：双 prompt 名称/key 可空=不改 → 双空不调 API → `POST /api/keys/update {name, patch}`；当前 key 改名 current 跟随由后端 updateKey 已有逻辑）；`webOn()` 展示 restarted。导出 `WEB_HTML`（仅命名导出）供单测断言。**验证**：bun build exit 0 + 内嵌 JS `node --check` PASS + 插件单测 **65→66 PASS**（新增 WEB_HTML 编辑 UI 断言）+ 隔离实例 E2E（`GOROTATE_WEB_PORT=18998` + 临时配置 2 假 key）全 PASS：ON1 `restarted:true`（未运行拉起）/ ON1b `restarted:false`（已运行）/ 进程内 fetch 18998 成功（**证明端口 env 覆盖生效**）/ curl `GET /` 含 data-edit+editKey+/api/keys/update / keys/update 改名+改 key+当前 key 跟随+不存在 400 / 先停后开（OFF→600ms→ON2 `restarted:true`）→ REBOUND status keyCount=2 / **md5 铁证：真实 go-keys.json `ae596e0e…` + auth.json `e4e9a727…` 前后逐字节一致**；真实 8899 未碰（opencode 20126 未动）；`/tmp/gr-e2e/` 已清理。**设计取舍**：HTTP 路径下先停后开不可达（web/off 停掉页面所在 server），`restarted:true` 完整路径在隔离实例进程内 handleWeb 验证；编辑 UI 用双 prompt 与既有交互一致。遗留（非阻塞）：README 默认端口 8899 不变无需改；安装副本 `~/.config/opencode/plugins/go-rotate.ts` 未同步本次改动，集成时需 install/拷贝。
> **✅ ZEN_AUTH_FILE 测试隔离交付（2026-08-16，dev team）**：gateway.mjs `AUTH_FILE` 支持 `process.env.ZEN_AUTH_FILE` 覆盖（生产不设行为不变，与 ZEN_CONFIG 对称独立；启动日志追加 `auth=<path>` 可观测）；导出区追加 `rotate`/`syncAuth`/`AUTH_FILE`。**关键技法**：ESM 模块缓存按完整标识符区分，测试用 `import("../gateway.mjs?zauth-isolation=1")` 查询串强制重跑模块顶层。单测 **144→150**（新增「ZEN_AUTH_FILE 隔离」6 用例：env 指向/写临时不写真实/损坏容错/rotate 全链路）。**集成铁证**：临时 ZEN_CONFIG+ZEN_AUTH_FILE 下假 key 401 轮换 → 临时 auth 更新、**真实 auth.json md5 前后一致 `e4e9a727…`**；不设 env 回归确认默认路径不变。
> **✅ 主线程集成复验（第二轮，2026-08-16）**：插件单测 **66/66** + CLI **52/52** + gateway **150/150** 全 PASS；安装副本已同步（go-rotate.ts/gateway.mjs md5 与开发一致）并 restart；Web 增强隔离实例 18997 全验证 PASS（新卡片/stats/gateway/每key窗口/全局窗口/编辑改名 current 跟随/web on restarted）；新增 `docs/Web增强后回归.md`（基线十条逐项对比：①③④⑥⑧⑩ 已解决，②⑦🟡，⑤⑨ 未解决）+ README 链接。**🚨 真实配置二次污染（2026-08-16）**：真实 go-keys.json 再次混入 `name` 为 opencode `Client` 对象的脏 key（含 `serverUrl:http://localhost:4096/`、`worktree`=本项目目录），md5 `70aa1342`→`ae596e0e`。**与测试 teams 无关**（均有隔离 md5 铁证；写入口非插件路径——插件 addKey/loadConfig 均做字符串类型过滤，脏 key 绕过插件直接写文件，疑似 opencode 环境把上下文对象序列化进配置）。**已清理**：过滤 name/key 非字符串条目恢复唯一 `test`，md5 回基线 `70aa1342…`。**防御说明**：`loadConfig` 已过滤非字符串 name/key（脏 key 不参与轮换/注入，无实际危害），但写入方为环境层无法在插件内防；若再现按同法清理。
> **✅ go-rotate × zen-gateway 渐进整合交付（2026-08-16，分析 subagent + 3 dev team 并行 + 主线程集成）**：目标——用户要求「opencode-go 订阅套餐做成网关」（即 zen-gateway 现有能力）+ 与 go-rotate 统一 CLI/Web/安装「一个命令管理」。分析报告 `docs/整合设计方案-渐进整合.md`（300 行 9 章，契约/文件归属/隔离红线）。**Team A（gateway.mjs +60 行）**：新增只读端点 `GET /api/gateway/status`（running/version/port/defaultModel/models/dynamic/aliases/usageFile/configFile/authEnabled/uptimeSec）、`GET /api/gateway/log?lines=N`（内存环形日志 `_logRing` 200 条 + `_logTotal` 累计）、`GET /api/gateway/models`（models 26 + aliases 16）、`GET /api/gateway/config`（keys 仅 name+cooldown_until，**零 key 明文泄漏**，测试含 JSON 序列化无 `sk-` 断言）；`log()` 改同时维护环形缓冲 + 导出 `getLogRing`；纯函数 `gatewayStatusSummary/gatewayModelsSummary/gatewayConfigSummary/readRawConfig` 供单测。测试 **150→170**。**Team B（go-rotate.ts +150 行）**：`GATEWAY_CTL`/`GOROTATE_GATEWAY_CTL` env（测试 stub）、`gatewayCtlExists/runGatewayCtl/gatewayManage`（withLockSync 包裹）/`gatewayLog`（优先新端点回退脚本）、handleWeb 加 `GET /api/gateway/log` + `POST /api/gateway/{start,stop,restart}`（execFileSync 调 zen-gateway 脚本，30s 超时容错）；WEB_HTML 网关管理卡（三态徽标 + 启停/重启按钮禁用矩阵 + 模型列表 details + 网关日志卡）；插件测试 **66→73**。**Team C（go-rotate CLI +175 行）**：`go-rotate gateway {start|stop|restart|status|logs [n]}`（Python subprocess 调 launchctl bootstrap/bootout/print + urllib healthz 2s 超时；启停持 `_with_lock`）；`go-rotate status` 末尾追加「网关: running (18888)/stopped」；`uninstall` 支持 `--gateway`；新增 `tests/test-go-rotate-gateway.py`（**35 用例/84 断言**，假 launchctl 注入 PATH + monkeypatch）。**主线程集成**：全测试 **CLI 52 + CLI-gateway 35 + gateway 170 + 插件 73 全 PASS** + 隔离 md5 铁证；同步副本（go-rotate.ts 尚未同步——见遗留；go-rotate/gateway.mjs 已同步）并重启真实网关；真实 18888 四新端点验证 PASS（status/models 26+16/config 零泄漏/log）；真实 CLI `go-rotate gateway status`→running、`status` 末尾网关行、`logs 3` PASS；Web 隔离 E2E（18996 + 假脚本 + 不可达 GATEWAY_BASE）6 项全 PASS。**⚠️ 集成发现**：`~/.local/bin/go-rotate` 曾为旧副本（md5 不同致 `gateway` 子命令打印 Usage），**cp 同步后正常**——后续任何 CLI 改动记得同步安装副本。**遗留（非阻塞）**：`~/.config/opencode/plugins/go-rotate.ts` 安装副本未同步本轮 Web 改动（opencode 8899 待重启生效）；install.sh `--all` 未做（现有 `bash install.sh zen-gateway` 已覆盖，避免过度工程）；`GATEWAY_VERSION` 设计文档字段未实装（status 返回无 version，属可选）。
> **✅ 收尾三连交付（2026-08-16，分析 subagent 裁定「收尾非新功能」+ 3 dev team 并行 + 主线程集成）**：**决策依据**——M3 动态模型表/X2 自愈/bun 兼容均已实装（分析逐项核实剔除），剩余均为低风险工程债，无真机验证需求；codex web_search 与真实 8899 重启为用户侧操作不派 team。交付：① **Team A（install.sh +60/-30 行）**：`--all` 一键装（默认安装后追加 `install_zen_gateway`，任意位置识别，幂等）；uninstall 支持 `--gateway [-y]`（任意位置识别，`( uninstall_zen_gateway -y -y )` 子 shell 防内部 exit 截断 + 传 `-y` 占 $2 跳过二次确认）；**卸载分支整体后移至 `uninstall_zen_gateway` 定义之后**（bash 函数执行到定义行才生效，原 L51 位置调用会 command not found——结构注意点）；头部用法注释同步。沙箱验证（HOME=/tmp/gr-install + 假 launchctl 注入 PATH）：`--all` 装全 6 件/幂等 md5 不变/默认行为不变/uninstall `--gateway` 全删/无 `--gateway` 保网关/参数顺序无关/bash 3.2 全程 0 unbound。② **Team B（gateway.mjs +3 + go-rotate.ts +18/-5）**：`GATEWAY_VERSION="1.1.0"` 常量 + `gatewayStatusSummary` 加 `version` 字段（修契约漂移 §5.3）；`/api/keys/check` 改 **POST-only**（GET→404 不进探测，前端 `api()` 显式 POST，防 GET 触发真实探测耗配额）；Web 网关卡显示 `v1.1.0`（旧网关无 version 容错 `—`）。测试 **gateway 170→171 + 插件 73→74**。③ **Team C（只读审计）**：`docs/审查报告-多provider-auth同步.md`（**0 HIGH / 2 MEDIUM / 3 LOW**）——核心结论：三套 syncAuth 均为「读全量→只改 opencode-go.key→全量写回」部分更新，**不会破坏 codeplan/fox-aws 等其它 provider**；锁完整（统一 go-keys.json.lock）；两次脏 key 事件排除本代码（syncAuth 永不写 name 字段，污染为环境层绕过插件直写）。M-1 插件 syncAuth 无 try/catch（auth.json 损坏→轮换抛错炸）→ **主线程已修**（try/catch + `!Array.isArray` 防御 + log 告警，损坏 auth 下注入/轮换实测正常）；M-2 网关已有 try/catch+log 足够不修；L-3/L-4/L-5 低频不修。**主线程集成**：全测试 **CLI 52 + CLI-gateway 35 + gateway 171 + 插件 74 全 PASS** + 隔离 md5 铁证；安装副本已同步（go-rotate.ts/install.sh）；真实环境零污染。**交付包：55 TS + 8 JSON + 10 WAV + docs/ 21 篇 + tests/ 280 断言 + tools/ 4 脚本 + CLI-gateway 35 用例 + gateway 171 用例**。
> **✅ Web 管理端现状基线审计已完成（2026-08-17，只读审计，未改任何代码）**：产出 `docs/审计报告-管理端现状基线.md`。核心结论：① 页面 649 行/30KB 单文件自包含（52 id / 32 JS 函数 / 42 CSS 规则 / 9 卡片 / 5 区块 / 23 后端 API 端点）；② 后端契约是稳定锚点——前端重构只需替换 `WEB_HTML` 内嵌部分，`handleWeb` 路由与 `statusPayload`/`parseStatsLog`/`gatewayStatus` 等纯函数可一字不动；③ **P1 缺陷 3 个**：P1-1 XSS（`refresh()` 内 `k.name`/`k.key`/`h.detail` 三处 innerHTML 拼接用户可控字段 + 无 CSP + 无 CSRF 防护）、P1-2 `webOff()` 后 body 替换但 4 个常驻 interval 未清理 → 每 5s 未捕获 TypeError 风暴、P1-3 概览页错误不可见（`showErr` 只写隐藏区块内的 `#msg`）；④ **P2 共 8 项**（隐藏区块持续轮询、5s 全表重建打断交互、无空状态、无响应式、错误处理不完整、无加载态、轮询失败污染消息区、checkKeys 无确认耗配额）；⑤ **轮询基线**：4 常驻 interval（refresh 5s / stats 10s / gateway 15s / plans 30s）+ 日志自动 3s 条件启停，常驻 24 请求/min、峰值 44/min；⑥ **结构性耦合三件套**（`data-*` 行内按钮委托 + `.block` 导航 + `#msg` 消息区）是重构最大风险，须整体迁移不可半替换；token 明文会话模型（GET 只回掩码）为既有安全设计不可改；`WEB_HTML` 模板字符串内 JS 换行转义必须 `\\n`。重构验收基准见报告 §8 清单。
> **✅ 管理端 UI/UX 设计规范已交付（2026-08-17，UI 设计师，只输出设计文档未改生产代码）**：产出 `docs/设计规范-管理端UI.md`（§1 设计 token / §2 组件规范 / §3 布局预览 / §4 交互与微动效 / §5 响应式 / §6 完整 CSS / §7 决策总结 + 与两份规划文档对应表）。**服务对象**：`docs/信息架构规划-管理端.md`（新 IA）+ `docs/审计报告-管理端现状基线.md`（白名单）。**核心决策**：深色延续不换肤（语义色 hex 全沿用，中性色 4 级递进 `#0b0d10→#11151c→#181d26→#202636` + 边框/文本 3 级，soft 12% alpha 徽章底）；状态可视化=彩色圆点+文本双通道（key 健康/网关态/鉴权态）；首屏焦点纯 CSS 达成（`#s-current` 品牌蓝 + `.ov-strip` 6 格分隔条 + 网关徽标，零 JS）；微动效全部 ≤200ms（按压 0.5px/card hover 提亮/行 hover 2% 白/tabular-nums 防轮询跳动）；零依赖（spinner/skeleton 纯 CSS、confirm 保持原生、`.modal*`/`.toast` 样式预留待接线）。**兼容红线**：审计 §7 全部 class/id 原样保留增强；新增 class（`.banner/.dot/.toast/.skeleton/.table-wrap/.gw-config-grid/.log-row/.ov-strip/.interactive/.ghost/.sm/.loading/.modal*`）纯样式零 JS 依赖，IA 重构 A5 直接可用。**§6 CSS 已验证可落地**：93 规则（89 普通 + 4 at）/ 约 205 行，node 提取花括号配平 OK + Chrome 真实渲染 0 解析错误（body `#0b0d10`/card `#11151c`/active nav 品牌蓝/stat 24px-600/wrap 1060px/`#s-current` 蓝全部生效）。遗留：XSS 修复（审计 P1-1）属 JS innerHTML 改造（B 组）非 CSS 职责，本规范不越界。
> **✅ 管理端布局再优化交付（2026-08-17，用户反馈 + frontend-design skill 指导）**：三项布局修复——① **key 名称溢出容器**：`.stat .v` 加 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%`（概览当前 key 格）+ `.ov-strip .stat` `min-width:110px→0`（flex 可收缩）；Key 管理表格与统计轮换表 name 列加 `class="td-name"`（`max-width:260px` ellipsis + `title` 悬浮全名，esc 转义保持）；`refresh()` 同步 `#s-current` 的 `title`（当前 key 名超长时悬浮可见）；② **gw-config-grid 单列化**：`grid-template-columns: 2fr 1fr → 1fr`（网关状态卡 + 套餐/Token 纵向堆叠，用户明确要求避免双列布局错乱）；③ **log-row 单列化**：`1fr 1fr → 1fr`（统计页运行日志 + 网关日志堆叠）；@media 720px 断点内双列降级规则自动冗余无害。**验证**：bun build ✅ + 插件单测 100/100 PASS + 真实 8899 浏览器实测（概览 currentKey title=`jiyi1990118@163.com` + ellipsis；网关管理两卡各 1020px 堆叠 top 446→647；统计两卡各 1020px 堆叠）+ md5 隔离不受影响。**坑**：`go-rotate web` 经 CLI 加载**安装副本** `~/.config/opencode/plugins/go-rotate.ts`（非开发目录），改完必须 cp 同步再重启，否则页面无变化（本次已实测踩坑）。遗留（非阻塞）：单列后页面更垂直，日志 pre 高度可后续加 `max-height` 收拢；概览 6 格在 24px 字下 1100px 宽平均 ~176px/格，长 key 名显示省略号（title 可看全名），如需完整显示可调 `.stat .v` 字号或格布局。
> **✅ 管理端继续修复交付（2026-08-17，主线程，处理上轮遗留 P2-2/P2-4/P3-2/P3-3）**：① **P2-2 健康文案夸大**：`ov-hint-min` 固定"当前状态健康"改为动态判定——`availableCount > 0` → "N 个 key 可用，轮换正常。"，全部冷却 → "全部 key 冷却中，轮换暂不可用。"（0 key 仍显示引导条）；② **P2-4 隐藏区块轮询停**：`refreshStats()` 开头守卫 `nav-stats.style.display !== "block"` → return（10s 常驻 interval 不再空转，实测概览页 11.5s 内 `/api/stats` 请求 0 次）；`switchNav('stats')` 手动触发 `refreshStats()+refreshGwLog()`（切入立即出数不等 interval）；③ **P3-2 favicon 404**：`<head>` 加内联 data URI SVG favicon（蓝底圆心环）；④ **P3-3 灰卡无过渡**：`#gateway-card` transition 追加 `opacity .3s`（未运行 opacity 0.55 降级平滑）。**验证**：bun build ✅ + 插件单测 100/100 PASS + 内嵌 JS `node --check` ✅ + 真实 8899 浏览器实测（hintText="1 个 key 可用，轮换正常。"、favicon data URI、gwTransition 含 opacity、切统计 stTotal/gwlog 立即出数、概览隐藏期间 stats 请求 0）。未改后端/CLI/gateway。提交 `d75ae09`（布局三改）后本轮提交见 git log。：用户反馈「web 页面布局存在不少问题」→ 派专业 teams。**审查 team（只读）**：产出 `docs/审查报告-管理端布局问题.md`（202 行 + 5 张截图 `docs/审查截图-0X*.png`），结论 **P1×3 / P2×7 / P3×6**：① P1-1 网关日志卡显示原始 JSON（`gatewayLog()` 用 `r.text()` 取回 gateway `/api/gateway/log` 的 `{lines,total}` JSON 结构未解析，pre 原样展示）；② P1-2 桌面宽屏**横向溢出 5140px**（`.log-row` grid item 无 `min-width:0`，pre 的 `overflow:auto` 被 grid min-width 覆盖，track 撑爆成 1433px+3670px；移动端 390px 反而正常）；③ P1-3 **运行日志/轮换统计被测试污染 80%**（5481 行中 4403 行 `__RING_TEST_`/`gort-plugin-test-*`——`LOG_FILE` 是模块级常量无 env 覆盖，测试隔离了配置但没隔离日志，测试隔离缺陷非页面缺陷）。P2 重点：P2-1 showMsg 写隐藏 `#msg` 设置/统计反馈不可见（showErr 有 toast 兜底、showMsg 无）、P2-2「当前状态健康」只判 keyCount>0 文案夸大、P2-7 健康徽章 invalid/nobalance/error 仍用 b-cooling 琥珀（`.b-invalid` CSS 已就绪 JS 未接线）。**已确认旧 P1 修复无回归**（XSS/CSP/定时器清理/toast 双写）。**修复 Team A（go-rotate.ts WEB_HTML）**：① P1-1 网关日志——后端 `gatewayLog()` 改 `r.json()` 解析 `lines.join("\n")`（+3 行）+ 前端 `refreshGwLog()` 逐行渲染（Array.isArray 优先、textContent 防 XSS、空态「暂无网关日志」）；② P1-2 CSS `.log-row > .card, .gw-config-grid > .card { min-width: 0 }` + `.log-row pre { max-width: 100% }` 结构性根治；③ P2-1 `showMsg` 末尾加 `toast(m,"success")`（+1 行，webOn/editGlobalWindow/clearLog 等调用方自动获反馈）；④ P2-7 `tip()` 改三参按 status 映射 class（invalid/nobalance/error→b-invalid 红、limited→b-warn 黄）；⑤ P3-4 `.ov-strip` 断点 720→780px 去分隔线残留。**修复 Team B（日志隔离，P1-3 根治）**：`go-rotate.ts` L45 `LOG_FILE = process.env.GOROTATE_LOG_FILE || ...` + `gateway.mjs` L65 `ZEN_LOG_FILE`（与 GOROTATE_CONFIG/AUTH_FILE 同模式，生产不设行为不变）；插件单测/网关单测 import 前设 env 指向临时日志；**存量日志备份后清空**（`/tmp/opencode-go-rotate.log.preclean.bak` 保留，日志 5773 行→2 行零测试残留）。**主线程统一复验**：全测试 CLI 53/35/21 + gateway 191 + 插件 100 全 PASS + bun build/node --check/py_compile ✅ + md5 铁证（go-keys `83e49deb…`/auth `e4e9a727…`）+ 真实日志零 `__RING_TEST_` 残留；同步安装副本（md5 一致）+ 重启真实 8899（nohup 拉起 PID 69148）；**真实页面浏览器验证全 ✅**：1280px 视口 `bodyOverflow:false`（原 5140px）、网关日志逐行可读非 JSON、双列各 502px、`showMsg`→`#gtoast toast show success`、徽章 b-invalid 红已接线、运行日志零测试污染。遗留（非阻塞）：P2-2 健康文案夸大（有 key 但全冷却仍显示健康）、P2-3/4/5 审计已知项（5s 全表重建/隐藏区块轮询/轮询失败 toast 风暴）、P2-6 操作列 6 按钮换行（多 key 场景）、P3 微调若干（s-total 冗余/favicon 404/灰卡无过渡）；备份 `.preclean.bak` 待用户确认后可删。：**目标**——用户要求创建专业 UI/UX 设计师、页面信息分析规划 teams 对 8899 Web 界面及功能重构设计。**设计产出 3 文档**：① `docs/审计报告-管理端现状基线.md`（435 行：649 行/30KB 单页、52 id/32 函数/42 CSS/9 卡/5 区块/23 端点、5 定时器；**3 个 P1**：P1-1 XSS[refresh() 的 k.name/k.key/h.detail 直接 innerHTML + 无 CSP/CSRF]、P1-2 webOff 后 4 interval 未清→每 5s TypeError 风暴、P1-3 showErr 只写隐藏区 #msg 概览页错误不可见；P2 8 项[隐藏区块轮询/5s 全表重建/无空态/无响应式]；§7 必须保留 id/class 白名单）；② `docs/信息架构规划-管理端.md`（433 行：**5 区块导航一字不动**[单测锁定红线]→区块内重组：概览降为只读 6 格状态面板[当前 key/可用/网关运行态/最近轮换/冷却只读/Web 只读，编辑下沉设置]、冷却完全行内化、网关两级化[状态卡 2/3 主卡+套餐/Token 1/3 子区]、统计=分析与日志聚合[轮换统计+运行日志+网关日志]、空状态引导；改动分级 A 纯布局/B 小 JS/C 可选后端）；③ `docs/设计规范-管理端UI.md`（**§6 完整 CSS 93 规则 205 行**：深色延续，中性色 4 级 `#0b0d10→#202636` + 语义色沿用、状态=彩色圆点+文本双通道、微交互 ≤200ms、零依赖[spinner/skeleton 纯 CSS]、白名单 class 原样保留增强、Chrome 真渲染 0 解析错误）。**实现 Team A（go-rotate.ts WEB_HTML 重构）**：CSS 42→93 规则全替换；IA 落地[6 格状态条 `.ov-strip`/`ov-gw-state`/`ov-last-rotate`、`keys-empty` 空态、`ov-hint` 引导条、`gw-config-grid` 双列、日志双列 `.log-row`、网关日志移入统计 `an-gwlog-card`、web 按钮迁设置、wrap 1060px + @media 720px 响应式]；**P1 三修**：①`esc()` 统一转义 + CSP 头[`default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri/form-action/frame-ancestors 'none'`]（XSS 注入 `<img onerror>` 实测转义为纯文本不触发）②interval 句柄存 `timers` 对象，webOff 清理后换 body（实测 6s 无 TypeError）③showErr 双写 `#msg`+全局 `#gtoast`（概览页错误可见）；copyToken 一步化。**实现 Team B（测试同步方案）**：`docs/测试同步方案-管理端重构.md`（89 用例/313 expect 基线实测；0 确定性失败、1 条件性[data-edit 依赖 XSS 方案]、12 条新增断言建议）。**主线程集成**：插件测试 89→**100**（新增 11 条重构断言：CSP 头/esc/keys-empty/ov-hint/gw-config-grid/log-row/an-gwlog-card/@media/copyToken 一步化/概览只读化/web 按钮迁移/网关日志搬家；修正 1 处断言误匹配导航按钮 switchNav→改从 s-cooldown 位置向后搜）；全测试 **CLI 53 + CLI-gateway 35 + CLI-gateway-config 21 + gateway 191 + 插件 100 全 PASS** + 隔离 md5 铁证；同步副本 + 真实 8899 web restart 加载新版页面；DOM 快照验证新版渲染（6 格状态条 `test`/1-1/网关运行中/最近轮换 10:44:11/去设置跳链/当前状态健康）+ CSP 头实测存在。**交付包：55 TS + 8 JSON + 10 WAV + docs/ 27 篇 + tests/ 100+53+35+21+191 断言 + 4 脚本**。遗留（非阻塞）：P2 项（隐藏区块轮询/5s 全表重建）未处理；真实 8899 现由独立 bun 进程加载新版（opencode 重启后插件加载同步）；截图存 `docs/gr-admin-new.png`（模型无法看图，视觉以 DOM 快照+HTML 校验为准）。
> **✅ 管理端布局审查报告已交付（2026-08-17，只读审查，未改任何代码）**：产出 `docs/审查报告-管理端布局问题.md`（+ 截图 `docs/审查截图-01概览~05设置.png`）。结论速览 **P1×3 / P2×7 / P3×6**：① **P1-1 网关日志卡显示原始 JSON**（已知问题 1 根因落定）：`go-rotate.ts gatewayLog()` L561-564 用 `r.text()` 取 zen-gateway `/api/gateway/log` 的 **JSON 结构**（gateway.mjs `getLogRing()` 返回 `{lines,total}`，L135-138/1668）→ 前端 `pre.textContent` 原样展示 `{"lines":[...],"total":4}`。修复：`r.json()` 解析 `lines.join("\n")`（+3 行，需同步插件单测）。② **P1-2 桌面宽屏页面横向溢出 5140px**（视口 1032px）：`.log-row`（CSS L1006）grid item 无 `min-width:0` → pre 超长行（网关日志 JSON 475 字符单行 + 运行日志测试行 184 字符）撑爆 track（两列实测 1433px+3670px），pre 的 `overflow:auto` 被 grid min-width 覆盖失效。修复：P1-1 消除最长行 + `.log-row > .card { min-width:0 }` 结构性根治。移动端 390px 实测无溢出（<720px 断点转单列，**移动比桌面好**）。③ **P1-3 运行日志/轮换统计被测试污染 80%**（已知问题 2 专项结论）：5481 行日志中 4403 行（80%）为测试记录（`__RING_TEST_`×250、`gort-plugin-test-*`、`zen-gateway-unittest-*`、`fake zen-gateway`），页面 300 行窗口内 81% 是测试 → 真实日志被挤出、parseStatsLog 统计被污染（假 key a/b/good/bad + 234 次虚假轮换）。**性质：测试隔离缺陷，非页面缺陷**——`LOG_FILE` 是模块级常量（go-rotate.ts L45 / gateway.mjs L65）无 env 覆盖，测试隔离了配置（GOROTATE_CONFIG/AUTH_FILE）但未隔离日志。修复：LOG_FILE 支持 env 覆盖（`GOROTATE_LOG_FILE`/`ZEN_LOG_FILE`，各 1 行）+ 清理存量日志。**P2 重点**：P2-1 showMsg 写入隐藏 `#msg`（nav-keys 内）→ 设置/统计区块操作成功反馈不可见（showErr 有 toast 兜底、showMsg 无，+1 行可修）；P2-2「当前状态健康」只判 keyCount>0 文案夸大；P2-7 健康徽章 invalid/nobalance/error 仍用 b-cooling 琥珀（设计规范 `.b-invalid` CSS 已就绪 JS 未接线）；P2-3/4/5 为审计已知未修项。**已确认修复生效**：P1-1 XSS（esc 全覆盖+CSP）/P1-2 webOff 定时器清理（控制台仅 favicon 404 无 TypeError 风暴）/P1-3 错误可见（toast 双写）；设置区块 web-on/off 互斥逻辑正确（auto_web=true → 开启 disabled/关闭可用）；窄屏 390px 响应式正常；网关 2/3+1/3 双列 589+386px 正确；概览 6 格 986px 单行均分正确；日志过滤/自动刷新正常。

## CLI 命令

`status` / `list` / `init`(交互式) / `web`(独立启动 Web，无需 opencode) / `web restart`(重启管理端：kill 占用 8899 进程后独立拉起新版 Web，用于 opencode 旧插件加载新版) / `add <name> <key>` / `set <name>` / `next [min]` / `cooldown <name> [min]` / `check [name]` / `stats`(从 /tmp/opencode-go-rotate.log 统计每 key 轮换/冷却次数) / `gateway {start|stop|restart|status|logs|plan|token}` / `uninstall [-y] [--gateway]`

> **CLI 跨进程锁（2026-08-16 已加）**：写命令（set/next/add/cooldown/web on|off/init 的 save）走 `_with_lock()`——与插件 `withLockSync` 同机制同参数（`go-keys.json.lock` O_EXCL + 15s 陈旧锁检测 + 5s 超时降级警告继续）；`save()` 改原子写（.tmp+`os.replace`）。status/list/check 只读不锁；check 的 last_status 写不持锁（探测耗时，避免长锁阻塞插件轮换，且该字段非关键）。并发实测：60 个写命令并行 JSON 无损、无锁残留。
> **stats 限制**：只统计主日志文件（归档 .1/.2/.3 不计）、日志轮转只保留近期 → 统计为「近期」非全历史。

> `go-rotate web` 通过 `bun -e` 加载插件模块并调用 `GoRotate()` 起 Web，复用插件同一套逻辑（不复制代码）。端口仍固定 8899，若已有 go-rotate web 在跑会自动跳过（只启一个）。
> Web 自动启动由配置 `auto_web`（默认 true）控制：`go-rotate web off` 关闭、`on` 开启、`status` 查看。
> 关闭后 opencode 启动不占 8899 端口，轮换功能不受影响；`go-rotate web` 独立启动会通过 `GOROTATE_FORCE_WEB=1` 强制起 Web。
> **`go-rotate web restart`（2026-08-16 已加）**：kill 占用 8899 的进程（若为 opencode 则其下次会话重载新插件）→ 独立模式拉起新版 Web。用于 opencode 旧插件场景下快速加载 Web 新版（如管理端）。已验证：真实 8899 由 opencode 20126 持有 → `web restart` 后 8899 转由独立 bun 进程监听并加载最新插件（主导航 5 区块/套餐卡/token 卡全生效）。
> `uninstall` 删除插件、CLI 自身、`go-keys.json`；**不碰 auth.json**。install.sh 也支持 `bash install.sh uninstall [-y]`。

## 验证方法（重要：改完必测）

1. **逻辑单测（无需真实请求）**：用 bun 直接 import 插件模块，调用返回的 hooks：
   ```bash
   bun -e '
     import("/Users/jary/.config/opencode/plugins/go-rotate.ts").then(async m=>{
       const h=await m.GoRotate({directory:"/tmp"});
       const out={headers:{}};
       await h["chat.headers"]({model:{providerID:"opencode-go"},sessionID:"s1"},out);
       console.log(out.headers); // 应有 Authorization
       await h.event({event:{type:"session.error",properties:{sessionID:"s1",error:{name:"APIError",data:{message:"quota exceeded",statusCode:429,metadata:{url:"https://opencode.ai/zen/go/v1"}}}}}});
     })'
   ```
   注意：会写真实 go-keys.json / auth.json，**测完要恢复**（`cp /tmp/ok.bak`，或先备份）。
2. **Web 跨进程只启一个**：`bun` 起一个 keepalive 实例，再起第二个，确认第二个日志"不再重复启动"。
3. **真实请求**：`opencode run -m opencode-go/hy3 "Reply with exactly: OK"`，看返回值与 `/tmp/opencode-go-rotate.log`。
4. **安装脚本**：沙箱 HOME 下跑 `HOME=/tmp/x bash install.sh`，验证幂等（重跑不覆盖配置）。

## 边界 / 易踩的坑

- **改端口**：`WEB_PORT` 与 README 的 8899、插件日志提示、`startWeb` 健康检查三处要一致。
- `chat.headers` 只对 `providerID` 含 `opencode` 的请求注入，**绝不**影响 codeplan/fox-aws 等其他 provider。
- `isQuotaError` 的 401 也触发轮换（key 失效/余额不足都算），这是刻意的。
- 时区解析：错误消息 `reset at 2026-08-16 08:00:00 +0800 CST` 必须解析出带偏移的时间（`2026-08-16T00:00:00.000Z`），别退化回本地时区。
- 插件在 bun 环境运行，可用 `Bun.serve` / `Bun` 全局；导入用 `node:fs` / `node:os` / `node:path`。
- CLI 与插件是**两套实现**（Python vs TS），共用 `go-keys.json` 与 `auth.json`。改配置 schema 时两边都要同步。
- 分发路径：`install.sh` 的 `BASE_URL` = `https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main`。改文件名/目录要同步。
- **⚠️ 测试铁律（2026-08-16 血泪教训）**：任何单测 / 集成验证 / 轮换模拟，**一律用临时 HOME（`HOME=/tmp/...`）或 `GoRotate({directory:tmp})` / 临时 `ZEN_CONFIG` 隔离**，**严禁直接对真实 `~/.config/opencode/go-keys.json` / `auth.json` 跑 rotate/cooldown/check/注入验证**。曾因测试 teams 在真实配置上做轮换验证，把测试假 key（key 值 `"k"`）、冷却、`last_status` 写进真实配置，导致真实 key 被顶掉失效。插件模块级 `CONFIG_FILE`/`AUTH_FILE` 由 `homedir()` 在 import 时固化——测试必须在 **import 插件之前**设置 `process.env.HOME`，bun 的 `homedir()` 尊重 `$HOME`；`LOG_FILE=/tmp/opencode-go-rotate.log` 是模块常量不可重定向，测试向其追加日志属可接受副作用。测试用例断言一律以**当前实现实际行为**为真值，发现的缺陷记录报告交主线程裁决，不擅自改生产实现。
- **⚠️⚠️ bun homedir() 不尊重 $HOME（2026-08-16 实测）**：上述"设置 `process.env.HOME` 隔离插件"的方法**无效**——`bun` 的 `node:os.homedir()` 固定返回系统真实 home（`HOME=/tmp/xxx bun -e 'import{os}...'` 实测仍输出 `/Users/jary`）。曾因此导致 `tests/go-rotate-plugin.test.ts`（初版用 `process.env.HOME` 隔离）**把测试 key/冷却写进真实 go-keys.json**（`a-renamed`/`"k"` 混入）。**已修复**：插件支持 `GOROTATE_CONFIG_FILE` / `GOROTATE_AUTH_FILE` 环境变量覆盖 `CONFIG_FILE`/`AUTH_FILE`（生产不设置则行为不变）；插件测试改为 import 前设置这两个变量指向临时文件。**写插件测试/验证时必须用 GOROTATE_CONFIG_FILE/GOROTATE_AUTH_FILE，不是 HOME。** CLI（Python）用 `os.path.expanduser("~")` 尊重 `$HOME`，subprocess env 覆盖有效。
- **真实 key 配置当前状态（2026-08-16 二次修复后）**：`go-keys.json` 仅含 `test`（`sk-epyPd50...`，current、无冷却、无 last_status）；auth.json 同 key。**不要再写入测试 key**。

## 发布流水线

```bash
cd /Users/jary/serverTools/go-rotate
git add -A && git commit -m "..." && git push origin main
git tag -a vX.Y.Z -m "go-rotate vX.Y.Z" && git push origin vX.Y.Z
gh release create vX.Y.Z --title "go-rotate vX.Y.Z" --notes "..."
```
推送后 `curl | bash` 一行安装立即用新版本；发小版本可固定到某个 tag（如 `.../v1.0.0/install.sh`）。

## 调研文档（research）
- `docs/测试同步方案-管理端重构.md`（2026-08-17 写入，测试同步团队只读审计）：**WEB_HTML IA 重构的测试兼容性方案（未改任何代码）**。基线实测：`bun test tests/go-rotate-plugin.test.ts` 89 pass / 313 expect / 0 fail。WEB_HTML 相关断言 5 test / 72 expect 逐条对照新 IA（`信息架构规划-管理端.md`）：**确定性失败 0 条**（全部断言元素按红线 C4/§1.3 原样保留，移动区块不影响 `toContain`）；**条件性失败 1 条**——L631 `data-edit="`（取决于 P1-1 XSS 修复实现：方案 A 保留字符串拼接+escapeHtml → 过；方案 B 改 DOM API setAttribute → 挂，同步建议改为 `toContain("data-edit")`）；低风险观察 1 条——L673 启动序列断言（实现方若超 IA 范围做懒加载才挂）。**建议新增 12 条断言**：CSP 头（handleWeb 响应头或 meta 双思路，注意内联 script 需允许 'unsafe-inline'）/ XSS 转义函数或旧拼接消失 / keys-empty / ov-hint / gw-config-grid+log-row 双列 class / an-gwlog-card / @media / copyToken 一步化（not.toContain 旧「先显示」提示）/ 概览只读化跳链（indexOf s-cooldown → switchNav('settings')）/ web 按钮迁移（indexOf nav-settings 之后）/ 网关日志移入统计（indexOf nav-stats 之后）。**关键提醒**：现有 72 条全是 `toContain` 弱断言，无法捕获「元素搬家」回归，必须靠 3 条 indexOf 位置断言补网。实施顺序：实现团队落地 A+B+P1 后先跑现有测试（方案 A → 89/89 零改动；方案 B → 仅 L631 一条需同步）→ 补 12 条新增 → 复验链（bun build + node --check + bun test ≈101 条 + 隔离 E2E 断言空态横幅/双列 class）。

- `docs/信息架构规划-管理端.md`（2026-08-17 写入）：**8899 Web 管理端 IA 重构规划**（纯规划，未改生产代码）。基线：`/tmp/gr-web.html`（649 行页面提取）+ 单测 `tests/go-rotate-plugin.test.ts` UI 断言约束（main-nav + 5 区块 id + gw-plan-card/gw-token-card/gateway-card 等全部保留）。核心决策：5 区块导航不变（test 锁定），块内重组——概览降为只读「状态面板」（当前 key/可用/网关运行态/最近轮换/冷却只读/Web 只读，编辑全下沉设置与 Key 管理）；冷却行内化（每 key 行内、全局只在设置）；网关管理两级化（状态卡 2/3 主卡 + 套餐/Token 1/3 配置子区）；网关日志卡移入「统计」区块（聚合为分析与日志：轮换统计+运行日志+网关日志）；引入 3 处空状态横幅 + 首上手引导条；桌面双列（max-width 860→1060）。改动分级：A 组纯布局（HTML 顺序/嵌套+CSS，JS 零改动，一次可上线）；B 组小 JS ≤5 行/项（ov-last-rotate 最近轮换、ov-gw-state 网关态、keys-empty 空态、copyToken 一步化复制）；C 组可选后端（首个 key 自动 current 1 行、7 天用量趋势代理 18888 /api/usage/trend）。兼容红线：被 JS getElementById 引用的 id（s-*/set-*/gw-*/st-*/log-*/token-*/plan-*/web-*/tbody/msg/check-hint）可移区块不可删。后续实施时按 §6 分级推进。
- `docs/ccswitch-opencode-usage-tracking.md`（2026-08-15 写入）：CC Switch 监控 opencode token 消耗的机制（读 opencode.db 会话日志，非本地代理）。
- `docs/zen-model-research.md`（2026-08-16 写入）：**opencode zen/go 免费模型导出为供应服务的可行性调研**。关键技术结论：官方端点 `https://opencode.ai/zen/v1`（Zen）与 `https://opencode.ai/zen/go/v1`（Go），均支持 OpenAI 兼容 `/chat/completions` + `/v1/models` 列表；官方明确支持「用任何 agent」，个人自用=合规，对外转售=违反 ToS（own internal use, not for third party benefit）。免费模型 7 个（big-pickle/deepseek-v4-flash-free/mimo-v2.5-free/**hy3-free**/laguna-s-2.1-free/nemotron-3-ultra-free/nemotron-3.5-lightning-free）。**关键区分：hy3 是 Go 模型（`opencode-go/hy3`），免费档是 `hy3-free`（`opencode/hy3-free`），探测别混用**。现有成熟方案：routatic/proxy（945★，协议转换+模型选择）、free-claude-code（多 agent+多 key+配额）。推荐：个人自用直接复用 key，仅需时加本地网关做多 key 轮换。

## zen-gateway（2026-08-16 已交付）
- 目录：`zen-gateway/`。单文件 `gateway.mjs`（Node ≥18 原生 http+fetch，**零 npm 依赖**）+ `README.md` + `usage-report.mjs`（用量趋势分析）+ `tests/run-tests.mjs`（纯逻辑单测，`ZEN_TEST=1 node run-tests.mjs`，120 断言）；架构文档 `docs/zen-gateway-architecture.md`。
- 作用：把 opencode zen（Go 档）暴露成 OpenAI 兼容网关，供 claude code/codex/cursor 使用；**与 go-rotate 共用 `go-keys.json`**（同锁/原子写/轮换），配额耗尽自动换 key 重试一次。
- 端点：`POST /v1/chat/completions`（stream SSE 逐块透传）、`GET /v1/models`（26 个 Go 档真实模型）、`GET /healthz`。默认 `127.0.0.1:18888`（避开 8899 与 tui-control 7792-7811）。
- 模型映射：请求任意模型名 → zen 真实模型（默认 `hy3`，env `ZEN_DEFAULT_MODEL` 可改）。26 个真实模型原样透传；别名 `grok-code→hy3`、`gpt-4o→glm-5.2`、`gpt-4o-mini→deepseek-v4-flash` 等。
- **关键实测结论**：`hy3` 是**推理模型**（先输出 reasoning 再 content，`max_tokens` 不足时 `content:null`）；agentic/工具密集场景建议 `ZEN_DEFAULT_MODEL=deepseek-v4-flash|glm-5.2` 避免推理开销。
- 环境变量：`ZEN_GATEWAY_PORT/HOST/TOKEN`、`ZEN_CONFIG`、`ZEN_DEFAULT_MODEL`、`ZEN_UPSTREAM_BASE`。鉴权默认仅绑定 127.0.0.1；内网共享需 `ZEN_GATEWAY_HOST=0.0.0.0` + token。
- 验证：`node --check` PASS；真实 key 非流式/流式/模型映射均通过；假 key 401 → 自动轮换到下一 key → 重试成功（轮换写临时 `ZEN_CONFIG` 配置验证，auth.json 测后已还原）。启动：`cd zen-gateway && node gateway.mjs`。
- **QA 审查与客户端接入（2026-08-16，QA team）**：审查报告 `docs/zen-gateway-review.md`（2 HIGH / 6 MEDIUM / 8 LOW；最严重：①请求体无大小上限内存 DoS、②并发 401 时 rotate 冷却"当前 key"而非失败 key 误冷却健康 key、③token 空串静默关鉴权+明文打 stdout）；客户端接入指南 `docs/zen-gateway-clients.md`（claude code 需 Anthropic 协议等 `/v1/messages`，codex 新版仅 Responses 需 `/v1/responses`，cursor 非 GPT-5 模型可用；网关本体已实测非流式/流式/别名/鉴权）。审查仅只读未改 gateway.mjs；Anthropic `/v1/messages` 并行开发中，纳入后续审查。
- 注意：claude code 走 Anthropic `/v1/messages` 协议，本网关是 OpenAI 兼容，需协议转换层或直接用 codex/cursor。
- **✅ Anthropic /v1/messages 端点交付（2026-08-16，Team A）**：gateway.mjs 新增 `POST /v1/messages`（双层协议转换：anthropicToOpenAI / openAIToAnthropic / streamAnthropic 逐事件转换，thinking 参数忽略、tool_result→role:tool、tool_calls→tool_use、input_json_delta 按 index 分片重组、content:null→空 text 块+max_tokens；鉴权兼容 x-api-key + anthropic-version）。**实测全 PASS**：非流式/流式 7 事件序列/tools 流式分片/system+thinking+tool_result/max_tokens=8 边界/假 key 401→轮换/坏 JSON 400/OpenAI 回归。claude code 接入：`ANTHROPIC_BASE_URL=http://127.0.0.1:18888` + `ANTHROPIC_API_KEY=占位`（或 `ANTHROPIC_AUTH_TOKEN=<ZEN_GATEWAY_TOKEN>`），`claude -p "hi"` 直连。
- **✅ 主线程修复 QA 审查 2 HIGH + 1 MEDIUM（2026-08-16）**：① 请求体无大小上限（内存 DoS）→ 新增 `readBody` + `MAX_BODY_BYTES=8MB`，超限 413（实测 9MB body → 413）② 并发 401 误冷却健康 key → `rotate(errBody,status,failedKeyName)` 改为冷却**实际失败的 key**（原冷却 current，并发 401 会误伤刚切过去的好 key）③ token 空串静默关鉴权 + 明文打 stdout → 新增 `maskToken`（日志/启动输出只显示掩码）。已同步安装副本并 `zen-gateway restart`，healthz + 真实请求 + /v1/messages 复验 PASS。
- **✅ Phase 2 推进交付（2026-08-16，Team A/B 并行 + 主线程复验）**：
  - **Team A（架构）新增 OpenAI Responses API**：`POST /v1/responses`（新版 codex 2026 起仅 Responses / cursor GPT-5 系），双层转换（input 数组/instructions/max_output_tokens/tools → chat completions；output_text/function_call → Responses；流式逐事件 response.created→output_text.delta→response.completed）；**cursor 兼容**：`/v1/chat/completions` 收到含 `input` 无 `messages` 的 body 自动走 Responses 转换（实测：非流式 OK ✅、流式 9 事件序列 ✅、cursor 检测分支 ✅）。
  - **Team B（工程）修复审查 MEDIUM/LOW**：S6（非 loopback HOST + 无 token → 拒绝启动退出码 1，`ZEN_ALLOW_OPEN_NOSEC=1` 显式绕过；实测 ✅）、C2（`withLockAsync` 异步锁 sleep 100ms 轮询让出事件循环，运行路径全走 async 锁）、E1（`AbortController` + `res.on("close")` → abort 上游 fetch + `combineSignals` 桥接超时/客户端双信号）、E2（流中段错误帧：OpenAI `data:{error}` / Anthropic `event: error` / Responses `response.failed`）、R1（parseResetTime 时区 regex 放宽 `+0800`/`+08:00`/`Z` 仍解析 UTC）、E4（loadConfig 损坏警告日志）、M1（推理模型 content:null 非流式 reasoning 兜底）。
  - **主线程复验**：全部端点（chat/messages/responses/models/healthz）真实请求 PASS；S6 拒绝启动 PASS；9MB→413 PASS；`node --check` PASS。文档同步：README（Responses 端点+codex/cursor 配置表）、review.md（§已修复表）、clients.md（三客户端状态全部 ✅）、architecture.md。运行中服务已重启加载新版。
  - **遗留（非阻塞）**：M3 动态模型表（ZEN_MODELS 26 个硬编码）、X2 reconcileCurrent 自愈、bun 兼容未实测；codex/cursor 本机未装，客户端级实测待有环境时补。
- **✅ Phase 3 推进交付（2026-08-16，三 team 并行 + 主线程复验）**：
  - **Team C 验证（codex 实测 + 终验）**：`npm install -g @openai/codex` → **codex-cli 0.147.0** 直连网关实测全 PASS（`codex exec --skip-git-repo-check "Reply with exactly OK"` → `OK`，`-m gpt-5` 别名映射 → hy3；tokens 7584 因 hy3 推理先行）。隔离方式：`CODEX_HOME=/tmp/codex-zen` 指向临时目录，用户真实 `~/.codex/config.toml`（newapi@15721）一字未动。**坑：codex 0.147.0 默认发 `{"type":"web_search"}` 工具（无 name）→ zen 400**，config.toml 需 `web_search = "disabled"`。**bun 观察项升级为真实 HIGH bug**：所谓「首次瞬时 AbortError」实为**上游超时进程崩溃**——三个 handler `await sendWithRotation` 无 try/catch + 无 unhandledRejection 兜底，`AbortSignal.timeout(15000)` 触发时 AbortError 外泄崩进程（挂起 mock 上游在 Node 与 bun 下均复现）。
  - **Team B（每 key 独立冷却 window）**：go-keys.json schema 扩展——每 key 可选 `cooldown_minutes`（有则优先 → 全局 → `DEFAULT_COOLDOWN_MIN`，**向后兼容**）；插件 `cooldownUntilDefault(cfg, key?)` + `rotate()` 冷却取被冷却 key 的独立窗口；CLI 新增 `cooldown <name> window <min|clear>` 子命令（非法拒绝 exit 1）。验证：插件临时 HOME 隔离（A 独立 1min / B 全局 300min 均正确）、CLI 全链路（window 设置/无参/clear/status）PASS。
  - **Team A（网关增强三块）**：①**用量趋势持久化** `usage.jsonl`（默认 `~/.local/share/zen-gateway/usage.jsonl`，`ZEN_USAGE_FILE` 覆盖；`sendWithRotation` 完成后追加 `{ts,key,ok,model,rotated,endpoint}`；超 5000 行截断保留后 1000；**注意 endpoint 参数**：chat/messages/responses 三处接线曾传反已修）；②**轮换系统通知** `notify()`（osascript display notification，文案含新 key 名不含值；非 darwin / `ZEN_NOTIFY=0` 跳过；失败静默）；③**配额主动探测** `ZEN_PROBE_INTERVAL_MIN`>0 才启用（默认关），对当前 key 最小探测（hy3+max_tokens:1+15s 超时），配额错误走同一 `rotate()`，`_probeRunning` 防并发。验证全 PASS（usage 行合法/rotated 标记正确/截断 5099+1→保留 1000/通知日志/探测 6s 触发+轮换+优雅降级）。
  - **主线程修复 HIGH bug**：三 handler `sendWithRotation` → `safeSend`（try/catch 返回 502 `gateway internal`）+ 全局 `unhandledRejection`/`uncaughtException` 兜底（只记日志不崩进程）。**实测：挂起上游 15s → Node 与 bun 双环境均返回 502「gateway internal: This operation was aborted」且进程存活**。**主线程另修 1 个 CLI 真实 bug**：`_with_lock` 锁文件目录不存在时 `os.open(O_EXCL)` 直接 FileNotFoundError 崩（全新 HOME 场景）→ 加 `os.makedirs(dirname, exist_ok=True)`。
  - **主线程复验**：`node --check` ✅ + `py_compile` ✅ + `bun build go-rotate.ts` ✅ + CLI 临时 HOME 全链路（window 设置→无参 30min→全局 300min→clear→非法拒绝）PASS；安装副本已同步（gateway.mjs md5 一致、插件/CLI 已拷）；服务重启后 healthz（keys=2 current=act1）、/api/usage、/v1/models（26）、chat 真实请求（gpt-4o→glm-5.2 返回 OK）、usage.jsonl 落盘（hy3 responses + glm-5.2 chat 两行）全部 PASS。
  - **遗留（非阻塞）**：macOS 通知真实弹窗未人工确认（日志为证）；codex `web_search="disabled"` 为客户端配置需用户自行加；主动探测与 `go-rotate check` 手动命令未统一。
- **✅ Phase 4 测试补全 + 新装审计交付（2026-08-16，三 team 并行 + 主线程集成修复）**：
  - **Team A（usage 分析工具）**：新建 `zen-gateway/usage-report.mjs`（零依赖 Node ≥18，readline 流式统计：汇总/按 key 明细/按日趋势 ASCII 柱状图，支持 `--file/--days/--key/--endpoint/--json`，坏行计 bad_lines 不崩，退出码 0/1/2；ts 按 UTC 归日兼容带时区偏移 ISO）+ `docs/用量趋势分析.md` + README 用量节。实测：真实 18 行 vs `wc -l`+python 独立核算逐项一致；真实数据结论——responses 端点占 67%（codex 走 Responses 协议）、失败集中在测试期假 key 与轮换测试。
  - **Team B（gateway 纯逻辑单测）**：`gateway.mjs` **仅 2 处改动**（`server.listen` 包进 `if (!process.env.ZEN_TEST)` + 文件末尾 ESM 顶层命名 `export` 16 个纯函数 + `__setDynamicModels` 测试钩子；**纯函数实现一字未动**）。新建 `zen-gateway/tests/run-tests.mjs`（零依赖 node 内置断言，**119 用例 / 182 断言点**）+ `docs/测试报告-zen-gateway.md`。**关键坑：`.mjs`（ESM）下 `module.exports` 直接抛 ReferenceError，必须用顶层命名 export**（直接运行惰性、行为逐字节等价）。正常启动回归（临时 18901 + healthz 200 + 26 模型）PASS。**发现 4 项交主线程裁决**（见下）。
  - **Team C（新装审计）**：沙箱 HOME 全链路审计 16 项全 PASS（安装→幂等→init→CLI→插件注入→服务化→端点→卸载，auth.json 始终保留）；产出 `docs/运行就绪核对清单.md`（8 节含期望输出）+ `docs/审查报告-新装审计.md`。**发现 3 项**（见下）。唯一副作用：uninstall 审计短暂 bootout 真实服务，已立即恢复。
  - **主线程裁决 Team B 4 项 + 修 3 个真实 bug**：①`anthropicToOpenAI` **不转换 assistant tool_use**（往返不对称，多轮工具上游可能 400「tool messages must follow assistant tool_calls」）→ **已修**（tool_use→tool_calls，纯 tool_use 无文本 → content:null+tool_calls）；②`isQuotaError` **纯英文正则**（中文"配额/余额"返回 false）→ **已修**（加 `配额|余额|限流|超出`）；③gateway 内 `cooldownUntilDefault` 仅全局窗口（per-key 独立窗口在插件，**签名差异非缺陷**）→ 不修；④`openAIToResponse` 纯 tool_calls 响应**误标 incomplete + 多余空文本块**（codex 可能误判截断）→ **已修**（有 tool_calls 且无 content 时不再标 incomplete/push 空块）。测试断言同步更新为正确行为（119→**120 用例，120/120 PASS**）。
  - **主线程处理 Team C 审计 3 项**：MEDIUM bash 3.2 中文丢值 bug（系统 bash 3.2.57 多字节 UTF-8 紧邻 `$VAR` 丢值，**比 AGENTS.md 记录的 set -u 报错形态更广**）→ **已修 6 处**（管理脚本 L62/L66/L68/L104/L106 + install.sh L265，全角括号两侧加空格；对照实验证明免疫，系统 bash 3.2 实测 URL 不丢）；LOW install.sh `launchctl bootstrap` 失败被 `|| true` 吞掉假报「已加载」→ **已修**（bootstrap 失败 → 检查 `launchctl print` 区分「已加载幂等 warn」/「真失败 warn」，load 回退保留）；LOW clients.md §0「Responses 不兼容/等 /v1/messages」过期声明 → **已修**（三协议全 ✅）。
  - **主线程复验**：`node --check` + `bash -n`（install.sh/zen-gateway）+ `ZEN_TEST=1` 测试 **120/120 PASS**；全角紧邻变量残留清零；安装副本已同步（gateway.mjs md5 一致 + zen-gateway 管理脚本）并 restart；全端点回归 healthz/chat(OK)/messages(HI)/models(26) PASS。**注：healthz `available` 与冷却无关——cooldown_until 只影响轮换选择（pickNext），不影响当前 key 直接请求**（当前两 key 均在冷却期但请求成功，属设计一致）。
  - **本轮新增文档**：`docs/用量趋势分析.md`、`docs/测试报告-zen-gateway.md`、`docs/运行就绪核对清单.md`、`docs/审查报告-新装审计.md` + `zen-gateway/tests/run-tests.mjs` + `zen-gateway/usage-report.mjs`。
- **✅ Phase 5 插件/CLI 单测 + X1 修复 + 隔离事故处置（2026-08-16，三 team 派发空返回 → 主线程全部落盘/修复）**：
  - **三 team 落盘但返回空**（`go-rotate-plugin.test.ts` / `test-go-rotate-cli.py`+`run-cli-tests.sh` / gateway.mjs X1 last_status 修复均已写入文件）。主线程逐项验证并修复。
  - **Team A（插件单测 `tests/go-rotate-plugin.test.ts`）**：bun 零依赖，65 用例 / 163 断言。**初版用 `process.env.HOME` 隔离无效（bun homedir() 不尊重 $HOME）→ 污染真实 go-keys.json（a-renamed/k 假 key 混入），事故根源**。**已修复**：插件加 `GOROTATE_CONFIG_FILE`/`GOROTATE_AUTH_FILE` env 覆盖（生产不设行为不变），测试改 import 前设这两个变量 → **65/65 PASS**。**测试暴露 1 个真实生产 bug 已修**：`loadConfig` 白名单字段往返 → `mutateConfig` 丢失自定义顶层字段（生产只用 5 字段未暴露）→ 补「保留其它扩展字段」。
  - **Team B（CLI 单测 `tests/test-go-rotate-cli.py`）**：Python 标准库零依赖，52 用例 / 119 断言，subprocess `env["HOME"]` 隔离（**python os.path.expanduser 尊重 $HOME，与 bun 不同，有效**）→ **52/52 PASS**。未改生产代码。
  - **Team C（X1 修复）**：gateway `rotate()` 冷却失败 key 时写 `last_status`（`classifyGoError(msg,status)`，401→invalid/402/429→limited 等，与 go-rotate 契约一致）+ 新当前 key 清空 last_status；日志含 last_status。**集成验证**：临时 ZEN_CONFIG 下 401 → go-keys.json 失败 key 有 last_status=invalid ✅。
  - **主线程集成修复**：①插件测试隔离机制（GOROTATE_CONFIG_FILE，见上）；②`loadConfig` 扩展字段保留 bug；③真实配置二次清理（`test` 唯一 key，current，无冷却/状态，auth.json 同步真实 key）。
  - **主线程复验（铁证）**：三套测试全 PASS（插件 65 / CLI 52 / gateway 120）；**测试前后真实 go-keys.json + auth.json md5 完全一致**（隔离铁证）；插件注入真实 key 验证通过；安装副本已同步（go-rotate.ts/gateway.mjs md5 一致）并 restart；healthz + 真实请求（gpt-4o→glm-5.2 OK）回归 PASS。**当前真实 key：`test`（sk-epyPd50...），仅此一个，勿再污染**。
- **✅ 服务化部署交付（2026-08-16，dev team）**：zen-gateway 做成 **macOS 常驻服务（launchd LaunchAgent）**，交付 4 件：① `zen-gateway/launchd/com.go-rotate.zen-gateway.plist`（**模板**，占位符 `__NODE_BIN__/__GATEWAY_MJS__/__GATEWAY_DIR__/__LOG_PATH__`，install 用 python3 替换后写 `~/Library/LaunchAgents/`；`RunAtLoad`+`KeepAlive`+`ProcessType=Background`；label 用 `com.go-rotate.zen-gateway` 因项目品牌+可移植，不用 com.jary.*）；② `zen-gateway/zen-gateway`（bash 管理脚本 → `~/.local/bin/zen-gateway`，命令 `start/stop/restart/status/logs/uninstall`，幂等）；③ `install.sh` 集成 `bash install.sh zen-gateway`（拷贝 gateway.mjs → `~/.local/share/zen-gateway/`、生成 plist、管理脚本、`launchctl bootstrap` 回退 load）+ `bash install.sh zen-gateway-uninstall`（bootout+删文件，不动 go-keys.json/auth.json）；④ README「服务化运行」节 + 架构文档 §8 部署拓扑 + systemd unit 参考。**实测全 PASS**：plutil -lint OK、`zen-gateway start`→`curl /healthz` 200、status running、stop→stopped、restart、uninstall 后文件全清+端口释放+launchctl label 消失、go-keys.json/auth.json 未动。**关键坑（已踩排）**：① macOS 系统 bash 3.2 在 `set -u` 下对「多字节 UTF-8 紧邻 `${VAR}` 于同一 word」有 bug 误报 unbound variable → 管理脚本只 `set -eo pipefail` 不用 `-u`（install.sh 因全用 ASCII `=>` 分隔 vir 无此问题）；② 若此前 `nohup node gateway.mjs &` 手动跑过，旧实例占 18888 会让 LaunchAgent `EADDRINUSE` 反复重启（KeepAlive）→ 先 `pkill -f gateway.mjs` 再装服务；③ launchd 首次 bootstrap spawn 较慢（本机 ~8s），start 健康等待循环用 60×0.25s=15s。**未改 gateway.mjs**（Team A 并行加 /v1/messages，安装时已拉取其新版）。服务当前在本机已安装并 running（`zen-gateway status` 可查）。
 - **✅ 用量趋势 + 系统通知 + 主动探测交付（2026-08-16，dev team）**：三块增强全部落地 gateway.mjs（README/architecture/review 已同步，安装副本已同步并重启）：
   - **用量持久化趋势**：新增 `usage.jsonl` 追加日志（默认 `~/.local/share/zen-gateway/usage.jsonl`，`ZEN_USAGE_FILE` 覆盖），每次 `sendWithRotation` 完成后追加一行 `{ts,key,ok,model,rotated,endpoint}`；`_usageCount` 内存计数（启动 `seedUsageCount()` 回填），超 5000 行截断保留后 1000。`/api/usage` 仍是内存实时计数（重启清零），两者互补。**注意 endpoint 参数**：`handleChatCompletions`→`chat`、`handleMessages`→`messages`、`handleResponsesBody`→`responses`（曾传反已修）。
   - **轮换系统通知（macOS）**：`rotate()` 成功切换后 `notify()` 用 `execFile("osascript", display notification)`，文案含新 key 名不含 key 值；非 darwin / `ZEN_NOTIFY=0` 跳过；失败只 log 不 crash。
   - **配额主动探测**：`ZEN_PROBE_INTERVAL_MIN`（分钟）`>0` 启用 `setInterval`，对当前 key 发最小探测（`hy3`+`max_tokens:1`+15s 超时，复用 `upstreamOnce`）；配额错误→`rotate()`（冷却失败 key+轮换+通知），成功/其它/异常→仅 log；`_probeRunning` 防并发；**默认关闭**不影响既有行为。
   - **实测全 PASS**：`node --check`；mock 上游下 chat/messages/responses 各写合法 `usage.jsonl` 行（ok:true + 正确 endpoint）；真实上游假 key 401→轮换→`rotated:true` + `🔔 发送系统通知` 日志（`ZEN_NOTIFY=0` 时无）；`ZEN_PROBE_INTERVAL_MIN=0.1`（6s）假 key 探测每 6s 触发、401→轮换、无可用 key 优雅降级；mock 下探测 200→`正常`不轮换；`usage.jsonl` 5099 行种子+1→截断 1000；回归 chat/messages/responses/models/usage/healthz 全正常。**测试用临时端口 18896 + 临时 ZEN_CONFIG/ZEN_USAGE_FILE，测后清理；auth.json 曾因测试轮换 syncAuth 写入假 key，已恢复为真实 act1；launchd 服务在高负载（load avg 200+）下 spawn 极慢（~78s），`pkill -9`+`bootout`+`bootstrap` 后最终健康**。
- **✅ zen-gateway 纯逻辑单元测试交付（2026-08-16，dev team）**：`zen-gateway/tests/run-tests.mjs`（零 npm 依赖，node 内置 assert，**119 用例 / 182 断言点全 PASS exit 0**）+ `docs/测试报告-zen-gateway.md`。**gateway.mjs 仅两处改动（纯函数实现一字未动）**：① L1592 起 `server.listen(...)` 包进 `if (!process.env.ZEN_TEST)`（正常启动路径逐字节等价，已用 18901 临时端口 + 临时 ZEN_CONFIG 回归 healthz 200）；② 文件末尾新增 **ESM 顶层命名 `export`** 导出 16 个纯函数（parseResetTime/isQuotaStatus/isQuotaError/mapModel/pickNext/currentKey/cooldownUntilDefault/maskToken/parseErrorBody/combineSignals/anthropicToOpenAI/openAIToAnthropic/responsesToOpenAI/openAIToResponse/allModelIds）+ 测试钩子 `__setDynamicModels`（重置动态模型表）。**关键坑**：任务建议 `module.exports` 在 .mjs（ESM）直接抛 `ReferenceError: module is not defined`（已实测），必须用顶层命名 export（直接运行惰性、不影响行为）。**发现 4 项待主线程裁决（未改实现，详见报告）**：① **`anthropicToOpenAI` 不转换 tool_use block**（只处理 text/image/tool_result，assistant tool_use 被整体丢弃 → 多轮工具调用上游可能 400「tool messages must follow assistant tool_calls」；反向 openAIToAnthropic 的 tool_calls→tool_use 完整，往返不对称）② **isQuotaError 正则纯英文**（中文"配额/余额"返回 false，上游现为英文错误影响低）③ cooldownUntilDefault 在 gateway 内仅全局窗口（per-key 独立窗口在 go-rotate.ts 插件，签名差异非缺陷）④ openAIToResponse 纯 tool_calls 响应被标 incomplete + 多余空文本块（codex 可能误判截断）。运行：`cd zen-gateway/tests && node run-tests.mjs`。

## 待办 / 可扩展方向

- [x] ~~通知机制（切换后通过系统通知 / 日志高亮提示用户）~~（2026-08-16 已实现：macOS osascript 系统通知，见「用量趋势 + 系统通知 + 主动探测交付」；`ZEN_NOTIFY=0` 关闭）
- [x] ~~配额**主动**探测（opencode-go 无公开配额 API；目前已有 `check` 手动探测，无自动轮询）~~（2026-08-16 已实现：`ZEN_PROBE_INTERVAL_MIN` 定时最小探测，见「用量趋势 + 系统通知 + 主动探测交付」；默认关闭）
- [x] ~~CLI 增加文件锁~~（2026-08-16 已加，见上「CLI 跨进程锁」）
- [x] ~~冷却 window 每 key 独立~~（2026-08-16 已实现：`go-rotate.ts` `cooldownUntilDefault(cfg,key?)` 优先取 key.cooldown_minutes，`rotate()` 传当前失败 key；CLI `do_cooldown` 支持 `cooldown <name> window <min|clear>` 设置/清除每 key 独立窗口。向后兼容，详见 README「配置 Schema」）
- [x] ~~使用量统计 / 每个 key 的切换次数趋势~~（网关 `/api/usage` 内存计数 + CLI `go-rotate stats` 日志统计；**持久化趋势已做**：`usage.jsonl` 追加日志，见「用量趋势 + 系统通知 + 主动探测交付」）

> 健康探测注意：`probeKey`/CLI `check` 用模型 `hy3` + `max_tokens:1` 发最小请求判断 key 状态。
> 关键坑：**CLI 用 urllib 必须伪装浏览器 UA**（opencode.ai 会 403 拦截 `Python-urllib`）；插件用 bun `fetch` 无此问题。