/**
 * Host execution service: runs a task through dsh's REAL session machinery —
 * a fresh agent+session inside the task's project workspace (creation carries
 * the pinned model when the task has one), the session is attached to the
 * workspace so it appears in the GUI's project session list, the effective
 * prompt is submitted as an ordinary user message, and the turn settlement
 * (turn/end reason) is folded back into the task's execution record.
 *
 * Manual runs open fresh sessions; scheduled runs can resume their previous
 * session while keeping separate execution records and settlement watchers.
 *
 * @module dsh-taskboard/host/execution
 */
import {
  branchNameModeOf,
  branchNamePrefixOf,
  buildBranchName,
  DEFAULT_PERMISSION,
  effectiveIsolation,
  DEFAULT_MAX_CONCURRENT,
  effectivePrompt,
  isSpentOneShot,
  newCommentId,
  newExecutionId,
  nextCronTime,
  normalizeBody,
  parseCron,
  spawnNextCycle,
  taskModeOf,
  taskSessionId,
  type ExecutionRecord,
  type IsolationMode,
  type PermissionMode,
  type TaskModel,
  type TaskRecord,
  type TaskMode,
} from '../shared/protocol.ts'
import { type GitFace, type SettlementFacts } from './git.ts'
import { prepareOfficialIsolation, type WorktreeIsolation } from './isolation.ts'
import { OFFICIAL_SERVICE_UNAVAILABLE_NOTE, type OfficialWorktreeService, type WorkingDirectoryService } from '../local/official-worktree.ts'
import {
  applyTaskMode,
  goalObjectiveOf,
  type OfficialGoalsService,
  type OfficialPlanModeService,
} from '../local/official-modes.ts'
import {
  matchCompletedTodos,
  todosFromChecklist,
  todosFromEventData,
  TODO_WRITE_BACK_NOTE,
  type PreStepAgentFace,
} from '../local/todo-sync.ts'
import { MessageId } from './sdk.ts'
import type { TaskStore } from './store.ts'
import { dependencyError, gateEnabled } from '../shared/dependencies.ts'

/**
 * Producer-owned message source kind for the framing line dsh-taskboard injects
 * at the head of each execution turn (the "plugin context row"). dsh 0.1.7-rc.2
 * retired the generic `kind: 'plugin'` source — the v4 session format now
 * requires every durable message to carry a producer-owned source kind (a
 * non-empty string that is not `'plugin'`), declared here so the taskboard owns
 * its attribution instead of using the retired wrapper.
 */
import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-taskboard': { kind: 'dsh-taskboard' }
  }
}

/** Why a scheduled conversation could not be continued. */
export type SessionReuseDegradeReason = 'archived' | 'busy' | 'incompatible' | 'unresumable' | 'unavailable'

/** Narrow agents face (the registry's create, structurally). */
export interface AgentsFace {
  /** Restore a compatible scheduled session; undefined means it is unavailable. */
  resumeScheduled?(sessionId: string, options: Parameters<AgentsFace['create']>[0], onDegrade?: (reason: SessionReuseDegradeReason) => void): Promise<Awaited<ReturnType<AgentsFace['create']>> | undefined>
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
    /** Preset composition callback: mounts tools/persona into the agent's scoped context. */
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<{
    agent: {
      id: string
      /** Present on the real DSH agent; rechecked immediately before dispatch. */
      readonly status?: 'idle' | 'running'
      followup(message: unknown): void
      inject(message: unknown): void
      whenIdle(): Promise<void>
    }
    dispose(): Promise<void>
    /** Live sessions borrowed from another owner must survive cancelled startup. */
    borrowed?: boolean
  }>
}

/** A live agent retained by DSH across a plugin hot reload. */
export type LiveAgentFace = Awaited<ReturnType<AgentsFace['create']>>['agent'] & {
  cancel(cause: { kind: 'user' }): void
}

/**
 * The preset composition an execution session is built from — the shape
 * apiproxy's ensureSession produces: resolve → record on the session header,
 * mount → inside agents.create's setup callback.
 */
export interface AgentComposition {
  /** The resolved preset id recorded on the session header. */
  agentPreset: string
  /** Mounts the preset's plugins (tools, persona) into the agent's scope. */
  setup: (agentCtx: unknown) => Promise<void> | void
}

/** Narrow workspaces face for execution. */
export interface ExecutionWorkspaceFace {
  get(id: string): { id: string; path: string } | undefined
  attach(workspaceId: string, sessionId: string): Promise<void>
}

/** Narrow event-bus face for settlement listening. */
export interface EventsFace {
  onSessionEvent(listener: (sessionId: string, event: { type: string; data?: unknown }, sessionMeta?: { header?: { cwd?: string } }) => void | Promise<void>): () => void
}

/** Everything the execution service needs. */
export interface ExecutionDeps {
  store: TaskStore
  agents: AgentsFace
  workspaces: ExecutionWorkspaceFace
  events: EventsFace
  now: () => number
  /** The deployment default model (fills sessions of unpinned tasks). */
  defaultModel?: () => TaskModel | undefined
  /** Mint session ids (injectable for tests). */
  mintSessionId?: () => string
  /** Mint message ids (injectable for tests). */
  mintMessageId?: () => string
  /** Best-effort session rename (pins the session list title to the task title). */
  renameSession?: (sessionId: string, title: string) => void
  /** Max concurrently running executions across all tasks (default 3). */
  maxConcurrent?: number | (() => number)
  /** Delays between settlement write attempts; an empty list disables retries. */
  settlementRetryDelaysMs?: readonly number[]
  /** Resolve a still-live agent so reload reconciliation can adopt its run. */
  liveAgent?: (sessionId: string) => LiveAgentFace | undefined
  /**
   * Git face for the isolation git FINISH work (0.3.0; 0.10.1 narrowed):
   * evidence collection / merge / branch deletion. Absent → every
   * worktree-mode task degrades to the original directory with an
   * isolationNote.
   */
  git?: GitFace
  /**
   * Official worktree service soft-read (0.10.1): the official
   * @deepseek-ai/dsh-experimental-worktree service (`ctx.worktrees`) owns
   * worktree CREATION and RECLAMATION. Undefined → worktree-mode tasks
   * degrade to isolation:none with the enable-the-official-bundle hint
   * (never an error).
   */
  worktrees?: () => OfficialWorktreeService | undefined
  /**
   * Host workingDirectory service soft-read (0.10.1): re-points an agent's
   * effective cwd at a REUSED official checkout (续跑). Undefined → a
   * previous checkout cannot be resumed and the run degrades with a note.
   */
  workingDirectory?: () => WorkingDirectoryService | undefined
  /**
   * Official plan-mode service soft-read (0.11.0 / 看板增强系列 2/6; 5/6 修正
   * 读取拓扑): the official @deepseek-ai/dsh-plan-mode service owns the
   * per-agent `plan/mode` log state. The service mounts inside the SESSION's
   * preset realm (host-plane rows are disabled by design), so the reader
   * receives the LIVE agent and reads through `agentRealmCtx(agent)` — a
   * host-context fallback is resolved on the wiring side (src/index.ts).
   * Undefined → plan-mode tasks degrade to normal mode with a visible
   * execution.taskModeNote (never an error).
   */
  planMode?: (agent: object) => OfficialPlanModeService | undefined
  /**
   * Official goal service soft-read (0.11.0 / 看板增强系列 2/6; 5/6 同修正):
   * the official @deepseek-ai/dsh-goal service owns persistent goals and
   * their round driver. Same live-agent contract as planMode (goals lives on
   * the host plane, but the agent realm resolves it through the shared root
   * store). Undefined → goal-mode tasks degrade to normal mode with a
   * visible execution.taskModeNote (never an error).
   */
  goals?: (agent: object) => OfficialGoalsService | undefined
  /**
   * Resolve the preset composition for an execution session (0.3.3): hands
   * the session its tool set. Absent → sessions run on the bare host
   * composition (pre-preset behavior). A rejection fails the run through
   * the existing failure path — a broken preset never yields a half-composed
   * session (same rollback semantics as apiproxy).
   */
  composeAgent?: (presetId?: string) => Promise<AgentComposition | undefined>
  /**
   * Set execution session permission (0.5.5; 'workspace-write' | 'read-only' | 'danger-full-access').
   */
  setPermission?: (sessionId: string, permission: PermissionMode) => void
}

/** Outcome of a run request (immediate; the run settles asynchronously). */
export type RunRequestResult =
  | { ok: true; executionId: string; sessionId: string }
  | { ok: false; error: string }

/** Outcome of a cancel request. */
export type CancelRequestResult =
  | { ok: true; executionId: string }
  | { ok: false; error: string }

/**
 * Outcome of a comment-delivery request (issue #51 Plan A): 'live' appended
 * the comments to the still-running conversation, 'run' woke a fresh run;
 * count = comments delivered. Failures carry a user-facing error.
 */
export type DeliverCommentsResult =
  | { ok: true; delivered: 'live' | 'run'; count: number; executionId?: string; sessionId?: string }
  | { ok: false; error: string }

/**
 * Merge pending comment bodies into ONE user message (issue #51; user
 * decision 2026-10-23): N comments must never render as N conversation
 * bubbles. A lone comment stays verbatim; several join into a single message
 * separated by a markdown rule under a short count header.
 */
export function mergeCommentBodies(bodies: string[]): string {
  if (bodies.length === 0) return ''
  if (bodies.length === 1) return bodies[0]!
  return `（用户共留言 ${bodies.length} 条，请逐条处理）\n\n${bodies.join('\n\n----\n\n')}`
}

/** Whether a turn/end payload closed with an error reason. */
function isErrorTurnEnd(data: unknown): { message: string } | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const reason = (data as { reason?: unknown }).reason
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind = (reason as { kind?: unknown }).kind
  if (kind !== 'error') return undefined
  const error = (reason as { error?: { message?: unknown } }).error
  const message = typeof error?.message === 'string' ? error.message : 'turn failed'
  console.error('[dsh-taskboard] turn error detail:', JSON.stringify(error)?.slice(0, 2000) ?? '')
  return { message }
}

