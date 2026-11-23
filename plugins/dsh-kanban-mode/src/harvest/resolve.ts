/**
 * 冲突续跑判定:检测「进行中的 rebase / merge」状态(存在性探测)。
 *
 * 设计依据 docs/harvest-design.md §5(幂等与状态机)/§6(步骤 6/8):
 * - apply 遇冲突时管线保留现场(rebase/merge 进行中),再次 apply 必须先
 *   判定现场存在与否再走续跑——本面即该判定;
 * - 探测对象是 git dir 下的进度标记(存在即进行中):
 *   - `rebase-merge`(默认 merge 后端变基)/`rebase-apply`(apply 后端变基
 *     或 `git am`)→ rebase 进行中;
 *   - `MERGE_HEAD` → merge 进行中;
 *   - rebase 标记优先于 merge 标记(变基过程中途做合并提交时两类标记可
 *     同时存在,续跑应跟随 rebase)。
 *
 * git dir 解析不自行拼 `.git`——经 `git rev-parse --git-dir` 读取,天然
 * worktree 感知(链接 worktree 的进度标记在其专属 gitdir
 * `<主仓>/.git/worktrees/<名>/` 之下)。
 *
 * 续跑/放弃命令构造为本面导出的纯函数:
 * - rebase 续跑 = `rebase --continue`(复用原提交信息,不开编辑器);
 * - merge 续跑 = `commit --no-edit`——`merge --continue` 语义上等价于
 *   `git commit`(会开编辑器,无人值守管线不可接受),取其无编辑器收尾形态
 *   (设计文档 §5「或对应收尾」口径);
 * - 放弃 = `rebase --abort` / `merge --abort`(干净回滚,零脏态)。
 *
 * @module dsh-kanban-mode/harvest/resolve
 */
import { stat } from 'node:fs/promises';
import path from 'node:path';

import { classifyGitFailure, GitRunnerError } from './git-runner.ts';
import type { GitRunner } from './git-runner.ts';

/** 进行中状态的类别。 */
export type InProgressKind = 'rebase' | 'merge' | 'none';

/** 一次进行中状态探测的结果。 */
export interface InProgressState {
  /** 是否有进行中的 rebase/merge。 */
  readonly inProgress: boolean;
  /** 状态类别(rebase 标记优先于 merge 标记)。 */
  readonly kind: InProgressKind;
  /** 该检出对应的 git dir 绝对路径(worktree 感知)。 */
  readonly gitDir: string;
  /** 实际探测到的标记名(相对 git dir):rebase-merge / rebase-apply / MERGE_HEAD。 */
  readonly markers: readonly string[];
}

/** 变基进度标记目录(merge 后端与 apply 后端两种形态都覆盖)。 */
const REBASE_MARKERS: readonly string[] = ['rebase-merge', 'rebase-apply'];

/** 合并进度标记文件。 */
const MERGE_MARKER = 'MERGE_HEAD';

/** 存在性探测(不区分文件/目录,git 结束状态时会把标记整体移除)。 */
async function markerExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测 cwd 所在检出的进行中 rebase/merge 状态。
 * cwd 不是可用检出(rev-parse 失败)时抛 GitRunnerError(错误类别经
 * classifyGitFailure 归类,与 git-runner 同一口径)。
 */
export async function detectInProgressState(
  runner: GitRunner,
  cwd: string,
): Promise<InProgressState> {
  const probe = await runner.capture(['rev-parse', '--git-dir'], { cwd });
  if (!probe.ok) {
    const kind = classifyGitFailure({
      exitCode: probe.exitCode,
      timedOut: probe.timedOut,
      stderr: probe.stderr,
    });
    throw new GitRunnerError(
      kind,
      `无法读取 git 目录(git rev-parse --git-dir 失败,cwd=${cwd}):${probe.stderr.trim().slice(0, 200)}`,
      {
        args: ['rev-parse', '--git-dir'],
        exitCode: probe.exitCode,
        stderr: probe.stderr,
      },
    );
  }
  const raw = probe.stdout.trim();
  const gitDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  const markers: string[] = [];
  for (const marker of REBASE_MARKERS) {
    if (await markerExists(path.join(gitDir, marker))) markers.push(marker);
  }
  if (await markerExists(path.join(gitDir, MERGE_MARKER)))
    markers.push(MERGE_MARKER);
  let kind: InProgressKind = 'none';
  if (markers.includes('rebase-merge') || markers.includes('rebase-apply')) {
    kind = 'rebase';
  } else if (markers.includes(MERGE_MARKER)) {
    kind = 'merge';
  }
  return { inProgress: kind !== 'none', kind, gitDir, markers };
}

/**
 * 续跑命令(rebase --continue / merge 的无编辑器收尾 commit --no-edit)。
 * 返回空数组 = 无可续跑状态。
 */
export function resumeActionFor(kind: InProgressKind): readonly string[] {
  switch (kind) {
    case 'rebase':
      return ['rebase', '--continue'];
    case 'merge':
      return ['commit', '--no-edit'];
    case 'none':
      return [];
  }
}

/** 放弃命令(rebase --abort / merge --abort,干净回滚)。空数组 = 无可放弃状态。 */
export function abortActionFor(kind: InProgressKind): readonly string[] {
  switch (kind) {
    case 'rebase':
      return ['rebase', '--abort'];
    case 'merge':
      return ['merge', '--abort'];
    case 'none':
      return [];
  }
}
