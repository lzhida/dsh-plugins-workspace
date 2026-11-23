/**
 * 工具三 kanban_schedule_run（写）：为一张目标卡生成「看板模式定时执行卡」。
 *
 * 写路径只走 boardService.createTask（上游 task-writer 的唯一建卡实现），
 * 本工具不复制第二份建卡逻辑；上游负责 execution 归一化、blockedBy 同项目
 * 校验、成环与缺失前置拒绝。
 *
 * 生成卡契约：
 *   - status='todo'、urgency='normal'；
 *   - execution={mode:'scheduled', cron|runAt}（cron 与 runAt 恰好一个）；
 *   - presetId='kanban-mode' 写死——部署默认预设不可控，定时卡的执行会话
 *     必须显式拿到看板模式工作法，不能赌部署默认；
 *   - blockedBy=[targetTaskId]（目标卡交付前本卡不会被调度执行）；
 *   - checklist 留空（验收项由目标卡自身携带）；
 *   - prompt 内置无人值守纪律模板（先查目标卡 → 前置未满足则立即停止并
 *     comment_add → 可执行才按目标卡 prompt 执行 → 自验 → execution_report
 *     → 移 in_review；不得自行移到 done）。
 *
 * @module dsh-kanban-mode/tools/schedule-run
 */

import {
  requireBoardService,
  TOOL_ERR,
  type BoardServiceConsumerContext,
  type BoardServiceContract,
  type BoardTaskRecord,
} from './board-contract.ts';
import { defineTool } from './define-tool.ts';

/** 工具名。 */
export const SCHEDULE_RUN_TOOL_NAME = 'kanban_schedule_run';

/** 工具描述。 */
export const SCHEDULE_RUN_TOOL_DESCRIPTION =
  '为一张目标卡生成「看板模式定时执行卡」（写操作）：新卡 presetId 固定 kanban-mode、blockedBy 锁定目标卡、execution 为 scheduled（cron 定期或 runAt 一次性二选一）。用于无人值守 / 非高峰期自动执行看板任务的场景；触发时执行会话先检查目标卡状态，前置未满足则立即停止。需要 dsh-taskboard 插件提供的板服务。';

/** 入参形状。 */
export interface ScheduleRunArgs {
  /** 必填：目标卡 id。 */
  readonly targetTaskId: string;
  /** RFC 5545 五段 cron（定期）；与 runAt 二选一。 */
  readonly cron?: string;
  /** ISO 时间串或 epoch ms（一次性）；与 cron 二选一。 */
  readonly runAt?: string | number;
  /** 可选：新卡标题；缺省「定时执行：<目标卡 title>」。 */
  readonly title?: string;
  /** 可选：附加说明（写进新卡 description）。 */
  readonly note?: string;
  /** 可选：新卡项目；缺省取目标卡所属项目（blockedBy 必须同项目）。 */
  readonly workspaceId?: string;
}

/** 返回值形状（生成卡的关键字段）。 */
export interface ScheduleRunValue {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly execution: {
    readonly mode: string;
    readonly cron?: string;
    readonly runAt?: number;
  };
  readonly presetId: string;
  readonly blockedBy: readonly string[];
}

/** 写死的新卡预设 id（显式覆盖部署默认 preset）。 */
export const SCHEDULE_PRESET_ID = 'kanban-mode';

/**
 * 生成卡描述：说明本卡职责 + 无人值守用途 + 已知限制。
 */
export function buildScheduleDescription(
  targetTaskId: string,
  note?: string,
): string {
  const lines = [
    '【看板模式定时执行卡】本卡由 kanban_schedule_run 生成，负责在触发时执行目标卡 ' +
      `${targetTaskId}（blockedBy 已锁定该前置：目标卡未交付前本卡不会被调度执行）。`,
    '用途：无人值守执行 / 非高峰期窗口（如凌晨、周末）等不需要人在场的场景。',
    '已知限制：一次性 runAt 错过触发窗口（宿主离线超过 scheduleMissedAfterMinutes，默认 5 分钟）会回退为普通 claim 卡，不补跑；建议优先使用周期 cron。宿主 scheduler 全局并发默认 maxConcurrent=3、每分钟 tick。',
  ];
  if (note !== undefined && note.trim().length > 0) {
    lines.push(`附加说明：${note.trim()}`);
  }
  return lines.join('\n');
}

/**
 * 生成卡 prompt：内置无人值守纪律模板（写死在工具内）。
 * 锚点：目标卡不在 todo/in_progress 或前置未满足则立即停止并 comment_add，
 * 不得强行执行；严禁自行移到 done。
 */
export function buildSchedulePrompt(targetTaskId: string): string {
  return [
    '【看板模式定时执行纪律（kanban-mode 预设卡）】',
    `1. 先读后动：先 taskboard_get 目标卡 ${targetTaskId} 并读全部评论（评论视为最新需求；若要求等待/暂缓，停下并在本卡 comment_add 说明，不改目标卡状态）。`,
    `2. 前置门禁：若目标卡不在 todo / in_progress，或 dependency_blocked（前置未满足）则立即停止：用 taskboard_comment_add 记录原因，不得强行执行。`,
    `3. 可执行确认：用 kanban_ready_cards 确认目标卡可执行后，按目标卡的 prompt 执行。`,
    '4. 交接纪律：自验 → taskboard_execution_report 提交结构化报告；报告接口失败时改用 taskboard_comment_add 归档同一份报告 → 把本卡移到 in_review。',
    '5. 不得自行移到 done：done 是用户确认动作，执行者严禁代点；验收归人。',
  ].join('\n');
}

