---
'@zhidal/dsh-llm-fallback': patch
---

step 回退状态键并入会话标识（会话隔离）：键位从 `turn:step` 升级为 `<会话id>:<turn>:<step>`（会话标识取自 `agent/request(-error)` payload 的 `agent.session.id`，缺失时降级为无会话段的 `turn:step` 共享键位，与旧行为兼容）——多会话并发时同号 turn 的回退状态不再互相串扰，新 turn 建态清理只作用于同会话的旧 turn，不再误清其他会话的在途状态（原表现为该 step 回退状态重置、从会话模型重来）；代价是每会话在其最末 turn 后遗留少量状态（上界 ≈ 会话数 × 单 turn step 数，宿主重启即清零）。冷却表不受影响（provider/model 键，跨会话共享属既定语义）。另将 client 冒烟测试的渲染等待预算从 100×10ms（≈1s）放宽至 300×20ms（≈6s）并细化探测条件（断言前先等目录名解析），消除全量并发跑时的预存 flaky。
