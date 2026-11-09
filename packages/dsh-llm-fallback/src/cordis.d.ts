/**
 * 类型增强（0.6.0 起已移交官方）。
 *
 * 历史:0.5.0 及以前,`agent/request` / `agent/request-error` 两个 waterfall
 * 事件由本文件以 `declare module '@deepseek-ai/cordis'` ambient 增强——彼时
 * 宿主类型未声明它们,插件需要自己补全才能 typecheck。
 *
 * 现状:宿主 `@deepseek-ai/dsh-agent`(0.2.2-rc.1 起)的 runtime-types.d.ts
 * 已自带 `interface Events` 增强(payload 含 `agent: Agent`,Agent 挂
 * `session` 与 `model`),本文件与它重复声明会触发 TS 重复成员冲突,故全部
 * 移除。事件与模型类型统一从官方包取:
 * - 事件 payload/决策类型:`@deepseek-ai/dsh-agent`(Context.Events);
 * - `Agent`:`@deepseek-ai/dsh-agent`(`payload.agent`,挂 `session: Session`
 *   与 `model: Model`,即 `model.current()` / `model.select()`);
 * - `LlmFailure`:`@deepseek-ai/dsh-llm`。
 *
 * 本文件保留为 package.json `types` 字段的指向目标(纯注释壳),避免宿主
 * 沿导入链解析 types 时落空。
 */
export {};
