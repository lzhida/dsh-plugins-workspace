/**
 * 工具一 kanban_ready_cards（只读）：盘点当前可执行 / 被阻塞的看板卡，
 * 并给出 Kahn 分层的并行波次规划。
 *
 * 依赖判定口径：本包 board-contract.ts 的 judgeDependencies（照上游
 * shared/dependencies.ts 语义逐字重实现），不调用上游 dependencies()——
 * 口径唯一、可独立单测。
 *
 * 输出契约（render 即模型可见结果）：ready / blocked 每卡带 id 与 title，
 * blocked 附 unmet 前置 {id,title,status}；parallelBatches 第 1 波 = 当前
 * ready，第 k 波 = 前置全部落在更早波次（in_review/done 前置视为已满足，
 * 候选集外的前置——missing/已删/终态/跨项目——永不满足，对应卡不进波次，
 * 只在 blocked 里报告）。
 *
 * @module dsh-kanban-mode/tools/ready-cards
 */

import {
  judgeDependencies,
  requireBoardService,
  type BoardServiceConsumerContext,
  type BoardServiceContract,
  type BoardTaskRecord,
} from './board-contract.ts';
import { defineTool } from './define-tool.ts';

/** 工具名。 */
export const READY_CARDS_TOOL_NAME = 'kanban_ready_cards';

/** 工具描述（注册进宿主 tools 目录）。 */
export const READY_CARDS_TOOL_DESCRIPTION =
  '盘点看板当前可执行（ready）与被前置阻塞（blocked）的任务卡，并给出 Kahn 分层的并行执行波次（parallelBatches）。只读工具，不改任何卡。开工会前、领取任务前、规划并行批次时使用；需要 dsh-taskboard 插件提供的板服务。';

/** 入参形状。 */
export interface ReadyCardsArgs {
  /** 可选：只看单一项目（workspaceId）；缺省盘点全项目。 */
  readonly workspaceId?: string;
}

/** 单张可执行卡。 */
export interface ReadyCardEntry {
  readonly id: string;
  readonly title: string;
}

