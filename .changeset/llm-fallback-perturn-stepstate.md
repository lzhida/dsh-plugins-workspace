---
'@zhidal/dsh-llm-fallback': minor
---

perTurn 字段正式实装（单次切换档）并收口 step 回退状态表的无界增长：`perTurn: false` 时同一 `turn:step` 至多切换一次候选——切换生效处消耗 one-shot 名额，同 step 后续预算耗尽不再切换、透传上游决策（官方 retry 透传与预算内代执行重试不消耗名额），新 step / 新 turn 天然重置，agent/request 的冷却起点改写不算切换；每 step 回退状态（`turn:step` 键）在新 turn 首次请求时清理其他 turn 的旧状态，内存上界从严格无界收敛为单 turn 的 step 数，冷却表独立于清理、跨 step 语义不变。
