# 上游口径对齐登记

本卡（看板模式三工具）有两处「读上游源码搬运」——kanban-mode 是独立插件包，与
dsh-taskboard **零跨包运行时 import**，因此把上游语义逐字本地化，并用单测锁定口径。
本文登记来源与对齐方式，供后续跟版核查。

## 1. 依赖判定口径（judgeDependencies）

- **来源**：`plugins/dsh-taskboard/src/shared/dependencies.ts` 的 `dependencyState`
  （依赖判定唯一真源）。
- **落点**：`src/tools/board-contract.ts` 的 `judgeDependencies(tasks, task)`。
- **搬运语义（逐字）**：

  ```
  satisfied = 前置存在
            ∧ prerequisite.workspaceId === task.workspaceId（同项目）
            ∧ prerequisite.trashedAt === undefined（未软删）
            ∧ prerequisite.status ∈ { in_review, done }
  ```

  前置 id 不存在于记录表时同样不满足，`status` 回退 `'missing'`、`title` 回退前置 id
  （与上游 `prerequisite?.title ?? id` 一致）。

- **对齐断言**：`src/tools/board-contract.test.ts` 按五个维度构造等价场景矩阵——
  正常满足、状态非 in_review/done（如 in_progress/todo 不满足）、跨项目前置永不满足、
  已软删前置不满足、missing 前置报 `missing`——与上游 `dependencies()` 返回的
  `TaskDependencyView { id, title, status, satisfied }` 逐字段比对。
- **跟版注意**：上游 `dependencies.ts` 若调整判定集合（如纳入新终态），本包需同步
  `SATISFIED_STATUSES` 并跑对齐单测。

## 2. 工具规格机制（defineTool 垫片）

- **来源**：`plugins/dsh-taskboard/src/host/sdk.ts`（vendored 包自带的 sdk 垫片，它让
  宿主半区零运行时 `@deepseek-ai` 依赖）与 `src/host/tools.ts` 的注册面
  （`ctx.tools.register(definition)`）。
- **落点**：`src/tools/define-tool.ts`（结构兼容重实现）+ `src/tools/register.ts`
  （注册封装）。
- **对齐要点**：

  - ToolDefinition 形状逐字段对齐：`{ name, description, parameters(编译后 raw
schema: {type:'object', properties, required?}), output: { schema:{},
render(args, value): [{type:'text', text}], execute } }`；
  - execute 前参数预校验，违规抛 `Error: invalid arguments: <violations>`（与上游垫片
    同款消息形状）；
  - `output.schema` 对 `{type:'json'}` 编译为 `{}`（annotation-only）；
  - render 是模型可见输出契约：宿主 registry 用 `output.render(args, value)` 产出
    `result.content`，因此 render 必须带全事实（ids/statuses/execution 等）；
  - 错误消息沿用上游 BoardError 形状 `Error: <code>: <detail>`（码表见
    `src/tools/board-contract.ts` 的 `TOOL_ERR`）。

- **精简范围**：本包参数只有顶层标量与 json 节点，垫片未实现上游的嵌套 ObjectSpec
  编译（注释已声明）；若未来需要嵌套参数，按上游 sdk.ts 补齐即可。
- **跟版注意**：上游 sdk.ts 若调整 ToolDefinition 形状或校验消息，本包需同步重实现并
  跑 `register.test.ts` 的形状断言。

## 3. 软依赖先例

板服务的读取方式照 `plugins/dsh-anytype/src/entries/wiki.ts:114` 的跨插件软依赖先例：
`ctx.get('dsh-taskboard') as BoardServiceContract | undefined`，不声明 inject、invoke 时
惰性解析；缺失时转可操作错误而不崩宿主。
