# go-rotate

> 自动轮换 opencode-go 多账号 key，配额用尽热切换，内置 Web 管理界面，无需重启。

opencode 的 opencode-go 多 key 自动轮换插件 + Web 管理界面。

配额用尽 / 401 / 402 / 429 时**自动**切换到下一个可用 key，无需重启 opencode、不中断当前会话。

> 原理：通过 opencode 插件钩子 `chat.headers` 在每次请求注入当前 key 的 `Authorization`（该 header 会覆盖 SDK 自带 key），并用 `event` 监听配额错误触发轮换。

## 特性

- ✅ 自动轮换：配额耗尽自动切换下一个 key
- ✅ 免重启：热切换，当前会话不丢
- ✅ 冷却机制：按滚动窗口让用尽的 key 冷却（可解析错误里的 reset 时间）
- ✅ Web 管理界面：`http://localhost:8899` 增删/切换/编辑 key（全系统只启动一个）
- ✅ Web 支持**每 key 独立冷却窗口**（行内「窗口/清窗」按钮）与**全局窗口编辑**
- ✅ Web **轮换统计卡片**（从日志解析每 key 轮换/冷却次数）与 **zen-gateway 状态卡片**（跨进程展示 18888 服务与每 key 用量，未运行时灰卡降级）
- ✅ Web **删除 key 确认弹窗**、日志**自动刷新开关 + 关键字过滤**
- ✅ Web **key 行内编辑**（双 prompt 改名称/key，当前 key 改名 current 自动跟随）
- ✅ Web **`/api/web/on` 立即重启**（server 未运行即拉起并返回 `restarted`），支持 `GOROTATE_WEB_PORT` env 覆盖端口（隔离实例/测试用）
- ✅ 并发安全：跨进程文件锁 + 原子写
- ✅ 零依赖：插件用 Node 内置模块，CLI 用纯 Python
- ✅ **三域独立轮换**：zen（免费档）/ go（套餐档）/ 网关 三个域各自独立 current + 冷却 + 轮换，互不干扰；auth.json 仅由 zen 域维护
- ✅ **双套餐健康检查**：每 key 分别探测 zen 与 go 端点（`check` 或 Web「检查」按钮），状态列展示两行健康 + 探测时间
- ✅ Web **4 区块导航**：Key 管理（三域健康总览 + key 双套餐健康列）/ TUI（zen+go 子卡设置）/ 网关 / 统计
- ✅ 网关卡片**双套餐模型动态查看**：go 与 zen 全部模型（上游实时获取 + 内置兜底），各行分折叠块展示动态/内置计数，「刷新模型」一键重拉；网关设 token 时 Web 自动带 Bearer 读取（不再 401）
- ✅ **梯子（本地 SOCKS5 透明代理）**：Web 一键启用，其它应用（浏览器/curl/git/系统代理）指向 `socks5://127.0.0.1:<port>` 即通过 IP 池出口上网——轮换模式每连接自动换 IP（坏出口自动顺延重试）、固定模式锁定指定出口；内置使用说明
- ✅ **科学上网筛选**：Web「科学上网筛选」按钮对 IP 池每个出口测 google/youtube CONNECT + 出口 IP 归属地，筛出真能翻墙的代理
- ✅ **不可用池**：IP 池/限流池一键「→ 转移不可用」，把健康检查失败的出口移到单独「不可用池」（默认折叠）管理，恢复后移回
- ✅ **实时健康检查**：「检查所有 IP 健康度」逐出口实时探测（每行徽标边查边更新 + 进度计数），大池不再一次性整池长请求超时；结果本地缓存，刷新页面徽标仍在
- ✅ **多选轮换子集**：IP 池每行可勾选 1~N 个出口 →「启用选中为轮换（立即启动）」即时生效（选中项前置到列表头部、复选框保持勾选 + 「轮换中」徽标、`egress_active` 子集落盘）；「恢复全池轮换」一键回全池
- 联动文档：`docs/网关双套餐模型查看-phase22.md`
- ✅ 测试体系：插件单测（`bun test tests/`）、CLI 单测（`python3 tests/test-go-rotate-cli.py`）、gateway 单测（`ZEN_TEST=1 node zen-gateway/tests/run-tests.mjs`）

## 安装

### 一键安装（推荐）

```bash
# 全量安装：插件 + CLI + zen-gateway 网关服务（OpenAI/Anthropic/Responses 兼容，端口 18888）
curl -fsSL https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main/install.sh | bash -s -- --all
# 仅插件 + CLI（不开网关）
curl -fsSL https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main/install.sh | bash
```

