/**
 * 建卡 / 改卡的唯一实现。
 *
 * 上游 host/tools.ts 的 taskboard_create / taskboard_update 与本地板服务
 * （board-service.ts）共用本文件：参数归一化、依赖校验、版本守卫与台账写入
 * 只在这里发生一次，行为与报错文案与上游零漂移。
 *
 * 设计约束：
 * - 纯逻辑 + 依赖注入：调用方注入台账写入面、时钟、看板设置、（可选的）固定
 *   模型校验与（可选的）工作区解析器；会话上下文（exec）只在上游工具层出现。
 * - 归一化与依赖校验一律直接复用 ../shared/protocol.ts 与
 *   ../shared/dependencies.ts，不复制第二份逻辑，也不改写其报错原文。
 */

import { createHash } from 'node:crypto';
import {
  asIsolation,
  asPermission,
  asStatus,
  asUrgency,
  checklistFromTexts,
  defaultIsolationOf,
  defaultPermissionOf,
  newCommentId,
  newTaskId,
  normalizeBody,
  normalizeExecution,
  normalizeModel,
  normalizePrompt,
  normalizeTitle,
  sanitizeCustomBranchName,
  summarize,
  type Actor,
  type BoardSettings,
  type CommentRecord,
  type IsolationMode,
  type TaskLedger,
  type TaskModel,
  type TaskRecord,
  type TaskSummary,
} from '../shared/protocol.ts';
import {
  dependenciesEnabled,
  validateDependencies,
} from '../shared/dependencies.ts';
import { applyHumanWaitingPatch } from '../shared/human-wait.ts';
import { BoardError, ERR, type BoardErrorCode } from './board-errors.ts';

/**
 * 台账写入面（本地窄接口；与 host/store.ts 的 TaskStore 结构兼容）。
 *
 * 刻意不 import host/store.ts：本地层只依赖纯逻辑的 shared/ 与一个结构
 * 兼容的窄接口，宿主实现（TaskStore）在装配时注入。
 */
export interface LedgerStore {
  /** 当前台账快照（深拷贝）。 */
  snapshot(): TaskLedger;
  /** 单个任务（已删除任务也返回）；不存在返回 undefined。 */
  get(id: string): TaskRecord | undefined;
  /**
   * 串行队列内的台账变更：mutator 收到新鲜草稿，返回 undefined 表示放弃写入。
   */
  mutate(
    kind: 'task-created' | 'task-updated' | 'comment-added',
    mutator: (ledger: TaskLedger) => TaskRecord[] | undefined,
  ): Promise<{ ledger: TaskLedger; changed: readonly TaskRecord[] }>;
}

/** 建卡 / 改卡的依赖注入面。 */
export interface TaskWriterDeps {
  /** 台账写入面（写路径一律走 store.mutate 事件流）。 */
  store: LedgerStore;
  /** 当前 epoch ms。 */
  now: () => number;
  /** 看板默认设置（建卡默认值的来源）。 */
  settings: () => BoardSettings | undefined;
  /**
   * 固定模型校验（上游 checkModel 语义：结构校验 + 可选的 provider 路由校验）。
   * 缺省仅做结构校验（normalizeModel）。
   */
  checkModel?: (raw: unknown) => TaskModel;
  /**
   * 工作区解析器：把工作区参数（项目 id 或目录路径）解析为规范项目 id，
   * 解析不到返回 undefined。未注入时视为参数已是规范项目 id。
   */
  resolveWorkspace?: (raw: string) => Promise<string | undefined>;
  /** 工作区解析失败时的错误详情（上游 unknownWorkspaceDetail）。 */
  unknownWorkspaceDetail?: (raw: string) => Promise<string>;
}

/** 建卡输入（与上游 taskboard_create 的参数同构）。 */
export interface CreateTaskInput {
  /** 标题（1..200 字符）。 */
  title: string;
  /** 目标项目 id（工作区解析由调用方注入的解析器完成）。 */
  workspaceId: string;
  /** 紧急度：urgent | normal | relaxed。 */
  urgency: string;
  /** 初始状态（只允许 backlog / todo）。 */
  status?: string;
  /** 任务描述。 */
  description?: string;
  /** 执行提示词。 */
  prompt?: string;
  /** 执行方式（claim / scheduled）。 */
  execution?: { mode?: string; cron?: string; runAt?: string | number };
  /** 固定模型。 */
  model?: { provider?: string; model?: string; reasoningEffort?: string };
  /** 代码隔离方式。 */
  isolation?: string;
  /** 显式任务分支。 */
  branch?: string;
  /** 执行权限。 */
  permission?: string;
  /** Agent 预设 id。 */
  presetId?: string;
  /** 验收清单（DoD）文本。 */
  checklist?: string[];
  /** 前置任务 id（新建语义：直接挂上这些前置）。 */
  blockedBy?: string[];
}

