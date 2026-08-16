# Web 管理界面 · 增强后回归

> 2026-08-16 主线程补做（Team C 未完成落盘）。对照 `docs/Web界面使用.md` §7.4「增强前基线·已知限制十条」逐项核验。

## 回归方法

- 隔离实例：`GOROTATE_CONFIG_FILE`/`GOROTATE_AUTH_FILE` 指向临时 2 假 key 配置 + 临时端口 18997 起 `handleWeb`（`GOROTATE_WEB_PORT` env 覆盖生效——Team A 收尾 ⑥ 已落地）。
- 全部写操作走隔离配置；真实 `~/.config/opencode/go-keys.json` + `auth.json` 前后 md5 一致（`70aa1342…` / `e4e9a727…`）。

## API 回归矩阵（隔离实例 18997）

| # | 验证 | 结果 |
|---|---|---|
| 1 | `GET /` 含全部新卡片（stats-tbody / gateway-card / data-edit / editKey JS） | ✅ |
| 2 | `GET /api/status` 结构完整（keys 含 cooldown_minutes/last_status/isCurrent/state） | ✅ |
| 3 | `GET /api/stats` → `{totalRotations, byKey}` | ✅ |
| 4 | `GET /api/gateway` → 连真实 18888，`running:true` | ✅ |
| 5 | `POST /api/cooldown/window {a,30}` → status 中 a.cooldown_minutes=30 | ✅ |
| 6 | `POST /api/settings {60}` → 全局 cooldown_minutes=60 | ✅ |
| 7 | `POST /api/keys/update {a→a2}` → current 跟随 a2 | ✅ |
| 8 | `POST /api/web/off` → `{ok:true, shutting_down}` | ✅ |
| 9 | `POST /api/web/on` → 返回 `restarted` 布尔（off 后 on 为 true） | ✅ |

## 基线十条限制对比

| # | 限制（增强前） | 当前状态 | 证据 |
|---|---|---|---|
| ① | 无每 key 冷却窗口 UI | ✅ 已解决 | key 行「窗口/清窗」按钮（Team A 上轮） |
| ② | `/api/keys/update` 无编辑入口 | ✅ 已解决 | key 行「编辑」按钮（Team A 收尾） |
| ③ | 删除 key 无 confirm | ✅ 已解决 | `confirm()` 弹窗 |
| ④ | 无统计/用量图表 | ✅ 已解决 | 轮换统计卡片 + zen-gateway 状态卡片 |
| ⑤ | 无鉴权（仅 127.0.0.1） | ❌ 未解决 | 设计如此（本地工具）；如需 token 鉴权为后续项 |
| ⑥ | `WEB_PORT=8899` 硬编码无 env 覆盖 | ✅ 已解决 | `GOROTATE_WEB_PORT` env 覆盖（隔离实例 18997 生效铁证） |
| ⑦ | `/api/keys/check` 非纯只读（探测+写 last_status） | 🟡 部分 | 探测是功能（检测 key 健康），写 last_status 为设计；GET 可触发是开放面，建议后续改 POST-only |
| ⑧ | `/api/web/on` 只开 auto_web 不立即重启 | ✅ 已解决 | 返回 `restarted`，server 未运行即拉起 |
| ⑨ | 无 provider_id 编辑 | ❌ 未解决 | 低频场景，未纳入 |
| ⑩ | 无每 key 精确冷却时长 UI | ✅ 已解决 | 即 ① 的窗口设置（精确分钟） |

## 真实 8899 状态

- 8899 由 opencode 进程（会话实例）加载**旧插件**监听，`GET /` 仍为旧版（无 stats-tbody）。
- 开发目录 + 安装副本 `~/.config/opencode/plugins/go-rotate.ts` 已是最新（md5 一致），**opencode 重启后新 Web 生效**。

## 遗留 / 建议

- ⑤ 鉴权：本地工具 + 仅 127.0.0.1 绑定，风险低；如需内网共享再加 token。
- ⑦ `/api/keys/check` 建议 POST-only（避免 GET 意外触发真实探测消耗配额）。
- ⑨ provider_id 编辑：低频，暂缓。
- 真实 8899 需用户重启 opencode 才能看到增强（不强杀用户会话）。