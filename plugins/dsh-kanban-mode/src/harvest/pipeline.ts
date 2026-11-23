/**
 * 收割管线:plan(只读规划)/ apply(执行)/ 冲突续跑状态机 / discard(丢弃模式)。
 *
 * 设计依据 docs/harvest-design.md §5(输出契约)/§6(收割十步)/§7(冲突问询
 * 分叉)/§12(变基优先、已推送则降级合并)/§13.2(discard 模式);discard 四步
 * 以看板卡 2026-11-23 口径为准(先留痕 → 删检出 → 删分支 → 结构化结果)。
 *
 * 十步管线(apply 路径,括号内为设计文档步骤号):
 *   0 前置校验(仓库/任务分支/目标分支/任务状态)→ rejected
 *   1 主区清洁检查(脏 → rejected + 脏文件清单)
 *   2 分支推送检查(有 upstream 且与本地不等 → 拒绝变基,降级 --no-ff 合并)
 *   3 检出定位(官方池 .agents/worktrees/<branch>,缺席则临时检出,收割后删除)
 *   4 差异审查(log / diff --stat / changedFiles)
 *   5 base 前进检测(baseAdvanced=false → 需变基)
 *   6 变基(检出内 rebase;冲突 → 保留现场返回 conflict;非冲突错误 → abort + failed)
 *   7 合并预检(merge-tree 只读,仅作提示)
 *   8 合并(主区 merge --no-ff;冲突 → 保留现场返回 conflict;其他错误 → abort + failed)
 *   9 清理(worktree remove 非 force / branch -d 安全删除,失败只进 notes)
 *  10 留痕(结构化结果)
 *
 * 冲突续跑状态机:apply 再次调用时,先探测「进行中的 rebase / merge」
 * (resolve.ts 的存在性探测):
 *   - 检出内 rebase 进行中 → `rebase --continue`(变基未解决则再次 conflict,
 *     现场保留,重复调用幂等);
 *   - 主区 merge 进行中 → `commit --no-edit` 收尾(等价 merge --continue 但
 *     不开编辑器;未解决则再次 conflict,现场保留,重复调用幂等);
 *   - 两条路径都不可用 → 走正常十步管线。
 *
 * 仓库级串行互斥:同一仓库的 apply/discard 以仓库根为键串行(进程内
 * promise 链),并发调用时第二次必须等第一次完成(避免两个收割互相踩
 * 主区/检出)。
 *
 * @module dsh-kanban-mode/harvest/pipeline
 */
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { createGitRunner, toPosixPath } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';
import {
  createGitInspector,
  HEAVY_TIMEOUT_MS,
  probeConflictsByMergeTree,
} from './inspect.ts';
import type { CommitEntry, GitInspector, GitLogReview } from './inspect.ts';
import {
  buildConflictPlan,
  formatConflictSuggestion,
} from './conflict-plan.ts';
import type { ConflictPlan } from './conflict-plan.ts';
import { detectInProgressState } from './resolve.ts';
import type { InProgressKind } from './resolve.ts';

/** 管线模式:plan=只读规划,apply=执行。 */
export type HarvestMode = 'plan' | 'apply';

/**
 * 收割结果分支。
 * - `merged`:收尾完成(合并提交已生成);
 * - `conflict`:冲突且**保留现场**(变基/合并进行中,等待人工解决后再次 apply);
 * - `rejected`:前置校验拒绝(脏主区/分支缺失/目标分支非法等);
 * - `noop`:无可收割内容(任务分支没有领先目标分支的提交);
 * - `failed`:不可恢复失败(已 abort 干净回滚);
 * - `planned`:**仅 plan 模式**产出——只读规划结论,不等于实际合并。
 */
export type HarvestResultKind =
  'merged' | 'conflict' | 'rejected' | 'noop' | 'failed' | 'planned';

/** discard 模式结果分支。 */
export type DiscardResultKind = 'deleted' | 'partial' | 'rejected' | 'noop';

/** 实际采用的收割策略。 */
export type HarvestStrategy = 'rebase' | 'merge';

/** 冲突现场描述。 */
export interface HarvestConflict {
  /** 冲突发生在变基还是合并。 */
  readonly kind: InProgressKind;
  /** 现场位置:检出内(worktree)还是主区(main)。 */
  readonly side: 'worktree' | 'main';
  /** 冲突文件清单(POSIX 归一,仓库相对)。 */
  readonly files: readonly string[];
  /** 结构化建议(每行一条,可直接展示给用户/agent)。 */
  readonly suggestions: readonly string[];
  /** 现场所在检出路径(主区冲突时为仓库根)。 */
  readonly worktreePath: string;
  /** 解决冲突后再次调用 apply 会执行的续跑命令。 */
  readonly resumeCommand: readonly string[];
}

/** 收割请求(plan/apply 共用)。 */
export interface HarvestRequest {
  /** 任务 id(写入结果,便于调用方回链看板卡)。 */
  readonly taskId: string;
  /** 仓库根目录(主区检出所在目录)。 */
  readonly repo: string;
  /** 任务分支名。 */
  readonly branch: string;
  /** 目标分支(缺省=收割时主区当前分支)。 */
  readonly targetBranch?: string;
  /** 模式:缺省 plan。 */
  readonly mode?: HarvestMode;
  /** 是否删除任务分支(缺省 true → `git branch -d` 安全删除)。 */
  readonly deleteBranch?: boolean;
  /** 是否保留检出(缺省 false → 收割后删除检出)。 */
  readonly keepWorktree?: boolean;
  /** 任务创建时的基线提交(用于 base 前进检测;缺省=不检查,不触发变基)。 */
  readonly baseCommit?: string;
  /** 任务状态(缺省视为 done;非 done 直接 rejected)。 */
  readonly status?: string;
}

/** 收割结构化结果(设计文档 §5 输出契约)。 */
export interface HarvestResult {
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly targetBranch: string;
  readonly mode: HarvestMode;
  readonly result: HarvestResultKind;
  /** base 前进检测结论(null=未检查)。 */
  readonly baseAdvanced: boolean | null;
  /** 任务分支领先目标分支的提交。 */
  readonly commits: readonly CommitEntry[];
  /** 差异摘要。 */
  readonly diffStat?: string;
  /** 改动文件清单。 */
  readonly changedFiles: readonly string[];
  /** 冲突现场(仅 conflict)。 */
  readonly conflict?: HarvestConflict;
  /** 实际执行的动作清单(审计用)。 */
  readonly actions: readonly string[];
  /** 结果说明/过程备注。 */
  readonly notes: readonly string[];
  /** 拒绝或失败原因。 */
  readonly reason?: string;
  /** 合并提交(仅 merged 且生成了合并提交时)。 */
  readonly mergeCommit?: string;
  /** 主区脏文件清单(仅 rejected 的脏主区场景)。 */
  readonly dirtyFiles?: readonly string[];
  /** 实际采用的策略。 */
  readonly strategy?: HarvestStrategy;
  /** 是否发生降级(如已推送分支拒绝变基 → 降级合并)。 */
  readonly degraded?: boolean;
  /** 任务基线提交(透传)。 */
  readonly baseCommit?: string;
}

