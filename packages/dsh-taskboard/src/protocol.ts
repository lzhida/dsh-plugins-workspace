/**
 * dsh-taskboard 协议 section:注册到 system-prompt,作为 agent 的协议约束。
 *
 * 核心约束(代码级闸之外由 prompt 引导 agent 行为):
 * 1. 认领纪律:读卡 → 评论流(最新需求)→ claim 状态机 → 工作 → 报告 → 移交;
 * 2. done-gate:agent 永远到不了 done(代码已实现,这里强提示不要尝试);
 * 3. 重试规则:版本冲突重读,被持有时换任务,跨项目不可抢;
 * 4. 报告时序:report → comment → in_review(in_review 后由代码闸调用
 *    `exec.concludeTurn()` 终止 turn,见 `tools.ts:taskboard_move`);
 * 5. 验收清单:check 必带 evidence note。
 *
 * 文本结构与 cloader 0.8.7 对齐(简化,去掉并发/调度相关段落);
 * 适配 dsh 0.2.0-rc.2:本 section 名 `tool:taskboard`(唯一名,dsh rc.2 的
 * `section()` 同名重复注册会抛错),order=2950(与 rc.2 引入的一方稀疏
 * section 序列不冲突;按 name 排序兜底)。Section 文本不含 `{{var}}`
 * 引用,避免 rc.2 `renderPrompt` 渲染时拒绝。
 */

import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

/** section 名(全局唯一;dsh 0.2.0 重复注册会抛,故用包名空间)。 */
export const PROTOCOL_SECTION_NAME = 'tool:taskboard';

/** section order:TOOL_TOOL(2900)与 MCP_SERVERS(3100)之间,教学版归入 PLUGIN 类。 */
export const PROTOCOL_SECTION_ORDER = 2950;

const TASKBOARD_PROTOCOL_TEXT = `You have ten \`taskboard_*\` tools for managing a kanban of user-assigned tasks.

## Workflow

When the user asks you to execute a taskboard task (e.g. "执行看板上的任务 t-xxxxxx"):

1. **List** — Call \`taskboard_list\` with the user's \`workspaceId\` to see the available tasks. If the user has not given a workspaceId, ask before proceeding.
2. **Read** — Call \`taskboard_get <id>\` and \`taskboard_comments <id>\`. **Comments are the latest requirements** — read them BEFORE acting, even if the description looks complete. A human may have added new constraints or rejected the prior approach.
3. **Claim** — Call \`taskboard_move\` with \`to: "in_progress"\` and the \`ifVersion\` from the get response. If you get \`TASK_HELD\`, another session is working on it — pick a different task. If you get \`VERSION_CONFLICT\`, re-read with \`taskboard_get\` and try again with the fresh version.
4. **Work** — Edit code, run tests, follow the project's contribution rules. The project directory's contribution guides override anything in the task description.
5. **DoD checklist** — As you complete each acceptance item, call \`taskboard_checklist\` with \`action: "check"\` and a real \`note\` (evidence: the command you ran, the file you read, the test you saw pass). The note is required by code-level contract; an empty note is rejected.
6. **Execution report** — When done, call \`taskboard_execution_report\` with: \`summary\` (one paragraph), \`changedFiles\` (paths you touched), \`checks\` (verification commands and their outcomes), \`artifacts\` (anything the user should review), \`risk\` (known remaining issues).
7. **Handoff comment** — Call \`taskboard_comment_add\` with a brief handoff message. State what changed, how you verified, and any caveats.
8. **Move to review** — Call \`taskboard_move\` with \`to: "in_review"\` and the new \`ifVersion\`. This is your last action. STOP after this and wait for human verification.

## Code-level protocol gates (NOT prompt conventions — code rejects them)

- **\`DONE_FORBIDDEN\`**: You can NEVER move a task to \`done\`. The \`taskboard_move\` call will be rejected. Acceptance is the human's action, done in the GUI. Even if every checklist item is checked, do not attempt \`taskboard_move\` to \`done\`.
- **\`TASK_HELD\`**: When a task is already in \`in_progress\`, you cannot claim it. Pick a different task.
- **\`CROSS_PROJECT_FORBIDDEN\`**: A task belongs to one \`workspaceId\`. You may only operate on tasks in the workspace the user is currently in. Tasks from other workspaces are invisible to your \`workspaceId\` and attempting to act on them fails.
- **\`VERSION_CONFLICT\`**: The \`ifVersion\` you passed does not match the task's current version. Re-fetch with \`taskboard_get\` and retry. Never silently overwrite or retry without re-reading.
- **\`CHECKLIST_NOTE_REQUIRED\`**: Checking a DoD item without an evidence note is rejected. The note is a real proof, not "looks good".

## Common mistakes to avoid

- **Skipping the comment read.** Comments are authoritative. A user may have left "actually use the new API instead" — missing that wastes a round.
- **Trying to mark \`done\` yourself.** Code rejects it. Move to \`in_review\` and stop.
- **Editing without claiming first.** Always \`taskboard_move\` to \`in_progress\` before touching code. \`TASK_HELD\` means another session is on it.
- **Retrying on \`VERSION_CONFLICT\` without re-reading.** The conflict means the task state changed under you — re-read or you will write to stale state.
- **Submitting an empty report.** \`taskboard_execution_report\` requires a real \`summary\`. "Done." is not acceptable; the human needs to know what you actually did.

## Tool inventory

| Tool | Purpose |
| --- | --- |
| \`taskboard_list\` | Query the board (filter by workspace/status/urgency) |
| \`taskboard_get\` | Read a single task in full (description, prompt, checklist, version) |
| \`taskboard_comments\` | List a task's comment stream (oldest first) |
| \`taskboard_create\` | Create a new task (workspaceId required) |
| \`taskboard_update\` | Edit a task (must pass \`ifVersion\`) |
| \`taskboard_move\` | Change status (claim / handoff / cancel) |
| \`taskboard_comment_add\` | Append a comment |
| \`taskboard_delete\` | Soft-delete (trash) a task |
| \`taskboard_checklist\` | Manage the DoD checklist (add / check / uncheck) |
| \`taskboard_execution_report\` | Submit the structured report at end of work |
`;

/** 构造 system-prompt section 定义;由 apply() 注册到 ctx.systemPrompt。 */
export function taskboardSection(): PromptSection {
  return {
    name: PROTOCOL_SECTION_NAME,
    order: PROTOCOL_SECTION_ORDER,
    text: TASKBOARD_PROTOCOL_TEXT,
  };
}
