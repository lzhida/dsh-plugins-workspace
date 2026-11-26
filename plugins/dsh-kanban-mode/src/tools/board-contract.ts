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
 * 上游 0.10.1 起依赖受看板设置「启用任务依赖」总开关（dependenciesEnabled）
 * 门控：上游缺省关闭，本仓 vendored 版缺省钉为开启（local-patches.json 第
 * 16 条）。判定函数本身在 0.10.0 → 0.10.1 之间未变；总开关只影响板服务的
 * 读面与门禁面（见 BoardServiceContract.dependencies / dependencyBlock 注释），
 * 本文件的 judgeDependencies 作用于台账原始记录面，不知晓开关状态。
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

/**
 * 单次执行记录面（照上游 ExecutionRecord，只声明收割需要的字段）。
 *
 * 收割要知道「任务分支 / 检出路径 / 基线提交」——这些只存在于执行记录里
 * （台账任务本身只存 baseCommit 与 branch 覆盖，见上游 protocol.ts:920-945）。
 */
export interface BoardExecutionEvidence {
  readonly outcome?: string;
  readonly isolation?: string;
  readonly isolationNote?: string;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly baseCommit?: string;
  readonly headCommit?: string;
  readonly diffStat?: string;
  readonly changedFiles?: number;
  readonly dirtyFiles?: readonly string[];
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
  /** 显式任务分支（上游 issue #98：首建 worktree 时固定）。 */
  readonly branch?: string;
  /** 代码隔离方式（'worktree' | 'none'）。 */
  readonly isolation?: string;
  /** 执行记录（收割目标解析的数据来源）。 */
  readonly executions?: readonly BoardExecutionEvidence[];
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
  /**
   * 建卡时强制隔离的说明（上游建卡强制 worktree 时才出现）。
   * 不声明这两个字段，消费方在类型面上就看不到「已强制 worktree」的通知。
   */
  readonly isolationForced?: boolean;
  readonly isolationNote?: string;
}

/** 台账面（照上游 TaskLedger，只声明本卡读取的字段）。 */
export interface BoardLedger {
  readonly tasks: readonly BoardTaskRecord[];
  /** 台账修订号（上游 store.mutate 每次写入 +1；watcher 靠它感知变更）。 */
  readonly revision?: number;
}

/** 评论记录面（照上游 CommentRecord，只声明本包读取的字段）。 */
export interface BoardCommentRecord {
  readonly id: string;
  readonly body: string;
  readonly version: number;
  readonly createdAt: number;
  readonly threadId?: string;
  readonly systemKey?: string;
}

/** 评论写通道输入面（照上游 addTaskComment）。 */
export interface BoardAddTaskCommentInput {
  readonly taskId: string;
  readonly body: string;
  /** 来源标记（缺省由上游写通道取系统默认）。 */
  readonly source?: string;
  /** 幂等键（同一键重复写入不产生重复评论）。 */
  readonly idempotencyKey?: string;
}

/** 评论写通道结果面（照上游 addTaskComment 的结构化返回）。 */
export interface BoardAddTaskCommentResult {
  readonly ok: boolean;
  readonly comment?: BoardCommentRecord;
  readonly taskId?: string;
  readonly taskVersion?: number;
  /** 命中幂等键（未新增评论）。 */
  readonly duplicate?: boolean;
  readonly error?: { readonly code: string; readonly message: string };
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
  /**
   * 某任务的前置满足情况（任务不存在返回空数组）。
   * 上游 0.10.1 读面语义：依赖总开关（dependenciesEnabled）关闭时恒返回
   * `[]`——空数组不代表卡上没有 blockedBy 记录，只代表读面被关。
   */
  dependencies(taskId: string): BoardDependencyView[];
  /**
   * 某任务是否被未满足的前置阻塞（返回阻塞详情，未阻塞返回 undefined）。
   * 上游 0.10.1 读面语义：依赖总开关关闭时恒返回 `undefined`（门禁面停用）。
   */
  dependencyBlock(taskId: string): string | undefined;
  /** 建卡（上游走 store.mutate('task-created') 事件流）。 */
  createTask(input: BoardCreateTaskInput): Promise<BoardTaskSummary>;
  /**
   * 评论写通道（上游 src/local/task-writer.ts 的 addTaskComment）。
   *
   * 声明为可选：旧版板服务实例没有该方法时，调用方需自行降级
   * （不得因「方法不存在」抛穿整个调用链）。
   */
  addTaskComment?(
    input: BoardAddTaskCommentInput,
  ): Promise<BoardAddTaskCommentResult>;
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
 * 记录面口径：本函数吃台账原始记录（`task.blockedBy`），**不看**依赖总开关
 * （dependenciesEnabled）——上游 0.10.1 起，总开关只影响板服务的读面
 * （`dependencies()` 返回 `[]`）与门禁面（`dependencyBlock()` 返回
 * undefined、四类门禁短路、建卡/改卡传 blockedBy 被静默丢弃），不改变台账
 * 里已写的 blockedBy 记录。因此总开关关闭期间，本函数（kanban_ready_cards
 * 的 ready/blocked 判定）仍按记录报「等待前置」，与门禁面表现不同——这是
 * 记录面 vs 门禁面的已知口径差异，消费方需要门禁面结论时以
 * `dependencyBlock()` 为准。
 *
 * 版本锚：与 vendored @zhidal/dsh-taskboard（上游 v0.10.1）
 * `src/shared/dependencies.ts` 的 `dependencyState` 判定口径对齐
 * （判定函数 0.10.0 → 0.10.1 未变，0.10.1 新增的是同文件的
 * `dependenciesEnabled` 总开关；上游升级时同步核对 `docs/upstream-alignment.md`）。
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