/**
 * 建卡时强制生效的隔离模式（验收联动系列 1/4 起）。
 *
 * 建卡入口共三条且**各自独立归一化** isolation：工具入口与板服务入口汇聚到
 * 本文件的 createTask，GUI 入口走 host/routes.ts 的 POST /tasks。两处都必须
 * 走 {@link resolveIsolation}（下方单一真源），否则 GUI 建卡会绕过强制。
 */
export const FORCED_ISOLATION: IsolationMode = 'worktree';

/** 强制覆盖时写进建卡结果的注明文案。 */
export const FORCED_ISOLATION_NOTE = '已强制 worktree 隔离';

/** 建卡隔离归一化的结果。 */
export interface IsolationResolution {
  /** 最终生效的隔离模式（恒为 {@link FORCED_ISOLATION}）。 */
  isolation: IsolationMode;
  /** 是否发生了强制覆盖（入参或看板默认与强制值不一致）。 */
  forced: boolean;
  /** 覆盖注明（forced 为 true 时存在）。 */
  note?: string;
}

/**
 * 建卡隔离归一化的**单一真源**：工具 / 板服务 / GUI 三条建卡入口共用。
 *
 * 语义：
 * - 显式 `worktree`（或看板默认即为 worktree）→ 原样生效，不算覆盖；
 * - 显式 `none` → 强制改为 worktree 并注明；入参非法值仍按上游口径报错
 *   （`isolation must be 'worktree' or 'none'`），校验不被绕过；
 * - 未指定 → 取看板默认（缺省为上游 DEFAULT_ISOLATION='none'），同样强制
 *   为 worktree 并注明。
 */
export function resolveIsolation(
  raw: string | undefined,
  boardDefault: IsolationMode | undefined,
): IsolationResolution {
  const requested = raw === undefined ? boardDefault : asIsolation(raw);
  if (requested === FORCED_ISOLATION) {
    return { isolation: FORCED_ISOLATION, forced: false };
  }
  const source =
    raw !== undefined
      ? '显式请求 none'
      : boardDefault === 'none'
        ? '看板默认隔离为 none'
        : '未指定隔离（上游缺省为 none）';
  return {
    isolation: FORCED_ISOLATION,
    forced: true,
    note: `${FORCED_ISOLATION_NOTE}（原值：${source}）`,
  };
}

/**
 * 建卡结果（TaskSummary 的本地扩展）。
 *
 * 强制覆盖建卡隔离时附带注记字段；上游 TaskSummary 是 vendored 类型（禁改），
 * 故用本地扩展承载附加信息——结构兼容，上游调用方（工具 / GUI / 板服务）无感。
 */
export interface CreateTaskResult extends TaskSummary {
  /** 隔离被强制覆盖（仅覆盖时存在）。 */
  isolationForced?: boolean;
  /** 隔离强制覆盖的注明（仅覆盖时存在）。 */
  isolationNote?: string;
}

/** 改卡输入（与上游 taskboard_update 的参数同构）。 */
export interface UpdateTaskInput {
  /** 目标任务 id。 */
  id: string;
  /** 调用方读到的版本号（乐观锁；缺省或不符即失败）。 */
  ifVersion?: number;
  /** 新标题。 */
  title?: string;
  /** 新描述。 */
  description?: string;
  /** 新执行提示词。 */
  prompt?: string;
  /** 新紧急度。 */
  urgency?: string;
  /** 阻塞标记。 */
  blocked?: boolean;
  /** 前置任务 id（替换语义：整体替换已有前置）。 */
  blockedBy?: string[];
  /** 是否等待人工处理（false 显式清除等待，抑制推断）。 */
  waitingForHuman?: boolean;
  /** 等待原因（最多 500 字符；空串清除）。 */
  waitingReason?: string;
  /** 新执行权限。 */
  permission?: string;
}

/**
 * 在 mutator 内定位存活任务（未删除）。
 *
 * R1：所有守卫都必须跑在串行队列交给我们的新鲜草稿上，而不是预读的克隆——
 * 预读可能通过版本检查后再盲写覆盖被并发改动的任务。
 */
