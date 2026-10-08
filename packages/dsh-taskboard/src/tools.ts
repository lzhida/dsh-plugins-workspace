/**
 * dsh-taskboard agent 工具层:10 个 taskboard_* 工具,全部基于 TaskStore。
 *
 * 工具契约(对齐 cloader/dsh-taskboard):
 * - 每个工具的输出是 model 可见文本 + 结构化 result(text 形态供模型阅读);
 *   真正的 canonical 结构(任务/评论/清单)由 store 提供(测试用),不进
 *   模型可见的 content。本教学版统一用 text 形态 — 工具 description
 *   已经写明"输出文本",模型按文本来动作。
 * - 错误一律格式化为 `[CODE] message` 文本(模型可解析)。
 *
 * 与 dsh-tools 的对齐:
 * - 用 defineTool 注册,output.render 把结构化结果投影为 text;
 * - 系统提示 section 与 tool 同步注册,模型看得到工具就能读到协议。
 *
 * 设计选择:
 * - 这里把 tools 写成"工厂函数",接收 store + tools 注册器(便于单测);
 * - 真正在 apply() 里注入依赖,避免 ctx.tools 还没就绪时调用 register。
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import type { TaskStore } from './store.ts';
import {
  type ChecklistItem,
  CHECKLIST_MAX,
  CHECKLIST_NOTE_MAX,
  COMMENT_BODY_MAX,
  DESCRIPTION_DISPLAY_MAX,
  formatTaskboardError,
  type Task,
  type TaskStatus,
  type TaskSummary,
  type Urgency,
} from './types.ts';

/** 工具构造参数:store + author 解析器(从 ToolRunContext 抽取身份)。 */
export interface TaskboardToolsOptions {
  readonly store: TaskStore;
  /**
   * 从 execute 调用上下文抽取身份(workspaceId / author / authorKind / now)。
   * 若未提供,默认走「unknown workspaceId + author=system」;生产 ctx 注入
   * (agent.session.header.cwd → workspaceId;agent.id → author)。
   */
  readonly resolveContext?: (exec: unknown) => ResolvedCallContext;
}

/** 工具解析后的调用方身份(传给 store)。 */
export interface ResolvedCallContext {
  readonly workspaceId: string;
  readonly author: string;
  readonly authorKind: 'agent' | 'user' | 'system';
  readonly now: number;
}

/** 紧凑渲染:TaskSummary 一行展示(看板缩略)。 */
function renderSummary(s: TaskSummary): string {
  const progress =
    s.checklistProgress === undefined
      ? ''
      : ` ☑ ${s.checklistProgress.checked}/${s.checklistProgress.total}`;
  const held = s.claimSessionId === undefined ? '' : ` 🔒${s.claimSessionId}`;
  return `[${s.id}] (${s.urgency}) ${s.title}${progress}${held}`;
}

/** 任务详情渲染(供 get / 状态变更后回显)。 */
function renderTask(task: Task): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push(
    `id: ${task.id}  status: ${task.status}  urgency: ${task.urgency}  version: ${task.version}`,
  );
  lines.push(`workspace: ${task.workspaceId}`);
  if (task.claimSessionId !== undefined) {
    lines.push(
      `claim: ${task.claimSessionId}${task.claimOwner !== undefined && task.claimOwner !== task.claimSessionId ? ` (${task.claimOwner})` : ''}`,
    );
  }
  lines.push(`execution: ${renderExecution(task)}`);
  if (task.model !== undefined) {
    lines.push(
      `model: ${task.model.provider}/${task.model.model}${task.model.reasoningEffort !== undefined ? ` (effort=${task.model.reasoningEffort})` : ''}`,
    );
  }
  if (task.presetId !== undefined) lines.push(`preset: ${task.presetId}`);
  if (task.description.length > 0) {
    lines.push('');
    lines.push('## Description');
    lines.push(truncate(task.description, DESCRIPTION_DISPLAY_MAX));
  }
  if (task.prompt !== undefined && task.prompt.length > 0) {
    lines.push('');
    lines.push('## Prompt');
    lines.push(truncate(task.prompt, DESCRIPTION_DISPLAY_MAX));
  }
  if (task.checklist.length > 0) {
    lines.push('');
    lines.push(
      `## DoD Checklist (${task.checklist.filter((c) => c.checked).length}/${task.checklist.length})`,
    );
    for (const item of task.checklist) {
      const box = item.checked ? '[x]' : '[ ]';
      const note =
        item.note === undefined ? '' : ` — ${truncate(item.note, 200)}`;
      lines.push(`- ${box} ${item.text}${note}`);
    }
  }
  return lines.join('\n');
}

