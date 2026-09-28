import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import {
  apply,
  applyOutputFormat,
  canonicalNushellResult,
  Config,
  DEFAULT_TIMEOUT_MS,
  inject,
  MAX_TIMEOUT_MS,
  name,
  nushellJobOutcome,
  renderNushellResult,
  resolveWorkdir,
  validateNushellArgs,
  type NushellForegroundOutput,
  type NushellToolConfig,
  type NushellToolOutput,
} from './index.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

interface AppliedTool {
  name: string;
  description: string;
  timeoutMs?: number;
  parameters?: Record<string, unknown>;
  output?: {
    schema?: unknown;
  };
  isConcurrencySafe?(args: unknown): boolean;
  execute(
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<unknown>;
  presentCall?(args: Record<string, unknown>): unknown;
  presentResult?(args: Record<string, unknown>, result: unknown): unknown;
}

interface StubShell {
  resolve: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
}

interface StubState {
  registered: AppliedTool[];
  disposers: Array<ReturnType<typeof vi.fn>>;
  cleanups: Array<() => void>;
  tool: AppliedTool;
  /** 原始 ctx(测试中按需补挂 logger 等可选服务)。 */
  ctx: Context;
  /** 注册工具的 parameters schema(直通 definition)。 */
  schema: AppliedTool['parameters'];
  sections: Array<{ name: string; order: number; text: string }>;
  collectCalls: unknown[];
  shell: StubShell;
}

interface StubOptions {
  /** ctx.get('jobs'):job registry 假体(0.1.7 pull-sources 契约)。 */
  jobs?: Record<string, unknown>;
  dshEnv?: Record<string, string>;
  config?: NushellToolConfig;
  /** ctx.shell.sandboxMode:confining executor 探测结果。 */
  sandboxMode?: string;
  /** ctx.get('sandboxPolicy'):共享策略服务假体。 */
  sandboxPolicyResolve?: ReturnType<typeof vi.fn>;
  /** ctx.get('approval'):审批通道假体。 */
  approval?: unknown;
  /** ctx.get('sandbox'):沙箱服务假体(默认随 sandboxMode 给空对象)。 */
  sandbox?: unknown;
  /**
   * 接缝 shell 是否带 nushell runtime 标记(默认 true,模拟执行器组合;
   * false 模拟官方 shell 占缝——探针必须无视,直跑模式接管)。
   */
  seamRuntime?: boolean;
  /** ctx.subprocess.spawn:直跑模式执行核心假体。 */
  subprocessSpawn?: ReturnType<typeof vi.fn>;
}

/**
 * resolve 假体:按真实契约填缺省(timeoutMs 默认 30s、onExpiry 默认 kill),
 * 其余字段直通——断言直接针对构造的请求形状。
 */
function stubShell(): StubShell {
  return {
    resolve: vi.fn(
      (request: ShellExecRequest) =>
        ({
          ...request,
          workdir: request.workdir ?? process.cwd(),
          timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          onExpiry: request.onExpiry ?? 'kill',
          stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
          sandboxPolicy: request.sandboxPolicy,
        }) as unknown as ShellExecSpec,
    ),
    execute: vi.fn(),
  };
}

function stubCtx(options: StubOptions = {}): StubState {
  const registered: AppliedTool[] = [];
  const disposers: Array<ReturnType<typeof vi.fn>> = [];
  const cleanups: Array<() => void> = [];
  const sections: Array<{ name: string; order: number; text: string }> = [];
  const collectCalls: unknown[] = [];
  const shell = stubShell();
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
    get: vi.fn((key: string) =>
      key === 'jobs'
        ? options.jobs
        : key === 'sandbox'
          ? options.sandbox !== undefined
            ? options.sandbox
            : options.sandboxMode !== undefined
              ? {}
              : undefined
          : key === 'sandboxPolicy'
            ? options.sandboxPolicyResolve !== undefined
              ? { resolve: options.sandboxPolicyResolve }
              : undefined
            : key === 'approval'
              ? options.approval
              : undefined,
    ),
    subprocess: {
      spawn: options.subprocessSpawn ?? vi.fn(),
    },
    // 服务属性镜像:直跑内部执行器经 this.ctx.sandbox / sandboxPolicy
    // 直读服务(get 与属性两条访问路径都要成立)。
    ...(options.sandbox !== undefined || options.sandboxMode !== undefined
      ? {
          sandbox: options.sandbox !== undefined ? options.sandbox : {},
        }
      : {}),
    ...(options.sandboxPolicyResolve !== undefined
      ? { sandboxPolicy: { resolve: options.sandboxPolicyResolve } }
      : {}),
    // inject(['jobs']) 回调经 jobCtx.jobs 直读服务(属性与 get 双路径)。
    ...(options.jobs !== undefined ? { jobs: options.jobs } : {}),
    inject: vi.fn((names: readonly string[], cb: (c: unknown) => void) => {
      // 服务「可用」即回调,模拟 cordis inject 语义:['shell'] 恒可用;
      // ['jobs'] 仅在组合里真的提供了 jobs 时才回调——避免假体自相矛盾。
      if (names.includes('shell')) {
        cb(ctx);
      } else if (names.includes('jobs') && options.jobs !== undefined) {
        cb(ctx);
      }
    }),
    fiber: { state: 2 },
    shell: Object.assign(shell, {
      sandboxMode: options.sandboxMode,
      runtime: options.seamRuntime === false ? undefined : 'nushell',
    }),
  } as unknown as Context;
  apply(ctx, options.config);
  return {
    registered,
    disposers,
    cleanups,
    tool: registered[0]!,
    ctx,
    schema: registered[0]!.parameters,
    sections,
    collectCalls,
    shell,
  };
}