export function liveTaskAt(
  ledger: TaskLedger,
  id: string,
): { index: number; task: TaskRecord } {
  const index = ledger.tasks.findIndex((t) => t.id === id);
  if (index < 0) throw new BoardError(ERR.notFound, `no task ${id}`);
  const task = ledger.tasks[index]!;
  if (task.trashedAt !== undefined) {
    throw new BoardError(ERR.notFound, `no task ${id}`);
  }
  return { index, task };
}

/** 版本守卫：ifVersion 必须提供且与当前版本一致。 */
export function versionGuard(
  task: TaskRecord,
  ifVersion: number | undefined,
): void {
  if (ifVersion === undefined) {
    throw new BoardError(
      ERR.versionConflict,
      'this write requires ifVersion; read the task first',
    );
  }
  if (ifVersion !== task.version) {
    throw new BoardError(
      ERR.versionConflict,
      `stale version ${ifVersion} (current ${task.version}); re-read the task and retry once`,
    );
  }
}

/** 工作区解析：返回规范项目 id；解析不到则抛 not_found（详情由调用方给出）。 */
async function resolveWorkspaceId(
  raw: string,
  deps: TaskWriterDeps,
): Promise<string> {
  if (deps.resolveWorkspace === undefined) return raw;
  const resolved = await deps.resolveWorkspace(raw);
  if (resolved !== undefined) return resolved;
  const detail =
    deps.unknownWorkspaceDetail === undefined
      ? `unknown workspaceId "${raw}" (expected a project id or its directory path)`
      : await deps.unknownWorkspaceDetail(raw);
  throw new BoardError(ERR.notFound, detail);
}

/**
 * 建卡：参数归一化 → 组装 TaskRecord → 走 store.mutate('task-created') 写入。
 *
 * 归一化的先后顺序本身就是行为的一部分（先 title、再 urgency、再 status……），
 * 这里与上游 taskboard_create 逐字对齐；报错文案沿用上游原文。
 */
export async function createTask(
  input: CreateTaskInput,
  actor: Actor,
  deps: TaskWriterDeps,
): Promise<CreateTaskResult> {
  const title = normalizeTitle(input.title);
  const workspaceId = await resolveWorkspaceId(input.workspaceId, deps);
  const urgency = asUrgency(input.urgency);
  const status =
    input.status === undefined ? ('todo' as const) : asStatus(input.status);
  if (status !== 'backlog' && status !== 'todo') {
    throw new BoardError(
      ERR.invalidTransition,
      'a new task must start as backlog or todo (in_progress requires claiming the task)',
    );
  }
  const execution = normalizeExecution(input.execution ?? {}, deps.now());
  const modelRaw = input.model ?? deps.settings()?.defaultModel;
  const model =
    modelRaw !== undefined
      ? (deps.checkModel ?? normalizeModel)(modelRaw)
      : undefined;
  // 验收联动系列 1/4：建卡一律强制 worktree 隔离——无视入参与看板默认值；
  // 显式 'none' 被覆盖时在结果里注明「已强制 worktree」。
  const isolationResolution = resolveIsolation(
    input.isolation,
    defaultIsolationOf(deps.settings()),
  );
  const isolation = isolationResolution.isolation;
  // Issue #98：显式任务分支；垃圾/空输入不写覆盖（首次执行时套用看板命名预设）。
  const branchOverride =
    input.branch === undefined
      ? undefined
      : sanitizeCustomBranchName(input.branch);
  // 与 GUI 建卡路由一致：把当前看板默认权限固化到任务上。
  const permission =
    input.permission === undefined
      ? defaultPermissionOf(deps.settings())
      : asPermission(input.permission);
  const presetId =
    input.presetId === undefined
      ? deps.settings()?.defaultPresetId
      : input.presetId.trim() || undefined;
  // T9：与 GUI 建卡路由一致——trim 并丢弃空行，不因一条空串让整次调用失败。
  const checklistTexts = input.checklist
    ?.map((c) => c.trim())
    .filter((c) => c.length > 0);
  const checklist =
    checklistTexts !== undefined && checklistTexts.length > 0
      ? checklistFromTexts(checklistTexts)
      : undefined;
  const now = deps.now();
  const task: TaskRecord = {
    id: newTaskId(),
    title,
    description: (input.description ?? '').trim(),
    prompt: normalizePrompt(input.prompt),
    workspaceId,
    urgency,
    status,
    blocked: false,
    execution,
    model,
    isolation,
    ...(branchOverride !== undefined ? { branch: branchOverride } : {}),
    permission,
    ...(presetId !== undefined ? { presetId } : {}),
    ...(checklist !== undefined ? { checklist } : {}),
    version: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
    comments: [],
    executions: [],
  };
  await deps.store.mutate('task-created', (ledger) => {
    // 上游 0.10.1 起：依赖总开关关闭时不挂前置（开关语义见 shared/dependencies.ts）。
    if (dependenciesEnabled(ledger.settings)) {
      task.blockedBy = validateDependencies(
        ledger.tasks,
        task,
        input.blockedBy ?? [],
      );
    }
    ledger.tasks.push(task);
    return [task];
  });
  return {
    ...summarize(task),
    ...(isolationResolution.forced
      ? { isolationForced: true, isolationNote: isolationResolution.note }
      : {}),
  };
}

