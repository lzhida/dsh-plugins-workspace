/**
 * 任务台账(TaskStore):内存态 + 文件持久化 + 乐观并发。
 *
 * 设计原则:
 * 1. 单一真源:内存中的 `ledger` 是当前真相,文件只是其序列化;写路径
 *    总是「load → modify → save」,且 save 阶段做 ifVersion 校验(防止
 *    多会话同时读改写导致覆盖)。
 * 2. 原子写:写文件用「临时文件 + rename」,确保断电/异常不会留下半截
 *    JSON;temp 文件名含纳秒级时间戳,避免重入冲突。
 * 3. 失败不损数据:load 阶段如果文件损坏,落 quarantine 副本并返回空
 *    台账(不抛)—看板仍能启动,任务数据可人工恢复。
 * 4. 查询 API 全部走 ledger 引用,不做深拷贝(由调用方按需 Object.freeze
 *    或解构);写入 API(CRUD)以 immutable 方式返回新 task。
 *
 * 与 cloader 的差异(教学版简化):
 * - 不实现 SSE 推送(UI 由宿主插件提供);
 * - 不实现 asset 存储(图片附件);
 * - 不实现 storage 目录迁移(默认落在 DSH_HOME);
 * - 不实现 cron 调度器(只记录 execution spec)。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  type ChecklistItem,
  type Comment,
  type CreateTaskInput,
  DEFAULT_SETTINGS,
  type ExecutionMode,
  type ExecutionRecord,
  type ExecutionReport,
  type ExecutionSpec,
  EMPTY_LEDGER,
  type Ledger,
  type LedgerSettings,
  type ModelSelection,
  type Task,
  TaskboardError,
  type TaskStatus,
  type TaskSummary,
  type UpdateTaskInput,
  type Urgency,
} from './types.ts';

/** 工具调用的可选身份信息(谁发起的,用于跨项目边界校验、归因)。 */
export interface CallContext {
  /** 调用方所属 workspace(DSH workspace id)。 */
  readonly workspaceId: string;
  /** 调用方标识(会话 id / 用户名),写入 claimOwner / comment.author。 */
  readonly author: string;
  /** authorKind: agent(模型) / user(GUI) / system(本插件自生)。 */
  readonly authorKind: 'agent' | 'user' | 'system';
  /** 当前 epoch ms(测试可注入,生产 = Date.now)。 */
  readonly now: number;
}

/** 任务台账存储配置。 */
export interface TaskStoreOptions {
  /** 台账文件绝对路径;为 undefined 时回退到内存模式(测试/初始化期)。 */
  readonly file?: string;
  /** now() 注入(测试)。 */
  readonly now?: () => number;
  /** 显式初始 settings(覆盖默认;测试用)。 */
  readonly initialSettings?: LedgerSettings;
}

/** 状态机的合法转移表(白名单,其余视为 ILLEGAL_TRANSITION)。 */
const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> =
  {
    backlog: ['todo', 'archived', 'canceled'],
    todo: ['in_progress', 'archived', 'canceled'],
    in_progress: ['in_review', 'todo', 'archived', 'canceled'],
    in_review: ['done', 'in_progress', 'todo', 'archived', 'canceled'],
    done: ['archived', 'in_progress'], // done 可被重开回 in_progress(用户改判)
    canceled: ['archived', 'todo'],
    archived: ['todo'],
  };

/** 状态转移是否合法(教学版 agent 工具自检;production 还会区分 agent/user 角色)。 */
export function isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/**
 * 任务台账(教学版)。
 *
 * 用法:
 *   const store = new TaskStore({ file: '...' });
 *   await store.load();
 *   const tasks = store.list({ workspaceId, status: 'todo' });
 *   const task = store.create(ctx, { ... });
 *   store.move(ctx, id, 'in_progress', task.version);
 */
