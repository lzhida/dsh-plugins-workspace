# 收割（Harvest）设计：看板验收后的变基与合并

> 状态：**已实现**（2026-11-23 收割系列 6/6 收官）。本文既是方案也是实现契约；
> 实现落在 `plugins/dsh-kanban-mode/src/harvest/`（新增 7 个源文件 + 同目录单测）与
> `plugins/dsh-kanban-mode/src/tools/harvest.ts`（工具）；dsh-taskboard 侧动自研的
> `src/local/`（评论写通道与建卡强制隔离）+ **一处已登记的 vendored 改动**
> （`src/host/routes.ts` 建卡入口接入 `resolveIsolation`，登记见
> `plugins/dsh-taskboard/docs/local-patches.json` 与 `docs/local-changes.md`）。
> 证据：单测与契约测试见 `plugins/dsh-kanban-mode/src/harvest/*.test.ts`；隔离 profile
> 实机证据（正常收割 / base 前进变基 / 冲突问询→AI 解决续跑 / canceled 丢弃 / done 钩子
> 自动合并）见看板卡「收割系列 5/6」「验收联动系列 4/4」的交接评论。
> 目标形态：**B 路线——收割工具派**（用户 2026-11-23 选定）。
> 对标：vibe-kanban 的 attempt-completion / merge-queue 流程。

## 1. 背景与目标

现状（事实基线见 §3）：任务卡在 worktree 隔离执行、agent 收尾提交、人验收（done）后，
看板只提供**一次 `--no-ff` 合并**（GUI 一键），且冲突「原样报告，不自动解决」
（`plugins/dsh-taskboard/docs/upstream-readme.md`，上游 v0.10.0 行为，本仓 vendored 一致）。
**没有**变基、**没有**冲突 AI/手动分叉、**没有**目标分支选择、**没有**验收后自动触发的钩子。

本方案要交付的闭环：

```
人验收 done → 差异审查 → base 前进检测 → 变基 → 合并预检
                                   ↘ 冲突：问询（AI 解决 / 手动解决）
                                   ↘ AI 解决 → 继续变基/合并 → 合并回目标分支 → 清理检出
```

## 2. 范围

**做**

1. `taskboard_harvest` 工具（plan / apply 两态，幂等续跑），封装审查、变基、预检、合并、清理；
2. 冲突问询分叉：工具返回结构化冲突 → agent 用 `ask_user_question` 问人 → AI 解决或停手交人；
3. 目标分支：默认「合并时主区当前分支」（与 GUI 一键合并同语义），可参数指定；
4. kanban-mode 工作法新增「收割段」纪律（`plugins/dsh-kanban-mode/src/context-text.ts`）；
5. 编排：支持「下游收割卡」（`blockedBy` + `presetId='kanban-mode'`）与「会话内直接调用」两种触发；
6. **验收联动自动化（2026-11-23 新增，§13）**：每卡强制 worktree 隔离；验收 done → 自动合并（无冲突直合 / 冲突只留痕评论交人，`DSH_HARVEST_CONFLICT_CARD=on` 可恢复自动建收割执行卡）；验收 canceled → 自动丢弃（删检出+删分支，删前评论留痕）。

**不做（本期）**

- 宿主侧 done 事件桥（`store.subscribe → ctx.provide` 事件面，需动已登记 `index.ts`）——本期用进程内轮询 `revision` 等效实现（§13.2），事件面留作 P3；
- 执行层 isolation 钉死与缺席拒绝（需再动已登记 `execution.ts`）——缺席降级保留为已知限制（§13.1）；
- 多仓库镜像收割（官方集成已禁用镜像，见 `plugins/dsh-taskboard/docs/local-changes.md` 卡片「官方集成系列 1/3」）；
- 任何 push / 远端操作 / 已推送历史改写（全局红线，见 §10）；
- 改动 vendored 上游文件与客户端 UI（本期连联动需求也保持 vendored 零改动；GUI 适配列为后续可选）。

## 3. 事实基线（本仓已核实的硬事实）