/**
 * 改卡：定位 → 版本守卫 → 逐字段 patch → 写回（全部在 mutate 的新鲜草稿内）。
 *
 * blockedBy 在这里是**替换**语义（与建卡时的新增语义不同）：整体替换已有前置。
 */
export async function updateTask(
  input: UpdateTaskInput,
  actor: Actor,
  deps: TaskWriterDeps,
): Promise<TaskSummary> {
  // R1：查找 + 版本守卫 + 写回都在串行队列的变更里、于新鲜草稿上完成——
  // 预读的克隆可能通过版本检查后再盲写覆盖并发改动。
  let next: TaskRecord | undefined;
  await deps.store.mutate('task-updated', (ledger) => {
    const { index, task } = liveTaskAt(ledger, input.id);
    versionGuard(task, input.ifVersion);
    if (task.status === 'archived') {
      throw new BoardError(
        ERR.invalidTransition,
        'archived tasks are immutable',
      );
    }
    next = structuredClone(task);
    if (input.title !== undefined) next.title = normalizeTitle(input.title);
    if (input.description !== undefined) {
      next.description = input.description.trim();
    }
    if (input.prompt !== undefined) next.prompt = normalizePrompt(input.prompt);
    if (input.urgency !== undefined) next.urgency = asUrgency(input.urgency);
    if (input.blocked !== undefined) next.blocked = input.blocked;
    if (dependenciesEnabled(ledger.settings) && input.blockedBy !== undefined) {
      next.blockedBy = validateDependencies(
        ledger.tasks,
        next,
        input.blockedBy,
      );
    }
    applyHumanWaitingPatch(next, input);
    if (input.permission !== undefined)
      next.permission = asPermission(input.permission);
    next.version = task.version + 1;
    next.updatedAt = deps.now();
    next.updatedBy = actor;
    ledger.tasks[index] = next;
    return [next];
  });
  return summarize(next!);
}

// ------------------------------------------------------------- 评论写通道
// 验收联动系列 2/4：板服务 addTaskComment 的实现。上游 host/tools.ts 的
// taskboard_comment（agent 会话评论）与 GUI 的用户评论各有自己的写入口，
// 这里是第三条：供模式插件（收割 watcher 等）以系统身份留痕，不新增
// host 工具、不改既有评论读路径。

/** 系统评论的默认来源标记（上游约定：无会话的 host 系统评论用稳定来源标签）。 */
export const SYSTEM_COMMENT_SOURCE = 'host';

/** 系统评论正文前缀（与上游 scheduler 的 '[系统]' 同风格，便于 UI 与审计一眼分辨）。 */
export const SYSTEM_COMMENT_BODY_PREFIX = '[系统] ';

/** 评论写通道输入。 */
export interface AddTaskCommentInput {
  /** 目标任务 id。 */
  taskId: string;
  /** 评论正文（1..4000 字符；系统前缀自动补齐，已带则不重复叠加）。 */
  body: string;
  /** 来源标记（写入 threadId；缺省 {@link SYSTEM_COMMENT_SOURCE}）。 */
  source?: string;
  /**
   * 幂等键：同一 (taskId, idempotencyKey) 只留一条评论——重复写入不推进任务
   * 版本、不重复留痕，返回 duplicate=true。键经 sha256 派生确定性评论 id，
   * 进程重启与台账导入 / 导出都不丢失幂等性（导入规范化只保留上游已知字段，
   * 自定义字段会被丢弃，故幂等必须落在 id 上）。
   */
  idempotencyKey?: string;
}

