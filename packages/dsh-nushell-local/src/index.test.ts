import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import {
  annotateWrappedNu,
  assertServiceableNushellConfig,
  DEFAULT_NUSHELL_CONFIG,
  NushellLocalExecutor,
  type NushellLocalConfig,
} from './index.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** collect-mode reader 假体:按 offset 返回预设文本。 */
function fakeReader(
  text = '',
  lossy = false,
  spillPath?: string,
): {
  readFrom: ReturnType<typeof vi.fn>;
} {
  return {
    readFrom: vi.fn((offset: number) => ({
      text: offset === 0 ? text : '',
      lossy,
      nextOffset: text.length,
      ...(spillPath !== undefined ? { spillPath } : {}),
    })),
  };
}

interface FakeHandle {
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  collected: {
    stdout: ReturnType<typeof fakeReader>;
    stderr: ReturnType<typeof fakeReader>;
  };
  terminate: ReturnType<typeof vi.fn>;
  resolveDone: (outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  rejectDone: (error: Error) => void;
}

function fakeHandle(stdoutText = '', stderrText = ''): FakeHandle {
  let settle: (outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const done = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((res, rej) => {
    settle = res;
    reject = rej;
  });
  return {
    done,
    collected: {
      stdout: fakeReader(stdoutText),
      stderr: fakeReader(stderrText),
    },
    terminate: vi.fn(),
    resolveDone: settle,
    rejectDone: reject,
  };
}

function stubCtx(
  stdoutText = '',
  stderrText = '',
): {
  ctx: Context;
  handle: FakeHandle;
  spawn: ReturnType<typeof vi.fn>;
} {
  const handle = fakeHandle(stdoutText, stderrText);
  const spawn = vi.fn(() => handle);
  // cordis Service 构造仅要求 ctx.reflect.provide(name, instance);stub 之。
  const ctx = {
    reflect: { provide: vi.fn() },
    subprocess: { spawn },
  } as unknown as Context;
  return { ctx, handle, spawn };
}

function makeExecutor(
  config: NushellLocalConfig = {},
  ctx?: Context,
): NushellLocalExecutor {
  return new NushellLocalExecutor(
    ctx ??
      ({
        reflect: { provide: vi.fn() },
        subprocess: { spawn: vi.fn() },
      } as unknown as Context),
    config,
  );
}

describe('nushell-local 配置', () => {
  it('缺省配置与显式覆盖并存', () => {
    expect(makeExecutor().config).toMatchObject({
      timeoutMs: 30_000,
      maxTimeoutMs: 600_000,
      maxOutputBytes: 64_000,
      nuPath: 'nu',
    });
    expect(
      makeExecutor({ timeoutMs: 1_000, nuPath: 'F:/nu/nu.exe' }).config,
    ).toMatchObject({ timeoutMs: 1_000, nuPath: 'F:/nu/nu.exe' });
    expect(DEFAULT_NUSHELL_CONFIG.maxSpillBytes).toBe(64 * 1024 * 1024);
  });

  it('拒绝不可运行的配置', () => {
    expect(() => makeExecutor({ timeoutMs: -1 })).toThrow(
      'timeoutMs must be a positive finite',
    );
    expect(() =>
      assertServiceableNushellConfig({
        ...DEFAULT_NUSHELL_CONFIG,
        graceMs: 3_000_000_000,
      }),
    ).toThrow('graceMs must be no greater than');
  });
});

describe('nushell-local resolve', () => {
  it('workdir 链:请求值 → 配置 cwd → 进程 cwd', () => {
    const configured = makeExecutor({ cwd: 'F:/base' });
    expect(configured.resolve({ command: 'ls' }).workdir).toBe('F:/base');
    expect(
      configured.resolve({ command: 'ls', workdir: 'F:/req' }).workdir,
    ).toBe('F:/req');
    expect(makeExecutor().resolve({ command: 'ls' }).workdir).toBe(
      process.cwd(),
    );
  });

  it('timeoutMs 请求值钳制与 stdout 预算', () => {
    const executor = makeExecutor();
    expect(executor.resolve({ command: 'ls' }).timeoutMs).toBe(30_000);
    expect(
      executor.resolve({ command: 'ls', timeoutMs: 9_000 }).timeoutMs,
    ).toBe(9_000);
    expect(
      executor.resolve({ command: 'ls', timeoutMs: 999_999_999 }).timeoutMs,
    ).toBe(600_000);
    expect(() => executor.resolve({ command: 'ls', timeoutMs: -5 })).toThrow(
      'request.timeoutMs',
    );
    expect(executor.resolve({ command: 'ls' }).stdoutMaxBytes).toBe(64_000);
    expect(
      executor.resolve({ command: 'ls', stdoutMaxBytes: 128 }).stdoutMaxBytes,
    ).toBe(128);
  });

  it('可选字段条件传播,sandboxPolicy 原样透传', () => {
    const controller = new AbortController();
    const dshEnv = { DSH_SESSION_ID: 's1' };
    const spec = makeExecutor().resolve({
      command: 'ls',
      signal: controller.signal,
      dshEnv,
      sandboxPolicy: {
        mode: 'ro',
        workspaceRoot: 'F:/ws',
      } as unknown as NonNullable<ShellExecRequest['sandboxPolicy']>,
    });
    expect(spec.signal).toBe(controller.signal);
    expect(spec.dshEnv).toBe(dshEnv);
    expect(spec).toHaveProperty('sandboxPolicy');
    const minimal = makeExecutor().resolve({ command: 'ls' });
    expect(minimal.signal).toBeUndefined();
    expect(minimal.stdin).toBeUndefined();
    expect(minimal.env).toBeUndefined();
    expect(minimal.dshEnv).toBeUndefined();
  });
});

describe('nushell-local argv 与 spawnSpec', () => {
  it('argv 固定 --no-config-file -c 形态,nuPath 可覆盖', () => {
    const executor = makeExecutor();
    expect(executor.argv({ command: 'ls | length' } as ShellExecSpec)).toEqual([
      'nu',
      '--no-config-file',
      '-c',
      'ls | length',
    ]);
    expect(
      makeExecutor({ nuPath: 'F:/nu/nu.exe' }).argv({
        command: 'ls',
      } as ShellExecSpec)[0],
    ).toBe('F:/nu/nu.exe');
  });

  it('spawnSpec:env 合并顺序为覆盖项 < env < dshEnv,预算进入 stdio', () => {
    const executor = makeExecutor({ maxOutputBytes: 128, maxSpillBytes: 256 });
    const spec = executor.resolve({
      command: 'ls',
      workdir: 'F:/work',
      env: { FOO: '1', NO_COLOR: '0' },
      dshEnv: { DSH_X: 'y' },
    });
    const spawnSpec = executor.spawnSpec(
      spec,
      128,
      undefined,
      executor.argv(spec),
    );
    expect(spawnSpec.argv).toEqual(['nu', '--no-config-file', '-c', 'ls']);
    expect(spawnSpec.cwd).toBe('F:/work');
    expect(spawnSpec.stdio.stdout).toEqual({
      maxBytes: 128,
      spill: { maxBytes: 256 },
    });
    expect(spawnSpec.stdio.stderr).toEqual({
      maxBytes: 128,
      spill: { maxBytes: 256 },
    });
    expect(spawnSpec.env).toEqual({
      NO_COLOR: '0',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      FOO: '1',
      DSH_X: 'y',
    });
  });
});

describe('nushell-local 前台 run', () => {
  it('正常结算 resolve(非零退出也 resolve)并投影 collect readers', async () => {
    const { ctx, handle, spawn } = stubCtx('out', 'err');
    const executor = makeExecutor({}, ctx);
    const spec = executor.resolve({ command: 'ls' });
    const pending = executor.run(spec);
    handle.resolveDone({ exitCode: 3, signal: null });
    const result = await pending;
    expect(result).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'err', truncated: false },
    });
    expect(result.stdout.spillPath).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(handle.collected.stdout.readFrom).toHaveBeenCalledWith(0);
  });

