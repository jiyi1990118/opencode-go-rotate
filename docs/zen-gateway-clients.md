# 三大客户端接入 zen-gateway 实测指南

> 编写日期：2026-08-16
> 目标：claude code / codex / cursor 直接接入本地 zen-gateway（`http://127.0.0.1:18888/v1`），复用 opencode zen（Go 档）免费模型 + go-rotate 多 key 自动轮换。
> 实测状态：网关本体已实测（非流式 `OK` / 流式 SSE / 模型别名 / 鉴权 / Anthropic `/v1/messages` / Responses `/v1/responses` 均通过）；**codex CLI 已实测直连通过**（见 §2）；**cursor 本机未安装**，详见各节「实测状态」。
> ⚠️ 前置：先 `cd zen-gateway && node gateway.mjs` 起网关，`curl http://127.0.0.1:18888/healthz` 应返回 `{"ok":true,...}`。

---

## 0. 网关能力速览（决定每个客户端怎么接）

- **协议**：实现 **OpenAI `/v1/chat/completions`**、**Anthropic `/v1/messages`**、**OpenAI Responses `/v1/responses`**（+ `/v1/models`、`/healthz`）。三大主流协议全覆盖。
- **鉴权**：默认只有 `127.0.0.1` 监听、无 token。设 `ZEN_GATEWAY_TOKEN` 后需 `Authorization: Bearer <token>`。
- **模型**：3 类 → 真实 zen 模型：`hy3`/`deepseek-v4-flash` 等原生；`gpt-4o→glm-5.2`、`grok-code→hy3` 等别名；未知 → 默认 `hy3`（可用 `ZEN_DEFAULT_MODEL` 覆盖）。
- **关键推论**：
  - ✅ 会说 **OpenAI Chat Completions** 的客户端 → 直接可用。
  - ✅ 会说 **Responses API** 的客户端（最新 codex、cursor 的 GPT-5 系模型）→ 走网关 `/v1/responses`（或 `/v1/chat/completions` 自动识别 `input`），已实测可用。
  - ✅ 会说 **Anthropic Messages** 的客户端（claude code）→ 走网关 `/v1/messages`，已实测可用（claude code 直连见 §1）。

| 客户端 | 协议 | 能否直连当前网关 | 实测状态 |
|---|---|---|---|
| claude code | Anthropic Messages | ✅ `/v1/messages` | 端点已实测（非流式/流式/tools/边界全 PASS）；claude code 直连见 §1 |
| codex CLI | OpenAI / Responses（2026 起仅 Responses） | ✅ `/v1/responses` | 端点 + codex CLI 直连均已实测（见 §2，需 `web_search = "disabled"`） |
| cursor | OpenAI Chat / Responses（按模型） | ✅ 自动检测 | GPT-5 系自动走 Responses 分支；cursor 本机未装 |

---

## 1. claude code（协议需 Anthropic，当前不直连）

### 实测状态（本机）
`claude` 已装（v2.1.202）。网关的 Anthropic `/v1/messages` 端点已落地并实测全 PASS（非流式/流式 7 事件/tools 分片/max_tokens 边界/401 轮换）。claude code 直连配置如下。

### 配置方式
claude code 用 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（→ `Authorization: Bearer`）或 `ANTHROPIC_API_KEY`（→ `x-api-key`），写 `~/.claude/settings.json` 的 `env` 块：
```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18888",
    "ANTHROPIC_AUTH_TOKEN": "<若网关设了 ZEN_GATEWAY_TOKEN 则填，否则去掉>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "hy3",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash"
  }
}
```
实测验证：`claude -p "Reply with OK"`（来源：code.claude.com/docs/en/env-vars，核实 2026-08-16）。