/** discard 请求。 */
export interface DiscardRequest {
  readonly taskId: string;
  /** 仓库根目录。 */
  readonly repo: string;
  /** 任务分支(缺省=只清检出,如实标注分支未处理)。 */
  readonly branch?: string;
  /** 检出路径(缺省=不处理检出)。 */
  readonly worktreePath?: string;
}

/** discard 留痕素材(只返回给调用方,不落盘)。 */
export interface DiscardTrace {
  /** 分支名。 */
  readonly branch?: string;
  /** 分支 tip 提交哈希(分支不存在时缺省)。 */
  readonly branchTip?: string;
  /** 检出内脏文件清单(删除前的现场)。 */
  readonly dirtyFiles: readonly string[];
  /** 检出路径。 */
  readonly worktreePath?: string;
}

/** discard 结构化结果。 */
export interface DiscardResult {
  readonly taskId: string;
  readonly repo: string;
  readonly result: DiscardResultKind;
  /** 分支是否已删除(-D 强删)。 */
  readonly branchDeleted: boolean;
  /** 检出是否已删除(脏检出也删)。 */
  readonly worktreeRemoved: boolean;
  /** 留痕素材(先于删除动作产出)。 */
  readonly trace: DiscardTrace;
  readonly actions: readonly string[];
  readonly notes: readonly string[];
  readonly reason?: string;
}

/** 管线工厂的可选项。 */
export interface HarvestPipelineOptions {
  /** git 执行器(缺省新建真实 git 封装;测试可注入 mock)。 */
  readonly runner?: GitRunner;
  /** 只读审查器(缺省基于 runner 新建)。 */
  readonly inspector?: GitInspector;
}

/** 收割管线对外接口。 */
export interface HarvestPipeline {
  /** 只读规划:产出规划结论,不落盘、不改任何 git 状态。 */
  plan(request: HarvestRequest): Promise<HarvestResult>;
  /** 执行收割:含冲突续跑状态机与仓库级互斥。 */
  apply(request: HarvestRequest): Promise<HarvestResult>;
  /** 丢弃模式:先留痕 → 删检出 → 删分支 → 结构化结果。 */
  discard(request: DiscardRequest): Promise<DiscardResult>;
}

/** 官方检出池相对目录(设计文档 §6 步骤 3)。 */
const WORKTREE_POOL_DIR = path.join('.agents', 'worktrees');

/** 仓库根绝对路径下的官方检出路径:`<repo>/.agents/worktrees/<branch>`。 */
export function officialWorktreePath(repo: string, branch: string): string {
  return path.join(repo, WORKTREE_POOL_DIR, branch);
}

/** 仓库级互斥表:仓库根 → promise 链。 */
const repoLocks = new Map<string, Promise<void>>();

/** 互斥键:Windows 下路径大小写不敏感,统一小写归一。 */
function lockKey(repo: string): string {
  const resolved = path.resolve(repo);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 仓库级串行互斥:同一 key 的调用严格排队(后到者等待先到者完成)。 */
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.then(
    () => gate,
    () => gate,
  );
  repoLocks.set(key, chain);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (repoLocks.get(key) === chain) repoLocks.delete(key);
  }
}

/** 路径是否存在。 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 路径是否是目录。 */
async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** 目录是否为空(用于清理残留的空官方池槽位)。 */
async function isEmptyDir(target: string): Promise<boolean> {
  try {
    const entries = await readdir(target);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/** 解析 `git status --porcelain` 的文件清单(renames 取新路径)。 */
function parseStatusPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim().length === 0) continue;
    // porcelain v1:`XY<空格>path`(renames 为 `old -> new`)。
    const rest = line.slice(3).trim();
    const arrow = rest.indexOf(' -> ');
    const filePath = arrow === -1 ? rest : rest.slice(arrow + 4);
    if (filePath.length > 0) paths.push(toPosixPath(filePath));
  }
  return paths;
}

/** 一个已注册 worktree。 */
interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string;
}

/** 解析 `git worktree list --porcelain`。 */
function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  const flush = (): void => {
    if (currentPath !== undefined) {
      entries.push(
        currentBranch === undefined
          ? { path: currentPath }
          : { path: currentPath, branch: currentBranch },
      );
    }
    currentPath = undefined;
    currentBranch = undefined;
  };
  for (const line of stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = path.normalize(line.slice('worktree '.length).trim());
      continue;
    }
    if (line.startsWith('branch ')) {
      currentBranch = line
        .slice('branch '.length)
        .trim()
        .replace(/^refs\/heads\//, '');
      continue;
    }
    if (line.trim().length === 0) flush();
  }
  flush();
  return entries;
}

/** 分支是否存在(本地分支)。 */
async function branchExists(
  runner: GitRunner,
  repo: string,
  branch: string,
): Promise<boolean> {
  const result = await runner.capture(
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    {
      cwd: repo,
    },
  );
  return result.ok;
}

/** 解析任意 ref 到提交哈希(失败返回 undefined)。 */
async function revParse(
  runner: GitRunner,
  cwd: string,
  ref: string,
): Promise<string | undefined> {
  const result = await runner.capture(['rev-parse', ref], { cwd });
  if (!result.ok) return undefined;
  const hash = result.stdout.trim();
  return hash.length > 0 ? hash : undefined;
}

/** 当前检出分支(detached HEAD 返回 undefined)。 */
async function currentBranch(
  runner: GitRunner,
  cwd: string,
): Promise<string | undefined> {
  const result = await runner.capture(['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
  });
  if (!result.ok) return undefined;
  const name = result.stdout.trim();
  return name.length > 0 && name !== 'HEAD' ? name : undefined;
}

/** 上游跟踪信息(无上游返回 undefined)。 */
interface UpstreamInfo {
  readonly name: string;
  readonly tip: string;
}

