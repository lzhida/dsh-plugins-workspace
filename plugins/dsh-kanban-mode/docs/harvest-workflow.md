# 收割工作法（Harvest）：验收后的变基与合并

本包（`@zhidal/dsh-kanban-mode`）对「收割」——把验收通过的任务分支合回目标分支——
提供**纪律 + 编排 + 模板**三层落地。

## 〇、与设计文档的分工边界

| 文档                                                               | 写什么                                                               | 不写什么                   |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------- |
| 仓库根 [`docs/harvest-design.md`](../../../docs/harvest-design.md) | **定稿设计**：十步管线、状态机、冲突分叉算法、目标分支语义、红线清单 | 不写具体卡片模板与操作脚本 |
| 本页                                                               | **怎么用**：三种触发方式、收割卡模板、冲突处理剧本、已知坑           | 不重复叙述管线十步细节     |

- 管线细节（每一步做什么、失败怎么降级）→ **只看设计文档**。
- 「我现在该建什么卡、prompt 写什么、冲突了怎么办」→ **只看本页**。
- 两者冲突时以设计文档为准；本页若与设计文档口径不符，按设计文档修订本页。

## 一、工具契约速查

工具名 `taskboard_harvest`，两态：

- `mode=plan`（默认）：只读审查与预检——差异摘要、base 是否前进、预检到的冲突文件；
  **不碰工作区、不改历史**。
- `mode=apply`：执行变基 + 合并；幂等续跑（检测进行中的 rebase / merge 会走
  `--continue` 收尾）。

| 参数           | 类型              | 默认                   | 说明                                                                                                                               |
| -------------- | ----------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `taskId`       | string            | —（必填）              | 被收割的任务卡 id                                                                                                                  |
| `mode`         | `plan` \| `apply` | `plan`                 | `plan` 只读预检；`apply` 执行收割                                                                                                  |
| `targetBranch` | string（可选）    | **收割时主区当前分支** | 合并目标分支；必须 ≠ 任务分支，且**只能是本地分支名**（不解析 `origin/` 等远端跟踪引用，传 `origin/dev` 会被判「目标分支不存在」） |
| `deleteBranch` | boolean           | `true`                 | 合并成功后是否删任务分支（`branch -d`，非强制）                                                                                    |
| `keepWorktree` | boolean           | `false`                | 合并后是否保留检出（默认删除；检出脏则拒删并报告）                                                                                 |

输出里与纪律直接相关的字段：

- `result` ∈ `merged` | `conflict` | `rejected` | `noop` | `failed`（`mode=plan` 另有
  第六态 `planned`）；
- `conflict.files`（冲突文件清单）+ `conflict.suggestions`（每处的两侧摘要与建议）；
- 已推送分支被拒绝变基时，合并结果会置 `degraded=true` 并在 `notes` 里写明
  「拒绝变基,直接 --no-ff 合并」（`--no-ff` 降级合并；实现**不**产出「未变基」
  这两个字样，以 `degraded` 与 `notes` 为准）。

## 二、三种触发方式

### T1 会话内直呼（半自动，人发起）

最省事的一条：验收完成后，在项目会话里直接调工具。

```
1. taskboard_get(<被收割卡>) 确认 status === 'done'
2. taskboard_harvest(taskId=<被收割卡>, mode='plan')   # 只读，看清楚
3. taskboard_harvest(taskId=<被收割卡>, mode='apply')  # 执行
```

- `plan` 结果无冲突 → 直接 `apply`；
- `plan` 报冲突 → 先按第四节给结构化清单并问人，别直接 `apply` 硬闯；
- `apply` 返回 `rejected` → 按第六节已知坑对症处理（通常是主区脏 / 目标分支缺失）。

### T2 下游收割卡（近自动）

把「收割」本身做成一张**下游卡**，`blockedBy` 指向被收割的卡：

- 前置卡进入 `done` → 依赖门禁放行 → 收割卡可被认领（`claim`）或被 cron 触发；
- 收割卡的 `prompt` 里显式调 `taskboard_harvest(mode=apply)`。