function fakeExec(agent?: unknown): {
  exec: ToolRunContext;
  signal: AbortSignal;
} {
  const controller = new AbortController();
  return {
    exec: {
      callId: 'call-1',
      signal: controller.signal,
      agent,
    } as unknown as ToolRunContext,
    signal: controller.signal,
  };
}

/** 0.1.7 执行句柄假体:done 手动结算,result() 投影可注入,observed 可断言。 */
function fakeExecution(result?: Partial<ShellRunResult>): ShellExecution & {
  settle: (outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
} {
  let settleDone: (outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void = () => {};
  const reader = {
    readFrom: (fromByte: number) => ({
      text: '',
      nextOffset: fromByte,
      lossy: false,
    }),
  };
  const proc = {
    status: 'running',
    exitCode: null,
    signal: null,
    observed: { stdout: reader, stderr: reader },
    readOutput: vi.fn(() => ({ delta: '', lossy: false })),
    kill: vi.fn(),
  } as unknown as ShellExecution & {
    settle: typeof settleDone;
  };
  Object.assign(proc, {
    done: new Promise<void>((res) => {
      settleDone = (outcome) => {
        proc.exitCode = outcome.exitCode;
        proc.signal = outcome.signal;
        if (proc.status === 'running') {
          proc.status = outcome.signal !== null ? 'killed' : 'completed';
        }
        res();
      };
    }),
  });
  let resultPromise: Promise<ShellRunResult> | undefined;
  proc.result = vi.fn(() => {
    resultPromise ??= proc.done.then(() => ({
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      aborted: false,
      timeoutMs: 30_000,
      stdout: { text: '', truncated: false },
      stderr: { text: '', truncated: false },
      ...result,
    }));
    return resultPromise;
  });
  proc.settle = settleDone;
  return proc;
}

function foreground(
  overrides: Partial<NushellForegroundOutput> = {},
): NushellForegroundOutput {
  return {
    kind: 'foreground',
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1_000,
    stdout: { text: 'hello', truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  };
}

interface JobHooksStub {
  cancel(reason?: string): void;
  done: Promise<{ status: string; detail?: string }>;
}

function stubJobs() {
  const starts: Array<Record<string, unknown>> = [];
  const hooksList: JobHooksStub[] = [];
  const jobs: Record<string, unknown> = {
    start: vi.fn(
      (
        spec: {
          run(job: { id: string }): JobHooksStub;
        } & Record<string, unknown>,
      ) => {
        // 真实 registry 在 start 内同步调用 run(准入后启动生产者)。
        starts.push(spec);
        const id = `nushell-${starts.length}`;
        hooksList.push(spec.run({ id }));
        return id;
      },
    ),
    kill: vi.fn(() => 'requested' as const),
    remove: vi.fn(),
    wait: vi.fn(async (): Promise<{ status: string; detail?: string }> => ({
      status: 'completed',
      detail: 'exit code: 0',
    })),
    read: vi.fn(() => ({
      chunks: [] as Array<{ channel?: string; text: string }>,
      lossy: false,
      job: {} as { output?: { spillPaths?: string[] } },
    })),
  };
  return { jobs, starts, hooksList };
}

describe('dsh-tool-nushell 契约', () => {
  it('导出 loader 依赖的插件符号', () => {
    expect(name).toBe('dsh-tool-nushell');
    expect(inject).toEqual(['tools', 'systemPrompt', 'shellEnv', 'subprocess']);
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
    // 提示词契约:nu 原生语法引导必须存在——防回归删除导致模型回落 cmd/bash 习惯。
    expect(state.sections[0]!.text).toContain('Do NOT shell out to `^cmd`');
    expect(state.sections[0]!.text).toContain("single quotes ('C:");
    expect(state.sections[0]!.text).toContain('$env.NAME');
    expect(state.tool.description).toContain('Do NOT shell out to `^cmd`');
    expect(state.tool.description).toContain('$env.NAME');
  });

  it('无 jobs 时注册前台形态工具;cleanup 注销', () => {
    const state = stubCtx();
    expect(state.registered).toHaveLength(1);
    // 无 run_in_background 参数:前台形态不公布后台开关。
    const properties = state.schema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(properties.properties.run_in_background).toBeUndefined();
    for (const cleanup of state.cleanups) {
      cleanup();
    }
    expect(state.disposers[0]).toHaveBeenCalled();
  });

  it('有 jobs 时同样注册唯一工具,且公布 run_in_background', () => {
    const { jobs } = stubJobs();
    const state = stubCtx({ jobs });
    expect(state.registered).toHaveLength(1);
    const properties = state.schema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(properties.properties.run_in_background).toBeDefined();
  });

  it('调用方取消以 AbortError 中止(HarnessError/TOOL_ABORTED 语义)', async () => {
    const { jobs } = stubJobs();
    const state = stubCtx({ jobs });
    const controller = new AbortController();
    controller.abort();
    await expect(
      state.tool.execute(
        {
          command: 'sleep 5sec',
          description: '等待五秒',
          run_in_background: true,
        },
        { signal: controller.signal } as ToolRunContext,
      ),
    ).rejects.toMatchObject({
      message: 'tool call aborted',
      code: 'ABORTED',
      name: 'AbortError',
    });
  });
});

describe('参数与纯函数', () => {
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
    // 语义按运行时 path 模块解析(每平台原生形状),夹具按平台给绝对路径
    const win = process.platform === 'win32';
    const cwd = win ? 'F:/session' : '/tmp/session';
    const abs = win ? 'F:/abs' : '/abs';
    const agent = { session: { header: { cwd } } };
    const exec = { agent } as unknown as ToolRunContext;
    const bare = { agent: undefined } as unknown as ToolRunContext;
    expect(resolveWorkdir(undefined, exec)).toBe(cwd);
    expect(resolveWorkdir(undefined, bare)).toBeUndefined();
    expect(resolveWorkdir('sub/dir', exec)).toBe(path.resolve(cwd, 'sub/dir'));
    expect(resolveWorkdir(abs, exec)).toBe(abs);
  });

  it('validateNushellArgs 拒绝非法 outputFormat,合法值放行', () => {
    expect(() =>
      validateNushellArgs({
        command: 'ls',
        description: 'ok',
        outputFormat: 'xml',
      }),
    ).toThrow("invalid outputFormat: expected 'json', 'nuon' or 'text'");
    expect(() =>
      validateNushellArgs({
        command: 'ls',
        description: 'ok',
        outputFormat: 'json',
      }),
    ).not.toThrow();
  });

  it('applyOutputFormat:text/缺省原样,json/nuon 包 do 块接序列化器', () => {
    expect(applyOutputFormat('ls | length', undefined)).toBe('ls | length');
    expect(applyOutputFormat('ls | length', 'text')).toBe('ls | length');
    expect(applyOutputFormat('ls', 'json')).toBe('do { ls } | to json --raw');
    expect(applyOutputFormat('ls', 'nuon')).toBe('do { ls } | to nuon');
  });

  it('Config schema 声明两个开关,jobs 在场时 promote 文案生效', () => {
    expect(Config).toBeDefined();
    const { jobs } = stubJobs();
    const state = stubCtx({ jobs });
    // promote 默认开启:timeoutMs 参数文案带「到点转后台」语义。
    const properties = state.schema as unknown as {
      properties: Record<string, { description?: string }>;
    };
    expect(properties.properties.timeoutMs?.description).toContain(
      'moves to the background as a job',
    );
  });
});

describe('结构化输出与 stdin', () => {
  it('前台请求应用 outputFormat 包装并透传 stdin', async () => {
    const state = stubCtx();
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground()),
    });
    const { exec } = fakeExec();
    await state.tool.execute(
      {
        command: 'ls | length',
        description: '数一数',
        outputFormat: 'json',
        stdin: 'abc',
      },
      exec,
    );
    const request = state.shell.resolve.mock
      .calls[0][0] as unknown as ShellExecRequest;
    expect(request.command).toBe('do { ls | length } | to json --raw');
    expect(request.stdin).toBe('abc');
    // 前台执行必须把调用方 signal 交给 executor(取消即杀)。
    expect(request.signal).toBeDefined();
  });

  it('后台请求同样应用包装,label 保留原始命令', async () => {
    const { jobs, starts } = stubJobs();
    const state = stubCtx({ jobs });
    state.shell.execute.mockResolvedValue(fakeExecution());
    const { exec } = fakeExec();
    await state.tool.execute(
      {
        command: 'open a.csv | length',
        description: '数行',
        run_in_background: true,
        outputFormat: 'nuon',
      },
      exec,
    );
    const request = state.shell.resolve.mock
      .calls[0][0] as unknown as ShellExecRequest;
    expect(request.command).toBe('do { open a.csv | length } | to nuon');
    expect(request.stdin).toBeUndefined();
    // 后台按 0.1.7 契约不带 executor 截止(onExpiry: 'none')。
    expect(request.onExpiry).toBe('none');
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      kind: 'nushell',
      label: 'open a.csv | length',
    });
  });

  it('系统提示 section 含 complete 捕获、命令替换与 outputFormat 指引', () => {
    const state = stubCtx();
    expect(state.sections[0]!.text).toContain('do -i { ^cmd } | complete');
    expect(state.sections[0]!.text).toContain('`(cmd)`');
    expect(state.sections[0]!.text).toContain('outputFormat');
    expect(state.sections[0]!.text).toContain('$env.NAME? | default X');
    expect(state.tool.description).toContain('outputFormat');
  });
});

