# @zhidal/dsh-kanban-mode —— 「看板模式」预设

把 DSH 任务看板（taskboard）变成**唯一台账**的工作方式：一条预设、七个工作法段落、一套纪律，外加内嵌建卡 skill。

## 用途

插件加载后向宿主的 `agentPresets` 注册表**编程式注册**一个预设：

- **id**：`kanban-mode`
- **名称**：看板模式
- **order**：2（排在官方 standard 预设之后）
- **行集**：官方 standard 预设的 `config.plugins` **逐行复刻** + 末尾追加一行看板上下文入口
  （`@zhidal/dsh-kanban-mode/board-context`）+ delegation 组内追加**两行官方可选**工具行
  （codex / claude-code 子代理，未安装提供方时零影响，见
  [docs/official-subagent.md](docs/official-subagent.md)）

看板上下文入口会向系统提示注册一个 `order=185` 的段落，内容是**看板模式工作法七段**：

| 段落               | 要点                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 总纪律             | 先查板 → 先读后动 → 先认领；版本冲突只重试一次；验收交接；完成须用户确认；backlog = 未授权                                           |
| 拆卡               | 复杂需求先拆成多卡，**拆分表先给用户确认**再落卡；一张卡 = 一个可独立验收的功能点                                                    |
| 前置               | 有真实先后依赖时用 `blockedBy` 落机器门禁；只是建议顺序就只写文字，不设门禁                                                          |
| 并行               | 没有前置关系的卡可以并行；**被前置阻塞的卡必须等前置完成，否则立即停止**；官方进程外子代理是可选工位                                 |
| 定时               | 定时卡用于无人值守 / 套餐非高峰期 / 套餐重置后的时间窗口；定时卡默认按看板模式执行                                                   |
| 验收               | 自验 → `execution_report` → 评论归档 → 置为待验收；**任务永不自行置完成，完成由用户确认**                                            |
| Git 收尾与变更请求 | 条件增强：启用官方 forge 后开 PR 且 **PR URL 回写 execution_report 与评论**（不回写则验收链断点）；未启用按仓库常规 git 纪律，不阻塞 |

## 官方能力集成（三件套，条件增强）

本包对 DSH 官方增强能力做「纪律 + 文档」接入，覆盖三件套：

- **forge（变更请求 / PR）**：启用官方 forge（插件页启用「变更请求与工作树」）后，
  执行会话完成改动后开 PR，并把 **PR URL 回写 execution_report 与任务评论**——
  官方模型没有读取已绑定变更请求的工具，不回写看板则验收链断点；验收人按
  PR diff 审查；
- **worktree（任务工作树隔离）**：官方 worktree 服务可用时由 dsh-taskboard
  软依赖接管（任务分支 `task/<标题>+<任务ID>`），服务缺席降级 `isolation: none`；
- **subagent（进程外子代理）**：见下一节与
  [docs/official-subagent.md](docs/official-subagent.md)。

**三者全部是条件增强：未启用 / 未安装时零影响**——工作法第七段「Git 收尾与变更
请求」的硬要求只在启用 forge 后生效，未启用时按仓库常规 git 纪律收尾、不阻塞。
启用步骤、官方限制与看板验收链衔接详见
[docs/official-integration.md](docs/official-integration.md)。

## 可选增强：官方进程外子代理（codex / claude-code）

预设 delegation 组内带两行官方 `dsh-tool-subagent` 实例行。**不安装官方提供方插件时
它们静默不挂载、不影响任何功能**（官方语义：提供方存在才注册工具、离开即释放）；
安装后 `subagent_codex` / `subagent_claude_code` 自动出现在看板模式会话里，可作为
额外的并行工位（one-shot 语义，只适合无共享上下文的独立小任务）。

- 启用步骤、凭证归属（codex 的 `OPENAI_API_KEY` 须经 provider 行 `config.env` 显式
  提供；claude-code 走原生登录）、限制清单与设计取舍：
  见 [docs/official-subagent.md](docs/official-subagent.md)。

## 内嵌 skill：kanban-task-create

插件在**根层**向宿主 `skills` 注册表（`ctx.skills.register`）注册一个 `source: 'bundled'` 的内嵌
skill，看板模式预设会话无需额外配置即可获得建卡方法论：

- **注册名**：`kanban-task-create`
- **来源**：用户级 `dsh-task-create` skill（549 行）的看板模式内联版，忠实保留七步骨架
  （环境门禁 → 需求澄清 → 看板侦察 → 拆分 → Plan 起草 → 用户确认 → 落卡/回报）、
  blockedBy 机器门禁、深度调研规范（4.5–4.11）、Pitfalls / Verification / 硬约束清单；