**T2 的关键坑**：依赖门禁把 `in_review` 也算「前置已满足」，所以门禁放行**不等于**
前置已验收。收割卡的 `prompt` **必须**显式要求：

> 先 `taskboard_get` 确认前置任务 `status === 'done'`，否则停手并报告。

### T3 done 钩子（自动，**已落地**）

**已落地**（验收联动系列 3/4）：进程内 watcher 轮询台账 `revision`，发现卡片**进入**
`done` 就自动收割：无冲突直合并、无冲突时删检出 + 删分支并留痕；有冲突则**不动 git**，
只在本卡写结构化留痕评论（冲突文件 / 类型 / 建议 / 续跑命令与主区绝对路径），由人在
原卡会话或任意会话里让 agent 跑 `taskboard_harvest apply` 续跑，或手动按指引处理——
**默认不自动建收割执行卡**。卡片进入 `canceled` 时走丢弃路径（先留痕
分支 tip 与脏文件清单，再删检出 + `branch -D`）。

- 实现：`src/harvest/watcher.ts`（`createHarvestWatcher`），由 `src/index.ts` 在
  `ctx.effect` 内随插件启动/停止；
- 留痕通道：板服务评论写通道 `addTaskComment`（`src/local/task-writer.ts`，
  见 dsh-taskboard 包），系统评论带来源标记与幂等键；
- 环境开关（默认值保持「开」）：
  - `DSH_HARVEST_WATCH=off|0|false` → 不启动 watcher（工具直呼场景用，避免自动
    收割与手动 `taskboard_harvest` 抢同一张卡）；
  - `DSH_HARVEST_WATCH_INTERVAL_MS=<毫秒>` → 轮询间隔（默认 800）；
  - `DSH_HARVEST_CONFLICT_CARD=on|1|true` → 恢复「冲突自动建收割执行卡」的旧行为
    （默认关闭：只留痕评论，等待人工/会话接手）。

**不可逆提示**：`canceled` 路径会强制删除检出并 `git branch -D`（脏检出也删），
该动作**不可回滚**；分支上的提交只留在 reflog 里，回收前须确认已无价值。

**边界**：watcher 只处理「进入 done/canceled」的跃迁；首次见到的卡只登记状态，
不会把历史存量卡当跃迁；项目未在本实例注册的卡会被静默跳过（不写看板评论）。

## 三、收割卡模板（T2 直接复制）

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

字段说明：

| 字段                  | 取值                                        | 为什么这么写                                                                                    |
| --------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `blockedBy`           | 被收割的任务卡 id                           | 把「前置 done 才收割」落成机器门禁；**但门禁把 in_review 也算满足**，所以 prompt 里仍要显式确认 |
| `presetId`            | `kanban-mode`                               | 收割执行会话必须按看板模式纪律跑（先读后动、依赖门禁、禁止自行置 done）；不依赖部署默认预设     |
| `execution.mode`      | `claim`                                     | 人认领触发——验收后顺手收尾的标准做法                                                            |
| `execution`（另一种） | `{"mode":"scheduled","cron":"<五段 cron>"}` | 定时触发，适合无人值守窗口                                                                      |
| `prompt`              | 见上                                        | 显式门禁确认 + 工具调用 + 冲突问人 + 留痕 + 不置 done                                           |

> `execution` 用 `claim` 还是 `cron` 取决于触发者：有人盯 → `claim`；固定窗口批量收
> → `cron`（周期表达式，宿主 scheduler tick 驱动）。两者都**不豁免** prompt 里的
> `status==='done'` 确认。

## 四、冲突处理剧本

冲突时**先给清单、再问人**，不许直接动手改冲突。

### 1）先出结构化冲突清单

来自工具输出的 `conflict.files` 与 `conflict.suggestions`，整理成可读清单：

- 冲突文件清单（路径）；
- 每处的冲突类型；
- 两侧摘要（base 侧 vs 任务分支侧各做了什么）。

### 2）再问人：`ask_user_question`

给两个选项：**AI 解决** / **手动解决**。二选一，不替人做决定。

### 3A）AI 解决

