---
'@zhidal/dsh-llm-fallback': minor
---

回退时机配置 `fallbackWhen`(afterRetry/immediately 两档)移除,改为数值化的每候选重试次数 `retriesBeforeSwitch`:

- `N > 0` = **以插件配置为准**:当前候选重试 N 次后才切下一候选,不被 provider 重试策略封顶——预算内由官方 `dsh-llm-retry` 执行重试(透传其决策),超出的部分由本插件代执行(指数退避 + 官方 `llm/retry` / `llm/retry-started` 轨迹事件,retry 记候选内序号),直到 N 用满;N 小于预算时会在官方仍在预算内时提前覆盖切换;
- `0`(默认)= 自动跟随 provider 重试策略的 `maxRetries`(宿主默认 5):预算内透传官方 retry 决策,预算耗尽后切换——与旧 `afterRetry` 等价;provider 未注册策略时视为 0(首失败即切)。provider 的 `retryPolicy` 本身可编辑(`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`,保存即热生效),自动档实时跟随;
- 同一 step 内计数按候选独立,切换后清零,每个候选(含会话指定模型)获得完整预算;
- `always` 模式策略:自动档整体透传官方无限重试,自定义档按 N 覆盖切换;
- 设置卡「回退时机」下拉替换为「每候选重试次数」数字输入(中英双语);`maxRetries` 字段保留(只限切换候选次数),描述改为与 `retriesBeforeSwitch` 明确互斥;旧配置中的 `fallbackWhen` 键被忽略,无需迁移。
