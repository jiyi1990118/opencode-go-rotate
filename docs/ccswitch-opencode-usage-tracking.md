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

## Claude Code 的读取机制（已本机验证）

Claude Code 走**会话日志导入**（与 opencode 同思路，文件格式不同），本机叠加代理路径。

### 两条路径（本机 `proxy_request_logs` 实测）
- `data_source='proxy'`（114 行）—— 走了本地代理拦截
- `data_source='session_log'`（11 行）—— 会话日志导入

### 会话日志
- 路径：`~/.claude/projects/<项目路径转义>/<session-id>.jsonl`
- 每个 assistant message 行自带 `usage` 字段：
  ```json
  "usage": {
    "input_tokens": 32255,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 73,
    "server_tool_use": { ... }
  },
  "model": "deepseek-v4-pro"
  ```
- 模型名取自每行 `model` 字段（三方供应商如 deepseek-v4-pro 也能读到）。
- 增量同步：`session_log_sync` 记录文件 + `last_line_offset`（行偏移），只追新增行。

### 本机验证证据
| 检查项 | 结果 |
| --- | --- |
| 磁盘 Claude 会话文件 | ✅ `~/.claude/projects/` 21 项目、20 个 jsonl，usage/model 字段真实存在 |
| `session_log_sync` 记录 `.claude/projects/*.jsonl` | ✅ 681 条，含真实行偏移（17/29/16/967/259） |
| `proxy_request_logs` 有 `claude + session_log` | ✅ request_id=`session:msg_xxx`，provider_id=`_session` |
| 模型名对得上 | ✅ DB 里 `deepseek-v4-pro` 与磁盘 jsonl 的 `model` 一致 |
| 用量对得上 | ✅ DB 里 input/output 与磁盘 jsonl 的 `usage` 值一致（32255/73） |

## Codex 的读取机制（已调查）

- 路径：`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<时间戳>-<uuid>.jsonl`
- 读 `type:"message"`、`role:"assistant"`（agent_message 事件）的 `info.total_token_usage`：
  ```json
  "info": {
    "total_token_usage": {
      "input_tokens": 10650,
      "cached_input_tokens": 9856,       // 缓存读
      "cache_write_input_tokens": 0,     // 缓存写
      "output_tokens": 75,
      "reasoning_output_tokens": 0,
      "total_tokens": 10725
    },
    "last_token_usage": { ... }
  }
  ```
- 模型名从 `session_meta` / `model` 字段取。
- 本机 `session_log_sync` 有 `.codex/sessions/**/rollout-*.jsonl`（19 条）；`proxy_request_logs` 有 `codex + proxy`（62 行，因 proxy_config 里 codex 接管开启）。
- 新版本还兼容从 `updates.jsonl` 的 `turn_completed` 事件导入。

## 与 go-rotate 的启示

- opencode 的 Node 插件 hook（`chat.params.tokens` / `event.message.part.usage`）能拿到**更实时、同一份**的 token 数据，无需读库。
- 若 go-rotate 需要展示 token 消耗统计，可在现有 `last_status` hook 基础上顺手累计 token，思路与 CC Switch 的会话导入一致但更轻量。

## 参考文件位置
- 本机数据：`~/.cc-switch/cc-switch.db`、`~/.local/share/opencode/opencode.db`
- 官方源码：`github.com/farion1231/cc-switch`（`src-tauri/src/opencode_config.rs` 含 `get_opencode_db_path()`；`usage_script.rs` 是供应商余额查询，非逐请求 token 追踪）