| 事实                                                                                                                                        | 依据                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 官方 worktree 池：`<repo>/.agents/worktrees/<branch>`（按 `/` 嵌套）；`from` 缺省 `HEAD`，可传固定 commit                                   | `plugins/dsh-taskboard/docs/official-worktree-spike.md` §(b)（实测 `baseCommit: 0be76dc…`） |
| 官方服务**没有** `--no-ff` 合并、分支删除、孤儿清理、「立即移除」API → 这些是插件侧的 git 收尾                                              | 同上，「官方能力边界 → 实现约束清单」                                                       |
| 官方回收挂 Session 归档，冷会话 sandbox 回落 `read-only` → 实测 **retained**（检出与分支都留着）                                            | 同上 §(c)                                                                                   |
| 结算只**采集**证据（commits / diffStat / dirtyFiles），不代提交；`TaskRecord.branch` 记录任务分支，execution 记 `baseCommit`/`worktreePath` | `plugins/dsh-taskboard/docs/local-changes.md` #25–#28、e2e 证据块                           |
| 现有 git 收尾口径：`merge --no-ff`、`git worktree remove`（非 force，脏则拒）、`branch -d`；主区脏或冲突原样报告                            | 同上 #25、#28                                                                               |
| 依赖门禁判定 `satisfied = 前置 status ∈ {in_review, done}`                                                                                  | `plugins/dsh-kanban-mode/README.md` 「准备卡」口径与 `src/tools/board-contract.ts`          |
| 板服务已导出（`ctx.provide('dsh-taskboard', boardService)`），含 `snapshot/getTask/listTasks/createTask/updateTask`（ifVersion 乐观锁）     | `plugins/dsh-taskboard/src/local/board-service.ts`、`src/index.ts`（已登记改动）            |
| kanban-mode 不 import taskboard 包运行时；板服务经 `ctx.get('dsh-taskboard')` **软读取**                                                    | `plugins/dsh-kanban-mode/README.md` 「看板模式三工具」                                      |

## 4. 落点与文件清单

**全部新增落在 `plugins/dsh-kanban-mode`（本仓自研包，改动无 vendored 契约负担）**；
`plugins/dsh-taskboard`（vendored）**只动已登记的最小面**：自研 `src/local/`（评论写通道与
建卡强制隔离真源）+ 一处已登记的 `src/host/routes.ts`（建卡入口接入同一真源 `resolveIsolation`，
登记见 `plugins/dsh-taskboard/docs/local-patches.json`）：

```
plugins/dsh-kanban-mode/src/harvest/
├── git-runner.ts        # git 子进程封装（exec/capture/错误分类），仅本包内部
├── inspect.ts           # 只读审查：差异摘要、base 前进检测、冲突预检（纯函数 + git-runner 组合）
├── conflict-plan.ts     # 冲突清单 → 结构化「建议解决方案」数据（供 agent 问询）
├── pipeline.ts          # 收割管线状态机（plan/apply/续跑），幂等
├── resolve.ts           # 冲突续跑判定（检测进行中的 rebase/merge 状态）
├── task-target.ts       # 收割目标解析（项目目录 → 任务分支/baseCommit/检出路径 + 收割卡标记）
├── watcher.ts           # 验收联动 watcher（轮询台账 revision → 收割/丢弃/留痕，见 §13.2）
└── *.test.ts            # 单测（含真实 git 临时仓集成测试）
plugins/dsh-kanban-mode/src/tools/harvest.ts      # 工具规格（照既有 define-tool 垫片）
plugins/dsh-kanban-mode/src/context-text.ts       # 工作法第七段扩展「收割段」
```

工具注册沿用 `src/tools/register.ts` 既有模式（`ctx.tools.register`，spec 形状与
`taskboard_*` 同形，见 `docs/upstream-alignment.md`）。

**为什么放 kanban-mode 而不是 taskboard**：taskboard 是 vendored 包，动上游文件必须登记
`local-patches.json` + `local-sha256.txt`（`docs/local-changes.md` 三段式契约），而收割
所需的全部输入（任务分支、worktree 路径、baseCommit、项目根）都能从**软读取的板服务**

- 台账 execution 记录拿到；git 操作由 kanban-mode 自行调用（宿主进程内 spawn git，
  与上游 `src/host/git.ts` 同一层）。

## 5. 工具契约

### `taskboard_harvest`

