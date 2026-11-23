/**
 * 收割只读审查:diffStat / log / changedFiles / baseAdvanced / conflictFiles
 * 五项审查(纯查询,不改任何 git 状态——冲突预检的降级试合并除外,见下)。
 *
 * 设计依据 docs/harvest-design.md §5/§6:
 * - §5 输出契约:commits / diffStat / changedFiles / baseAdvanced / conflict
 *   五个事实字段即本面的五项审查,管线(plan/apply)直接组合成本面输出;
 * - §6 步骤 4 差异审查:`git log target..branch`、`git diff target...branch --stat`
 *   与 changed files(log 用两点=分支独有提交,diff 用三点=任务分支带来的改动);
 * - §6 步骤 5 base 前进检测:`git merge-base --is-ancestor baseCommit target`,
 *   {@link GitInspector.baseAdvanced} 返回 true = baseCommit 仍是 target 祖先
 *   (base 未前进),false = 需要变基;
 * - §6 步骤 7 合并预检:`git merge-tree --write-tree --name-only`(git ≥ 2.38),
 *   版本不足时降级 `merge --no-commit` + `merge --abort` 试合并。降级路径会
 *   **短暂触碰工作区**(要求 cwd 当前检出 ours 且工作区干净,结束必还原)。
 *
 * 冲突预检的两条路径独立导出({@link probeConflictsByMergeTree} /
 * {@link probeConflictsByMergeFallback}),可分别真实测试,不依赖本机 git 版本。
 *
 * @module dsh-kanban-mode/harvest/inspect
 */
import { GitRunnerError, toPosixPath, versionAtLeast } from './git-runner.ts';
import type { GitRunner, GitVersion } from './git-runner.ts';

/** 冲突预检 merge-tree 路径的最低 git 版本(`--write-tree` 于 git 2.38 引入)。 */
export const MIN_MERGE_TREE_VERSION: GitVersion = {
  major: 2,
  minor: 38,
  patch: 0,
  raw: '2.38.0',
};

/** 单条审查的提交数上限(与上游结算证据 MAX_COMMIT_EVIDENCE 同口径,截断不阻塞)。 */
export const MAX_LOG_ENTRIES = 50;

/** 降级试合并 / abort 等重操作的超时(毫秒)。 */
export const HEAVY_TIMEOUT_MS = 30_000;

/** 单条提交(`git log --pretty=format:%h %s` 的解析结果)。 */
export interface CommitEntry {
  readonly hash: string;
  readonly subject: string;
}

/** log 审查结果:entries 最多 cap 条,total 是截断前总数。 */
export interface GitLogReview {
  readonly entries: readonly CommitEntry[];
  readonly total: number;
}

/** 冲突预检走的路径。 */
export type ConflictProbeMethod = 'merge-tree' | 'merge-fallback';

/** 冲突预检结果(只读;降级路径的还原说明进 notes)。 */
export interface ConflictProbe {
  readonly hasConflicts: boolean;
  /** 冲突文件清单(POSIX 归一路径,仓库相对)。 */
  readonly files: readonly string[];
  readonly method: ConflictProbeMethod;
  /** 过程说明(如「已用 merge --abort 还原试合并现场」)。 */
  readonly notes: readonly string[];
}

/** 冲突预检能力自报(按本机 git 版本判定)。 */
export interface GitInspectorCapabilities {
  /** 本机 git 是否支持 merge-tree 路径(git ≥ 2.38)。 */
  readonly mergeTree: boolean;
  readonly gitVersion: GitVersion;
}

/** 五项只读审查的窄接口(收割管线与后续工具只依赖本接口)。 */
export interface GitInspector {
  /** 差异摘要(`git diff --shortstat <range>`);无差异时 undefined。 */
  diffStat(cwd: string, range: string): Promise<string | undefined>;
  /** 提交清单(`git log --pretty=format:%h %s <range>`),超出 cap 截断并报总数。 */
  log(cwd: string, range: string, cap?: number): Promise<GitLogReview>;
  /** 改动文件清单(`git diff --name-only <range>`,POSIX 归一路径)。 */
  changedFiles(cwd: string, range: string): Promise<string[]>;
  /**
   * base 前进检测:`baseCommit` 是否仍是 `targetBranch` 的祖先
   * (`merge-base --is-ancestor`)。true = base 未前进;false = base 已不在
   * target 线上(需要变基)。分支/提交不存在时抛 `command-failed`。
   */
  baseAdvanced(
    cwd: string,
    baseCommit: string,
    targetBranch: string,
  ): Promise<boolean>;
  /**
   * 冲突预检:按本机 git 版本自动选路——git ≥ 2.38 走 merge-tree(无检出
   * 要求),否则降级试合并(要求 cwd 当前检出 ours 且工作区干净,结束还原)。
   */
  conflictFiles(
    cwd: string,
    ours: string,
    theirs: string,
  ): Promise<ConflictProbe>;
  /** 能力自报:本机 git 版本与 merge-tree 可用性(调用方可据此预告预检路径)。 */
  capabilities(): Promise<GitInspectorCapabilities>;
}

