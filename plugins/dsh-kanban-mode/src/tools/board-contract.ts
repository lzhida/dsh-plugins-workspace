/**
 * 板服务契约（共享基建）：本卡对宿主 `dsh-taskboard` 板服务的本地窄接口、
 * 软读取入口与依赖判定口径。
 *
 * 为什么不 import @zhidal/dsh-taskboard：kanban-mode 与上游包零跨包运行时
 * import（硬约束），接口形状照 plugins/dsh-taskboard/src/local/board-service.ts
 * 的 BoardService 真源**结构兼容**声明，只保留本卡真正调用的面。
 *
 * 依赖判定 judgeDependencies 照上游 plugins/dsh-taskboard/src/shared/
 * dependencies.ts 的 dependencyState 逐字重实现（该文件是唯一真源），来源
 * 登记见 docs/upstream-alignment.md；board-contract.test.ts 与上游口径
 * 逐维对齐断言。
 *
 * @module dsh-kanban-mode/tools/board-contract
 */

/** 板任务状态词表（照上游 shared/protocol.ts 的 TaskStatus）。 */
export type BoardTaskStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'done'
  | 'canceled'
  | 'archived';

/** 板任务的执行配置面（本卡只读这几个字段）。 */
export interface BoardExecutionLite {
  readonly mode?: string;
  readonly cron?: string;
  readonly runAt?: number;
  readonly nextRunAt?: number;
}

/** 板任务完整记录面（照上游 TaskRecord，只声明本卡读取的字段）。 */
export interface BoardTaskRecord {
  readonly blockedBy?: readonly string[];
  readonly id: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly status: BoardTaskStatus;
  readonly waitingForHuman?: boolean;
  readonly claimedBy?: string;
  readonly trashedAt?: number;
  readonly execution: BoardExecutionLite;
  readonly presetId?: string;
  readonly version: number;
}

/** 板任务列表摘要面（照上游 TaskSummary，只声明本卡读取的字段）。 */
export interface BoardTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly workspaceId: string;
  readonly status: BoardTaskStatus;
  readonly blocked: boolean;
  readonly waitingForHuman?: boolean;
  readonly claimOwner?: string;
  readonly trashed?: boolean;
  readonly version: number;
}

/** 台账面（照上游 TaskLedger，只声明本卡读取的字段）。 */
export interface BoardLedger {
  readonly tasks: readonly BoardTaskRecord[];
}

/** 建卡输入的 execution 面（照上游 normalizeExecution 的 raw 输入形状）。 */
export interface BoardCreateExecutionInput {
  readonly mode?: string;
  readonly cron?: string;
  readonly runAt?: string | number;
}

/** 建卡输入面（照上游 BoardCreateTaskInput：title/workspaceId 必填，其余可选）。 */
export interface BoardCreateTaskInput {
  readonly title: string;
  readonly workspaceId: string;
  readonly urgency?: string;
  readonly status?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly execution?: BoardCreateExecutionInput;
  readonly presetId?: string;
  readonly blockedBy?: readonly string[];
  readonly checklist?: readonly string[];
}

/** 单个前置任务的依赖判定结果（照上游 TaskDependencyView）。 */
export interface BoardDependencyView {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly satisfied: boolean;
}

/** 板服务契约（照上游 BoardService，本卡只声明真正用到的面）。 */
export interface BoardServiceContract {
  /** 当前台账快照（上游为深拷贝；ready 判定吃全量记录）。 */
  snapshot(): BoardLedger;
  /** 单个任务（含已删除）；不存在返回 undefined。 */
  getTask(id: string): BoardTaskRecord | undefined;
  /** 任务列表（可过滤，返回摘要视图）。 */
  listTasks(filter?: { workspaceId?: string }): BoardTaskSummary[];
  /** 某任务的前置满足情况（任务不存在返回空数组）。 */
  dependencies(taskId: string): BoardDependencyView[];
  /** 某任务是否被未满足的前置阻塞（返回阻塞详情，未阻塞返回 undefined）。 */
  dependencyBlock(taskId: string): string | undefined;
  /** 建卡（上游走 store.mutate('task-created') 事件流）。 */
  createTask(input: BoardCreateTaskInput): Promise<BoardTaskSummary>;
}

