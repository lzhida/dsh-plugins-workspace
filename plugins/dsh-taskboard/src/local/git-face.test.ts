/**
 * git 面的回归测试（0.10.1 官方 worktree 服务改造后仍必须成立的三项行为契约）。
 *
 * 覆盖：① 任务分支命名；② 结算证据 collect（官方检出路径 + 基准提交）；
 * ③ 合并走 `merge --no-ff` 且主工作区脏时拒绝合并。
 *
 * git 面通过可注入的 exec 层驱动，本测试用脚本化 exec 覆盖各分支，不依赖真实
 * git 二进制。
 */

import { describe, expect, it } from 'vitest';
import {
  createGitFace,
  sanitizeBranchName,
  type ExecFn,
  type ExecResult,
} from '../host/git.ts';
import { buildBranchName } from '../shared/protocol.ts';

/** 脚本化 exec：按参数前缀返回预设结果，并记录调用。 */
function scriptedExec(
  handler: (args: string[]) => ExecResult | undefined,
  calls: string[][] = [],
): ExecFn {
  return async (args) => {
    calls.push(args);
    return handler(args) ?? { ok: true, stdout: '', stderr: '' };
  };
}

describe('dsh-taskboard 任务分支命名', () => {
  it('默认命名为 task/<标题>+<任务ID>', () => {
    expect(sanitizeBranchName('摸鱼', 't-1')).toBe('task/摸鱼+t-1');
  });

  it('标题含 git 非法字符时清洗后仍可用', () => {
    const branch = sanitizeBranchName('修复 a/b: 报错', 't-2');
    expect(branch).toBe('task/修复-ab-报错+t-2');
    // 标题段内不得再出现 git 非法字符；'task/' 前缀是官方服务允许的分隔符。
    const segment = branch.slice('task/'.length);
    expect(segment).not.toContain(':');
    expect(segment).not.toContain('/');
    expect(segment).not.toContain(' ');
  });

  it('命名结果符合官方 worktree 服务接受的分支形态（task/<段>+<任务ID>）', () => {
    const branch = sanitizeBranchName('摸鱼', 't-1');
    // 官方 create 的 name 需通过 git check-ref-format，且路径 = 池目录/分支名。
    expect(branch).toMatch(/^task\/[^\s:~^?*[\\]+t-1$/);
    expect(
      branch
        .split('/')
        .every((part) => part.length > 0 && part !== '.' && part !== '..'),
    ).toBe(true);
  });

  it('标题为空时退化为 task/<任务ID>', () => {
    expect(sanitizeBranchName('   ', 't-3')).toBe('task/t-3');
  });

  it('命名预设按看板设置切换', () => {
    expect(buildBranchName('摸鱼', 't-1', 'id')).toBe('task/t-1');
    expect(buildBranchName('摸鱼', 't-1', 'prefix-id', 'feat')).toBe(
      'feat/t-1',
    );
    expect(buildBranchName('摸鱼', 't-1', 'prefix-title-id', 'feat')).toBe(
      'feat/摸鱼+t-1',
    );
  });
});

describe('dsh-taskboard 结算证据采集', () => {
  it('采集提交、脏文件、diff 统计与变更文件数', async () => {
    const calls: string[][] = [];
    const git = createGitFace(
      scriptedExec((args) => {
        if (args[0] === 'rev-parse')
          return { ok: true, stdout: 'c'.repeat(40) + '\n', stderr: '' };
        if (args[0] === 'log')
          return {
            ok: true,
            stdout: 'aaa111 第一笔\nbbb222 第二笔\n',
            stderr: '',
          };
        if (args[0] === 'status')
          return { ok: true, stdout: ' M src/a.ts\n?? src/b.ts\n', stderr: '' };
        if (args[0] === 'diff' && args[1] === '--shortstat') {
          return {
            ok: true,
            stdout: ' 2 files changed, 10 insertions(+)\n',
            stderr: '',
          };
        }
        if (args[0] === 'diff' && args[1] === '--name-only')
          return { ok: true, stdout: 'src/a.ts\nsrc/b.ts\n', stderr: '' };
        return undefined;
      }, calls),
    );

    const facts = await git.collect(
      'C:\\repo\\.agents\\worktrees\\task\\demo+t-1',
      'a'.repeat(40),
    );

    expect(facts.headCommit).toBe('c'.repeat(40));
    expect(facts.commits).toEqual([
      { hash: 'aaa111', subject: '第一笔' },
      { hash: 'bbb222', subject: '第二笔' },
    ]);
    expect(facts.commitsTotal).toBe(2);
    expect(facts.dirtyFiles).toEqual(['M src/a.ts', '?? src/b.ts']);
    expect(facts.dirtyFilesTotal).toBe(2);
    expect(facts.diffStat).toBe('2 files changed, 10 insertions(+)');
    expect(facts.changedFiles).toBe(2);
    // 基准提交作为 range 的左端，官方检出的 HEAD 作为右端。
    expect(
      calls.some(
        (call) =>
          call[0] === 'log' &&
          call[1] === `--pretty=format:%h %s` &&
          call[2] === `${'a'.repeat(40)}..HEAD`,
      ),
    ).toBe(true);
  });

  it('按 excludeRelPaths 过滤嵌套仓遗留路径（遗留多仓记录的兼容口径）', async () => {
    const git = createGitFace(
      scriptedExec((args) => {
        if (args[0] === 'status')
          return {
            ok: true,
            stdout: '?? sub-repo/\n?? src/b.ts\n',
            stderr: '',
          };
        return undefined;
      }),
    );

    const facts = await git.collect(
      'C:\\repo\\.agents\\worktrees\\task\\demo+t-1',
      'a'.repeat(40),
      ['sub-repo'],
    );

    expect(facts.dirtyFiles).toEqual(['?? src/b.ts']);
  });
});

describe('dsh-taskboard 分支合并', () => {
  it('走 merge --no-ff 且主工作区干净时成功', async () => {
    const calls: string[][] = [];
    const git = createGitFace(
      scriptedExec((args) => {
        if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
        return undefined;
      }, calls),
    );

    await git.merge('C:\\repo', 'task/demo+t-1');

    expect(
      calls.some(
        (call) =>
          call[0] === 'merge' &&
          call[1] === '--no-ff' &&
          call[3] === 'task/demo+t-1',
      ),
    ).toBe(true);
  });

  it('主工作区有未提交修改时拒绝合并', async () => {
    const git = createGitFace(
      scriptedExec((args) => {
        if (args[0] === 'status')
          return { ok: true, stdout: ' M src/a.ts\n', stderr: '' };
        return undefined;
      }),
    );

    await expect(git.merge('C:\\repo', 'task/demo+t-1')).rejects.toMatchObject({
      code: 'dirty-tree',
    });
  });

  it('官方 worktree 池的未跟踪条目不阻塞合并', async () => {
    const calls: string[][] = [];
    const git = createGitFace(
      scriptedExec((args) => {
        if (args[0] === 'status')
          return { ok: true, stdout: '?? .agents/\n', stderr: '' };
        return undefined;
      }, calls),
    );

    await git.merge('C:\\repo', 'task/demo+t-1');

    expect(calls.some((call) => call[0] === 'merge')).toBe(true);
  });

  it('合并失败时回滚并抛出可读原因', async () => {
    const calls: string[][] = [];
    const git = createGitFace(
      scriptedExec((args) => {
        if (args[0] === 'status') return { ok: true, stdout: '', stderr: '' };
        if (args[0] === 'merge' && args[1] === '--no-ff')
          return { ok: false, stdout: '', stderr: 'CONFLICT (content)' };
        return undefined;
      }, calls),
    );

    await expect(git.merge('C:\\repo', 'task/demo+t-1')).rejects.toThrow(
      '合并失败：CONFLICT (content)',
    );
    expect(
      calls.some((call) => call[0] === 'merge' && call[1] === '--abort'),
    ).toBe(true);
  });
});