| 参数           | 类型                             | 说明                                            |
| -------------- | -------------------------------- | ----------------------------------------------- |
| `taskId`       | string（必填）                   | 目标任务 id                                     |
| `mode`         | `plan` \| `apply`（默认 `plan`） | `plan` 只读审查与预检；`apply` 执行变基+合并    |
| `targetBranch` | string（可选）                   | 合并目标分支；缺省 = 主区当前分支               |
| `deleteBranch` | boolean（默认 `true`）           | 合并成功后是否删任务分支（`branch -d`，非强制） |
| `keepWorktree` | boolean（默认 `false`）          | 合并后是否保留检出（默认删除，脏则拒删并报告）  |

**输出**（结构化 JSON，agent 可直接据此问询与交接）：

```jsonc
{
  "taskId": "t-xxxx", "repo": "E:/…/repo",
  "branch": "task/标题+t-xxxx", "worktreePath": "<repo>/.agents/worktrees/task/标题+t-xxxx",
  "targetBranch": "dev",
  "baseCommit": "0be76dc",
  "baseAdvanced": true,              // baseCommit 是否已是 targetBranch 的祖先
  "commits": [{ "hash": "d6636b7", "subject": "feat(x): …" }],
  "diffStat": "3 files changed, 120 insertions(+), 8 deletions(-)",
  "changedFiles": ["src/a.ts", "src/b.ts"],
  "conflict": { "files": ["src/a.ts"], "kind": "rebase" | "merge", "suggestions": ["…"] },
  "actions": ["rebase", "merge", "cleanup"],   // 本次实际执行的动作
  "result": "merged" | "conflict" | "rejected" | "noop" | "failed" | "planned",
  // ↑ 第六态 planned 仅出现在 mode=plan（只读规划，未改动任何 git 状态）。
  "mergeCommit": "a1b2c3d",
  "notes": ["…"]
}
```

> **实现回填（2026-11-23，收官卡 6/6）**：`mode=plan` 实际返回第六态 `planned`
> （规划完成、未改动任何 git 状态），实现侧见 `plugins/dsh-kanban-mode/src/harvest/pipeline.ts`；
> `baseAdvanced` 语义为「baseCommit 是否仍是 targetBranch 的祖先」（true = 未前进）。

**幂等与状态机**：

```
plan ──► apply ──► (冲突) ──► 冲突态检出保留 ──► 人工/AI 解决 ──► apply(续跑) ──► merged
                 └─► rejected（主区脏 / 分支已推送 / 目标分支不存在 / 状态不是 done）
```

- `apply` 遇冲突：**中止并保留冲突现场**（rebase/merge 进行中），返回 `conflict`；
- 再次调用 `apply` 时检测到「进行中的 rebase/merge」→ 走**续跑**分支（`--continue`）；
- 冲突解决由 agent 在检出内完成（编辑 + `git add`），工具只负责 continue/收尾；
- 任何不可恢复的失败都要 **干净回滚**（`rebase --abort` / `merge --abort`），不留脏状态。

## 6. 收割管线（apply 模式步骤序列）

| #   | 步骤          | 命令 / 判定                                                                                                         | 失败语义                                                                                    |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 0   | 前置校验      | 任务 `status==='done'`；仓库存在；目标分支存在且 ≠ 任务分支                                                         | 拒绝（`rejected`），说明原因                                                                |
| 1   | 主区清洁检查  | `git -C repo status --porcelain` 空                                                                                 | 拒绝 + 列出脏文件（不替人清理）                                                             |
| 2   | 分支推送检查  | 任务分支若有 upstream 且与本地不等 → **拒绝 rebase**（不改写已推送历史）                                            | 降级为 `--no-ff` 合并 + `degraded=true` + notes 写明「拒绝变基」（实现口径，见下方说明）    |
| 3   | 定位检出      | `<repo>/.agents/worktrees/<branch>` 存在则用；不存在（官方回收 retained 或已删）→ `git worktree add` 临时检出该分支 | 失败 → `failed`                                                                             |
| 4   | 差异审查      | `git log target..branch`、`git diff target...branch --stat`、changed files                                          | 只读信息进输出                                                                              |
| 5   | base 前进检测 | `git merge-base --is-ancestor baseCommit target`                                                                    | 否 → 需变基                                                                                 |
| 6   | 变基          | 检出内 `git rebase target`                                                                                          | 冲突 → 停（保留现场，返回 `conflict`，kind=rebase）；非冲突错误 → `rebase --abort` + failed |
| 7   | 合并预检      | `git merge-tree --write-tree target branch`（git ≥ 2.38）；旧版降级 `merge --no-commit` + `--abort` 试合并          | 冲突 → `conflict`（kind=merge）                                                             |
| 8   | 合并          | 主区 `git merge --no-ff branch`（与现有 GUI 合并口径一致）                                                          | 失败 → `merge --abort` + failed（主区脏态由 abort 还原）                                    |
| 9   | 清理          | `git worktree remove`（非 force，脏则拒并报告）+ 可选 `git branch -d`                                               | 失败不影响已完成的合并，只报 `notes`                                                        |
| 10  | 留痕          | 输出结构化结果；agent 侧写 `taskboard_comment_add` + 交接（见 §9）                                                  | —                                                                                           |