describe('前台执行', () => {
  it('execute 经 execute().result(),请求携带 workdir/timeoutMs/DSH_*', async () => {
    const foregroundResult = foreground({
      exitCode: 2,
      stdout: { text: 'out', truncated: false },
    });
    const state = stubCtx({ dshEnv: { DSH_SESSION_ID: 's1' } });
    const execution = fakeExecution();
    state.shell.execute.mockResolvedValue(execution);
    execution.result = vi.fn(
      async () => foregroundResult as unknown as ShellRunResult,
    );
    const { exec } = fakeExec();
    const value = (await state.tool.execute(
      {
        command: 'ls',
        description: '列目录',
        timeoutMs: 1_000,
        workdir: 'F:/work',
      },
      exec,
    )) as NushellForegroundOutput;
    expect(state.shell.execute).toHaveBeenCalledTimes(1);
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request).toMatchObject({
      command: 'ls',
      workdir: 'F:/work',
      timeoutMs: 1_000,
      dshEnv: { DSH_SESSION_ID: 's1' },
    });
    expect(value).toEqual(foregroundResult);
    expect(state.collectCalls).toHaveLength(1);
    expect(state.collectCalls[0]).toBe(exec);
  });

  it('result.aborted 时以 AbortError 中止', async () => {
    const state = stubCtx();
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => ({
        ...foreground(),
        aborted: true,
        signal: 'SIGTERM' as const,
        exitCode: null,
      })),
    });
    const { exec } = fakeExec();
    await expect(
      state.tool.execute({ command: 'ls', description: '列目录' }, exec),
    ).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
  });

  it('无 workdir/timeoutMs 时请求不带,默认由 executor 预算', async () => {
    const state = stubCtx();
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground()),
    });
    const { exec } = fakeExec();
    await state.tool.execute({ command: 'ls', description: '列目录' }, exec);
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request.workdir).toBeUndefined();
    expect(request.timeoutMs).toBeUndefined();
  });
});