/** 单个未满足前置的摘要。 */
export interface UnmetPrerequisite {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/** 单张被阻塞卡（附未满足前置明细）。 */
export interface BlockedCardEntry {
  readonly id: string;
  readonly title: string;
  readonly unmet: UnmetPrerequisite[];
}

/** 一个并行波次。 */
export interface ParallelBatch {
  readonly wave: number;
  readonly taskIds: string[];
}

/** 工具返回值（结构化）。 */
export interface ReadyCardsValue {
  readonly workspaceId?: string;
  readonly ready: ReadyCardEntry[];
  readonly blocked: BlockedCardEntry[];
  readonly parallelBatches: ParallelBatch[];
  readonly concurrencyNote: string;
  /** 参与盘点的 todo 卡总数（含被排除的待人工/被认领卡）。 */
  readonly todoCount: number;
  /** 因待人工 / 已被认领而排除出两个清单的卡数。 */
  readonly excludedCount: number;
}

/** 并行度提示（宿主 scheduler 语义，固定口径）。 */
export const CONCURRENCY_NOTE =
  '宿主 scheduler maxConcurrent 默认 3，可在看板设置调整；每分钟 tick';

/**
 * Kahn 分层：第 1 波 = 当前 ready；第 k 波 = 前置全部落在更早波次。
 * 只对「阻塞边全部指向候选集内其他卡」的卡分层——unmet 前置里存在候选集
 * 外节点（missing/已删/终态/跨项目）的卡永远不会 ready，不进波次（它们
 * 已在 blocked[] 里带 unmet 详情）；环内剩余卡同样丢弃（上游建卡禁环，
 * 成环属历史脏数据，blocked[] 的 unmet 已给出行动线索）。
 */
function buildParallelBatches(
  rows: readonly {
    task: Pick<BoardTaskRecord, 'id'>;
    waiting: boolean;
    claimed: boolean;
    unmetIds: readonly string[];
  }[],
  candidateIds: ReadonlySet<string>,
): ParallelBatch[] {
  interface BatchNode {
    readonly id: string;
    readonly internalBlockedBy: ReadonlySet<string>;
  }
  const batchable: BatchNode[] = [];
  for (const row of rows) {
    if (row.waiting || row.claimed) continue;
    const externalUnmet = row.unmetIds.some((id) => !candidateIds.has(id));
    if (externalUnmet) continue;
    batchable.push({
      id: row.task.id,
      internalBlockedBy: new Set(row.unmetIds),
    });
  }
  const batches: ParallelBatch[] = [];
  const scheduled = new Set<string>();
  let remaining = batchable;
  let wave = 1;
  while (remaining.length > 0) {
    const current = remaining.filter((node) =>
      [...node.internalBlockedBy].every((id) => scheduled.has(id)),
    );
    if (current.length === 0) break;
    batches.push({
      wave,
      taskIds: current.map((node) => node.id).sort(),
    });
    for (const node of current) scheduled.add(node.id);
    remaining = remaining.filter((node) => !scheduled.has(node.id));
    wave += 1;
  }
  return batches;
}

/**
 * 计算 ready / blocked / 波次盘点（纯函数，单测直接覆盖）。
 */
export function buildReadyCardsValue(
  board: BoardServiceContract,
  args: ReadyCardsArgs,
): ReadyCardsValue {
  const ledger = board.snapshot();
  const all: readonly BoardTaskRecord[] = ledger.tasks ?? [];
  const scoped =
    args.workspaceId === undefined
      ? all
      : all.filter((task) => task.workspaceId === args.workspaceId);
  const candidates = scoped.filter(
    (task) => task.trashedAt === undefined && task.status === 'todo',
  );
  const candidateIds = new Set(candidates.map((task) => task.id));

  const rows = candidates.map((task) => {
    const deps = judgeDependencies(all, task);
    const unmet = deps.filter((dep) => !dep.satisfied);
    return {
      task,
      waiting: task.waitingForHuman === true,
      claimed: task.claimedBy !== undefined,
      unmetIds: unmet.map((dep) => dep.id),
      unmet: unmet.map((dep) => ({
        id: dep.id,
        title: dep.title,
        status: dep.status,
      })),
    };
  });

  const actionable = rows.filter((row) => !row.waiting && !row.claimed);
  const ready = actionable
    .filter((row) => row.unmetIds.length === 0)
    .map((row) => ({ id: row.task.id, title: row.task.title }));
  const blocked = actionable
    .filter((row) => row.unmetIds.length > 0)
    .map((row) => ({
      id: row.task.id,
      title: row.task.title,
      unmet: row.unmet,
    }));
  const parallelBatches = buildParallelBatches(rows, candidateIds);
  return {
    ...(args.workspaceId !== undefined
      ? { workspaceId: args.workspaceId }
      : {}),
    ready,
    blocked,
    parallelBatches,
    concurrencyNote: CONCURRENCY_NOTE,
    todoCount: candidates.length,
    excludedCount: rows.length - actionable.length,
  };
}

/** render：把盘点结果渲染成模型可读文本（每卡带 id/title 事实）。 */
function renderReadyCards(value: ReadyCardsValue): string[] {
  const scope =
    value.workspaceId === undefined ? '全项目' : `项目 ${value.workspaceId}`;
  const lines: string[] = [`看板可执行卡盘点（${scope}）：`];
  if (value.ready.length === 0) {
    lines.push('- 可执行 ready：无');
  } else {
    lines.push(`- 可执行 ready（${value.ready.length} 张）：`);
    for (const card of value.ready) {
      lines.push(`  - ${card.id}「${card.title}」`);
    }
  }
  if (value.blocked.length === 0) {
    lines.push('- 被前置阻塞 blocked：无');
  } else {
    lines.push(`- 被前置阻塞 blocked（${value.blocked.length} 张）：`);
    for (const card of value.blocked) {
      const unmet = card.unmet
        .map((dep) => `${dep.title}(${dep.id},${dep.status})`)
        .join(', ');
      lines.push(`  - ${card.id}「${card.title}」← 等待前置：${unmet}`);
    }
  }
  if (value.parallelBatches.length === 0) {
    lines.push('- 并行波次：无可分层的卡');
  } else {
    const waves = value.parallelBatches
      .map((batch) => `第 ${batch.wave} 波: ${batch.taskIds.join(', ')}`)
      .join('；');
    lines.push(`- 并行波次（Kahn 分层）：${waves}`);
  }
  lines.push(`- 并行度：${value.concurrencyNote}`);
  lines.push(
    `- 统计：todo 卡 ${value.todoCount} 张，其中待人工/已认领排除 ${value.excludedCount} 张`,
  );
  return lines;
}

/** 构造 kanban_ready_cards 工具定义（execute 时惰性软读取板服务）。 */
export function buildReadyCardsTool(
  ctx: BoardServiceConsumerContext,
): ReturnType<typeof defineTool<ReadyCardsArgs, ReadyCardsValue>> {
  return defineTool<ReadyCardsArgs, ReadyCardsValue>({
    name: READY_CARDS_TOOL_NAME,
    description: READY_CARDS_TOOL_DESCRIPTION,
    parameters: {
      workspaceId: {
        type: 'string',
        description:
          '可选：只盘点该项目的卡（DSH workspace id）；缺省盘点全项目',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [
        { type: 'text', text: renderReadyCards(value).join('\n') },
      ],
    },
    async execute(args) {
      const board = requireBoardService(ctx);
      return buildReadyCardsValue(board, args);
    },
  });
}
