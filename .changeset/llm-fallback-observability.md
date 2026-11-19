---
'@zhidal/dsh-llm-fallback': minor
---

切换可观测性（0.9.0）：新增配置卡只读状态面板与按天统计落盘。面板展示今日尝试/失败/切换计数、装配事故数、最近切换事件与冷却中候选，数据经插件自有只读路由 `GET /dsh-llm-fallback/status`（本机回环，宿主 webServer 信任边界）提供，30 秒轮询 + 手动刷新，路由不可达时面板不渲染、不影响配置卡其余功能。按天统计落盘 `DSH_HOME/dsh-llm-fallback-usage.json`（按「日期 × 候选路由」聚合 attempts/failures/cooldownMarks/switches，失败/切换事件触发 + 卸载兜底、5 秒去抖原子写，保留 14 天自动修剪，损坏回落空表，重启后按天计数恢复；最近切换环形缓冲、装配事故与守卫期望表仅内存）。新增旧装配守卫：切换经 `agent.model.select()` 持久化后，**下一 step 的首个请求**若 selection 仍是旧模型即 `console.warn` 告警并计入装配事故（one-shot 期望表；同 step 内官方 retry 重入不消费期望，正常生效零开销）。轨迹事件不自创新类型（读侧 format v4 拒读未知 type），告警走 console + 计数 + 自有路由。统计仅本机聚合落盘，无遥测、无外发。