/** 校验 ref 参数:拒绝空串与以 `-` 开头的名字(选项注入防御,可操作错误)。 */
function assertRefName(name: string, what: string): void {
  if (name.length === 0 || name.startsWith('-')) {
    throw new GitRunnerError(
      'command-failed',
      `${what} 非法(不允许为空或以 - 开头):「${name}」`,
      { args: [name] },
    );
  }
}

/** 校验 range 参数(如 `main...task`):同样拒绝空串与 `-` 开头。 */
function assertRange(range: string): void {
  if (range.length === 0 || range.startsWith('-')) {
    throw new GitRunnerError(
      'command-failed',
      `diff/log 范围非法(不允许为空或以 - 开头):「${range}」`,
      { args: [range] },
    );
  }
}

/** 解析 `--pretty=format:%h %s` 的单行(第一个空格分隔哈希与主题)。 */
function parseCommitLine(line: string): CommitEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const space = trimmed.indexOf(' ');
  if (space === -1) return { hash: trimmed, subject: '' };
  return { hash: trimmed.slice(0, space), subject: trimmed.slice(space + 1) };
}

/**
 * 冲突预检路径一:merge-tree(git ≥ 2.38,纯只读,不触碰工作区)。
 * `git merge-tree --write-tree --name-only ours theirs`:
 * exit 0 = 干净合并(stdout 仅 tree oid);exit 1 = 有冲突或合并失败。
 * `--write-tree` 的 stdout 形态(git 文档):首行 tree oid,随后是冲突文件
 * 列表,再以一个空行分隔 informational messages(Auto-merging/CONFLICT…,
 * 实测 git 2.56 把这些也打进 stdout,必须按空行切开丢弃)。
 * 甄别:exit 1 且首行是合法 tree oid = 冲突结果;exit 1 且无 tree oid =
 * 合并本身失败(如坏引用),抛可操作错误;其他退出码同样抛。
 */
export async function probeConflictsByMergeTree(
  runner: GitRunner,
  cwd: string,
  ours: string,
  theirs: string,
): Promise<ConflictProbe> {
  assertRefName(ours, 'ours(合并基准侧)');
  assertRefName(theirs, 'theirs(被合并侧)');
  const result = await runner.capture(
    ['merge-tree', '--write-tree', '--name-only', ours, theirs],
    { cwd },
  );
  if (result.exitCode === 0) {
    return { hasConflicts: false, files: [], method: 'merge-tree', notes: [] };
  }
  if (result.exitCode === 1) {
    const lines = result.stdout.split('\n');
    const first = (lines[0] ?? '').trim();
    // sha1 tree oid 40 位 / sha256 64 位;缺失说明合并本身没跑成(非冲突)。
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(first)) {
      throw new GitRunnerError(
        'command-failed',
        `merge-tree 冲突预检失败(exit 1,stdout 缺少 tree oid):git merge-tree --write-tree --name-only ${ours} ${theirs};${result.stderr.trim().slice(0, 300)}`,
        {
          args: ['merge-tree', ours, theirs],
          exitCode: result.exitCode,
          stderr: result.stderr,
        },
      );
    }
    // tree oid 之后到第一个空行是冲突文件(--name-only);空行后是信息区,丢弃。
    const body = lines.slice(1);
    const blankIdx = body.findIndex((line) => line.trim().length === 0);
    const fileLines = blankIdx === -1 ? body : body.slice(0, blankIdx);
    const files = fileLines
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(toPosixPath);
    return {
      hasConflicts: files.length > 0,
      files,
      method: 'merge-tree',
      notes:
        files.length === 0
          ? ['merge-tree 报告冲突但未列出文件,建议人工 git status 复核']
          : [],
    };
  }
  throw new GitRunnerError(
    'command-failed',
    `merge-tree 冲突预检失败(exit ${result.exitCode}):git merge-tree --write-tree --name-only ${ours} ${theirs};${result.stderr.trim().slice(0, 300)}`,
    {
      args: ['merge-tree', ours, theirs],
      exitCode: result.exitCode,
      stderr: result.stderr,
    },
  );
}

/**
 * 冲突预检路径二:旧版 git(< 2.38)降级试合并——`merge --no-commit --no-ff`
 * 试合并 theirs,失败则用 `diff --name-only --diff-filter=U` 收冲突文件,
 * 无论结果如何都以 `merge --abort` 还原现场。要求 cwd 当前检出 ours 且
 * 工作区干净(merge 会触碰工作区与索引)。
 */
