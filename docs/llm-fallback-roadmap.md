# dsh-llm-fallback 策略演进路线图

> 状态：**提案，未排期**（盘点日期 2026-10-16）。本文档是策略维度的决策底稿：
> §3 每个维度的勾选与 §5 待决策点的勾选即为立项动作，勾选后走正常开发流程
> （`feat/*` 分支 → 门禁链 → changeset → 合入 `dev`）。
> 维护约定：市场快照（§2）仅在重新调研时更新日期；§3 的机制依托只写函数/机制名、
> 不写行号，避免实现漂移导致文档失真。

## 1. 背景与定位

### 1.1 现有能力

dsh-llm-fallback 当前是「失败驱动的候选队列回退」插件：

- 监听 loop 级 `agent/request` 与 `agent/request-error` waterfall；
- 会话指定模型失败后按 `fallbackChains` 纯回退队列切换；`retriesBeforeSwitch`
  控制每候选切换前的同 provider 重试预算（`0` = 跟随官方 `dsh-llm-retry` 预算）；
- 失败候选进入冷却表（`provider/model → 到期时间戳`），冷却跳过复用
  `firstAvailableCandidateIndex` / `nextCandidate` 扫描，全冷却时降级回原顺序；
- 轨迹复用官方 `llm/retry` / `llm/retry-started` 已知事件类型
  （`policyKey: llm-fallback` 可辨识，format v4 读侧安全）。

### 1.2 拦截层能力边界（可行性判据）

| 数据面                        | 插件可见 / 可写                                                               | 对策略选择的意义                    |
| ----------------------------- | ----------------------------------------------------------------------------- | ----------------------------------- |
| `agent/request` payload       | `turn` / `step` / `signal`                                                    | 步级定位                            |
| proposedConfig                | `provider` / `model` 可改写；`reasoningEffort` / `maxTokens` 随对象保留       | 一切「换目标 / 调参数」类策略的入口 |
| `agent/request-error` payload | `provider` / `failure`（失败码）/ `retryPolicy` / `agent`（session，写轨迹）  | 重试预算与失败分类策略的入口        |
| `llm/stream`                  | 仅允许在适配器流上**叠加监听**，不可改 options                                | 观测 usage / TTFT 可用，改写不可用  |
| 模型目录                      | 宿主侧插件不可直接取（设置卡 client 经 `remote.session.modelCatalog()` 获取） | 「目录自动发现」类策略需新增数据面  |
| 运行状态                      | 纯进程内存                                                                    | 重启即清零；持久化是独立维度        |

### 1.3 与 LiteLLM Router 的对照

llm-fallback 与 LiteLLM 无代码或协议关系，可理解为 dsh 宿主内的「迷你 Router」，
功能上是 LiteLLM Router 的子集（失败回退 + 每候选重试 + 失败冷却三件）。
层差异：LiteLLM 是独立 HTTP 网关服务，llm-fallback 运行在 agent loop 内。

关键宿主事实（host 包 README 核实）：两种官方 DeepSeek 接入在 waterfall 中是
两个不同 provider id——桌面端账号登录为 `deepseek-account`（`dsh-llm-deepseek-account`），
API Key 提供商为 `deepseek-official`（`dsh-llm-deepseek-api-key`）。
**账号 token 有来源校验、只能发往 DeepSeek 官方源，网关方案（LiteLLM / new-api）
覆盖不了账号登录方式——宿主内插件是限制账号使用的唯一拦截点。**

## 2. 市场调研结论（2026-10-16 快照）

结论：**dsh 生态无现成的时段限制插件；「按时钟时段切换 / 禁用模型」这一功能
模式在其他 agent 生态已被第三方实现过，可直接借鉴其配置形态与交互。**

| 生态              | 有无时段限制 / 切换        | 最接近的实现                                                                   |
| ----------------- | -------------------------- | ------------------------------------------------------------------------------ |
| dsh 官方插件      | 无（宿主包清单无此类功能） | —                                                                              |
| Hermes Agent      | 有，第三方插件             | `time-model-router`（peak / off-peak 双模型 + 多段窗口 + 跨夜区间 + 状态指示） |
| Claude Code       | 理念相近，机制不同         | `ccblocks`（定时触发挪动订阅 5 小时窗口）                                      |
| LiteLLM 网关      | 无（仅计费感知）           | `off_peak_pricing`（错峰成本核算，不禁用）；cooldown 为失败驱动                |
| OpenRouter        | 无（按负载不按时钟）       | 延迟感知软路由（p90 滚动窗口，应对高峰拥堵）                                   |
| one-api / new-api | 无                         | 分时段倍率计费                                                                 |

## 3. 策略维度清单

> ☐ = 候选未立项；勾选即视为采纳并进入 §4 排期。可行性判据见 §1.2。

### 第一档：拦截层数据现成（近期可做）

- [x] **时间窗切换 / 错峰优先**——高峰期把 DeepSeek 候选（`deepseek-account` /
      `deepseek-official`）视为「冷却中」自动切走；错峰窗口（官方半价 00:30–08:30 北京时间）
      可反向「优先用 deepseek」。先例：Hermes `time-model-router`。机制依托：冷却表 +
      冷却跳过扫描——时间窗即「预填冷却表」，窗口结束惰性过期自动恢复优先级。
      （✅ 0.6.0 时段计划 v2 实装，2026-10-21；v1 ee533db 曾实装后整体 revert
      （d4aef59，时机/流程原因，机制本身无问题），v2 收敛为预填冷却表机制重做）
- [ ] **参数适配**——切换候选时连带调整 `reasoningEffort` / `maxTokens`
      （弱模型配高推理档常白烧 token）。先例：无直接对照，dsh 特有机会
      （proposedConfig 字段可写）。机制依托：链条项加 per-candidate 覆盖字段。
