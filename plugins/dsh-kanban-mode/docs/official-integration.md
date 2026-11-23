# 官方能力集成（forge / worktree / subagent 三件套）

本包（`@zhidal/dsh-kanban-mode`）对 DSH 官方增强能力做「纪律 + 文档」接入：
工作法文案、内嵌建卡 skill 与本文档描述官方 forge 变更请求（PR）、官方 worktree
隔离与官方进程外子代理三件套与看板验收链的衔接方式。

**总口径：三件套全部是条件增强，不是本包工作的前提。** 未启用 / 未安装时，
看板模式工作法、三工具与建卡 skill 完全不受影响——工作法「Git 收尾与变更请求」
段与本页的所有硬要求都只在对应能力被启用后才生效。

## 一、三件套启用步骤

### forge + worktree（变更请求与工作树）

1. 安装官方 bundle：`dsh plugin add @deepseek-ai/dsh-experimental-forge-bundle`
   （版本口径对齐 `0.2.2-rc.5`；首次不带版本安装可能落到旧版，装完核对版本号）。
2. bundle 会向 profile patch 插入六个插件行：`worktree` / `tool-worktree` /
   `forge` / `forge-github` / `forge-session` / 面板 UI 行（1/3 卡 spike 实读
   行名为 `forge-panel`；任务卡记录为 `client-ui-forge`，行名以实际安装的
   官方包版本为准）。
3. 六行默认**禁用**，需在插件页手动启用「变更请求与工作树」相关行。
4. 能力语义：
   - `forge` 是 provider-neutral 的变更请求注册表（共享状态轮询）；
   - `forge-github` 走宿主 `gh` CLI（`gh pr create/view/edit/checkout` 打开的
     PR 与分支 push 更新的 PR 自动出现在面板）；
   - `worktree` 提供官方工作树服务（`ctx.worktrees.create` 等）。

### worktree 服务与 dsh-taskboard 的软依赖

- 1/3 卡改造后的 `@zhidal/dsh-taskboard`（0.10.1 起）对官方 worktree 服务是
  **软依赖**：`ctx.get('worktrees')` 形状校验 fail-soft，零 `@deepseek-ai`
  运行时 import。
- 服务可用 → 官方 create 接管任务 worktree（`agents.create` → attach →
  setPermission → `ctx.worktrees.create(agent, { name: 'task/<标题>+<任务ID>', from })`）。
- 服务缺席 → `isolation: none` 降级并在启用提示里写明原因，工作流不阻塞。
- 详见 `plugins/dsh-taskboard/docs/official-worktree-spike.md`（spike 结论与
  能力边界表）。

### subagent（进程外子代理）

- 安装提供方插件：`dsh plugin add @deepseek-ai/dsh-subagent-codex` /
  `dsh plugin add @deepseek-ai/dsh-subagent-claude-code`。
- 提供方（OpenAI / Anthropic provider 行）归宿主层配置，本包预设只挂
  `dsh-tool-subagent` 工具行（`maxDepth: 'provider-managed'`），不挂 provider 行。
- 启用步骤、API key 注入与 CLI 自备要求详见 `docs/official-subagent.md`。

## 二、官方限制（如实声明）

| 能力     | 限制                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| forge    | 仅支持 GitHub / github.com 一个 provider（无 GitLab）；模型目前没有读取已绑定变更请求的工具，PR 信息只能靠执行会话回写看板                                                                                                          |
| worktree | 单仓单 worktree 池（`<repo>/.agents/worktrees/<branch>`），多仓镜像禁用；官方回收挂 Session 归档事件，冷会话回落 `retained`，纯 git 收尾（`merge --no-ff` / `git worktree remove` 非 force / `branch -d`）由 dsh-taskboard 插件保留 |
| subagent | one-shot 委派（每次新进程、无续接 / 无池化 / 无审批路径）；CLI 本机自备并登录（codex 协议基线 `@openai/codex@0.147.0`）；官方包 `publishConfig.access: restricted`                                                                  |

## 三、看板验收链衔接（启用 forge 后的闭环）

```text
worktree 隔离 → 任务分支（task/<标题>+<任务ID>）→ 执行会话完成改动后开 PR
→ PR URL 回写 execution_report 与任务评论 → 验收人按 PR diff / PR 审查
→ in_review → 用户确认 done
```

- **PR URL 回写是启用 forge 场景下的硬要求**：官方模型没有读取已绑定变更请求
  的工具，PR URL 不写回看板（execution_report + 评论），验收人就无从按 diff
  审查——验收链在这一步断掉。
- 验收口径不变：验收人确认后仍按「待验收 → 用户确认完成」走；PR 合并、分支
  清理属 git 收尾，交用户执行。
- 未启用 forge 时：执行会话按仓库常规 git 纪律收尾（分支与提交在工作目录内
  完成，push 交用户），不阻塞、不算未完成——本链路整段不适用。

## 四、与本包的落点对照

| 落点                                                    | 内容                                                                          |
| ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/context-text.ts`                                   | 工作法第七段「Git 收尾与变更请求」（条件式口径 + PR URL 回写硬要求）          |
| `src/skill/skill-content.ts`                            | 4.0 交接纪律、Verification 第 11 条、Pitfalls、硬约束第 19 条的同款条件式口径 |
| `docs/official-subagent.md`                             | subagent 三件套的启用步骤与限制                                               |
| `plugins/dsh-taskboard/docs/official-worktree-spike.md` | worktree 软依赖改造结论与能力边界                                             |