/** Per-run options. */
export interface RunOptions {
  /**
   * 续跑: keep a live worktree/branch exactly as-is (the previous agent's
   * commits and uncommitted changes survive) instead of resetting to the
   * main HEAD. Falls back to a fresh preparation when none is alive.
   */
  reuseWorktree?: boolean
  /**
   * Scheduler-only dispatch token. The execution gate consumes the matching
   * durable queue entry in the same mutation that creates the running record.
   */
  scheduledWindow?: number
  /**
   * Comment wake (issue #51 Plan A): the pending user comments to deliver,
   * each as its own ordinary user message, in ascending createdAt order.
   * The caller reads them from the ledger; comment bodies are immutable once
   * written (append-only ledger), so the snapshot cannot go stale.
   */
  comments?: Array<{ id: string; body: string }>
}

/** One live execution tracked for settlement and cancellation. */
interface RunEntry {
  sessionId: string
  /** The task this run executes (checklist sync tracking, 看板增强系列 3/6). */
  taskId?: string
  /** Official checkout prepared for this run (evidence collection at ANY settlement). */
  isolation?: WorktreeIsolation
  dispose: () => Promise<void>
  stopping?: Promise<void>
  stopped?: boolean
  settlement?: PendingSettlement
  commentDelivery?: { taskId: string; commentIds: string[]; announce: boolean }
  deliveryWriting?: Promise<void>
}

interface PendingSettlement {
  outcome: 'succeeded' | 'failed' | 'cancelled'
  error?: string
  endedAt: number
  attempts: number
  retry?: ReturnType<typeof setTimeout>
  writing?: Promise<boolean>
  evidenceReady?: boolean
  evidence?: SettlementFacts
}

const SETTLEMENT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000] as const
const ACTIVITY_PERSIST_MS = 60_000
const ACTIVITY_EVENTS = new Set(['turn/start', 'turn/step', 'turn/progress', 'agent/step', 'agent/thought', 'user/message'])

/**
 * The execution service.
 */
export class ExecutionService {
  /** Live executions by execution id (settles and cancels remove entries). */
  private readonly runs = new Map<string, RunEntry>()
  private disposed = false

  /** Detaches the turn/end listener (plugin teardown — review P1). */
  private readonly unsubscribeEvents: () => void

  /** Last activity persistence attempt per live session (avoid per-event disk writes). */
  private readonly lastActivityAt = new Map<string, number>()

  /**
   * 会话 → 卡片：清单同步跟踪（看板增强系列 3/6；见 local/todo-sync.ts）。
   * 只登记看板自己启动的执行会话——pre-step 与 todo/write 事件都按它做 O(1) 过滤，
   * 宿主里的其它会话不会触发任何台账读写。
   */
  private readonly checklistSync = new Map<string, string>()

  /** 已完成初始 todo 注入的会话（注入成功、或 plan 模式/空清单的永久跳过）。 */
  private readonly todoInitialized = new Set<string>()

  /** @param deps - store + agents + workspaces + events + clock. */
  constructor(private readonly deps: ExecutionDeps) {
    this.unsubscribeEvents = deps.events.onSessionEvent((sessionId, event) => {
      if (ACTIVITY_EVENTS.has(event.type)) {
        this.noteActivity(sessionId).catch(error => {
          console.error('[dsh-taskboard] activity persistence error:', error)
        })
      }
      if (event.type === 'todo/write') {
        // 会话任务清单 → 卡片验收清单的单向回写（看板增强系列 3/6）：宿主兜底，
        // 不依赖 agent 自觉；只推进勾选，绝不取消勾选（冲突以卡片清单为准）。
        this.writeBackCompletedChecklist(sessionId, event.data).catch(error => {
          console.error('[dsh-taskboard] checklist write-back error:', error)
        })
      }
      if (event.type !== 'turn/end') return
      // S7 (open question): ANY turn/end with an error reason fails the whole
      // execution and hands the task back. Whether the DSH session loop can
      // produce recoverable per-turn errors (and keep the session alive) needs
      // host-side confirmation; if it can, this should count consecutive
      // errors or wait for an explicit termination signal instead.
      const failure = isErrorTurnEnd(event.data)
      if (failure !== undefined) {
        this.noteFailure(sessionId, failure.message).catch(error => {
          console.error('[dsh-taskboard] failure settlement error:', error)
        })
      }
    })
  }

  /** Detach the settlement listener; safe to call once at plugin teardown. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeEvents()
    for (const entry of this.runs.values()) {
      if (entry.settlement?.retry !== undefined) clearTimeout(entry.settlement.retry)
    }
    this.runs.clear()
    this.lastActivityAt.clear()
    this.checklistSync.clear()
    this.todoInitialized.clear()
  }

  /** Record execution activity at most once per minute for an accurate stale badge. */
  private async noteActivity(sessionId: string): Promise<void> {
    const now = this.deps.now()
    const previous = this.lastActivityAt.get(sessionId)
    if (previous !== undefined && now - previous < ACTIVITY_PERSIST_MS) return
    const entry = [...this.runs.entries()].find(([, run]) => run.sessionId === sessionId)
    if (entry === undefined) return
    this.lastActivityAt.set(sessionId, now)
    const [executionId] = entry
    await this.deps.store.mutate('execution-recorded', ledger => {
      for (const task of ledger.tasks) {
        const execution = task.executions.find(current => current.id === executionId)
        if (execution?.outcome !== 'running') continue
        if (execution.lastActivityAt !== undefined && now - execution.lastActivityAt < ACTIVITY_PERSIST_MS) return undefined
        execution.lastActivityAt = now
        return [task]
      }
      return undefined
    })
  }

  /**
   * 首个 agent/pre-step：把卡片验收清单注入为官方会话任务清单（看板增强系列 3/6）。
   *
   * 注入点选 pre-step 是确定性的：官方 todo 投影在 turn/start 清空，而 pre-step
   * 位于 Session.append 发布之外（官方 dsh-plan-mode 同款先例），append 安全且
   * 必然生效——create 之后、首轮 turn 之前直接 append 会被 turn/start 清掉。
   * 本轮只注入一次；后续轮次由 agent 按 framing 纪律自行 todo_write 维护。
   * 计划模式卡片（声明 taskMode='plan'，官方服务可用与否均如此）不注入：
   * 官方计划模式文案禁止规划期使用 todo_write，规划阶段仍以 exit_plan_mode
   * 提交计划；降级为普通执行的 plan 卡同样跳过——framing 仍按声明口径告知
   * agent 不要用 todo_write，注入一份它被告知不要维护的清单只会自相矛盾。
   *
   * @param agent - pre-step 载荷里的 agent 面（会话 id + session.append）。
   */
  async injectChecklistTodos(agent: PreStepAgentFace): Promise<void> {
    const sessionId = typeof agent.id === 'string' ? agent.id : undefined
    if (sessionId === undefined || this.todoInitialized.has(sessionId)) return
    const taskId = this.checklistSync.get(sessionId)
    if (taskId === undefined) return
    const session = agent.session
    if (session === undefined || typeof session.append !== 'function') return
    const checklist = await this.deps.store.read(ledger => {
      const task = ledger.tasks.find(t => t.id === taskId && t.trashedAt === undefined)
      if (task === undefined) return undefined
      const execution = task.executions.find(e => e.sessionId === sessionId && e.outcome === 'running')
      // Plan cards never get a session list — not even when the official
      // plan-mode service was absent and the run degraded to normal
      // (execution.taskModeNote). The framing (checklistFraming) derives from
      // the task's DECLARED mode and already tells the agent not to use
      // todo_write on plan cards, so injecting a list it is told not to
      // maintain would contradict the prompt.
      if (taskModeOf(task) === 'plan') return undefined
      const mode = execution?.taskMode ?? taskModeOf(task)
      if (mode === 'plan') return undefined
      return task.checklist ?? []
    })
    if (checklist === undefined || checklist.length === 0) {
      // Plan mode, an empty DoD, or a vanished card: mark it as handled so the
      // next pre-step does not retry forever.
      this.todoInitialized.add(sessionId)
      return
    }
    session.append('todo/write', { todos: todosFromChecklist(checklist) })
    this.todoInitialized.add(sessionId)
  }

  /**
   * 会话 todo/write 事件的单向回写（看板增强系列 3/6）：把会话清单里标记
   * completed 的项幂等勾选回卡片验收清单。匹配先精确后近似（agent 常把 DoD 原文
   * 改写后再写回 todo，纯精确匹配会漏掉这种常见情形）。
   *
   * 冲突口径以卡片清单为准——本回写只推进勾选、绝不取消勾选；agent 手动
   * taskboard_checklist 仍是权威路径，本回写是宿主兜底。没有新变化时整个
   * mutation 被放弃（返回 undefined），不写盘、不涨版本。
   */
  private async writeBackCompletedChecklist(sessionId: string, data: unknown): Promise<void> {
    const taskId = this.checklistSync.get(sessionId)
    if (taskId === undefined) return
    const todos = todosFromEventData(data)
    if (todos === undefined) return
    if (!todos.some(todo => todo.status === 'completed')) return
    await this.deps.store.mutate('task-updated', ledger => {
      const index = ledger.tasks.findIndex(t => t.id === taskId && t.trashedAt === undefined)
      if (index < 0) return undefined
      const task = ledger.tasks[index]
      if (task === undefined) return undefined
      const current = task.checklist
      if (current === undefined || current.length === 0) return undefined
      const matched = matchCompletedTodos(todos, current)
      if (matched.size === 0) return undefined
      let changed = false
      const checklist = current.map(item => {
        if (item.checked || !matched.has(item.id)) return item
        changed = true
        return {
          ...item,
          checked: true,
          checkedBy: sessionId,
          checkedAt: this.deps.now(),
          note: TODO_WRITE_BACK_NOTE,
        }
      })
      if (!changed) return undefined
      const next: TaskRecord = {
        ...task,
        checklist,
        version: task.version + 1,
        updatedAt: this.deps.now(),
        updatedBy: { kind: 'agent', sessionId },
      }
      ledger.tasks[index] = next
      return [next]
    })
  }