describe('沙箱组合与升权', () => {
  it('非沙箱组合不公布升权字段,请求不带 sandboxPolicy', async () => {
    const state = stubCtx();
    const plain = state.schema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(plain.properties.sandbox_permissions).toBeUndefined();
    expect(plain.properties.justification).toBeUndefined();
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground()),
    });
    const { exec } = fakeExec();
    await state.tool.execute({ command: 'ls', description: '列目录' }, exec);
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request.sandboxPolicy).toBeUndefined();
  });

  it('confining executor 缺共享策略服务时 apply 失败', () => {
    expect(() => stubCtx({ sandboxMode: 'read-only' })).toThrow(
      'ctx.sandboxPolicy is unresolvable',
    );
  });

  /** 注册工具 output.schema 的 foreground 分支(编译后 JSON Schema)。 */
  function foregroundBranchOf(outputSchema: unknown) {
    const schema = outputSchema as {
      oneOf: Array<{
        properties?: Record<string, { const?: string }>;
      }>;
    };
    const branch = schema.oneOf.find(
      (item) => item.properties?.kind?.const === 'foreground',
    );
    expect(branch).toBeDefined();
    return branch!;
  }

  it('输出 schema 的 foreground 分支声明 sandbox 事实', () => {
    const state = stubCtx();
    const foregroundBranch = foregroundBranchOf(
      state.registered[0]!.output!.schema,
    );
    expect(foregroundBranch.properties!.sandbox).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string' },
        denied: { type: 'boolean' },
        enforcement: { type: 'string' },
        runnerFailed: { type: 'boolean' },
      },
      required: ['mode', 'denied'],
    });
  });

  it('输出 schema 声明 promoted 分支', () => {
    const state = stubCtx();
    const schema = state.registered[0]!.output!.schema as {
      oneOf: Array<{ properties?: Record<string, { const?: string }> }>;
    };
    const promoted = schema.oneOf.find(
      (item) => item.properties?.kind?.const === 'promoted',
    );
    expect(promoted).toBeDefined();
    expect(Object.keys(promoted!.properties!)).toEqual([
      'kind',
      'jobId',
      'timeoutMs',
      'output',
    ]);
  });

  it('confining 前台输出经官方校验器零违规(声明覆盖实际输出)', () => {
    const state = stubCtx();
    const foregroundBranch = foregroundBranchOf(
      state.registered[0]!.output!.schema,
    );
    const confining = canonicalNushellResult({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1_000,
      stdout: { text: '42', truncated: false },
      stderr: { text: '', truncated: false },
      sandbox: { mode: 'read-only', denied: false, enforcement: 'partial' },
    });
    expect(
      validateJsonSchemaValue(foregroundBranch as never, confining, 'value'),
    ).toEqual([]);
    const violations = validateJsonSchemaValue(
      foregroundBranch as never,
      { ...confining, extra: 1 },
      'value',
    );
    expect(violations.length).toBeGreaterThan(0);
  });

  it('沙箱组合公布升权字段并在 execute 解析 standing policy', async () => {
    const resolvePolicy = vi.fn(() => ({
      mode: 'read-only',
      workspaceRoot: 'F:/work',
    }));
    const state = stubCtx({
      sandboxMode: 'read-only',
      sandboxPolicyResolve: resolvePolicy,
    });
    const properties = state.schema as unknown as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(properties.properties.sandbox_permissions).toMatchObject({
      enum: ['workspace-write', 'danger-full-access'],
    });
    expect(properties.properties.justification).toBeDefined();
    const { exec } = fakeExec({ session: { id: 's1' } });
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground()),
    });
    await state.tool.execute({ command: 'ls', description: '列目录' }, exec);
    expect(resolvePolicy).toHaveBeenCalledWith({
      session: { id: 's1' },
    });
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request.sandboxPolicy).toEqual({
      mode: 'read-only',
      workspaceRoot: 'F:/work',
    });
  });

  it('升权请求经审批后以放宽模式执行', async () => {
    const resolvePolicy = vi.fn(() => ({
      mode: 'read-only',
      workspaceRoot: 'F:/work',
    }));
    const requestApproval = vi.fn().mockResolvedValue('allowed-once');
    const state = stubCtx({
      sandboxMode: 'read-only',
      sandboxPolicyResolve: resolvePolicy,
      approval: { request: requestApproval },
    });
    const { exec, signal } = fakeExec({ session: { id: 's1' } });
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground()),
    });
    await state.tool.execute(
      {
        command: `'x' | save ../out.txt`,
        description: '写工作区外',
        sandbox_permissions: 'workspace-write',
        justification: '需要把导出文件写到工作区外',
      },
      exec,
    );
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0]![0]).toMatchObject({
      toolName: 'nushell',
      callId: exec.callId,
      signal,
    });
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request.sandboxPolicy).toEqual({
      mode: 'workspace-write',
      workspaceRoot: 'F:/work',
    });
  });

  it('拒绝的升权中止执行(approveEscalation fail-closed)', async () => {
    const resolvePolicy = vi.fn(() => ({
      mode: 'read-only',
      workspaceRoot: 'F:/work',
    }));
    const state = stubCtx({
      sandboxMode: 'read-only',
      sandboxPolicyResolve: resolvePolicy,
      approval: { request: vi.fn().mockResolvedValue('rejected') },
    });
    const { exec } = fakeExec({ session: { id: 's1' } });
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground()),
    });
    await expect(
      state.tool.execute(
        {
          command: 'ls',
          description: '列目录',
          sandbox_permissions: 'workspace-write',
          justification: '想写外面',
        },
        exec,
      ),
    ).rejects.toThrow(/rejected escalating this command/);
    expect(state.shell.execute).not.toHaveBeenCalled();
  });

  it('升权理由缺失时参数配对校验抛错', async () => {
    const state = stubCtx({
      sandboxMode: 'read-only',
      sandboxPolicyResolve: vi.fn(() => ({
        mode: 'read-only',
        workspaceRoot: 'F:/work',
      })),
    });
    const { exec } = fakeExec();
    await expect(
      state.tool.execute(
        {
          command: 'ls',
          description: '列目录',
          sandbox_permissions: 'workspace-write',
        },
        exec,
      ),
    ).rejects.toThrow(/justification/i);
  });

  it('非沙箱组合收到未公布的升权参数时组合守卫抛错', async () => {
    const state = stubCtx();
    const { exec } = fakeExec();
    await expect(
      state.tool.execute(
        {
          command: 'ls',
          description: '列目录',
          sandbox_permissions: 'workspace-write',
          justification: 'x',
        },
        exec,
      ),
    ).rejects.toThrow(/no sandboxing executor to escalate/);
  });

  it('拒绝与 runner 失败按官方语义渲染 marker', () => {
    const denied = foreground({
      sandbox: { mode: 'read-only', denied: true },
    });
    expect(renderNushellResult(denied)).toBe(
      'hello\n[sandbox: file access denied under read-only mode]',
    );
    expect(
      renderNushellResult(denied, ['workspace-write', 'danger-full-access']),
    ).toBe(
      'hello\n[sandbox: file access denied under read-only mode]\n' +
        '[sandbox: escalation available — retry this exact command once with ' +
        'sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
    );
    const runnerFailed = foreground({
      sandbox: {
        mode: 'read-only',
        denied: false,
        runnerFailed: true,
      },
    });
    expect(renderNushellResult(runnerFailed, ['workspace-write'])).toContain(
      '[sandbox: the sandbox runner itself failed under read-only mode',
    );
  });

  it('canonical 输出透传沙箱事实,非沙箱结果不带字段', () => {
    expect(
      canonicalNushellResult(foreground() as unknown as ShellRunResult).sandbox,
    ).toBeUndefined();
    const result = canonicalNushellResult({
      exitCode: 1,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 1_000,
      stdout: { text: '', truncated: false },
      stderr: { text: 'denied', truncated: false },
      sandbox: {
        mode: 'read-only',
        denied: true,
        enforcement: 'partial',
        runnerFailed: false,
      },
    });
    expect(result.sandbox).toEqual({
      mode: 'read-only',
      denied: true,
      enforcement: 'partial',
      runnerFailed: false,
    });
  });
});

