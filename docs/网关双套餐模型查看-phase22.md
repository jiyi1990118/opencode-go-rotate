# 网关 go + zen 双套餐模型动态查看（Phase 22）

> 2026-08-17。用户需求：Web 管理页面的网关卡片支持 go 与 zen **所有模型**的**动态查看**（此前只显示当前套餐单套餐清单，且网关设 token 时 Web 因缺 Bearer 实际读到 401 空数据）。

## 交付内容

### 1. zen-gateway（gateway.mjs）— 双套餐动态模型表

- 动态表由单一 `ZEN_MODELS_DYNAMIC` 拆为 **`DYNAMIC_GO` / `DYNAMIC_ZEN`** 两张（同一 opencode key 双端点通用，一次拉齐两档）：
  - `refreshDynamicModels()` 并发拉 `https://opencode.ai/zen/go/v1/models` 与 `https://opencode.ai/zen/v1/models`（各 3s 超时，失败仅该档保留上次结果，不影响另一档）。
  - 请求路由判定仍用「当前套餐」动态表（`dynamicFor(ACTIVE_PLAN.id)`，语义与旧表逐字节等价）；`mapModel` / `allModelIds` / `handleModelsRefresh` 同步切换。
- **`GET /api/gateway/models` 返回双套餐明细**（向后兼容：`models` 字段仍为当前套餐合并清单）：
  ```json
  {
    "active": "go|zen",
    "models": [/* 当前套餐 动态∪内置 */],
    "aliases": { ... },
    "plans": {
      "go":  { "id":"go",  "dynamic":[], "builtin":[], "models":[] },
      "zen": { "id":"zen", "dynamic":[], "builtin":[], "models":[] }
    }
  }
  ```
- `POST /v1/models/refresh` 响应扩展 `go` / `zen` 动态数。
- 测试钩子 `__setDynamicModels(list, planId?)`：缺省同设两档（旧语义）；传 `"go"|"zen"` 定向设置。
- 新增导出：`sortedModelUnion` / `dynamicFor` / `DYNAMIC_GO` / `DYNAMIC_ZEN`。

### 2. go-rotate.ts（插件 + Web）

- **修复网关鉴权缺口**：`gatewayAuthHeaders()` 从 `gateway-config.json` 读 token → fetch 18888 附带 Bearer。此前网关设 token 后 Web 服务端所有网关探测（healthz/usage/models）实际 401（fetch 仍 resolve，`running` 误判 true、模型显示 "-"）。
- `gatewayStatus()` 新增第 5 路并行 fetch `GET /api/gateway/models` → `out.gwModels.plans`（新网关）/ 旧网关无 `plans` 时兼容回退 `/v1/models`。
- 新路由：`GET /api/gateway/models`（代理透传）、`POST /api/gateway/models/refresh`（触发网关重拉双套餐模型表）。
- **Web 网关卡片**：详情区改为「Go 订阅」「Zen 免费」两个折叠块，各自显示 `模型数（动态 N · 内置 M）`、当前套餐徽标、动态/内置计数与来源；顶部「刷新模型」按钮一键重拉（toast 反馈 go/zen 动态数）；`模型数 go+zen` 状态格显示两档去重总数。

## 验证

- 插件单测 **142 用例 / 580 expect，138 通过 / 4 失败**（4 失败均为 **pre-existing 待办**，见下「遗留」）；新增 4 条双套餐断言全 PASS（WEB_HTML 渲染 + go/zen 两栏 + 刷新建于 `gw-models-refresh` + 2 路由降级）。
- 网关单测 **222 用例全 PASS**（新增 5 条：plans 双套餐明细 / 差异化动态表互不串扰 / 子对象拷贝 / sortedModelUnion / 定向钩子）。
- `bun build` PASS；渲染后内嵌 JS `node --check` PASS；`node --check gateway.mjs` PASS。
- 副本已同步（`~/.config/opencode/plugins/go-rotate.ts`、`~/.local/share/zen-gateway/gateway.mjs` md5 与开发一致），18888 / 8899 已重启加载新版。
- **真实 E2E**（含鉴权网关）：`18888 /api/gateway/models` → active=zen，go `26`（动态 26）/ zen `62`（动态 62，内置兜底仅 7）；8899 `/api/gateway` → `gwModels.plans` 双档齐全；浏览器网关卡片渲染 Go 订阅（26）/ Zen 免费（62）双折叠块 + 刷新按钮；点「刷新模型」→ toast "模型清单已刷新：go 动态 26 个 / zen 动态 62 个"。真实 `go-keys.json` / `auth.json` md5 **前后逐字节一致**（隔离铁证）。

## 遗留

1. ~~**pre-existing 未收尾（非本 Phase）**~~：**✅ 已由 Phase 23 收尾（2026-08-17）**——网关访问 Key 多 token（sk- 前缀 `tokens[]`）前端从引用已删除 `token-input` 的旧 JS 重构为 `token-list` 多 key UI（生成/设置/逐行删除/清空 + 本会话明文一键复制），4 条旧测试同步 + 新增 `/api/gateway/token` 全链路路由测试；插件单测 **143 用例 628 expect 全 PASS**。
2. 模型刷新失败（网关不可达）时 Web 显示 `{ok:false, error}` 且 toast 提示，不影响其它卡。
3. 上游模型表在 go/zen 间有少量重叠名称（本次 union 72 < 26+62），Web 总数用去重后的 Set 计算，语义正确。