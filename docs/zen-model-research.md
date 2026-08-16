# opencode zen / go 模型导出为供应服务 — 可行性调研报告

> 调研日期：2026-08-16（所有链接当日联网核实）
> 调研目标：把 opencode zen 免费模型（及 go 订阅）导出/包装成 OpenAI 兼容供应服务，供 claude code / codex / cursor 等其它 agent 使用 —— 可行性与现状。
> 结论速览：**技术上完全成熟、官方明确支持「用任何 agent」**；但存在 ToS「仅供自用、不得为第三方利益」的边界红线。个人自用=可行甚至官方推荐；对外转发/转售=违约风险。

---

## 1. opencode zen 是什么（已证实）

**定义**：OpenCode Zen 是 OpenCode 团队自营的模型网关（AI gateway / provider hub），把经过测试、针对 coding agent 基准优化的模型统一到一个 API key 下提供。
- 来源：[opencode.ai/docs/zen](https://opencode.ai/docs/zen)（核实 2026-08-16）
- 官方原文：「OpenCode Zen is a list of tested and verified models provided by the OpenCode team… An AI gateway that gives you access to these models.」
- 官网营销语：「While we suggest you use Zen with OpenCode, you can use Zen with any agent.」见 [opencode.ai/zen](https://opencode.ai/zen)（已经 ANOMALY 团队成员/CEO 在播客背书：「it works with anything else as well. We don't care if you don't use it with OpenCode」— [baseten.co 对 Dax 的访谈](https://www.baseten.co/blog/building-ai-agents-open-code-and-open-source-a-conversation-with-dax)）。

**与 opencode 官方 API 的关系**：是同一家公司（ANOMALY INNOVATIONS, INC.）官方提供的 API，不是第三方逆向。`opencode-go` 是 opencode 内置 provider 名，对应底层就是 `opencode.ai/zen/go/*` 端点。**这不是灰色地带逆向，而是官方公开端点。**

### 1.1 免费模型清单（已证实，官方定价表）
来源：[opencode.ai/docs/zen「Pricing」](https://opencode.ai/docs/zen) + [Docker Docs「Available Models」](https://docs.docker.com/ai/docker-agent/providers/opencode-zen)（核实 2026-08-16）

免费（Input/Output/Cached 全 Free）模型，全部走 OpenAI 兼容 `/v1/chat/completions`：

| 模型 | Model ID | 说明 |
|---|---|---|
| Big Pickle | `big-pickle` | 隐身模型（glm 系），免费 |
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` | DeepSeek 免费档 |
| MiMo-V2.5 Free | `mimo-v2.5-free` | 小米编码模型 |
| Hy3 Free | `hy3-free` | 腾讯模型免费档 |
| Laguna S 2.1 Free | `laguna-s-2.1-free` | 语音/多模态 |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | NVIDIA |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | NVIDIA |

> 注意：免费模型名单**会变**（beta 期「for a limited time」）。Reddit / YouTube 上提到的 `gpt-5-nano`、`minimax-m2.5-free`、`ling-2.6-flash-free`、`nemotron-3-super-free`、`hy3-preview-free` 是**旧列表/社区列表**，与当前官方定价表不完全一致（来源：[reddit.com/r/opencode](https://www.reddit.com/r/opencode/comments/1t5n8dg/what_are_my_free_options)）。**以 `/v1/models` 实时返回为准。**

### 1.2 `hy3` 是什么（已证实）
- **Hy3 是腾讯（Tencent）的模型**。来源：[opencode.ai/data/tencent](https://opencode.ai/data/tencent)（「Explore 2 Tencent models used in OpenCode including Hy3 and Hy3 preview」）。
- 两个 ID：Go 订阅里叫 `hy3`（`opencode-go/hy3`）；Zen 免费档叫 `hy3-free`（`opencode/hy3-free`）。来源：[opencode.ai/docs/go](https://opencode.ai/docs/go) 模型表 + [mastra.ai/models/providers/opencode](https://mastra.ai/models/providers/opencode)（列 `opencode/hy3-free`，上下文 190K）。
- 用法：Go 的 `hy3` 走 `https://opencode.ai/zen/go/v1/chat/completions`；Zen 的 `hy3-free` 走 `https://opencode.ai/zen/v1/chat/completions`。两者都是 OpenAI 兼容。
- **对 go-rotate 的意义**：你现在用 `hy3` 探测是 Go 模型；若想探测/使用「免费 Zen」应改用 `hy3-free`。二者模型不同，别混用。

---

## 2. API 细节（已证实）

### 2.1 端点结构（官方文档「Endpoints」表）
来源：[opencode.ai/docs/zen](https://opencode.ai/docs/zen) + [opencode.ai/docs/go](https://opencode.ai/docs/go)（核实 2026-08-16）

Zen 基础 URL：`https://opencode.ai/zen/v1`；Go 基础 URL：`https://opencode.ai/zen/go/v1`

| 协议族 | 端点 | 适用模型 | AI SDK |
|---|---|---|---|
| OpenAI 兼容 | `/v1/chat/completions` | DeepSeek V4 / MiniMax M2.5-M3 / GLM 5.x / Kimi / Big Pickle / MiMo / Hy3 / 全部免费模型 | `@ai-sdk/openai-compatible` |
| OpenAI Responses | `/v1/responses` | GPT 全系 / Grok 4.x / Grok Build / Muse | `@ai-sdk/openai` |
| Anthropic Messages | `/v1/messages` | Claude 全系 / Qwen3.x / MiniMax M（go）/ Qwen（go） | `@ai-sdk/anthropic` |
| Google SDK | `/v1beta/models/...` | Gemini 3.x | `@ai-sdk/google` |
| 模型列表 | `/v1/models` | 全部 | - |

- **`/v1/models` 存在**：`https://opencode.ai/zen/v1/models` 与 `https://opencode.ai/zen/go/v1/models`，返回完整模型清单+元数据（官方文档「You can fetch the full list of available models and their metadata from」）。**已证实。**
- **完整性**：`/v1/chat/completions` 是标准 OpenAI 兼容（stream SSE / tools / json mode 由官方选择 `@ai-sdk/openai-compatible` 证明）。**多模态**：免费档 `mimo-v2.5` 有 Omni 变体、`laguna-s-2.1` 支持多模态；付费 `qwen3.6-plus` 是**视觉模型**（见 go 端点表 + cocowork-proxy 的 image 路由说明 [github.com/cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy)，它把图片请求自动路由到 `qwen3.6-plus`）。**视觉可用但需选对模型。**
- **鉴权**：`Authorization: Bearer <key>`。key 来自 [opencode.ai/auth](https://opencode.ai/auth) 创建。**同一个 key 同时用于 Zen 和 Go 两端点**（[Docker Docs「The same API key works for both OpenCode Go and OpenCode Zen」](https://docs.docker.com/ai/docker-agent/providers/opencode-zen) + [shravanbhati.com 博客](https://www.shravanbhati.com/blog/run-opencode-zen-and-go-models-with-claude-code-cli)）。
- **curl 探测**：本次调研未持真实 key，未实测。但第三方文档（Docker `curl https://opencode.ai/zen/v1/models`、GPT Breeze 指南 base URL `https://opencode.ai/zen/v1`、openclaw 用 `OPENCODE_API_KEY`）均一致佐证。**本报告未做真实请求，属「多源一致推断」而非「本机实测」。**

---

## 3. 认证方式（已证实）

- **key 来源**：登录 [opencode.ai/auth](https://opencode.ai/auth) → 创建 API key（未开启 billing 也能拿到免费模型 key）。key 形如 `sk-opencode-...`（[shravanbhati.com](https://www.shravanbhati.com/blog/run-opencode-zen-and-go-models-with-claude-code-cli)）。
- **与 go-rotate 的关系**：opencode 把该 key 存在 `~/.local/share/opencode/auth.json` 的 `opencode-go.key`（或 `opencode.key`）里。go-rotate 同步的正是这个 key。**已证实**（见本仓库 AGENTS.md 与 opencode.ai/docs/providers「Credentials stored in ~/.local/share/opencode/auth.json」）。
- **其它 agent 能否直接复用同一个 key？—— 可以，且官方鼓励。** opencode 官方文档明确「no lock-in by allowing you to use it with any other coding agent」，Zen 官网「Use with any agent」。同一 Bearer key 可直接贴到任意 OpenAI 兼容客户端（Codex/Cursor/Docker Agent/OpenClaw/Mastra/GPT Breeze 等均有官方或社区接入）。
- 一个 Go 订阅的 key 同时解锁 Zen 免费模型 + Go 付费模型（同一 key 双端点）。

---

## 4. 条款风险（已证实 ToS 条文 + 社区讨论）

### 4.1 ToS 关键条文
来源：[opencode.ai/legal/terms-of-service](https://opencode.ai/legal/terms-of-service)（Effective date: Mar 6, 2026，核实 2026-08-16）

- **自用限制（最重要）**：「You will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party」。→ **对外提供/转发/转售给第三方 = 违约。**
- **禁止程序化提取**：「automatically or programmatically extracts data or Output」「crawls/scrapes/spiders any page, data, or portion」。→ 批量抓 `/v1/models` + 批量转发做「服务」灰色。
- **禁止与竞品竞争**：「uses Output to develop artificial intelligence models that compete with the Services or any Third Party Models」。
- 违约 → 终止访问（「A violation of any of the foregoing is grounds for termination」）。
- **免费档数据**：「if you are using the Services through an unpaid account, we may use Content to further develop and improve our Services」→ 免费模型可能用你的 prompt 训练。**敏感代码勿用免费档。**

### 4.2 官方立场 vs 社区红线
- **官方营销/访谈明确支持「给其它 agent 用」**（见 §1：CEO「works with anything else」）。**已证实。**
- **但「给其它 agent 用」≠「给第三方转售/代理」**。ToS 的「own internal use, not for third party benefit」是硬边界。**个人把同一 key 配给自己的 claude/codex/cursor = 内部自用，合规；开一个公网网关供别人用 / 收钱 = 违约。**
- **前车之鉴（重要风险信号）**：Anthropic 于 2026-01-09 起封禁第三方工具用 Claude OAuth，OpenCode 随后移除 Claude Pro/Max OAuth 支持（[shareuhack.com 综述](https://www.shareuhack.com/en/posts/opencode-anthropic-legal-controversy-2026)、[morphllm.com](https://www.morphllm.com/comparisons/opencode-vs-claude-code)、[HN 讨论](https://news.ycombinator.com/item?id=46549823)）。**教训：上游模型厂（尤其 Claude）会突然收紧条款并封号。** 若你的网关把 zen 里的 Claude 模型转给其它 agent，最可能被 Anthropic 盯上；免费/开源系模型（grok/deepseek/minimax/qwen/hy3）相对安全。
- 无公开社区讨论「zen 官方封代理」——因为官方本来就支持直接 API 用，无需代理；社区代理项目（见 §5）多为协议转换（Anthropic↔OpenAI），不是「绕过封禁」。

---

## 5. 现有开源方案（已证实，2026-08-16 用 GitHub API 核实 star/活跃度）

| 仓库 | Star | 语言/形态 | 核心做法 |
|---|---|---|---|
| [routatic/proxy](https://github.com/routatic/proxy)（原名 oc-go-cc） | **945** | Go CLI 本地代理 | Claude Code ↔ OpenCode Go / Zen / AWS Bedrock；自动模型选择 + 协议转换（Anthropic↔OpenAI/Responses/Gemini）；**最成熟、最活跃** |
| [samueltuyizere/oc-go-cc](https://github.com/samueltuyizere/oc-go-cc) | 945 | Go 本地 HTTP (port 3456) | 同上（routatic/proxy 的前身，现为兼容别名） |
| [Alishahryar1/free-claude-code](https://github.com/alishahryar1/free-claude-code) | 高人气（YouTube 广泛） | 多 agent 调度器(FCC) | 让 Claude Code/Codex/Pi 用免费/付费/本地模型；内建 opencode_zen/opencode_go 前缀接入 + 配额探测 + 模型映射；**含多 key/配额逻辑，与 go-rotate 目标最接近** |
| [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy) | 48 | Cloudflare Worker | Claude↔OpenCode，Anthropic↔OpenAI 互译；图片自动路由 qwen3.6-plus；`/zen` 与 `/go` 双路由 |
| [Itsme23476/claude-zen](https://github.com/Itsme23476/claude-zen) | 8 | Node 本地代理 | 直接把 `ANTHROPIC_BASE_URL` 指向 zen `/v1/messages` 会坏 tool schema（缺 `function.name`），所以用 `/v1/chat/completions` 转 Anthropic 协议 |
| [Ishanoshada/Claude-Zen-Proxy](https://github.com/Ishanoshada/Claude-Zen-Proxy) | 2 | Node | Claude Code ← MiMo2.5/DeepSeekV4/Nemotron3 |
| [KoLDXr00T/cc-with-oc-zen](https://github.com/KoLDXr00T/cc-with-oc-zen) | 指南 | 无代理 | 直接改 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` = `https://opencode.ai/zen/v1`（仅 Anthropic 兼容模型） |
| GOST 官方 LLM 博客 | - | 反向代理 | 教你用 GOST 把 `/v1/messages`、`/v1/responses` 重写为 `/zen/go/v1/chat/completions` + openai-converter 做协议转换（[gost.run](https://gost.run/en/blog/category/llm)） |

**结论**：这条路**已有大量成熟实现**，且 star 最高/最活跃的 `routatic/proxy`（945★）与你的 go-rotate 高度互补（它做协议转换+模型选择，你已有的 go-rotate 做多 key 轮换）。**不用从零造轮子。**

---

## 6. 模型清单汇总（已证实）

- **Zen 付费**（`/v1/chat/completions` + `/v1/responses` + `/v1/messages` + `/v1beta`）：GPT 5.x 全系、Claude 4.5-5 全系、Gemini 3.x、Grok 4.5/4.6、Qwen3.5-3.7、DeepSeek V4、MiniMax M2.5/M2.7/M3、GLM 5/5.1/5.2、Kimi K2.5-K3、Muse 等（完整见 [opencode.ai/docs/zen](https://opencode.ai/docs/zen)）。
- **Go 订阅（$10/月）**：Grok 4.5、GLM-5.3/5.2/5.1、GPT 5.6 Luna、Kimi K3/K2.7/K2.6、MiMo-V2.5(/Pro)、MiniMax M3/M2.7、Qwen3.8/3.7 Max/3.7Plus/3.6Plus、DeepSeek V4 Pro/Flash、**Hy3**（[opencode.ai/docs/go](https://opencode.ai/docs/go)）。
- **免费模型**：见 §1.1 的 7 个。
- **上下文窗口**：举例 `kimi-k3` 1.0M、`nemotron-3-ultra-free` 1.0M、`hy3-free` 190K、`minimax-m2.5` 205K（[mastra.ai/models/providers/opencode](https://mastra.ai/models/providers/opencode)）。

---

## 7. 替代路径：官方是否提供独立 key / baseURL 供第三方？（已证实）

**是，官方原生支持。** 不需要任何代理/包装：
- 只要在 [opencode.ai/auth](https://opencode.ai/auth) 建一个 API key，任何 OpenAI 兼容客户端把 baseURL 设成 `https://opencode.ai/zen/v1`（Zen）或 `https://opencode.ai/zen/go/v1`（Go），model id 填 `hy3-free` / `gpt-5.6-luna` 等即可。
- 官方文档「Model ID format: `opencode/<model-id>`（Zen）/ `opencode-go/<model-id>`（Go）」，即内部 provider 前缀，**外部使用时去掉前缀直接填裸 model id**。
- 它就是「OpenRouter 式」的官方网关，天然是给第三方 agent 用的。**已证实。**

---

## 8. 结论与建议

### 可行性评估
- **技术可行性：极高（成熟）**。官方公开端点 + 官方明确支持任何 agent + 大量现成代理/接入。**不是逆向、不是脆弱 hack。**
- **合规可行性：个人自用 = 官方推荐；对外服务/转售 = 违约。** 这是唯一真正的阻碍。

### 推荐技术路线（分场景）

**场景 A：只给自己多个 agent 用（推荐，最稳）**
- **直接复用 key，零代理。** 每个 agent 配 baseURL + model id 即可：
  - Codex / Cursor / 任意 OpenAI 兼容：`baseURL=https://opencode.ai/zen/go/v1`，model `hy3` / `deepseek-v4-flash` / `kimi-k3`。
  - 免费模型：`baseURL=https://opencode.ai/zen/v1`，model `hy3-free`。
  - 免费模型 Vanilla：`baseURL=https://opencode.ai/zen/v1`，model `hy3-free`。
  - Claude Code：`ANTHROPIC_BASE_URL=https://opencode.ai/zen/v1`（仅 Anthropic 兼容模型如 miniMax M3 / Qwen），或用 `routatic/proxy` 做协议转换以兼容更多模型。
- **若想多个 key 轮换**：把 go-rotate 的方向从「注入到 opencode 会话」扩展为「本地 OpenAI 兼容网关 + 多 key 轮换 + 模型映射转发到 `opencode.ai/zen/go/v1`」。**参考 `routatic/proxy`（945★）与 `free-claude-code`，不必自研协议层。**

**场景 B：对外提供/转售（不推荐，违约）**
- 违反 ToS「own internal use, not for third party benefit」+「no programmatic extraction」。有封号风险（参考 Anthropic 封 OpenCode 前例）。**不建议。**

### 风险提示
1. **ToS 红线**：内部自用 OK；第三方利益/转售 = 违约，可被终止访问。
2. **上游模型厂收紧**：zen 里的 **Claude** 模型最可能被 Anthropic 盯上（已有前例）；免费/开源系（grok/deepseek/minimax/qwen/hy3）风险低。
3. **免费档数据**：免费模型可能用你的 prompt 训练（ToS「unpaid account may use Content」），敏感代码勿用免费档，用付费 zen 或 Go。
4. **模型名映射易错**：同模型在 Zen 与 Go 是**不同 ID**（`hy3` vs `hy3-free`）；外部 agent 用裸 ID、去掉 `opencode/` 前缀；端点按协议选（chat-completions / responses / messages / google）。
5. **免费名单会变**：以 `/v1/models` 实时返回为准，别硬编码。
6. **限流/配额**：Go 有 5h/weekly/monthly 美元上限（超限会 429/block），多 agent 共享同一 key 会更快打满——**这正是 go-rotate 多 key 轮换的价值点**。

---

## 附：对本仓库 go-rotate 的直接启示
- 你现在探测用 `hy3`（Go 模型）。若想覆盖「免费 Zen」，应加 `hy3-free` 作为探测目标之一。
- 你的插件按 `providerID.includes("opencode")` 匹配 —— 对 `opencode`（Zen）与 `opencode-go`（Go）都生效，正确。
- 扩展方向（若做「导出网关」）：维护一份「外部 agent model id → 上游端点 (chat/responses/messages)」映射表 + 多 key 轮换 + 协议转换，可直接复用 `routatic/proxy` 的协议层思路；**对外只做自用不做转售。**