  it('截断流投影 truncated 与 spillPath', async () => {
    const { ctx, handle } = stubCtx();
    handle.collected.stdout = fakeReader('head', true, 'F:/spill/out.txt');
    const executor = makeExecutor({}, ctx);
    const spec = executor.resolve({ command: 'ls' });
    const pending = executor.run(spec);
    handle.resolveDone({ exitCode: 0, signal: null });
    const result = await pending;
    expect(result.stdout).toEqual({
      text: 'head',
      truncated: true,
      spillPath: 'F:/spill/out.txt',
    });
  });

  it('上游取消:aborted 置位(区别于超时)', async () => {
    const { ctx, handle } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const controller = new AbortController();
    const spec = executor.resolve({
      command: 'sleep 5sec',
      signal: controller.signal,
    });
    const pending = executor.run(spec);
    controller.abort();
    handle.resolveDone({ exitCode: null, signal: 'SIGTERM' });
    const result = await pending;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('基础设施失败(spawn 层拒绝)作为异常传播', async () => {
    const { ctx, handle } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const pending = executor.run(executor.resolve({ command: 'ls' }));
    handle.rejectDone(new Error('spawn EACCES'));
    await expect(pending).rejects.toThrow('spawn EACCES');
  });
});

describe('nushell-local 后台 start', () => {
  function startProc(
    executor: NushellLocalExecutor,
    spec: ShellExecSpec,
  ): ShellProcess {
    return executor.start(spec);
  }

  it('启动即 running;done 结算 completed 与 exitCode', async () => {
    const { ctx, handle } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const proc = startProc(
      executor,
      executor.resolve({ command: 'sleep 5sec' }),
    );
    expect(proc.status).toBe('running');
    handle.resolveDone({ exitCode: 7, signal: null });
    await proc.done;
    expect(proc.status).toBe('completed');
    expect(proc.exitCode).toBe(7);
  });

  it('上游取消的进程结算为 killed', async () => {
    const { ctx, handle } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const controller = new AbortController();
    const proc = startProc(
      executor,
      executor.resolve({ command: 'sleep 5sec', signal: controller.signal }),
    );
    controller.abort();
    handle.resolveDone({ exitCode: null, signal: 'SIGTERM' });
    await proc.done;
    expect(proc.status).toBe('killed');
  });

  it('kill 幂等:运行中终止并翻转状态,结算后返回 false', async () => {
    const { ctx, handle } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const proc = startProc(
      executor,
      executor.resolve({ command: 'sleep 5sec' }),
    );
    expect(proc.kill()).toBe(true);
    expect(handle.terminate).toHaveBeenCalledTimes(1);
    expect(proc.kill()).toBe(false);
  });

  it('readOutput 消费式增量:[stderr] 段、offset 推进、lossy 与 spill 路径', () => {
    const { ctx } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const handle = fakeHandle();
    let outCalls = 0;
    handle.collected.stdout.readFrom = vi.fn(() => {
      outCalls += 1;
      return {
        text: `chunk${outCalls} `,
        lossy: outCalls > 1,
        nextOffset: outCalls * 6,
      };
    });
    handle.collected.stderr.readFrom = vi.fn(() => ({
      text: 'warn',
      lossy: false,
      nextOffset: 4,
      spillPath: 'F:/spill/err.txt',
    }));
    const spawn = vi.fn(() => handle);
    (
      ctx as unknown as { subprocess: { spawn: typeof spawn } }
    ).subprocess.spawn = spawn;
    const proc = startProc(executor, executor.resolve({ command: 'ls' }));
    const first = proc.readOutput();
    expect(first.delta).toBe('chunk1 \n[stderr]\nwarn');
    expect(first.lossy).toBe(false);
    expect(first.stderrSpillPath).toBe('F:/spill/err.txt');
    const second = proc.readOutput();
    expect(second.delta).toBe('chunk2 \n[stderr]\nwarn');
    expect(second.lossy).toBe(true);
  });

  it('provider 拒绝结算 killed,失败说明并入下次 readOutput', async () => {
    const { ctx, handle } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const proc = startProc(executor, executor.resolve({ command: 'ls' }));
    handle.rejectDone(new Error('boom'));
    await proc.done;
    expect(proc.status).toBe('killed');
    const read = proc.readOutput();
    expect(read.delta).toContain(
      'subprocess failed before reporting an outcome: Error: boom',
    );
    expect(proc.readOutput().delta).not.toContain('boom');
  });
});

describe('nushell-local collect readers', () => {
  it('缺 collect 流时报实现错误', () => {
    const broken = {
      collected: { stdout: undefined, stderr: undefined },
    } as unknown as Parameters<typeof NushellLocalExecutor.collected>[0];
    expect(() => NushellLocalExecutor.collected(broken)).toThrow(
      'dropped a requested collect stream',
    );
  });
});

describe('nushell-local ShellRunResult 形状', () => {
  it('结果满足 shell 接缝 DTO(编译期形状 + 运行时字段)', async () => {
    const { ctx, handle } = stubCtx('ok', '');
    const executor = makeExecutor({}, ctx);
    const pending: Promise<ShellRunResult> = executor.run(
      executor.resolve({ command: 'ls' }),
    );
    handle.resolveDone({ exitCode: 0, signal: null });
    const result = await pending;
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining([
        'exitCode',
        'signal',
        'timedOut',
        'aborted',
        'timeoutMs',
        'stdout',
        'stderr',
      ]),
    );
  });
});