### 独立服务器安装（无 opencode，zen 免费网关）

**不需要安装 opencode**，仅需 Node.js ≥ 18。一键安装 zen-gateway 并注册为常驻服务。跨平台：Linux（systemd --user）/ macOS（launchd）/ Windows（计划任务 schtasks）。

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main/install.sh | bash -s -- zen-gateway
# Windows（PowerShell）—— 仅网关：加 -GatewayOnly 跳过 opencode 插件/CLI
powershell -ExecutionPolicy Bypass -File install.ps1
```

自动完成：拷贝 `gateway.mjs` → 创建默认 `go-keys.json` + `gateway-config.json` → 注册常驻服务 → 开机自启 + 崩溃自动重启。安装后：

```bash
zen-gateway status          # 查看状态（running）
go-rotate add mykey sk-xxx  # 填入你的 opencode 账号 API key
go-rotate gateway plan zen  # 切 zen 免费档（默认 go 付费档；免费档自动轮换已禁用）
zen-gateway restart         # 生效
curl http://127.0.0.1:18888/v1/models   # 验证
```

Windows 用 `go-rotate gateway start/stop/restart/status/logs` 装好后管理（等价 `zen-gateway` 命令）；`zen-gateway` 命令由 install.ps1 通过计划任务管理。

> 完整手册（systemd / launchd / **Windows 计划任务** / 客户端接入 / FAQ）：[`docs/部署指南-独立机器.md`](docs/部署指南-独立机器.md)。

### 手动安装

```bash
# 1. 插件（自动加载）
mkdir -p ~/.config/opencode/plugins
cp go-rotate.ts ~/.config/opencode/plugins/

# 2. CLI
mkdir -p ~/.local/bin
cp go-rotate ~/.local/bin/
chmod +x ~/.local/bin/go-rotate
```

## 配置 key

```bash
go-rotate init              # 交互式引导（傻瓜式）
go-rotate add act2 sk-xxx   # 或命令行添加
go-rotate status            # 查看状态
```

或启动 opencode 后访问 **http://localhost:8899**，在网页里增删/切换 key。

## 配置 Schema（go-keys.json）

```jsonc
{
  "provider_id": "opencode-go",   // 命中的 providerID（前缀匹配 "opencode"）
  "cooldown_minutes": 300,        // 全局冷却窗口（分钟）；缺省 300（三域共享）
  "current": "act1",              // zen 域（opencode 免费档）当前 key 的 name（插件路径，字段名不变）
  "current_go": "act1",           // go 套餐域当前 key 的 name（新增；未设置时读侧兜底 current_go ?? current）
  "current_gateway": "act1",      // 网关域当前 key 的 name（新增；未设置时读侧兜底 current_gateway ?? current）
  "keys": [
    {
      "name": "act1",
      "key": "sk-...",
      "cooldown_until": null,     // zen 域冷却：null=可用；ISO 时间=冷却到何时
      "cooldown_until_go": null,  // go 套餐域冷却（新增）：null=可 go 轮换；ISO=冷却到何时
      "cooldown_until_gateway": null,  // 网关域冷却（新增）：null=可网关轮换；ISO=冷却到何时
      "last_status": null,            // zen 域健康状态（可用/无效/余额不足/限流；现状字段）
      "last_status_go": null,         // go 套餐域健康状态（新增）
      "last_checked_zen": null,       // zen 探测时间（ISO；新增）
      "last_checked_go": null,        // go 探测时间（ISO；新增）
      "cooldown_minutes": 30      // 可选：该 key 独立冷却窗口（三域同用）；缺省回退全局 cooldown_minutes
    }
  ]
}
```

**三域独立轮换**：opencode zen（免费档）/ go 套餐 / zen-gateway 共用同一份 key，但各自独立轮换。
- **zen 域**（provider `opencode`，模型 hy3-free）走 `current` / `cooldown_until`（插件/`set`/`next`/`cooldown` 现状行为不变）
- **go 套餐域**（provider `opencode-go`，模型 hy3）走 `current_go` / `cooldown_until_go`（`go set/next/cooldown` 子命令）；未设置时读侧兜底 `current_go ?? current`
- **网关域**走 `current_gateway` / `cooldown_until_gateway`（`gateway set/next/cooldown` 子命令）；未设置时读侧兜底 `current_gateway ?? current`
- **auth.json 唯一归属 zen 域**：仅 zen 域轮换（`set`/`next`）写 auth.json；go 域与网关域轮换**均不碰 auth.json**（auth.json 单槽代表 zen 免费档现状语义，opencode 重启后主用 zen 档）
- 旧配置零迁移，go 域从 `current` 干净起步
- **健康检查双端点**：`go-rotate check` 默认对每 key 双端探测——zen 档 `https://opencode.ai/zen/v1`+hy3-free / go 档 `https://opencode.ai/zen/go/v1`+hy3（`--plan zen|go` 单端点）