**变基 vs 合并的取舍**：默认变基（线性历史、任务分支未推送，改写安全）；若任务分支已推送
→ 拒绝变基，直接走 `--no-ff` 合并，并在输出里置 `degraded=true` + notes 写明
「拒绝变基,直接 --no-ff 合并」（**不**产出「未变基」字样）。

> **实现回填（2026-11-23，收官卡 6/6）**：本节原写「目标分支是远端跟踪分支 → 拒绝变基 →
> 拒绝」，与 §12 的决策记录（降级 `--no-ff` 合并）矛盾；实现跟随 §12（降级合并 + degraded），
> 故本表按实现口径回填。另：远端跟踪分支的判定**尚未实现**（`branchExists` 只查
> `refs/heads/`），当前仅按「任务分支已推送」触发降级——这是已知缺口，见收割 6/6 交接评论。

## 7. 冲突分叉（用户要求的核心交互）

1. 工具返回 `conflict.files` + 每文件的冲突类型（双方新增/修改/删除）+ 两侧内容摘要；
2. agent 调 `ask_user_question`：「AI 解决 / 手动解决」；
3. **AI 解决**：agent 在检出内逐文件解决（编辑 + `git add`）→ 调 `taskboard_harvest(mode=apply)`
   续跑 → 工具检测进行中的 rebase/merge → `--continue` → 继续到合并；
4. **手动解决**：工具**保留冲突现场**（rebase / merge 进行中，不 abort、不清理），输出「手动收割指引」清单
   （分支名、目标分支、检出路径、建议命令序列）；人在检出内解决后 `git add`，再跑一次 `apply`
   续跑（工具按检测到的进行中状态走 `--continue` 收尾）；
5. 二次冲突（AI 解决后仍冲突）→ 最多再问一轮，仍冲突则停手交人。

## 8. 目标分支语义（「原创建的分支」怎么解析）

- **台账事实**：`from` 缺省 `HEAD`（创建时主区 HEAD），台账只存 `baseCommit`，**不存 base 分支名**；
  官方 `create` 的 `from` 可传固定 commit。
- **默认规则（本期）**：合并目标 = **执行收割时主区当前分支**（`git branch --show-current`），
  与看板 GUI 一键合并的既有语义一致；同时用 `baseCommit` 是否为该分支祖先来判断
  「base 是否前进」，供审查参考。
- **手动指定**：`targetBranch` 参数（必须是本地已有分支），并校验 ≠ 任务分支。
- **可选增强（P1.5，待拍板）**：把创建时的 base 分支名写进 task 记录（需改 vendored
  `src/host/execution.ts` 或改由 taskboard 在 isolation 时记录到 description），让「默认 =
  原创建分支」严格成立。代价：触碰 vendored 上游文件（需登记 patch）。

## 9. 触发编排与留痕

| 触发                | 机制                                                                     | 自动化程度                          |
| ------------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| T1 会话内直呼       | 用户/agent 在项目会话调用 `taskboard_harvest`                            | 半自动（人发起）                    |
| T2 下游收割卡       | 任务卡 done → 收割卡 `blockedBy` 满足 → 认领或 cron 触发 → prompt 调工具 | 近自动（依赖门禁 + 调度器 tick）    |
| T3 验收联动 watcher | 进程内轮询 `revision`，done → 直合/建收割卡，canceled → 丢弃（§13.2）    | 自动（验收即联动，延迟 ≈ 轮询间隔） |

