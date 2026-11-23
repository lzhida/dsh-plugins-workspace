/**
 * 官方 worktree 服务软依赖适配层的契约测试。
 *
 * 覆盖：官方服务的软读取（形状不匹配即视为缺席）、失败原因分类、降级文案，
 * 以及 host/isolation.ts 的隔离准备链路——尤其是**服务缺席时的降级路径**
 * （任务按 isolation:none 继续执行，绝不报错阻塞）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  OFFICIAL_SERVICE_UNAVAILABLE_NOTE,
  classifyOfficialFailure,
  officialDegradeNote,
  readWorkingDirectory,
  readWorktreeService,
  type OfficialCreatedWorktree,
  type OfficialWorktreeService,
} from './official-worktree.ts';
import { prepareOfficialIsolation } from '../host/isolation.ts';

/** 官方 create 的成功返回值（形状同 CreatedWorktree）。 */
const created: OfficialCreatedWorktree = {
  path: 'C:\\repo\\.agents\\worktrees\\task\\demo+t-1',
  branch: 'task/demo+t-1',
  baseCommit: 'a'.repeat(40),
  repositoryRoot: 'C:\\repo',
};

describe('dsh-taskboard 官方 worktree 服务适配层', () => {
  it('软读取官方服务：形状不匹配或读取抛错都视为缺席', () => {
    expect(readWorktreeService(undefined)).toBeUndefined();
    expect(readWorktreeService({})).toBeUndefined();
    expect(readWorktreeService({ get: () => undefined })).toBeUndefined();
    expect(readWorktreeService({ get: () => ({}) })).toBeUndefined();
    expect(
      readWorktreeService({
        get: () => {
          throw new Error('boom');
        },
      }),
    ).toBeUndefined();

    const service: OfficialWorktreeService = { create: async () => created };
    expect(readWorktreeService({ get: () => service })).toBe(service);
  });

  it('软读取宿主 workingDirectory 服务：形状不匹配即视为缺席', () => {
    expect(readWorkingDirectory(undefined)).toBeUndefined();
    expect(readWorkingDirectory({ get: () => ({}) })).toBeUndefined();

    const service = { set: async () => undefined };
    expect(readWorkingDirectory({ get: () => service })).toBe(service);
  });

  it('按官方错误文本分类失败原因', () => {
    expect(
      classifyOfficialFailure(
        new Error('worktree branch already exists: task/x'),
      ),
    ).toBe('branch-exists');
    expect(
      classifyOfficialFailure(
        new Error('worktree path already exists: C:\\repo\\x'),
      ),
    ).toBe('path-exists');
    expect(
      classifyOfficialFailure(new Error('fatal: not a git repository')),
    ).toBe('not-a-repo');
    expect(
      classifyOfficialFailure(new Error('EPERM: operation not permitted')),
    ).toBe('sandbox-denied');
    expect(classifyOfficialFailure(new Error('read-only sandbox'))).toBe(
      'sandbox-denied',
    );
    expect(classifyOfficialFailure(new Error('boom'))).toBe('unknown');
  });

  it('降级文案都以「已在原目录执行」收尾，并点名官方 bundle', () => {
    for (const kind of [
      'branch-exists',
      'path-exists',
      'sandbox-denied',
      'not-a-repo',
      'unknown',
    ] as const) {
      expect(officialDegradeNote(kind, '细节')).toContain('已在原目录执行');
    }
    expect(officialDegradeNote('sandbox-denied', '细节')).toContain(
      'workspace-write',
    );
    expect(OFFICIAL_SERVICE_UNAVAILABLE_NOTE).toContain(
      '@deepseek-ai/dsh-experimental-forge-bundle',
    );
  });
});

describe('dsh-taskboard 隔离准备（官方服务）', () => {
  it('官方服务缺席时降级为在原目录执行，不抛错阻塞', async () => {
    const outcome = await prepareOfficialIsolation(
      { scope: { get: () => undefined } },
      {
        agent: {},
        branch: 'task/demo+t-1',
      },
    );

    expect(outcome.isolation).toBeUndefined();
    expect(outcome.note).toBe(OFFICIAL_SERVICE_UNAVAILABLE_NOTE);
  });

  it('官方服务可用时用分支名与基准提交建立检出', async () => {
    const create = vi.fn(
      async (_agent: object, request?: { name?: string; from?: string }) => {
        void request;
        return created;
      },
    );
    const outcome = await prepareOfficialIsolation(
      { worktrees: { create }, git: undefined },
      { agent: { id: 'agent-1' }, branch: 'task/demo+t-1', from: 'HEAD' },
    );

    expect(outcome.note).toBeUndefined();
    expect(outcome.isolation).toEqual({
      path: created.path,
      branch: created.branch,
      baseCommit: created.baseCommit,
    });
    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[1];
    expect(request).toEqual({ name: 'task/demo+t-1', from: 'HEAD' });
  });

  it('官方 create 失败时给出可读降级说明，不抛出异常', async () => {
    const outcome = await prepareOfficialIsolation(
      {
        worktrees: {
          create: async () => {
            throw new Error('worktree branch already exists: task/demo+t-1');
          },
        },
      },
      { agent: {}, branch: 'task/demo+t-1' },
    );

    expect(outcome.isolation).toBeUndefined();
    expect(outcome.note).toContain('分支已被占用');
    expect(outcome.note).toContain('已在原目录执行');
  });

  it('上次的检出仍存活时续用它（不再新建检出）', async () => {
    const create = vi.fn(async () => created);
    const set = vi.fn(async () => undefined);
    const git = { headOf: async () => 'b'.repeat(40) };

    const outcome = await prepareOfficialIsolation(
      { worktrees: { create }, workingDirectory: { set }, git },
      {
        agent: { id: 'agent-1' },
        branch: 'task/demo+t-1',
        previous: {
          path: 'C:\\repo\\.agents\\worktrees\\task\\demo+t-1',
          branch: 'task/demo+t-1',
        },
      },
    );

    expect(create).not.toHaveBeenCalled();
    expect(set).toHaveBeenCalledTimes(1);
    expect(outcome.isolation?.reused).toBe(true);
    expect(outcome.isolation?.baseCommit).toBe('b'.repeat(40));
  });

  it('上次的检出已被删除时退回官方新建检出', async () => {
    const create = vi.fn(async () => created);
    const git = { headOf: async () => undefined };

    const outcome = await prepareOfficialIsolation(
      {
        worktrees: { create },
        workingDirectory: { set: async () => undefined },
        git,
      },
      {
        agent: {},
        branch: 'task/demo+t-1',
        previous: {
          path: 'C:\\repo\\.agents\\worktrees\\task\\demo+t-1',
          branch: 'task/demo+t-1',
        },
      },
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(outcome.isolation?.reused).toBeUndefined();
  });

  it('有既有检出但宿主 workingDirectory 服务缺席时拒绝假装隔离', async () => {
    const outcome = await prepareOfficialIsolation(
      {
        worktrees: { create: async () => created },
        git: { headOf: async () => 'c'.repeat(40) },
      },
      {
        agent: {},
        branch: 'task/demo+t-1',
        previous: {
          path: 'C:\\repo\\.agents\\worktrees\\task\\demo+t-1',
          branch: 'task/demo+t-1',
        },
      },
    );

    expect(outcome.isolation).toBeUndefined();
    expect(outcome.note).toContain('无法续用该检出');
  });
});
