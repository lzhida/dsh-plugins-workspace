---
'@zhidal/dsh-llm-fallback': minor
---

新增候选级参数覆盖：回退链条目可选配置 `reasoningEffort` 与 `maxTokens`，按候选定制推理力度与单次输出上限。`reasoningEffort` 随 `agent.model.select()` 切换持久化（selection 不可在 waterfall 改写，下一 step 生效）；`maxTokens` 经 `agent/request` waterfall controls 按请求路由覆盖（宿主认可通道，会话指定模型永不命中，未配置零改写）。配置卡队列行内新增力度 / 上限两个可清空输入（中英文案），保存时未配置的候选不带键、旧配置零迁移。非法力度无需预校验——`UNSUPPORTED_REASONING_EFFORT` 已在默认失败码白名单内，自动切下一候选。