### ⚠️ 常见坑
1. **`ANTHROPIC_AUTH_TOKEN` 劫持**：只要它存在，claude code 优先用它直连上游、**忽略 `ANTHROPIC_BASE_URL`**。切网关前必须 `unset ANTHROPIC_AUTH_TOKEN`（或用 `ANTHROPIC_API_KEY` 走 x-api-key）。本机 `~/.claude/settings.json` 里就有 `"ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED"`，**不删掉它网关配置会形同虚设**。
2. **`/v1/messages` 的 tool schema 坑**：直接用 zen 官方 `/v1/messages` 会缺 `function.name` 导致工具调用坏（社区 claude-zen 项目已踩坑，见 zen-model-research.md §5）。网关的 Anthropic 端点需正确转发 tool schema。
3. **鉴权 header 差异**：claude 默认发 `x-api-key`；网关 `gatewayAuth` 只读 `Authorization`。若网关用 token 鉴权，claude 必须设 `ANTHROPIC_AUTH_TOKEN`（Bearer）而非 `ANTHROPIC_API_KEY`。

---

## 2. codex CLI（Responses-only）

### 实测状态（本机）✅ 已实测（2026-08-16）
codex CLI **已安装并实测直连通过**：`npm install -g @openai/codex` → **codex-cli 0.147.0**（路径 `~/.nvm/versions/node/v24.14.1/bin/codex`）。实测矩阵全 PASS（见下）。本机 `~/.codex/config.toml` 指向别的新 API 代理（`newapi@127.0.0.1:15721`），**未改动**——用 `CODEX_HOME` 环境变量隔离到临时目录验证。

### 💡 关键：如何隔离用户真实配置（不碰 `~/.codex/config.toml`）
codex 支持 `CODEX_HOME` 环境变量指向替代配置目录（`codex doctor` 会显示 `config.toml` / `auth.json` 均从该目录加载）。**临时目录造最小 config，绝不改用户真实配置**：
```bash
mkdir -p /tmp/codex-zen && cat > /tmp/codex-zen/config.toml <<'EOF'
model_provider = "zen"
model = "hy3"
web_search = "disabled"            # ← 必须！否则 codex 会发 web_search 工具触发网关 400 bug（见坑 5）
[model_providers.zen]
name = "zen-gateway"
base_url = "http://127.0.0.1:18888/v1"
wire_api = "responses"
requires_openai_auth = false
EOF
CODEX_HOME=/tmp/codex-zen codex exec --skip-git-repo-check "Reply with exactly OK"
# 验证隔离已生效：CODEX_HOME=/tmp/codex-zen codex doctor → 看 config.toml 路径与 auth 均为 /private/tmp/codex-zen/...
```

### 实测矩阵（命令 → 输出 → 耗时 → 网关日志证据）
| 命令 | 输出 | 耗时 | 网关证据 |
|---|---|---|---|
| `codex exec --skip-git-repo-check "Reply with exactly OK"`（默认 hy3） | `OK`（exit 0） | ~15.6s | `POST /v1/responses` → usage.jsonl `ok:true model:hy3 endpoint:responses` |
| `codex exec --skip-git-repo-check -m gpt-5 "Reply with exactly OK"`（别名覆盖） | `OK`（exit 0） | ~20.9s | `POST /v1/responses` → usage.jsonl `ok:true model:hy3`（gpt-5 别名已映射到 hy3） |

> 功耗说明：`hy3` 是推理模型，`codex exec` 每次会先输出大段 reasoning（skills/permissions 指令 + 推理），首次调用含 models_cache 拉取，故耗时 ~15-20s。`tokens used 7,584`。

### 配置方式（新版 codex，Responses wire_api）
`~/.codex/config.toml`（用户真实配置，若要接入网关直接改这里）：
```toml
model_provider = "zen"
model = "hy3"
web_search = "disabled"            # ← 必须！见坑 5

[model_providers.zen]
name = "zen-gateway"
base_url = "http://127.0.0.1:18888/v1"
env_key = "ZEN_GATEWAY_TOKEN"          # 网关无 token 时可不设；设了则配
wire_api = "responses"                  # 新版 codex（2026 起）仅支持 responses
```
实测验证：`codex exec --skip-git-repo-check "Reply with exactly OK"`（`codex exec` 非交互调用，`--skip-git-repo-check` 用于非受信目录；在受信 git 目录可省略）。