冷却窗口优先级：**该 key 的 `cooldown_minutes` > 全局 `cooldown_minutes` > 默认 300 分钟**。
通过 `go-rotate cooldown <name> window <min>` 设置独立窗口，`window clear` 删除字段回退全局。
旧配置（无每 key 字段）行为完全不变。

> **不想开 opencode 也能用 Web 界面**：直接运行 `go-rotate web` 即可独立启动
> Web 管理界面（http://localhost:8899），Ctrl+C 停止。
> 若已有 go-rotate web 在运行（如 opencode 已开着），会自动复用，不会重复启动。
>
> **不想让 opencode 自动占用 8899 端口**：`go-rotate web off`。之后 opencode 启动时
> 不再自动起 Web，但**自动轮换功能不受影响**；需要 Web 时再 `go-rotate web` 手动起，
> 或 `go-rotate web on` 恢复自动启动。

> 📖 **Web 界面完整使用文档**（页面布局 / API 速查表 / 安全说明 / FAQ / 增强前基线 / **Web 增强**）：[`docs/Web界面使用.md`](docs/Web界面使用.md)
> 📊 **Web 增强后回归**（基线十条逐项对比 + API 回归矩阵）：[`docs/Web增强后回归.md`](docs/Web增强后回归.md)

## CLI 命令

| 命令 | 说明 |
|---|---|
| `go-rotate init` | 交互式首次配置 |
| `go-rotate web` | 独立启动 Web 界面（无需 opencode 运行） |
| `go-rotate web on\|off\|status` | 控制 opencode 启动时是否自动起 Web（off = 不占用端口，轮换仍可用） |
| `go-rotate status` / `list` | 查看当前 key 与**三域（zen/go/网关）当前 key**、每域冷却摘要与各 key 冷却状态 |
| `go-rotate add <name> <key>` | 新增 key |
| `go-rotate set <name>` | 启用指定 key（**zen 域**，会同步 auth.json） |
| `go-rotate next [分钟]` | 切到下一个可用 key（**zen 域**） |
| `go-rotate cooldown <name> [分钟]` | 手动设置/清除冷却（**zen 域**；无参用该 key 独立窗口或全局） |
| `go-rotate cooldown <name> window <分钟\|clear>` | 设置/清除该 key 独立的冷却窗口（clear 回退全局；三域共享） |
| `go-rotate check [name] [--plan zen\|go]` | 探测 key 健康（**默认双端点** zen+go；`--plan` 单端点；写双套餐状态） |
| `go-rotate go set <name>` | **go 套餐域**设为当前 key（写 `current_go`，不写 auth.json） |
| `go-rotate go next [分钟]` | **go 套餐域**轮换（原 go current 进 go 域冷却 + 选下一个未冷却写 `current_go`） |
| `go-rotate go cooldown <name> [分钟\|clear]` | 写/清 **go 套餐域**冷却（写 `cooldown_until_go`，缺省窗口与字段级语义一致） |
| `go-rotate stats` | 从日志统计每 key 轮换/冷却次数（近期） |
| `go-rotate gateway {start\|stop\|restart\|status\|logs [n]}` | 管理 zen-gateway 服务（macOS launchd / Linux systemd --user / Windows 计划任务，端口 18888） |
| `go-rotate gateway plan [go\|zen]` | 查看/切换网关套餐（Go 订阅 / Zen 免费档，切换后需 restart） |
| `go-rotate gateway token [gen\|clear\|set <v>]` | 管理网关访问 token（供其它 agent 连接鉴权，只显示掩码） |
| `go-rotate gateway set <name>` | 网关域设为当前 key（不写 auth.json，不影响 TUI） |
| `go-rotate gateway next [分钟]` | 网关域轮换（原网关 current 进网关域冷却 + 选下一个未冷却） |
| `go-rotate gateway cooldown <name> [分钟\|clear]` | 写/清网关域冷却（缺省窗口与 TUI 一致） |
| `go-rotate uninstall [-y] [--gateway]` | 卸载（`--gateway` 同时卸载网关服务） |

## 文件

| 文件 | 说明 |
|---|---|
| `~/.config/opencode/plugins/go-rotate.ts` | 插件（自动加载） |
| `~/.config/opencode/go-keys.json` | key 配置 |
| `~/.local/share/opencode/auth.json` | opencode 凭据（自动同步） |
| `/tmp/opencode-go-rotate.log` | 运行日志 |

