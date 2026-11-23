/**
 * Host isolation layer (0.3.0 – 0.9.x: self-built worktrees & multi-repo
 * mirrors; 0.10.1: the OFFICIAL worktree service only).
 *
 * 0.10.1 本地改造（「不实现自己的一套 worktree 能力」）：自建的
 * prepareWorktree / worktree add / 分支重置 / 多仓镜像 / 检出删除全部移除，
 * 隔离改由官方 @deepseek-ai/dsh-experimental-worktree 的 `ctx.worktrees`
 * 服务承担（软依赖——运行时软读取，不声明 inject 硬依赖）。官方为
 * **单仓库单 worktree** 服务，多仓库镜像模式随之停用。
 *
 * 与旧自建路径的行为差异（都是官方语义决定的，见
 * docs/official-worktree-spike.md）：
 * - 官方 create 会把执行会话的**有效工作目录**切到检出（session header.cwd
 *   不变 → attachSession 校验 / 侧栏分组 / 文件沙箱边界不受影响，实测坐实），
 *   因此隔离准备必须发生在执行 agent 创建**之后**；
 * - 官方不覆盖既有分支/路径：分支已存在时 create 失败 → 降级。为避免「重跑
 *   同一任务必然降级」，上一次隔离的检出仍存活（HEAD 可读）时自动**续用**
 *   该检出（分支与改动原样保留，证据基线取检出当前 HEAD）——旧的「每次全新
 *   重置」语义不再存在；
 * - 检出删除不复存在：回收归官方（执行会话归档时回收干净且无引用的检出，
 *   分支保留）；被保留（retained）的检出由用户手动 `git worktree remove`。
 *
 * 服务缺席或建立失败时返回降级 note（任务按 isolation:none 照常执行），
 * 绝不报错阻塞任务。
 *
 * @module dsh-taskboard/host/isolation
 */
import {
  OFFICIAL_SERVICE_UNAVAILABLE_NOTE,
  classifyOfficialFailure,
  officialDegradeNote,
  readWorkingDirectory,
  readWorktreeService,
  type OfficialWorktreeService,
  type WorkingDirectoryService,
} from '../local/official-worktree.ts'
import type { GitFace } from './git.ts'

/** One prepared isolation, shaped by the official service's CreatedWorktree. */
export interface WorktreeIsolation {
  /** 检出绝对路径（官方池目录下的分支路径，分支含 '/' 时嵌套）。 */
  path: string
  /** 任务分支名（官方 request.name）。 */
  branch: string
  /** 证据基线：全新执行 = request.from 解析出的提交；续用 = 检出当前 HEAD。 */
  baseCommit: string
  /** True when a previous live checkout was kept as-is (续跑/续用). */
  reused?: boolean
}

/** Result of one isolation attempt: either a prepared isolation or a degrade note. */
export interface IsolationOutcome {
  isolation?: WorktreeIsolation
  /** 降级说明（任务按 isolation:none 继续执行时给用户/agent 的原因）。 */
  note?: string
}

/** External dependencies of one isolation attempt (all optional / soft). */
export interface IsolationDeps {
  /** 只读 git 面：续用时读检出 HEAD 作为 liveness 探测与证据基线。 */
  git?: Pick<GitFace, 'headOf'>
  /** 已软读取的官方服务实例（缺省时从 `scope` 再软读取）。 */
  worktrees?: OfficialWorktreeService
  /** 宿主 workingDirectory 服务：续用时把有效 cwd 指回既有检出。 */
  workingDirectory?: WorkingDirectoryService
  /** 软读取 scope（任意 cordis 上下文；`deps.worktrees` 缺省时用）。 */
  scope?: unknown
}

/** One isolation request. */
export interface IsolationRequest {
  /** 宿主真实 agent 对象（官方 create 需要 agent.session / agent.ctx）。 */
  agent: object
  /** 任务分支名（官方 request.name；沿用看板命名 `task/<标题>+<任务ID>`）。 */
  branch: string
  /** 基准提交（官方 request.from；缺省官方默认 'HEAD'）。 */
  from?: string
  /** 上一次隔离执行的检出（官方路径 + 分支），存在时才可能续用。 */
  previous?: { path: string; branch: string }
  /** 续跑（评论触发/手动续跑）：即使服务可用也绝不新建检出，只续用。 */
  reuse?: boolean
}

/**
 * 通过官方 `ctx.worktrees` 服务建立任务隔离。
 *
 * 流程：服务软读取 → 上一次检出仍存活则续用（workingDirectory.set 指回）→
 * 否则官方 `create({name: branch, from})`（官方会接管该 agent 的有效 cwd）。
 * 任何失败都解析为降级 note，绝不抛出。
 */
export async function prepareOfficialIsolation(deps: IsolationDeps, request: IsolationRequest): Promise<IsolationOutcome> {
  const service = deps.worktrees ?? readWorktreeService(deps.scope)
  if (service === undefined) {
    return { note: OFFICIAL_SERVICE_UNAVAILABLE_NOTE }
  }
  // 续用：上一次隔离的检出还活着（分支一致且 HEAD 可读）→ 不新建（官方不
  // 覆盖既有分支，新建也只会失败），把有效 cwd 指回原处，改动与提交保留。
  const previousAlive = request.previous !== undefined && request.previous.branch === request.branch
    ? await aliveHead(deps.git, request.previous.path)
    : undefined
  if (previousAlive !== undefined && request.previous !== undefined) {
    const workingDirectory = deps.workingDirectory ?? readWorkingDirectory(deps.scope)
    if (workingDirectory !== undefined) {
      try {
        await workingDirectory.set(request.agent, request.previous.path)
        return {
          isolation: {
            path: request.previous.path,
            branch: request.previous.branch,
            baseCommit: previousAlive,
            reused: true,
          },
        }
      } catch {
        // 指回失败（目录被删/服务异常）→ 落到全新 create，官方会如实报错。
      }
    } else {
      // 没有 workingDirectory 服务就无法接管 cwd——官方语义下继续在主目录
      // 执行会让隔离失效，宁可不隔离也不假装隔离。
      return {
        note: `检测到既有任务检出 ${request.previous.path}，但宿主 workingDirectory 服务不可用，无法续用该检出；已在原目录执行`,
      }
    }
  }
  const from = request.from
  try {
    const created = await service.create(request.agent, {
      name: request.branch,
      ...(from !== undefined ? { from } : {}),
    })
    return {
      isolation: {
        path: created.path,
        branch: created.branch,
        baseCommit: created.baseCommit,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { note: officialDegradeNote(classifyOfficialFailure(error), message.slice(0, 200)) }
  }
}

/** 检出还活着吗：HEAD 可读即活（缺 git 面或读不到 → undefined）。 */
async function aliveHead(git: Pick<GitFace, 'headOf'> | undefined, path: string): Promise<string | undefined> {
  if (git === undefined) return undefined
  try {
    return await git.headOf(path)
  } catch {
    return undefined
  }
}

/**
 * Map a (workspace, repo-rel-path) pair onto that repo's main checkout root —
 * the git-level helper behind per-repo merge / branch cleanup for legacy
 * `task.branches` records. Pure path math; NOT a mirror capability (the
 * 0.10.1 isolation itself is single-repo, official-service driven).
 */
export function repoMainPath(workspacePath: string, repo: string): string {
  return repo === '' ? workspacePath : workspacePath + '/' + repo
}