### ⚠️ 常见坑
1. **`wire_api` 版本差异（最坑）**：新版 codex 只认 `responses`——网关已支持 `/v1/responses`，`wire_api = "responses"` 即可直连。若你的 codex 仍是旧版支持 chat，`wire_api = "chat"` 同样可用（网关两个端点都有）。
2. **`base_url` 结尾**：以 `/v1` 结尾、无尾斜杠（`http://127.0.0.1:18888/v1`），codex 会拼 `/responses`。
3. **鉴权**：codex 用 `env_key` 指向的环境变量作为 Bearer token。网关无 token 时用 `requires_openai_auth = false` 或不设 env_key；有 token 时设 `env_key = "ZEN_GATEWAY_TOKEN"`。
4. **模型名**：填 `hy3` / `deepseek-v4-flash` 会原样透传；填 `gpt-5` 等会走别名映射。别指望 `gpt-*` 就是 GPT——全被映射到 zen 模型。
5. **🚨 web_search 工具触发网关 400 bug（实测发现，必须 `web_search = "disabled"`）**：codex CLI（0.147.0）默认会向 `/v1/responses` 发一个 `{"type":"web_search","external_web_access":false}` 工具（无 `name` 字段）。网关 `responsesToOpenAI()` 的 tools 映射 `fn.name || t.name || ""` 把它转成 **空名 function**，zen 上游返回 400 → codex 报 `Error from provider (Console Go): Upstream request failed: [400]`。**规避**：config.toml 顶层加 `web_search = "disabled"`（WebSearchMode 枚举）即可去掉该工具、直连成功。**修复建议**（主线程）：`responsesToOpenAI` 对 `type != "function"` 的工具（web_search / namespace）应跳过或给合法名，勿透传空名。

---

## 3. cursor（OpenAI Chat Completions，GPT-5 系模型有 Responses 坑）

### 实测状态（本机）
cursor **未安装**（`/Applications/Cursor.app` 不存在）。**未实测。** 配置方式基于官方/社区文档（来源：ofox.ai、claudeapi.com、forum.cursor.com，核实 2026-08-16）。

### 配置方式（GUI，无需改文件）
1. Cursor **Settings → Models**。
2. 在「Overrides」区，打开 **Override OpenAI Base URL**，填 `http://127.0.0.1:18888/v1`（必须含 `/v1`，cursor 会拼 `/chat/completions`）。
3. **OpenAI API Key** 填 `<若网关设了 ZEN_GATEWAY_TOKEN 则填，否则随便填>`。
4. 点 **+ Add Model**，填 `hy3`（或 `deepseek-v4-flash`）。
5. 选中该模型，发一条消息验证。

### ⚠️ 常见坑（cursor 特有，最重要）
1. **GPT-5 系模型走 Responses 路径（已知 bug）**：cursor 官方论坛两个置顶帖（forum.cursor.com #153019 / #159298）确认：用「Override OpenAI Base URL」+ GPT-5 系模型（含 o3/o4/gpt-4*）时，**cursor 会把 Responses 形状的 body（`input` 字段而非 `messages`）发到 `/chat/completions`** → 网关 `bodyObj.messages` 为 undefined → 上游 400「Missing required parameter: messages」。**规避：模型名别填 gpt-5/gpt-4 等，填 `hy3`/`deepseek-v4-flash`/`glm-5.2` 等 Chat Completions 路径模型。**
2. **`base_url` 必须带 `/v1`**：漏掉会拼出 `.../chat/completions` 404（claudeapi.com 决策表：OpenAI 兼容含 `/v1`，Anthropic 不含）。
3. **模型名未知 → 默认 hy3**：cursor 填任意模型名都能通，但会被映射。想用非推理模型就填具体 zen 模型名。
4. **Agent 模式的工具 payload**：cursor Agent 模式可能带 Responses 风格 tool（`type:"custom"`），即使走 chat 端点也可能被上游拒。遇到就先在 Chat 模式验证，别一上来用 Agent。

