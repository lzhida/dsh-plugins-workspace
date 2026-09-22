import path from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import {
  apply,
  applyOutputFormat,
  canonicalNushellResult,
  DEFAULT_TIMEOUT_MS,
  inject,
  MAX_TIMEOUT_MS,
  name,
  nushellJobOutcome,
  renderNushellProcessRead,
  renderNushellResult,
  resolveWorkdir,
  validateNushellArgs,
  type Config,
  type NushellForegroundOutput,
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
  run: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
}

interface StubJobs {
  start(spec: Record<string, unknown>): string;
}

interface StubState {
  registered: AppliedTool[];
  disposers: Array<ReturnType<typeof vi.fn>>;
  cleanups: Array<() => void>;
  tool: AppliedTool;
  /** 注册工具的 parameters schema(直通 definition)。 */
  schema: AppliedTool['parameters'];
  sections: Array<{ name: string; order: number; text: string }>;
  collectCalls: unknown[];
  shell: StubShell;
}

interface StubOptions {
  jobs?: StubJobs;
  dshEnv?: Record<string, string>;
  config?: Config;
  /** ctx.shell.sandboxMode:confining executor 探测结果。 */
  sandboxMode?: string;
  /** ctx.get('sandboxPolicy'):共享策略服务假体。 */
  sandboxPolicyResolve?: ReturnType<typeof vi.fn>;
  /** ctx.get('approval'):审批通道假体。 */
  approval?: unknown;
}

