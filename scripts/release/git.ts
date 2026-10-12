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