**T2 的坑**：依赖判定把 `in_review` 也算「满足」，所以收割卡 prompt 必须显式写
「先 `taskboard_get` 确认前置 `status==='done'`，否则停手」——这是纪律，不能指望门禁。

**留痕**：工具只做 git 侧动作与结构化输出；评论与执行报告由 agent 会话按既有纪律写
（`taskboard_comment_add` → `taskboard_execution_report`）。联动 watcher 的自动动作
（直合/丢弃）经板服务新增评论写通道留痕（§13.2，`src/local/` 自研文件扩展）。

## 10. 风险与红线

1. **不 push**：收割全程本地操作，永不 push（全局纪律）。
2. **不改写已推送历史**：任务分支已有 upstream 且已推送 → 拒绝变基（§6 步骤 2）。
3. **主区脏不擅动**：主区有未提交改动 → 拒绝并报脏文件，绝不替人 stash/clean。
4. **变基后分支历史改写**：仅限未推送的本地任务分支；收割在验收 done 后执行，不与续跑并行。
5. **官方回收 retained**：worktree 可能早已不存在但分支仍在 → 临时检出路径必须落回官方池
   `.agents/worktrees/<branch>`，避免自造第二套池。
6. **多仓镜像遗留台账**：只收割当前项目主仓；台账里遗留的 `branches/repos` 字段在输出中标注
   「镜像形态已禁用，未逐仓收割」。
7. **tool 调用并发**：同一仓库同时收割两张卡会撞 git 锁 → 工具内加仓库级互斥（同仓串行）。
8. **误删分支**：`branch -d` 是安全删除（未合并则拒绝），不 force。

## 11. 验证策略

- **单测**：纯函数部分（分支解析、base 前进判定、冲突清单结构、状态机转移、命令序列构造）用
  mock git runner；既有 vitest 基建与 mock 模式照 `src/tools/*.test.ts`。
- **真实 git 集成测试**：vitest 内 `git init` 临时仓（上游 `dsh-taskboard` 有真实 git 集成测试先例），
  覆盖：正常变基+合并、base 前进、rebase 冲突、merge 冲突、脏主区拒绝、已推送分支拒绝、续跑幂等。
- **e2e**：独立隔离 profile（如 `kanban-smoke`）跑「建卡 → worktree 执行 → 验收 done → 收割 →
  合并」全链路；**严禁**在 desktop profile 装开发版插件、严禁杀宿主进程（用户硬规则）。
- **提交门禁**：改动仅在本仓自研包 → 不触发 vendored 哈希契约；仍需 `pnpm lint && pnpm typecheck && pnpm test` 全绿，
  并按用户纪律做 ≥2 轮交叉验证（V1 自验 + V2 子代理审 diff）。

## 12. 决策记录（2026-11-23 用户拍板）

| 决策点       | 结论                                                              |
| ------------ | ----------------------------------------------------------------- |
| 分支清理     | 合并后删任务分支（`branch -d` 安全删除）                          |
| 目标分支语义 | 收割时主区当前分支（零 vendored 改动；baseCommit 前进检测仍报告） |
| 变基策略     | 变基优先；检测到已推送/远端跟踪则降级 `--no-ff` 合并并标注        |
| 拆卡         | 方案定稿即拆卡 → 已落「收割系列」六卡（见 §14）                   |

## 13. 验收联动自动化（2026-11-23 新增需求：强制隔离 + done 合并 / canceled 丢弃）

> 用户需求（m00159 paraphrase）：验收之后需要提交合并等清理操作，执行隔离不能再在原主分支和
> 工作树上执行——严格要求每张卡执行时都新建分支和对应 worktree；验收通过（done）即合并，
> 取消（canceled）即丢弃。
> 实现形态：**vendored 上游改动仅为已登记的一处**（`src/host/routes.ts` 建卡入口接入真源
> `resolveIsolation`，登记见 `plugins/dsh-taskboard/docs/local-patches.json`），其余全部落在
> 本仓自研 `src/local/` 与 kanban-mode 包。

### 13.0 事实基线（两轮源码调研，2026-11-23）

状态迁移与感知：

- done 与 canceled 写路径**完全统一**：GUI move / 工具 move / 结算三条入口全部汇入 `TaskStore.mutate`
  （`plugins/dsh-taskboard/src/host/store.ts:255-289`，唯一写入口，串行队列+原子写盘）；
