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

看板上下文入口会向系统提示注册一个 `order=185` 的段落，内容是**看板模式工作法八段**：

| 段落               | 要点                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 总纪律             | 先查板 → 先读后动 → 先认领；版本冲突只重试一次；验收交接；完成须用户确认；backlog = 未授权                                                                                         |
| 拆卡               | 复杂需求先拆成多卡，**拆分表先给用户确认**再落卡；一张卡 = 一个可独立验收的功能点                                                                                                  |
| 前置               | 有真实先后依赖时用 `blockedBy` 落机器门禁（依赖总开关开启时生效，dsh-taskboard 0.10.1 起看板设置可关，关闭期间门禁不拦、顺序靠卡内文字）；只是建议顺序就只写文字，不设门禁         |
| 并行               | 没有前置关系的卡可以并行；**被前置阻塞的卡必须等前置完成，否则立即停止**；官方进程外子代理是可选工位                                                                               |
| 定时               | 定时卡用于无人值守 / 套餐非高峰期 / 套餐重置后的时间窗口；定时卡默认按看板模式执行                                                                                                 |
| 验收               | 自验 → `execution_report` → 评论归档 → 置为待验收；**任务永不自行置完成，完成由用户确认**                                                                                          |
| Git 收尾与变更请求 | 条件增强：启用官方 forge 后开 PR 且 **PR URL 回写 execution_report 与评论**（不回写则验收链断点）；未启用按仓库常规 git 纪律，不阻塞                                               |
| 收割               | 验收 `done` 后把任务分支合回目标分支：**必须先 `taskboard_get` 确认前置 `status==='done'`**（in_review 不算）；冲突先列结构化清单再问人；永不 push、主区脏不擅动、不改写已推送历史 |

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

## 看板模式四工具

插件在根层向宿主 `tools` 注册表（`ctx.tools.register`）注册四个工具，让看板模式会话能
**在不挂 dsh-taskboard 行的前提下**盘点、校验、调度任务卡并执行收割。板服务经
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

**记录面 vs 门禁面（dsh-taskboard 0.10.1 起）**：上游 0.10.1 给看板设置加了「启用任务依赖」
总开关（`dependenciesEnabled`，上游缺省关闭、本仓 vendored 版缺省钉为开启）。本工具的
`ready[]/blocked[]` 判定吃台账**原始记录**（`task.blockedBy`），不看总开关——总开关被用户
显式关闭期间，板服务门禁面（认领拦截、`dependencyBlock()`）停用，但本工具仍按记录报
「等待前置」，与门禁面表现不同。需要门禁面结论时以 `taskboard_get` / 认领报错为准；
机制详见 vendored `plugins/dsh-taskboard/docs/local-changes.md` 的「上游同步系列」小节，
以及本仓 `src/skill/skill-content.ts` 的 4.11.0 节（两层探测判据与关闭态处置）。

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
`presetId='kanban-mode'`（**写死**）、`blockedBy=[targetTaskId]`（依赖总开关开启时生效，
dsh-taskboard 0.10.1 起看板设置可关；关闭期间传参被静默丢弃，顺序兜底靠下方 prompt 纪律）、
checklist 留空；description 写明「这是看板模式定时执行卡，负责在触发时执行目标卡 <id>」+
无人值守/非高峰期用途说明 + 已知限制；返回生成卡的 `{id, title, status, execution, presetId, blockedBy}`。

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

## 收割（Harvest）：验收后的变基与合并

任务卡验收通过（`status=done`）后，把任务分支合回目标分支的闭环。

**分工边界**：管线的十步、状态机、冲突分叉与红线以仓库根
[docs/harvest-design.md](../../docs/harvest-design.md)（定稿设计文档）为准——**本节不重复
叙述管线细节**，只写「怎么用」与「已知坑」；可复制的卡片模板与冲突处理脚本见
[docs/harvest-workflow.md](docs/harvest-workflow.md)。

工具：`taskboard_harvest`（`plan` / `apply` 两态，幂等续跑）。

| 参数           | 类型                             | 说明                                                         |
| -------------- | -------------------------------- | ------------------------------------------------------------ |
| `taskId`       | string（必填）                   | 被收割的任务卡 id                                            |
| `mode`         | `plan` \| `apply`（默认 `plan`） | `plan` 只读审查与预检；`apply` 执行变基 + 合并               |
| `targetBranch` | string（可选）                   | 合并目标分支；缺省 = **收割时主区当前分支**；必须 ≠ 任务分支 |
| `deleteBranch` | boolean（默认 `true`）           | 合并成功后是否删任务分支（`branch -d`，非强制）              |
| `keepWorktree` | boolean（默认 `false`）          | 合并后是否保留检出（默认删除，脏则拒删并报告）               |

