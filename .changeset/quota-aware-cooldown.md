---
'@zhidal/dsh-llm-fallback': minor
---

配额感知自适应冷却（新配置 `quotaCooldownEnabled` / `quotaCooldownMs` / `cooldownCapMs`）：订阅制提供商（GLM Coding Plan / MiniMax Token Plan 等）的用量窗口耗尽失败（GLM 1308/1310、MiniMax 2056 等业务码或 usage limit / 用量上限措辞）记冷却时自动延长时长——报错携带重置时间（GLM「将在 … 重置」、MiniMax「resets at …Z」）直接采用，无重置时间用配额档（默认 5 小时，对齐用量窗口周期），全部结果受 7 天硬上限封顶；普通失败（瞬时限流 / 服务器错误）维持 `cooldownMs` 固定档（默认 5 分钟），行为与旧版完全一致。路由判定不读 message 的约定不变，解析只影响冷却时长、失败时优雅降级。切换轨迹事件追加 `cooldownUntilMs` / `cooldownSource` 字段（读侧透传安全），延长发生时打 `[dsh-llm-fallback] quota-aware cooldown` 日志。
