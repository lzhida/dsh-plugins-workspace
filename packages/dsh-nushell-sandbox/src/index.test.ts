import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import type {
  ConfinedArgv,
  SandboxExecutionPolicy,
} from '@deepseek-ai/dsh-sandbox';
import {
  assertServiceableNushellConfig,
  classifySandboxFacts,
  DEFAULT_NUSHELL_CONFIG,
  NushellSandboxExecutor,
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
  const confine = vi.fn(() => WRAPPED);
  const resolvePolicy = vi.fn(() => READ_ONLY_POLICY);
  // cordis Service 构造仅要求 ctx.reflect.provide(name, instance);stub 之。
  const ctx = {
    reflect: { provide: vi.fn() },
    subprocess: { spawn },
    sandbox: { confine },
    sandboxPolicy: { resolve: resolvePolicy, defaultMode: 'read-only' },
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
        sandbox: { confine: vi.fn() },
        sandboxPolicy: {
          resolve: vi.fn(() => READ_ONLY_POLICY),
          defaultMode: 'read-only',
        },
      } as unknown as Context),
    config,
  );
}

function specOf(overrides: Partial<ShellExecSpec> = {}): ShellExecSpec {
  return {
    command: 'ls',
    workdir: 'F:/ws',
    timeoutMs: 30_000,
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

describe('dsh-nushell-sandbox 前台 run', () => {
  it('受限模式经 confine 包装 argv 后 spawn,并结算沙箱事实', async () => {
    const { ctx, handle, spawn, sandbox } = stubCtx('out', '');
    handle.resolveDone({ exitCode: 0, signal: null });
    const executor = makeExecutor({}, ctx);
    const result = await executor.run(specOf());
    expect(sandbox.confine).toHaveBeenCalledOnce();
    expect(sandbox.confine).toHaveBeenCalledWith(
      ['nu', '--no-config-file', '-c', 'ls'],
      READ_ONLY_POLICY,
    );
    const spawnedArgv = spawn.mock.calls[0][0].argv as string[];
    expect(spawnedArgv.slice(0, 2)).toEqual(['runner', '--']);
    expect(result.sandbox).toEqual({
      mode: 'read-only',
      denied: false,
      enforcement: 'partial',
      runnerFailed: false,
    });
  });

  it('stderr 命中拒绝方言时如实报告 denied', async () => {
    const { ctx, handle } = stubCtx('', 'Error: access is denied');
    handle.resolveDone({ exitCode: 1, signal: null });
    const executor = makeExecutor({}, ctx);
    const result = await executor.run(specOf());
    expect(result.sandbox?.denied).toBe(true);
    expect(result.sandbox?.runnerFailed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it('runner 自身失败优先于拒绝分类并标记 runnerFailed', async () => {
    const { ctx, handle, sandbox } = stubCtx(
      '',
      'runner: refusing profile\nunrelated',
    );
    sandbox.confine.mockReturnValue({
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
    const result = await executor.run(specOf());
    expect(result.sandbox?.runnerFailed).toBe(true);
    expect(result.sandbox?.denied).toBe(false);
  });

  it('danger-full-access 不包装直接 spawn', async () => {
    const { ctx, handle, spawn, sandbox } = stubCtx('out', '');
    handle.resolveDone({ exitCode: 0, signal: null });
    const executor = makeExecutor({}, ctx);
    const result = await executor.run(
      specOf({
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: 'F:/ws' },
      }),
    );
    expect(sandbox.confine).not.toHaveBeenCalled();
    const spawnedArgv = spawn.mock.calls[0][0].argv as string[];
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
    const result: ShellRunResult = await executor.run(specOf());
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });
});

describe('dsh-nushell-sandbox 后台 start', () => {
  it('受限模式包装 argv,进程结算后盖上沙箱事实', async () => {
    const { ctx, handle, spawn } = stubCtx('out', '');
    const executor = makeExecutor({}, ctx);
    const proc = executor.start(specOf());
    const spawnedArgv = spawn.mock.calls[0][0].argv as string[];
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

  it('spawn 阶段 runner 失败结算为 killed 且 runnerFailed 如实标记', async () => {
    const { ctx, handle } = stubCtx('', '');
    const executor = makeExecutor({}, ctx);
    const proc = executor.start(specOf());
    handle.rejectDone(new Error('runner refused its profile'));
    await proc.done;
    expect(proc.status).toBe('killed');
    expect(proc.sandbox?.runnerFailed).toBe(true);
  });

  it('kill 幂等并终止受管进程', async () => {
    const { ctx, handle } = stubCtx('', '');
    const executor = makeExecutor({}, ctx);
    const proc = executor.start(specOf());
    expect(proc.kill()).toBe(true);
    expect(proc.kill()).toBe(false);
    handle.resolveDone({ exitCode: null, signal: 'SIGTERM' });
    await proc.done;
    expect(proc.status).toBe('killed');
  });
});

describe('dsh-nushell-sandbox 方言分类', () => {
  it('denialSignatures 大小写不敏感命中', () => {
    const facts = classifySandboxFacts(WRAPPED, 1, 'x\nAccess Is Denied\n');
    expect(facts).toEqual({ denied: true, runnerFailed: false });
  });

  it('informationalLines 全行排除后 fatal 签名仍命中', () => {
    const facts = classifySandboxFacts(
      {
        denialSignatures: [],
        runnerFailureRules: [
          {
            fatalSignatures: ['refusing profile'],
            informationalLines: ['BENIGN banner'],
          },
        ],
      },
      2,
      'benign banner\nrunner: refusing profile',
    );
    expect(facts).toEqual({ denied: false, runnerFailed: true });
  });

  it('allowedExitCodes 不匹配的退出码跳过该规则', () => {
    const facts = classifySandboxFacts(
      {
        denialSignatures: [],
        runnerFailureRules: [
          { allowedExitCodes: [64], fatalSignatures: ['refusing profile'] },
        ],
      },
      2,
      'runner: refusing profile',
    );
    expect(facts).toEqual({ denied: false, runnerFailed: false });
  });
});

describe('dsh-nushell-sandbox 配置', () => {
  it('缺省配置与显式覆盖并存', () => {
    expect(makeExecutor().config).toMatchObject({
      timeoutMs: 30_000,
      maxTimeoutMs: 600_000,
      maxOutputBytes: 64_000,
      maxSpillBytes: DEFAULT_NUSHELL_CONFIG.maxSpillBytes,
      nuPath: 'nu',
    });
    expect(makeExecutor({ nuPath: 'F:/nu/nu.exe' }).config.nuPath).toBe(
      'F:/nu/nu.exe',
    );
  });

  it('拒绝负数与非法超时配置', () => {
    expect(() => makeExecutor({ timeoutMs: -1 })).toThrow(
      'nushell-sandbox: timeoutMs must be a positive finite number',
    );
    expect(() =>
      assertServiceableNushellConfig({
        ...DEFAULT_NUSHELL_CONFIG,
        graceMs: 0,
      }),
    ).toThrow('nushell-sandbox: graceMs must be a positive finite number');
  });

  it('argv 固定 --no-config-file -c 形态,nuPath 可覆盖', () => {
    const executor = makeExecutor();
    expect(executor.argv(specOf())).toEqual([
      'nu',
      '--no-config-file',
      '-c',
      'ls',
    ]);
  });
});
