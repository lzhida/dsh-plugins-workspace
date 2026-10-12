---
'@zhidal/dsh-llm-fallback': minor
---

轨迹透明化：跨 provider 回退不再是黑盒。切换候选时通过官方轨迹接口（`agent/request-error` payload 携带的 `agent.session.append`，与宿主 `dsh-llm-retry` 同一通道）向会话日志写入官方 `llm/retry` / `llm/retry-started` 事件（`policyKey` 固定 `llm-fallback`），宿主轨迹 UI 内置渲染为请求节点的重试状态（失败消息、错误码、重试进度与退避时长）；切换目标 provider/model 由宿主 loop 的 `request/header` change 自动记录。附带修复：`baseDelayMs` / `maxDelayMs` 显式 `0` 现按文档语义生效（禁用退避），此前被误判非法回落 500/30000；退避等待现在可被 turn 取消立即中断，不再拖住已取消的 waterfall。
