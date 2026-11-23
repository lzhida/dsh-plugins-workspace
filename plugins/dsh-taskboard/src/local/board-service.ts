/**
 * 板服务（宿主服务名 `dsh-taskboard` 的本地实现）。
 *
 * 目的：模式插件（另一个 dsh 插件包）能以 `ctx.get('dsh-taskboard')` 软读取板
 * 数据——服务缺失时消费方拿到 undefined、不抛错——并按需建卡 / 改卡。
 *
 * 写路径全部经过 store.mutate 事件流（与上游工具一致），不绕过事件流直改台账；
 * 只读路径的依赖判定口径来自 ../shared/dependencies.ts（唯一真源）。
 */

import {
  dependencyError,
  dependencyState,
  gateEnabled,
  type DependencyGate,
} from '../shared/dependencies.ts';
import {
  summarize,
  type Actor,
  type TaskLedger,
  type TaskRecord,
  type TaskStatus,
  type TaskSummary,
  type Urgency,
} from '../shared/protocol.ts';
import {
  createTask as writeCreateTask,
  updateTask as writeUpdateTask,
  type CreateTaskInput,
  type LedgerStore,
  type TaskWriterDeps,
  type UpdateTaskInput,
} from './task-writer.ts';

/** 单个前置任务的依赖判定结果（口径见 shared/dependencies.ts）。 */
export interface TaskDependencyView {
  /** 前置任务 id。 */
  id: string;
  /** 前置任务标题（缺失时回退为 id）。 */
  title: string;
  /** 前置任务状态（缺失时为 'missing'）。 */
  status: string;
  /** 是否满足：同项目 ∧ 未删除 ∧ 状态 ∈ {in_review, done}。 */
  satisfied: boolean;
}

/** 任务列表过滤条件（全部缺省 = 不过滤）。 */
export interface TaskFilter {
  /** 只看该项目下的任务。 */
  workspaceId?: string;
  /** 只看这些状态的任务。 */
  status?: TaskStatus | readonly TaskStatus[];
  /** 只看该紧急度的任务。 */
  urgency?: Urgency;
  /** true = 只看未删除；false = 只看已删除；缺省 = 都看。 */
  trashed?: boolean;
  /** true = 只看被未满足前置阻塞的任务。 */
  blockedOnly?: boolean;
}

/** 板服务建卡输入（在写手输入之上补齐紧急度默认值与记录者）。 */
export interface BoardCreateTaskInput extends Omit<CreateTaskInput, 'urgency'> {
  /** 紧急度：urgent | normal | relaxed（缺省 normal）。 */
  urgency?: string;
  /** 记录者（缺省 system）。 */
  actor?: Actor;
}

/** 板服务改卡输入（在写手输入之上补齐记录者）。 */
export interface BoardUpdateTaskInput extends UpdateTaskInput {
  /** 记录者（缺省 system）。 */
  actor?: Actor;
}

/** 板服务接口（宿主以 ctx.get('dsh-taskboard') 软读取）。 */
export interface BoardService {
  /** 当前台账快照（深拷贝）。 */
  snapshot(): TaskLedger;
  /** 单个任务（含已删除）；不存在返回 undefined。 */
  getTask(id: string): TaskRecord | undefined;
  /** 任务列表（可过滤，返回摘要视图）。 */
  listTasks(filter?: TaskFilter): TaskSummary[];
  /** 某任务的前置满足情况（任务不存在返回空数组）。 */
  dependencies(taskId: string): TaskDependencyView[];
  /** 某任务是否被未满足的前置阻塞（返回阻塞详情，未阻塞返回 undefined）。 */
  dependencyBlock(taskId: string): string | undefined;
  /** 依赖门禁是否开启。 */
  dependencyGateEnabled(gate: DependencyGate): boolean;
  /** 建卡（走 store.mutate('task-created') 事件流）。 */
  createTask(input: BoardCreateTaskInput): Promise<TaskSummary>;
  /** 改卡（走 store.mutate('task-updated') 事件流；ifVersion 乐观锁）。 */
  updateTask(input: BoardUpdateTaskInput): Promise<TaskSummary>;
}

/** 板服务的构造参数。 */
export interface BoardServiceOptions {
  /** 台账面（写路径一律走 store.mutate 事件流）。 */
  store: LedgerStore;
  /** 时钟（缺省 Date.now）。 */
  now?: () => number;
  /** 默认记录者（缺省 system：板服务由插件驱动，不是用户会话）。 */
  actor?: Actor;
}

/** 判断任务是否命中过滤条件。 */
function matchesFilter(
  all: readonly TaskRecord[],
  task: TaskRecord,
  filter: TaskFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (
    filter.workspaceId !== undefined &&
    task.workspaceId !== filter.workspaceId
  ) {
    return false;
  }
  if (filter.urgency !== undefined && task.urgency !== filter.urgency) {
    return false;
  }
  if (filter.status !== undefined) {
    const wanted: readonly TaskStatus[] =
      typeof filter.status === 'string' ? [filter.status] : filter.status;
    if (!wanted.includes(task.status)) return false;
  }
  if (filter.trashed !== undefined) {
    if ((task.trashedAt !== undefined) !== filter.trashed) return false;
  }
  if (filter.blockedOnly === true && dependencyError(all, task) === undefined) {
    return false;
  }
  return true;
}

/**
 * 构造板服务。
 *
 * @param options - 台账 + 时钟 + 默认记录者。
 * @returns 板服务实例（只读视图 + 走事件流的建卡/改卡）。
 */
export function createBoardService(options: BoardServiceOptions): BoardService {
  const { store } = options;
  const now = options.now ?? (() => Date.now());
  const defaultActor: Actor = options.actor ?? { kind: 'system' };
  const writerDeps: TaskWriterDeps = {
    store,
    now,
    settings: () => store.snapshot().settings,
  };
  const allTasks = (): readonly TaskRecord[] => store.snapshot().tasks;
  return {
    snapshot: () => store.snapshot(),
    getTask: (id) => store.get(id),
    listTasks: (filter) =>
      allTasks()
        .filter((task) => matchesFilter(allTasks(), task, filter))
        .map((task) => summarize(task)),
    dependencies: (taskId) => {
      const all = allTasks();
      const task = all.find((t) => t.id === taskId);
      if (task === undefined) return [];
      return dependencyState(all, task).map((dep) => ({
        id: dep.id,
        title: dep.title,
        status: dep.status,
        satisfied: dep.satisfied,
      }));
    },
    dependencyBlock: (taskId) => {
      const all = allTasks();
      const task = all.find((t) => t.id === taskId);
      if (task === undefined) return undefined;
      return dependencyError(all, task);
    },
    dependencyGateEnabled: (gate) =>
      gateEnabled(store.snapshot().settings, gate),
    createTask: (input) => {
      const { actor, ...rest } = input;
      return writeCreateTask(
        { ...rest, urgency: input.urgency ?? 'normal' },
        actor ?? defaultActor,
        writerDeps,
      );
    },
    updateTask: (input) => {
      const { actor, ...rest } = input;
      return writeUpdateTask(rest, actor ?? defaultActor, writerDeps);
    },
  };
}