- **调用**：`invocation: { modelInvocable: true, userInvocable: true }`；
- **与用户级副本的差异**（改名、环境表述本地化、版本探测与字段取舍补齐）：
  见 [docs/skill-vs-user-skill.md](docs/skill-vs-user-skill.md)。
- **优先级**：看板模式会话内以本内联版为准；用户级副本可保留但建议停用以免两份漂移。
- **降级**：宿主 `skills` 服务缺失或注册失败时只 `console.warn`，不影响预设注册。

## 看板模式三工具

插件在根层向宿主 `tools` 注册表（`ctx.tools.register`）注册三个工具，让看板模式会话能
**在不挂 dsh-taskboard 行的前提下**盘点、校验与调度任务卡。板服务经
`ctx.get('dsh-taskboard')` 运行时软读取（对齐 dsh-anytype wiki 先例，不声明 inject）；
服务缺失时工具抛可操作错误：`dsh-taskboard 服务不可用：请安装并启用 @zhidal/dsh-taskboard 插件后重试`。
工具规格（name/description/参数 schema/output.render/execute）照 vendored sdk 垫片机制
在本包结构兼容重实现（见 [docs/upstream-alignment.md](docs/upstream-alignment.md)），
宿主 registry 拿到的 ToolDefinition 与上游 `taskboard_*` 工具同形。

### kanban_ready_cards（只读）

盘点当前可执行卡与并行波次。

| 参数        | 类型           | 说明                         |
| ----------- | -------------- | ---------------------------- |
| workspaceId | string（可选） | 过滤单一项目；缺省盘点全项目 |

输出：

- `ready[]`：`status=todo ∧ 未软删 ∧ 非待人工 ∧ 未被认领 ∧ 前置全满足` 的卡；
- `blocked[]`：todo 但前置未满足的卡，每项附 `unmet` 前置明细 `{id, title, status}`；
- `parallelBatches`：Kahn 分层拓扑波次——第 1 波 = 当前 ready；第 k 波 = 前置全部落在
  更早波次（in_review/done 的前置视为已满足；被 missing/跨项目/已删前置卡死的卡不进
  波次，只在 `blocked[]` 里报告 unmet）；
- `concurrencyNote`：固定提示「宿主 scheduler maxConcurrent 默认 3，可在看板设置调整；每分钟 tick」。

前置判定口径照上游 `plugins/dsh-taskboard/src/shared/dependencies.ts` 的 `dependencyState`
逐字重实现（kanban-mode 零跨包运行时 import）：`satisfied = 前置存在 ∧ 同项目 ∧ 未软删 ∧
status ∈ {in_review, done}`（前置不存在视为不满足，status 报 `missing`）。来源登记见
[docs/upstream-alignment.md](docs/upstream-alignment.md)。

### kanban_plan_check（只读）

对一份结构化拆卡方案（`{series?: {theme, total}, cards[]}`，每卡
`{title, description, prompt, checklist[], blockedBy[]（引用 cards 下标）}`）做五类机械
校验，逐项 PASS/FAIL + 可操作失败原因，另附 warnings：

1. **系列命名**：title 匹配「<主题>系列 n/N：<祈使短句>」——主题 2~10 字全组逐字一致、
   n 从 1 起连续无跳号、N = 总卡数、中文冒号后有动作短语；单卡不适用。
2. **description 四段**：「目标与成功标准 / 范围 / 实施要点 / 边界情况与已知风险」标记
   齐全；系列多卡时另要求「系列全景」行。
3. **prompt 四段**：「先读后动 / 执行位置 / 依赖与门禁 / 交接纪律」关键词齐全。
4. **checklist 可观察**：非空、每条 ≤200 字符、无重复；纯评价词（如「做好」「完善」
   无宾语）只告警不硬拒。
5. **依赖图**：blockedBy 下标合法、无环（DFS 检测）、可拓扑排序；下游卡引用更晚下标卡
   时告警（建卡拓扑序违规提示）。

输出必附声明：**机械校验不代替人判断：确认需求与拆分仍须用户点头**。

### kanban_schedule_run（写）

为目标卡生成一张**看板模式定时执行卡**。写路径只走 `boardService.createTask`（即
dsh-taskboard 2/6 定稿的 task-writer），**绝不复制第二份建卡逻辑**。