/** 软读取板服务的宿主服务名。 */
export const BOARD_SERVICE_NAME = 'dsh-taskboard';

/** 板服务不可用的可操作报错文案（工具 execute 与注册降级共用）。 */
export const BOARD_SERVICE_UNAVAILABLE_MESSAGE =
  'dsh-taskboard 服务不可用：请安装并启用 @zhidal/dsh-taskboard 插件后重试';

/** 本卡工具的错误码（消息形状对齐 vendored ERR：`Error: <code>: <detail>`）。 */
export const TOOL_ERR = {
  serviceUnavailable: 'board_service_unavailable',
  notFound: 'not_found',
  invalidInput: 'invalid_input',
  workspaceMismatch: 'workspace_mismatch',
} as const;

/** 工具消费方上下文（ctx.get 软读取面；对齐 dsh-anytype wiki 先例）。 */
export interface BoardServiceConsumerContext {
  /** cordis Context 的服务软读取；服务缺失时返回 undefined。 */
  get?(name: string): unknown;
}

/**
 * 惰性软读取板服务（invoke 时调用，不在注册期解析）。
 * 对齐 dsh-anytype wiki 先例：不声明 inject、运行时 `ctx.get('dsh-taskboard')`，
 * 服务缺失返回 undefined（上游 board-service.ts 头注释约定的消费方式）。
 */
export function resolveBoardService(
  ctx: BoardServiceConsumerContext,
): BoardServiceContract | undefined {
  const service = ctx.get?.(BOARD_SERVICE_NAME);
  if (service === undefined || service === null) return undefined;
  return service as BoardServiceContract;
}

/**
 * 软读取板服务，缺失时抛可操作错误（消息形状对齐 vendored ERR）。
 */
export function requireBoardService(
  ctx: BoardServiceConsumerContext,
): BoardServiceContract {
  const service = resolveBoardService(ctx);
  if (service === undefined) {
    throw new Error(
      `Error: ${TOOL_ERR.serviceUnavailable}: ${BOARD_SERVICE_UNAVAILABLE_MESSAGE}`,
    );
  }
  return service;
}

/** 前置「已满足」的状态集合（照上游 dependencies.ts：in_review | done）。 */
const SATISFIED_STATUSES: ReadonlySet<string> = new Set(['in_review', 'done']);

/** 本地依赖判定结果（形状照上游 dependencyState 的返回项）。 */
export interface BoardDependencyJudgement {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly satisfied: boolean;
}

/**
 * 判定一张卡的全部前置满足情况（照上游 shared/dependencies.ts 的
 * dependencyState 逐字重实现，kanban-mode 零跨包 import 故语义本地化）：
 *
 *   satisfied = 前置存在 ∧ 同项目 ∧ 未软删 ∧ status ∈ {in_review, done}
 *
 * 前置不存在（missing）、已软删、跨项目、状态为 backlog/todo/in_progress/
 * canceled/archived 一律不满足；status 回退 'missing'、title 回退 id 的
 * 缺失回退也与上游一致。
 *
 * 版本锚：与 vendored @zhidal/dsh-taskboard（上游 v0.10.0）
 * `src/shared/dependencies.ts` 的 `dependencyState` 判定口径对齐
 * （2026-11-20 快照；上游升级时同步核对 `docs/upstream-alignment.md`）。
 */
export function judgeDependencies(
  tasks: readonly BoardTaskRecord[],
  task: Pick<BoardTaskRecord, 'workspaceId' | 'blockedBy'>,
): BoardDependencyJudgement[] {
  const byId = new Map(
    tasks.map((candidate) => [candidate.id, candidate] as const),
  );
  return (task.blockedBy ?? []).map((id) => {
    const prerequisite = byId.get(id);
    const satisfied =
      prerequisite !== undefined &&
      prerequisite.workspaceId === task.workspaceId &&
      prerequisite.trashedAt === undefined &&
      SATISFIED_STATUSES.has(prerequisite.status);
    return {
      id,
      title: prerequisite?.title ?? id,
      status: prerequisite?.status ?? 'missing',
      satisfied,
    };
  });
}
