---
'@zhidal/dsh-llm-fallback': minor
---

简化：移除每候选重试次数配置（0.5.0 引入的 `retriesBeforeSwitch`），同候选重试预算固定跟随官方 `dsh-llm-retry`（provider 重试策略 `maxRetries`，宿主默认 5）——预算内透传官方重试决策，耗尽后才切下一候选；不再有插件代执行重试分支（0.5.0 的 N>0 自定义档整段删除）。旧配置残留值被宽松忽略，无需迁移。欲调整同候选重试预算，请直接编辑 provider 适配器的 `retryPolicy`（`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`）。配置卡同步移除该输入，`maxRetries` 描述改为「只限切换候选次数」。