| 参数         | 类型            | 说明                                                               |
| ------------ | --------------- | ------------------------------------------------------------------ |
| targetTaskId | string（必填）  | 目标卡 id；缺失时报 not_found 并回显 id                            |
| cron         | string          | RFC 5545 五段，与 runAt 二选一                                     |
| runAt        | string / number | ISO 时间或 epoch ms，一次性，与 cron 二选一                        |
| title        | string（可选）  | 缺省「定时执行：<目标卡 title>」                                   |
| note         | string（可选）  | 附加说明，写进生成卡 description                                   |
| workspaceId  | string（可选）  | 缺省取目标卡所属项目；显式传入必须与之一致（blockedBy 前置同项目） |

生成卡固定形状：`status='todo'`、`urgency='normal'`、`execution={mode:'scheduled', cron|runAt}`、
`presetId='kanban-mode'`（**写死**）、`blockedBy=[targetTaskId]`、checklist 留空；
description 写明「这是看板模式定时执行卡，负责在触发时执行目标卡 <id>」+ 无人值守/非高峰期
用途说明 + 已知限制；返回生成卡的 `{id, title, status, execution, presetId, blockedBy}`。

prompt 内置执行纪律模板（写死在工具内）：执行会话先 `taskboard_get` 目标卡 → 目标卡不在
todo/in_progress 或 dependency_blocked（**前置未满足则立即停止**，`taskboard_comment_add`
记录原因，不得强行执行）→ 否则用 `kanban_ready_cards` 确认可执行后按目标卡 prompt 执行 →
自验 → `taskboard_execution_report`（失败改 `taskboard_comment_add` 归档）→ 移 `in_review`；
**严禁自行移到 done**（done 是用户确认动作）。

**presetId 为什么写死 kanban-mode**：定时卡触发时的执行会话按 `presetId` 决定预设；部署
默认预设不可控（看板设置的 `defaultPresetId` 可能指向 standard 或别的预设），而看板模式
纪律（先读后动、依赖门禁、禁止移 done）必须在执行会话生效——所以定时卡显式写
`presetId='kanban-mode'`，不依赖部署默认值。

### 并行度限制（宿主 scheduler）

- 全局并发默认 `maxConcurrent=3`（看板设置可调）；
- 调度器每分钟 tick 一次；
- 一次性 `runAt` 错过窗口（宿主离线超过 `scheduleMissedAfterMinutes` 默认 5 分钟）后回退
  为普通 claim 卡，**不补跑**——无人值守场景建议优先使用周期 cron；
- 执行会话永远不能把任务移到 done，完成由用户确认。

## 安装

本包是**构建式发行**（`main` 指向 `dist/index.js`）：实体安装（git/npm/tarball）时插件落在
profile 的 `node_modules` 下，Node 拒绝对其中的 `.ts` 做 type-stripping，TS 源码入口必然加载失败。

```sh
# 构建（实体安装与打包前会自动执行 prepare/prepack）
pnpm --filter @zhidal/dsh-kanban-mode build

# 开发期 link 安装
pnpm dsh plugin --profile test add link:<仓库绝对路径>/plugins/dsh-kanban-mode
```

装上后，宿主 bundle 会通过包内的 `cordis.patch.yml` 插入插件行 `dsh-kanban-mode`；插件加载即注册
「看板模式」预设，在新建会话的预设选择器里可见。

## 限制与红线

1. **预设内绝不挂 dsh-taskboard 行。** 宿主根层已经注册了 `taskboard_*` 工具；预设里再挂同一个插件
   会在该作用域再注册一套同名工具（遮蔽根层工具），并额外实例化**第二套 SchedulerService**
   → 定时卡被重复执行。单测与构建脚本都对这条红线做了断言。
2. **服务缺失时降级不崩。** `agentPresets` / `systemPrompt` / `tools` 服务缺失时插件只
   `console.warn` 后返回/跳过对应注册，不抛异常影响宿主启动；三块注册互不连累。
   dsh-taskboard 板服务缺失时三工具抛可操作错误（提示安装 @zhidal/dsh-taskboard）。
3. **编程式注册与声明式预设行互斥。** 宿主注册表对重复 id 直接抛 `Duplicate agent preset: <id>`，
   所以 `cordis.patch.yml` 里**只插插件行，不插预设行**。
4. **宿主服务用本地窄接口声明**，不 import 宿主 `@deepseek-ai/*` 运行时包——构建产物零
   `@deepseek-ai` 运行时引用，不会顶替宿主版本。
