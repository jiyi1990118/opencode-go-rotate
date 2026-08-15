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
    { "name": "act1", "key": "sk-...", "cooldown_until": null }  // null=可用；ISO 时间=冷却到何时
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
      当前 key 进冷却（优先解析错误里 "reset at <time>" 含时区偏移，否则用 cooldown_minutes）
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

## CLI 命令

`status` / `list` / `init`(交互式) / `web`(独立启动 Web，无需 opencode) / `add <name> <key>` / `set <name>` / `next [min]` / `cooldown <name> [min]` / `check [name]` / `uninstall [-y]`

> `go-rotate web` 通过 `bun -e` 加载插件模块并调用 `GoRotate()` 起 Web，复用插件同一套逻辑（不复制代码）。端口仍固定 8899，若已有 go-rotate web 在跑会自动跳过（只启一个）。
> Web 自动启动由配置 `auto_web`（默认 true）控制：`go-rotate web off` 关闭、`on` 开启、`status` 查看。
> 关闭后 opencode 启动不占 8899 端口，轮换功能不受影响；`go-rotate web` 独立启动会通过 `GOROTATE_FORCE_WEB=1` 强制起 Web。
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

## 发布流水线

```bash
cd /Users/jary/serverTools/go-rotate
git add -A && git commit -m "..." && git push origin main
git tag -a vX.Y.Z -m "go-rotate vX.Y.Z" && git push origin vX.Y.Z
gh release create vX.Y.Z --title "go-rotate vX.Y.Z" --notes "..."
```
推送后 `curl | bash` 一行安装立即用新版本；发小版本可固定到某个 tag（如 `.../v1.0.0/install.sh`）。

## 待办 / 可扩展方向

- [ ] 通知机制（切换后通过系统通知 / 日志高亮提示用户）
- [ ] 配额**主动**探测（opencode-go 无公开配额 API；目前已有 `check` 手动探测，无自动轮询）
- [ ] CLI 增加文件锁（当前 CLI 写入未加跨进程锁，与插件并发时理论上有竞态）
- [ ] 冷却 window 每 key 独立（当前是全局 `cooldown_minutes`）
- [ ] 使用量统计 / 每个 key 的切换次数趋势

> 健康探测注意：`probeKey`/CLI `check` 用模型 `hy3` + `max_tokens:1` 发最小请求判断 key 状态。
> 关键坑：**CLI 用 urllib 必须伪装浏览器 UA**（opencode.ai 会 403 拦截 `Python-urllib`）；插件用 bun `fetch` 无此问题。