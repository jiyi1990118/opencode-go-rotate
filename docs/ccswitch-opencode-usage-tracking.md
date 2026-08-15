# CC Switch 监控 opencode token 消耗的机制（已确认）

> 调研日期：2026-08-15
> 结论来源：本机 `~/.cc-switch/cc-switch.db`（SQLite，43MB）实际数据 + 官方源码结构交叉验证。
> 关键结论：**CC Switch 直接读取 opencode 自己的 SQLite 数据库 `opencode.db`，完全不经过本地代理。**

## 概览

CC Switch 监控 opencode token 消耗有两条数据来源（写入同一张 `proxy_request_logs` 表，用 `data_source` 区分）：

| 数据来源 | 机制 | opencode 是否使用 |
| --- | --- | --- |
| 代理请求日志（`data_source='proxy'`） | 本地代理拦截 HTTP 请求/响应，解析 usage | ❌ 否 |
| 会话日志导入（`data_source='opencode_session'`） | 直接读 opencode 的 SQLite 数据库 | ✅ **是（本机的实际来源）** |

本机 `proxy_config` 表只有 claude / codex / gemini / grokbuild，**没有 opencode**，因此 opencode 没有走 CC Switch 的本地代理。

## 详细机制（opencode 会话导入路径）

### 1. 定位 opencode 数据库
优先 `OPENCODE_DB` 环境变量 > `XDG_DATA_HOME` > `~/.local/share/opencode/opencode.db`。本机为 `~/.local/share/opencode/opencode.db`（约 7.6GB）。

### 2. 按会话增量同步
`session_log_sync` 表记录每个会话（`opencode.db:ses_xxx`）的同步进度：
```sql
CREATE TABLE session_log_sync (
    file_path TEXT PRIMARY KEY,        -- 如 /…/opencode.db 或 /…/opencode.db:ses_xxx
    last_modified INTEGER NOT NULL,
    last_line_offset INTEGER NOT NULL DEFAULT 0,
    last_synced_at INTEGER NOT NULL
);
```
只处理新增 / 变更的会话，不回扫全库。本机 `session_log_sync` 中有 2806 条 `opencode.db:ses_xxx` 记录。

### 3. 读 `part` 表的 `step-finish` 节点
opencode 每次模型调用完成会写一条 `data.type='step-finish'` 的 part，其 `data.tokens` 就是真实消耗：
```json
{
  "type": "step-finish",
  "tokens": {
    "total": 72692,
    "input": 61698,
    "output": 434,
    "reasoning": 0,
    "cache": { "write": 0, "read": 10560 }
  },
  "cost": 0
}
```
- `tokens.input` / `output` / `reasoning` / `cache.read`（缓存读）/ `cache.write`（缓存写）
- `cost` 为 opencode 已计算好的费用
- 模型名取自 `session.model`（如 glm-5.2、gpt-5.5、claude-opus-4-8）

### 4. 写入请求日志表
每条 step-finish 用量写入 `proxy_request_logs`，关键标记：
```sql
request_id  = 'opencode_session:ses_xxx:msg_yyy'
provider_id = '_opencode_session'
data_source = 'opencode_session'
```
代理产生的行为 `data_source='proxy'`、`provider_id` 为真实供应商 —— 二者以此区分。

### 5. 聚合展示
`usage_daily_rollups` 按 `(date, app_type, provider_id, model, request_model, pricing_model)` 聚合成日汇总，用量面板据此出趋势图 / 费用 / 缓存命中率。

## 本机实测证据

| 检查项 | 结果 |
| --- | --- |
| `proxy_config` 是否含 opencode | ❌ 无（只有 claude/codex/gemini/grokbuild） |
| `session_log_sync` 中 opencode 路径 | ✅ `opencode.db` + 2806 条 `opencode.db:ses_xxx` |
| `proxy_request_logs` 中 opencode 行 | 65253 行，全部 `data_source='opencode_session'`、`provider_id='_opencode_session'` |
| `usage_daily_rollups` 中 opencode 汇总 | 63 条日汇总，合计约 2.3 亿 tokens |

## 与 go-rotate 的启示

- opencode 的 Node 插件 hook（`chat.params.tokens` / `event.message.part.usage`）能拿到**更实时、同一份**的 token 数据，无需读库。
- 若 go-rotate 需要展示 token 消耗统计，可在现有 `last_status` hook 基础上顺手累计 token，思路与 CC Switch 的会话导入一致但更轻量。

## 参考文件位置
- 本机数据：`~/.cc-switch/cc-switch.db`、`~/.local/share/opencode/opencode.db`
- 官方源码：`github.com/farion1231/cc-switch`（`src-tauri/src/opencode_config.rs` 含 `get_opencode_db_path()`；`usage_script.rs` 是供应商余额查询，非逐请求 token 追踪）