describe('渲染与 canonical 输出', () => {
  it('干净退出无 marker;stdout+stderr 组合;空输出占位', () => {
    expect(renderNushellResult(foreground())).toBe('hello');
    expect(
      renderNushellResult(
        foreground({
          stdout: { text: '', truncated: false },
          stderr: { text: 'warn', truncated: false },
        }),
      ),
    ).toBe('[stderr]\nwarn');
    expect(
      renderNushellResult(
        foreground({
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      ),
    ).toBe('(no output)');
  });

  it('非零退出与超时/信号 marker;截断附完整文件路径注记', () => {
    expect(
      renderNushellResult(
        foreground({ exitCode: 2, stderr: { text: 'oops', truncated: false } }),
      ),
    ).toBe('hello\n[stderr]\noops\n[exit code: 2]');
    expect(
      renderNushellResult(
        foreground({
          timedOut: true,
          signal: 'SIGTERM',
          exitCode: null,
          stdout: { text: 'partial', truncated: false },
        }),
      ),
    ).toBe('partial\n[timed out after 1000ms]\n[killed by signal: SIGTERM]');
    expect(
      renderNushellResult(
        foreground({
          stdout: { text: 'head', truncated: true, spillPath: 'F:/spill' },
        }),
      ),
    ).toBe('head\n[output truncated; full output: F:/spill]');
    expect(
      renderNushellResult(
        foreground({ stdout: { text: 'head', truncated: true } }),
      ),
    ).toBe('head\n[output truncated; full output: (unavailable)]');
  });

  it('stopped 原因渲染为 marker', () => {
    expect(renderNushellResult(foreground({ stopped: 'job_kill' }))).toBe(
      'hello\n[stopped: job_kill]',
    );
  });

  it('canonicalNushellResult 透传 shell 结果并原样携带 aborted', () => {
    const value = canonicalNushellResult({
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: true,
      timeoutMs: 2_000,
      stdout: { text: 'a', truncated: true, spillPath: 'F:/s' },
      stderr: { text: '', truncated: false },
    });
    expect(value).toEqual({
      kind: 'foreground',
      exitCode: 3,
      signal: null,
      timedOut: false,
      aborted: true,
      timeoutMs: 2_000,
      stdout: { text: 'a', truncated: true, spillPath: 'F:/s' },
      stderr: { text: '', truncated: false },
    });
  });

  it('后台句柄渲染 started background job;升格渲染 job 交接指引', () => {
    const value: NushellToolOutput = { kind: 'background', jobId: 'nushell-3' };
    expect(renderNushellResult(value)).toBe('started background job nushell-3');
    const promoted: NushellToolOutput = {
      kind: 'promoted',
      jobId: 'nushell-4',
      timeoutMs: 5_000,
      output: 'partial\n',
    };
    const rendered = renderNushellResult(promoted);
    expect(rendered).toContain('partial\n');
    expect(rendered).toContain(
      '[still running after 5000ms; moved to background job nushell-4]',
    );
    expect(rendered).toContain('read newer output with job_output');
  });

  it('nushellJobOutcome 映射 killed/completed;沙箱事实并入 detail', () => {
    expect(
      nushellJobOutcome({
        status: 'killed',
        exitCode: null,
        signal: 'SIGTERM',
      }),
    ).toEqual({
      status: 'killed',
      detail: 'signal: SIGTERM',
    });
    expect(
      nushellJobOutcome({ status: 'completed', exitCode: 3, signal: null }),
    ).toEqual({
      status: 'completed',
      detail: 'exit code: 3',
    });
    const deniedOutcome = nushellJobOutcome(
      {
        status: 'completed',
        exitCode: 1,
        signal: null,
        sandbox: { mode: 'read-only', denied: true },
      },
      ['workspace-write'],
    );
    expect(deniedOutcome.detail).toContain('[sandbox: file access denied');
    expect(deniedOutcome.detail).toContain('[sandbox: escalation available');
  });
});

describe('后台执行', () => {
  it('run_in_background 注册 job:pull-sources 输出环 + cancel 转发 kill', async () => {
    const execution = fakeExecution();
    const { jobs, starts, hooksList } = stubJobs();
    const state = stubCtx({ jobs });
    state.shell.execute.mockResolvedValue(execution);
    const { exec } = fakeExec({
      id: 'agent-1',
      session: { header: { cwd: 'F:/session' } },
    });
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
      owner: 'agent-1',
    });
    // pull sources:stdout/stderr 双通道,读的是句柄的 observed 非消费读。
    const sources = starts[0]!.output as Array<{
      channel: string;
      read(from: number): { text: string; nextOffset: number };
    }>;
    expect(sources.map((s) => s.channel)).toEqual(['stdout', 'stderr']);
    expect(sources[0]!.read(0)).toEqual({
      text: '',
      nextOffset: 0,
      lossy: false,
    });
    // start 内同步调用的 run hooks:cancel 转发 kill(经 controller 兜底),
    // done 结算 outcome(信号终止记 killed)。
    const hooks = hooksList[0]!;
    hooks.cancel('user asked');
    execution.settle({ exitCode: null, signal: 'SIGTERM' });
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
});

describe('前台升格(promoteOnTimeout)', () => {
  it('到点未完:返回 promoted 结果,job 保留可继续读', async () => {
    const execution = fakeExecution();
    const { jobs } = stubJobs();
    // 让出微任务/宏任务,确保 registry.start 已同步启动生产者、
    // processJob 已拿到执行句柄后再返回 running。
    jobs.wait = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { status: 'running' };
    });
    jobs.read = vi.fn(() => ({
      chunks: [
        { channel: 'stdout', text: 'partial ' },
        { channel: 'stderr', text: 'warn' },
      ],
      lossy: false,
      job: { output: { spillPaths: ['F:/o.txt'] } },
    }));
    const state = stubCtx({ jobs });
    state.shell.execute.mockResolvedValue(execution);
    const { exec } = fakeExec();
    const value = (await state.tool.execute(
      {
        command: 'sleep 30sec',
        description: '长任务',
        timeoutMs: 1_234,
      },
      exec,
    )) as NushellToolOutput;
    expect(value).toEqual({
      kind: 'promoted',
      jobId: 'nushell-1',
      timeoutMs: 1_234,
      output: 'partial \n[stderr]\nwarn',
    });
    // 升格不杀进程、不移除记录:模型仍可用 job_output/job_kill 跟进。
    expect(execution.kill).not.toHaveBeenCalled();
    expect(jobs.remove).not.toHaveBeenCalled();
  });

  it('等待期内结算:移除记录并走前台 canonical 结果', async () => {
    const execution = fakeExecution({
      exitCode: 0,
      stdout: { text: 'done', truncated: false },
    });
    execution.settle({ exitCode: 0, signal: null });
    const { jobs } = stubJobs();
    jobs.wait = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { status: 'completed', detail: 'exit code: 0' };
    });
    const state = stubCtx({ jobs });
    state.shell.execute.mockResolvedValue(execution);
    const { exec } = fakeExec();
    const value = (await state.tool.execute(
      { command: 'ls', description: '列目录' },
      exec,
    )) as NushellForegroundOutput;
    expect(jobs.remove).toHaveBeenCalledWith('nushell-1', undefined);
    expect(value).toEqual({
      kind: 'foreground',
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 30_000,
      stdout: { text: 'done', truncated: false },
      stderr: { text: '', truncated: false },
    });
  });

  it('等待被调用方取消:停掉 job 并抛 AbortError', async () => {
    const execution = fakeExecution();
    const { jobs } = stubJobs();
    const { exec } = fakeExec();
    // 第一次 wait(携带调用方 signal)被取消打断;stop 的后续 wait 正常返回。
    let waitCalls = 0;
    jobs.wait = vi.fn(async () => {
      waitCalls += 1;
      if (waitCalls === 1) {
        throw new Error('wait aborted');
      }
      return { status: 'killed', detail: 'tool call aborted' };
    });
    const state = stubCtx({ jobs });
    state.shell.execute.mockResolvedValue(execution);
    await expect(
      state.tool.execute({ command: 'ls', description: '列目录' }, exec),
    ).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
    expect(jobs.kill).toHaveBeenCalledWith(
      'nushell-1',
      undefined,
      'tool call aborted',
    );
  });

  it('promoteOnTimeout: false 时前台直接走 execute 杀路径', async () => {
    const { jobs } = stubJobs();
    const state = stubCtx({
      jobs,
      config: { promoteOnTimeout: false },
    });
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground() as unknown as ShellRunResult),
    });
    const { exec } = fakeExec();
    await state.tool.execute({ command: 'ls', description: '列目录' }, exec);
    expect(jobs.start).not.toHaveBeenCalled();
    expect(state.shell.execute).toHaveBeenCalledTimes(1);
  });

  it('job 注册被拒时降级前台执行(logger.warn 提示)', async () => {
    const { jobs } = stubJobs();
    jobs.start = vi.fn(() => {
      throw new Error('admission refused');
    });
    const warn = vi.fn();
    const state = stubCtx({ jobs });
    (state.ctx as unknown as { logger?: unknown }).logger = { warn };
    state.shell.execute.mockResolvedValue({
      result: vi.fn(async () => foreground() as unknown as ShellRunResult),
    });
    const { exec } = fakeExec();
    await state.tool.execute({ command: 'ls', description: '列目录' }, exec);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('job registration refused'),
    );
    expect(state.shell.execute).toHaveBeenCalledTimes(1);
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

  it('presentResult:前台结果渲染终端卡片并经 parseExitStatus 反解退出状态', () => {
    const state = stubCtx();
    const meta: NushellToolOutput = foreground({
      exitCode: 2,
      stdout: { text: 'out', truncated: false },
      stderr: { text: 'oops', truncated: false },
    });
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

  it('presentResult:信号终止携带 signal,后台/升格结果降级 console 卡片', () => {
    const state = stubCtx();
    const meta: NushellToolOutput = foreground({
      exitCode: null,
      signal: 'SIGTERM',
      stdout: { text: '', truncated: false },
    });
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
    const promoted: NushellToolOutput = {
      kind: 'promoted',
      jobId: 'nushell-4',
      timeoutMs: 5_000,
      output: 'partial',
    };
    expect(
      state.tool.presentResult?.(
        { command: 'sleep', description: '长任务' },
        {
          content: [{ type: 'text', text: renderNushellResult(promoted) }],
          isError: false,
          meta: promoted,
        },
      ),
    ).toEqual({
      card: 'generic',
      content: [
        {
          type: 'text',
          text: expect.stringContaining('moved to background job nushell-4'),
        },
      ],
    });
  });
});

describe('超时预算常量', () => {
  it('工具层保留默认/上限文案常量,默认超时交由 executor 预算', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(MAX_TIMEOUT_MS).toBe(600_000);
  });
});

