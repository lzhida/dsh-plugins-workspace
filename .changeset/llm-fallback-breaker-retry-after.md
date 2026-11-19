---
'@zhidal/dsh-llm-fallback': minor
---

冷却策略强化：熔断升级与限流对齐。

- **熔断升级**（默认开启）：同一候选连续失败时冷却窗指数递增（`cooldownMs × 2^N`，首次失败不翻倍、固定档零回归），结果封顶于独立的 `cooldownBreakerCapMs`（默认 30 分钟，与配额档 7 天上限分离；若固定档 `cooldownMs` 更长，有效上限不低于固定档）；冷却期满进入稳定观察期 `cooldownStabilizationMs`（默认 10 分钟），期间再失败继续翻倍，观察期安静度过才恢复原优先级。宿主不暴露成功事件，恢复为时间基近似。新增配置 `cooldownBreakerEnabled` / `cooldownBreakerCapMs` / `cooldownStabilizationMs`，配置卡新增对应区块与中英文案。
- **限流对齐**：记冷却时优先读宿主透传的 `LlmFailure.providerRetryAfterMs`（deepseek 路由填充，兼容秒数与 HTTP 日期两种 `retry-after` 格式），冷却到期直接对齐服务端要求（轨迹 `cooldownSource` = `retry-after`）；该字段缺失时优雅降级到配额档 / 熔断档 / 固定档。判定全程不解析错误 message。
- 轨迹事件的 `cooldownSource` 新增 `retry-after` 与 `breaker` 两个取值；冷却日志文案由 `quota-aware cooldown` 统一为 `cooldown`。
