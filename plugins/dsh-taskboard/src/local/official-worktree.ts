/**
 * 官方 worktree 服务的软依赖适配层（0.10.1 本地改造）。
 *
 * dsh-taskboard 不再自建 worktree 能力：任务隔离改用官方
 * @deepseek-ai/dsh-experimental-worktree 提供的 `ctx.worktrees` 服务
 * （随 @deepseek-ai/dsh-experimental-forge-bundle 分发，插件页「变更请求与
 * 工作树」启用）。本模块只声明官方服务的**结构类型**并做软读取——不 import
 * 官方包（宿主半区禁止运行时 @deepseek-ai 引用，见 package-contract.test.ts）；
 * 服务缺失时调用方降级为 isolation:none 并提示启用官方 bundle，绝不阻塞任务。
 *
 * 官方语义要点（0.2.2-rc.5，实测见 docs/official-worktree-spike.md）：
 * - `create(agent, {name, from})` 在源仓库池目录 `.agents/worktrees/` 下建立
 *   `git worktree`（路径 = 池/分支名，分支含 '/' 时逐级嵌套），并把该 agent
 *   的**有效工作目录**切到检出（session header.cwd 不变 → attachSession /
 *   侧栏分组 / 沙箱边界均不受影响）；
 * - `name` 需通过 git check-ref-format 且不含 '\\' ':'，允许 `task/x+y` 形态；
 * - 分支已存在 / 路径已存在时 create 直接失败（不覆盖、不自动清理）；
 * - 检出回收挂在**执行会话归档**（WorkspaceReclamation）：干净且无引用的检出
 *   被移除，分支保留；沙箱 read-only 或仍被引用时 status='retained'。
 */

/** 官方 worktree 池目录（官方 Config.directory 的出厂默认，相对源仓库根）。 */
export const OFFICIAL_POOL_DIR = '.agents/worktrees';

/**
 * 官方池的父目录（`.agents`）——主工作区的 `git status` 只看到这一个未跟踪
 * 目录条目（`?? .agents/`），所以「主工作区是否干净」的豁免必须按它判断。
 */
export const OFFICIAL_POOL_ROOT_DIR = '.agents';

/** 提示用户启用官方 bundle 的固定文案（降级提示里引用）。 */
export const OFFICIAL_BUNDLE_HINT =
  '请启用官方 @deepseek-ai/dsh-experimental-forge-bundle（插件页「变更请求与工作树」，其中 worktree 插件行提供 ctx.worktrees 服务）';

/** 服务缺席时的标准降级提示（isolationNote）。 */
export const OFFICIAL_SERVICE_UNAVAILABLE_NOTE = `官方 worktree 服务不可用（${OFFICIAL_BUNDLE_HINT}），已在原目录执行`;

/** 官方 `WorktreeService.create` 的返回值（CreatedWorktree 的结构面）。 */
export interface OfficialCreatedWorktree {
  /** 检出绝对路径（= 池目录/分支名，分支含 '/' 时逐级嵌套）。 */
  path: string;
  /** 任务分支名。 */
  branch: string;
  /** 基准提交（request.from 解析出的 commit，缺省主仓 HEAD）。 */
  baseCommit: string;
  /** 源仓库根（池目录所在仓库的 toplevel）。 */
  repositoryRoot: string;
}

/** 官方服务的最小结构面：本插件只用到 `create`。 */
export interface OfficialWorktreeService {
  create(
    agent: object,
    request?: { name?: string; from?: string },
    signal?: unknown,
    onPhase?: unknown,
  ): Promise<OfficialCreatedWorktree>;
}

/** 宿主 workingDirectory 服务的最小结构面（续跑时把有效 cwd 指回既有检出）。 */
export interface WorkingDirectoryService {
  set(agent: object, path: string, signal?: unknown): Promise<void>;
}

/**
 * 软读取官方服务：在 cordis 作用域上 `get('worktrees')`，服务缺席、形状不
 * 匹配或读取抛错一律返回 undefined（调用方降级，绝不抛出）。
 */
export function readWorktreeService(
  scope: unknown,
): OfficialWorktreeService | undefined {
  if (scope === undefined || scope === null) return undefined;
  try {
    const service = (scope as { get?(name: string): unknown }).get?.(
      'worktrees',
    );
    if (
      service !== undefined &&
      service !== null &&
      typeof (service as { create?: unknown }).create === 'function'
    ) {
      return service as OfficialWorktreeService;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 软读取宿主 workingDirectory 服务（同上，fail-soft）。 */
export function readWorkingDirectory(
  scope: unknown,
): WorkingDirectoryService | undefined {
  if (scope === undefined || scope === null) return undefined;
  try {
    const service = (scope as { get?(name: string): unknown }).get?.(
      'workingDirectory',
    );
    if (
      service !== undefined &&
      service !== null &&
      typeof (service as { set?: unknown }).set === 'function'
    ) {
      return service as WorkingDirectoryService;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 官方 create 失败的可读分类（官方只抛带原因文本的错误，无结构化错误码）。 */
export type OfficialFailureKind =
  'branch-exists' | 'path-exists' | 'sandbox-denied' | 'not-a-repo' | 'unknown';

/** 按官方服务的错误消息分类失败原因。 */
export function classifyOfficialFailure(error: unknown): OfficialFailureKind {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('worktree branch already exists'))
    return 'branch-exists';
  if (message.includes('worktree path already exists')) return 'path-exists';
  if (message.includes('not a git repository')) return 'not-a-repo';
  if (
    /(sandbox|EPERM|EACCES|permission denied|operation not permitted|read-only)/i.test(
      message,
    )
  )
    return 'sandbox-denied';
  return 'unknown';
}

/** 各失败类别对应的降级提示（都以「已在原目录执行」收尾，任务照常执行）。 */
const DEGRADE_NOTES: Record<OfficialFailureKind, (detail: string) => string> = {
  'branch-exists': (detail) =>
    `任务分支已被占用且官方 worktree 服务不覆盖既有分支（${detail}）；可先在任务详情清理分支或合并后重试，本次已在原目录执行`,
  'path-exists': (detail) =>
    `worktree 检出路径已存在且官方服务拒绝覆盖（${detail}）；本次已在原目录执行`,
  'not-a-repo': () =>
    '当前项目不是 git 仓库，官方 worktree 服务无法建立隔离，本次已在原目录执行',
  'sandbox-denied': (detail) =>
    `官方 worktree 服务建立检出被沙箱拒绝（${detail}）；请确认执行会话权限为 workspace-write，本次已在原目录执行`,
  unknown: (detail) =>
    `官方 worktree 服务建立检出失败（${detail}），本次已在原目录执行`,
};

/** 生成一次官方 create 失败的降级提示（isolationNote）。 */
export function officialDegradeNote(
  kind: OfficialFailureKind,
  detail: string,
): string {
  return DEGRADE_NOTES[kind](detail);
}
