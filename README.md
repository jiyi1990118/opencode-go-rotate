# go-rotate

> 自动轮换 opencode-go 多账号 key，配额用尽热切换，内置 Web 管理界面，无需重启。

opencode 的 opencode-go 多 key 自动轮换插件 + Web 管理界面。

配额用尽 / 401 / 402 / 429 时**自动**切换到下一个可用 key，无需重启 opencode、不中断当前会话。

> 原理：通过 opencode 插件钩子 `chat.headers` 在每次请求注入当前 key 的 `Authorization`（该 header 会覆盖 SDK 自带 key），并用 `event` 监听配额错误触发轮换。

## 特性

- ✅ 自动轮换：配额耗尽自动切换下一个 key
- ✅ 免重启：热切换，当前会话不丢
- ✅ 冷却机制：按滚动窗口让用尽的 key 冷却（可解析错误里的 reset 时间）
- ✅ Web 管理界面：`http://localhost:8899` 增删/切换 key（全系统只启动一个）
- ✅ 并发安全：跨进程文件锁 + 原子写
- ✅ 零依赖：插件用 Node 内置模块，CLI 用纯 Python

## 安装

### 一键安装（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/jiyi1990118/opencode-go-rotate/main/install.sh | bash
```

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

> **不想开 opencode 也能用 Web 界面**：直接运行 `go-rotate web` 即可独立启动
> Web 管理界面（http://localhost:8899），Ctrl+C 停止。
> 若已有 go-rotate web 在运行（如 opencode 已开着），会自动复用，不会重复启动。

## CLI 命令

| 命令 | 说明 |
|---|---|
| `go-rotate init` | 交互式首次配置 |
| `go-rotate web` | 独立启动 Web 界面（无需 opencode 运行） |
| `go-rotate status` / `list` | 查看当前 key 与冷却状态 |
| `go-rotate add <name> <key>` | 新增 key |
| `go-rotate set <name>` | 启用指定 key |
| `go-rotate next [分钟]` | 切到下一个可用 key |
| `go-rotate cooldown <name> [分钟]` | 手动设置/清除冷却 |

## 文件

| 文件 | 说明 |
|---|---|
| `~/.config/opencode/plugins/go-rotate.ts` | 插件（自动加载） |
| `~/.config/opencode/go-keys.json` | key 配置 |
| `~/.local/share/opencode/auth.json` | opencode 凭据（自动同步） |
| `/tmp/opencode-go-rotate.log` | 运行日志 |

## 卸载

```bash
rm -f ~/.config/opencode/plugins/go-rotate.ts ~/.local/bin/go-rotate
# 可选：删除配置
rm -f ~/.config/opencode/go-keys.json
```

## FAQ

**Web 界面打不开？**
插件随 opencode 启动时自动起 Web（localhost:8899）。若没开 opencode，直接运行 `go-rotate web` 即可独立启动。

**为什么要有多个 key？**
opencode-go 是订阅套餐，配额按时间窗口重置。多账号轮换可提升可用时长。

**对我的其它 provider（codeplan/fox-aws 等）有影响吗？**
没有。插件只在 `providerID` 命中的 opencode-go 请求上注入 key，只处理 opencode-go 的配额错误。