  /**
   * 热重载接管的会话补登记清单同步（看板增强系列 3/6；尽力而为）。
   * @param executionId - 被接管的执行 id（台账里反查任务）。
   * @param sessionId - 接管后的会话 id。
   */
  private async retrackChecklistSync(executionId: string, sessionId: string): Promise<void> {
    try {
      const taskId = await this.deps.store.read(ledger =>
        ledger.tasks.find(t => t.trashedAt === undefined && t.executions.some(e => e.id === executionId))?.id)
      if (taskId !== undefined && !this.checklistSync.has(sessionId)) {
        this.checklistSync.set(sessionId, taskId)
      }
    } catch {
      /* an adopted run keeps working without checklist sync */
    }
  }

  /** Recreate enough checkout metadata from the durable start record to collect settlement facts. */
  private isolationFromExecution(execution: ExecutionRecord): WorktreeIsolation | undefined {
    if (execution.branch !== undefined && execution.worktreePath !== undefined && execution.baseCommit !== undefined) {
      return {
        path: execution.worktreePath,
        branch: execution.branch,
        baseCommit: execution.baseCommit,
        reused: true,
      }
    }
    return undefined
  }

  /** Attach a new-generation settlement watcher without taking ownership of the live agent. */
  private adoptLiveRun(executionId: string, sessionId: string, agent: LiveAgentFace, isolation: WorktreeIsolation | undefined): void {
    if (this.runs.has(executionId)) return
    this.watchRun(executionId, agent, {
      sessionId,
      ...(isolation !== undefined ? { isolation } : {}),
      // The hot-reloaded service did not create this agent, but it can still
      // honor the existing stop button through the live registry face.
      dispose: async () => { agent.cancel({ kind: 'user' }); await agent.whenIdle() },
    })
    // A hot-reloaded service adopts a run it did not start: its checklist sync
    // registration is rebuilt from the durable execution record (3/6).
    void this.retrackChecklistSync(executionId, sessionId)
  }

  /** Every watcher keeps its entry until the terminal ledger write succeeds. */
  private watchRun(executionId: string, agent: Awaited<ReturnType<AgentsFace['create']>>['agent'], entry: RunEntry): void {
    if (this.disposed) return
    this.runs.set(executionId, entry)
    if (entry.taskId !== undefined) this.checklistSync.set(entry.sessionId, entry.taskId)
    this.lastActivityAt.set(entry.sessionId, this.deps.now())
    void agent.whenIdle().then(
      () => this.requestSettlement(executionId, 'succeeded'),
      () => this.requestSettlement(executionId, 'failed', 'agent did not reach quiescence'),
    ).catch(error => { console.error('[dsh-taskboard] settlement watcher failed:', error) })
  }

  /** Cancellation wins over an uncommitted failure, which wins over success. */
  private requestSettlement(executionId: string, outcome: PendingSettlement['outcome'], error?: string, retryNow = false): Promise<boolean> {
    const entry = this.runs.get(executionId)
    if (this.disposed || entry === undefined) return Promise.resolve(false)
    const priority = { succeeded: 0, failed: 1, cancelled: 2 }
    let pending = entry.settlement
    if (pending === undefined) {
      pending = { outcome, error, endedAt: this.deps.now(), attempts: 0 }
      entry.settlement = pending
    } else if (priority[outcome] > priority[pending.outcome]) {
      pending.outcome = outcome
      pending.error = error
      pending.endedAt = this.deps.now()
      retryNow = true
    }
    if (retryNow && pending.retry !== undefined) {
      clearTimeout(pending.retry)
      pending.retry = undefined
    }
    if (pending.writing !== undefined) return pending.writing
    if (retryNow) pending.attempts = 0
    if (pending.retry !== undefined || (!retryNow && pending.attempts > 0)) return Promise.resolve(false)
    return this.writeSettlement(executionId, entry, pending)
  }

  /** Bounded retries keep both the outcome intent and concurrency reservation. */
  private writeSettlement(executionId: string, entry: RunEntry, pending: PendingSettlement): Promise<boolean> {
    const write = async (): Promise<boolean> => {
      pending.attempts += 1
      try {
        if (pending.outcome === 'cancelled') await this.stopRun(entry)
        else await entry.stopping
        if (this.disposed || this.runs.get(executionId) !== entry) return false
        await this.flushCommentDelivery(executionId, entry)
        let settled = await this.settleExecution(executionId, entry.sessionId, entry.isolation, pending)
        // Cancellation may arrive after this attempt entered the store queue.
        // A skipped write waits for the agent stop before trying its new intent.
        if (!settled && !this.disposed) {
          await entry.stopping
          settled = await this.settleExecution(executionId, entry.sessionId, entry.isolation, pending)
        }
        if (!settled) return false
        if (this.runs.get(executionId) === entry) this.runs.delete(executionId)
        this.lastActivityAt.delete(entry.sessionId)
        this.checklistSync.delete(entry.sessionId)
        this.todoInitialized.delete(entry.sessionId)
        return true
      } catch (error) {
        if (this.disposed || this.runs.get(executionId) !== entry) return false
        const delays = this.deps.settlementRetryDelaysMs ?? SETTLEMENT_RETRY_DELAYS_MS
        const delay = delays[pending.attempts - 1]
        console.error(`[dsh-taskboard] settlement ${executionId} (${pending.outcome}, ${this.deps.store.location()}) write failed; ${delay === undefined ? 'automatic retries exhausted; restore storage and retry Stop or reload the plugin' : `retrying in ${delay}ms`}:`, error)
        if (delay !== undefined) {
          pending.retry = setTimeout(() => {
            pending.retry = undefined
            if (this.disposed || this.runs.get(executionId) !== entry) return
            void this.writeSettlement(executionId, entry, pending).catch(error => {
              console.error('[dsh-taskboard] settlement retry failed:', error)
            })
          }, delay)
          pending.retry.unref?.()
        }
        return false
      } finally {
        pending.writing = undefined
      }
    }
    pending.writing = write()
    return pending.writing
  }

  /**
   * Best-effort evidence collection from the official checkout (0.10.1):
   * git.collect NEVER throws (fail-soft internal) and a missing git face or
   * checkout resolves undefined — settlement never blocks on git.
   */
  private async collectEvidence(isolation: WorktreeIsolation | undefined): Promise<SettlementFacts | undefined> {
    if (isolation === undefined || this.deps.git === undefined) return undefined
    try {
      return await this.deps.git.collect(isolation.path, isolation.baseCommit)
    } catch {
      return undefined /* fail-soft: no evidence, settlement continues */
    }
  }

  /**
   * Copy collected facts onto an execution record (in place). The record keeps
   * the legacy flat-field shape (single official checkout).
   */
  private applyFacts(
    execution: ExecutionRecord,
    facts: SettlementFacts | undefined,
  ): void {
    if (facts === undefined) return
    if (facts.headCommit !== undefined) execution.headCommit = facts.headCommit
    execution.commits = facts.commits
    execution.commitsTotal = facts.commitsTotal
    execution.dirtyFiles = facts.dirtyFiles
    execution.dirtyFilesTotal = facts.dirtyFilesTotal
    execution.changedFiles = facts.changedFiles
    if (facts.diffStat !== undefined) execution.diffStat = facts.diffStat
  }

  /** Request failure settlement without letting a later idle success replace it. */
  private noteFailure(sessionId: string, message: string, executionId?: string): Promise<boolean> {
    const match = [...this.runs.entries()].find(([id, entry]) => entry.sessionId === sessionId && (executionId === undefined || id === executionId))
    return match === undefined ? Promise.resolve(false) : this.requestSettlement(match[0], 'failed', message)
  }

