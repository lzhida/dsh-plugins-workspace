# @lzhida/dsh-taskboard

教学版 dsh-taskboard 插件:复刻 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard#readme) 的核心契约,精简到适配本仓库工具链。

> **范围说明**:本包是 cloader/dsh-taskboard 0.8.x 的**架构与契约级教学复刻**,覆盖 10 个 `taskboard_*` agent 工具、ifVersion 乐观并发、代码级协议闸(agent 永远到不了 done / 被持有时不可抢 / 跨项目不可认领)、DoD 验收清单、结构化执行报告、system-prompt 协议 section。
>
> 与原版差异:**无 Web UI / 无 cron 调度器 / 无 worktree 隔离执行 / 无外部会话自动同步 / 无数据目录迁移**。这些是 cloader 的庞大能力,本教学版专注于核心契约的"代码闸"实现。

## 安装

仓库内开发:`packages/dsh-taskboard` 已在 pnpm workspaces 收录,直接 `pnpm install` 即可。

宿主 `dsh` 加载:

```sh
dsh plugin add link:packages/dsh-taskboard
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层,无需 overlay 注入。

## 快速开始(教学版 agent 工作流)

```
你:执行看板任务 t-ab12cd
agent:
  taskboard_list                # 查板:项目内 todo 任务
  taskboard_get t-ab12cd        # 读需求
  taskboard_comments t-ab12cd   # 读最新评论流(用户可能在评论里改需求)
  taskboard_move → in_progress  # 认领(代码闸:被持有/跨项目被拒)
  ...编码 / 测试...
  taskboard_checklist check     # 逐项勾验收清单,必附 evidence note
  taskboard_execution_report    # 结构化报告:摘要/改动/自验/产物/风险
  taskboard_comment_add         # 交接说明
  taskboard_move → in_review    # 移待验收
你:看板待验收列 ✓ 完成          # done 永远只属于人
```

## 10 个 taskboard_* 工具

| 工具                         | 作用                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| `taskboard_list`             | 查板(按 workspace/status/urgency 过滤,紧凑摘要)                        |
| `taskboard_get`              | 读单卡全文(描述、prompt、清单、当前 version)                           |
| `taskboard_comments`         | 列出任务评论(按时间正序,视为最新需求)                                  |
| `taskboard_create`           | 建卡(workspaceId 必填,可指定 urgency/execution/model/preset/checklist) |
| `taskboard_update`           | 改标题/描述/urgency/execution/checklist(必传 ifVersion)                |
| `taskboard_move`             | 状态机转移(`done` 永远被代码闸拒绝)                                    |
| `taskboard_comment_add`      | 追加评论                                                               |
| `taskboard_delete`           | 软删除(写 trashedAt,数据保留供审计)                                    |
| `taskboard_checklist`        | DoD 清单 add / check / uncheck(check 必带 note)                        |
| `taskboard_execution_report` | 提交结构化报告(summary 必填)                                           |

## 代码级协议闸(非提示词约定)

| 错误码                     | 触发条件                                        |
| -------------------------- | ----------------------------------------------- |
| `DONE_FORBIDDEN`           | 任何到 `done` 的 move 调用,无论 agent 还是 user |
| `TASK_HELD`                | todo→in_progress 时,任务已被其他 session 持有   |
| `CROSS_PROJECT_FORBIDDEN`  | 调用方 workspaceId ≠ 任务 workspaceId           |
| `VERSION_CONFLICT`         | ifVersion 与任务当前 version 不匹配             |
| `CHECKLIST_NOTE_REQUIRED`  | check 验收项时未提供 evidence note              |
| `CHECKLIST_LIMIT_EXCEEDED` | checklist 项数 > 30                             |
| `REPORT_INCOMPLETE`        | execution report 的 summary 为空                |
| `ILLEGAL_TRANSITION`       | 状态机白名单外转移(如 todo→in_review 跳级)      |

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
```

e2e(走真实 dsh Web UI 验证):

```sh
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- packages/dsh-taskboard/src/index.ts
```

## 教学版 vs 原版对比

| 能力                     | 原版 (0.8.7) | 教学版 (本包)                |
| ------------------------ | ------------ | ---------------------------- |
| 10 个 taskboard_* 工具   | ✓            | ✓                            |
| ifVersion 乐观并发       | ✓            | ✓                            |
| 代码级协议闸             | ✓            | ✓                            |
| DoD 验收清单             | ✓            | ✓                            |
| 结构化执行报告           | ✓            | ✓                            |
| 任务台账文件持久化       | ✓            | ✓(基础版,无原子迁移)         |
| system-prompt section    | ✓            | ✓                            |
| Web UI(看板)             | ✓            | ✗                            |
| cron 调度器              | ✓            | ✗                            |
| Worktree 隔离执行        | ✓            | ✗                            |
| 多仓库镜像 (0.6.3)       | ✓            | ✗                            |
| 外部会话自动同步 (0.5.5) | ✓            | ✗                            |
| 数据目录迁移             | ✓            | ✗                            |
| 任务模板                 | ✓            | ✗(数据模型预留,UI 不在范围)  |
| 图片附件                 | ✓            | ✗                            |
| 任务级 preset            | ✓            | ✓(数据模型,无 preset 解析器) |
| 模型/推理强度            | ✓            | ✓(数据模型,无 modelCatalog)  |

## 数据模型

台账顶层(写入 `~/.dsh/dsh-taskboard.json`):

```ts
interface Ledger {
  settings: {
    maxConcurrent: number;
    defaultUrgency: Urgency;
    defaultExecutionMode: ExecutionMode;
  };
  tasks: Task[]; // 任务,带 checklist / claim / version
  comments: Comment[]; // 流式追加,作为最新需求来源
  executions: ExecutionRecord[]; // 每次执行一条,带可选 report
  version: number; // 顶层乐观并发版本
}
```

任务核心字段:

```ts
interface Task {
  id: string; // t-xxxxxx
  title: string; // ≤200
  description: string; // Markdown
  prompt?: string; // 额外给 agent 的指令
  workspaceId: string; // 所属项目 → 跨项目边界
  status:
    | 'backlog'
    | 'todo'
    | 'in_progress'
    | 'in_review'
    | 'done'
    | 'canceled'
    | 'archived';
  urgency: 'urgent' | 'normal' | 'relaxed';
  execution:
    | { mode: 'claim' }
    | { mode: 'at'; runAt: number }
    | { mode: 'cron'; cron: string };
  model?: { provider: string; model: string; reasoningEffort?: string };
  presetId?: string;
  checklist: ChecklistItem[]; // ≤30,check 必带 note
  claimSessionId?: string; // 持有者
  claimOwner?: string;
  version: number; // 乐观并发
  createdAt: number;
  updatedAt: number;
  trashedAt?: number; // 软删除
}
```

## 测试覆盖

`src/index.test.ts` 覆盖:

- 插件契约(name / inject / 装载日志 / section / 10 个工具);
- Store CRUD + 状态机合法性;
- 协议闸(DONE_FORBIDDEN / TASK_HELD / CROSS_PROJECT_FORBIDDEN / VERSION_CONFLICT / ILLEGAL_TRANSITION);
- Checklist(check 必带 note、uncheck 清除证据、跨项目拒绝);
- 评论流 + 执行报告;
- 软删除 + 文件持久化(原子写、损坏文件 quarantine);
- 工具层(所有 10 个工具的关键路径)。

## 与原版的契约对齐

教学版尽量保持与 cloader/dsh-taskboard 一致的工具名、参数、错误码,使熟悉原版的用户/agent 无缝切换。差异点仅在能力面(UI/调度/隔离),不影响工具契约。