---

## 4. 通用：curl 裸测网关（先于任何客户端）

任何客户端接不上时，先用 curl 验证网关本身：
```bash
# 非流式
curl -s http://127.0.0.1:18888/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"hy3","messages":[{"role":"user","content":"Reply with OK"}],"max_tokens":200}'
# 流式
curl -sN http://127.0.0.1:18888/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}],"max_tokens":100,"stream":true}'
# 带网关 token
curl -s http://127.0.0.1:18888/healthz -H "Authorization: Bearer <token>"
```
> 本指南实测：非流式返回 `content="OK"`；流式 `gpt-4o`（→glm-5.2）SSE 逐块透传。✅

---

## 5. 合规提醒（源自 docs/zen-model-research.md）

### 5.1 个人自用 vs 转售边界（遵守 ToS）
- opencode ToS（Effective 2026-03-06）：「You will only use the Services for **your own internal use, and not on behalf of or for the benefit of any third party**」。→ **把网关配给自己本机的 claude/codex/cursor = 内部自用，合规**；**开公网网关/收钱/供第三方 = 违约，可能终止访问**。
- 仅绑定 `127.0.0.1` 是合规的安全边界；`ZEN_GATEWAY_HOST=0.0.0.0` 对外开放会让网关变成"为第三方利益"的分享服务，**风险自担**。
- 参考前车之鉴：Anthropic 2026-01 封禁第三方工具用 Claude OAuth，OpenCode 移除 Claude Pro/Max OAuth。zen 里的 **Claude 模型**最可能被上游盯上；免费/开源系（grok/deepseek/minimax/qwen/hy3）风险低。

### 5.2 多 agent 共享同一 key 的配额提示
- **同一个 opencode key 同时用于 Zen 免费档 + Go 档**；Go 订阅有 5h/weekly/monthly 美元**硬上限**，超限 429/block。
- 多个 agent（claude/codex/cursor + opencode 本身）共享同一 key 会**更快打满配额**——这正是网关复用 go-rotate 多 key 轮换的价值。
- 网关 `healthz` 可看 `keys`/`available`；`go-rotate status` 看每 key 冷却状态。

### 5.3 `ZEN_DEFAULT_MODEL` 选择
- 默认 `hy3` 是**推理模型**：先消耗大量 token 输出 reasoning，`max_tokens` 不足时返回 `content:null`（实测）。**agentic/工具密集场景**（cursor Agent、codex、长会话）建议：
  ```bash
  ZEN_DEFAULT_MODEL=deepseek-v4-flash node gateway.mjs   # 快、非推理、够用
  # 或 ZEN_DEFAULT_MODEL=glm-5.2
  ```
- 免费档敏感数据警告：ToS「unpaid account may use Content to improve services」→ **免费档别放敏感代码**；用付费 zen/Go 档。

### 5.4 模型名映射误区
- Go 模型 `hy3` ≠ 免费档 `hy3-free`（不同 ID、不同端点）。外部 agent 填裸 ID、去掉 `opencode/` 前缀。
- 免费名单会变，以网关 `/v1/models` 实时返回为准。

---

## 附：快捷决策表

| 场景 | 推荐配置 | 可实现 |
|---|---|---|
| 想立刻用网关跑通 | curl 裸测 / cursor（非 GPT-5 模型） | ✅ 已实测网关 |
| cursor 用 GPT-5 系 | ✅ `/v1/responses` + chat/completions 自动检测 | ✅ 端点已实测 |
| codex CLI | ✅ 新版 Responses wire_api → `/v1/responses` | ✅ 端点已实测 |
| claude code | ✅ Anthropic 协议 → `/v1/messages` | ✅ 端点已实测 |
| 多 agent 共享 | 确认只绑 127.0.0.1 + 设 `ZEN_GATEWAY_TOKEN` | ✅ |
| 避免推理开销 | `ZEN_DEFAULT_MODEL=deepseek-v4-flash` | ✅ |