export async function probeConflictsByMergeFallback(
  runner: GitRunner,
  cwd: string,
  ours: string,
  theirs: string,
): Promise<ConflictProbe> {
  assertRefName(ours, 'ours(合并基准侧)');
  assertRefName(theirs, 'theirs(被合并侧)');
  // 前置:工作区必须干净。降级试合并会动工作区,脏现场拒绝(不替人清理)。
  const status = await runner.captureOrThrow(['status', '--porcelain'], {
    cwd,
  });
  const dirtyLines = status.stdout
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (dirtyLines.length > 0) {
    throw new GitRunnerError(
      'command-failed',
      `降级试合并要求工作区干净(当前有 ${dirtyLines.length} 处未提交改动)。请先提交或暂存后再做冲突预检`,
      { args: ['status', '--porcelain'], stderr: status.stdout },
    );
  }
  const notes: string[] = [];
  const merged = await runner.capture(
    ['merge', '--no-commit', '--no-ff', theirs],
    { cwd, timeoutMs: HEAVY_TIMEOUT_MS },
  );
  let files: string[] = [];
  if (!merged.ok) {
    const unmerged = await runner.capture(
      ['diff', '--name-only', '--diff-filter=U'],
      { cwd },
    );
    files = unmerged.ok
      ? unmerged.stdout
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .map(toPosixPath)
      : [];
  }
  // 无论结果如何都还原现场(merge --no-commit 后 MERGE_HEAD 悬挂;失败未开始
  // 合并时 abort 会报 not currently on a merge,无害)。
  const aborted = await runner.capture(['merge', '--abort'], {
    cwd,
    timeoutMs: HEAVY_TIMEOUT_MS,
  });
  if (!aborted.ok) {
    if (/not currently on a merge|no merge in progress/i.test(aborted.stderr)) {
      notes.push('试合并未开始,无需还原');
    } else {
      notes.push(
        'merge --abort 未能还原现场,请立即人工执行 git status 检查工作区',
      );
    }
  } else {
    notes.push('已用 merge --abort 还原试合并现场');
  }
  if (merged.ok) {
    return { hasConflicts: false, files: [], method: 'merge-fallback', notes };
  }
  if (files.length > 0) {
    return { hasConflicts: true, files, method: 'merge-fallback', notes };
  }
  // 失败但没有任何未合并文件:不是冲突,是其他错误(如分支不存在)。
  throw new GitRunnerError(
    'command-failed',
    `降级试合并失败(非冲突):git merge --no-commit --no-ff ${theirs};${merged.stderr.trim().slice(0, 300)}`,
    {
      args: ['merge', '--no-commit', '--no-ff', theirs],
      exitCode: merged.exitCode,
      stderr: merged.stderr,
    },
  );
}

/** 构造五项只读审查器:全部经注入的 git-runner 执行真实 git。 */
export function createGitInspector(runner: GitRunner): GitInspector {
  const diffStat = async (
    cwd: string,
    range: string,
  ): Promise<string | undefined> => {
    assertRange(range);
    const result = await runner.captureOrThrow(['diff', '--shortstat', range], {
      cwd,
    });
    const text = result.stdout.trim();
    return text.length > 0 ? text : undefined;
  };

  const log = async (
    cwd: string,
    range: string,
    cap: number = MAX_LOG_ENTRIES,
  ): Promise<GitLogReview> => {
    assertRange(range);
    const limit = Math.max(1, Math.floor(cap));
    const result = await runner.captureOrThrow(
      ['log', '--pretty=format:%h %s', range],
      { cwd },
    );
    const all = result.stdout
      .split('\n')
      .map(parseCommitLine)
      .filter((entry): entry is CommitEntry => entry !== undefined);
    return { entries: all.slice(0, limit), total: all.length };
  };

  const changedFiles = async (
    cwd: string,
    range: string,
  ): Promise<string[]> => {
    assertRange(range);
    const result = await runner.captureOrThrow(['diff', '--name-only', range], {
      cwd,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(toPosixPath);
  };

  const baseAdvanced = async (
    cwd: string,
    baseCommit: string,
    targetBranch: string,
  ): Promise<boolean> => {
    assertRefName(baseCommit, 'baseCommit');
    assertRefName(targetBranch, 'targetBranch');
    // exit 0 = base 是 target 祖先(base 未前进);exit 1 = 不是祖先(需变基);
    // 其他退出码 = 无法判定(分支/提交不存在等),抛可操作错误。
    const result = await runner.capture(
      ['merge-base', '--is-ancestor', baseCommit, targetBranch],
      { cwd },
    );
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new GitRunnerError(
      'command-failed',
      `无法判定 base 是否前进(exit ${result.exitCode}):git merge-base --is-ancestor ${baseCommit} ${targetBranch};${result.stderr.trim().slice(0, 300)}`,
      {
        args: ['merge-base', '--is-ancestor', baseCommit, targetBranch],
        exitCode: result.exitCode,
        stderr: result.stderr,
      },
    );
  };

  const conflictFiles = async (
    cwd: string,
    ours: string,
    theirs: string,
  ): Promise<ConflictProbe> => {
    const current = await runner.version();
    if (versionAtLeast(current, MIN_MERGE_TREE_VERSION)) {
      return probeConflictsByMergeTree(runner, cwd, ours, theirs);
    }
    return probeConflictsByMergeFallback(runner, cwd, ours, theirs);
  };

  const capabilities = async (): Promise<GitInspectorCapabilities> => {
    const current = await runner.version();
    return {
      mergeTree: versionAtLeast(current, MIN_MERGE_TREE_VERSION),
      gitVersion: current,
    };
  };

  return {
    diffStat,
    log,
    changedFiles,
    baseAdvanced,
    conflictFiles,
    capabilities,
  };
}
