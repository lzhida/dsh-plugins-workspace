import type { ChildProcess, ExecFileException } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import {
  apply,
  buildNuArgs,
  canonicalNushellResult,
  DEFAULT_TIMEOUT_MS,
  inject,
  MAX_TIMEOUT_MS,
  name,
  nushellJobOutcome,
  renderNushellResult,
  resolveTimeoutMs,
  resolveWorkdir,
  runNushell,
  validateNushellArgs,
  type Config,
  type NushellForegroundOutput,
  type NushellToolOutput,
} from './index.ts';

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

interface AppliedTool {
  name: string;
  description: string;
  timeoutMs?: number;
  isConcurrencySafe?(args: unknown): boolean;
  execute(
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<unknown>;
  presentCall?(args: Record<string, unknown>): unknown;
  presentResult?(args: Record<string, unknown>, result: unknown): unknown;
}

interface StubJobs {
  start(spec: Record<string, unknown>): string;
}

interface StubState {
  registered: AppliedTool[];
  disposers: Array<ReturnType<typeof vi.fn>>;
  cleanups: Array<() => void>;
  tool: AppliedTool;
  sections: Array<{ name: string; order: number; text: string }>;
  collectCalls: unknown[];
}

interface StubOptions {
  jobs?: StubJobs;
  dshEnv?: Record<string, string>;
  config?: Config;
}

function stubCtx(options: StubOptions = {}): StubState {
  const registered: AppliedTool[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const cleanups: Array<() => void> = [];
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const collectCalls: unknown[] = [];
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
    systemPrompt: {
      section: vi.fn(
        (section: { name: string; order: number; text: string }) => {
          sections.push(section);
        },
      ),
    },
    shellEnv: {
      collect: vi.fn((exec: unknown) => {
        collectCalls.push(exec);
        return options.dshEnv ?? {};
      }),
    },
    get: vi.fn((key: string) => (key === 'jobs' ? options.jobs : undefined)),
  } as unknown as Context;
  apply(ctx, options.config);
  return {
    registered,
    disposers,
    cleanups,
    tool: registered[0]!,
    sections,
    collectCalls,
  };
}

function fakeExec(agent?: unknown): {
  exec: ToolRunContext;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  return {
    exec: { signal: controller.signal, agent } as unknown as ToolRunContext,
    signal: controller.signal,
  };
}

/** 前台 execFile 的回调句柄捕获(供 waitFor 重试)。 */
function spawnCapture(
  child: ChildProcess = fakeChild() as unknown as ChildProcess,
): {
  callback: (
    error: ExecFileException | null,
    stdout: string,
    stderr: string,
  ) => void;
  options: () => Record<string, unknown>;
} {
  let captured:
    | ((
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void)
    | null = null;
  let lastOptions: Record<string, unknown> = {};
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      options: Record<string, unknown>,
      callback: (
        error: ExecFileException | null,
        stdout: string,
        stderr: string,
      ) => void,
    ) => {
      lastOptions = options;
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
    options: () => lastOptions,
  };
}

interface FakeChild {
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

function fakeChild(
  overrides: Partial<FakeChild> = {},
): ChildProcess & FakeChild {
  return {
    kill: vi.fn(),
    exitCode: null,
    signalCode: null,
    ...overrides,
  } as unknown as ChildProcess & FakeChild;
}

/** 后台 spawn 的流式子进程:真实 EventEmitter,close/error 手动触发。 */
function fakeStreamChild(): Omit<ChildProcess, 'kill' | 'stdout' | 'stderr'> & {
  kill: ReturnType<typeof vi.fn>;
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
} {
  const child = new EventEmitter() as unknown as Omit<
    ChildProcess,
    'kill' | 'stdout' | 'stderr'
  > & {
    kill: ReturnType<typeof vi.fn>;
    stdout: EventEmitter;
    stderr: EventEmitter;
    emitClose: (code: number | null, signal: NodeJS.Signals | null) => void;
  };
  const makeStream = (): EventEmitter & {
    setEncoding: ReturnType<typeof vi.fn>;
  } => {
    const stream = new EventEmitter() as EventEmitter & {
      setEncoding: ReturnType<typeof vi.fn>;
    };
    stream.setEncoding = vi.fn();
    return stream;
  };
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.kill = vi.fn();
  child.emitClose = (code, signal) => {
    child.emit('close', code, signal);
  };
  return child;
}

describe('dsh-nushell-tool 契约', () => {
  it('导出 loader 依赖的插件符号', () => {
    expect(name).toBe('dsh-nushell-tool');
    expect(inject).toEqual(['tools', 'systemPrompt', 'shellEnv']);
  });

  it('apply 注册唯一 nushell 工具、加载日志与系统提示 section', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const state = stubCtx();
    expect(log).toHaveBeenCalledWith(`[${name}] plugin loaded`);
    expect(state.registered).toHaveLength(1);
    expect(state.tool.name).toBe('nushell');
    expect(state.tool.timeoutMs).toBe(MAX_TIMEOUT_MS);
    expect(
      state.tool.isConcurrencySafe?.({ command: 'ls', description: '列目录' }),
    ).toBe(true);
    expect(state.sections).toHaveLength(1);
    expect(state.sections[0]!.name).toBe('tool:nushell');
    expect(state.sections[0]!.order).toBe(1015);
    expect(state.sections[0]!.text).toContain('[exit code: N]');
  });

  it('工具经 effect 登记清理:注销工具并击杀存活子进程', async () => {
    const child = fakeChild();
    spawnCapture(child as unknown as ChildProcess);
    const state = stubCtx();
    const { exec } = fakeExec();
    void state.tool.execute(
      { command: 'sleep 5sec', description: '等待五秒' },
      exec,
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    expect(state.cleanups).toHaveLength(1);
    state.cleanups[0]!();
    expect(child.kill).toHaveBeenCalled();
    expect(state.disposers[0]).toHaveBeenCalled();
  });

  it('调用方取消时以 AbortError 中止(HarnessError/TOOL_ABORTED 语义)', async () => {
    const capture = spawnCapture();
    const state = stubCtx();
    const controller = new AbortController();
    const pending = state.tool.execute(
      { command: 'sleep 5sec', description: '等待五秒' },
      { signal: controller.signal } as ToolRunContext,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    controller.abort();
    capture.callback(
      { killed: true, name: 'AbortError' } as ExecFileException,
      '',
      '',
    );
    await expect(pending).rejects.toMatchObject({
      message: 'tool call aborted',
      code: 'ABORTED',
      name: 'AbortError',
    });
  });
});

describe('参数与纯函数', () => {
  it('buildNuArgs 固定 --no-config-file -c 形态', () => {
    expect(buildNuArgs('ls | length')).toEqual([
      '--no-config-file',
      '-c',
      'ls | length',
    ]);
  });

  it('resolveTimeoutMs 覆盖默认/负值/上限/截断', () => {
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(Number.NaN)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(0)).toBe(1);
    expect(resolveTimeoutMs(1_500.9)).toBe(1_500);
    expect(resolveTimeoutMs(MAX_TIMEOUT_MS + 1)).toBe(MAX_TIMEOUT_MS);
  });

  it('validateNushellArgs 拒绝空 command/空 description/非正 timeoutMs', () => {
    expect(() =>
      validateNushellArgs({ command: '   ', description: 'ok' }),
    ).toThrow('invalid command: expected a non-empty string');
    expect(() =>
      validateNushellArgs({ command: 'ls', description: '  ' }),
    ).toThrow('invalid description: expected a non-empty string');
    expect(() =>
      validateNushellArgs({ command: 'ls', description: 'ok', timeoutMs: -1 }),
    ).toThrow('invalid timeoutMs: expected a positive number, got -1');
    expect(() =>
      validateNushellArgs({ command: 'ls', description: 'ok' }),
    ).not.toThrow();
  });

  it('resolveWorkdir 对齐官方语义:相对基于会话 cwd,缺省回退会话 cwd', () => {
    const agent = { session: { header: { cwd: 'F:/session' } } };
    const exec = { agent } as unknown as ToolRunContext;
    const bare = { agent: undefined } as unknown as ToolRunContext;
    expect(resolveWorkdir(undefined, exec)).toBe('F:/session');
    expect(resolveWorkdir(undefined, bare)).toBeUndefined();
    expect(resolveWorkdir('sub/dir', exec)).toBe(
      path.resolve('F:/session', 'sub/dir'),
    );
    expect(resolveWorkdir('F:/abs', exec)).toBe('F:/abs');
    expect(resolveWorkdir('F:/abs', bare)).toBe('F:/abs');
  });
});

describe('前台执行', () => {
  it('execFile 收到 nu 参数、workdir、超时预算与 DSH_* 合并环境', async () => {
    const capture = spawnCapture();
    const state = stubCtx({ dshEnv: { DSH_SESSION_ID: 's1' } });
    const { exec } = fakeExec();
    const pending = state.tool.execute(
      {
        command: 'ls',
        description: '列目录',
        timeoutMs: 1_000,
        workdir: 'F:/work',
      },
      exec,
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    const options = capture.options();
    expect(options).toMatchObject({
      cwd: 'F:/work',
      timeout: 1_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
    expect(options.env).toMatchObject({ DSH_SESSION_ID: 's1' });
    capture.callback(null, 'out', '');
    const value = (await pending) as NushellForegroundOutput;
    expect(value).toMatchObject({
      kind: 'foreground',
      exitCode: null,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1_000,
      stdout: { text: 'out', truncated: false },
    });
    expect(state.collectCalls).toHaveLength(1);
    expect(state.collectCalls[0]).toBe(exec);
  });

  it('nu 缺失(ENOENT)时拒绝并给安装指引', async () => {
    const capture = spawnCapture();
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute(
      { command: 'ls', description: '列目录' },
      exec,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback(
      { code: 'ENOENT', name: 'Error' } as ExecFileException,
      '',
      '',
    );
    await expect(pending).rejects.toThrow('nu executable not found');
  });

  it('无法启动的基础设施失败作为 isError 结果拒绝', async () => {
    const capture = spawnCapture(
      fakeChild({ exitCode: null, signalCode: null }),
    );
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute(
      { command: 'ls', description: '列目录' },
      exec,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback(
      {
        killed: false,
        message: 'spawn EACCES',
        name: 'Error',
      } as ExecFileException,
      '',
      '',
    );
    await expect(pending).rejects.toThrow('failed to start nu: spawn EACCES');
  });

  it('非零退出与信号终止属正常结果:canonical 记录并渲染 marker', async () => {
    const capture = spawnCapture(fakeChild({ exitCode: 2, signalCode: null }));
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute(
      { command: 'ls', description: '列目录' },
      exec,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback(null, '', 'oops');
    const value = (await pending) as NushellForegroundOutput;
    expect(value.exitCode).toBe(2);
    expect(renderNushellResult(value)).toBe('[stderr]\noops\n[exit code: 2]');
  });

  it('超时被终止时渲染 [timed out after Nms] marker', async () => {
    const capture = spawnCapture(
      fakeChild({ exitCode: null, signalCode: 'SIGTERM' }),
    );
    const state = stubCtx();
    const { exec } = fakeExec();
    const pending = state.tool.execute(
      { command: 'sleep 10sec', description: '等待十秒' },
      exec,
    );
    await vi.waitFor(() => expect(capture.callback).toBeTypeOf('function'));
    capture.callback(
      { killed: true, name: 'Error' } as ExecFileException,
      'partial',
      '',
    );
    const value = (await pending) as NushellForegroundOutput;
    expect(value.timedOut).toBe(true);
    expect(value.signal).toBe('SIGTERM');
    expect(renderNushellResult(value)).toBe(
      `partial\n[timed out after ${DEFAULT_TIMEOUT_MS}ms]\n[killed by signal: SIGTERM]`,
    );
  });
});

describe('渲染与 canonical 输出', () => {
  const clean: NushellForegroundOutput = {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1_000,
    stdout: { text: 'hello', truncated: false },
    stderr: { text: '', truncated: false },
  };

  it('干净退出无 marker;stdout+stderr 组合;空输出占位', () => {
    expect(renderNushellResult(clean)).toBe('hello');
    expect(
      renderNushellResult({
        ...clean,
        stdout: { text: '', truncated: false },
        stderr: { text: 'warn', truncated: false },
      }),
    ).toBe('[stderr]\nwarn');
    expect(
      renderNushellResult({
        ...clean,
        stdout: { text: '', truncated: false },
        stderr: { text: '', truncated: false },
      }),
    ).toBe('(no output)');
  });

  it('截断输出附完整文件路径注记', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-nushell-tool-test-'));
    const spill = path.join(dir, 'stdout.out.txt');
    await writeFile(spill, 'full', 'utf8');
    expect(
      renderNushellResult({
        ...clean,
        stdout: { text: 'head', truncated: true, spillPath: spill },
      }),
    ).toBe(`head\n[output truncated; full output: ${spill}]`);
    expect(
      renderNushellResult({
        ...clean,
        stdout: { text: 'head', truncated: true },
      }),
    ).toBe('head\n[output truncated; full output: (unavailable)]');
  });

  it('canonicalNushellResult 超限时截断并落盘完整输出', async () => {
    const raw = 'x'.repeat(20_001);
    const value = await canonicalNushellResult({
      command: 'ls',
      exitCode: 0,
      signal: null,
      timedOut: false,
      timeoutMs: 1_000,
      stdout: raw,
      stderr: '',
    });
    expect(value.stdout.truncated).toBe(true);
    expect(value.stdout.text).toHaveLength(20_000);
    expect(value.stdout.spillPath).toBeDefined();
    expect(existsSync(value.stdout.spillPath!)).toBe(true);
    expect(value.stderr).toEqual({ text: '', truncated: false });
  });

  it('后台句柄渲染 started background job', () => {
    const value: NushellToolOutput = { kind: 'background', jobId: 'nushell-3' };
    expect(renderNushellResult(value)).toBe('started background job nushell-3');
  });

  it('nushellJobOutcome 映射信号终止与非零退出', () => {
    expect(nushellJobOutcome(null, 'SIGTERM')).toEqual({
      status: 'killed',
      detail: 'signal: SIGTERM',
    });
    expect(nushellJobOutcome(3, null)).toEqual({
      status: 'completed',
      detail: 'exit code: 3',
    });
    expect(nushellJobOutcome(0, null)).toEqual({
      status: 'completed',
      detail: 'exit code: 0',
    });
  });

  it('runNushell 纯调用:默认 cwd 缺省、超时默认、结果登记 children 移除', async () => {
    const child = fakeChild({ exitCode: 0 });
    const capture = spawnCapture(child as unknown as ChildProcess);
    const children = new Set<ChildProcess>();
    const controller = new AbortController();
    const pending = runNushell(
      { command: 'ls' },
      { signal: controller.signal },
      children,
    );
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(1));
    expect(children.size).toBe(1);
    expect(capture.options().cwd).toBeUndefined();
    expect(capture.options().timeout).toBe(DEFAULT_TIMEOUT_MS);
    expect(capture.options().env).toBeUndefined();
    capture.callback(null, '', '');
    await pending;
    expect(children.size).toBe(0);
  });
});

describe('后台执行', () => {
  function setupJobs(): {
    jobs: StubJobs;
    starts: Array<Record<string, unknown>>;
  } {
    const starts: Array<Record<string, unknown>> = [];
    const jobs: StubJobs = {
      start: vi.fn((spec: Record<string, unknown>) => {
        starts.push(spec);
        return 'nushell-1';
      }),
    };
    return { jobs, starts };
  }

  it('run_in_background 返回 job 句柄并注册 nushell kind', async () => {
    const child = fakeStreamChild();
    spawnMock.mockImplementation(() => child);
    const { jobs, starts } = setupJobs();
    const state = stubCtx({ jobs });
    const { exec } = fakeExec({ session: { header: { cwd: 'F:/session' } } });
    const value = (await state.tool.execute(
      {
        command: 'sleep 5sec | print',
        description: '后台等待',
        workdir: 'sub',
        run_in_background: true,
      },
      exec,
    )) as NushellToolOutput;
    expect(value).toEqual({ kind: 'background', jobId: 'nushell-1' });
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      kind: 'nushell',
      label: 'sleep 5sec | print',
    });
    expect(starts[0]!.owner).toBe(exec.agent);
    (starts[0]!.run as () => unknown)();
    const spawnOptions = spawnMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(spawnOptions.cwd).toBe(path.resolve('F:/session', 'sub'));
    expect(spawnOptions.timeout).toBeUndefined();
    expect(spawnOptions.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('job 句柄支持增量读、取消与结算 outcome', async () => {
    const child = fakeStreamChild();
    spawnMock.mockImplementation(() => child);
    const { jobs } = setupJobs();
    const state = stubCtx({ jobs });
    const { exec } = fakeExec();
    const value = (await state.tool.execute(
      {
        command: 'sleep 5sec',
        description: '后台等待',
        run_in_background: true,
      },
      exec,
    )) as NushellToolOutput;
    const spec = (jobs.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      run(): {
        cancel(reason?: string): void;
        done: Promise<{ status: string; detail?: string }>;
        readOutput(): string;
      };
    };
    expect(value.kind).toBe('background');
    const hooks = spec.run();
    child.stdout.emit('data', 'hello ');
    child.stderr.emit('data', 'warn');
    expect(hooks.readOutput()).toBe('hello warn');
    expect(hooks.readOutput()).toBe('');
    hooks.cancel();
    expect(child.kill).toHaveBeenCalled();
    child.emitClose(3, null);
    await expect(hooks.done).resolves.toEqual({
      status: 'completed',
      detail: 'exit code: 3',
    });
  });

  it('信号终止的后台进程结算为 killed', async () => {
    const child = fakeStreamChild();
    spawnMock.mockImplementation(() => child);
    const { jobs } = setupJobs();
    const state = stubCtx({ jobs });
    const { exec } = fakeExec();
    await state.tool.execute(
      {
        command: 'sleep 5sec',
        description: '后台等待',
        run_in_background: true,
      },
      exec,
    );
    const spec = (jobs.start as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      run(): { done: Promise<{ status: string; detail?: string }> };
    };
    const hooks = spec.run();
    child.emitClose(null, 'SIGTERM');
    await expect(hooks.done).resolves.toEqual({
      status: 'killed',
      detail: 'signal: SIGTERM',
    });
  });

  it('宿主缺 jobs 服务时报错引导装载', async () => {
    const state = stubCtx();
    const { exec } = fakeExec();
    await expect(
      state.tool.execute(
        { command: 'ls', description: '列目录', run_in_background: true },
        exec,
      ),
    ).rejects.toThrow('background jobs unavailable');
  });

  it('enableRunInBackground: false 时拒绝后台调用', async () => {
    const state = stubCtx({ config: { enableRunInBackground: false } });
    const { exec } = fakeExec();
    await expect(
      state.tool.execute(
        { command: 'ls', description: '列目录', run_in_background: true },
        exec,
      ),
    ).rejects.toThrow('run_in_background is disabled for this deployment');
  });

  it('后台调用前置检查调用方取消信号', async () => {
    const { jobs } = setupJobs();
    const state = stubCtx({ jobs });
    const controller = new AbortController();
    controller.abort();
    await expect(
      state.tool.execute(
        { command: 'ls', description: '列目录', run_in_background: true },
        { signal: controller.signal } as ToolRunContext,
      ),
    ).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
  });
});

describe('UI 呈现', () => {
  it('presentCall:前台终端卡片携带命令/说明/工作目录', () => {
    const state = stubCtx();
    expect(
      state.tool.presentCall?.({
        command: 'ls',
        description: '列目录',
        workdir: 'F:/work',
      }),
    ).toEqual({
      card: 'terminal',
      title: 'ls',
      description: '列目录',
      cwd: 'F:/work',
    });
  });

  it('presentCall:后台调用降级为 generic 卡片', () => {
    const state = stubCtx();
    expect(
      state.tool.presentCall?.({
        command: 'sleep 5sec',
        description: '后台等待',
        run_in_background: true,
      }),
    ).toEqual({
      card: 'generic',
      title: 'sleep 5sec',
      kind: 'execute',
      rawInput: 'sleep 5sec',
      content: [{ type: 'text', text: '后台等待' }],
    });
  });

  it('presentResult:前台结果渲染终端卡片并带退出状态', () => {
    const state = stubCtx();
    const meta: NushellToolOutput = {
      kind: 'foreground',
      exitCode: 2,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1_000,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'oops', truncated: false },
    };
    expect(
      state.tool.presentResult?.(
        { command: 'ls', description: '列目录' },
        {
          content: [{ type: 'text', text: renderNushellResult(meta) }],
          isError: false,
          meta,
        },
      ),
    ).toEqual({
      card: 'terminal',
      output: 'out\n[stderr]\noops',
      exitCode: 2,
    });
  });

  it('presentResult:信号终止携带 signal,后台结果降级 console 卡片', () => {
    const state = stubCtx();
    const meta: NushellToolOutput = {
      kind: 'foreground',
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: false,
      aborted: false,
      timeoutMs: 1_000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
    };
    expect(
      state.tool.presentResult?.(
        { command: 'ls', description: '列目录' },
        {
          content: [{ type: 'text', text: renderNushellResult(meta) }],
          isError: false,
          meta,
        },
      ),
    ).toEqual({
      card: 'terminal',
      output: '(no output)',
      signal: 'SIGTERM',
    });
    const background: NushellToolOutput = {
      kind: 'background',
      jobId: 'nushell-1',
    };
    expect(
      state.tool.presentResult?.(
        { command: 'ls', description: '列目录' },
        {
          content: [{ type: 'text', text: 'started background job nushell-1' }],
          isError: false,
          meta: background,
        },
      ),
    ).toEqual({
      card: 'generic',
      content: [
        {
          type: 'text',
          text: '```console\nstarted background job nushell-1\n```',
        },
      ],
    });
  });
});
