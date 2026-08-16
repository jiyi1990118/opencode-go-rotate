# 测试报告：go-rotate CLI（零依赖单测）

- 日期：2026-08-16
- 测试文件：`tests/test-go-rotate-cli.py`（仅 Python 标准库，`unittest` + `tempfile` + `subprocess`，零 npm/零第三方依赖）
- 运行：`python3 tests/test-go-rotate-cli.py`（或 `bash tests/run-cli-tests.sh` 一键：py_compile + 单测 + md5 隔离确认）
- 结果：**52 用例 / 119 断言语句，全部 PASS（exit 0），用时 ~7.5s**

## 1. 覆盖范围

| 类别 | 用例数 | 说明 |
|---|---|---|
| 命令分发/退出码 | 8 | 无参数→doc exit 0；未知命令→1；缺参数（set/add/cooldown）→1；无配置 status/set 干净报错无 traceback；锁不残留 |
| status/list | 5 | 当前 key 标记 `>`、各 key 名、冷却状态、last_status 中文标签、list 别名、无 .lock/.tmp 残留 |
| set/next | 6 | 切换 current + auth 同步；未知 key；跳过冷却 key；全部冷却兜底；单 key 轮换回自身；**next [minutes] 不冷却旧 key（死变量，见 §3）** |
| cooldown 全链路 | 10 | 显式分钟/无参全局/无参 key 独立窗口/window 设置/window clear/clear/0 清除/负数拒绝/非整数拒绝/未知 key/非法分钟值干净报错 |
| 锁与原子写 | 4 | 陈旧锁（>15s mtime）自动清除；新鲜锁 5s 超时降级警告继续（长用例 ~5s）；写后无 .tmp；**20 并发写命令 JSON 无损、锁删除、无 tmp** |
| web 分发 | 4 | on/off 写 auto_web、status 读、独立启动无插件→exit 1（不碰 bun/8899） |
| stats | 3 | 临时日志 3 轮换+2 冷却计数正确 + 最近切换时间；日志不存在→SystemExit；无轮换行提示 |
| add（进程内打桩） | 4 | 新建 key + current 自动设置、已有配置追加、重名拒绝（探测前拦截）、**源码断言 add 探测在锁内执行** |
| init（进程内打桩） | 3 | 交互创建配置+auth 同步、空输入不写配置、重名跳过 |
| uninstall | 2 | 仅测取消路径：输入 n 取消不删除；**EOF（`< /dev/null`）默认取消（修复后）**；`-y` 会真删，不测 |
| auth 同步 | 2 | auth.json 权限 0600；保留其他 provider 仅更新 opencode-go |
| **合计** | **52** | 119 条 `self.assert*` 断言语句 |

**策略**：绝大多数用例 subprocess 跑真实 CLI（`env HOME=临时目录`，覆盖参数解析/退出码/真实文件 IO）；需要网络（`probe_key`）或读写全局日志的用例（add/init/stats）用 `importlib.machinery.SourceFileLoader` 进程内加载 + monkeypatch（`probe_key` 打桩、`LOG_FILE` 指临时文件、`sys.stdin` 替换），保证**零网络、零真实文件**。

## 2. 运行方式与验证记录（真实输出）

```
$ python3 -m py_compile go-rotate        # PASS
$ python3 tests/test-go-rotate-cli.py
...
Ran 52 tests in 7.460s
OK
用例数: 52  断言语句数: 119  失败: 0  错误: 0  跳过: 0
```

隔离验证（测试前后真实配置 md5 完全一致，测试全程未触碰）：

```
测试前: MD5 (~/.config/opencode/go-keys.json) = b64d8abf5cf4cc1b2c50c06369db3fa5
        MD5 (~/.local/share/opencode/auth.json) = 863176e6ea5f13a1f7b081828ef92b14
测试后: 相同（逐字节未变）
```

- 未启动任何 bun 进程、未占用 8899 端口（web 用例只在临时 HOME 下验证命令分发到「插件未安装」分支）。
- 未触碰真实 `/tmp/opencode-go-rotate.log`（stats 用例全部指向临时日志文件）。
- 临时 HOME（`tempfile.mkdtemp`）由 tearDown 清理，测试后无残留。

