import { describe, expect, it } from 'vitest';
import {
  createOpenInZedTool,
  type OpenInZedFail,
  type OpenInZedResult,
} from './tools.ts';
import type { WorkspaceRegistryFace, WorkspaceRow } from './routes.ts';

/** Narrow a tool result to the failure shape or fail the test. */
function expectFail(result: OpenInZedResult): asserts result is OpenInZedFail {
  if (result.opened !== false) {
    throw new Error(`expected failure, got success: ${JSON.stringify(result)}`);
  }
}

const ROWS: WorkspaceRow[] = [
  { id: 'ws-1', path: 'C:\\work\\alpha', title: 'alpha' },
];

function registry(): WorkspaceRegistryFace {
  return {
    get: (id) => ROWS.find((row) => row.id === id),
    list: () => [...ROWS],
    resolveByPath: async (path) => ROWS.find((row) => row.path === path),
  };
}

/** The open tool's argument shape (mirrors the tool parameters). */
interface OpenArgs {
  workspaceId?: string;
  path?: string;
  newWindow?: boolean;
}

/** Extract the typed result out of the tool's execute via a scripted run. */
async function run(
  args: OpenArgs,
  spawn?: (file: string, args: readonly string[]) => Promise<unknown>,
): Promise<OpenInZedResult> {
  const tool = createOpenInZedTool({
    registry: registry(),
    runner: async (file, runnerArgs) => {
      if (spawn === undefined) return { stdout: '', stderr: '' };
      return (await spawn(file, runnerArgs)) as {
        stdout: string;
        stderr: string;
      };
    },
  });
  // The defined tool exposes execute on itself.
  const execute = (
    tool as unknown as {
      execute: (args: OpenArgs) => Promise<OpenInZedResult>;
    }
  ).execute;
  return execute.call(tool, args);
}

describe('dsh-open-in-zed host/tools', () => {
  it('成功打开并回传结构化结果', async () => {
    const seen: Array<readonly string[]> = [];
    const result = await run(
      { workspaceId: 'ws-1', newWindow: true },
      (_file, args) => {
        seen.push(args);
        return Promise.resolve({ stdout: '', stderr: '' });
      },
    );
    expect(seen).toEqual([['--new', 'C:\\work\\alpha']]);
    expect(result).toEqual({
      opened: true,
      path: 'C:\\work\\alpha',
      command: ['zed', '--new', 'C:\\work\\alpha'],
      workspace: { id: 'ws-1', title: 'alpha' },
    });
  });

  it('未知 id 失败并附带可用工作区清单', async () => {
    const result = await run({ workspaceId: 'ghost' });
    expectFail(result);
    expect(result.code).toBe('not_found');
    expect(result.workspaces).toEqual([
      { id: 'ws-1', title: 'alpha', path: 'C:\\work\\alpha' },
    ]);
  });

  it('未注册路径 → forbidden（拒绝任意目录）', async () => {
    const result = await run({ path: 'C:\\Windows' });
    expectFail(result);
    expect(result.code).toBe('forbidden');
  });

  it('zed 缺失 → zed-not-found 且消息带环境变量指引', async () => {
    const result = await run({ workspaceId: 'ws-1' }, () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expectFail(result);
    expect(result.code).toBe('zed-not-found');
    expect(result.message).toContain('DSH_OPEN_IN_ZED_BIN');
  });
});