describe('nushell-local nu 包装层检测', () => {
  it('annotateWrappedNu 无特征原样返回', () => {
    expect(annotateWrappedNu('')).toBe('');
    expect(annotateWrappedNu('error: syntax error')).toBe(
      'error: syntax error',
    );
  });

  it('annotateWrappedNu 命中 pi-natives 特征附诊断注记', () => {
    const annotated = annotateWrappedNu('pi-natives:command: syntax error');
    expect(annotated).toContain('[nushell-local:');
    expect(annotated).toContain('official nu build');
  });

  it('前台 run 的 stderr 命中特征时被注记,stdout 不受影响', async () => {
    const { ctx, handle } = stubCtx('out', 'pi-natives:command: syntax error');
    const executor = makeExecutor({}, ctx);
    const spec = executor.resolve({ command: 'metadata 100' });
    const pending = executor.run(spec);
    handle.resolveDone({ exitCode: 1, signal: null });
    const result = await pending;
    expect(result.stdout.text).toBe('out');
    expect(result.stderr.text).toContain('[nushell-local:');
    expect(result.stderr.text).toContain('pi-natives:command: syntax error');
    expect(result.stderr.truncated).toBe(false);
  });

  it('后台增量读的 stderr 命中特征时被注记', async () => {
    const { ctx, handle } = stubCtx('', 'pi-natives:command: syntax error');
    const executor = makeExecutor({}, ctx);
    const proc = executor.start(executor.resolve({ command: 'metadata 100' }));
    handle.resolveDone({ exitCode: 1, signal: null });
    await proc.done;
    const read = proc.readOutput();
    expect(read.delta).toContain('[stderr]');
    expect(read.delta).toContain('[nushell-local:');
  });
});