function renderExecution(task: Task): string {
  const e = task.execution;
  if (e.mode === 'claim') return 'claim (manual)';
  if (e.mode === 'at') return `at (${new Date(e.runAt).toISOString()})`;
  return `cron (${e.cron})`;
}

function truncate(s: string, max: number): string {
  return s.length <= max
    ? s
    : `${s.slice(0, max)}\n…(truncated, total ${s.length} chars)`;
}

/** 默认 ctx 解析:从 ToolRunContext 抽取身份,失败兜底为 system/unknown。 */
function defaultResolveContext(exec: unknown): ResolvedCallContext {
  const e = exec as
    | {
        agent?: {
          id?: string;
          session?: { id?: string; header?: { cwd?: string } };
        };
      }
    | undefined;
  const session = e?.agent?.session;
  const author = e?.agent?.id ?? session?.id ?? 'system';
  // workspaceId 优先从 session.header.cwd 抽取绝对路径的 basename + parent(简化:取 cwd)
  const workspaceId = session?.header?.cwd ?? 'unknown';
  return { workspaceId, author, authorKind: 'agent', now: Date.now() };
}

/** 工具工厂:返回 10 个 tool 定义 + 一个注册所有工具的便捷函数。 */
export function createTaskboardTools(options: TaskboardToolsOptions) {
  const { store } = options;
  const resolveCtx = options.resolveContext ?? defaultResolveContext;

  /** 包一层 execute:把异常格式化为 `[CODE] message` 文本抛出,模型可读。 */
  async function withErrorBoundary<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      // 全部错误抛文本(tool 框架把它当作 isError);保留 cause 供调试链
      throw new Error(formatTaskboardError(error), { cause: error });
    }
  }

  // ── 1. taskboard_list ─────────────────────────────────────────────

  const list = defineTool({
    name: 'taskboard_list',
    description:
      'List tasks on the kanban for the calling project. Filter by status (todo / in_progress / in_review / done / backlog / canceled / archived), urgency (urgent / normal / relaxed), or include trashed. ' +
      'Returns a compact one-line summary per task. Use this first to see what is available before claiming.',
    parameters: {
      workspaceId: {
        type: 'string',
        description:
          'Project id (DSH workspace) to scope the query to. Defaults to the calling agent workspace.',
      },
      status: {
        type: 'string',
        enum: [
          'backlog',
          'todo',
          'in_progress',
          'in_review',
          'done',
          'canceled',
          'archived',
        ],
        description:
          'Filter by exact status. Omit to include all non-trashed statuses.',
      },
      urgency: {
        type: 'string',
        enum: ['urgent', 'normal', 'relaxed'],
        description: 'Filter by urgency.',
      },
      includeTrashed: {
        type: 'boolean',
        description: 'Include soft-deleted tasks (default false).',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as {
          workspaceId?: string;
          status?: TaskStatus;
          urgency?: Urgency;
          includeTrashed?: boolean;
        };
        const workspaceId = a.workspaceId ?? ctx.workspaceId;
        const tasks = store.list({
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(a.status !== undefined ? { status: a.status } : {}),
          ...(a.urgency !== undefined ? { urgency: a.urgency } : {}),
          ...(a.includeTrashed === true ? { includeTrashed: true } : {}),
        });
        const text =
          tasks.length === 0
            ? `No tasks found (workspace=${workspaceId ?? '(any)'}${a.status !== undefined ? `, status=${a.status}` : ''}).`
            : `Found ${tasks.length} task(s):\n${tasks.map(renderSummary).join('\n')}`;
        return { text, count: tasks.length };
      });
    },
  });

  // ── 2. taskboard_get ──────────────────────────────────────────────

  const get = defineTool({
    name: 'taskboard_get',
    description:
      'Read one task in full: description, prompt, checklist with check status, execution config, model/preset selection, claim info, and current version. ' +
      'The version is required for any subsequent taskboard_update / taskboard_move / taskboard_checklist call (used as ifVersion for optimistic concurrency).',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'Task id (e.g. t-ab12cd).',
      },
      includeTrashed: {
        type: 'boolean',
        description: 'Include trashed task (default false).',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
          version: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, _exec) {
      void _exec;
      return withErrorBoundary(async () => {
        const a = args as { id: string; includeTrashed?: boolean };
        const task = store.get(a.id, {
          includeTrashed: a.includeTrashed === true,
        });
        if (task === undefined) {
          throw new Error(`[TASK_NOT_FOUND] 任务 ${a.id} 不存在或已删除`);
        }
        return { text: renderTask(task), id: task.id, version: task.version };
      });
    },
  });

  // ── 3. taskboard_comments ─────────────────────────────────────────

  const comments = defineTool({
    name: 'taskboard_comments',
    description:
      'List the comment stream of a task (oldest first). Comments are authoritative — they override the task description if they disagree. ' +
      'Always read comments BEFORE starting work, even if the task description looks complete.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, _exec) {
      void _exec;
      return withErrorBoundary(async () => {
        const a = args as { id: string };
        const list = store.commentsFor(a.id);
        const task = store.get(a.id, { includeTrashed: true });
        if (task === undefined) {
          throw new Error(`[TASK_NOT_FOUND] 任务 ${a.id} 不存在或已删除`);
        }
        const text =
          list.length === 0
            ? `任务 ${a.id} 暂无评论。`
            : `共 ${list.length} 条评论:\n\n` +
              list
                .map((c) => {
                  const when = new Date(c.createdAt).toISOString();
                  return `### [${c.authorKind}] ${c.author} @ ${when}\n${c.body}`;
                })
                .join('\n\n');
        return { text, count: list.length };
      });
    },
  });

  // ── 4. taskboard_create ───────────────────────────────────────────

  const create = defineTool({
    name: 'taskboard_create',
    description:
      'Create a new task on the board. workspaceId is required. Optional: urgency, execution mode (claim / at / cron), model selection, agent preset id, and the initial DoD checklist (≤30 items, each ≤200 chars). ' +
      'New tasks start in `todo` and are owned by the calling project.',
    parameters: {
      workspaceId: {
        type: 'string',
        required: true,
        description: 'Project id (DSH workspace) the task belongs to.',
      },
      title: {
        type: 'string',
        required: true,
        description: 'Task title (≤200 chars).',
      },
      description: {
        type: 'string',
        description: 'Markdown description (optional).',
      },
      prompt: {
        type: 'string',
        description: 'Extra prompt for the agent (optional).',
      },
      urgency: {
        type: 'string',
        enum: ['urgent', 'normal', 'relaxed'],
        description: 'Urgency; defaults to the board default.',
      },
      // 嵌套对象:用 type: 'json' 接受任意 JSON(教学版宽容模式;
      // production 应严格定义 additionalProperties:false + properties 树)。
      execution: {
        type: 'json',
        description:
          'Execution spec: { mode: "claim" } | { mode: "at", runAt: <epoch ms> } | { mode: "cron", cron: "<expr>" }. Default: claim.',
      },
      model: {
        type: 'json',
        description:
          'Pin a model: { provider, model, reasoningEffort? }. Omit to follow the deployment default.',
      },
      presetId: {
        type: 'string',
        description: 'Agent preset id to use for executions.',
      },
      checklist: {
        type: 'array',
        items: { type: 'string' },
        description: `Initial DoD checklist (≤${CHECKLIST_MAX} strings, each ≤200 chars).`,
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
          version: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as unknown as {
          workspaceId: string;
          title: string;
          description?: string;
          prompt?: string;
          urgency?: Urgency;
          execution?:
            | { mode: 'claim' }
            | { mode: 'at'; runAt: number }
            | { mode: 'cron'; cron: string };
          model?: { provider: string; model: string; reasoningEffort?: string };
          presetId?: string;
          checklist?: readonly string[];
        };
        const task = await store.create(ctx, {
          workspaceId: a.workspaceId,
          title: a.title,
          ...(a.description !== undefined
            ? { description: a.description }
            : {}),
          ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a.urgency !== undefined ? { urgency: a.urgency } : {}),
          ...(a.execution !== undefined ? { execution: a.execution } : {}),
          ...(a.model !== undefined ? { model: a.model } : {}),
          ...(a.presetId !== undefined ? { presetId: a.presetId } : {}),
          ...(a.checklist !== undefined
            ? { checklist: a.checklist.map((t) => ({ text: t })) }
            : {}),
        });
        return {
          text: `已创建任务 ${task.id}。\n${renderTask(task)}`,
          id: task.id,
          version: task.version,
        };
      });
    },
  });

  // ── 5. taskboard_update ───────────────────────────────────────────

  const update = defineTool({
    name: 'taskboard_update',
    description:
      'Edit a task. Pass only the fields you want to change (omitted fields are left alone). ' +
      "`ifVersion` is REQUIRED: it must match the task's current version. On mismatch you get VERSION_CONFLICT — re-read with taskboard_get and retry with the new version. " +
      'You cannot change status with this tool; use taskboard_move.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      ifVersion: {
        type: 'integer',
        required: true,
        description: 'The version you read (optimistic concurrency).',
      },
      title: { type: 'string' },
      description: { type: 'string' },
      prompt: { type: 'string' },
      urgency: { type: 'string', enum: ['urgent', 'normal', 'relaxed'] },
      execution: {
        type: 'json',
        description: 'Replace the execution spec.',
      },
      model: {
        type: 'json',
        description: 'Replace the model selection.',
      },
      presetId: { type: 'string' },
      checklist: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            text: { type: 'string', required: true },
            checked: { type: 'boolean' },
            note: { type: 'string' },
          },
        },
        description:
          'Replace the entire checklist (≤30 items). To check/uncheck individual items, use taskboard_checklist.',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
          version: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as unknown as {
          id: string;
          ifVersion: number;
          title?: string;
          description?: string;
          prompt?: string;
          urgency?: Urgency;
          execution?:
            | { mode: 'claim' }
            | { mode: 'at'; runAt: number }
            | { mode: 'cron'; cron: string };
          model?: { provider: string; model: string; reasoningEffort?: string };
          presetId?: string;
          checklist?: readonly {
            id?: string;
            text: string;
            checked?: boolean;
            note?: string;
          }[];
        };
        const next = await store.update(ctx, a.id, a.ifVersion, {
          ...(a.title !== undefined ? { title: a.title } : {}),
          ...(a.description !== undefined
            ? { description: a.description }
            : {}),
          ...(a.prompt !== undefined ? { prompt: a.prompt } : {}),
          ...(a.urgency !== undefined ? { urgency: a.urgency } : {}),
          ...(a.execution !== undefined ? { execution: a.execution } : {}),
          ...(a.model !== undefined ? { model: a.model } : {}),
          ...(a.presetId !== undefined ? { presetId: a.presetId } : {}),
          ...(a.checklist !== undefined
            ? {
                checklist: a.checklist.map<ChecklistItem>((c) => ({
                  id: c.id ?? `cli-${Math.random().toString(36).slice(2, 8)}`,
                  text: c.text,
                  checked: c.checked === true,
                  ...(c.note !== undefined ? { note: c.note } : {}),
                })),
              }
            : {}),
        });
        return {
          text: `已更新任务 ${next.id} (v${next.version})。\n${renderTask(next)}`,
          id: next.id,
          version: next.version,
        };
      });
    },
  });

  // ── 6. taskboard_move ─────────────────────────────────────────────

  const move = defineTool({
    name: 'taskboard_move',
    description:
      "Change a task's status. The state machine is: backlog → todo → in_progress → in_review → (done) → archived. " +
      '`to: "in_progress"` claims the task (sets claimSessionId to the caller). ' +
      '`to: "in_review"` is the handoff at end of work. ' +
      '`to: "todo"` releases the claim. ' +
      "Code-level gates: you CANNOT move to `done` (DONE_FORBIDDEN — acceptance is the human's action); you CANNOT claim a task another session already holds (TASK_HELD); you CANNOT operate across projects (CROSS_PROJECT_FORBIDDEN). " +
      'On VERSION_CONFLICT, re-read with taskboard_get and retry.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      to: {
        type: 'string',
        required: true,
        enum: [
          'backlog',
          'todo',
          'in_progress',
          'in_review',
          'canceled',
          'archived',
        ],
        description: 'Target status. `done` is FORBIDDEN via this tool.',
      },
      ifVersion: {
        type: 'integer',
        required: true,
        description: 'The version you read (optimistic concurrency).',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
          version: { type: 'integer' },
          status: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as { id: string; to: TaskStatus; ifVersion: number };
        const next = await store.move(ctx, a.id, a.to, a.ifVersion);
        return {
          text: `任务 ${next.id} 状态 → ${next.status} (v${next.version})`,
          id: next.id,
          version: next.version,
          status: next.status,
        };
      });
    },
  });

  // ── 7. taskboard_comment_add ──────────────────────────────────────

  const commentAdd = defineTool({
    name: 'taskboard_comment_add',
    description:
      'Append a comment to a task. Use this for: progress notes, handoff messages to the next agent or human reviewer, "actually, the user asked for X" updates, risk callouts. ' +
      `Body must be ≤${COMMENT_BODY_MAX} chars.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      body: {
        type: 'string',
        required: true,
        description: `Comment body (≤${COMMENT_BODY_MAX} chars).`,
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
          commentId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as { id: string; body: string };
        if (a.body.length > COMMENT_BODY_MAX) {
          throw new Error(
            `[INVALID_INPUT] 评论长度 ${a.body.length} > ${COMMENT_BODY_MAX}`,
          );
        }
        const c = await store.addComment(ctx, a.id, a.body);
        return {
          text: `已追加评论 (${c.id}) 到任务 ${a.id}。\n\n### [${c.authorKind}] ${c.author}\n${c.body}`,
          id: a.id,
          commentId: c.id,
        };
      });
    },
  });

  // ── 8. taskboard_delete ───────────────────────────────────────────

  const del = defineTool({
    name: 'taskboard_delete',
    description:
      'Soft-delete a task. The task data is preserved (trashedAt is set) for audit, but it disappears from default listings. ' +
      'ifVersion is required. To actually purge, the user does it in the GUI; this tool only marks.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      ifVersion: {
        type: 'integer',
        required: true,
        description: 'The version you read (optimistic concurrency).',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as { id: string; ifVersion: number };
        const next = await store.trash(ctx, a.id, a.ifVersion);
        return {
          text: `已软删除任务 ${next.id} (v${next.version});数据保留供审计,看板不再展示。`,
          id: next.id,
        };
      });
    },
  });

  // ── 9. taskboard_checklist ────────────────────────────────────────

  const checklist = defineTool({
    name: 'taskboard_checklist',
    description:
      'Manage the DoD checklist. `action: "add"` appends a new item (text required). `action: "check"` marks an item done (itemId + note BOTH required — note is the evidence, code rejects empty). `action: "uncheck"` clears an item (itemId required). ' +
      `Total items capped at ${CHECKLIST_MAX}; note capped at ${CHECKLIST_NOTE_MAX} chars.`,
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      ifVersion: {
        type: 'integer',
        required: true,
        description: 'The version you read (optimistic concurrency).',
      },
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'check', 'uncheck'],
        description: 'add | check | uncheck',
      },
      itemId: { type: 'string', description: 'Required for check / uncheck.' },
      text: {
        type: 'string',
        description: 'Required for add. Item text (≤200 chars).',
      },
      note: {
        type: 'string',
        description: `Required for check. Evidence note (≤${CHECKLIST_NOTE_MAX} chars; describe the proof: command, file, test).`,
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
          version: { type: 'integer' },
          itemId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as {
          id: string;
          ifVersion: number;
          action: 'add' | 'check' | 'uncheck';
          itemId?: string;
          text?: string;
          note?: string;
        };
        const { task, item } = await store.checklist(
          ctx,
          a.id,
          a.ifVersion,
          a.action,
          {
            ...(a.itemId !== undefined ? { itemId: a.itemId } : {}),
            ...(a.text !== undefined ? { text: a.text } : {}),
            ...(a.note !== undefined ? { note: a.note } : {}),
          },
        );
        const verb =
          a.action === 'add'
            ? '已新增'
            : a.action === 'check'
              ? '已勾选'
              : '已取消勾选';
        const itemDesc = item === undefined ? '' : `「${item.text}」`;
        return {
          text: `${verb}验收项 ${itemDesc} (任务 ${task.id} v${task.version})`,
          id: task.id,
          version: task.version,
          ...(item !== undefined ? { itemId: item.id } : {}),
        };
      });
    },
  });

  // ── 10. taskboard_execution_report ────────────────────────────────

  const executionReport = defineTool({
    name: 'taskboard_execution_report',
    description:
      'Submit a structured execution report at the end of work. Fields: `summary` (one paragraph, REQUIRED), `changedFiles` (paths touched), `checks` (verification commands + outcomes), `artifacts` (files/links the human should review), `risk` (known remaining issues). ' +
      'Call this BEFORE `taskboard_comment_add` and `taskboard_move to "in_review"`. The order matters: report → comment → in_review.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      executionId: {
        type: 'string',
        description:
          'Execution record id. If omitted, a new record is created lazily.',
      },
      summary: {
        type: 'string',
        required: true,
        description: 'What you did, in one paragraph.',
      },
      changedFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of file paths you changed.',
      },
      checks: {
        type: 'array',
        items: { type: 'string' },
        description: 'Verification commands and their outcomes.',
      },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Artifacts the human should review.',
      },
      risk: {
        type: 'string',
        description: 'Known remaining risks or follow-ups.',
      },
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          id: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: (value as { text: string }).text },
      ],
    },
    async execute(args, exec) {
      return withErrorBoundary(async () => {
        const ctx = resolveCtx(exec);
        const a = args as {
          id: string;
          executionId?: string;
          summary: string;
          changedFiles?: readonly string[];
          checks?: readonly string[];
          artifacts?: readonly string[];
          risk?: string;
        };
        const executionId =
          a.executionId ?? `exec-${Math.random().toString(36).slice(2, 10)}`;
        const { task, execution } = await store.submitReport(
          ctx,
          a.id,
          executionId,
          {
            summary: a.summary,
            changedFiles: a.changedFiles ?? [],
            checks: a.checks ?? [],
            artifacts: a.artifacts ?? [],
            ...(a.risk !== undefined ? { risk: a.risk } : {}),
          },
        );
        return {
          text: renderReport(task.id, execution.id, execution.report),
          id: task.id,
        };
      });
    },
  });

  return {
    tools: {
      taskboard_list: list,
      taskboard_get: get,
      taskboard_comments: comments,
      taskboard_create: create,
      taskboard_update: update,
      taskboard_move: move,
      taskboard_comment_add: commentAdd,
      taskboard_delete: del,
      taskboard_checklist: checklist,
      taskboard_execution_report: executionReport,
    },
    /** 便捷:一次性注册全部工具,返回清理函数。 */
    registerAll(
      register: (tool: ReturnType<typeof defineTool>) => () => void,
    ): () => void {
      const allTools = [
        list,
        get,
        comments,
        create,
        update,
        move,
        commentAdd,
        del,
        checklist,
        executionReport,
      ];
      const disposers = allTools.map((t) => register(t));
      return () => {
        for (const d of disposers) d();
      };
    },
  };
}

function renderReport(
  taskId: string,
  executionId: string,
  report:
    | {
        summary: string;
        changedFiles: readonly string[];
        checks: readonly string[];
        artifacts: readonly string[];
        risk?: string;
      }
    | undefined,
): string {
  if (report === undefined) {
    return `执行报告未生成 (${taskId} / ${executionId})`;
  }
  const lines: string[] = [];
  lines.push(`## Execution report (${executionId})`);
  lines.push('');
  lines.push('### Summary');
  lines.push(report.summary);
  if (report.changedFiles.length > 0) {
    lines.push('');
    lines.push('### Changed files');
    for (const f of report.changedFiles) lines.push(`- ${f}`);
  }
  if (report.checks.length > 0) {
    lines.push('');
    lines.push('### Checks');
    for (const c of report.checks) lines.push(`- ${c}`);
  }
  if (report.artifacts.length > 0) {
    lines.push('');
    lines.push('### Artifacts');
    for (const a of report.artifacts) lines.push(`- ${a}`);
  }
  if (report.risk !== undefined && report.risk.length > 0) {
    lines.push('');
    lines.push('### Risk');
    lines.push(report.risk);
  }
  return lines.join('\n');
}
