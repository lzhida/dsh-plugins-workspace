import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ShellExecRequest, ShellExecSpec } from '@deepseek-ai/dsh-shell';
import type {
  ConfinedArgv,
  SandboxExecutionPolicy,
} from '@deepseek-ai/dsh-sandbox';
import {
  assertServiceableNushellConfig,
  DEFAULT_NUSHELL_CONFIG,
  NushellSandboxExecutor,
  resolveNuPath,
  type NushellSandboxConfig,
} from './index.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const READ_ONLY_POLICY: SandboxExecutionPolicy = {
  mode: 'read-only',
  workspaceRoot: 'F:/ws',
};

const WRAPPED: ConfinedArgv = {
  argv: ['runner', '--', 'nu', '--no-config-file', '-c', 'ls'],
  enforcement: 'partial',
  denialSignatures: ['access is denied'],
  runnerFailureRules: [],
};

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

interface SandboxStubs {
  confine: ReturnType<typeof vi.fn>;
  resolvePolicy: ReturnType<typeof vi.fn>;
}

function stubCtx(
  stdoutText = '',
  stderrText = '',
): {
  ctx: Context;
  handle: FakeHandle;
  spawn: ReturnType<typeof vi.fn>;
  sandbox: SandboxStubs;
} {
  const handle = fakeHandle(stdoutText, stderrText);
  const spawn = vi.fn(() => handle);
  const confine = vi.fn(async () => WRAPPED);
  const resolvePolicy = vi.fn(() => READ_ONLY_POLICY);
  // cordis Service 构造仅要求 ctx.reflect.provide(name, instance);stub 之。
  const ctx = {
    reflect: { provide: vi.fn() },
    subprocess: { spawn },
    sandbox: { confine },
    sandboxPolicy: { resolve: resolvePolicy, defaultMode: 'read-only' },
    inject: vi.fn(),
  } as unknown as Context;
  return {
    ctx,
    handle,
    spawn,
    sandbox: { confine, resolvePolicy },
  };
}

function makeExecutor(
  config: NushellSandboxConfig = {},
  ctx?: Context,
): NushellSandboxExecutor {
  return new NushellSandboxExecutor(
    ctx ??
      ({
        reflect: { provide: vi.fn() },
        subprocess: { spawn: vi.fn() },
        sandbox: { confine: vi.fn(async () => WRAPPED) },
        sandboxPolicy: {
          resolve: vi.fn(() => READ_ONLY_POLICY),
          defaultMode: 'read-only',
        },
        inject: vi.fn(),
      } as unknown as Context),
    config,
  );
}

function specOf(overrides: Partial<ShellExecSpec> = {}): ShellExecSpec {
  return {
    command: 'ls',
    workdir: 'F:/ws',
    timeoutMs: 30_000,
    onExpiry: 'kill',
    stdoutMaxBytes: 64_000,
    sandboxPolicy: READ_ONLY_POLICY,
    ...overrides,
  };
}

describe('dsh-nushell-sandbox 契约', () => {
  it('导出 loader 依赖的插件符号与 confining 服务注入', () => {
    expect(NushellSandboxExecutor.inject).toEqual([
      'subprocess',
      'sandbox',
      'sandboxPolicy',
    ]);
    expect(NushellSandboxExecutor.name).toBe('NushellSandboxExecutor');
  });

  it('sandboxMode 透传共享策略服务的部署缺省', () => {
    const executor = makeExecutor();
    expect(executor.sandboxMode).toBe('read-only');
  });

  it('resolve 为缺 policy 的请求解析共享策略', () => {
    const { ctx, sandbox } = stubCtx();
    const executor = makeExecutor({}, ctx);
    const request: ShellExecRequest = {
      command: 'ls',
      timeoutMs: 1_000,
    };
    const spec = executor.resolve(request);
    expect(sandbox.resolvePolicy).toHaveBeenCalledOnce();
    expect(spec.sandboxPolicy).toEqual(READ_ONLY_POLICY);
    expect(spec.timeoutMs).toBe(1_000);
  });
});