/** 校验 cron / runAt 恰好提供一个，返回归一化后的 execution 输入。 */
function resolveExecution(args: ScheduleRunArgs): {
  mode: 'scheduled';
  cron?: string;
  runAt?: string | number;
} {
  const hasCron = typeof args.cron === 'string' && args.cron.trim().length > 0;
  const hasRunAt = args.runAt !== undefined && args.runAt !== null;
  if (hasCron === hasRunAt) {
    throw new Error(
      `Error: ${TOOL_ERR.invalidInput}: cron 与 runAt 恰好提供一个（定期 cron 或一次性 runAt，二选一）`,
    );
  }
  return hasCron
    ? { mode: 'scheduled', cron: (args.cron as string).trim() }
    : { mode: 'scheduled', runAt: args.runAt as string | number };
}

/**
 * 校验目标卡存在性与同项目约束，返回目标卡记录。
 */
function resolveTarget(
  board: BoardServiceContract,
  args: ScheduleRunArgs,
): BoardTaskRecord {
  const target = board.getTask(args.targetTaskId);
  if (target === undefined) {
    throw new Error(
      `Error: ${TOOL_ERR.notFound}: 目标卡不存在：${args.targetTaskId}（先用 taskboard_get 确认 id，已删除的卡也会命中此错误）`,
    );
  }
  if (
    args.workspaceId !== undefined &&
    args.workspaceId !== target.workspaceId
  ) {
    throw new Error(
      `Error: ${TOOL_ERR.workspaceMismatch}: workspaceId（${args.workspaceId}）必须与目标卡所属项目一致（${target.workspaceId}）——blockedBy 前置必须同项目`,
    );
  }
  return target;
}

/**
 * 生成定时执行卡（走 boardService.createTask 唯一写路径）。
 * 返回前用 getTask 回读完整记录补 execution/presetId/blockedBy（上游
 * TaskSummary 不携带这三者的完整形状）。
 */
export async function buildScheduleRunValue(
  board: BoardServiceContract,
  args: ScheduleRunArgs,
): Promise<ScheduleRunValue> {
  const target = resolveTarget(board, args);
  const execution = resolveExecution(args);
  const workspaceId = args.workspaceId ?? target.workspaceId;
  const trimmedTitle = args.title?.trim();
  const title =
    trimmedTitle !== undefined && trimmedTitle.length > 0
      ? trimmedTitle
      : `定时执行：${target.title}`;
  const summary = await board.createTask({
    title,
    workspaceId,
    urgency: 'normal',
    status: 'todo',
    execution,
    presetId: SCHEDULE_PRESET_ID,
    blockedBy: [args.targetTaskId],
    description: buildScheduleDescription(args.targetTaskId, args.note),
    prompt: buildSchedulePrompt(args.targetTaskId),
  });
  const created = board.getTask(summary.id);
  return {
    id: summary.id,
    title: created?.title ?? summary.title,
    status: summary.status,
    execution: {
      mode: created?.execution.mode ?? 'scheduled',
      ...(created?.execution.cron !== undefined
        ? { cron: created.execution.cron }
        : {}),
      ...(created?.execution.runAt !== undefined
        ? { runAt: created.execution.runAt }
        : {}),
    },
    presetId: created?.presetId ?? SCHEDULE_PRESET_ID,
    blockedBy: created?.blockedBy ?? [args.targetTaskId],
  };
}

/** render：生成卡的关键事实（id/execution/presetId/blockedBy 齐全）。 */
function renderScheduleRun(value: ScheduleRunValue): string[] {
  const exec =
    value.execution.cron !== undefined
      ? `scheduled cron=${value.execution.cron}`
      : `scheduled runAt=${new Date(value.execution.runAt ?? 0).toISOString()}`;
  const lines = [
    '已生成看板模式定时执行卡：',
    `- ${value.id}「${value.title}」 status=${value.status}`,
    `- execution: ${exec}`,
    `- presetId: ${value.presetId}`,
    `- blockedBy: [${value.blockedBy.join(', ')}]`,
    '触发时执行会话按内置纪律先检查目标卡状态（不在 todo/in_progress 或前置未满足则立即停止并留评论）；目标卡交付前本卡不会被调度执行。',
    '提醒：一次性 runAt 错过窗口会回退 claim 不补跑；周期任务建议用 cron。',
  ];
  return lines;
}

/** 构造 kanban_schedule_run 工具定义（execute 时惰性软读取板服务）。 */
export function buildScheduleRunTool(
  ctx: BoardServiceConsumerContext,
): ReturnType<typeof defineTool<ScheduleRunArgs, ScheduleRunValue>> {
  return defineTool<ScheduleRunArgs, ScheduleRunValue>({
    name: SCHEDULE_RUN_TOOL_NAME,
    description: SCHEDULE_RUN_TOOL_DESCRIPTION,
    parameters: {
      targetTaskId: {
        type: 'string',
        required: true,
        description: '必填：目标卡 id（定时触发时执行的那张卡）',
      },
      cron: {
        type: 'string',
        description: 'RFC 5545 五段 cron 表达式（定期执行）；与 runAt 二选一',
      },
      runAt: {
        type: 'json',
        description: '一次性触发时间：ISO 时间串或 epoch ms；与 cron 二选一',
      },
      title: {
        type: 'string',
        description: '可选：新卡标题；缺省「定时执行：<目标卡 title>」',
      },
      note: {
        type: 'string',
        description: '可选：附加说明（写入新卡 description）',
      },
      workspaceId: {
        type: 'string',
        description:
          '可选：新卡所属项目；缺省取目标卡所属项目（blockedBy 必须同项目）',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        { type: 'text', text: renderScheduleRun(value).join('\n') },
      ],
    },
    async execute(args) {
      const board = requireBoardService(ctx);
      return buildScheduleRunValue(board, args);
    },
  });
}
