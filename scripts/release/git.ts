/**
 * git 子进程薄封装:所有 git 交互集中在此,
 * 失败统一抛带错误码的 ReleaseError(NOT_A_GIT_REPO / GIT_FAILURE)。
 */
import { spawnSync } from 'node:child_process';
import { ReleaseError } from './core.ts';

/** 同步执行一条 git 命令,成功返回去首尾空白的 stdout。 */
function runGit(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error !== undefined) {
    throw new ReleaseError(
      'GIT_FAILURE',
      `无法执行 git(${result.error.message});请确认 git 已安装并在 PATH 中`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      throw new ReleaseError('NOT_A_GIT_REPO', `${cwd} 不在 git 仓库内`);
    }
    throw new ReleaseError(
      'GIT_FAILURE',
      `git ${args.join(' ')} 失败(exit ${String(result.status)}): ${stderr}`,
    );
  }
  return (result.stdout ?? '').trim();
}

/** 从 startDir 向上定位 git 仓库根目录;不在仓库内时抛 NOT_A_GIT_REPO。 */
export function findRepoRoot(startDir: string): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: startDir,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new ReleaseError(
      'GIT_FAILURE',
      `无法执行 git(${result.error.message});请确认 git 已安装并在 PATH 中`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    if (/not a git repository/i.test(stderr)) {
      throw new ReleaseError('NOT_A_GIT_REPO', `${startDir} 不在 git 仓库内`);
    }
    throw new ReleaseError(
      'GIT_FAILURE',
      `定位仓库根失败(exit ${String(result.status)}): ${stderr}`,
    );
  }
  return (result.stdout ?? '').trim();
}

/** 工作树是否干净(git status --porcelain 为空)。 */
export function worktreeIsClean(rootDir: string): boolean {
  return runGit(['status', '--porcelain'], rootDir) === '';
}

/** refs/tags/{tag} 是否已存在(静默探测,不抛错)。 */
export function tagExists(rootDir: string, tag: string): boolean {
  const result = spawnSync(
    'git',
    ['rev-parse', '-q', '--verify', `refs/tags/${tag}`],
    { cwd: rootDir, encoding: 'utf8' },
  );
  return result.status === 0;
}

/** 当前所在分支名(游离 HEAD 时返回 'HEAD')。 */
export function currentBranch(rootDir: string): string {
  return runGit(['rev-parse', '--abbrev-ref', 'HEAD'], rootDir);
}

/** 创建 annotated tag(指向当前 HEAD)。 */
export function createAnnotatedTag(
  rootDir: string,
  tag: string,
  message: string,
): void {
  runGit(['tag', '-a', tag, '-m', message], rootDir);
}

/** 发布线分支:main(仓库分支模型中的发布线,dev 为集线)。 */
export const RELEASE_LINE_BRANCH = 'main';

/** refs/{ref} 是否存在(静默探测,不抛错)。 */
function refExists(rootDir: string, ref: string): boolean {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', ref], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return result.status === 0;
}

/**
 * 解析发布线 ref:本地 main 优先,回退 origin/main——CI 按 tag 检出是
 * detached HEAD(fetch-depth: 0 下只有远端跟踪 ref),本地仓库则两个都在。
 * 两者皆无时抛 RELEASE_LINE_NOT_FOUND:发布线缺失即环境不满足发布前提。
 */
export function releaseLineRef(rootDir: string): string {
  if (refExists(rootDir, `refs/heads/${RELEASE_LINE_BRANCH}`)) {
    return RELEASE_LINE_BRANCH;
  }
  if (refExists(rootDir, `refs/remotes/origin/${RELEASE_LINE_BRANCH}`)) {
    return `origin/${RELEASE_LINE_BRANCH}`;
  }
  throw new ReleaseError(
    'RELEASE_LINE_NOT_FOUND',
    `找不到发布线分支:本地与 origin 均无 ${RELEASE_LINE_BRANCH};发布线缺失,无法校验 tag 是否已进入发布线`,
  );
}

/**
 * rev 是否可从 base 到达(git merge-base --is-ancestor:相等或为其祖先均算)。
 * git 用退出码表达判定(0=是,1=否),其余退出码视为 git 失败抛 GIT_FAILURE。
 * rev/base 由调用方保证存在(如先过 tagExists / releaseLineRef)。
 */
export function commitReachableFrom(
  rootDir: string,
  rev: string,
  base: string,
): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', rev, base], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new ReleaseError(
      'GIT_FAILURE',
      `无法执行 git(${result.error.message});请确认 git 已安装并在 PATH 中`,
    );
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const stderr = (result.stderr ?? '').trim();
  throw new ReleaseError(
    'GIT_FAILURE',
    `git merge-base --is-ancestor ${rev} ${base} 失败(exit ${String(result.status)}): ${stderr}`,
  );
}