describe('dsh-nushell-sandbox 前台 execute().result()', () => {
  it('受限模式经 confine 包装 argv 后 spawn,并结算沙箱事实', async () => {
    const { ctx, handle, spawn, sandbox } = stubCtx('out', '');
    handle.resolveDone({ exitCode: 0, signal: null });
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const spec = specOf();
    const result = await (await executor.execute(spec)).result();
    expect(sandbox.confine).toHaveBeenCalledOnce();
    const [argv, policy, signal] = sandbox.confine.mock.calls[0] as unknown as [
      string[],
      SandboxExecutionPolicy,
      AbortSignal | undefined,
    ];
    expect(argv).toEqual(['nu', '--no-config-file', '-c', 'ls']);
    expect(policy).toEqual(READ_ONLY_POLICY);
    // 0.1.7:confine 在 executeArgv 准备期执行,携带取消信号。
    expect(signal).toBeDefined();
    const spawnedArgv = spawn.mock.calls[0]![0].argv as string[];
    expect(spawnedArgv.slice(0, 2)).toEqual(['runner', '--']);
    expect(result.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
    });
  });

  it('stderr 命中拒绝方言时如实报告 denied', async () => {
    const { ctx, handle } = stubCtx('', 'Error: access is denied');
    handle.resolveDone({ exitCode: 1, signal: null });
    const executor = makeExecutor({}, ctx);
    const result = await (await executor.execute(specOf())).result();
    expect(result.sandbox?.denied).toBe(true);
    expect(result.sandbox?.runnerFailed).toBeUndefined();
    expect(result.exitCode).toBe(1);
  });

  it('runner 自身失败优先于拒绝分类:前台抛 SANDBOX_UNAVAILABLE', async () => {
    const { ctx, handle, sandbox } = stubCtx(
      '',
      'runner: refusing profile\nunrelated',
    );
    sandbox.confine.mockResolvedValue({
      ...WRAPPED,
      runnerFailureRules: [
        {
          fatalSignatures: ['refusing profile'],
          informationalLines: ['benign banner'],
        },
      ],
    });
    handle.resolveDone({ exitCode: 2, signal: null });
    const executor = makeExecutor({}, ctx);
    const execution = await executor.execute(specOf());
    // 0.1.7 语义:runner 失败 = 命令从未运行,前台以基础设施失败拒绝,
    // 决不把「沙箱问题」伪装成「命令结果」。
    await expect(execution.result()).rejects.toMatchObject({
      code: 'SANDBOX_UNAVAILABLE',
    });
  });

  it('danger-full-access 不包装直接 spawn', async () => {
    const { ctx, handle, spawn, sandbox } = stubCtx('out', '');
    handle.resolveDone({ exitCode: 0, signal: null });
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const result = await (
      await executor.execute(
        specOf({
          sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: 'F:/ws' },
        }),
      )
    ).result();
    expect(sandbox.confine).not.toHaveBeenCalled();
    const spawnedArgv = spawn.mock.calls[0]![0].argv as string[];
    expect(spawnedArgv).toEqual(['nu', '--no-config-file', '-c', 'ls']);
    expect(result.sandbox).toEqual({
      mode: 'danger-full-access',
      denied: false,
    });
  });

  it('非零退出按结果 resolve 而非 reject', async () => {
    const { ctx, handle } = stubCtx('', 'boom');
    handle.resolveDone({ exitCode: 3, signal: null });
    const executor = makeExecutor({}, ctx);
    const result = await (await executor.execute(specOf())).result();
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });
});

describe('dsh-nushell-sandbox 执行句柄(后台形态)', () => {
  it('受限模式包装 argv,进程结算后盖上沙箱事实', async () => {
    const { ctx, handle, spawn } = stubCtx('out', '');
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const proc = await executor.execute(specOf({ onExpiry: 'none' }));
    const spawnedArgv = spawn.mock.calls[0]![0].argv as string[];
    expect(spawnedArgv.slice(0, 2)).toEqual(['runner', '--']);
    handle.resolveDone({ exitCode: 0, signal: null });
    await proc.done;
    expect(proc.status).toBe('completed');
    expect(proc.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
    });
  });

  it('spawn 阶段 runner 可归因失败(ENOENT 且 path 即 argv[0])标记 runnerFailed', async () => {
    const { ctx, handle } = stubCtx('', '');
    const executor = makeExecutor({}, ctx);
    const proc = await executor.execute(
      specOf({ workdir: process.cwd(), onExpiry: 'none' }),
    );
    // 官方诊断:仅当错误 code/syscall/path 精确指向 runner 本身才归因。
    const runnerSpawnError = Object.assign(new Error('spawn runner ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn runner',
      path: 'runner',
    });
    handle.rejectDone(runnerSpawnError);
    await proc.done;
    expect(proc.status).toBe('killed');
    expect(proc.sandbox?.runnerFailed).toBe(true);
    expect(proc.sandbox?.denied).toBe(false);
  });

  it('无归因证据的 provider 拒绝不标记 runnerFailed(防误报)', async () => {
    const { ctx, handle } = stubCtx('', '');
    const executor = makeExecutor({}, ctx);
    const proc = await executor.execute(specOf({ onExpiry: 'none' }));
    handle.rejectDone(new Error('runner refused its profile'));
    await proc.done;
    expect(proc.sandbox?.runnerFailed).toBeUndefined();
    expect(proc.sandbox?.denied).toBe(false);
  });

  it('kill 幂等并终止受管进程', async () => {
    const { ctx, handle } = stubCtx('', '');
    const executor = makeExecutor({}, ctx);
    const proc = await executor.execute(specOf({ onExpiry: 'none' }));
    expect(proc.kill()).toBe(true);
    expect(proc.kill()).toBe(false);
    handle.resolveDone({ exitCode: null, signal: 'SIGTERM' });
    await proc.done;
    expect(proc.status).toBe('killed');
  });
});