  /**
   * Patch one task's execution record in the ledger. R3 depth: a record that
   * already settled (cancelled/failed/succeeded) is never resurrected — the
   * startup path patches sessionId long after the gate opened, and a cancel
   * may have committed in between.
   */
  private async patchExecution(executionId: string, patch: Partial<ExecutionRecord>): Promise<void> {
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      for (const task of ledger.tasks) {
        const execution = task.executions.find(e => e.id === executionId)
        if (execution !== undefined) {
          if (execution.outcome !== 'running') return undefined
          Object.assign(execution, patch)
          return [task]
        }
      }
      return undefined
    })
  }

  /**
   * Run one task now (manual button or scheduler tick).
   *
   * The in-progress gate and the execution-open write happen inside ONE
   * serial-queue mutation, so two overlapping run() calls (double click,
   * overlapping scheduler ticks) can never both pass — exactly one session
   * is opened per task.
   * @param taskId - the task to run.
   * @param trigger - what started it.
   * @param options - per-run options (`reuseWorktree` = 续跑).
   * @returns the immediate result; settlement lands in the ledger.
   */
  async run(taskId: string, trigger: ExecutionRecord['trigger'], options?: RunOptions): Promise<RunRequestResult> {
    if (this.disposed) return { ok: false, error: 'execution service is disposed' }
    const max = typeof this.deps.maxConcurrent === 'function' ? this.deps.maxConcurrent() : this.deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    if (this.runs.size >= max) {
      return { ok: false, error: `execution concurrency limit reached (${this.runs.size}/${max} running)` }
    }
    const task = this.deps.store.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) {
      return { ok: false, error: `no task ${taskId}` }
    }
    const workspace = this.deps.workspaces.get(task.workspaceId)
    if (workspace === undefined) {
      return { ok: false, error: `unknown workspace ${task.workspaceId}` }
    }

    const executionId = newExecutionId()
    let sessionId = this.deps.mintSessionId?.() ?? `session-taskboard-${crypto.randomUUID()}`

    // 0. Resolve code isolation (plan §3.2): explicit 'none' → zero git calls;
    //    'worktree' (also the omitted default) → prepare below, degrading to
    //    the original directory fail-soft on any git problem.
    const isolation: IsolationMode = effectiveIsolation(task)
    // 看板增强系列 2/6: the card's task mode (normal | goal | plan). It is a
    // TASK semantic (what the run is supposed to achieve), completely
    // independent of execution.mode (claim | scheduled — WHEN it runs).
    const taskMode: TaskMode = taskModeOf(task)
    // Issue #98: an explicit branch (task-level override, possibly pinned
    // earlier) wins; otherwise the board naming preset decides. Either way
    // the FIRST worktree creation pins the result for merge/continuation.
    const settings = this.deps.store.snapshot().settings
    const branch = task.branch ?? buildBranchName(task.title, task.id, branchNameModeOf(settings), branchNamePrefixOf(settings))

    // 1. Open the execution record, flip the card to in_progress, and record
    //    the executing session as the claim holder — atomically.
    let gate: string | undefined
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target === undefined || target.trashedAt !== undefined) {
        gate = `no task ${taskId}`
        return undefined
      }
      const dependencyGate = trigger === 'scheduled' ? 'scheduled' : trigger === 'comment' || target.status === 'in_review' ? 'review' : 'manual'
      const blocked = gateEnabled(ledger.settings, dependencyGate) && dependencyError(ledger.tasks, target)
      if (blocked) {
        gate = blocked
        return undefined
      }
      // A status may change after the scheduler selected/advanced the task.
      // Recheck at the atomic execution gate so terminal tasks cannot be
      // revived by that race. Only todo fires scheduled (periodic or one-
      // shot); an in_review card is finished work and never refires — a
      // periodic run's successor todo card carries the schedule onward.
      // Manual reruns keep their existing semantics.
      if (trigger === 'scheduled' && target.status !== 'todo') {
        gate = `scheduled task is not actionable (${target.status})`
        return undefined
      }
      if (trigger === 'scheduled' && options?.scheduledWindow !== undefined
        && target.execution.dispatchingRunAt !== options.scheduledWindow) {
        gate = 'scheduled dispatch is no longer queued'
        return undefined
      }
      // Issue #51 Plan A: a comment wake is the acceptance-review loop — it
      // only fires on an in_review card. Rechecked INSIDE the gate (not just
      // at the route) so a card that moved between route check and this
      // mutation can never be woken by a stale delivery.
      if (trigger === 'comment' && target.status !== 'in_review') {
        gate = `comment wake requires in_review (current ${target.status})`
        return undefined
      }
      // Refuse while work is IN FLIGHT: a live execution, or a session holding
      // the claim. Status alone is not the test — a card moved back to
      // in progress by the user, or left behind by a run whose host died,
      // is in progress with nothing holding it, and refusing that made the
      // card unrunnable until it was pushed back through todo (issue #50).
      // A run that passes this gate re-claims the card, so the orphan state
      // repairs itself instead of persisting.
      if (target.executions.some(e => e.outcome === 'running') || target.claimedBy !== undefined) {
        gate = 'task is already in progress'
        return undefined
      }
      // S4: authoritative capacity check INSIDE the gate — counts ledger-wide
      // running executions, immune to the startup window (`runs` registers
      // only after agent creation, seconds later).
      const running = ledger.tasks.reduce((n, t) => n + t.executions.filter(e => e.outcome === 'running').length, 0)
      if (running >= max) {
        gate = `execution concurrency limit reached (${running}/${max} running)`
        return undefined
      }
      target.executions.push({
        id: executionId,
        trigger,
        startedAt: this.deps.now(),
        lastActivityAt: this.deps.now(),
        outcome: 'running',
        ...(isolation === 'none' ? { isolation: 'none' as const } : { isolation: 'worktree' as const, branch }),
      })
      if (options?.scheduledWindow !== undefined) {
        delete target.execution.dispatchingRunAt
        delete target.execution.queuedAt
        target.execution.lastTriggeredAt = options.scheduledWindow
      }
      target.status = 'in_progress'
      target.updatedAt = this.deps.now()
      target.updatedBy = { kind: 'system' }
      target.claimedBy = sessionId
      target.claimedAt = this.deps.now()
      return [target]
    })
    if (gate !== undefined) return { ok: false, error: gate }

    let isolationNote: string | undefined
    let prepared: WorktreeIsolation | undefined

    // Isolation now rides the OFFICIAL ctx.worktrees service (0.10.1). The
    // official `create` switches the executing session's EFFECTIVE working
    // directory to the checkout, so preparation runs AFTER the agent handle
    // exists below — never before agent creation (the previous pre-create
    // ordering would prepare with no agent to switch). The session header cwd
    // stays the workspace root (immutable): attachSession validation, sidebar
    // grouping and the sandbox boundary all keep working (spike-verified,
    // docs/official-worktree-spike.md).
    const prepareIsolation = async (agent: object): Promise<void> => {
      if (isolation !== 'worktree') return
      const worktrees = this.deps.worktrees?.()
      if (worktrees === undefined) {
        isolationNote = OFFICIAL_SERVICE_UNAVAILABLE_NOTE
        await this.patchExecution(executionId, { isolation: 'none', isolationNote, branch: undefined, worktreePath: undefined, baseCommit: undefined })
        return
      }
      if (this.deps.git === undefined) {
        isolationNote = 'git 集成不可用，已在原目录执行'
        await this.patchExecution(executionId, { isolation: 'none', isolationNote, branch: undefined, worktreePath: undefined, baseCommit: undefined })
        return
      }
      // Reuse candidate: the last isolated execution's official checkout.
      const previousExecution = [...task.executions].reverse().find(e => e.worktreePath !== undefined && e.branch !== undefined)
      const previous = previousExecution !== undefined
        ? { path: previousExecution.worktreePath as string, branch: previousExecution.branch as string }
        : undefined
      const outcome = await prepareOfficialIsolation(
        {
          git: this.deps.git,
          worktrees,
          workingDirectory: this.deps.workingDirectory?.(),
        },
        {
          agent,
          branch,
          // Comment wake NEVER abandons the previous checkout: the comments
          // review the PREVIOUS run's work (and official checkouts are never
          // reset anyway — reuse is the only continuation the service allows).
          reuse: options?.reuseWorktree === true || trigger === 'comment',
          ...(previous !== undefined ? { previous } : {}),
        },
      )
      if (outcome.isolation !== undefined) {
        prepared = outcome.isolation
        await this.pinBranches(task, outcome.isolation)
        // Persist the actual checkout facts (branch may have been pinned;
        // reuse keeps the previous path with a fresh HEAD baseline).
        await this.patchExecution(executionId, {
          branch: outcome.isolation.branch,
          worktreePath: outcome.isolation.path,
          baseCommit: outcome.isolation.baseCommit,
        })
      } else {
        isolationNote = outcome.note
        // Degraded run: clear the optimistic worktree markers.
        await this.patchExecution(executionId, { isolation: 'none', isolationNote, branch: undefined, worktreePath: undefined, baseCommit: undefined })
      }
    }

    // 2. Create or resume the agent+session inside the task's project, carrying
    //    the pinned model — or the deployment default when unpinned (the
    //    persona template renders {{model}}, so the session always needs one).
    //    The session HEADER cwd is ALWAYS the project root — DSH requires
    //    header.cwd === the workspace path EXACTLY (attachSession validates
    //    it, the sidebar groups by it, and the file sandbox takes it as the
    //    workspace-write boundary). Worktree isolation (0.10.1) is applied
    //    AFTER creation by the OFFICIAL worktree service, which switches the
    //    session's EFFECTIVE working directory to the checkout via a
    //    working-directory/change event — the immutable header keeps pointing
    //    at the project root, so all three invariants above hold
    //    (spike-verified). The framing line below also tells the agent where
    //    it now works.
    //    Preset composition (0.3.3): resolve BEFORE creation so the header
    //    snapshots `agentPreset` and the setup callback mounts the preset's
    //    tools/persona into the agent's scope. undefined composeAgent (or an
    //    absent preset roster) keeps the bare host composition.
    let composition: AgentComposition | undefined
    try {
      composition = this.deps.composeAgent === undefined ? undefined : await this.deps.composeAgent(task.presetId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.patchExecution(executionId, { outcome: 'failed', error: `preset 组合失败：${message.slice(0, 400)}`, endedAt: this.deps.now() })
      await this.revertProgress(taskId)
      // Isolation preparation has not run yet (it needs the agent handle), so
      // there is no checkout to clean up on this path.
      return { ok: false, error: `preset composition failed: ${message}` }
    }
    let handle: Awaited<ReturnType<AgentsFace['create']>>
    let reuseFallbackNote: string | undefined
    let sessionReuseKey: string | undefined
    try {
      const model = task.model ?? this.deps.defaultModel?.()
      const createOptions: Parameters<AgentsFace['create']>[0] = {
        sessionId,
        meta: {
          cwd: workspace.path,
          ...(composition !== undefined ? { agentPreset: composition.agentPreset } : {}),
        },
        ...(model !== undefined ? {
          agentOptions: {
            provider: model.provider,
            model: model.model,
            ...(model.reasoningEffort !== undefined ? { reasoningEffort: model.reasoningEffort } : {}),
          },
        } : {}),
        ...(composition !== undefined ? { setup: composition.setup } : {}),
      }
      // Persist the effective settings, including resolved defaults. Never
      // continue history under a different project, model, preset or boundary.
      // The task mode (看板增强系列 2/6) joins the key: a plan-mode session
      // carries a `plan/mode` log state and a goal-mode session carries an
      // armed goal — resuming either under another mode would silently run
      // the card in a mode the conversation was never set up for.
      sessionReuseKey = JSON.stringify([
        task.workspaceId, workspace.path, composition?.agentPreset ?? null,
        model?.provider ?? null, model?.model ?? null, model?.reasoningEffort ?? null,
        task.permission ?? DEFAULT_PERMISSION, isolation, taskMode,
      ])
      // Session continuation candidate: scheduled uses its explicit binding;
      // a comment wake (issue #51) continues the ONE conversation the card
      // points at (shared taskSessionId resolution — running execution is
      // impossible here, the gate refused it). resumeScheduled's compatibility
      // check downgrades to a fresh session when cwd/preset/model drifted.
      const selectedSessionId = trigger === 'scheduled'
        ? task.execution.reuseSessionId
        : trigger === 'comment'
          ? taskSessionId(task)
          : undefined
      if (selectedSessionId !== undefined) {
        let reason: SessionReuseDegradeReason = 'unavailable'
        const resumed = await this.deps.agents.resumeScheduled?.(selectedSessionId, createOptions, value => { reason = value })
        if (resumed === undefined) {
          reuseFallbackNote = `bound session ${selectedSessionId} could not be reused (${reason}); starting a fresh conversation without previous context`
          await this.patchExecution(executionId, { reuseFallbackNote })
        }
        handle = resumed ?? await this.deps.agents.create(createOptions)
      } else {
        // A task can explicitly require a fresh conversation every time. Old
        // ledgers omit sessionReuseMode and deliberately retain #26's legacy
        // auto-reuse behavior.
        const reuseCreatedSession = trigger === 'scheduled' && task.execution.cron !== undefined
          && task.execution.sessionReuseMode !== 'fresh'
        const previous = trigger === 'scheduled'
          ? [...task.executions].reverse().find(e => e.trigger === 'scheduled' && e.sessionId !== undefined)
          : undefined
        const automaticSessionId = task.execution.autoReuseSessionId
          ?? (previous?.sessionReuseKey === sessionReuseKey ? previous.sessionId : undefined)
        const automaticSessionKey = task.execution.autoReuseSessionId !== undefined
          ? task.execution.autoReuseSessionKey
          : previous?.sessionReuseKey
        const resumed = reuseCreatedSession && automaticSessionKey === sessionReuseKey && automaticSessionId !== undefined
          ? await this.deps.agents.resumeScheduled?.(automaticSessionId, createOptions)
          : undefined
        handle = resumed ?? await this.deps.agents.create(createOptions)
      }
      sessionId = handle.agent.id
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.patchExecution(executionId, { outcome: 'failed', error: message.slice(0, 500), endedAt: this.deps.now() })
      await this.revertProgress(taskId)
      // Isolation preparation has not run yet (it needs the agent handle), so
      // there is no checkout to clean up on this path.
      return { ok: false, error: message }
    }

    // R3: the startup path above awaited seconds of git + agent work. A
    // cancel() that landed inside that window already settled the execution
    // (cancelled + task back to todo) — with nothing registered in `runs`,
    // it could not dispose the agent this path was about to create. Re-verify
    // INSIDE the queue (after any enqueued cancel committed) BEFORE injecting:
    // a cancelled card must not gain a zombie session that burns tokens and
    // edits files while the task sits in todo, re-runnable by anyone.
    const stillRunning = await this.deps.store.read(ledger =>
      ledger.tasks.some(t => t.executions.some(e => e.id === executionId && e.outcome === 'running')))
    if (!stillRunning || this.runs.get(executionId)?.settlement?.outcome === 'cancelled' || this.disposed) {
      if (!handle.borrowed) await handle.dispose().catch(() => { /* best effort */ })
      // Isolation preparation runs after this check (3b below), so nothing
      // needs cleaning behind a cancelled startup.
      return { ok: false, error: 'cancelled during startup' }
    }

    // 3. Attach the session to the workspace (GUI project session list).
    await this.deps.workspaces.attach(task.workspaceId, sessionId).catch(() => { /* cosmetic */ })

    // 3a. Apply execution session permission (0.5.5; 'workspace-write' | 'read-only' | 'danger-full-access').
    if (this.deps.setPermission !== undefined) {
      try {
        this.deps.setPermission(sessionId, task.permission ?? DEFAULT_PERMISSION)
      } catch { /* best effort */ }
    }

    // 3b. Isolation (0.10.1): prepare AFTER the agent exists AND after the
    //     permission preset landed — the official worktree service switches
    //     THIS agent's effective working directory to the checkout, and its
    //     git writes need a non-read-only sandbox (the preset propagates
    //     'sandbox/mode' for live sessions only, hence this order).
    //     A failure degrades to isolation:none (note kept) and the run
    //     proceeds in the original directory — never an error.
    await prepareIsolation(handle.agent as object)

    // 3b-2. Task mode (看板增强系列 2/6): normal | goal | plan.
    //     Timing is a hard requirement:
    //       * the official plan/goal services need the LIVE agent instance
    //         that agents.create just resolved — the goal service's
    //         assertLive rejects anything else (and a later phase would hold a
    //         different instance), so the call must happen HERE, right after
    //         the handle exists;
    //       * it must still happen BEFORE the opening user message is
    //         injected, otherwise the first turn already runs in the wrong
    //         mode.
    //     'normal' never touches an official service. A missing service or a
    //     failing call degrades to normal mode with a VISIBLE note on the
    //     execution record — never a silent failure.
    // TEMP DIAGNOSTIC (5/6 e2e) 已删除（服务读取拓扑已定位，见 official-modes.ts）。
    // 5/6 修正：官方目标模式在 goals.create 成功后由 goal-round-driver 立刻起
    //     第 1 回合——agent.status 会在本函数内从 idle 变 running。那是「我们自己
    //     刚开的执行」，不是「插队到别人正在跑的会话」，不能按 busy 判失败：
    //     旧判定会把刚起的回合 abort 掉（kanban-e2e 实测：目标卡 execution
    //     failed、error='scheduled session is busy'、回合 aborted/disposed）。
    const agentStatusBeforeMode = handle.agent.status
    const modeApplication = applyTaskMode({
      mode: taskMode,
      agent: handle.agent as object,
      // Soft service reads stay lazy: a 'normal' card must not touch the
      // official plan/goal services at all (系列 2/6 acceptance) — the
      // getters are only invoked for goal/plan cards. 5/6 修正：读取拓扑走
      // live agent 的会话 realm（agentRealmCtx），宿主面服务经共享根 store
      // 同样可解析（见 official-modes.ts 顶部文档）。
      planMode:
        taskMode !== 'normal' ? this.deps.planMode?.(handle.agent as object) : undefined,
      goals:
        taskMode !== 'normal' ? this.deps.goals?.(handle.agent as object) : undefined,
      // 5/6 修正：planMode 服务只挂在每会话 preset realm 内，宿主面读不到；
      // 官方计划状态以会话投影（折叠 plan/mode 事件）为准，故把 live agent 的
      // 会话对象交出去，让模式层能写同一条官方事件激活计划模式。
      session:
        taskMode !== 'normal'
          ? (handle.agent as { session?: unknown }).session
          : undefined,
      // Objective = title + description (see goalObjectiveOf for the
      // rationale: the goal must state WHAT to achieve, while the execution
      // prompt already reached the session as the opening message).
      objective: goalObjectiveOf(task),
    })
    const taskModeNote = modeApplication.note
    // 目标模式由本次运行自己开回合（idle → running），故不计为 busy。
    //   注意：goal-round-driver 的第 1 回合是**异步**起的——goals.create
    //   返回那一刻 agent.status 可能仍是 idle，busy 判定发生在若干 await
    //   之后，那时才变 running。所以「是否由我们开跑」要在 busy 判定点按
    //   **当时**的 status 复核（见下方 goalArmedRun），不能只看模式应用后的
    //   瞬时快照。
    await this.patchExecution(executionId, {
      taskMode: modeApplication.applied,
      ...(taskModeNote !== undefined ? { taskModeNote } : {}),
    })
    if (taskModeNote !== undefined) {
      console.warn('[dsh-taskboard] task mode degraded to normal:', taskModeNote)
    } else if (modeApplication.evidence !== undefined) {
      console.log('[dsh-taskboard] task mode applied:', modeApplication.evidence)
    }

    // 3c. Best-effort rename: pin the session title to the task title so the
    //     session list shows the task name (a user-sourced title also stops
    //     automatic first-prompt retitling).
    try {
      if (task.execution.reuseSessionId !== sessionId) this.deps.renameSession?.(sessionId, task.title)
    } catch { /* cosmetic */ }

    // 4. Record the session id (execution is really started now).
    await this.deps.store.mutate('execution-recorded', ledger => {
      const target = ledger.tasks.find(t => t.id === taskId)
      const execution = target?.executions.find(e => e.id === executionId && e.outcome === 'running')
      if (target === undefined || execution === undefined) return undefined
      Object.assign(execution, { sessionId, ...(trigger === 'scheduled' ? { sessionReuseKey } : {}) })
      // `reuse` is independent of periodic completion: once the first run
      // creates a session, successor cards inherit this pointer and continue
      // it; `fresh` never records a continuation target.
      if (trigger === 'scheduled' && target.execution.cron !== undefined && target.execution.reuseSessionId === undefined
        && target.execution.sessionReuseMode !== 'fresh') {
        target.execution.autoReuseSessionId = sessionId
        target.execution.autoReuseSessionKey = sessionReuseKey
      }
      target.claimedBy = sessionId
      return [target]
    })

    // Attach/ledger writes above may yield to manual activity or cancellation.
    // Do not inject a scheduled prompt into an already running conversation.
    const current = this.deps.store.get(taskId)?.executions.find(e => e.id === executionId)
    const cancellationPending = this.runs.get(executionId)?.settlement?.outcome === 'cancelled' || this.disposed
    // 目标模式：模式由**本次运行**激活（applied==='goal'），且模式应用前 agent 还是
    //   idle（说明这个会话本来没人跑），此刻 running 只可能是官方 goal-round-driver
    //   自己起的第 1 回合 → 不能按 busy 判失败（否则刚起的回合被 abort）。
    //   会话若在派发前就已被别处占用（模式应用前已是 running），旧语义保持不变。
    const goalArmedRun = taskMode === 'goal'
      && modeApplication.applied === 'goal'
      && agentStatusBeforeMode === 'idle'
      && handle.agent.status === 'running'
    if (current?.outcome !== 'running' || cancellationPending || (handle.agent.status === 'running' && !goalArmedRun)) {
      if (!handle.borrowed) await handle.dispose().catch(() => { /* best effort */ })
      if (current?.outcome === 'running' && !cancellationPending) {
        await this.patchExecution(executionId, { outcome: 'failed', error: 'scheduled session is busy', endedAt: this.deps.now() })
        await this.revertProgress(taskId)
      }
      return { ok: false, error: current?.outcome === 'running' && !cancellationPending ? 'scheduled session is busy' : 'cancelled during startup' }
    }

    // 5. Submit the opening pair and settle on quiescence (turn/end errors
    //    were already folded by the listener). Two messages, ONE turn:
    //    - inject() queues the plugin framing line (next-step, no wake); it
    //      renders as a plugin context row in the conversation.
    //    - followup() queues the card body as a normal user message
    //      (next-turn, wakes the driver). At claim time the loop drains ALL
    //      next-step messages plus the one next-turn message into a single
    //    turn — framing first, then the user bubble.
    //    Comment wake (issue #51): the framing changes to the review variant
    //    and ALL pending comments go in as ONE merged user message (never N
    //    bubbles; lone comment stays verbatim) — user decision 2026-10-23.
    const commentWake = trigger === 'comment' && (options?.comments?.length ?? 0) > 0
    // goal 模式下开场合一与官方第 1 回合**并存是预期行为**（5/6 e2e-10 活体）：
    // goals.create 后 goal-round-driver 先把 <goal_round> splice 进 inbox（seq10），
    // 本卡开场合一随后注入（framing→next-step、正文→next-turn，seq15/16），
    // 会话按 framing → 正文 → goal_round 的稳定顺序排布且执行成功。不跳过注入：
    // DoD 与纪律说明只随卡片消息到达，goal_round 只带 objective。
    handle.agent.inject({
      id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
      role: 'user' as const,
      content: [{ type: 'text' as const, text: (commentWake ? this.commentFraming(task, prepared, isolationNote) : this.pluginFraming(task, prepared, isolationNote)) + (reuseFallbackNote !== undefined ? `\n⚠ ${reuseFallbackNote}` : '') + (taskModeNote !== undefined ? `\n⚠ ${taskModeNote}` : '') }],
      source: { kind: 'dsh-taskboard' as const },
    })
    if (commentWake) {
      handle.agent.followup({
        id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: mergeCommentBodies(options!.comments!.map(c => c.body)) }],
        source: { kind: 'user' as const },
      })
    } else {
      handle.agent.followup({
        id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: this.userBody(task) }],
        source: { kind: 'user' as const },
      })
    }
    // Track the live agent before any post-dispatch write can fail. Delivery
    // metadata shares the settlement retry path, so a disk error cannot orphan
    // the agent or make the already queued comments eligible for redelivery.
    const entry: RunEntry = {
      sessionId,
      taskId,
      ...(prepared !== undefined ? { isolation: prepared } : {}),
      dispose: () => handle.dispose(),
      ...(commentWake ? { commentDelivery: { taskId, commentIds: options!.comments!.map(c => c.id), announce: true } } : {}),
    }
    // 6. Settlement watcher: mark succeeded, release the executing session's
    //    hold, collect the worktree evidence (commits / dirty / diff), and —
    //    when the session did NOT follow the handoff protocol — auto-move the
    //    card to in_review with a system comment.
    this.watchRun(executionId, handle.agent, entry)
    if (commentWake) {
      try { await this.flushCommentDelivery(executionId, entry) } catch (error) {
        console.error('[dsh-taskboard] comment delivery metadata write failed; execution remains tracked and settlement will retry:', error)
      }
    }

    return { ok: true, executionId, sessionId }
  }

  /**
   * Settle one execution: collect worktree facts first (fail-soft — git
   * problems never block settlement), then commit outcome + release + the
   * protocol-auto-review move in ONE ledger mutation.
   */
  private async settleExecution(
    executionId: string,
    sessionId: string,
    isolation: WorktreeIsolation | undefined,
    pending: PendingSettlement,
  ): Promise<boolean> {
    if (!pending.evidenceReady) {
      pending.evidence = await this.collectEvidence(isolation)
      pending.evidenceReady = true
    }
    const evidence = pending.evidence
    await this.runs.get(executionId)?.stopping
    if (this.disposed) return false
    const result = await this.deps.store.mutate('execution-recorded', (ledger) => {
      if (this.disposed) return undefined
      if (pending.outcome === 'cancelled' && !this.runs.get(executionId)?.stopped) return undefined
      for (const t of ledger.tasks) {
        const execution = t.executions.find(e => e.id === executionId)
        if (execution !== undefined && execution.outcome === 'running') {
          const now = pending.endedAt
          execution.outcome = pending.outcome
          execution.endedAt = now
          this.applyFacts(execution, evidence)
          // A settled scheduled run leaves a one-shot (定时一次) spent: its
          // runAt was consumed at queue time and the cron path below hands
          // the schedule to a successor — a one-shot has neither. Normalize
          // the mode so the card stays a plain claim task (runnable and
          // editable) instead of a scheduled ghost with no trigger (#95).
          // A re-arm mid-run keeps its fields even if its new trigger time
          // passes before this run settles; the scheduler still owns it.
          if (isSpentOneShot(t.execution)) {
            t.execution.mode = 'claim'
            delete t.execution.runAt
            t.execution.nextRunAt = undefined
          }
          if (pending.outcome !== 'succeeded') {
            if (pending.outcome === 'failed') execution.error = (pending.error ?? 'execution failed').slice(0, 500)
            if (t.status === 'in_progress' && (pending.outcome === 'cancelled' || t.claimedBy === sessionId)) {
              t.status = 'todo'
              t.updatedAt = now
              delete t.claimedBy
              delete t.claimedAt
              if (pending.outcome === 'failed') {
                const error = (pending.error ?? 'execution failed').slice(0, 300)
                t.comments.push({
                  id: newCommentId(),
                  body: normalizeBody(`[系统] 执行失败：${error}；任务已退回待办。`),
                  systemKey: 'sys.execFailed', systemParams: { error },
                  threadId: sessionId, version: 1, createdAt: now,
                })
              }
            }
            return [t]
          }
          if (t.status === 'in_progress' && t.claimedBy === sessionId) {
            delete t.claimedBy
            delete t.claimedAt
          }
          const periodicCompletion = execution.trigger === 'scheduled' && t.execution.cron !== undefined
            ? t.execution.periodicCompletion ?? 'spawn'
            : undefined
          // These policies are host-owned: an agent may follow the ordinary
          // hand-off protocol and already have moved the card to in_review,
          // but that must never suppress the selected periodic continuation.
          if (periodicCompletion === 'rearm') {
            t.status = 'todo'
            t.updatedAt = now
            t.updatedBy = { kind: 'system' }
            t.comments.push({
              id: newCommentId(),
              body: normalizeBody('[系统] 定期任务本轮执行完成，已按设置自动回到待办，等待下一次触发。'),
              systemKey: 'sys.periodicRearmed',
              threadId: sessionId,
              version: 1,
              createdAt: now,
            })
            return [t]
          }
          if (periodicCompletion === 'spawn') {
            const match = parseCron(t.execution.cron!)
            const next = match === null ? undefined : nextCronTime(match, now) ?? undefined
            t.status = 'in_review'
            t.updatedAt = now
            t.updatedBy = { kind: 'system' }
            if (next !== undefined) {
              const successor = spawnNextCycle(t, executionId, now)
              t.execution = { mode: 'claim' }
              t.comments.push({
                id: newCommentId(),
                body: normalizeBody(`[系统] 定期任务本轮执行完毕，已按设置新建待办卡 ${successor.id} 承接下一轮，请审查本卡后验收。`),
                systemKey: 'sys.periodicHandoff',
                systemParams: { nextTaskId: successor.id },
                threadId: sessionId,
                version: 1,
                createdAt: now,
              })
              ledger.tasks.push(successor)
              return [t, successor]
            }
            t.execution = { mode: 'claim' }
            t.comments.push({
              id: newCommentId(),
              body: normalizeBody('[系统] 定期表达式已无未来触发时间，本轮结束后定时停用；如需继续请重新设置。'),
              systemKey: 'sys.cronDead',
              threadId: sessionId,
              version: 1,
              createdAt: now,
            })
            return [t]
          }
          if (t.status === 'in_progress') {
            // Host system comments carry threadId too — only a real agent
            // comment (no systemKey) proves the session handed off.
            const commented = t.comments.some(c => c.threadId === sessionId && c.systemKey === undefined && c.createdAt >= (execution.startedAt ?? 0))
            t.comments.push({
              id: newCommentId(),
              body: normalizeBody(commented
                ? '[系统] 执行会话已结束并留有评论，但未移至待验收；系统自动移入待验收。'
                : '[系统] 执行会话已结束，但未按协议交接（无评论、未移至待验收）；系统自动移入待验收，请审查后退回或验收。'),
              systemKey: commented ? 'sys.endedWithComment' : 'sys.endedNoHandoff',
              threadId: sessionId,
              version: 1,
              createdAt: now,
            })
            t.status = 'in_review'
            t.updatedAt = now
            t.updatedBy = { kind: 'system' }
            // Periodic scheduled success (定期执行): the finished card stays
            // here for acceptance while a fresh todo card minted from it
            // carries the cron onward. The cron is consumed either way so
            // the in_review card can never refire.
            if (execution.trigger === 'scheduled' && t.execution.cron !== undefined) {
              const match = parseCron(t.execution.cron)
              const next = match === null ? undefined : nextCronTime(match, now) ?? undefined
              if (next !== undefined) {
                const successor = spawnNextCycle(t, executionId, now)
                t.execution = { mode: 'claim' }
                t.comments.push({
                  id: newCommentId(),
                  body: normalizeBody(`[系统] 定期任务本轮执行完毕，定时已由新待办卡 ${successor.id} 承接，请审查本卡后验收。`),
                  systemKey: 'sys.periodicHandoff',
                  systemParams: { nextTaskId: successor.id },
                  threadId: sessionId,
                  version: 1,
                  createdAt: now,
                })
                ledger.tasks.push(successor)
                return [t, successor]
              }
              // Dead cron (no match within the scan window): consume it with
              // a comment instead of letting the handoff die silently.
              t.execution = { mode: 'claim' }
              t.comments.push({
                id: newCommentId(),
                body: normalizeBody('[系统] 定期表达式已无未来触发时间，本轮结束后定时停用；如需继续请重新设置。'),
                systemKey: 'sys.cronDead',
                threadId: sessionId,
                version: 1,
                createdAt: now,
              })
            }
          }
          return [t]
        }
      }
      return undefined
    })
    return !result.ledger.tasks.some(task => task.executions.some(execution => execution.id === executionId && execution.outcome === 'running'))
  }

  /**
   * Pin the actual prepared branch on the task (0.10.1 single official
   * checkout; the old per-repo pinning died with the mirror). A rename keeps
   * the pinned name; preparation alone can replace it. Compare against the
   * original snapshot so concurrent edits cannot be overwritten.
   */
  private async pinBranches(task: TaskRecord, isolation: WorktreeIsolation): Promise<void> {
    if (task.branch === isolation.branch) return
    const previous = task.branch
    await this.deps.store.mutate('task-updated', (ledger) => {
      const target = ledger.tasks.find(t => t.id === task.id)
      if (target === undefined) return undefined
      if (target.branch !== previous) return undefined
      target.branch = isolation.branch
      return [target]
    })
  }

  /** Running or awaiting durable settlement; both reserve concurrency capacity. */
  inFlight(): number {
    return this.runs.size
  }

  /** Managed sessions must not also be settled by external-session sync. */
  managesSession(sessionId: string): boolean {
    return [...this.runs.values()].some(entry => entry.sessionId === sessionId)
  }

  private stopRun(entry: RunEntry): Promise<void> {
    entry.stopping ??= Promise.resolve().then(() => entry.dispose()).then(() => {
      entry.stopped = true
    }).catch(error => {
      entry.stopping = undefined
      throw error
    })
    return entry.stopping
  }

  /**
   * Cancel the running execution of a task (user action): stop the agent
   * session, mark the execution cancelled, and hand the task back to todo.
   * @param taskId - the task whose execution should be stopped.
   * @returns the immediate result.
   */
  async cancel(taskId: string): Promise<CancelRequestResult> {
    const task = this.deps.store.get(taskId)
    if (task === undefined) return { ok: false, error: `no task ${taskId}` }
    const running = [...task.executions].reverse().find(e => e.outcome === 'running')
    if (running === undefined) return { ok: false, error: 'no running execution' }

    let entry = this.runs.get(running.id)
    if (entry === undefined) {
      const sessionId = running.sessionId ?? task.claimedBy ?? ''
      const live = this.deps.liveAgent?.(sessionId)
      // External-session sync records executions without owning their agents.
      // Borrow the live registry handle to stop activity without disposing it.
      // Startup cancellation can still precede creation of any live agent.
      entry = {
        sessionId,
        taskId,
        isolation: this.isolationFromExecution(running),
        dispose: async () => {
          if (live !== undefined) { live.cancel({ kind: 'user' }); await live.whenIdle() }
        },
      }
      this.runs.set(running.id, entry)
    }
    // Register cancellation before dispose can resolve the idle watcher.
    // Repeated Stop requests share the same agent stop and in-progress write.
    // Start stopping even when a prior success write already owns the lane;
    // that writer must await this stop before retrying with cancellation.
    void this.stopRun(entry).catch(() => { /* settlement owns stop retries */ })
    const written = await this.requestSettlement(running.id, 'cancelled', undefined, true)
    const outcome = this.deps.store.get(taskId)?.executions.find(e => e.id === running.id)?.outcome
    if (written && outcome === 'cancelled') return { ok: true, executionId: running.id }
    return { ok: false, error: written ? 'execution already settled' : 'cancellation could not be persisted; execution remains tracked for retry' }
  }

  /**
   * Reconcile running records after load. A real process restart leaves no
   * live agent, but a plugin hot reload does; retain and adopt those runs
   * instead of recording a false "interrupted by host restart" failure.
   */
  async reconcile(): Promise<void> {
    if (this.disposed) return
    await this.deps.store.load()
    // A clean startup needs no write lane or cross-process lock at all.
    if (!this.deps.store.snapshot().tasks.some(task => task.executions.some(execution => execution.outcome === 'running'))) return
    const adopted = new Map<string, { sessionId: string; agent: LiveAgentFace; isolation: WorktreeIsolation | undefined }>()
    for (const task of this.deps.store.snapshot().tasks) {
      for (const execution of task.executions) {
        if (execution.outcome !== 'running' || execution.sessionId === undefined) continue
        const agent = this.deps.liveAgent?.(execution.sessionId)
        if (agent !== undefined) adopted.set(execution.id, {
          sessionId: execution.sessionId,
          agent,
          isolation: this.isolationFromExecution(execution),
        })
      }
    }
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      if (this.disposed) return undefined
      const now = this.deps.now()
      const touched: TaskRecord[] = []
      for (const task of ledger.tasks) {
        let dirty = false
        for (const execution of task.executions) {
          if (execution.outcome === 'running' && !adopted.has(execution.id)) {
            execution.outcome = 'failed'
            execution.error = 'interrupted by host restart'
            execution.endedAt = now
            dirty = true
          }
        }
        if (!dirty) continue
        if (task.status === 'in_progress') {
          task.status = 'todo'
          task.updatedAt = now
          delete task.claimedBy
          delete task.claimedAt
        }
        touched.push(task)
      }
      return touched.length > 0 ? touched : undefined
    })
    for (const [executionId, entry] of adopted) {
      // A concurrent old-generation settlement may already have finished it;
      // the idempotent settlement mutation below then becomes a no-op.
      const stillRunning = this.deps.store.snapshot().tasks.some(task =>
        task.executions.some(execution => execution.id === executionId && execution.outcome === 'running'))
      if (!stillRunning) continue
      this.adoptLiveRun(executionId, entry.sessionId, entry.agent, entry.isolation)
    }
  }

  /**
   * Deliver a task's pending user comments to its conversation (issue #51
   * Plan A explicit delivery). The route validates the card and writes the
   * composer comment; this picks the channel:
   * - live: the previous run is STILL settling (agent self-moved the card to
   *   in_review before going idle) and this host tracks its watcher → append
   *   each comment as a user message, no new execution;
   * - run: otherwise a comment-triggered run that continues the card's
   *   conversation (taskSessionId candidate, compatibility-checked) or
   *   degrades to a fresh one — comments appended verbatim by run().
   * Agent comments and host system messages are never delivered; already-
  * delivered ones never repeat.
   */
  async deliverComments(taskId: string): Promise<DeliverCommentsResult> {
    const task = this.deps.store.get(taskId)
    if (task === undefined || task.trashedAt !== undefined) return { ok: false, error: `no task ${taskId}` }
    if (task.status !== 'in_review') return { ok: false, error: `comment wake requires in_review (current ${task.status})` }
    const pending = task.comments
      .filter(c => c.systemKey === undefined && c.threadId === undefined && c.deliveredAt === undefined
        && ![...this.runs.values()].some(entry => entry.commentDelivery?.taskId === taskId && entry.commentDelivery.commentIds.includes(c.id)))
      .sort((a, b) => a.createdAt - b.createdAt)
    if (pending.length === 0) return { ok: false, error: '没有待投递的留言' }
    const running = task.executions.find(e => e.outcome === 'running')
    if (running !== undefined) {
      const liveSessionId = running.sessionId
      const tracked = liveSessionId !== undefined
        && [...this.runs.values()].some(entry => entry.sessionId === liveSessionId)
      const live = tracked && liveSessionId !== undefined ? this.deps.liveAgent?.(liveSessionId) : undefined
      if (liveSessionId === undefined || live === undefined) {
        // A running record this host does not track (restart leftover) gets
        // the manual-run treatment: refuse with a clear message instead of
        // firing messages into an orphaned conversation.
        return { ok: false, error: '执行会话状态不明（宿主可能重启过），请先停止执行再投递留言' }
      }
      // Same ONE-message rule as the run channel (user decision 2026-10-23):
      // the pending backlog joins into a single user message bubble.
      live.followup({
        id: this.deps.mintMessageId?.() ?? MessageId(`msg-taskboard-${crypto.randomUUID()}`),
        role: 'user' as const,
        content: [{ type: 'text' as const, text: mergeCommentBodies(pending.map(c => c.body)) }],
        source: { kind: 'user' as const },
      })
      await this.markCommentsDelivered(taskId, pending.map(c => c.id), running.id, liveSessionId, false)
      return { ok: true, delivered: 'live', count: pending.length, executionId: running.id, sessionId: liveSessionId }
    }
    const result = await this.run(taskId, 'comment', { comments: pending.map(c => ({ id: c.id, body: c.body })) })
    if (!result.ok) return { ok: false, error: result.error }
    return { ok: true, delivered: 'run', count: pending.length, executionId: result.executionId, sessionId: result.sessionId }
  }

  /** Serialize immediate delivery writes with settlement retries. */
  private flushCommentDelivery(executionId: string, entry: RunEntry): Promise<void> {
    if (entry.deliveryWriting !== undefined) return entry.deliveryWriting
    const delivery = entry.commentDelivery
    if (delivery === undefined) return Promise.resolve()
    entry.deliveryWriting = this.markCommentsDelivered(delivery.taskId, delivery.commentIds, executionId, entry.sessionId, delivery.announce)
      .then(() => { entry.commentDelivery = undefined })
      .finally(() => { entry.deliveryWriting = undefined })
    return entry.deliveryWriting
  }

  /**
   * Mark comments delivered (idempotent per comment) and — for the run
   * channel — leave the wake trace as a system comment, in ONE mutation.
   * A failed run never marks: pending comments stay pending for a retry.
   */
  private async markCommentsDelivered(taskId: string, commentIds: string[], executionId: string, sessionId: string, announce: boolean): Promise<void> {
    await this.deps.store.mutate('comment-added', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target === undefined) return undefined
      const now = this.deps.now()
      let touched = false
      for (const c of target.comments) {
        if (commentIds.includes(c.id) && c.deliveredAt === undefined) {
          c.deliveredAt = now
          c.deliveredExecutionId = executionId
          touched = true
        }
      }
      if (!touched) return undefined
      if (announce) {
        target.comments.push({
          id: newCommentId(),
          body: normalizeBody(`[系统] 用户留言已投递，唤醒会话 ${sessionId} 处理。`),
          systemKey: 'sys.commentWoke',
          systemParams: { id: sessionId },
          threadId: sessionId,
          version: 1,
          createdAt: now,
        })
        target.updatedAt = now
      }
      return [target]
    })
  }

  /**
   * The plugin framing line (rendered as a plugin context row): task head,
   * already-claimed state, and the handoff protocol — everything the session
   * must know about the board. The task id appears exactly once (here); the
   * protocol steps below refer to it as 本任务. Isolated runs add one line
   * steering the session onto its dedicated branch (commits are the evidence
   * the user reviews at merge time); 续跑 and degraded runs each add their
   * own steering line (0.3.1).
   * @param task - the task.
   * @param isolation - the task's official worktree when this run is isolated.
   * @param degradeNote - why a worktree task degraded to the main directory.
   */
  private pluginFraming(task: TaskRecord, isolation?: WorktreeIsolation, degradeNote?: string): string {
    const periodicCompletion = task.execution.mode === 'scheduled' && task.execution.cron !== undefined
      ? task.execution.periodicCompletion ?? 'spawn'
      : undefined
    let text = `【任务看板】${task.title}（ID: ${task.id}）\n`
      + `本会话由任务看板执行服务启动，任务已置为进行中——无需认领；「已完成」仅限用户在界面操作（代码已限制，移了会被拒）。\n`
      + `完成后按序交接：\n`
      + `1. taskboard_get 读取本任务，取得最新 version\n`
      + `2. taskboard_execution_report 提交结构化执行报告（做了什么/改了哪些文件/如何验证/剩余风险；提交与评论不冲突，都会展示给验收人）\n`
      + `3. taskboard_comment_add 留评论：做了什么改动 / 如何验证 / 剩余风险\n`
      + `${periodicCompletion === 'rearm'
        ? '4. 本任务设为“完成后移回待办”：完成报告和评论后无需改变状态，宿主会在会话结束时自动回到待办。\n'
        : periodicCompletion === 'spawn'
          ? '4. 本任务设为“完成后新建待办”：完成报告和评论后无需改变状态，宿主会保留本卡待验收并新建下一轮待办卡。\n'
          : '4. taskboard_move 将本任务移至待验收 in_review（带 ifVersion）\n'}`
      + `若无法完成：留评论说明原因，将任务移回待办 todo。`
    text += this.checklistFraming(task)
    text += this.isolationFraming(isolation, degradeNote)
    return text
  }

  /**
   * The comment-wake framing line (issue #51 Plan A): the review-loop variant
   * of {@link pluginFraming} — same handoff protocol, shared DoD and isolation
   * sections — but the opening tells the agent the conversation was woken by
   * user comments, which arrive verbatim as the following user messages.
   */
  private commentFraming(task: TaskRecord, isolation?: WorktreeIsolation, degradeNote?: string): string {
    let text = `【任务看板】${task.title}（ID: ${task.id}）\n`
      + `本会话由任务看板的「用户留言」触发：用户在本卡待验收时留言，留言已合并为下方的一条用户消息（多条之间以分隔线隔开、保持原文）——请逐条处理，不要遗漏。\n`
      + `处理完成后仍按序交接：\n`
      + `1. taskboard_get 读取本任务，取得最新 version\n`
      + `2. taskboard_execution_report 提交结构化执行报告（做了什么/改了哪些文件/如何验证/剩余风险）\n`
      + `3. taskboard_comment_add 留评论说明本轮留言的处理结果\n`
      + `4. taskboard_move 将本任务移至待验收 in_review（带 ifVersion）\n`
      + `若某条留言无法处理：留评论说明原因，任务保持待验收，交回用户决定。`
    text += this.checklistFraming(task)
    text += this.isolationFraming(isolation, degradeNote)
    return text
  }

  /** The shared DoD section of a framing line (extracted for the comment wake variant, issue #51). */
  private checklistFraming(task: TaskRecord): string {
    if (task.checklist === undefined || task.checklist.length === 0) return ''
    const items = task.checklist
      .map((item, index) => `${item.checked ? '☑' : '☐'} ${index + 1}. ${item.text}${item.note !== undefined ? `（证据: ${item.note}）` : ''}`)
      .join('\n')
    const done = task.checklist.filter(i => i.checked).length
    // 会话任务清单 ↔ 卡片验收清单的同步纪律（看板增强系列 3/6；口径与看板模式
    // 系列的清单纪律一致）：todo_write 管会话清单，taskboard_checklist 管卡片
    // 清单；计划模式是官方明文例外——规划期禁用 todo_write。
    const sync = taskModeOf(task) === 'plan'
      ? `\n会话任务清单（计划模式例外）：官方计划模式文案禁止规划期使用 todo_write；规划阶段仍以 exit_plan_mode 提交计划，不要用 todo_write 代替。本次不注入会话任务清单——直接按上方清单用 taskboard_checklist（附证据 note）推进与回写。`
      : `\n会话任务清单：宿主已在首个执行步骤把上方清单注入为官方任务清单（todo 投影）——请用 todo_write 维护它：开工把当前项标 in_progress（非并行配置同时至多一项），完成即标 completed。执行阶段任何操作前先更新官方任务清单：更新任务清单 → 执行动作 → 回写卡片清单。todo_write 管会话任务清单（本会话的工作分解），taskboard_checklist 管卡片验收清单（看板卡的 DoD 条目）。会话清单把对应 DoD 条目标成 completed 时宿主会自动回写卡片清单；但你勾选卡片清单仍必须用 taskboard_checklist 并附证据 note。`
    return `\n本任务有验收清单（DoD，${done}/${task.checklist.length} 已完成）——按清单干活：\n${items}\n完成一项就用 taskboard_checklist（action=check，附 note 证据）勾选；未完成项会在验收时高亮，全部完成再移待验收。需要补充验收项也可用 action=add 追加。${sync}`
  }

  /**
   * The shared isolation/degrade section of a framing line (issue #51
   * extraction). 0.10.1: a single official checkout — the official service
   * already switched the session's working directory onto it, so the note
   * states that fact and the commit discipline instead of path juggling.
   */
  private isolationFraming(isolation: WorktreeIsolation | undefined, degradeNote?: string): string {
    if (isolation !== undefined) {
      if (isolation.reused === true) {
        return `\n本任务启用了 Git Worktree 隔离，且本次为续跑：任务工作目录是独立分支 ${isolation.branch} 的 worktree——\n${isolation.path}\n上一次执行的改动与提交都保留在原处——请先查看已有改动（git status / git log）再继续，避免重复劳动，并把新完成的工作提交到该分支。`
      }
      return `\n本任务启用了 Git Worktree 隔离：任务工作目录是独立分支 ${isolation.branch} 的全新 worktree——\n${isolation.path}\n（全新检出，不含 node_modules/构建产物，构建或测试前可能需要先安装依赖）。\n⚠ 边界纪律：你的会话工作目录已由宿主切到该 worktree，本任务的全部改动必须只发生在其中——不要改动主工作区的任何其它文件；把完成的工作提交（git commit）到该分支，验收将基于该分支的提交记录合并。`
    }
    if (degradeNote !== undefined) {
      return `\n⚠ 本次执行未能建立隔离，正在主项目目录中工作（原因：${degradeNote}）。该目录可能有他人未提交的改动：动手前先 git status 检查现状，改动尽量集中，结束时在评论中说明动了哪些文件；避免把未经验证的改动直接提交到主分支。`
    }
    return ''
  }

  /**
   * The card body as a normal user bubble: the effective prompt (title+
   * description, with the explicit prompt appended when set) with template
   * variables resolved from
   * the task's own history at submit time (valuable for recurring patrols):
   * `{{lastExecution}}` → the previous execution's trigger/outcome/error;
   * `{{lastComments}}` → the last three comments (who + body).
   */
  private userBody(task: TaskRecord): string {
    const lastExec = [...task.executions].reverse().find(e => e.outcome !== 'running')
    const lastExecText = lastExec === undefined
      ? '（无）'
      : `${lastExec.trigger} · ${lastExec.outcome}${lastExec.error !== undefined ? ` · ${lastExec.error.slice(0, 200)}` : ''} · ${lastExec.startedAt !== undefined ? new Date(lastExec.startedAt).toISOString() : '?'}`
    const lastCommentsText = task.comments.slice(-3)
      .map(c => `[${c.threadId !== undefined ? 'agent' : 'user'}] ${c.body}`)
      .join('\n') || '（无）'
    return effectivePrompt(task)
      .replace(/\{\{lastExecution\}\}/g, lastExecText)
      .replace(/\{\{lastComments\}\}/g, lastCommentsText)
  }

  /** Move a task back out of in_progress (and release its hold) after a failed start. */
  private async revertProgress(taskId: string): Promise<void> {
    await this.deps.store.mutate('execution-recorded', (ledger) => {
      const target = ledger.tasks.find(t => t.id === taskId)
      if (target !== undefined && target.status === 'in_progress') {
        target.status = 'todo'
        target.updatedAt = this.deps.now()
        delete target.claimedBy
        delete target.claimedAt
        return [target]
      }
      return undefined
    })
  }
}
