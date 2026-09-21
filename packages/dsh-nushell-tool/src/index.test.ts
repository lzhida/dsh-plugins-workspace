import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ChildProcess, ExecFileException } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apply,
  buildNuArgs,
  DEFAULT_TIMEOUT_MS,
  inject,
  MAX_TIMEOUT_MS,
  name,
  renderNushellResult,
  resolveTimeoutMs,
  runNushell,
} from './index.ts';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

interface AppliedTool {
  name: string;
  description: string;
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

interface StubState {
  registered: AppliedTool[];
  disposers: Array<ReturnType<typeof vi.fn>>;
  cleanups: Array<() => void>;
  tool: AppliedTool;
}

function stubCtx(): StubState {
  const registered: AppliedTool[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const cleanups: Array<() => void> = [];
  const ctx = {
    tools: {
      register: vi.fn((definition: AppliedTool) => {
        registered.push(definition);
        const dispose = vi.fn();
        disposers.push(dispose);
        return dispose as () => void;
      }),
    },
    effect: vi.fn((fn: () => () => void) => {
      const cleanup = fn();
      cleanups.push(cleanup);
      return cleanup;
    }),
  } as unknown as Context;
  apply(ctx);
  return { registered, disposers, cleanups, tool: registered[0]! };
}

function fakeExec(): { exec: ToolRunContext; signal: AbortSignal } {
  const signal = new AbortController().signal;
  return { exec: { signal } as ToolRunContext, signal };
}

interface FakeChild {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeChild(overrides: Partial<FakeChild> = {}): FakeChild {
  return { kill: vi.fn(), exitCode: null, signalCode: null, ...overrides };
}

/** 捕获 execFileMock 的回调句柄;`callback` getter 在回调就绪前抛错(供 waitFor 重试)。 */
function spawnCapture(
  child: ChildProcess = fakeChild() as unknown as ChildProcess,
): {
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void;
} {
  let captured:
    | ((
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void)
    | null = null;
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      queueMicrotask(() => {
        captured = callback;
      });
      return child;
    },
  );
  return {
    get callback(): (
      error: ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void {
      if (captured === null) {
        throw new Error('spawn 回调尚未就绪');
      }
      return captured;
    },
  };
}

describe('dsh-nushell-tool 契约', () => {
  it('导出 loader 依赖的插件符号', () => {
    expect(name).toBe('dsh-nushell-tool');
    expect(inject).toEqual(['tools']);
  });

  it('apply 注册唯一 nushell 工具并输出加载日志', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = stubCtx();
    expect(log).toHaveBeenCalledWith(`[${name}] plugin loaded`);
    expect(state.registered).toHaveLength(1);
    expect(state.tool.name).toBe('nushell');
    expect(state.tool.timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(state.tool.isConcurrencySafe?.({ command: 'ls' })).toBe(true);
  });

  it('工具经 effect 登记清理:注销工具并击杀存活子进程', async () => {
    const child = fakeChild();
    spawnCapture(child as unknown as ChildProcess);
    const state = stubCtx();
    const { exec } = fakeExec();
    void state.tool.execute({ command: 'sleep 5sec' }, exec);
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    expect(state.cleanups).toHaveLength(1);
    state.cleanups[0]!();
    expect(child.kill).toHaveBeenCalled();
    expect(state.disposers[0]).toHaveBeenCalled();
  });

  it('调用方取消时拒绝并说明中止原因', async () => {
    const capture = spawnCapture();
    const state = stubCtx();
    const controller = new AbortController();
    const pending = state.tool.execute({ command: 'sleep 5sec' }, {
      signal: controller.signal,
    } as ToolRunContext);
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    controller.abort();
    capture.callback(
      { killed: true, name: 'AbortError' } as ExecFileException,
      '',
      '',
    );
    await expect(pending).rejects.toThrow('取消');
  });

  it('runNushell 把子进程登记进 children,结束后移除', async () => {
    const child = fakeChild();
    const capture = spawnCapture(child as unknown as ChildProcess);
    const children = new Set<ChildProcess>();
    const controller = new AbortController();
    const pending = runNushell(
      { command: 'echo x' },
      { signal: controller.signal },
      children,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    expect(children.has(child as unknown as ChildProcess)).toBe(true);
    capture.callback(null, 'x', '');
    await pending;
    expect(children.size).toBe(0);
  });
});

describe('nu 调用参数', () => {
  it('以 --no-config-file -c 执行并透传 cwd/timeout', async () => {
    const capture = spawnCapture(
      fakeChild({ exitCode: 0 }) as unknown as ChildProcess,
    );
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute(
      { command: 'ls | length', cwd: 'E:/tmp', timeoutMs: 5000 },
      exec,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    expect(execFileMock).toHaveBeenCalledWith(
      'nu',
      ['--no-config-file', '-c', 'ls | length'],
      expect.objectContaining({
        cwd: 'E:/tmp',
        timeout: 5000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
    capture.callback(null, '3\n', '');
    await expect(pending).resolves.toContain('exit code: 0');
  });

  it('缺省 cwd/timeoutMs 时使用进程 cwd 与默认超时', async () => {
    const capture = spawnCapture(
      fakeChild({ exitCode: 0 }) as unknown as ChildProcess,
    );
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute({ command: 'echo hello' }, exec);
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    const options = execFileMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(options['cwd']).toBeUndefined();
    expect(options['timeout']).toBe(DEFAULT_TIMEOUT_MS);
    capture.callback(null, 'hello', '');
    await pending;
  });
});

describe('nu 执行结果', () => {
  it('非零退出正常返回并携带 stderr', async () => {
    const capture = spawnCapture(
      fakeChild({ exitCode: 2, signalCode: null }) as unknown as ChildProcess,
    );
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute({ command: 'exit 2' }, exec);
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback(null, '', 'some error');
    const text = (await pending) as string;
    expect(text).toContain('exit code: 2');
    expect(text).toContain('some error');
  });

  it('超时被杀的进程在状态行标记 timedOut', async () => {
    const capture = spawnCapture(
      fakeChild({
        exitCode: null,
        signalCode: 'SIGTERM',
      }) as unknown as ChildProcess,
    );
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute({ command: 'sleep 10sec' }, exec);
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback(
      { killed: true, signal: 'SIGTERM' } as ExecFileException,
      '',
      '',
    );
    const text = (await pending) as string;
    expect(text).toContain('超时');
    expect(text).toContain('SIGTERM');
  });

  it('nu 缺失(ENOENT)时拒绝并给出安装指引', async () => {
    const capture = spawnCapture();
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute({ command: 'echo x' }, exec);
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback({ code: 'ENOENT' } as ExecFileException, '', '');
    await expect(pending).rejects.toThrow(/PATH/);
  });
});

describe('runNushell 纯函数', () => {
  it('buildNuArgs 固定 --no-config-file -c', () => {
    expect(buildNuArgs('open a.csv | first')).toEqual([
      '--no-config-file',
      '-c',
      'open a.csv | first',
    ]);
  });

  it('resolveTimeoutMs 钳制边界值', () => {
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(0)).toBe(1);
    expect(resolveTimeoutMs(-5)).toBe(1);
    expect(resolveTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMEOUT_MS);
  });

  it('渲染截断超长 stdout 并标注原始长度', () => {
    const text = renderNushellResult({
      command: 'x',
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'a'.repeat(25_000),
      stderr: '',
    });
    expect(text).toContain('输出已截断');
    expect(text).toContain('25 000'.replace(/ /g, '')); // 25000
  });
});