### 三种触发方式

| 触发              | 机制                                                                      | 自动化程度                                                   |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **T1 会话内直呼** | 在项目会话里直接调 `taskboard_harvest`（先 `plan` 看清差异，再 `apply`）  | 半自动（人发起）                                             |
| **T2 下游收割卡** | 任务卡 done → 收割卡 `blockedBy` 满足 → 认领或 cron 触发 → prompt 调工具  | 近自动（依赖门禁 + 调度器 tick；依赖总开关开启时门禁才生效） |
| **T3 done 钩子**  | 验收联动 watcher（进程内轮询台账 `revision`，done → 直合 / 冲突留痕交人） | 自动（**已落地**）                                           |

- **T1**：最省事的一条。`plan` 只读出差异摘要、base 是否前进、预检到的冲突文件；
  确认无误再 `apply`。
- **T2**：把「收割」本身做成一张下游卡（`blockedBy` 指向被收割的卡）。前置卡 `done`
  后门禁放行，卡被认领或 cron 到点触发，prompt 里调工具——近自动，但**靠 prompt 里的
  纪律兜底**（见下方已知坑第 1、8 条；门禁还要求依赖总开关处于开启态）。
- **T3**（**已落地**）：验收联动 watcher——进程内轮询台账 `revision`，发现卡片**进入**
  `done` 就自动收割：无冲突直合并并删检出 + 删分支；有冲突则**不动 git**，只在本卡写
  结构化留痕评论（冲突文件 / 类型 / 建议 / 续跑命令），由人在原卡会话或任意会话里让
  agent 跑 `taskboard_harvest apply` 续跑，或手动按指引处理——**默认不再自动建收割卡**；
  `canceled` 则先留痕分支 tip 与脏文件清单，再强制删除检出与分支（不可逆）。可用
  `DSH_HARVEST_WATCH=off|0|false` 关闭、用 `DSH_HARVEST_WATCH_INTERVAL_MS` 调整轮询
  间隔（默认 800ms）；要恢复「冲突自动建收割执行卡」的旧行为，设
  `DSH_HARVEST_CONFLICT_CARD=on`。

### 收割卡模板（T2 直接抄）

```json
{
  "title": "收割：<被收割任务标题>",
  "workspaceId": "<项目 id>",
  "urgency": "normal",
  "blockedBy": ["<被收割的任务卡 id>"],
  "presetId": "kanban-mode",
  "execution": { "mode": "claim" },
  "prompt": "先 taskboard_get 确认前置任务 <被收割的任务卡 id> 的 status==='done'，否则停手并报告（依赖门禁把 in_review 也算满足，不能只信门禁）。确认 done 后调用 taskboard_harvest(taskId='<被收割的任务卡 id>', mode='apply')；遇冲突先列 conflict.files 与 suggestions 的结构化清单，再用 ask_user_question 问「AI 解决 / 手动解决」。自验 → taskboard_execution_report → 评论留痕 → 置 in_review，永不自行置 done。"
}
```

`execution` 两种取法：

- `{"mode":"claim"}`——**人认领**触发（默认，适合验收后顺手收尾）；
- `{"mode":"scheduled","cron":"..."}`——**定时**触发（无人值守窗口）。

`presetId` 写死 `kanban-mode`：收割执行会话必须按看板模式纪律跑（先读后动、依赖门禁、
禁止自行置 done），不依赖部署默认预设。

### 已知坑

1. **依赖门禁把 `in_review` 也算「前置已满足」**：T2 收割卡会在前置还停在待验收时
   就被放行。所以 prompt **必须**显式要求先 `taskboard_get` 确认前置 `status==='done'`，
   否则停手——这是纪律，不能指望门禁。
2. **主区脏 → 拒绝，不擅动**：主区有未提交改动时工具直接拒绝收割并列出脏文件，
   绝不替人 `stash` / `clean` / `reset`。自己收拾干净再重试。
3. **已推送的分支不改写历史**：任务分支已有 upstream 且已推送 → 拒绝变基，降级为
   `--no-ff` 合并并置 `degraded=true`（notes 写明「拒绝变基」）。收割全程本地操作，**永不 push**。