5. **standard 行集是快照。** 上游 DSH 升级后官方 standard 可能增删行，详见
   [docs/standard-preset-replica.md](docs/standard-preset-replica.md) 的跟版策略。
6. **官方子代理行只挂工具行、不挂 provider 行。** 提供方插件（`dsh-subagent-codex` /
   `dsh-subagent-claude-code`，均为 npm 限定发布）由用户装在宿主 profile 层；预设里
   若挂 provider 行会与宿主重复注册或在未安装时让整份预设加载失败。未安装时两行
   工具静默不挂载（官方语义），详见 [docs/official-subagent.md](docs/official-subagent.md)。
7. **`engines.dsh` 取 `>=0.2.2-rc.3`（与 @zhidal/dsh-taskboard 一致）。** 宿主低于该版本时安装会被
   dsh 兼容性守卫直接拒绝并自动回滚（实测：dsh 0.2.1-rc.2 上 `plugin add` 报
   `installation rejected: … requirements {"engines.dsh":">=0.2.2-rc.3"}`）；降级运行需走
   `dsh plugin allow-version` 显式豁免，不建议。

## 验证状态（如实记录）

- **单元/契约层**：`npx vitest run plugins/dsh-kanban-mode` 全绿（预设形状、七段工作法、
  skill 锚点、三工具契约、板服务判定矩阵），`tsc --noEmit` / `eslint` / `prettier` /
  `scripts/build.ts`（含产物断言）全过。
- **实机装载层**：系列收官卡 6/6 在独立隔离 profile（`kanban-smoke`，独立 DSH_HOME）完成了
  一次 bundle 安装链路 e2e——加载级三断言、`kanban-mode` 预设注册、三工具注册、
  `blockedBy` 依赖门禁链（`dependency_blocked` 拒绝 → 前置 `in_review` → 解锁）、定时卡
  `presetId='kanban-mode'` 持久化与前置未满足自动跳过，全部通过。该验证实例已退出，
  仓内证据为当时的运行期日志与 HTTP API 取证记录。
- **未覆盖**：接真实 LLM 的执行会话全链路（`kanban-smoke` profile 未配模型）未验证；
  读者不应把「171 用例全绿」理解为「LLM 执行链路已验」。后续可在配好模型的隔离 profile
  里补一轮无人值守定时卡真跑。

## 目录

```
plugins/dsh-kanban-mode/
├── cordis.patch.yml            # 只插一条插件行（不插预设行）
├── docs/
│   ├── standard-preset-replica.md  # standard 行集来源版本与跟版策略
│   ├── skill-vs-user-skill.md      # 内嵌 skill 与用户级 dsh-task-create 的差异对照
│   ├── official-integration.md     # 官方能力集成三件套（forge / worktree / subagent）与看板验收链
│   ├── official-subagent.md        # 官方进程外子代理（codex / claude-code）可选接入指南
│   └── upstream-alignment.md       # 照上游源码搬运的两处来源登记（判定口径 / 工具规格机制）
├── scripts/build.ts            # esbuild 双产物 + 构建断言
├── src/
│   ├── context-text.ts         # 看板工作法七段（纯函数）
│   ├── entries/board-context.ts# 包子路径入口（systemPrompt 段落）
│   ├── index.ts                # 插件入口（注册预设 + 内嵌 skill + 三工具）
│   ├── preset-def.ts           # 预设定义（standard 逐行复刻）
│   ├── skill/
│   │   ├── skill-content.ts    # 内嵌建卡 skill 正文（SKILL_NAME/SKILL_CONTENT）
│   │   └── register.ts         # ctx.skills 注册封装（降级容错）
│   └── tools/
│       ├── board-contract.ts   # BoardServiceContract 窄接口 + 软读取 + 依赖判定（照上游口径）
│       ├── define-tool.ts      # 本地工具规格垫片（照 vendored sdk 结构兼容重实现）
│       ├── ready-cards.ts      # kanban_ready_cards（只读盘点）
│       ├── plan-check.ts       # kanban_plan_check（只读五类校验）
│       ├── schedule-run.ts     # kanban_schedule_run（写：生成定时执行卡）
│       └── register.ts         # ctx.tools 注册封装（逐工具降级容错）
└── ...
```

## 校验命令

```sh
npx vitest run plugins/dsh-kanban-mode
npx tsc --noEmit -p plugins/dsh-kanban-mode/tsconfig.json
npx eslint plugins/dsh-kanban-mode
npx prettier --check "plugins/dsh-kanban-mode/**/*.{ts,md,json,yml}"
node plugins/dsh-kanban-mode/scripts/build.ts
```