/** identity resolve:spec 即 request,断言直接针对构造的请求形状。 */
function stubShell(): StubShell {
  return {
    resolve: vi.fn(
      (request: ShellExecRequest) => request as unknown as ShellExecSpec,
    ),
    run: vi.fn(),
    start: vi.fn(),
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
        : key === 'sandboxPolicy'
          ? options.sandboxPolicyResolve !== undefined
            ? { resolve: options.sandboxPolicyResolve }
            : undefined
          : key === 'approval'
            ? options.approval
            : undefined,
    ),
    shell: Object.assign(shell, {
      sandboxMode: options.sandboxMode,
    }),
  } as unknown as Context;
  apply(ctx, options.config);
  return {
    registered,
    disposers,
    cleanups,
    tool: registered[0]!,
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

/** 后台 shell 进程假体:done 手动结算,readOutput/kill 可断言。 */
function fakeProc(
  stdoutDelta = '',
  lossy = false,
): ShellProcess & {
  settle: (outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void;
  kill: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
} {
  const kill = vi.fn();
  const read = vi.fn(() => ({ delta: stdoutDelta, lossy }));
  let settleDone: (outcome: {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }) => void = () => {};
  const proc = {
    status: 'running',
    exitCode: null,
    signal: null,
    readOutput: read,
    kill,
  } as unknown as ShellProcess & {
    settle: typeof settleDone;
    kill: typeof kill;
    read: typeof read;
  };
  // ShellProcess.done 只读:经 Object.assign 注入手动结算的 promise。
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
  proc.settle = settleDone;
  proc.read = read;
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

describe('dsh-tool-nushell 契约', () => {
  it('导出 loader 依赖的插件符号', () => {
    expect(name).toBe('dsh-tool-nushell');
    expect(inject).toEqual(['tools', 'systemPrompt', 'shellEnv', 'shell']);
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

  it('工具经 effect 登记:卸载时注销工具', () => {
    const state = stubCtx();
    expect(state.cleanups).toHaveLength(1);
    state.cleanups[0]!();
    expect(state.disposers[0]).toHaveBeenCalled();
  });

  it('调用方取消以 AbortError 中止(HarnessError/TOOL_ABORTED 语义)', async () => {
    const state = stubCtx();
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
    const agent = { session: { header: { cwd: 'F:/session' } } };
    const exec = { agent } as unknown as ToolRunContext;
    const bare = { agent: undefined } as unknown as ToolRunContext;
    expect(resolveWorkdir(undefined, exec)).toBe('F:/session');
    expect(resolveWorkdir(undefined, bare)).toBeUndefined();
    expect(resolveWorkdir('sub/dir', exec)).toBe('F:\\session\\sub\\dir');
    expect(resolveWorkdir('F:/abs', exec)).toBe('F:/abs');
  });

  it('validateNushellArgs 拒绝非法 outputFormat,合法值放行', () => {
    expect(() =>
      validateNushellArgs({
        command: 'ls',
        description: 'ok',
        outputFormat: 'xml' as never,
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
});

describe('结构化输出与 stdin', () => {
  it('前台请求应用 outputFormat 包装并透传 stdin', async () => {
    const state = stubCtx();
    state.shell.run.mockResolvedValue(foreground());
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
  });

  it('后台请求同样应用包装,label 保留原始命令', async () => {
    const jobs: StubJobs = { start: vi.fn(() => 'job-1') };
    const state = stubCtx({ jobs });
    state.shell.start.mockReturnValue(fakeProc());
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
    expect(jobs.start).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'open a.csv | length' }),
    );
  });

  it('outputFormat 缺省时请求命令保持原样(stdin 仍透传)', async () => {
    const state = stubCtx();
    state.shell.run.mockResolvedValue(foreground());
    const { exec } = fakeExec();
    await state.tool.execute(
      { command: 'ls', description: '列目录', stdin: 'x' },
      exec,
    );
    const request = state.shell.resolve.mock
      .calls[0][0] as unknown as ShellExecRequest;
    expect(request.command).toBe('ls');
    expect(request.stdin).toBe('x');
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
  it('execute 经 ctx.shell.resolve/run,请求携带 workdir/timeoutMs/DSH_*', async () => {
    const foregroundResult = foreground({
      exitCode: 2,
      stdout: { text: 'out', truncated: false },
    });
    const state = stubCtx({ dshEnv: { DSH_SESSION_ID: 's1' } });
    state.shell.run.mockResolvedValue(foregroundResult);
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
    expect(state.shell.resolve).toHaveBeenCalledTimes(1);
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request).toMatchObject({
      command: 'ls',
      workdir: 'F:/work',
      timeoutMs: 1_000,
      dshEnv: { DSH_SESSION_ID: 's1' },
    });
    expect(state.shell.run).toHaveBeenCalledWith(
      state.shell.resolve.mock.results[0]!.value,
    );
    expect(value).toEqual(foregroundResult);
    expect(state.collectCalls).toHaveLength(1);
    expect(state.collectCalls[0]).toBe(exec);
  });

  it('result.aborted 时以 AbortError 中止', async () => {
    const state = stubCtx();
    state.shell.run.mockResolvedValue({
      ...foreground(),
      aborted: true,
      signal: 'SIGTERM',
      exitCode: null,
    } satisfies ShellRunResult);
    const { exec } = fakeExec();
    await expect(
      state.tool.execute({ command: 'ls', description: '列目录' }, exec),
    ).rejects.toMatchObject({ code: 'ABORTED', name: 'AbortError' });
  });

  it('无 workdir 时请求不带 workdir,默认超时由 executor 预算', async () => {
    const state = stubCtx();
    state.shell.run.mockResolvedValue(foreground());
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
    // state.schema 即编译后 JSON Schema:{type:'object', properties, required}。
    const plain = state.schema as unknown as {
      properties: Record<string, unknown>;
    };
    expect(plain.properties.sandbox_permissions).toBeUndefined();
    expect(plain.properties.justification).toBeUndefined();
    state.shell.run.mockResolvedValue(foreground());
    const { exec } = fakeExec();
    await state.tool.execute({ command: 'ls', description: '列目录' }, exec);
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request.sandboxPolicy).toBeUndefined();
  });

  it('confining executor 缺共享策略服务时 apply 失败', () => {
    expect(() => stubCtx({ sandboxMode: 'read-only' })).toThrow(
      'ctx.sandboxPolicy is missing',
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
    // canonicalNushellResult 在 confining 组合下输出 sandbox 字段,
    // additionalProperties:false 的声明必须覆盖之(否则校验失败)。
    const state = stubCtx();
    const foreground = foregroundBranchOf(state.registered[0]!.output!.schema);
    // 编译器把字段级 required:true 折叠为对象级 required 数组。
    expect(foreground.properties!.sandbox).toEqual({
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

  it('confining 前台输出经官方校验器零违规(声明覆盖实际输出)', () => {
    // 运行期 dsh 核心对每个成功返回值跑 validateJsonSchemaValue,违规即
    // ToolOutputError——confining 组合输出恒带 sandbox,必须通过校验。
    const state = stubCtx();
    const foreground = foregroundBranchOf(state.registered[0]!.output!.schema);
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
      validateJsonSchemaValue(foreground as never, confining, 'value'),
    ).toEqual([]);
    // 防空转:声明外键必须被同一校验器抓到。
    const violations = validateJsonSchemaValue(
      foreground as never,
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
    // schema 公布升权字段(编译后 JSON Schema;枚举为完整升权目标词汇)。
    const properties = state.schema as unknown as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(properties.properties.sandbox_permissions).toMatchObject({
      enum: ['workspace-write', 'danger-full-access'],
    });
    expect(properties.properties.justification).toBeDefined();
    const { exec } = fakeExec({ session: { id: 's1' } });
    state.shell.run.mockResolvedValue(foreground());
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
    state.shell.run.mockResolvedValue(foreground());
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
    state.shell.run.mockResolvedValue(foreground());
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
    expect(state.shell.run).not.toHaveBeenCalled();
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
    expect(
      renderNushellProcessRead(
        { delta: 'x', lossy: false },
        { mode: 'read-only', denied: true },
        ['workspace-write'],
      ),
    ).toBe(
      'x\n[sandbox: file access denied under read-only mode]\n' +
        '[sandbox: escalation available — retry this exact command once with ' +
        'sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
    );
  });

  it('canonical 输出透传沙箱事实,非沙箱结果不带字段', () => {
    expect(
      canonicalNushellResult(foreground() as unknown as ShellRunResult).sandbox,
    ).toBeUndefined();
    const result = canonicalNushellResult({
      kind: 'foreground',
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
    } as unknown as ShellRunResult);
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

  it('canonicalNushellResult 透传 shell 结果并保持 aborted=false', () => {
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
      aborted: false,
      timeoutMs: 2_000,
      stdout: { text: 'a', truncated: true, spillPath: 'F:/s' },
      stderr: { text: '', truncated: false },
    });
  });

  it('后台句柄渲染 started background job', () => {
    const value: NushellToolOutput = { kind: 'background', jobId: 'nushell-3' };
    expect(renderNushellResult(value)).toBe('started background job nushell-3');
  });

  it('nushellJobOutcome 映射 killed/completed;renderNushellProcessRead 附有损提示', () => {
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
      nushellJobOutcome({ status: 'killed', exitCode: null, signal: null }),
    ).toEqual({
      status: 'killed',
      detail: 'killed before exit',
    });
    expect(
      nushellJobOutcome({ status: 'completed', exitCode: 3, signal: null }),
    ).toEqual({
      status: 'completed',
      detail: 'exit code: 3',
    });
    expect(renderNushellProcessRead({ delta: 'chunk', lossy: false })).toBe(
      'chunk',
    );
    expect(
      renderNushellProcessRead({
        delta: 'chunk',
        lossy: true,
        stdoutSpillPath: 'F:/o.txt',
      }),
    ).toBe(
      'chunk\n[some output was dropped from memory; full output: F:/o.txt]',
    );
    expect(renderNushellProcessRead({ delta: 'chunk', lossy: true })).toBe(
      'chunk\n[some output was dropped from memory; full output: (unavailable)]',
    );
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

  it('run_in_background 经 ctx.shell.start 返回 job 句柄', async () => {
    const proc = fakeProc();
    const { jobs, starts } = setupJobs();
    const state = stubCtx({ jobs });
    state.shell.start.mockReturnValue(proc);
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
    const request = state.shell.resolve.mock.calls[0]![0] as ShellExecRequest;
    expect(request).toMatchObject({
      command: 'sleep 5sec | print',
      workdir: path.resolve('F:/session', 'sub'),
    });
    expect(request.timeoutMs).toBeUndefined();
    expect(state.shell.start).toHaveBeenCalledTimes(1);
  });

  it('job 句柄:cancel 转发 kill,readOutput 走渲染,done 结算 outcome', async () => {
    const proc = fakeProc('partial ');
    const { jobs } = setupJobs();
    const state = stubCtx({ jobs });
    state.shell.start.mockReturnValue(proc);
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
      run(): {
        cancel(reason?: string): void;
        done: Promise<{ status: string; detail?: string }>;
        readOutput(): string;
      };
    };
    const hooks = spec.run();
    proc.read.mockReturnValue({ delta: 'chunk ', lossy: false });
    expect(hooks.readOutput()).toBe('chunk ');
    hooks.cancel();
    expect(proc.kill).toHaveBeenCalled();
    proc.settle({ exitCode: 3, signal: null });
    await expect(hooks.done).resolves.toEqual({
      status: 'completed',
      detail: 'exit code: 3',
    });
  });

  it('信号终止的后台进程结算为 killed', async () => {
    const proc = fakeProc();
    const { jobs } = setupJobs();
    const state = stubCtx({ jobs });
    state.shell.start.mockReturnValue(proc);
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
    proc.settle({ exitCode: null, signal: 'SIGTERM' });
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

  it('presentResult:信号终止携带 signal,后台结果降级 console 卡片', () => {
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

describe('超时预算常量', () => {
  it('工具层保留默认/上限文案常量,默认超时交由 executor 预算', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(MAX_TIMEOUT_MS).toBe(600_000);
  });
});
