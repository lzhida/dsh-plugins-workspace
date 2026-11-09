---
'@zhidal/dsh-llm-fallback': minor
---

适配 dsh 宿主 0.2.2-rc.1：切换机制从 waterfall 改写迁移到官方 `agent.model.select()` 持久化

**背景**：宿主 0.2.2-rc.1 封死了 `agent/request` waterfall 改写通道（`prepareRequest` 校验输出必须等于 step 选定 selection，改写即抛 `use agent.model.select() before step preparation`），旧版插件在新宿主上加载即炸（改写抛错）或行为未定义。同时宿主启动日志报 `patch: entry "dsh-llm-fallback" not found`（profile 补丁层平级条目在 bundles 清单缺包时被丢弃）。

**运行时层改造**：

- `agent/request` 监听器改为**只读**：原样返回 seed（绝不改写 provider/model）；保留会话模型捕获（`payload.agent.model.current()`）与时间窗预填
- 预算耗尽切换改为 `payload.agent.model.select({provider, model, reasoningEffort?})` 持久化：写入 durable model/selection 事件 + 自动插 `[model changed]` user message；`reasoningEffort` 从切换前 selection 继承；select 失败不阻断回退本体（仅降级为不持久化）
- **切换时序变化**：selection 在 step 准备时快照，`select` 在下一 step 生效——切换当 step 会用旧模型重发一次请求（白名单内失败），该次失败后本 step 透传、turn 报错结束，重发消息即从新候选继续（旧版「同 step 无感续发」依赖已封死的改写通道）
- 冷却起点跳过（0.5.x 在请求起点直接改写模型）移除；冷却仅影响失败推进的候选选择顺序
- 新增 `engines: { dsh: ">=0.2.2-rc.1" }`，旧宿主由兼容性校验自动拦截
- devDeps 类型源升级至 0.2.2-rc.1（`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-system-prompt`）；`cordis.d.ts` 类型增强删除（官方 dsh-agent 自带 Context.Events 增强，重复声明冲突）

**升级注意**：要求 dsh 宿主 0.2.2-rc.1+。若 profile bundles 清单缺包（启动日志报 `patch: entry "dsh-llm-fallback" not found`），需重新 `dsh plugin add @zhidal/dsh-llm-fallback@0.6.0` 让宿主把包写回 bundles 清单。
