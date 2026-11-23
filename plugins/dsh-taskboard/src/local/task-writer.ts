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

import {
  asIsolation,
  asPermission,
  asStatus,
  asUrgency,
  checklistFromTexts,
  defaultIsolationOf,
  defaultPermissionOf,
  newTaskId,
  normalizeExecution,
  normalizeModel,
  normalizePrompt,
  normalizeTitle,
  sanitizeCustomBranchName,
  summarize,
  type Actor,
  type BoardSettings,
  type TaskLedger,
  type TaskModel,
  type TaskRecord,
  type TaskSummary,
} from '../shared/protocol.ts';
import { validateDependencies } from '../shared/dependencies.ts';
import { applyHumanWaitingPatch } from '../shared/human-wait.ts';
import { BoardError, ERR } from './board-errors.ts';

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
    kind: 'task-created' | 'task-updated',
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
): Promise<TaskSummary> {
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
  // 0.5.0：省略 isolation 时把当时的看板默认值固化到任务上，后续改设置不改旧卡。
  const isolation =
    input.isolation === undefined
      ? defaultIsolationOf(deps.settings())
      : asIsolation(input.isolation);
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
    task.blockedBy = validateDependencies(
      ledger.tasks,
      task,
      input.blockedBy ?? [],
    );
    ledger.tasks.push(task);
    return [task];
  });
  return summarize(task);
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
    if (input.blockedBy !== undefined) {
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