## 卸载

```bash
go-rotate uninstall            # 交互确认
go-rotate uninstall -y         # 跳过确认
# 或
bash install.sh uninstall      # 通过安装脚本卸载（-y 跳过确认）
# 手动方式：
rm -f ~/.config/opencode/plugins/go-rotate.ts ~/.local/bin/go-rotate
rm -f ~/.config/opencode/go-keys.json   # 可选：删除配置
```

会删除：插件、CLI、`go-keys.json` 配置。**不会**改动 `auth.json`（保留你的 opencode-go 凭据）。

## FAQ

**Web 界面打不开？**
插件随 opencode 启动时自动起 Web（localhost:8899）。若没开 opencode，直接运行 `go-rotate web` 即可独立启动。

**为什么要有多个 key？**
opencode-go 是订阅套餐，配额按时间窗口重置。多账号轮换可提升可用时长。

**能查每个 key 的额度吗？**
opencode-go 没有公开的额度/余额查询 API，**无法主动查额度**。但可以用 `go-rotate check`（或 Web 里的"检测所有 key"）发最小请求探测每个 key 当前是否可用——**默认双端点**（zen 免费档 + go 套餐档），能区分「可用 / key 无效 / 余额不足 / 限流」。注意每次探测默认消耗约 2 token（双端点），单端点 `--plan zen|go` 消耗 1 token。

**对我的其它 provider（codeplan/fox-aws 等）有影响吗？**
没有。插件只对 `providerID` 含 `opencode` 的请求注入 key——`opencode-go`（go 套餐）注入 **go 域** current key、`opencode`（zen 免费档）注入 **zen 域** current key；只处理 opencode 端点的配额错误。

## 相关项目

- **zen-gateway（`zen-gateway/`）**：把 opencode zen（Go 档 / opencode-go 订阅 key）暴露成标准 OpenAI/Anthropic/Responses 兼容网关，供 claude code / codex / cursor 使用。与 go-rotate **共用 `go-keys.json`** 和自动轮换。见 [`zen-gateway/README.md`](zen-gateway/README.md)，架构设计见 [`docs/zen-gateway-architecture.md`](docs/zen-gateway-architecture.md)。含零依赖工具 `zen-gateway/usage-report.mjs`（用量趋势分析）与 `zen-gateway/tests/run-tests.mjs`（纯逻辑单测，`ZEN_TEST=1 node run-tests.mjs`）。macOS launchd / Linux systemd 服务模板分别在 `zen-gateway/launchd/`、`zen-gateway/systemd/`。
- **渐进整合**：go-rotate 与 zen-gateway 已统一管理面——CLI `go-rotate gateway {start|stop|restart|status|logs}` 管理网关服务，`go-rotate status` 汇总网关状态，Web（8899）网关管理卡（启停/重启/模型/日志）直连 18888 只读端点。整合方案见 [`docs/整合设计方案-渐进整合.md`](docs/整合设计方案-渐进整合.md)。
- **网关管理端**：Web（8899）已可视化管理网关——**go/zen 套餐切换**（Go 订阅 26 模型 / Zen 免费 7 模型，双套餐模型动态查看）、**网关访问 token 多 key 管理**（生成 sk- 前缀 Key / 逐行删除 / 清空，供 claude code/codex/cursor 等其它 agent 连接鉴权，明文仅生成时回显一次并支持一键复制）、启停重启/模型/日志/用量。配置独立存 `~/.local/share/zen-gateway/gateway-config.json`（0600）。设计见 [`docs/网关管理端设计方案.md`](docs/网关管理端设计方案.md)。
- **自适配优化**：网关 UA 自动探测（`opencode --version`）、FreeUsageLimitError 免费档限流不轮换、推理模型 `max_tokens` 截断自动放大重试（`ZEN_AUTO_MAX_TOKENS=0` 关闭）。见 [`docs/网关自适配优化-phase24.md`](docs/网关自适配优化-phase24.md)。
- **独立部署**：无 opencode 机器上部署 zen 免费网关（Node ≥18 单文件 + systemd/launchd，UA 自动回退、plan=zen 免费档）。见 [`docs/部署指南-独立机器.md`](docs/部署指南-独立机器.md)。

## License

MIT License — 见 [LICENSE](LICENSE)。

> 注意：本项目用于调用你自己的 opencode 订阅账号。[opencode 开发者条款](https://opencode.ai/terms) 限制将服务转售或供第三方收益；仅供个人/团队内部自用。