## 3. 发现的真实 Bug

| # | 严重度 | 位置 | 复现 | 预期 vs 实际 | 状态 |
|---|---|---|---|---|---|
| 1 | 中 | `go-rotate` L220 `do_cooldown` | `go-rotate cooldown act1 abc` | 预期：干净用法提示 exit 1；实际：未捕获 `ValueError` → Python traceback 泄漏给用户（rc 1 但输出丑陋） | **已修**：`int(minutes)` 包 try/except ValueError → `sys.exit("非法冷却分钟值...")` |
| 2 | 中 | `go-rotate` L500 `main()` | `go-rotate next abc` | 预期：干净提示；实际：`int(args[1])` 未捕获 ValueError → traceback | **已修**：main 内 try/except → `sys.exit("非法分钟值...")` |
| 3 | 中 | `go-rotate` L401 `do_uninstall` | `go-rotate uninstall < /dev/null`（EOF） | 预期：默认取消（fail-safe）；实际：`input()` 抛未捕获 `EOFError` → traceback 崩溃 | **已修**：try/except EOFError → 按「n」默认取消（防误删） |
| 4 | 高（功能缺口） | `go-rotate` L154 `do_next` | `go-rotate next 45` | `dst_min` 计算后**从未使用**（死变量）。README L91「next [分钟] 切到下一个可用 key」暗示应把旧 key 冷却 minutes；实际旧 key 的 `cooldown_until` 保持原样，参数静默无效 | **待裁决**：语义歧义（是冷却旧 key 还是别的含义），且轮换语义敏感，未擅自改；建议确认意图后补 `旧key.cooldown_until = now + dst_min` 或删参数 |
| 5 | 低（设计观察） | `go-rotate` L501 + `do_add` | `go-rotate add` 慢网络场景 | `do_add` 在 `_with_lock` 内调用 `probe_key`（最多 15s 超时）→ **add 期间持锁最长 15s**，会阻塞插件/CLI 并发轮换 | **待裁决**：与 `do_init`（探测在锁外）不对称；建议把探测移出锁或先落盘再探测 |

修复均最小化（Bug 1/2 各 3-4 行、Bug 3 4 行），`python3 -m py_compile` 通过，52 用例全绿；复验输出见 §2。

## 4. 遗留（未测原因）

- **`do_check` 真实探测**：走网络打 opencode.ai（每次 ~1 token）。未测真实探测；仅覆盖「无可检测 key」分支（`check bogus` / 无 key 配置 → exit 1，无网络）。假 key 401 快速失败探测成本可控但依赖网络可用性，且当前 key 处于冷却期，留待有网环境人工验证。
- **`init` 真实交互**：进程内打桩 `probe_key` + 替换 stdin 模拟；真实终端多 key 输入路径逻辑相同（重名/空输入分支已覆盖）。
- **`uninstall -y`**：会真删插件/CLI/配置，危险；只测取消路径（n 与 EOF）。`-y` 的删除逻辑与取消路径共用 `do_uninstall` 主流程，风险集中在确认分支。
- **`web` 独立启动**：需 bun + 已装插件 + 8899 端口，会干扰真实 web，只验证分发到「插件未安装」分支。
- **`next [minutes]` 语义（Bug 4）**：待主线程/用户裁决后补行为测试。

## 5. 与插件测试的互补关系

- 本套件测 **CLI（Python 实现）**：参数解析、退出码、文件锁、原子写、并发、auth 同步——纯本地、零网络、可全自动。
- 插件单测（并行 team）测 **`go-rotate.ts`（TS 实现）**：`chat.headers` 注入、`event` 轮换决策、时区解析、web 健康检查。
- 两者共用同一份 `go-keys.json` schema 与锁协议（O_EXCL/陈旧锁/超时降级）——本套件的 `_with_lock`/cooldown 全链路用例同时充当 **schema 与锁协议的契约测试**，插件侧对同一文件的读写兼容性由此间接得到验证。
- 互补缺口：插件轮换的「真实配额耗尽→热切换」端到端路径依赖真实 API，两个套件均无法离线覆盖，仍需真实请求冒烟（AGENTS.md 验证方法第 3 条）。