1. 在**任务检出内**逐文件解决（编辑 + `git add`）；
2. 调 `taskboard_harvest(mode=apply)` 续跑——工具检测到进行中的 rebase / merge 会走
   `--continue` 并完成收尾；
3. **二次冲突最多再问一轮**：仍冲突则停手交人（不要反复自动重试）。

### 3B）手动解决

1. 工具 **保留冲突现场**（rebase / merge 进行中，不 abort、不清理；工具没有 abort 入口，
   现场保留正是续跑的前提）；
2. 输出**手动收割指引**：分支名、目标分支、检出路径、建议命令序列
   （如 `git -C <检出路径> status` → 人工解决 → `git -C <检出路径> rebase --continue`
   或 `merge --continue` → 目标分支上 `git merge --no-ff <任务分支>` →
   `git branch -d <任务分支>`；实际以工具输出的指引为准）；
3. 人在检出内解决并 `git add` 后，再回来跑一次 `taskboard_harvest(mode=apply)` 续跑收尾
   （工具按检测到的进行中状态走 `--continue`）。

## 五、红线（三条，任何模式都不豁免）

- **全程本地操作，永不 push**：收割只改本地仓库，push 是人的动作。
- **不改写已推送历史**：任务分支已有 upstream 且已推送 → 拒绝变基，直接 `--no-ff`
  合并，并置 `degraded=true` + 在 `notes` 写明「拒绝变基」。
- **主区脏不擅动**：主区有未提交改动 → 拒绝收割并报脏文件；绝不替人 `stash` /
  `clean` / `reset`。

## 六、已知坑清单

1. **门禁把 `in_review` 算满足**：T2 收割卡会在前置还停在待验收时被放行 → prompt
   必须显式 `taskboard_get` 确认 `status==='done'`，否则停手。
2. **主区脏 → 拒绝，不擅动**：工具只报脏文件，不替人清理；自己收拾干净再重试。
3. **已推送分支不改写历史**：拒绝变基 → `--no-ff` 合并 + `degraded=true` 标注
   （`notes` 写明「拒绝变基,直接 --no-ff 合并」）；全程不 push。
4. **检出可能已被官方回收**：官方回收挂会话归档，冷会话回落 `retained`——分支还在、
   检出没了；工具在官方池 `<repo>/.agents/worktrees/<branch>` 临时检出，不要自造
   第二套池路径。
5. **冲突必须先清单再问人**：先 `conflict.files` + `suggestions` 清单，再
   `ask_user_question` 问「AI 解决 / 手动解决」；AI 解决后仍冲突最多再问一轮，仍冲突
   停手交人。
6. **目标分支默认 = 收割时主区当前分支**：要合到别的分支必须显式传 `targetBranch`
   （且 ≠ 任务分支）；主区处于 detached HEAD 时工具直接拒绝，要显式指定。
7. **不要在预设里挂 dsh-taskboard 插件行**：收割工具与本包另外三个工具一样经
   `ctx.get('dsh-taskboard')` 软读板服务，缺席时报可操作错误（提示安装
   `@zhidal/dsh-taskboard`）而非静默失败；预设里再挂 dsh-taskboard 行会重复注册同名
   工具并实例化第二套 SchedulerService。
8. **丢弃路径只留痕 tip 与脏文件清单**：T3 watcher 在 `canceled` 时先留痕分支 tip
   hash 与脏文件**清单**（不抄文件内容），随后强制删除检出与 `branch -D`；内容不留
   存，需要内容请在取消前自行留档。

## 七、自验清单（每次收割后核对）

- [ ] `taskboard_get` 已确认前置 `status === 'done'`（不是 `in_review`）；
- [ ] 工具返回 `result === 'merged'`，无未处理冲突；
- [ ] 已推送分支的合并结果带 `degraded=true` 与「拒绝变基」notes（若有）；
- [ ] 任务分支按 `deleteBranch` 语义处理（默认已删；`keepWorktree=true` 则保留检出）；
- [ ] 收割卡侧留痕：`taskboard_execution_report` + 评论；
- [ ] 卡片置为 `in_review`，**没有**自行置 `done`。