4. **检出可能已被官方回收**：官方回收挂会话归档，冷会话回落 `retained`——分支还在、
   检出没了。工具会在官方池 `<repo>/.agents/worktrees/<branch>` 临时检出，**不要**自造
   第二套池路径。
5. **冲突必须先列清单再问人**：不许直接动手改冲突。先用 `conflict.files` +
   `suggestions` 给结构化清单（文件 + 冲突类型 + 两侧摘要），再 `ask_user_question` 问
   「AI 解决 / 手动解决」；AI 解决后仍冲突，最多再问一轮，仍冲突就停手交人。
6. **目标分支默认 = 收割时主区当前分支**：要合到别的分支必须显式传 `targetBranch`
   （且 ≠ 任务分支）；主区处于 detached HEAD 时工具会直接拒绝，要显式指定。
7. **不要在预设里挂 dsh-taskboard 插件行**：收割工具与本包另外三个工具一样经
   `ctx.get('dsh-taskboard')` **软读**板服务，缺席时报可操作错误（提示安装
   `@zhidal/dsh-taskboard`）而非静默失败；预设里再挂 dsh-taskboard 行会重复注册同名
   工具并实例化第二套 SchedulerService（见「限制与红线」第 1 条）。
8. **依赖总开关关闭时 `blockedBy` 静默不生效**（dsh-taskboard 0.10.1 起）：看板设置
   「启用任务依赖」被用户显式关闭期间，建收割卡传的 `blockedBy` 会被静默丢弃、门禁不拦，
   T2 的「近自动」就只剩 prompt 纪律兜底——顺序要靠模板里「显式确认 `status==='done'`」
   的纪律（这也是它无论如何都要保留的原因）。本仓 vendored 版把总开关缺省钉为开启
   （local-patches.json 第 16 条），上游官方缺省关闭。

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
   dsh-taskboard 板服务缺失时四个工具抛可操作错误（提示安装 @zhidal/dsh-taskboard）。
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

- **单元/契约层**：`npx vitest run plugins/dsh-kanban-mode` 全绿（预设形状、八段工作法、
  skill 锚点、四工具契约、板服务判定矩阵、收割管线与 watcher），`tsc --noEmit` / `eslint` / `prettier` /
  `scripts/build.ts`（含产物断言）全过。
- **实机装载层**：系列收官卡 6/6 在独立隔离 profile（`kanban-smoke`，独立 DSH_HOME）完成了
  一次 bundle 安装链路 e2e——加载级三断言、`kanban-mode` 预设注册、四工具注册、
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
│   ├── harvest-workflow.md         # 收割工作法：触发三法 / 收割卡模板 / 冲突剧本 / 已知坑
│   └── upstream-alignment.md       # 照上游源码搬运的两处来源登记（判定口径 / 工具规格机制）
├── scripts/build.ts            # esbuild 双产物 + 构建断言
├── src/
│   ├── context-text.ts         # 看板工作法八段（纯函数）
│   ├── entries/board-context.ts# 包子路径入口（systemPrompt 段落）
│   ├── index.ts                # 插件入口（注册预设 + 内嵌 skill + 四工具）
│   ├── preset-def.ts           # 预设定义（standard 逐行复刻）
│   ├── skill/
│   │   ├── skill-content.ts    # 内嵌建卡 skill 正文（SKILL_NAME/SKILL_CONTENT）
│   │   └── register.ts         # ctx.skills 注册封装（降级容错）
│   ├── harvest/
│   │   ├── git-runner.ts       # git 进程封装（capture/captureOrThrow/版本守卫）
│   │   ├── inspect.ts          # 只读审查（diffStat/log/changedFiles/baseAdvanced/冲突预检）
│   │   ├── conflict-plan.ts    # 冲突结构化清单（冲突类型 + 两侧摘要 + 建议）
│   │   ├── resolve.ts          # 变基/合并续跑现场探测与恢复动作
│   │   ├── task-target.ts      # 收割目标解析（项目目录 / 任务分支 / 收割卡标记）
│   │   ├── pipeline.ts         # 收割管线（plan/apply/冲突续跑/discard + 仓库级互斥）
│   │   └── watcher.ts          # T3 done 钩子（轮询 revision → 收割/丢弃/留痕）
│   └── tools/
│       ├── board-contract.ts   # BoardServiceContract 窄接口 + 软读取 + 依赖判定（照上游口径）
│       ├── define-tool.ts      # 本地工具规格垫片（照 vendored sdk 结构兼容重实现）
│       ├── harvest.ts          # taskboard_harvest（收割工具）
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
