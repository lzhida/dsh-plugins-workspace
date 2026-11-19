---
'@zhidal/dsh-llm-fallback': minor
---

角色级回退链（0.8.0）：新增 `roleChains` 配置字段，按角色（`subagent` / agentPreset id）配置专属回退候选池——子代理与顶层会话可走不同队列。角色识别走宿主 `agent.session.header`（origin='subagent' 或 delegationDepth>0 → 固定角色 `subagent`；顶层带 agentPreset → 以 preset id 为角色键；header 缺失回落 default）。未配置的角色回落全局 `fallbackChains`，`roleChains.default` 键显式忽略；旧配置零迁移、零行为变化。冷却跨角色共享（按 provider/model 键，与角色无关——避免一个角色打爆另一个角色的后备池）。角色链成员支持全套链条目字段（displayName/description/reasoningEffort/maxTokens），角色级参数覆盖优先于全局链同候选覆盖。schema 增 `roleChains` 字段（`Schema.dict(Schema.array(ChainEntrySchema))`，中英双语描述）；角色链选择/隔离/兜底/冷却共享均有单测背书。