/** 评论写通道结果：失败不抛穿调用方，折叠为结构化 ok/error。 */
export type AddTaskCommentResult =
  | {
      ok: true;
      /** 写入（或幂等命中）的评论。 */
      comment: CommentRecord;
      /** 目标任务 id。 */
      taskId: string;
      /** 写入后的任务版本（幂等命中时为当前版本，不推进）。 */
      taskVersion: number;
      /** true = 幂等键命中已有评论，本次未重复写入。 */
      duplicate: boolean;
    }
  | {
      ok: false;
      /** 稳定错误码（ERR 码表）与原文详情。 */
      error: { code: BoardErrorCode; message: string };
    };

/** 由幂等键派生确定性评论 id（`c-` + 16 位 hex；与上游时间随机 id 形状不冲突）。 */
function commentIdFor(taskId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${taskId}\u0000${idempotencyKey}`)
    .digest('hex')
    .slice(0, 16);
  return `c-${digest}`;
}

/**
 * 是否系统评论：threadId 等于约定来源标记。与用户评论（无 threadId）、
 * agent 会话评论（threadId 为会话 id）三者互斥可分。
 */
export function isSystemComment(
  comment: CommentRecord,
  source: string = SYSTEM_COMMENT_SOURCE,
): boolean {
  return comment.threadId === source;
}

/**
 * 评论写通道：正文归一化 → 系统前缀补齐 → 幂等键派生 id → 走
 * store.mutate('comment-added') 事件流追加（append-only、无 ifVersion，
 * 与上游 taskboard_comment 同口径）。
 *
 * 失败不抛穿：任务不存在（not_found）、已归档（invalid_transition）、正文
 * 非法（invalid_input）、台账写失败（taskboard_not_ready）一律折叠为
 * ok:false + 稳定错误码，调用方拿结果自行决策。
 */
export async function addTaskComment(
  input: AddTaskCommentInput,
  deps: TaskWriterDeps,
): Promise<AddTaskCommentResult> {
  const source = input.source?.trim() || SYSTEM_COMMENT_SOURCE;
  let body: string;
  try {
    body = normalizeBody(input.body);
  } catch (error) {
    return {
      ok: false,
      error: { code: ERR.invalidInput, message: (error as Error).message },
    };
  }
  if (!body.startsWith(SYSTEM_COMMENT_BODY_PREFIX)) {
    body = `${SYSTEM_COMMENT_BODY_PREFIX}${body}`;
  }
  if (body.length > 4000) {
    return {
      ok: false,
      error: {
        code: ERR.invalidInput,
        message: 'comment body must be 1..4000 characters',
      },
    };
  }
  const commentId =
    input.idempotencyKey === undefined
      ? newCommentId()
      : commentIdFor(input.taskId, input.idempotencyKey);
  let comment: CommentRecord | undefined;
  let taskVersion = 0;
  let duplicate = false;
  try {
    // R1：查找 + 幂等判定 + 追加都在串行队列交给我们的新鲜草稿上完成——
    // 幂等键命中已有评论即放弃写入（mutator 返回 undefined），不推进版本。
    await deps.store.mutate('comment-added', (ledger) => {
      const { index, task } = liveTaskAt(ledger, input.taskId);
      if (task.status === 'archived') {
        throw new BoardError(
          ERR.invalidTransition,
          'archived tasks are immutable',
        );
      }
      const existing = task.comments.find((c) => c.id === commentId);
      if (existing !== undefined) {
        duplicate = true;
        comment = existing;
        taskVersion = task.version;
        return undefined;
      }
      const next = structuredClone(task);
      const record: CommentRecord = {
        id: commentId,
        body,
        version: 1,
        createdAt: deps.now(),
        threadId: source,
      };
      next.comments.push(record);
      next.version = task.version + 1;
      next.updatedAt = deps.now();
      ledger.tasks[index] = next;
      comment = record;
      taskVersion = next.version;
      return [next];
    });
  } catch (error) {
    if (error instanceof BoardError) {
      return {
        ok: false,
        error: { code: error.code as BoardErrorCode, message: error.detail },
      };
    }
    return {
      ok: false,
      error: {
        code: ERR.notReady,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  return {
    ok: true,
    comment: comment!,
    taskId: input.taskId,
    taskVersion,
    duplicate,
  };
}
