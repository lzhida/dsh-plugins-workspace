# @lzhida/dsh-taskboard

教学版 dsh-taskboard 插件:复刻 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard#readme) 的核心契约,精简到适配本仓库工具链。

> **范围说明**:本包是 cloader/dsh-taskboard 0.8.x 的**架构与契约级教学复刻**,覆盖 10 个 `taskboard_*` agent 工具、ifVersion 乐观并发、代码级协议闸(agent 永远到不了 done / 被持有时不可抢 / 跨项目不可认领)、DoD 验收清单、结构化执行报告、system-prompt 协议 section。
>
> 与原版差异:**无 Web UI / 无 cron 调度器 / 无 worktree 隔离执行 / 无外部会话自动同步 / 无数据目录迁移**。这些是 cloader 的庞大能力,本教学版专注于核心契约的"代码闸"实现。

## 适配版本

| 组件     | 版本           | 说明                                                                                                        |
| -------- | -------------- | ----------------------------------------------------------------------------------------------------------- |
| 宿主 dsh | **0.2.0-rc.2** | `system-prompt` 与 `tools` 运行时对齐;`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已同步放行 rc.2。 |
| 插件包   | 0.1.0          | 插件版本号与 dsh 版本号解耦,只跟随契约调整升版本;此处不升。                                                 |

> rc.2 引入稀疏 system-prompt section 命名注册(`ctx.systemPrompt.getSectionOrder()`),但 README 明确 "External contributions may use any finite order"——本插件作为外部插件不受影响,section 名仍为唯一名 `tool:taskboard`,`order: 2950` 与 rc.2 一方稀疏序列按 name 排序兜底,model-visible 顺序不变。

## 安装

`dsh plugin add` 底层是 `pnpm add`,支持本地目录、`github:` / `git+https` / `git+ssh` / tarball 等多种源。本节给出本插件的四种常用形式。

### 仓库内开发(本地 link)

`packages/dsh-taskboard` 已在 pnpm workspaces 收录。仓库根执行一次 `pnpm install` 后:

```sh
dsh plugin add link:packages/dsh-taskboard
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层,无需 overlay 注入。

### Git 安装(外部用户 / CI 缓存场景)

以下四种形式等价,都只装 `packages/dsh-taskboard` 这个子包(其它子包不会拉入)。`<ref>` 替换为想锁定的分支 / tag / 提交(默认 = 远端默认分支 `main`):

```sh
# 1. github: 简写(pnpm 8+ 解析为 https://github.com/<user>/<repo>/tarball/<ref>)
dsh plugin add github:lzhida/dsh-plugins-workspace#main\&path:packages/dsh-taskboard

# 2. git+https(显式完整 URL,需 git 客户端)
dsh plugin add git+https://github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-taskboard

# 3. git+ssh(需本机配过 SSH key;CI 推镜像常用)
dsh plugin add git+ssh://git@github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-taskboard

# 4. tarball 快照(从 GitHub 直接拉 release tarball;适合离线 / 复现)
curl -L https://github.com/lzhida/dsh-plugins-workspace/archive/refs/heads/main.tar.gz | tar -xz -C /tmp
dsh plugin add /tmp/dsh-plugins-workspace-main/packages/dsh-taskboard
```

> `&path:<subdir>` 是 pnpm 安装 git monorepo 子目录的标准语法(`#<ref>&path:<dir>`,把 ref 与 subdir 用 `&` 分隔)。`<subdir>` 必须指向 monorepo 内一个真实存在的子目录。语法上 `git+ssh` 必须有 git 客户端(Windows 需 `scoop install git` 或 `choco install git`);`github:` 简写不依赖 git 客户端但需要 npm registry 联通 GitHub。**注意**:历史上本 README 写的是 `#<ref>:<subdir>`(冒号),是错误的,pnpm 11/12 会报 `Could not resolve <ref>:<subdir> to a commit` —— 必须用 `&path:`。

### monorepo 依赖说明

`dsh-taskboard` 的运行时依赖是 `@deepseek-ai/dsh-system-prompt` 与 `@deepseek-ai/dsh-tools`(均 `0.2.0-rc.2`)。git 安装仅拉取子包目录,dsh-tools / dsh-system-prompt 走 npm registry 解析。本仓库 `pnpm-workspace.yaml` 已把这两个以及全部传递 dsh-* 列入 `minimumReleaseAgeExclude`,允许 rc.2 通过。常见失败点:

- **GitHub 联通失败**:切换 npm 镜像(`npm config set registry https://registry.npmmirror.com`)或为 `git+https` 形式配置 HTTP 代理。
- **`@deepseek-ai/dsh-tools@0.2.0-rc.2` 拉不到**:确认 npm registry 已配置 `minimumReleaseAgeExclude` 白名单(本仓库已配;外部直接 `pnpm add` 可能被 pnpm 默认 release-age 拦截,加 `--no-strict-peer-dependencies` 与 `minimumReleaseAge=0` 兜底)。
- **subpath 解析失败**:确认 pnpm ≥ 8;旧版 pnpm 不支持 `#ref:subpath` 语法,需升 pnpm。

### 装好后的手工验证

```sh
# 1. 看子包是否真装入(本机 <DSH_HOME>/profiles/<name>/node_modules)
ls "$(dsh config profile-dir 2>/dev/null || echo $HOME/.dsh/profiles/<name>)/node_modules/@lzhida/dsh-taskboard"

# 2. 关键运行时依赖应该一并出现
ls "$(dsh config profile-dir 2>/dev/null || echo $HOME/.dsh/profiles/<name>)/node_modules/@deepseek-ai/dsh-tools"  # 版本 = 0.2.0-rc.2
ls "$(dsh config profile-dir 2>/dev/null || echo $HOME/.dsh/profiles/<name>)/node_modules/@deepseek-ai/dsh-system-prompt"  # 同上

# 3. 重启 dsh,在 settings → 插件中确认 "已启用"(详见 .agents/skills/dsh-plugin-dev 的 e2e 浏览器验证)
```

如果第 2 步找不到 `dsh-tools`,说明 git install 走了 subpath 但 npm 依赖没拉起——回到 "monorepo 依赖说明" 排查 release-age 与镜像。

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

### 升级到 dsh 0.2.0-rc.2 的变化

相比 0.1.0(对齐 dsh 0.2.0-rc.1),本次升级做了:

- 运行时依赖 `@deepseek-ai/dsh-system-prompt` / `@deepseek-ai/dsh-tools` 由 `0.2.0-rc.1` 升到 `0.2.0-rc.2`;根 `package.json` 与 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 同步升级;`pnpm-lock.yaml` 重生成。
- **不修改 `done` 协议闸、不修改 10 个工具的 schema 与返回形态**——契约层零破坏性变化。
- `system-prompt` section 名仍为 `tool:taskboard`(唯一名),`order: 2950` 不变。rc.2 引入的一方稀疏 section 序列按 name 排序兜底,model-visible 顺序不变;新增 `system-prompt section 文本不含未解析 {{var}}` 单测(rc.2 `renderPrompt` 对未注册变量会拒绝渲染)。
- **新功能:`taskboard_move → in_review` 调用 `exec.concludeTurn()`** — dsh 0.2.0-rc.2 的 `ToolRunContext` 新增 `concludeTurn()`,让工具把当前 turn 标记为终结。`in_review` 是 agent 工作流终点,加上 `concludeTurn` 后 loop 不会再让模型自动追加 tool calls(避免再调 in_review / 试探调 done / 写新评论等)。其它 `to` 状态(`todo` / `in_progress` / `canceled` / `archived`)不调用,允许后续的 checklist / comment / execution_report。`typeof exec.concludeTurn === 'function'` 守卫保证 rc.1 形态下不崩。
- **类型适配:`defaultResolveContext` 改用 dsh-tools 公开类型 `ToolRunContext`** — 0.1.x 内部 `as` 强转替换为公开类型,并对 `Agent` 在 rc.2 简化为 `{ id: SessionId }` 的变化做兼容(保留 `legacySession` 路径向后兼容测试 stub 与 0.1.x 形态)。生产部署建议注入 `workspaceRegistry` 自定义 `resolveContext`,用本函数做兜底。
- `TaskStore` 损坏文件 quarantine 副本命名升级为 `dsh-taskboard.json.corrupt.<pid>.<ms>.<uuid>`,新增对应单测覆盖并发 / 重复损坏场景,避免旧命名(`.<ms>`)在快速恢复时撞名。
- `index.ts` 创建 `DSH_HOME` 目录时的 `mkdir` 错误处理精细化:仅吞 `EEXIST`,其它错误重抛便于宿主诊断。
- `validateUpdatePatch` 删除了 `checked && note 空` 的死分支(注释说"不在 validate 拦截"实际未生效的哑代码),逻辑保持原契约。

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