- **done 只能来自 GUI**：工具路径显式拒绝（`src/host/tools.ts:692-694` "moving a task to done requires
  explicit user confirmation (GUI)"）；canceled 可来自 GUI 与工具；
- canceled 迁移**零清理副作用**：不归档会话（仅 `to==='archived'` 且显式 `archiveSessions` 才归档，
  `src/host/routes.ts:979-981`）、不回收检出、不删分支；canceled 可复活（`TRANSITIONS.canceled =
['archived','todo']`，`src/shared/protocol.ts:53-61`）；无 cancelReason/canceledAt 字段；
- 板服务 `snapshot()` 直通台账且携带 `revision`（每次 mutate +1，`src/host/store.ts:270`；
  `src/local/board-service.ts:78`）——进程内轮询是纯内存读；`store.subscribe`（`store.ts:228-231`）存在
  但 TaskStore 实例不外露，板服务无 subscribe/move；
- 宿主无「状态变更后回调」既有机制；0.8.2 定期任务完成策略的结算是 session 事件驱动
  （`src/host/execution.ts:914-1082`）。

隔离与丢弃：

- createTask 归一化默认链：`input.isolation → settings.defaultIsolation → 'none'`
  （`src/local/task-writer.ts:222-226`，**本仓自研文件**；`src/shared/protocol.ts:443-445`）；
  `IsolationMode = 'worktree' | 'none'`（`protocol.ts:122`）；updateTask **无 isolation 字段**
  （`task-writer.ts:116-139`）→ 强制不影响续跑；GUI 在首次执行前允许改 isolation
  （`routes.ts:908-916`）；
- 执行层对官方服务缺席三层降级绝不拒绝（`src/host/execution.ts:627-676`，上游已登记文件，本期不动）；
- canceled 后检出/分支**永久保留**，现有清理入口全手动：GUI 🗑 worktree-remove
  （`routes.ts:1294-1343`）、delete 动作 purge（`routes.ts:1068-1120`，现成丢弃模板）、诊断
  worktree-cleanup（`routes.ts:1370-1404`，只清孤儿）；
- 可复用件在上游 `src/host/git.ts`：`removeCheckout`（脏检出拒绝 + `git worktree remove` 非 force +
  prune，`git.ts:354-367`）、`deleteBranch`（**`-D` 强删**，`git.ts:349-352`）——kanban-mode 不跨包
  import，丢弃逻辑在自家 git-runner 自实现（收割/丢弃两种删除语义可分别实现）；
- **契约约束**：新增文件只能进 `src/local/`——`package-contract.test.ts` 断言「src/ 除 local/ 外与
  上游清单一一对应（63 文件）」，src/host 新文件会炸文件集一致性；local→host 运行时 import 零先例
  （惯例单向 host→local），构建无方向断言（`scripts/build.ts:72-123`）。

### 13.1 强制 worktree 隔离

- **唯一强制点**：`src/local/task-writer.ts` createTask 归一化处钉死 `isolation='worktree'`
  （忽略显式 `none` 与看板设置默认；该函数是 GUI/工具/板服务全部建卡入口的唯一实现——2/6 卡已上移）；
  显式传 `none` 被覆盖时在建卡返回注明「已强制 worktree」；
- 旧卡（已固化 `none`）不在强制范围：存量少，且 GUI 在首次执行前可手动改 isolation；
- **已知限制**：官方服务缺席时执行层仍降级原目录并有「⚠ 未隔离」警示文案（execution.ts 不动）；
  GUI 表单仍呈现 none 选项（后端强制覆盖，GUI 适配列为后续可选）；
- **收割卡不设豁免**：收割执行卡同样强制 worktree（规则纯粹），收割 prompt 教会话用
  `git -C <主仓绝对路径>` 操作目标仓、在目标任务检出内解决冲突。

### 13.2 验收联动 watcher（kanban-mode 包 `src/harvest/watcher.ts`）

- **感知**：进程内轮询 `boardService.snapshot().revision`（默认 800ms tick，纯内存读，可配置）；
  revision 变化 → 对比前后快照找出状态**进入** done / canceled 的卡 → 串行队列逐个处理；
