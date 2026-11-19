---
'@zhidal/dsh-decision': minor
---

新增**决策门控系列**（`@zhidal/dsh-decision`，私有包）：按「决策点」切分插件行的组合包，首个成员 `ask-gate` 把出厂的 `ask_user_question` 提问工具接管为**可由模型代答**的门控——决策模型给出高置信答案时直接代替用户作答，低置信或任何降级一律放行真实提问（fail-open）。

**包结构**（组合包扩展约定见 README）：

- `src/core/decision.ts`：决策点无关的纯函数底座——`runDecisionCall`（单轮调用 + 自有超时 + 融合上游 signal）、`parseDecisionResponse`（JSON 围栏/括号平衡提取、confidence 越界钳制）、`decideByThreshold`（阈值判定，非法阈值视为放行）、`decide`（组合，返回 call/parse/threshold 三段报告）；
- `src/core/config.ts`：配置模式与解析（非法值回落默认）；
- `src/entries/ask-gate.ts`：`ask-gate` 插件行（`main: src/index.ts` 的组合包入口，`cordis.patch.yml` 以 `insert:` 落行，并**让位**出厂 `tool-ask-user` 停用，避免同名工具重复注册）；
- `src/services/ask-gate.ts`：prompt 构造、答案构造与 meta 构造纯函数。

**门控行为**：总开关 `enabled` 默认关闭——关闭时不介入决策，原样直通宿主提问通道（参数与答案结构、宿主错误语义与原版一致；工具描述文案有改写，详见 README「已知限制」）。开启后按 `confidenceThreshold`（默认 0.8）判定：`confidence ≥ 阈值` → 自动作答（答案带 `[decision auto-answer]` 前缀标注）；`< 阈值` 或调用降级（模型不可用 / 超时 / 中止 / 路由非法 / 解析失败 / 未配置路由）→ 放行真实提问。

**落账可核查**：工具返回体携带 `presentationMeta{confidence, decision, rationale}`（`decision` 取 `auto-answered` / `passed-through`），宿主轨迹的 tool/result 可见；降级同时打 `[ask-gate] decision degraded (...)` 日志行；建议答案未覆盖全部问题时 `rationale` 前缀 `answers-incomplete:`。

**配置**：`enabled` / `decisionProvider` / `decisionModel` / `confidenceThreshold` / `decisionTimeoutMs` 五个字段，均标 volatileField（设置面板即时生效），落在 profile 补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml`（按 `- id: ask-gate` 覆盖），不引入任何自有配置文件或数据目录。

**行为变化**：装了本包的 profile 会让位出厂提问工具行（同名工具只保留本包实现）；决策调用是**纯旁路**——不进会话上下文，不受 `dsh-llm-fallback` 保护；出参 schema 顶层放宽 `additionalProperties` 以容纳 `presentationMeta`；仅支持 `link:` 安装（TS 源码入口）。本包为私有包，不发布 npm。