async function upstreamOf(
  runner: GitRunner,
  repo: string,
  branch: string,
): Promise<UpstreamInfo | undefined> {
  const result = await runner.capture(
    [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${branch}@{upstream}`,
    ],
    { cwd: repo },
  );
  if (!result.ok) return undefined;
  const name = result.stdout.trim();
  if (name.length === 0) return undefined;
  const tip = await revParse(runner, repo, name);
  return { name, tip: tip ?? '' };
}

/** commit 是否是某 ref 的祖先。 */
async function isAncestor(
  runner: GitRunner,
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runner.capture(
    ['merge-base', '--is-ancestor', ancestor, descendant],
    {
      cwd: repo,
    },
  );
  return result.exitCode === 0;
}

/** 列出已注册 worktree。 */
async function listWorktrees(
  runner: GitRunner,
  repo: string,
): Promise<WorktreeEntry[]> {
  const result = await runner.capture(['worktree', 'list', '--porcelain'], {
    cwd: repo,
  });
  if (!result.ok) return [];
  return parseWorktreeList(result.stdout);
}

/**
 * agent 自管目录(官方检出池所在)不算主区脏态:
 * `<repo>/.agents/` 整目录由管线/agent 管理,收割临时检出落在
 * `.agents/worktrees/` 下,porcelain 会把整个未跟踪目录折叠成一条
 * `?? .agents/`——那是管线自己的脚手架,不是用户的未提交改动。
 */
function isManagedPoolPath(p: string): boolean {
  return p === '.agents' || p.startsWith('.agents/');
}

/** 主区脏文件清单(porcelain 解析;剔除 .agents/ 自管目录)。 */
async function dirtyFilesOf(runner: GitRunner, cwd: string): Promise<string[]> {
  const result = await runner.capture(['status', '--porcelain'], { cwd });
  if (!result.ok) return [];
  return parseStatusPaths(result.stdout).filter((p) => !isManagedPoolPath(p));
}

/** 错误转可读文本。 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 分支名转安全的路径片段(用于临时合并检出的目录名)。 */
function sanitizeForPath(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned.length > 0 ? cleaned.slice(0, 60) : 'branch';
}

/** 临时名唯一后缀计数器。 */
let tempCounter = 0;

function uniqueSuffix(): string {
  tempCounter += 1;
  return `${process.pid}-${tempCounter}`;
}

/** 构造管线。 */
export function createHarvestPipeline(
  options: HarvestPipelineOptions = {},
): HarvestPipeline {
  const runner = options.runner ?? createGitRunner();
  const inspector = options.inspector ?? createGitInspector(runner);

  /** 结果草稿(内部)。 */
  interface Draft {
    readonly taskId: string;
    readonly repo: string;
    readonly branch: string;
    readonly targetBranch: string;
    readonly worktreePath: string;
    readonly mode: HarvestMode;
    readonly result: HarvestResultKind;
    readonly actions: readonly string[];
    readonly notes: readonly string[];
    readonly reason?: string;
    readonly commits?: readonly CommitEntry[];
    readonly diffStat?: string;
    readonly changedFiles?: readonly string[];
    readonly baseAdvanced?: boolean | null;
    readonly conflict?: HarvestConflict;
    readonly mergeCommit?: string;
    readonly dirtyFiles?: readonly string[];
    readonly strategy?: HarvestStrategy;
    readonly degraded?: boolean;
    readonly baseCommit?: string;
  }

  const toResult = (draft: Draft): HarvestResult => ({
    taskId: draft.taskId,
    repo: draft.repo,
    branch: draft.branch,
    worktreePath: draft.worktreePath,
    targetBranch: draft.targetBranch,
    mode: draft.mode,
    result: draft.result,
    baseAdvanced: draft.baseAdvanced ?? null,
    commits: draft.commits ?? [],
    changedFiles: draft.changedFiles ?? [],
    actions: draft.actions,
    notes: draft.notes,
    ...(draft.reason !== undefined ? { reason: draft.reason } : {}),
    ...(draft.diffStat !== undefined ? { diffStat: draft.diffStat } : {}),
    ...(draft.baseAdvanced !== undefined
      ? { baseAdvanced: draft.baseAdvanced }
      : {}),
    ...(draft.conflict !== undefined ? { conflict: draft.conflict } : {}),
    ...(draft.mergeCommit !== undefined
      ? { mergeCommit: draft.mergeCommit }
      : {}),
    ...(draft.dirtyFiles !== undefined ? { dirtyFiles: draft.dirtyFiles } : {}),
    ...(draft.strategy !== undefined ? { strategy: draft.strategy } : {}),
    ...(draft.degraded !== undefined ? { degraded: draft.degraded } : {}),
    ...(draft.baseCommit !== undefined ? { baseCommit: draft.baseCommit } : {}),
  });

  /** 由冲突现场计划生成 conflict 描述。 */
  const conflictFromPlan = (
    kind: InProgressKind,
    side: 'worktree' | 'main',
    worktreePath: string,
    plan: ConflictPlan,
    resumeCommand: readonly string[],
  ): HarvestConflict => ({
    kind,
    side,
    files: plan.files.map((file) => file.path),
    suggestions: plan.files.flatMap((file) => [
      formatConflictSuggestion(file),
      ...file.suggestions,
    ]),
    worktreePath,
    resumeCommand,
  });

  /** 只读规划。 */
  const plan = async (request: HarvestRequest): Promise<HarvestResult> => {
    const repo = path.resolve(request.repo);
    const actions: string[] = [];
    const notes: string[] = [];
    const branch = request.branch;
    const draftBase = {
      taskId: request.taskId,
      repo,
      branch,
      worktreePath: '',
      mode: 'plan' as HarvestMode,
      actions,
      notes,
    };

    if (!(await isDirectory(repo))) {
      return toResult({
        ...draftBase,
        targetBranch: request.targetBranch ?? '',
        result: 'rejected',
        reason: `仓库目录不存在:${repo}`,
      });
    }
    const repoProbe = await runner.capture(['rev-parse', '--git-dir'], {
      cwd: repo,
    });
    if (!repoProbe.ok) {
      return toResult({
        ...draftBase,
        targetBranch: request.targetBranch ?? '',
        result: 'rejected',
        reason: `不是 git 仓库:${repo}`,
      });
    }
    if (request.status !== undefined && request.status !== 'done') {
      return toResult({
        ...draftBase,
        targetBranch: request.targetBranch ?? '',
        result: 'rejected',
        reason: `任务状态不是 done(当前:${request.status})`,
      });
    }
    if (!(await branchExists(runner, repo, branch))) {
      return toResult({
        ...draftBase,
        targetBranch: request.targetBranch ?? '',
        result: 'rejected',
        reason: `任务分支不存在:${branch}`,
      });
    }
    const mainBranch = await currentBranch(runner, repo);
    const targetBranch = request.targetBranch ?? mainBranch;
    if (targetBranch === undefined) {
      return toResult({
        ...draftBase,
        targetBranch: '',
        result: 'rejected',
        reason:
          '无法确定目标分支(主区处于 detached HEAD,请显式传入 targetBranch)',
      });
    }
    if (targetBranch === branch) {
      return toResult({
        ...draftBase,
        targetBranch,
        result: 'rejected',
        reason: '目标分支与任务分支相同,无需收割',
      });
    }
    if (!(await branchExists(runner, repo, targetBranch))) {
      return toResult({
        ...draftBase,
        targetBranch,
        result: 'rejected',
        reason: `目标分支不存在:${targetBranch}`,
      });
    }

    // 步骤 1:主区清洁检查(只读;apply 的硬门禁在规划阶段提前暴露)。
    const dirty = await dirtyFilesOf(runner, repo);
    if (dirty.length > 0) {
      notes.push(`主区有 ${dirty.length} 处未提交改动,收割将被拒绝`);
      return toResult({
        ...draftBase,
        targetBranch,
        result: 'rejected',
        reason: `主区不干净,拒绝收割:${dirty.join(', ')}`,
        dirtyFiles: dirty,
      });
    }

    // 步骤 2:推送检查(只读)。
    const upstream = await upstreamOf(runner, repo, branch);
    const localTip = await revParse(runner, repo, branch);
    const pushed =
      upstream !== undefined &&
      upstream.tip.length > 0 &&
      upstream.tip !== localTip;
    if (pushed) {
      notes.push(
        `任务分支已推送(${upstream.name} 与本地 tip 不一致):按契约拒绝变基,收割将降级为 --no-ff 合并`,
      );
    }

    // 步骤 3:检出定位(只读,不创建)。
    const worktrees = await listWorktrees(runner, repo);
    const existing = worktrees.find((entry) => entry.branch === branch);
    const worktreePath = existing?.path ?? officialWorktreePath(repo, branch);
    actions.push(
      existing === undefined
        ? `将在官方池临时检出:${worktreePath}`
        : `复用既有检出:${worktreePath}`,
    );

    // 步骤 4:差异审查(只读;审查命令失败转为 failed,不让异常穿透)。
    let review: GitLogReview;
    let diffStat: string | undefined;
    let changedFiles: string[];
    try {
      review = await inspector.log(repo, `${targetBranch}..${branch}`);
      diffStat = await inspector.diffStat(repo, `${targetBranch}...${branch}`);
      changedFiles = await inspector.changedFiles(
        repo,
        `${targetBranch}...${branch}`,
      );
    } catch (err) {
      return toResult({
        ...draftBase,
        targetBranch,
        worktreePath,
        result: 'failed',
        reason: `差异审查失败(不可恢复):${errorText(err)}`,
      });
    }
    if (review.entries.length === 0) {
      return toResult({
        ...draftBase,
        targetBranch,
        worktreePath,
        result: 'noop',
        reason: '无可收割内容:任务分支没有领先目标分支的提交',
        changedFiles,
      });
    }

    // 步骤 5:base 前进检测(只读)。
    let baseAdvanced: boolean | null = null;
    if (request.baseCommit !== undefined) {
      try {
        baseAdvanced = await inspector.baseAdvanced(
          repo,
          request.baseCommit,
          targetBranch,
        );
        notes.push(
          baseAdvanced
            ? `base 未前进(${request.baseCommit} 仍是 ${targetBranch} 祖先):无需变基`
            : `base 已前进(${request.baseCommit} 不再是 ${targetBranch} 祖先):需要变基`,
        );
      } catch (error) {
        // 检测失败(baseCommit 被回收 / 目标分支不存在等)不得穿透成未结构化异常:
        // 那会破坏 §5 的 result 契约(merged|conflict|rejected|noop|failed)。
        // 保守按「未前进」处理——不查就绝不改写历史,只在 notes 里如实说明。
        baseAdvanced = null;
        notes.push(
          `base 前进检测失败(${errorText(error)}):按未前进处理,不执行变基`,
        );
      }
    } else {
      notes.push('未提供 baseCommit:不检查 base 前进,直接合并');
    }

    // 步骤 7:合并预检(仅 merge-tree 纯只读路径;旧版 git 不做预演)。
    let conflictFiles: readonly string[] = [];
    // 能力探测本身可能抛(git 缺失/版本输出不可解析),不可穿透 §5 的 result 契约:
    // 探测失败按「无预演能力」处理,跳过预演直接进入合并阶段。
    let caps: { mergeTree: boolean } = { mergeTree: false };
    try {
      caps = await inspector.capabilities();
    } catch (err) {
      notes.push(`合并预检能力探测失败(${errorText(err)}):跳过预演,直接合并`);
    }
    if (caps.mergeTree) {
      try {
        const probe = await probeConflictsByMergeTree(
          runner,
          repo,
          targetBranch,
          branch,
        );
        conflictFiles = probe.files;
        if (probe.hasConflicts) {
          notes.push(
            `合并预检(变基前口径)发现 ${probe.files.length} 个冲突文件`,
          );
        } else {
          notes.push('合并预检(变基前口径)未发现冲突');
        }
      } catch (err) {
        notes.push(`合并预检失败(不影响规划):${errorText(err)}`);
      }
    } else {
      notes.push(
        '本机 git 版本低于 2.38:规划阶段不做冲突预演(避免降级试合并触碰工作区)',
      );
    }

    actions.push(`计划审查提交 ${review.entries.length} 条`);
    actions.push(
      baseAdvanced === false
        ? `计划:在检出内 rebase ${targetBranch},再在主区 merge --no-ff ${branch}`
        : `计划:在主区 merge --no-ff ${branch}`,
    );
    if (deleteBranchDefault(request))
      actions.push('计划:收割后 git branch -d 删除任务分支');
    if (!keepWorktreeDefault(request)) actions.push('计划:收割后删除检出');

    return toResult({
      ...draftBase,
      targetBranch,
      worktreePath,
      result: 'planned',
      commits: review.entries,
      changedFiles,
      baseAdvanced,
      ...(diffStat !== undefined ? { diffStat } : {}),
      ...(request.baseCommit !== undefined
        ? { baseCommit: request.baseCommit }
        : {}),
      ...(conflictFiles.length > 0
        ? {
            conflict: {
              kind: 'merge' as InProgressKind,
              side: 'main' as const,
              files: conflictFiles,
              suggestions: conflictFiles.map(
                (file) => `预检:该文件预计冲突:${file}`,
              ),
              worktreePath: repo,
              resumeCommand: [],
            },
          }
        : {}),
    });
  };

  /** deleteBranch 缺省 true。 */
  const deleteBranchDefault = (request: HarvestRequest): boolean =>
    request.deleteBranch ?? true;
  /** keepWorktree 缺省 false。 */
  const keepWorktreeDefault = (request: HarvestRequest): boolean =>
    request.keepWorktree ?? false;

  /** 执行收割(含续跑状态机与互斥)。 */
  const apply = async (request: HarvestRequest): Promise<HarvestResult> => {
    const repo = path.resolve(request.repo);
    return withRepoLock(lockKey(repo), async () => {
      const actions: string[] = [];
      const notes: string[] = [];
      const branch = request.branch;
      const deleteBranch = deleteBranchDefault(request);
      const keepWorktree = keepWorktreeDefault(request);
      const base = {
        taskId: request.taskId,
        repo,
        branch,
        worktreePath: '',
        mode: 'apply' as HarvestMode,
        actions,
        notes,
      };
      const rejected = (
        reason: string,
        extra: Partial<Draft> = {},
      ): HarvestResult =>
        toResult({
          ...base,
          targetBranch: extra.targetBranch ?? request.targetBranch ?? '',
          result: 'rejected',
          reason,
          ...extra,
        });

      // 步骤 0:前置校验。
      if (!(await isDirectory(repo))) return rejected(`仓库目录不存在:${repo}`);
      const repoProbe = await runner.capture(['rev-parse', '--git-dir'], {
        cwd: repo,
      });
      if (!repoProbe.ok) return rejected(`不是 git 仓库:${repo}`);
      if (request.status !== undefined && request.status !== 'done') {
        return rejected(`任务状态不是 done(当前:${request.status})`);
      }
      if (!(await branchExists(runner, repo, branch))) {
        return rejected(`任务分支不存在:${branch}`);
      }
      const mainBranch = await currentBranch(runner, repo);
      const targetBranch = request.targetBranch ?? mainBranch;
      if (targetBranch === undefined) {
        return rejected(
          '无法确定目标分支(主区处于 detached HEAD,请显式传入 targetBranch)',
        );
      }
      if (targetBranch === branch) {
        return rejected('目标分支与任务分支相同,无需收割', { targetBranch });
      }
      if (!(await branchExists(runner, repo, targetBranch))) {
        return rejected(`目标分支不存在:${targetBranch}`, { targetBranch });
      }

      // 现场探测(主区 + 检出)。
      const mainState = await detectInProgressState(runner, repo).catch(() => ({
        inProgress: false,
        kind: 'none' as InProgressKind,
        gitDir: '',
        markers: [] as readonly string[],
      }));
      if (mainState.kind === 'rebase') {
        return rejected('主区存在进行中的 rebase,拒绝收割(请先完成或 abort)', {
          targetBranch,
        });
      }
      const worktrees = await listWorktrees(runner, repo);
      // 变基进行中的检出 HEAD 处于 detached(worktree list 不再报分支),
      // 按官方池路径 + detached 兜底识别,保证冲突续跑能找回现场。
      const officialPoolPath = path.normalize(
        officialWorktreePath(repo, branch),
      );
      const existing =
        worktrees.find((entry) => entry.branch === branch) ??
        worktrees.find(
          (entry) =>
            entry.branch === undefined &&
            path.normalize(entry.path) === officialPoolPath,
        );
      const worktreePath = existing?.path ?? officialPoolPath;

      // 续跑分支一:检出内 rebase 进行中。
      if (existing !== undefined) {
        const wtState = await detectInProgressState(
          runner,
          existing.path,
        ).catch(() => ({
          inProgress: false,
          kind: 'none' as InProgressKind,
          gitDir: '',
          markers: [] as readonly string[],
        }));
        if (wtState.kind === 'rebase') {
          actions.push(
            `检出内检测到 rebase 进行中(${wtState.markers.join(',')}),执行 rebase --continue`,
          );
          // 无头续跑旁路:rebase --continue 生成提交时可能调起编辑器,piped stdio
          // 下会无限挂起(core.editor=true 立即退出并保留原提交信息)。
          const cont = await runner.capture(
            ['-c', 'core.editor=true', 'rebase', '--continue'],
            {
              cwd: existing.path,
              timeoutMs: HEAVY_TIMEOUT_MS,
            },
          );
          if (!cont.ok) {
            const plan = await buildConflictPlan(runner, existing.path).catch(
              () => ({
                files: [],
                notes: [] as readonly string[],
              }),
            );
            notes.push(
              'rebase 续跑仍未解决冲突,现场保留(解决并 git add 后再次调用 apply 即可续跑)',
            );
            return toResult({
              ...base,
              targetBranch,
              worktreePath: existing.path,
              result: 'conflict',
              conflict: conflictFromPlan(
                'rebase',
                'worktree',
                existing.path,
                plan,
                ['rebase', '--continue'],
              ),
            });
          }
          notes.push('rebase --continue 成功:变基完成');
          const review = await inspector.log(
            repo,
            `${targetBranch}..${branch}`,
          );
          const dirtyNow = await dirtyFilesOf(runner, repo);
          if (dirtyNow.length > 0) {
            notes.push(
              `主区有 ${dirtyNow.length} 处未提交改动,无法继续合并,拒绝收割`,
            );
            return toResult({
              ...base,
              targetBranch,
              worktreePath: existing.path,
              result: 'rejected',
              reason: `主区不干净,拒绝收割:${dirtyNow.join(', ')}`,
              dirtyFiles: dirtyNow,
              commits: review.entries,
            });
          }
          return mergePhase({
            repo,
            branch,
            targetBranch,
            mainBranch,
            worktreePath: existing.path,
            worktreeExisted: true,
            deleteBranch,
            keepWorktree,
            request,
            actions,
            notes,
            commits: review.entries,
          });
        }
      }

      // 续跑分支二:主区 merge 进行中。
      if (mainState.kind === 'merge') {
        const mergeHead = await revParse(runner, repo, 'MERGE_HEAD');
        const branchTip = await revParse(runner, repo, branch);
        const ours =
          mergeHead !== undefined &&
          (mergeHead === branchTip ||
            (await isAncestor(runner, repo, mergeHead, branch)));
        if (!ours) {
          return rejected(
            '主区存在其他分支的未完成合并,拒绝接管(请先完成或 merge --abort)',
            {
              targetBranch,
            },
          );
        }
        actions.push('主区检测到 merge 进行中,执行 commit --no-edit 收尾');
        const cont = await runner.capture(['commit', '--no-edit'], {
          cwd: repo,
          timeoutMs: HEAVY_TIMEOUT_MS,
        });
        if (!cont.ok) {
          const plan = await buildConflictPlan(runner, repo).catch(() => ({
            files: [],
            notes: [] as readonly string[],
          }));
          notes.push(
            'merge 收尾失败:冲突仍未解决,现场保留(解决并 git add 后再次调用 apply 即可续跑)',
          );
          return toResult({
            ...base,
            targetBranch,
            worktreePath,
            result: 'conflict',
            conflict: conflictFromPlan('merge', 'main', repo, plan, [
              'commit',
              '--no-edit',
            ]),
          });
        }
        notes.push('merge 收尾成功:合并提交已生成');
        const mergeCommit = await revParse(runner, repo, 'HEAD');
        await cleanup({
          runner,
          repo,
          branch,
          worktreePath: existing?.path,
          worktreeExisted: existing !== undefined,
          deleteBranch,
          keepWorktree,
          mergeCwd: repo,
          actions,
          notes,
        });
        return toResult({
          ...base,
          targetBranch,
          worktreePath,
          result: 'merged',
          strategy: 'merge',
          ...(mergeCommit !== undefined ? { mergeCommit } : {}),
        });
      }

      // 续跑分支三:官方池检出(临时合并检出等)内属于本分支的进行中 merge。
      // 目标分支≠主区当前分支时合并发生在临时合并检出,其目录名不可反推,
      // 因此按 worktree 列表扫描(主区已由续跑分支二处理)。
      for (const entry of worktrees) {
        if (path.normalize(entry.path) === path.normalize(repo)) continue;
        const poolState = await detectInProgressState(runner, entry.path).catch(
          () => undefined,
        );
        if (poolState === undefined || poolState.kind !== 'merge') continue;
        const poolMergeHead = await revParse(runner, entry.path, 'MERGE_HEAD');
        const poolBranchTip = await revParse(runner, repo, branch);
        const ours =
          poolMergeHead !== undefined &&
          poolBranchTip !== undefined &&
          (poolMergeHead === poolBranchTip ||
            (await isAncestor(runner, entry.path, poolMergeHead, branch)));
        if (!ours) continue;
        actions.push(
          `检出 ${entry.path} 检测到 merge 进行中,执行 commit --no-edit 收尾`,
        );
        const cont = await runner.capture(['commit', '--no-edit'], {
          cwd: entry.path,
          timeoutMs: HEAVY_TIMEOUT_MS,
        });
        if (!cont.ok) {
          const plan = await buildConflictPlan(runner, entry.path).catch(
            () => ({
              files: [],
              notes: [] as readonly string[],
            }),
          );
          notes.push(
            'merge 收尾失败:冲突仍未解决,现场保留(解决并 git add 后再次调用 apply 即可续跑)',
          );
          return toResult({
            ...base,
            targetBranch,
            worktreePath,
            result: 'conflict',
            conflict: conflictFromPlan('merge', 'worktree', entry.path, plan, [
              'commit',
              '--no-edit',
            ]),
          });
        }
        notes.push('merge 收尾成功:合并提交已生成');
        const mergeCommit = await revParse(runner, entry.path, 'HEAD');
        // 该检出若就是任务检出,走常规清理;若是临时合并检出,清理时一并删除。
        const isTaskWorktree =
          existing !== undefined &&
          path.normalize(existing.path) === path.normalize(entry.path);
        await cleanup({
          runner,
          repo,
          branch,
          worktreePath: existing?.path,
          worktreeExisted: existing !== undefined,
          deleteBranch,
          keepWorktree,
          mergeCwd: isTaskWorktree ? repo : entry.path,
          ...(isTaskWorktree ? {} : { mergeWorktreePath: entry.path }),
          actions,
          notes,
        });
        return toResult({
          ...base,
          targetBranch,
          worktreePath,
          result: 'merged',
          strategy: 'merge',
          ...(mergeCommit !== undefined ? { mergeCommit } : {}),
        });
      }

      // 步骤 1:主区清洁检查。
      const dirty = await dirtyFilesOf(runner, repo);
      if (dirty.length > 0) {
        notes.push(`主区有 ${dirty.length} 处未提交改动,拒绝收割(不替人清理)`);
        return rejected(`主区不干净,拒绝收割:${dirty.join(', ')}`, {
          targetBranch,
          dirtyFiles: dirty,
        });
      }

      // 步骤 2:推送检查(拒绝变基 → 降级合并)。
      const upstream = await upstreamOf(runner, repo, branch);
      const localTip = await revParse(runner, repo, branch);
      const pushed =
        upstream !== undefined &&
        upstream.tip.length > 0 &&
        upstream.tip !== localTip;
      let degraded = false;
      if (pushed) {
        degraded = true;
        notes.push(
          `任务分支已推送(${upstream.name} 与本地 tip 不一致):拒绝变基,降级为 --no-ff 合并`,
        );
        actions.push(`推送检查:${branch} 已推送 → 跳过变基`);
      }

      // 步骤 4:差异审查(inspector 内部是 captureOrThrow,审查命令失败转为 failed,
      // 不让异常穿透互斥锁;典型如无关历史分支无 merge-base 导致三点 diff 失败)。
      let review: GitLogReview;
      let diffStat: string | undefined;
      let changedFiles: string[];
      try {
        review = await inspector.log(repo, `${targetBranch}..${branch}`);
        diffStat = await inspector.diffStat(
          repo,
          `${targetBranch}...${branch}`,
        );
        changedFiles = await inspector.changedFiles(
          repo,
          `${targetBranch}...${branch}`,
        );
      } catch (err) {
        return toResult({
          ...base,
          targetBranch,
          worktreePath,
          result: 'failed',
          reason: `差异审查失败(不可恢复):${errorText(err)}`,
        });
      }
      if (review.entries.length === 0) {
        notes.push('无可收割内容:任务分支没有领先目标分支的提交');
        return toResult({
          ...base,
          targetBranch,
          worktreePath,
          result: 'noop',
          reason: '无可收割内容:任务分支没有领先目标分支的提交',
          changedFiles,
        });
      }

      // 步骤 3:检出准备(缺席则官方池临时检出)。
      let worktreeExisted = existing !== undefined;
      if (!worktreeExisted) {
        const created = await createWorktree(
          runner,
          repo,
          worktreePath,
          branch,
        );
        if (!created.ok) {
          return rejected(
            `无法创建临时检出(${worktreePath}):${created.error}`,
            {
              targetBranch,
              commits: review.entries,
              changedFiles,
            },
          );
        }
        worktreeExisted = true;
        actions.push(`已在官方池创建临时检出:${worktreePath}`);
      } else {
        actions.push(`复用既有检出:${worktreePath}`);
      }

      // 步骤 5:base 前进检测。
      let baseAdvanced: boolean | null = null;
      if (request.baseCommit !== undefined) {
        try {
          baseAdvanced = await inspector.baseAdvanced(
            worktreePath,
            request.baseCommit,
            targetBranch,
          );
        } catch (error) {
          // 同上:检测失败按未前进处理(不变基),不让异常穿透破坏结果契约。
          baseAdvanced = null;
          notes.push(
            `base 前进检测失败(${errorText(error)}):按未前进处理,不执行变基`,
          );
        }
      }
      const needRebase = baseAdvanced === false;

      // 步骤 6:变基。
      if (needRebase) {
        if (pushed) {
          degraded = true;
          notes.push('base 已前进但分支已推送:拒绝变基,直接 --no-ff 合并');
        } else if (mainBranch === branch) {
          degraded = true;
          notes.push('任务分支当前在主区检出:无法变基,直接 --no-ff 合并');
        } else {
          actions.push(`在检出内执行 rebase ${targetBranch}`);
          const rebase = await runner.capture(['rebase', targetBranch], {
            cwd: worktreePath,
            timeoutMs: HEAVY_TIMEOUT_MS,
          });
          if (!rebase.ok) {
            const state = await detectInProgressState(
              runner,
              worktreePath,
            ).catch(() => ({
              inProgress: false,
              kind: 'none' as InProgressKind,
              gitDir: '',
              markers: [] as readonly string[],
            }));
            if (state.kind === 'rebase') {
              const plan = await buildConflictPlan(runner, worktreePath).catch(
                () => ({
                  files: [],
                  notes: [] as readonly string[],
                }),
              );
              notes.push(
                '变基冲突:现场保留(rebase 进行中),解决并 git add 后再次调用 apply 续跑',
              );
              return toResult({
                ...base,
                targetBranch,
                worktreePath,
                result: 'conflict',
                commits: review.entries,
                changedFiles,
                baseAdvanced,
                conflict: conflictFromPlan(
                  'rebase',
                  'worktree',
                  worktreePath,
                  plan,
                  ['rebase', '--continue'],
                ),
              });
            }
            const abort = await runner.capture(['rebase', '--abort'], {
              cwd: worktreePath,
              timeoutMs: HEAVY_TIMEOUT_MS,
            });
            notes.push(
              abort.ok
                ? '变基失败(非冲突):已 rebase --abort 干净回滚'
                : `变基失败(非冲突)且 abort 失败:${abort.stderr.trim().slice(0, 200)}`,
            );
            return toResult({
              ...base,
              targetBranch,
              worktreePath,
              result: 'failed',
              reason: `变基失败(非冲突):${rebase.stderr.trim().slice(0, 300)}`,
              commits: review.entries,
              changedFiles,
              baseAdvanced,
            });
          }
          actions.push('变基完成');
        }
      }

      return mergePhase({
        repo,
        branch,
        targetBranch,
        mainBranch,
        worktreePath,
        worktreeExisted,
        deleteBranch,
        keepWorktree,
        request,
        actions,
        notes,
        commits: review.entries,
        changedFiles,
        diffStat,
        baseAdvanced,
        degraded,
      });
    });
  };

  /** 合并阶段(步骤 7-10)。 */
  const mergePhase = async (ctx: {
    readonly repo: string;
    readonly branch: string;
    readonly targetBranch: string;
    readonly mainBranch: string | undefined;
    readonly worktreePath: string;
    readonly worktreeExisted: boolean;
    readonly deleteBranch: boolean;
    readonly keepWorktree: boolean;
    readonly request: HarvestRequest;
    readonly actions: string[];
    readonly notes: string[];
    readonly commits?: readonly CommitEntry[];
    readonly changedFiles?: readonly string[];
    readonly diffStat?: string;
    readonly baseAdvanced?: boolean | null;
    readonly degraded?: boolean;
  }): Promise<HarvestResult> => {
    const { repo, branch, targetBranch, actions, notes } = ctx;
    const base = {
      taskId: ctx.request.taskId,
      repo,
      branch,
      worktreePath: ctx.worktreePath,
      mode: 'apply' as HarvestMode,
      actions,
      notes,
    };

    // 合并落点:目标分支==主区当前分支 → 主区合并;否则临时合并检出。
    let mergeCwd = repo;
    let mergeWorktreePath: string | undefined;
    if (ctx.mainBranch !== targetBranch) {
      mergeWorktreePath = path.join(
        repo,
        WORKTREE_POOL_DIR,
        `harvest-merge-${sanitizeForPath(targetBranch)}-${uniqueSuffix()}`,
      );
      const created = await createWorktree(
        runner,
        repo,
        mergeWorktreePath,
        targetBranch,
      );
      if (!created.ok) {
        notes.push(`无法为 ${targetBranch} 创建临时合并检出:${created.error}`);
        return toResult({
          ...base,
          targetBranch,
          result: 'failed',
          reason: `无法为 ${targetBranch} 创建临时合并检出:${created.error}`,
          ...(ctx.commits !== undefined ? { commits: ctx.commits } : {}),
          ...(ctx.changedFiles !== undefined
            ? { changedFiles: ctx.changedFiles }
            : {}),
        });
      }
      mergeCwd = mergeWorktreePath;
      notes.push(
        `目标分支 ${targetBranch} 不是主区当前分支:在临时合并检出 ${mergeWorktreePath} 中合并`,
      );
    }

    // 步骤 7:合并预检(merge-tree 只读,仅提示)。
    // 能力探测本身可能抛(git 缺失/版本输出不可解析),不可穿透 §5 的 result 契约:
    // 探测失败按「无预演能力」处理,直接进入合并阶段。
    let mergeCaps: { mergeTree: boolean } = { mergeTree: false };
    try {
      mergeCaps = await inspector.capabilities();
    } catch (err) {
      notes.push(`合并预检能力探测失败(${errorText(err)}):跳过预演,直接合并`);
    }
    if (mergeCaps.mergeTree) {
      try {
        const probe = await probeConflictsByMergeTree(
          runner,
          repo,
          targetBranch,
          branch,
        );
        if (probe.hasConflicts) {
          notes.push(
            `合并预检发现 ${probe.files.length} 个冲突文件(变基后口径)`,
          );
        }
      } catch (err) {
        notes.push(`合并预检失败(不影响收割):${errorText(err)}`);
      }
    }

    // 步骤 8:合并。
    actions.push(`执行 merge --no-ff ${branch}`);
    const merge = await runner.capture(['merge', '--no-ff', branch], {
      cwd: mergeCwd,
      timeoutMs: HEAVY_TIMEOUT_MS,
    });
    if (!merge.ok) {
      const state = await detectInProgressState(runner, mergeCwd).catch(() => ({
        inProgress: false,
        kind: 'none' as InProgressKind,
        gitDir: '',
        markers: [] as readonly string[],
      }));
      if (state.kind === 'merge') {
        const plan = await buildConflictPlan(runner, mergeCwd).catch(() => ({
          files: [],
          notes: [] as readonly string[],
        }));
        notes.push(
          '合并冲突:现场保留(merge 进行中),解决并 git add 后再次调用 apply 续跑',
        );
        return toResult({
          ...base,
          targetBranch,
          result: 'conflict',
          conflict: conflictFromPlan(
            'merge',
            mergeCwd === repo ? 'main' : 'worktree',
            mergeCwd,
            plan,
            ['commit', '--no-edit'],
          ),
          ...(ctx.commits !== undefined ? { commits: ctx.commits } : {}),
          ...(ctx.changedFiles !== undefined
            ? { changedFiles: ctx.changedFiles }
            : {}),
          ...(ctx.baseAdvanced !== undefined
            ? { baseAdvanced: ctx.baseAdvanced }
            : {}),
        });
      }
      const abort = await runner.capture(['merge', '--abort'], {
        cwd: mergeCwd,
        timeoutMs: HEAVY_TIMEOUT_MS,
      });
      notes.push(
        abort.ok
          ? '合并失败(非冲突):已 merge --abort 干净回滚'
          : `合并失败(非冲突)且 abort 失败:${abort.stderr.trim().slice(0, 200)}`,
      );
      // 失败路径只收自己的尸体:临时合并检出删掉;任务检出与分支保留(未合并,
      // -d 会拒绝;保留便于人工排查或重试)。
      if (mergeWorktreePath !== undefined) {
        const removed = await runner.capture(
          ['worktree', 'remove', mergeWorktreePath],
          {
            cwd: repo,
            timeoutMs: HEAVY_TIMEOUT_MS,
          },
        );
        notes.push(
          removed.ok
            ? `已清理临时合并检出:${mergeWorktreePath}`
            : `临时合并检出未删除(${mergeWorktreePath}):${removed.stderr.trim().slice(0, 200)}`,
        );
      }
      return toResult({
        ...base,
        targetBranch,
        result: 'failed',
        reason: `合并失败(非冲突):${merge.stderr.trim().slice(0, 300)}`,
        ...(ctx.commits !== undefined ? { commits: ctx.commits } : {}),
        ...(ctx.changedFiles !== undefined
          ? { changedFiles: ctx.changedFiles }
          : {}),
        ...(ctx.baseAdvanced !== undefined
          ? { baseAdvanced: ctx.baseAdvanced }
          : {}),
      });
    }

    // 合并成功:收尾(步骤 9)。
    const mergeCommit = await revParse(runner, mergeCwd, 'HEAD');
    notes.push(
      `合并成功:${targetBranch} 上生成合并提交 ${mergeCommit ?? '(未知)'}`,
    );
    await cleanup({
      runner,
      repo,
      branch,
      worktreePath: ctx.worktreePath,
      worktreeExisted: ctx.worktreeExisted,
      deleteBranch: ctx.deleteBranch,
      keepWorktree: ctx.keepWorktree,
      mergeCwd,
      mergeWorktreePath,
      actions,
      notes,
    });
    return toResult({
      ...base,
      targetBranch,
      result: 'merged',
      strategy: 'merge',
      ...(mergeCommit !== undefined ? { mergeCommit } : {}),
      ...(ctx.commits !== undefined ? { commits: ctx.commits } : {}),
      ...(ctx.changedFiles !== undefined
        ? { changedFiles: ctx.changedFiles }
        : {}),
      ...(ctx.diffStat !== undefined ? { diffStat: ctx.diffStat } : {}),
      ...(ctx.baseAdvanced !== undefined
        ? { baseAdvanced: ctx.baseAdvanced }
        : {}),
      ...(ctx.degraded !== undefined ? { degraded: ctx.degraded } : {}),
    });
  };

  /** 清理(步骤 9):删检出 → 删分支 → 删临时合并检出(失败只进 notes)。 */
  const cleanup = async (ctx: {
    readonly runner: GitRunner;
    readonly repo: string;
    readonly branch: string;
    readonly worktreePath?: string;
    readonly worktreeExisted: boolean;
    readonly deleteBranch: boolean;
    readonly keepWorktree: boolean;
    readonly mergeCwd: string;
    readonly mergeWorktreePath?: string;
    readonly actions: string[];
    readonly notes: string[];
  }): Promise<void> => {
    const { runner, repo, branch, actions, notes } = ctx;
    // 先删检出:分支被检出时 `git branch -d` 会拒绝删除。
    if (
      ctx.worktreePath !== undefined &&
      ctx.worktreeExisted &&
      !ctx.keepWorktree
    ) {
      const removed = await runner.capture(
        ['worktree', 'remove', ctx.worktreePath],
        {
          cwd: repo,
          timeoutMs: HEAVY_TIMEOUT_MS,
        },
      );
      if (removed.ok) {
        actions.push(`已删除检出:${ctx.worktreePath}`);
      } else {
        notes.push(
          `检出未删除(${ctx.worktreePath},可能仍有未提交改动):${removed.stderr.trim().slice(0, 200)}`,
        );
      }
    } else if (ctx.keepWorktree) {
      notes.push('按 keepWorktree 保留检出');
    }
    // 再删分支:安全删除(-d),未合并则拒绝并如实报告。
    if (ctx.deleteBranch) {
      const deleted = await runner.capture(['branch', '-d', branch], {
        cwd: ctx.mergeCwd,
      });
      if (deleted.ok) {
        actions.push(`已安全删除分支:${branch}`);
      } else {
        notes.push(
          `分支未删除(${branch}):${deleted.stderr.trim().slice(0, 200)}`,
        );
      }
    } else {
      notes.push('按 deleteBranch=false 保留分支');
    }
    // 最后删临时合并检出(目标分支≠主区当前分支时创建的合并现场)。
    if (ctx.mergeWorktreePath !== undefined) {
      const removed = await runner.capture(
        ['worktree', 'remove', ctx.mergeWorktreePath],
        {
          cwd: repo,
          timeoutMs: HEAVY_TIMEOUT_MS,
        },
      );
      if (removed.ok) {
        actions.push(`已删除临时合并检出:${ctx.mergeWorktreePath}`);
      } else {
        notes.push(
          `临时合并检出未删除(${ctx.mergeWorktreePath}):${removed.stderr.trim().slice(0, 200)}`,
        );
      }
    }
  };

  /** 创建 worktree(官方池临时检出)。 */
  const createWorktree = async (
    git: GitRunner,
    repo: string,
    target: string,
    ref: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (await pathExists(target)) {
      if (await isEmptyDir(target)) {
        // 残留的空槽位:清掉再让 git 建。
        await rm(target, { recursive: true, force: true });
      } else {
        return { ok: false, error: `目标路径已存在且非空:${target}` };
      }
    }
    await mkdir(path.dirname(target), { recursive: true });
    const added = await git.capture(['worktree', 'add', target, ref], {
      cwd: repo,
      timeoutMs: HEAVY_TIMEOUT_MS,
    });
    if (!added.ok) {
      return { ok: false, error: added.stderr.trim().slice(0, 300) };
    }
    return { ok: true };
  };

  /** 丢弃模式:先留痕 → 删检出 → 删分支 → 结构化结果。 */
  const discard = async (request: DiscardRequest): Promise<DiscardResult> => {
    const repo = path.resolve(request.repo);
    return withRepoLock(lockKey(repo), async () => {
      const actions: string[] = [];
      const notes: string[] = [];
      const finish = (
        result: DiscardResultKind,
        branchDeleted: boolean,
        worktreeRemoved: boolean,
        trace: DiscardTrace,
        reason?: string,
      ): DiscardResult => ({
        taskId: request.taskId,
        repo,
        result,
        branchDeleted,
        worktreeRemoved,
        trace,
        actions,
        notes,
        ...(reason !== undefined ? { reason } : {}),
      });

      if (!(await isDirectory(repo))) {
        return finish(
          'rejected',
          false,
          false,
          {
            branch: request.branch,
            dirtyFiles: [],
            ...(request.worktreePath !== undefined
              ? { worktreePath: request.worktreePath }
              : {}),
          },
          `仓库目录不存在:${repo}`,
        );
      }
      const repoProbe = await runner.capture(['rev-parse', '--git-dir'], {
        cwd: repo,
      });
      if (!repoProbe.ok) {
        return finish(
          'rejected',
          false,
          false,
          {
            branch: request.branch,
            dirtyFiles: [],
            ...(request.worktreePath !== undefined
              ? { worktreePath: request.worktreePath }
              : {}),
          },
          `不是 git 仓库:${repo}`,
        );
      }

      // ① 留痕素材:必须先于任何删除动作产出(只返回调用方,不落盘)。
      const dirty: string[] = [];
      if (request.worktreePath !== undefined) {
        const status = await runner.capture(['status', '--porcelain'], {
          cwd: request.worktreePath,
        });
        if (status.ok) {
          dirty.push(...parseStatusPaths(status.stdout));
        } else {
          notes.push(
            `检出状态读取失败(${request.worktreePath}),脏文件清单为空`,
          );
        }
      }
      let branchTip: string | undefined;
      if (request.branch !== undefined) {
        branchTip = await revParse(runner, repo, request.branch);
      }
      const trace: DiscardTrace = {
        dirtyFiles: dirty,
        ...(request.branch !== undefined ? { branch: request.branch } : {}),
        ...(branchTip !== undefined ? { branchTip } : {}),
        ...(request.worktreePath !== undefined
          ? { worktreePath: request.worktreePath }
          : {}),
      };
      actions.push(
        `已采集留痕素材:分支=${trace.branch ?? '(无)'} tip=${trace.branchTip ?? '(无)'} 脏文件=${trace.dirtyFiles.length} 处`,
      );

      // ② 删检出:脏检出也删(丢弃语义,不套用收割的脏拒规则)。
      let worktreeRemoved = false;
      if (request.worktreePath !== undefined) {
        if (!(await pathExists(request.worktreePath))) {
          notes.push(`检出已不存在,跳过删除(幂等):${request.worktreePath}`);
        } else {
          const removed = await runner.capture(
            ['worktree', 'remove', '--force', request.worktreePath],
            { cwd: repo, timeoutMs: HEAVY_TIMEOUT_MS },
          );
          if (removed.ok) {
            worktreeRemoved = true;
            actions.push(`已删除检出:${request.worktreePath}`);
          } else {
            notes.push(
              `检出删除失败(${request.worktreePath}):${removed.stderr.trim().slice(0, 200)}`,
            );
          }
        }
      }

      // ③ 删分支:-D 强删(discard 语义,与收割的 -d 安全删除区分)。
      let branchDeleted = false;
      if (request.branch !== undefined) {
        if (!(await branchExists(runner, repo, request.branch))) {
          notes.push(`分支已不存在,跳过删除(幂等):${request.branch}`);
        } else {
          const deleted = await runner.capture(
            ['branch', '-D', request.branch],
            { cwd: repo },
          );
          if (deleted.ok) {
            branchDeleted = true;
            actions.push(`已强制删除分支:${request.branch}`);
          } else {
            notes.push(
              `分支删除失败(${request.branch}):${deleted.stderr.trim().slice(0, 200)}`,
            );
          }
        }
      } else {
        notes.push('未提供分支信息:仅清理检出,分支未处理');
      }

      // ④ 结构化结果。
      if (!worktreeRemoved && !branchDeleted) {
        return finish('noop', branchDeleted, worktreeRemoved, trace);
      }
      if (branchDeleted && worktreeRemoved) {
        return finish('deleted', branchDeleted, worktreeRemoved, trace);
      }
      return finish('partial', branchDeleted, worktreeRemoved, trace);
    });
  };

  return { plan, apply, discard };
}