- [ ] **熔断升级**——连续失败时冷却时长指数递增 + 半开试探。先例：LiteLLM
      `cooldown_time` / `allowed_fails_policy`。机制依托：`markCooldown` 的窗口计算参数化。
- [ ] **限流对齐**——`RATE_LIMIT` 失败时读 retry-after / 响应体，冷却到期时间
      对齐服务端要求而非固定值。先例：LiteLLM retry policy。
      数据面：需先验证 `LlmFailure` 是否携带响应细节。
- [ ] **会话粘性**——同会话已验证可用的候选，后续 step 不回会话指定模型重新验证
      （省首字延迟与失败成本）。先例：LiteLLM session affinity。
      风险：与「新 step 从会话指定模型重启」的基准语义需做开关兼容。

### 第二档：需打通 stream 层采集（中期）

- [ ] **成本路由**——多候选可用时选便宜的；预算烧完自动降级到廉价 / 免费候选。
      先例：LiteLLM Budget Routing / cost-based-routing。数据面：需在 `llm/stream`
      叠加监听采集 usage，或调研宿主 `dsh-token-meter` 是否对插件暴露数据（未验证）。
- [ ] **用量自限速**——对单 provider 做 RPM / 并发自限，主动摊开请求避免撞上游 429。
      先例：LiteLLM rpm / tpm limits。机制：请求时间戳纯内存可算。
- [ ] **健康度路由**——按 EMA 成功率 / TTFT 排序候选（最低延迟优先）。
      先例：LiteLLM lowest-latency-routing、OpenRouter p90 软排序。
      数据面：TTFT 从 stream 层测，成功率从 error 事件累计。

### 第三档：改变插件形态（远期）

- [ ] **状态持久化**——冷却 / 健康 / 用量表落盘，宿主重启不丢（现为纯内存）。
      代价：引入存储职责，破坏「纯内存无状态」的简单性。
- [ ] **模型目录自动发现**——从宿主模型目录自动生成候选链（现为手配）。
      代价：目录在 client 侧，需新增宿主数据面。
- [ ] **任务分型路由**——交互请求走强模型、后台批量走廉价模型，批量任务延迟到
      错峰执行。阻塞点：loop 层不知道请求「用途」，需宿主侧元数据支持（可能要向上游提需求）。
      先例：自建错峰调度网关的 overnight 优先级队列（见 §6）。
- [ ] **角色分派链**——`fallbackChains.<role>` 多链（当前为明确的设计简化，
      见 `src/config.ts` 设计注释「本期不做」段）。等待真实场景需求再解禁。

## 4. 推荐演进顺序

- **第一包（建议）**：时间窗切换 + 参数适配 + 熔断升级——三者全在现有拦截层
  与冷却框架内，一个设置卡三个区块，不引入新数据面。
- **观察期**：第一包上线后按真实使用决定是否启动第二档（成本 / 健康度）；
  两者要求先打通 `llm/stream` 层采集，是独立的前置工程。
- **改名阈值**：引入「状态持久化 / 成本 / 目录发现」任一时，插件职责已超出
  fallback 语义，应升级为 `dsh-llm-router`（对照 LiteLLM Router 定位），
  时间窗等策略降级为其模块；仅第一档范围内的扩展不改名。

## 5. 待决策点（勾选即采纳）

- [ ] **D1** 立项第一包（时间窗切换 + 参数适配 + 熔断升级）
- [x] **D2** 高峰期行为语义：**改写切换（采纳，2026-10-21）**——对话不中断；
      ~~延迟放行（waterfall 内 sleep 到窗口结束再发）~~ / ~~拒绝并报可读错误~~
- [x] **D3** 默认窗口：**反向对齐 DeepSeek 官方错峰（采纳，2026-10-21）**——
      高峰 = 08:30–00:30，错峰 = 00:30–08:30 半价；窗口按宿主机本地时区判定
      （本机即北京时间；预置模板随配置卡开启自动填入）
- [x] **D4** 配置形态：**全局窗口 + provider 匹配规则（采纳，2026-10-21）**
      （配置薄，规则 = match + action + windows；~~每候选 schedule 字段~~）
- [x] **D5** 错峰反向：**支持（采纳，2026-10-21）**——同一「预填冷却表」机制
      反向使用（错峰窗口内冷却非匹配候选）；批量任务错峰排程仍归第三档任务分型

## 6. 参考资料

- [Hermes time-model-router](https://github.com/makpapad/hermes-model-router-ui) —— 同构参照：时段双模型自动切换插件（多段窗口、跨夜区间、状态指示）
- [ccblocks](https://github.com/designorant/ccblocks) —— Claude 订阅 5 小时窗口的时段调度
- [LiteLLM Off-Peak Pricing](https://docs.litellm.ai/docs/proxy/off_peak_pricing) —— DeepSeek 错峰窗口与成本核算
- [LiteLLM Budget Reset & Timezones](https://docs.litellm.ai/docs/proxy/budget_reset_and_tz) / [Budget Routing](https://litellm.vercel.app/docs/proxy/provider_budget_routing)
- [LiteLLM cooldown handlers](https://github.com/BerriAI/litellm/blob/30f33a94/litellm/router_utils/cooldown_handlers.py) —— 失败驱动冷却的对照实现
- [OpenRouter Latency and Performance](https://openrouter.tokenhot.ai/docs/guides/best-practices/latency-and-performance) —— p90 滚动窗口软排序
- [How I Built My Own LLM Gateway](https://erikandersonbook.com/blog/posts/how-i-built-my-own-llm-gateway.html) —— 优先级分型 + overnight 延迟排程的自建实践