export class TaskStore {
  private ledger: Ledger = EMPTY_LEDGER;
  private loaded = false;
  private readonly now: () => number;
  private readonly file?: string;
  private readonly initialSettings: LedgerSettings;
  /** 待写盘的内容:每次 CRUD 后置 dirty,统一在 release 时落盘(测试可显式 flush)。 */
  private dirty = false;

  constructor(options: TaskStoreOptions = {}) {
    this.file = options.file;
    this.now = options.now ?? Date.now;
    this.initialSettings = options.initialSettings ?? DEFAULT_SETTINGS;
  }

  /** 当前 ledger 的不可变快照(供工具/路由读)。 */
  snapshot(): Ledger {
    return this.ledger;
  }

  /** 当前 settings 快照。 */
  settings(): LedgerSettings {
    return this.ledger.settings;
  }

  /** 替换 settings(看板设置页使用)。 */
  async updateSettings(
    patch: Partial<LedgerSettings>,
  ): Promise<LedgerSettings> {
    this.ledger = {
      ...this.ledger,
      settings: { ...this.ledger.settings, ...patch },
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return this.ledger.settings;
  }

  /** 从文件加载台账;若文件不存在/损坏,落 quarantine 副本并以默认台账启动。 */
  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.file === undefined) {
      // 内存模式:用 initialSettings 初始化
      this.ledger = { ...EMPTY_LEDGER, settings: this.initialSettings };
      this.loaded = true;
      return;
    }
    const path = resolve(this.file);
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Ledger>;
      this.ledger = normalizeLedger(parsed, this.initialSettings);
    } catch (error) {
      if (isMissingFileError(error)) {
        this.ledger = { ...EMPTY_LEDGER, settings: this.initialSettings };
      } else {
        // 损坏:quarantine 备份后从空台账启动
        try {
          const quarantine = `${path}.corrupt.${this.now()}`;
          await writeFile(
            quarantine,
            await readFile(path, 'utf8').catch(() => ''),
            'utf8',
          );
        } catch {
          // 备份失败不阻塞启动
        }
        this.ledger = { ...EMPTY_LEDGER, settings: this.initialSettings };
      }
    }
    this.loaded = true;
  }

  /**
   * 落盘(原子:临时文件 + rename)。
   * 内存模式下不抛(视为成功 noop)。
   */
  async flush(): Promise<void> {
    if (this.file === undefined) return;
    if (!this.dirty) return;
    const path = resolve(this.file);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp.${process.pid}.${this.now()}.${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(this.ledger, null, 2), 'utf8');
    await rename(tmp, path);
    this.dirty = false;
  }

  // ── 查询 API ───────────────────────────────────────────────────────

  /** 列表:按 workspaceId/status/urgency 过滤,返回紧凑 TaskSummary。 */
  list(filter: {
    workspaceId?: string;
    status?: TaskStatus | TaskStatus[];
    urgency?: Urgency;
    includeTrashed?: boolean;
  }): TaskSummary[] {
    const statuses =
      filter.status === undefined
        ? null
        : Array.isArray(filter.status)
          ? new Set<TaskStatus>(filter.status)
          : new Set<TaskStatus>([filter.status]);
    return this.ledger.tasks
      .filter((task) => {
        if (!filter.includeTrashed && task.trashedAt !== undefined)
          return false;
        if (
          filter.workspaceId !== undefined &&
          task.workspaceId !== filter.workspaceId
        )
          return false;
        if (statuses !== null && !statuses.has(task.status)) return false;
        if (filter.urgency !== undefined && task.urgency !== filter.urgency)
          return false;
        return true;
      })
      .map(toTaskSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 读取单卡全文(供 taskboard_get)。返回 undefined 表示不存在。 */
  get(id: string, opts: { includeTrashed?: boolean } = {}): Task | undefined {
    const task = this.ledger.tasks.find((t) => t.id === id);
    if (task === undefined) return undefined;
    if (!opts.includeTrashed && task.trashedAt !== undefined) return undefined;
    return task;
  }

  /** 读取评论流(按时间正序)。 */
  commentsFor(taskId: string): Comment[] {
    return this.ledger.comments
      .filter((c) => c.taskId === taskId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 读取任务的执行记录(按 startedAt 倒序)。 */
  executionsFor(taskId: string): ExecutionRecord[] {
    return this.ledger.executions
      .filter((e) => e.taskId === taskId)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  // ── 写 API(全部走 ifVersion 校验) ─────────────────────────────────

  /**
   * 建卡(taskboard_create)。
   * 不需要 ifVersion(创建即新 version=1)。
   */
  async create(ctx: CallContext, input: CreateTaskInput): Promise<Task> {
    validateCreateInput(input);
    const id = newTaskId();
    const ts = ctx.now;
    const task: Task = {
      id,
      title: input.title.trim(),
      description: input.description?.trim() ?? '',
      ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      workspaceId: input.workspaceId,
      status: 'todo',
      urgency: input.urgency ?? this.ledger.settings.defaultUrgency,
      execution:
        input.execution ??
        defaultExecution(this.ledger.settings.defaultExecutionMode),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.presetId !== undefined ? { presetId: input.presetId } : {}),
      checklist:
        input.checklist?.map((c) => ({
          id: randomUUID(),
          text: c.text.trim(),
          checked: false,
        })) ?? [],
      version: 1,
      createdAt: ts,
      updatedAt: ts,
    };
    this.ledger = {
      ...this.ledger,
      tasks: [...this.ledger.tasks, task],
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return task;
  }

  /**
   * 改卡(taskboard_update):可空字段表示"不修改"。
   * ifVersion 必传,版本不匹配抛 VERSION_CONFLICT。
   */
  async update(
    ctx: CallContext,
    id: string,
    ifVersion: number,
    patch: UpdateTaskInput,
  ): Promise<Task> {
    const current = this.requireTask(id);
    if (current.version !== ifVersion) {
      throw new TaskboardError(
        'VERSION_CONFLICT',
        `任务 ${id} 的版本不匹配:期望 ${ifVersion},实际 ${current.version};请重读后重试`,
        { expected: ifVersion, actual: current.version, taskId: id },
      );
    }
    if (ctx.workspaceId !== current.workspaceId) {
      throw new TaskboardError(
        'CROSS_PROJECT_FORBIDDEN',
        `任务 ${id} 属于项目 ${current.workspaceId},调用方项目 ${ctx.workspaceId};跨项目不可操作`,
        {
          taskId: id,
          taskWorkspace: current.workspaceId,
          callerWorkspace: ctx.workspaceId,
        },
      );
    }
    validateUpdatePatch(patch);
    const next: Task = {
      ...current,
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description.trim() }
        : {}),
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.urgency !== undefined ? { urgency: patch.urgency } : {}),
      ...(patch.execution !== undefined ? { execution: patch.execution } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.presetId !== undefined ? { presetId: patch.presetId } : {}),
      ...(patch.checklist !== undefined ? { checklist: patch.checklist } : {}),
      version: current.version + 1,
      updatedAt: ctx.now,
    };
    this.ledger = {
      ...this.ledger,
      tasks: this.ledger.tasks.map((t) => (t.id === id ? next : t)),
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return next;
  }

  /**
   * 移卡(taskboard_move):核心状态机。
   *
   * 规则(代码级协议闸):
   * - **DONE_FORBIDDEN**:任何 to=done 的调用被拒绝——验收权只属于人,
   *   agent 永远到不了 done;即使用户在 GUI 触发也必须走专用路径(本教
   *   学版只暴露 move(),GUI 验收由宿主层桥接)。
   * - **CROSS_PROJECT_FORBIDDEN**:ctx.workspaceId 必须等于 task.workspaceId,
   *   跨项目不可认领/操作(对齐 cloader 的「项目边界」契约)。
   * - **TASK_HELD**:todo→in_progress 时,若 task 已被其他会话持有
   *   (claimSessionId 存在且 ≠ ctx.author),拒绝被抢。
   * - **ILLEGAL_TRANSITION**:状态机白名单外转移。
   * - claim 转移(todo→in_progress)同时记录 claimSessionId/claimOwner,
   *   释放转移(in_progress→todo 或 in_review→todo 等)清空持有。
   */
  async move(
    ctx: CallContext,
    id: string,
    to: TaskStatus,
    ifVersion: number,
  ): Promise<Task> {
    const current = this.requireTask(id);
    if (current.version !== ifVersion) {
      throw new TaskboardError(
        'VERSION_CONFLICT',
        `任务 ${id} 版本不匹配:期望 ${ifVersion},实际 ${current.version}`,
        { expected: ifVersion, actual: current.version, taskId: id },
      );
    }
    if (ctx.workspaceId !== current.workspaceId) {
      throw new TaskboardError(
        'CROSS_PROJECT_FORBIDDEN',
        `任务 ${id} 属于项目 ${current.workspaceId},调用方项目 ${ctx.workspaceId};跨项目不可操作`,
        {
          taskId: id,
          taskWorkspace: current.workspaceId,
          callerWorkspace: ctx.workspaceId,
        },
      );
    }
    if (to === 'done') {
      // 关键代码闸:agent 永远移不到 done。即使用户通过工具路径调用,
      // 也必须先走"人工验收"专用路径(本教学版不在 move() 暴露)。
      throw new TaskboardError(
        'DONE_FORBIDDEN',
        `验收权只属于人:agent 永远移不到 done。请用户在看板上点击「✓ 完成」`,
        { taskId: id, attemptedTo: to },
      );
    }
    if (!isLegalTransition(current.status, to)) {
      throw new TaskboardError(
        'ILLEGAL_TRANSITION',
        `非法状态转移: ${current.status} → ${to}`,
        { taskId: id, from: current.status, to },
      );
    }
    // 认领闸:进入 in_progress 状态(从 todo 首次认领)与已在 in_progress
    // 状态下的"重新认领"都校验持有。
    // - todo→in_progress:todo 状态下 claimSessionId 必为 undefined,故仅
    //   兜底校验;生产可加"todo 锁"字段实现 todo 阶段防抢。
    // - in_progress→in_progress:同一任务已被某 session 持有,其他 session
    //   不得"偷走"(典型场景:另一 session 错把 ifVersion 拿对并试图重写
    //   claimSessionId,这是不被允许的;持有 session 才是合法重写方)。
    if (to === 'in_progress') {
      const holder = current.claimSessionId;
      if (holder !== undefined && holder !== ctx.author) {
        throw new TaskboardError(
          'TASK_HELD',
          `任务 ${id} 已被会话 ${holder} 持有,不可抢占`,
          { taskId: id, holder, caller: ctx.author },
        );
      }
    }
    const next: Task = applyClaim(
      {
        ...current,
        status: to,
        version: current.version + 1,
        updatedAt: ctx.now,
      },
      to,
      ctx,
    );
    this.ledger = {
      ...this.ledger,
      tasks: this.ledger.tasks.map((t) => (t.id === id ? next : t)),
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return next;
  }

  /**
   * 软删除(taskboard_delete):写入 trashedAt,版本递增;数据保留供审计。
   * 已 trashed 的任务不可再删(幂等:再删一次抛 TASK_NOT_FOUND)。
   */
  async trash(ctx: CallContext, id: string, ifVersion: number): Promise<Task> {
    const current = this.requireTask(id);
    if (current.trashedAt !== undefined) {
      throw new TaskboardError('TASK_NOT_FOUND', `任务 ${id} 已删除`, {
        taskId: id,
      });
    }
    if (current.version !== ifVersion) {
      throw new TaskboardError(
        'VERSION_CONFLICT',
        `任务 ${id} 版本不匹配:期望 ${ifVersion},实际 ${current.version}`,
        { expected: ifVersion, actual: current.version, taskId: id },
      );
    }
    if (ctx.workspaceId !== current.workspaceId) {
      throw new TaskboardError(
        'CROSS_PROJECT_FORBIDDEN',
        `任务 ${id} 属于项目 ${current.workspaceId},调用方项目 ${ctx.workspaceId}`,
        {
          taskId: id,
          taskWorkspace: current.workspaceId,
          callerWorkspace: ctx.workspaceId,
        },
      );
    }
    const next: Task = {
      ...current,
      trashedAt: ctx.now,
      version: current.version + 1,
      updatedAt: ctx.now,
    };
    this.ledger = {
      ...this.ledger,
      tasks: this.ledger.tasks.map((t) => (t.id === id ? next : t)),
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return next;
  }

  /**
   * 追加评论(taskboard_comment_add)。
   * 评论是流式追加,不走 ifVersion(无字段竞争;但写时也校验任务存在)。
   */
  async addComment(
    ctx: CallContext,
    id: string,
    body: string,
  ): Promise<Comment> {
    const task = this.requireTask(id);
    if (task.trashedAt !== undefined) {
      throw new TaskboardError('TASK_NOT_FOUND', `任务 ${id} 已删除`, {
        taskId: id,
      });
    }
    if (ctx.workspaceId !== task.workspaceId) {
      throw new TaskboardError(
        'CROSS_PROJECT_FORBIDDEN',
        `任务 ${id} 属于项目 ${task.workspaceId},调用方项目 ${ctx.workspaceId}`,
        {
          taskId: id,
          taskWorkspace: task.workspaceId,
          callerWorkspace: ctx.workspaceId,
        },
      );
    }
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      throw new TaskboardError('INVALID_INPUT', '评论内容不能为空', {
        taskId: id,
      });
    }
    const comment: Comment = {
      id: randomUUID(),
      taskId: id,
      author: ctx.author,
      authorKind: ctx.authorKind,
      body: trimmed,
      createdAt: ctx.now,
    };
    this.ledger = {
      ...this.ledger,
      comments: [...this.ledger.comments, comment],
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return comment;
  }

  /**
   * 验收清单操作(taskboard_checklist)。
   * actions: add / check / uncheck。
   * - add:追加条目,数量上限 CHECKLIST_MAX;
   * - check:勾选,note 必填(代码级契约 — 不允许空证据勾选);
   * - uncheck:取消勾选,清空 note / checkedAt / checkedBy。
   *
   * 跨项目校验:同 move。
   */
  async checklist(
    ctx: CallContext,
    id: string,
    ifVersion: number,
    action: 'add' | 'check' | 'uncheck',
    payload: { itemId?: string; text?: string; note?: string },
  ): Promise<{ task: Task; item?: ChecklistItem }> {
    const current = this.requireTask(id);
    if (current.version !== ifVersion) {
      throw new TaskboardError(
        'VERSION_CONFLICT',
        `任务 ${id} 版本不匹配:期望 ${ifVersion},实际 ${current.version}`,
        { expected: ifVersion, actual: current.version, taskId: id },
      );
    }
    if (ctx.workspaceId !== current.workspaceId) {
      throw new TaskboardError(
        'CROSS_PROJECT_FORBIDDEN',
        `任务 ${id} 属于项目 ${current.workspaceId},调用方项目 ${ctx.workspaceId}`,
        {
          taskId: id,
          taskWorkspace: current.workspaceId,
          callerWorkspace: ctx.workspaceId,
        },
      );
    }
    let nextChecklist: ChecklistItem[];
    let targetItem: ChecklistItem | undefined;
    if (action === 'add') {
      if (current.checklist.length >= 30) {
        throw new TaskboardError(
          'CHECKLIST_LIMIT_EXCEEDED',
          `验收清单最多 30 项,当前 ${current.checklist.length}`,
          { taskId: id, current: current.checklist.length, max: 30 },
        );
      }
      if (payload.text === undefined || payload.text.trim().length === 0) {
        throw new TaskboardError(
          'INVALID_INPUT',
          'checklist add 必须提供 text',
          { taskId: id },
        );
      }
      const item: ChecklistItem = {
        id: randomUUID(),
        text: payload.text.trim(),
        checked: false,
      };
      nextChecklist = [...current.checklist, item];
      targetItem = item;
    } else {
      const itemId = payload.itemId;
      if (itemId === undefined) {
        throw new TaskboardError(
          'INVALID_INPUT',
          `checklist ${action} 必须提供 itemId`,
          { taskId: id },
        );
      }
      const existing = current.checklist.find((c) => c.id === itemId);
      if (existing === undefined) {
        throw new TaskboardError(
          'CHECKLIST_ITEM_NOT_FOUND',
          `checklist 项 ${itemId} 不存在`,
          { taskId: id, itemId },
        );
      }
      if (action === 'check') {
        // 代码级契约:check 必须附 evidence note
        const note = payload.note?.trim() ?? '';
        if (note.length === 0) {
          throw new TaskboardError(
            'CHECKLIST_NOTE_REQUIRED',
            '勾选 checklist 项必须附 evidence note(代码级契约)',
            { taskId: id, itemId },
          );
        }
        const updated: ChecklistItem = {
          ...existing,
          checked: true,
          note,
          checkedAt: ctx.now,
          checkedBy: ctx.author,
        };
        nextChecklist = current.checklist.map((c) =>
          c.id === itemId ? updated : c,
        );
        targetItem = updated;
      } else {
        // uncheck:清空勾选证据
        const cleared: ChecklistItem = {
          id: existing.id,
          text: existing.text,
          checked: false,
        };
        nextChecklist = current.checklist.map((c) =>
          c.id === itemId ? cleared : c,
        );
        targetItem = cleared;
      }
    }
    const next: Task = {
      ...current,
      checklist: nextChecklist,
      version: current.version + 1,
      updatedAt: ctx.now,
    };
    this.ledger = {
      ...this.ledger,
      tasks: this.ledger.tasks.map((t) => (t.id === id ? next : t)),
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return {
      task: next,
      ...(targetItem !== undefined ? { item: targetItem } : {}),
    };
  }

  /**
   * 提交结构化执行报告(taskboard_execution_report)。
   * 挂到当前执行记录;若执行记录不存在则惰性创建(succeeded/失败由调用方控制)。
   *
   * 校验:summary 必须非空;其他字段允许空(可后续补)。
   */
  async submitReport(
    ctx: CallContext,
    id: string,
    executionId: string,
    report: Omit<ExecutionReport, 'submittedAt'>,
  ): Promise<{ task: Task; execution: ExecutionRecord }> {
    const task = this.requireTask(id);
    if (ctx.workspaceId !== task.workspaceId) {
      throw new TaskboardError(
        'CROSS_PROJECT_FORBIDDEN',
        `任务 ${id} 属于项目 ${task.workspaceId},调用方项目 ${ctx.workspaceId}`,
        {
          taskId: id,
          taskWorkspace: task.workspaceId,
          callerWorkspace: ctx.workspaceId,
        },
      );
    }
    if (report.summary.trim().length === 0) {
      throw new TaskboardError(
        'REPORT_INCOMPLETE',
        '执行报告 summary 不能为空',
        { taskId: id, executionId },
      );
    }
    const fullReport: ExecutionReport = { ...report, submittedAt: ctx.now };
    const executions = [...this.ledger.executions];
    const idx = executions.findIndex((e) => e.id === executionId);
    if (idx === -1) {
      // 惰性建记录(教学版简化:无 execution 启动概念)
      const rec: ExecutionRecord = {
        id: executionId,
        taskId: id,
        trigger: 'manual',
        startedAt: ctx.now,
        status: 'running',
        report: fullReport,
      };
      executions.push(rec);
    } else {
      const existing = executions[idx]!;
      executions[idx] = { ...existing, report: fullReport };
    }
    this.ledger = {
      ...this.ledger,
      executions,
      version: this.ledger.version + 1,
    };
    this.dirty = true;
    await this.flush();
    return {
      task,
      execution: executions.find((e) => e.id === executionId)!,
    };
  }

  // ── 内部 ───────────────────────────────────────────────────────────

  private requireTask(id: string): Task {
    const task = this.ledger.tasks.find((t) => t.id === id);
    if (task === undefined || task.trashedAt !== undefined) {
      throw new TaskboardError('TASK_NOT_FOUND', `任务 ${id} 不存在或已删除`, {
        taskId: id,
      });
    }
    return task;
  }
}

// ── 模块内纯函数(供 store 内部与单测共用) ──────────────────────────

/** 默认执行方式:claim / at / cron → 对应 spec。 */
export function defaultExecution(mode: ExecutionMode): ExecutionSpec {
  switch (mode) {
    case 'claim':
      return { mode: 'claim' };
    case 'at':
      // 教学版:默认 +5min;生产 at 必填 runAt,这里是 settings 默认
      return { mode: 'at', runAt: Date.now() + 5 * 60_000 };
    case 'cron':
      return { mode: 'cron', cron: '0 9 * * *' };
  }
}

/** 状态转移时的 claim 信息维护(进入 in_progress 记录持有,离开清空)。 */
function applyClaim(task: Task, to: TaskStatus, ctx: CallContext): Task {
  if (to === 'in_progress') {
    return { ...task, claimSessionId: ctx.author, claimOwner: ctx.author };
  }
  if (
    to === 'todo' ||
    to === 'in_review' ||
    to === 'done' ||
    to === 'canceled' ||
    to === 'archived'
  ) {
    // 离开 in_progress 即释放持有(claimSessionId 设为 undefined)
    const { claimSessionId: _a, claimOwner: _b, ...rest } = task;
    void _a;
    void _b;
    return rest;
  }
  return task;
}

/** Task → TaskSummary(列表展示用紧凑形态)。 */
function toTaskSummary(task: Task): TaskSummary {
  const checked = task.checklist.filter((c) => c.checked).length;
  const summary: TaskSummary = {
    id: task.id,
    title: task.title,
    status: task.status,
    urgency: task.urgency,
    workspaceId: task.workspaceId,
    updatedAt: task.updatedAt,
    ...(task.claimSessionId !== undefined
      ? { claimSessionId: task.claimSessionId }
      : {}),
    ...(task.checklist.length > 0
      ? { checklistProgress: { checked, total: task.checklist.length } }
      : {}),
  };
  return summary;
}

/** 校验 create 入参。 */
function validateCreateInput(input: CreateTaskInput): void {
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new TaskboardError('INVALID_INPUT', 'title 必须为非空字符串');
  }
  if (input.title.length > 200) {
    throw new TaskboardError(
      'INVALID_INPUT',
      `title 长度超限: ${input.title.length} > 200`,
    );
  }
  if (
    input.workspaceId === undefined ||
    input.workspaceId.trim().length === 0
  ) {
    throw new TaskboardError('INVALID_INPUT', 'workspaceId 必填');
  }
  if (input.urgency !== undefined && !URGENCY_SET.has(input.urgency)) {
    throw new TaskboardError('INVALID_INPUT', `urgency 非法: ${input.urgency}`);
  }
  if (input.checklist !== undefined && input.checklist.length > 30) {
    throw new TaskboardError(
      'CHECKLIST_LIMIT_EXCEEDED',
      `checklist 数量超限: ${input.checklist.length} > 30`,
    );
  }
  if (input.execution !== undefined) {
    validateExecutionSpec(input.execution);
  }
  if (input.model !== undefined) {
    validateModelSelection(input.model);
  }
}

/** 校验 update 入参(宽松:可空字段不校验)。 */
function validateUpdatePatch(patch: UpdateTaskInput): void {
  if (patch.title !== undefined) {
    if (patch.title.trim().length === 0) {
      throw new TaskboardError('INVALID_INPUT', 'title 不能为空');
    }
    if (patch.title.length > 200) {
      throw new TaskboardError(
        'INVALID_INPUT',
        `title 长度超限: ${patch.title.length} > 200`,
      );
    }
  }
  if (patch.urgency !== undefined && !URGENCY_SET.has(patch.urgency)) {
    throw new TaskboardError('INVALID_INPUT', `urgency 非法: ${patch.urgency}`);
  }
  if (patch.execution !== undefined) {
    validateExecutionSpec(patch.execution);
  }
  if (patch.model !== undefined) {
    validateModelSelection(patch.model);
  }
  if (patch.checklist !== undefined) {
    if (patch.checklist.length > 30) {
      throw new TaskboardError(
        'CHECKLIST_LIMIT_EXCEEDED',
        `checklist 数量超限: ${patch.checklist.length} > 30`,
      );
    }
    for (const item of patch.checklist) {
      if (item.text.trim().length === 0) {
        throw new TaskboardError('INVALID_INPUT', 'checklist 项 text 不能为空');
      }
      if (
        item.checked &&
        (item.note === undefined || item.note.trim().length === 0)
      ) {
        // 允许外部预置 checked 但带 note;若只 checked 无 note 视为非法
        // (但允许从已有数据导入时绕过 — 不在 validate 拦截;checklist() 钩子负责)
      }
    }
  }
}

function validateExecutionSpec(spec: ExecutionSpec): void {
  if (spec.mode === 'at') {
    if (!Number.isFinite(spec.runAt) || spec.runAt <= 0) {
      throw new TaskboardError(
        'INVALID_INPUT',
        `execution.at.runAt 必须为正数`,
      );
    }
  } else if (spec.mode === 'cron') {
    if (spec.cron.trim().length === 0) {
      throw new TaskboardError('INVALID_INPUT', 'execution.cron.cron 不能为空');
    }
  }
}

function validateModelSelection(model: ModelSelection): void {
  if (model.provider.trim().length === 0) {
    throw new TaskboardError('INVALID_INPUT', 'model.provider 不能为空');
  }
  if (model.model.trim().length === 0) {
    throw new TaskboardError('INVALID_INPUT', 'model.model 不能为空');
  }
}

const URGENCY_SET = new Set<Urgency>(['urgent', 'normal', 'relaxed']);

/** 归一化从 JSON 读到的 ledger(对老格式容错)。 */
function normalizeLedger(
  raw: Partial<Ledger>,
  initialSettings: LedgerSettings,
): Ledger {
  return {
    settings: { ...initialSettings, ...(raw.settings ?? {}) },
    tasks: Array.isArray(raw.tasks) ? raw.tasks : [],
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    executions: Array.isArray(raw.executions) ? raw.executions : [],
    version: typeof raw.version === 'number' ? raw.version : 1,
  };
}

/** ENOENT 等"文件不存在"错误的判定(供 load 兜底)。 */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}

/** 生成任务 id:`t-` + 6 字符 nanoid-ish(对齐 cloader 的人类可读形态)。 */
export function newTaskId(): string {
  // 教学版:用 crypto.randomUUID 截 6 字符(碰撞概率极低)
  const uuid = randomUUID().replaceAll('-', '');
  return `t-${uuid.slice(0, 6)}`;
}

// ── 工具专用便捷构造(供 tools.ts 复用) ──────────────────────────────

/** 在 store 外部构造默认 ledger file 路径(教学版:DSH_HOME/dsh-taskboard.json)。 */
export function defaultLedgerPath(homeDir: string): string {
  return join(homeDir, 'dsh-taskboard.json');
}
