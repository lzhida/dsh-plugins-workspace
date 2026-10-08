/**
 * dsh-taskboard 数据模型(教学版,精简自 cloader/dsh-taskboard 的 0.8.x 协议)。
 *
 * 复刻的核心契约:
 * - 任务五列流转(backlog → todo → in_progress → in_review → done),
 *   软删除(archived/canceled/trashed 单独分支);
 * - DoD 验收清单(≤30 项,check 需附证据);
 * - ifVersion 乐观并发:工具接收 ifVersion 校验,版本不匹配拒绝写;
 * - 状态机约束:agent 永远到不了 done、被持有时不可抢、跨项目不可认领;
 * - 评论流、模板存储与导出/导入。
 *
 * 本文件只声明类型(无副作用、无 IO),便于 vitest 直接 import 测试。
 */

// schemastery 仅供可选运行时校验(本教学版用 TS 类型即够,显式不引入依赖)。

/** 任务状态机:五列 + 三种终态。 */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'canceled',
  'archived',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 状态显示:五列主看板,其余归入归档列。 */
export const BOARD_COLUMNS: readonly TaskStatus[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const;

/** 紧急度三色。 */
export const URGENCIES = ['urgent', 'normal', 'relaxed'] as const;
export type Urgency = (typeof URGENCIES)[number];

/** 执行方式:认领(默认)、一次性定时(at)、定期 cron。 */
export const EXECUTION_MODES = ['claim', 'at', 'cron'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** DoD 验收清单项:check 后必须附 note(代码级契约,不可省略)。 */
export interface ChecklistItem {
  readonly id: string;
  /** 条目文本(≤200 字符,与 cloader 对齐)。 */
  readonly text: string;
  readonly checked: boolean;
  /** 勾选证据(由勾选方/模型提供),check 之后必填;un-check 清空。 */
  readonly note?: string;
  /** 勾选时间(epoch ms)。 */
  readonly checkedAt?: number;
  /** 勾选方标识(会话 id / 用户标识);用于归因。 */
  readonly checkedBy?: string;
}

/** 评论:agent 交接、用户退回、状态变更等任意节点追加。 */
export interface Comment {
  readonly id: string;
  readonly taskId: string;
  readonly author: string;
  /** authorKind: agent(模型/工具调用)或 user(看板 GUI)。 */
  readonly authorKind: 'agent' | 'user' | 'system';
  readonly body: string;
  readonly createdAt: number;
}

/** 单次执行记录(同一任务可有多次执行)。 */
export interface ExecutionRecord {
  readonly id: string;
  readonly taskId: string;
  /** 触发方式:手动、定时、cron。 */
  readonly trigger: 'manual' | 'scheduled' | 'cron';
  /** 关联的会话 id(执行中 agent 的会话),便于一键跳转。 */
  readonly sessionId?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly status: 'running' | 'succeeded' | 'failed' | 'canceled';
  /** 结构化执行报告(摘要/改动文件/自验/产物/风险)。 */
  readonly report?: ExecutionReport;
  /** 失败原因(简短,模型可见)。 */
  readonly failureReason?: string;
}

/** 结构化执行报告(agent 收尾时通过 taskboard_execution_report 提交)。 */
export interface ExecutionReport {
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly checks: readonly string[];
  readonly artifacts: readonly string[];
  readonly risk?: string;
  readonly submittedAt: number;
}

/** 任务核心模型:台账的最小原子。 */
export interface Task {
  readonly id: string;
  /** 任务标题(≤200 字符)。 */
  readonly title: string;
  /** 任务描述(Markdown)。 */
  readonly description: string;
  /** 给 agent 看的额外 prompt(协议/Markdown)。 */
  readonly prompt?: string;
  /** 所属项目(DSH workspace id);认领校验以此为边界。 */
  readonly workspaceId: string;
  readonly status: TaskStatus;
  readonly urgency: Urgency;
  readonly execution: ExecutionSpec;
  /** 任务级模型选择(provider+model);undefined = 跟随部署默认。 */
  readonly model?: ModelSelection;
  /** 任务级 agent preset id;undefined = 跟随部署默认。 */
  readonly presetId?: string;
  /** 验收清单(≤30 项)。 */
  readonly checklist: readonly ChecklistItem[];
  /** 持有该任务的会话 id(todo→in_progress 时写入,完成/退回时清空)。 */
  readonly claimSessionId?: string;
  /** 持有者 agent 的会话/用户标识(归因)。 */
  readonly claimOwner?: string;
  /** 乐观并发版本:每次写递增;tool 调用的 ifVersion 必须匹配。 */
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 软删除标记:被删除的任务保留以审计,清单/板视图过滤掉。 */
  readonly trashedAt?: number;
}

/** 模型选择(provider+model,可选推理强度)。 */
export interface ModelSelection {
  readonly provider: string;
  readonly model: string;
  /** 推理强度 id(由 model catalog 提供),undefined = 跟随模型默认。 */
  readonly reasoningEffort?: string;
}

/** 执行方式规约:claim / at / cron。 */
export type ExecutionSpec =
  | { mode: 'claim' }
  | { mode: 'at'; runAt: number }
  | { mode: 'cron'; cron: string };

/** 任务台账顶层:settings + tasks + comments + executions。 */
export interface Ledger {
  readonly settings: LedgerSettings;
  readonly tasks: readonly Task[];
  readonly comments: readonly Comment[];
  readonly executions: readonly ExecutionRecord[];
  /** 顶层 version:任何子集写入递增,导入/导出比对新旧。 */
  readonly version: number;
}

/** 台账设置(本教学版只保留 maxConcurrent,production 还会加 queueMaxAge 等)。 */
export interface LedgerSettings {
  /** 全局并发执行数上限(host 侧调度时使用)。 */
  readonly maxConcurrent: number;
  /** 默认紧急度(新建任务未指定时使用)。 */
  readonly defaultUrgency: Urgency;
  /** 默认执行方式。 */
  readonly defaultExecutionMode: ExecutionMode;
}

/** 默认台账设置:maxConcurrent=3(与 cloader 对齐)/ normal / claim。 */
export const DEFAULT_SETTINGS: LedgerSettings = {
  maxConcurrent: 3,
  defaultUrgency: 'normal',
  defaultExecutionMode: 'claim',
};

/** 空台账(首次启动):无任务、无评论、无执行。 */
export const EMPTY_LEDGER: Ledger = {
  settings: DEFAULT_SETTINGS,
  tasks: [],
  comments: [],
  executions: [],
  version: 1,
};

/** 新任务参数(用于 taskboard_create)。 */
export interface CreateTaskInput {
  readonly title: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly workspaceId: string;
  readonly urgency?: Urgency;
  readonly execution?: ExecutionSpec;
  readonly model?: ModelSelection;
  readonly presetId?: string;
  readonly checklist?: readonly { text: string }[];
}

/** 更新任务参数(用于 taskboard_update):可空字段表示"不修改"。 */
export interface UpdateTaskInput {
  readonly title?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly urgency?: Urgency;
  readonly execution?: ExecutionSpec;
  readonly model?: ModelSelection;
  readonly presetId?: string;
  readonly checklist?: readonly ChecklistItem[];
}

/** 工具通用响应:人类可读文本(模型可见)+ 结构化字段(SDK/路由消费)。 */
export interface ToolResultPayload {
  /** 模型可见文本:agent 看的是这段。 */
  readonly text: string;
  /** 任务 id(若操作针对单一任务)。 */
  readonly taskId?: string;
  /** 新版 version(写后)。 */
  readonly version?: number;
  /** 任务摘要快照(列表/单卡查询返回)。 */
  readonly tasks?: readonly TaskSummary[];
  /** 评论快照。 */
  readonly comments?: readonly Comment[];
  /** checklist 快照。 */
  readonly checklist?: readonly ChecklistItem[];
  /** 是否发生状态变更(用于渲染提示)。 */
  readonly statusChanged?: boolean;
}

export interface TaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly urgency: Urgency;
  readonly workspaceId: string;
  readonly claimSessionId?: string;
  readonly updatedAt: number;
  /** checklist 已勾 / 总数(如 2/5)。 */
  readonly checklistProgress?: { checked: number; total: number };
}

/** 工具错误码:全部失败路径的稳定标识。 */
export type TaskboardErrorCode =
  /** 任务 id 不存在(已删除/不存在)。 */
  | 'TASK_NOT_FOUND'
  /** ifVersion 不匹配(乐观并发冲突)。 */
  | 'VERSION_CONFLICT'
  /** 跨项目不可认领(调用方 workspaceId ≠ task.workspaceId)。 */
  | 'CROSS_PROJECT_FORBIDDEN'
  /** 任务被持有(已有 claimSessionId),不可抢。 */
  | 'TASK_HELD'
  /** 非法状态转移(如 todo→done 跳过 in_review)。 */
  | 'ILLEGAL_TRANSITION'
  /** agent 永远移不到 done:任何到 done 的调用被代码闸拒绝。 */
  | 'DONE_FORBIDDEN'
  /** 缺少必填参数。 */
  | 'INVALID_INPUT'
  /** 验收清单项数 > 30。 */
  | 'CHECKLIST_LIMIT_EXCEEDED'
  /** checklist 项不存在。 */
  | 'CHECKLIST_ITEM_NOT_FOUND'
  /** 勾选 checklist 必须附 evidence note(代码级契约)。 */
  | 'CHECKLIST_NOTE_REQUIRED'
  /** execution report 字段缺失。 */
  | 'REPORT_INCOMPLETE';

export class TaskboardError extends Error {
  readonly code: TaskboardErrorCode;
  readonly meta?: Record<string, unknown>;

  constructor(
    code: TaskboardErrorCode,
    message: string,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskboardError';
    this.code = code;
    if (meta !== undefined) this.meta = meta;
  }
}

/** 格式化为 `[CODE] message` 文本(工具错误统一出口,模型可解析)。 */
export function formatTaskboardError(error: unknown): string {
  if (error instanceof TaskboardError) {
    const head = `[${error.code}] ${error.message}`;
    if (error.meta === undefined) return head;
    return `${head}\n${JSON.stringify(error.meta, null, 2)}`;
  }
  return `[INVALID_INPUT] ${String(error)}`;
}

/** Title 长度上限(与 cloader 对齐,200 字符)。 */
export const TITLE_MAX = 200;
/** Description 长度上限(教学版简化,Markdown 不限长但工具返回需截断展示)。 */
export const DESCRIPTION_DISPLAY_MAX = 2000;
/** Checklist 项数上限(对齐 cloader,30)。 */
export const CHECKLIST_MAX = 30;
/** Checklist note 上限(对齐 cloader 400 字符)。 */
export const CHECKLIST_NOTE_MAX = 400;
/** Comment body 上限(避免恶意长文)。 */
export const COMMENT_BODY_MAX = 4000;

/** 校验 urgency 字符串(类型守卫;运行时用 store.validateXxx)。 */
export function isUrgency(value: unknown): value is Urgency {
  return (
    typeof value === 'string' &&
    (URGENCIES as readonly string[]).includes(value)
  );
}

/** 校验 execution.spec 形状(类型守卫)。 */
export function isExecutionSpec(value: unknown): value is ExecutionSpec {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { mode?: unknown };
  if (v.mode === 'claim') return true;
  if (v.mode === 'at') {
    const r = (value as { runAt?: unknown }).runAt;
    return typeof r === 'number' && Number.isFinite(r) && r > 0;
  }
  if (v.mode === 'cron') {
    const c = (value as { cron?: unknown }).cron;
    return typeof c === 'string' && c.trim().length > 0;
  }
  return false;
}