describe('dsh-nushell-sandbox 后台结算沙箱事实', () => {
  it('结算点全量 stderr 命中 denial 签名 → denied 置位', async () => {
    const { ctx, handle } = stubCtx('out', 'access is denied: F:/outside');
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const proc = await executor.execute(specOf({ onExpiry: 'none' }));
    handle.resolveDone({ exitCode: 1, signal: null });
    await proc.done;
    expect(proc.status).toBe('completed');
    expect(proc.sandbox).toEqual({
      mode: 'read-only',
      denied: true,
      enforcement: 'partial',
    });
  });

  it('结算点 stderr 未命中签名 → facts 保持初始 denied:false', async () => {
    const { ctx, handle } = stubCtx('out', 'harmless warning');
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const proc = await executor.execute(specOf({ onExpiry: 'none' }));
    handle.resolveDone({ exitCode: 1, signal: null });
    await proc.done;
    expect(proc.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
    });
  });

  it('runner 规则命中优先于 denial 签名', async () => {
    const { ctx, handle, sandbox } = stubCtx('', 'runner: refusing profile');
    sandbox.confine.mockResolvedValue({
      ...WRAPPED,
      denialSignatures: ['refusing profile'],
      runnerFailureRules: [{ fatalSignatures: ['refusing profile'] }],
    });
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const proc = await executor.execute(specOf({ onExpiry: 'none' }));
    handle.resolveDone({ exitCode: 2, signal: null });
    await proc.done;
    expect(proc.sandbox).toMatchObject({ denied: false, runnerFailed: true });
  });

  it('danger-full-access 后台不经过分类:句柄不携带沙箱事实(对齐官方)', async () => {
    const { ctx, handle } = stubCtx('', 'access is denied');
    const executor = makeExecutor({ nuPath: 'nu' }, ctx);
    const proc = await executor.execute(
      specOf({
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: 'F:/ws' },
        onExpiry: 'none',
      }),
    );
    handle.resolveDone({ exitCode: 1, signal: null });
    await proc.done;
    // 官方语义:danger-full-access 只装饰前台 result();后台句柄无 facts。
    expect(proc.sandbox).toBeUndefined();
  });
});

describe('dsh-nushell-sandbox 配置与 nuPath', () => {
  it('缺省配置与显式覆盖并存(resolve 时生效)', () => {
    const { ctx } = stubCtx();
    expect(makeExecutor({}, ctx).resolve({ command: 'ls' }).timeoutMs).toBe(
      30_000,
    );
    expect(
      makeExecutor({ nuPath: 'F:/nu/nu.exe' }, ctx).resolve({ command: 'ls' })
        .timeoutMs,
    ).toBe(30_000);
    expect(DEFAULT_NUSHELL_CONFIG.maxSpillBytes).toBe(64 * 1024 * 1024);
  });

  it('拒绝负数与非法超时配置', () => {
    const { ctx } = stubCtx();
    expect(() =>
      makeExecutor({ timeoutMs: -1 }, ctx).resolve({ command: 'ls' }),
    ).toThrow(/timeoutMs must be a positive finite number/);
    expect(() =>
      assertServiceableNushellConfig({
        ...DEFAULT_NUSHELL_CONFIG,
        graceMs: 0,
      }),
    ).toThrow(/graceMs must be a positive finite number/);
  });

  it('argv 固定 --no-config-file -c 形态,声明 nuPath 原样生效', () => {
    const executor = makeExecutor({ nuPath: 'nu' });
    expect(executor.argv(specOf())).toEqual([
      'nu',
      '--no-config-file',
      '-c',
      'ls',
    ]);
  });

  it('显式 nuPath 原样生效;POSIX 兜底 PATH 语义', () => {
    expect(resolveNuPath('F:/nu/nu.exe', {}, 'win32', () => true)).toBe(
      'F:/nu/nu.exe',
    );
    expect(
      resolveNuPath(undefined, { PATH: '/usr/bin' }, 'linux', () => true),
    ).toBe('nu');
  });

  it('活值 nuPath 快照变化后重新解析', () => {
    const { ctx } = stubCtx();
    let declared: string | undefined = 'F:/bundled/nu.exe';
    const executor = makeExecutor({ nuPath: { get: () => declared } }, ctx);
    expect(executor.argv(specOf())[0]).toBe('F:/bundled/nu.exe');
    declared = 'F:/official/nu.exe';
    expect(executor.argv(specOf())[0]).toBe('F:/official/nu.exe');
  });
});
