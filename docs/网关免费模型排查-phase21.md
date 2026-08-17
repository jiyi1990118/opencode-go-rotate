# 网关 free 模型排查与修复（Phase 21，2026-08-17）

## 现象
- 用户 TUI 用 `opencode/deepseek-v4-flash-free`（zen 免费档）正常可用
- 经网关（127.0.0.1:18888，plan=zen）请求 `gpt-4o-mini` 得到 `CreditsError: Insufficient balance`，且自动轮换把 3 个 key 全部标 `last_status=nobalance` + 网关域冷却

## 排查（3 个专业 team 并行，全部只读）
- **Team A（协议实测）**：`hy3-free`/未知名模型 → 200 + content"OK"（cost 0）；`deepseek-v4-flash-free` → 429 限流（free 但限流）；`gpt-4o-mini` → 401 CreditsError；`/v1/responses`（codex 协议）+ hy3-free → 200 completed。协议链路本身无问题
- **Team B（TUI vs 网关对照）**：两条路径端点/鉴权/透传一致；**唯一根因差异 = 模型名**——TUI 用 free 名，网关 `mapModel` 别名表把 `gpt-4o-mini` 硬映射到付费 `deepseek-v4-flash`（别名表无套餐感知），免费 endpoint 对付费模型计费拒绝。key 域差异（current_gateway vs current）非根因（3 key 全 nobalance 而 TUI 用 free 成功）
- **Team C（错误分类审计）**：`CreditsError → nobalance` 分类准确但**应用错维度**（轮换解决不了「免费档×付费模型」错配）；3 key 网关冷却属误伤；TUI/zen 域完全不受影响（域独立 + 网关绝不写 auth.json 已核实）；恢复顺序 = **先治根再清冷却**（否则 5 秒内重新被污染）

## 修复（最小改动，gateway.mjs `mapModel`）
```js
const alias = MODEL_ALIAASES[r]
if (alias) {
  // 别名目标必须属于当前套餐内置表；否则（如 zen 免费档命中付费别名）回退套餐默认
  if (ACTIVE_PLAN.builtinModels.includes(alias)) return alias
  return ACTIVE_PLAN.defaultModel
}
```
- zen 档：`gpt-4o-mini`/`gpt-4o`/`grok-code`（→hy3 付费）等一律回退 `hy3-free`，不再发出付费模型
- go 档：`deepseek-v4-flash ∈ 内置表`，别名行为不变（零影响）
- 顺带收益：不再有「付费别名点名 → 401 → 无效轮换 churn」

## 验证（真实环境）
| 项 | 结果 |
|---|---|
| gateway 单测 | 171→**173 用例** ALL PASS（新增 zen 档回退 6 断言 + go 档不受影响 3 断言） |
| node --check | PASS |
| 副本同步 + restart | md5 一致 `e090f23e…`，healthz OK（rotations 归零=新进程） |
| 清误伤冷却 | `gateway cooldown <3key> clear` ×3 → available 0→**3** |
| 复测 ① `gpt-4o-mini` | **200**，`model: hy3-free`，content "OK"（修复前 401 CreditsError） |
| 复测 ② `hy3-free` | 200，content "OK" |
| 复测 ③ 未知名 | 200 → 默认 hy3-free，content "OK" |

## 结论
**网关调用 opencode zen 的方式本身正确**（端点/鉴权/协议/透传全链路核实无误），失败根因是**别名映射把付费模型名发往免费档**。修复后网关对 free 模型与付费别名降级全部正常。用户 TUI 与网关现在行为一致。

## 遗留（非阻塞）
- `deepseek-v4-flash-free` 触发上游 429 FreeUsageLimit（免费档限流，非错误）；`hy3-free` 是推理模型，`max_tokens` 过小（<30）时 content 可能为空（reasoning 占满），建议客户端给足 max_tokens
- 3 key 的 `last_status=nobalance` 展示残留（网关无独立 `last_status_gateway` 槽位，写的是 zen 域 `last_status`）——重探（`go-rotate check --plan zen`）或下轮修复覆盖
- Team C 建议的「独立 last_status_gateway 槽位」「同形错误高频轮换熔断」为可选增强，暂不做（避免过度工程）