- **done → 收割管线 apply**：
  - 无冲突 ∧ 主区干净 ∧ base 检查通过 → 直接合并 → 删检出 + 删分支（`-d` 安全删）→ 经板服务
    评论写通道留痕（mergeCommit、diffStat、结果）；
  - 冲突 / 主区脏 / 其他拒绝态 → **不动手**，默认只在本卡写结构化留痕评论（冲突文件 /
    类型 / 建议 / 主区绝对路径与 `taskboard_harvest apply` 续跑指引），由人在原卡会话或
    任意会话接手（`DSH_HARVEST_CONFLICT_CARD=on` 恢复旧行为：自动建「收割执行卡」，
    `presetId='kanban-mode'`、`isolation='worktree'` 服从强制；prompt 内置冲突解决纪律：
    在目标任务检出内解决冲突后 `taskboard_harvest apply` 续跑；会话用 `git -C` 绝对路径
    操作主仓）；
  - 幂等：分支不存在 → noop；同一卡重复 done 事件安全；异常（服务缺席/无分支）→ 评论留痕，
    不阻塞队列；
- **canceled → 丢弃（管线 discard 模式）**：
  - 先留痕：系统评论记录 branch tip hash + 脏文件清单（reflog 窗口内可救）；
  - 删检出（**脏检出也删**——丢弃语义；评论已留痕）→ 删分支（`-D`，丢弃语义）；
  - canceled 复活（→todo）自洽：分支已删，官方 `create` 可重建；
- **留痕通道**：板服务新增评论写能力（`src/local/task-writer.ts` + `src/local/board-service.ts`
  扩展 `addTaskComment`，均为本仓自研文件，`ctx.provide` 的实例自动携带，不动 `index.ts`）。

### 13.3 与收割系列的协同

- 收割 2/6 管线新增 **discard 模式**（canceled 联动的执行体）；
- 收割 5/6 e2e 增加联动场景（done 自动合并、冲突留痕与接手、canceled 丢弃、强制隔离生效）；
- 收割 6/6 收官改为同时等待联动 e2e；
- 事件桥（`store.subscribe` → `ctx.provide('dsh-taskboard-events')` 装配桥，需动已登记 `index.ts`）
  为 P3 备选升级路径；本期轮询零契约。

### 13.4 联动决策记录（2026-11-23，模型定稿）

| 决策点     | 结论                                                                                                     | 理由                                                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 事件感知   | 轮询 `revision`（零 vendored 改动）而非事件桥                                                            | 进程内内存读廉价；事件桥需动已登记 index.ts，留作 P3                                                          |
| 强制点     | 真源在 task-writer 层（自研文件），三入口（工具/板服务/GUI）共用；GUI 入口另有一处已登记的 vendored 接线 | 真源唯一；GUI 必须接线才生效，故动 `src/host/routes.ts` 并登记；执行层钉死需再动已登记 execution.ts，本期不做 |
| 收割卡豁免 | 不设豁免，同样强制 worktree                                                                              | 规则纯粹；prompt 教 `git -C` 绝对路径                                                                         |
| 丢弃强度   | aggressive（脏检出也删）+ 删前评论留痕 tip                                                               | 用户明确「不留任何东西」；reflog 提供后悔窗口                                                                 |
| 落点包     | watcher/丢弃全在 kanban-mode；taskboard 包动自研 `src/local/` + 已登记的 `src/host/routes.ts`            | 底层不依赖上层；git-runner 复用；vendored 改动须登记（已在 local-patches.json 登记）                          |

## 14. 卡片系列

- **收割系列**（六卡链 1→2→{3,4}→5→6）：t-mwsp7304-0ijvn4 / t-mwsp7gzk-evu5gh / t-mwsp7v87-ocaj7f /
  t-mwsp8bk0-07o7jr / t-mwsp8roz-9ah8l3 / t-mwsp97cq-l23rn1（全部 todo 待审查，不自动开工）；
- **验收联动系列**（2026-11-23 新增，四卡，见 §13）：强制隔离 → 板服务评论通道 → 联动 watcher → 联动 e2e；
  联动 watcher 依赖收割 2/6 的管线（含 discard），联动 e2e 依赖联动 watcher 与收割 5/6 的 e2e 方法论；
  收割 6/6 收官同时等待联动 e2e。