describe('直跑模式(单装本包,不占接缝)', () => {
  function fakeExecSignal(): ToolRunContext {
    return {
      callId: 'call-direct',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext;
  }

  it('官方 shell 占缝时探针无视:直跑经 subprocess,不经 ctx.shell', async () => {
    const spawn = vi.fn((spec: { argv: string[] }) => {
      // 只断言选路与 argv 拼装;spawn 合同细节由执行器套件覆盖。
      expect(spec.argv).toEqual(['mynu', '--no-config-file', '-c', '1 + 1']);
      throw new Error('direct-spawn');
    });
    const state = stubCtx({
      seamRuntime: false,
      subprocessSpawn: spawn,
      config: { executor: { nuPath: 'mynu' } },
    });
    state.shell.execute.mockImplementation(() => {
      throw new Error('seam must not be used');
    });
    await expect(
      state.tool.execute(
        { command: '1 + 1', description: '算术' },
        fakeExecSignal(),
      ),
    ).rejects.toThrow('direct-spawn');
    expect(state.shell.execute).not.toHaveBeenCalled();
  });

  it('沙箱栈在时内部执行器选 confining 形态:confine 在准备期被调用', async () => {
    const confine = vi.fn(async () => {
      throw new Error('confine-invoked');
    });
    const state = stubCtx({
      seamRuntime: false,
      sandbox: { confine },
      sandboxMode: 'workspace-write',
      sandboxPolicyResolve: vi.fn(() => ({
        mode: 'workspace-write',
        workspaceRoot: 'E:/tmp',
      })),
      subprocessSpawn: vi.fn(() => {
        throw new Error('spawn must not run before confine');
      }),
      config: { executor: { nuPath: 'nu' } },
    });
    await expect(
      state.tool.execute(
        { command: 'ls', description: '列目录' },
        fakeExecSignal(),
      ),
    ).rejects.toThrow('confine-invoked');
    expect(confine).toHaveBeenCalled();
    const confineArgv = (confine.mock.calls as unknown as [string[]][])[0]![0];
    expect(confineArgv).toEqual(['nu', '--no-config-file', '-c', 'ls']);
  });

  it('直跑本地形态下升权请求 fail-closed 拒绝', async () => {
    const state = stubCtx({
      seamRuntime: false,
      subprocessSpawn: vi.fn(),
      config: { executor: { nuPath: 'nu' } },
    });
    await expect(
      state.tool.execute(
        {
          command: 'ls',
          description: '列目录',
          sandbox_permissions: 'workspace-write',
          justification: '需要写工作区外文件',
        },
        fakeExecSignal(),
      ),
    ).rejects.toThrow(/no sandboxing executor to escalate/);
  });
});
