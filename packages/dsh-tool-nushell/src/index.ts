import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type {
  ShellExecRequest,
  ShellExecutor,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell';
import {
  approveEscalation,
  escalationHintMarker,
  ESCALATION_TARGETS,
  sandboxDenialMarker,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { SandboxEnforcement, SandboxMode } from '@deepseek-ai/dsh-sandbox';
import {
  defineTool,
  TOOL_ABORTED,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { NUSHELL_RUNTIME } from './executor-runtime.ts';
import {
  NushellLocalExecutor,
  type NushellLocalConfig,
} from './executor-local.ts';
import { NushellSandboxExecutor } from './executor-sandbox.ts';

export const name = 'dsh-tool-nushell';
export const inject = ['tools', 'systemPrompt', 'shellEnv', 'subprocess'];

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    nushell: 'nushell';
  }
}

/**
 * tool-nushell:为 DeepSeek Harness 注册独立的 `nushell` 工具。双模执行:
 * - 直跑模式(单装本包):内置执行器实例经 `ctx.subprocess` 直接 spawn
 *   `nu --no-config-file -c`,不占 `ctx.shell` 接缝——官方 shell 家族、
 *   agent 预设与 permission 栈零改动;宿主沙箱栈在时选 confining 形态,
 *   nu 命令照常受约束。
 * - 接缝模式(另装 nushell-local/nushell-sandbox):探针认出带
 *   `NUSHELL_RUNTIME` 标记的 `ctx.shell` 并优先采用,即完全替换模式。
 * 本插件负责模型契约(参数校验、canonical 输出、marker 渲染、后台
 * job、系统提示 section、UI 呈现);能力面与官方 tool-pwsh 对齐,沙箱
 * 升权字段只在 confining 形态公布,词汇与审批次序复用共享的
 * dsh-sandbox escalation 通道。
 */

/** `nushell` 工具的结构化输出格式:非 text 时命令最终值经 nu 序列化返回。 */
export type NushellOutputFormat = 'json' | 'nuon' | 'text';

/** `nushell` 工具的模型参数(形状与 parameters schema 一致)。 */
export interface NushellArgs {
  command: string;
  description: string;
  timeoutMs?: number;
  workdir?: string;
  run_in_background?: boolean;
  outputFormat?: NushellOutputFormat;
  stdin?: string;
  /** 升权目标模式;只在挂载 confining executor 的组合里公布。 */
  sandbox_permissions?: string;
  /** 升权理由;与 sandbox_permissions 配对必填。 */
  justification?: string;
}

/** 单流输出的 canonical 形态:模型可见文本 + 截断标记 + 完整输出落盘路径。 */
export interface NushellStreamOutput {
  text: string;
  truncated: boolean;
  spillPath?: string;
}

/** 前台运行的 canonical 输出(字段集对齐官方 tool-bash/pwsh foreground 分支)。 */
export interface NushellForegroundOutput {
  kind: 'foreground';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  stdout: NushellStreamOutput;
  stderr: NushellStreamOutput;
  /** 沙箱事实;非沙箱 executor 不携带。 */
  sandbox?: {
    mode: SandboxMode;
    denied: boolean;
    enforcement?: SandboxEnforcement;
    runnerFailed?: boolean;
  };
}

/** `nushell` 工具的 canonical 输出(oneOf:后台句柄 | 前台结果)。 */
export type NushellToolOutput =
  { kind: 'background'; jobId: string } | NushellForegroundOutput;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
/** 系统提示 section 位置:SECTION_ORDERS.TOOL_PWSH(1010)与 TOOL_READ(1100)之间的空位。 */
const NUSHELL_SECTION_ORDER = 1015;

/**
 * 语义校验(文案对齐官方 validatePwshArgs);schema 校验由 defineTool 负责。
 * 参数接受 defineTool 从 parameters schema 推导的宽形状——outputFormat
 * 值域在此收窄为三值枚举,canonical 类型(NushellArgs)由调用方持有。
 */
export function validateNushellArgs(
  args: Omit<NushellArgs, 'outputFormat'> & { outputFormat?: string },
): void {
  if (args.command.trim().length === 0) {
    throw new Error('invalid command: expected a non-empty string');
  }
  if (args.description.trim().length === 0) {
    throw new Error('invalid description: expected a non-empty string');
  }
  if (
    args.timeoutMs !== undefined &&
    (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0)
  ) {
    throw new Error(
      `invalid timeoutMs: expected a positive number, got ${JSON.stringify(args.timeoutMs)}`,
    );
  }
  if (
    args.outputFormat !== undefined &&
    args.outputFormat !== 'json' &&
    args.outputFormat !== 'nuon' &&
    args.outputFormat !== 'text'
  ) {
    throw new Error(
      `invalid outputFormat: expected 'json', 'nuon' or 'text', got ${JSON.stringify(args.outputFormat)}`,
    );
  }
}

/**
 * 结构化输出包装:非 text 时把命令包进 `do { … }` 块并对最终值求
 * `to json --raw`/`to nuon`——do 块保证多语句命令整体求值(直接管道
 * 只会作用于末语句),最后表达式的值(nu 任意类型)被序列化为机器可读
 * 文本;副作用(print/环境修改/save)行为不变,文本仍走原 stdout。
 * format 为 json/nuon 之外的值(含缺省)一律按 text 原样返回;值域
 * 校验由 validateNushellArgs 负责,此处防御性回退。
 */
export function applyOutputFormat(
  command: string,
  format: string | undefined,
): string {
  if (format === 'json') {
    return `do { ${command} } | to json --raw`;
  }
  if (format === 'nuon') {
    return `do { ${command} } | to nuon`;
  }
  return command;
}

/** 会话工作目录载体(窄化访问,避免对 dsh-agent 的类型依赖)。 */
interface SessionCwdCarrier {
  session?: { header?: { cwd?: string } };
}

/**
 * 解析显式 workdir:相对路径基于会话工作目录;未给时回退会话工作目录,
 * 再由 executor 默认进程 cwd。语义对齐官方 resolveWorkdir。
 */
export function resolveWorkdir(
  workdir: string | undefined,
  exec: ToolRunContext,
): string | undefined {
  const headerCwd = (exec.agent as unknown as SessionCwdCarrier | undefined)
    ?.session?.header?.cwd;
  if (workdir === undefined) {
    return headerCwd;
  }
  if (headerCwd !== undefined && !path.isAbsolute(workdir)) {
    return path.resolve(headerCwd, workdir);
  }
  return workdir;
}

function abortError(): Error {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED);
  error.name = 'AbortError';
  return error;
}

function collectShellEnv(
  ctx: Context,
  exec: ToolRunContext,
): Record<string, string> {
  const registry = (
    ctx as unknown as {
      shellEnv?: { collect(e: ToolRunContext): Record<string, string> };
    }
  ).shellEnv;
  return registry?.collect(exec) ?? {};
}

/** 后台 job 注册契约(窄化 ctx.get('jobs') 的返回,避免对宿主类型布局的依赖)。 */
interface NushellJobRegistry {
  start(spec: {
    kind: 'nushell';
    label: string;
    owner?: unknown;
    run(): JobHooks;
  }): string;
}

function getJobs(ctx: Context): NushellJobRegistry | undefined {
  return (ctx as unknown as { get?(key: string): unknown }).get?.('jobs') as
    NushellJobRegistry | undefined;
}

/** 共享沙箱策略服务(窄化访问,避免对宿主类型布局的依赖)。 */
interface NushellPolicyService {
  resolve(request?: { session?: unknown }): SandboxExecutionPolicy;
}

function getPolicyService(ctx: Context): NushellPolicyService | undefined {
  return (ctx as unknown as { get?(key: string): unknown }).get?.(
    'sandboxPolicy',
  ) as NushellPolicyService | undefined;
}

/** 用户审批通道(EscalationApprover 的最小结构形状)。 */
type ApprovalChannel = Parameters<typeof approveEscalation>[1]['approver'];

function getApproval(ctx: Context): ApprovalChannel | undefined {
  return (ctx as unknown as { get?(key: string): unknown }).get?.(
    'approval',
  ) as ApprovalChannel | undefined;
}

/** 后台进程结算 → job outcome;信号终止记 killed,非零退出照报不判失败。 */
export function nushellJobOutcome(
  proc: Pick<ShellProcess, 'status' | 'exitCode' | 'signal'>,
): JobOutcome {
  if (proc.status === 'killed') {
    return {
      status: 'killed',
      detail:
        proc.signal !== null ? `signal: ${proc.signal}` : 'killed before exit',
    };
  }
  return { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` };
}

/**
 * 后台增量读 → `job_output` delta;有损读附 spill 路径提示,沙箱事实
 * (runner 失败优先于策略拒绝)按官方 renderProcessRead 语义附注。
 */
export function renderNushellProcessRead(
  read: ShellProcessRead,
  sandbox?: ShellSandboxInfo,
  escalationModes: readonly string[] = [],
): string {
  const notices: string[] = [];
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter(
      (p) => p !== undefined,
    );
    notices.push(
      `[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`,
    );
  }
  if (sandbox?.runnerFailed) {
    notices.push(
      `[sandbox: the sandbox runner itself failed under ${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
    );
  } else if (sandbox?.denied) {
    notices.push(sandboxDenialMarker(sandbox.mode));
    if (escalationModes.length > 0) {
      notices.push(escalationHintMarker('command'));
    }
  }
  if (notices.length === 0) {
    return read.delta;
  }
  const glue = read.delta.length > 0 && !read.delta.endsWith('\n') ? '\n' : '';
  return `${read.delta}${glue}${notices.join('\n')}`;
}

/** 前台 shell 结果 → canonical 输出(aborted 恒 false:取消走 reject 路径)。 */
export function canonicalNushellResult(
  result: ShellRunResult,
): NushellForegroundOutput {
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: false,
    timeoutMs: result.timeoutMs,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.sandbox !== undefined
      ? {
          sandbox: {
            mode: result.sandbox.mode,
            denied: result.sandbox.denied,
            ...(result.sandbox.enforcement !== undefined
              ? { enforcement: result.sandbox.enforcement }
              : {}),
            ...(result.sandbox.runnerFailed !== undefined
              ? { runnerFailed: result.sandbox.runnerFailed }
              : {}),
          },
        }
      : {}),
  };
}

/** 截断注记(含完整输出 spill 路径),对齐官方 streamText。 */
function streamText(output: NushellStreamOutput): string {
  if (!output.truncated) {
    return output.text;
  }
  return `${output.text}\n[output truncated; full output: ${output.spillPath ?? '(unavailable)'}]`;
}

/** 输出主体:stdout、[stderr] 段、空输出占位——不带退出状态 marker。 */
export function renderNushellBody(value: NushellForegroundOutput): string {
  const out = streamText(value.stdout);
  const err = streamText(value.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) {
      body += '\n';
    }
    body += `[stderr]\n${err}`;
  }
  if (body.length === 0) {
    return '(no output)';
  }
  return body;
}

/**
 * canonical 输出 → 模型可见文本:主体 + 沙箱拒绝/runner 失败、timeout/
 * signal/exit marker,干净退出(0、无信号)无 marker——对齐官方
 * renderResult(拒绝 marker 位于状态 marker 之前,升权 hint 只在
 * 公布了升权字段的组合里追加)。
 */
export function renderNushellResult(
  value: NushellToolOutput,
  escalationModes: readonly string[] = [],
): string {
  if (value.kind === 'background') {
    return `started background job ${value.jobId}`;
  }
  let body = renderNushellBody(value);
  const markers: string[] = [];
  if (value.sandbox?.runnerFailed) {
    markers.push(
      `[sandbox: the sandbox runner itself failed under ${value.sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
    );
  } else if (value.sandbox?.denied) {
    markers.push(sandboxDenialMarker(value.sandbox.mode));
    if (escalationModes.length > 0) {
      markers.push(escalationHintMarker('command'));
    }
  }
  if (value.timedOut) {
    markers.push(`[timed out after ${value.timeoutMs}ms]`);
  }
  if (value.signal !== null) {
    markers.push(`[killed by signal: ${value.signal}]`);
  } else if (value.exitCode !== 0) {
    markers.push(`[exit code: ${value.exitCode}]`);
  }
  if (markers.length === 0) {
    return body;
  }
  if (!body.endsWith('\n')) {
    body += '\n';
  }
  return body + markers.join('\n');
}

/** 插件运行时配置;enableRunInBackground 默认开启,对齐官方 Config 语义。 */
export interface Config {
  enableRunInBackground?: boolean;
  /**
   * 内部直跑执行器的配置透传(nuPath/cwd/超时与输出预算);仅在直跑
   * 模式读取,接缝模式由执行器组合行的自身配置接管。
   */
  executor?: NushellLocalConfig;
}

export function apply(ctx: Context, config: Config = {}): void {
  console.log(`[${name}] plugin loaded`);
  const backgroundEnabled = config.enableRunInBackground ?? true;

  // ── 执行器选路(双模核心)──────────────────────────────────────────
  // 直跑模式:本包内置执行器实例(subprocess 直 spawn nu),不占
  // ctx.shell 接缝——只装本包时官方 shell 家族、官方 agent 预设与
  // permission 栈原封不动。宿主具备沙箱栈(base 组合恒备)时选
  // confining 形态,nu 命令照常受 workspace-write 约束与升权审批。
  // 接缝模式:显式安装 nushell-local/sandbox 执行器后,探针认出带
  // nushell runtime 标记的 ctx.shell 并优先采用(完全替换模式);
  // 官方 pwsh/bash 执行器不带标记,占据接缝时保持无视(nu 语义不能
  // 经官方 shell 跑),这也是官方预设不被本插件牵连的关键。
  let seam: ShellExecutor | undefined;
  ctx.inject(['shell'], (shellCtx) => {
    const candidate = shellCtx.shell as unknown as { runtime?: unknown };
    if (candidate?.runtime !== NUSHELL_RUNTIME) {
      return;
    }
    seam = shellCtx.shell;
    shellCtx.effect(
      () => () => {
        seam = undefined;
      },
      'tool-nushell: nushell shell seam detach',
    );
  });

  // 沙箱组合探测(官方语义:只在 confining 形态公布升权字段;组合分裂
  // ——confining 在而共享策略服务缺——load 即 fail loud)。
  const sandboxPolicy = getPolicyService(ctx);
  const sandboxStackPresent =
    ctx.get('sandbox') !== undefined && sandboxPolicy !== undefined;
  const seamConfining = seam?.sandboxMode !== undefined;
  if ((seamConfining || sandboxStackPresent) && sandboxPolicy === undefined) {
    throw new Error(
      'tool-nushell: a confining composition is present but ctx.sandboxPolicy is unresolvable',
    );
  }
  /** 内部直跑执行器(惰性:接缝模式建立后永不构造,nuPath 扫描零开销)。 */
  let internal: NushellLocalExecutor | NushellSandboxExecutor | undefined;
  const getInternal = (): NushellLocalExecutor | NushellSandboxExecutor => {
    if (internal === undefined) {
      const executorConfig = config.executor ?? {};
      // 内部直跑实例不得注册任何服务(尤其不能污染 ctx.shell 接缝),而
      // Service 基类构造必经 ctx.reflect.provide。生产 ctx 是 cordis 代理:
      // 未声明的服务属性直读会被拒("cannot get property X without
      // inject"),代理派生伪装 reflect 又踩内部方法陷阱。故用最小服务
      // 载体:服务经 ctx.get()(load 期已验证可行)取值后以普通属性挂载,
      // inject/reflect 一律无操作。代价:直跑模式不支持设置层热更新
      // nuPath,静态配置走 Config.executor。
      const sandboxService = ctx.get('sandbox');
      const policyService = ctx.get('sandboxPolicy');
      const serviceCtx = {
        subprocess: ctx.subprocess,
        ...(sandboxService !== undefined ? { sandbox: sandboxService } : {}),
        ...(policyService !== undefined
          ? { sandboxPolicy: policyService }
          : {}),
        inject: () => {},
        reflect: { provide: () => {} },
      } as unknown as Context;
      internal = sandboxStackPresent
        ? new NushellSandboxExecutor(serviceCtx, executorConfig)
        : new NushellLocalExecutor(serviceCtx, executorConfig);
    }
    return internal;
  };
  /** 本次调用的执行器:已挂载的 nushell 接缝优先,否则内部直跑实例。 */
  const activeExecutor = (): ShellExecutor => seam ?? getInternal();
  /** 活跃执行器是否真在 confinement(升权的运行时事实,fail-closed)。 */
  const activeConfining = (): boolean =>
    activeExecutor().sandboxMode !== undefined;
  // 注册期公布面:接缝 confining 或沙箱栈在即公布升权字段;运行期以
  // activeConfining 为准。
  const escalationModes =
    seamConfining || sandboxStackPresent ? [...ESCALATION_TARGETS] : [];
  /** confining 组合下解析本次调用的完整 standing policy。 */
  const resolveSandboxPolicy = (
    exec: ToolRunContext,
  ): SandboxExecutionPolicy | undefined =>
    sandboxPolicy?.resolve(
      exec.agent === undefined ? {} : { session: exec.agent.session },
    );
  /**
   * 在任何执行发生前把升权请求走完共享的 fail-closed 审批序列
   * (严格放宽、通道解析、结果映射),本工具只贡献组合守卫与审批材料。
   */
  const approveNushellEscalation = async (
    mode: string,
    justification: string,
    exec: ToolRunContext,
    standingPolicy: SandboxExecutionPolicy,
  ): Promise<SandboxExecutionPolicy['mode']> => {
    if (!activeConfining()) {
      throw new Error(
        'sandbox_permissions is not available in this composition (no sandboxing executor to escalate)',
      );
    }
    const approver = getApproval(ctx);
    if (approver === undefined) {
      throw new Error(
        'sandbox_permissions is not available in this composition (no approval channel)',
      );
    }
    return approveEscalation(
      {
        requestedMode: mode,
        justification,
        effectiveMode: standingPolicy.mode,
        subject: 'command',
      },
      {
        approver,
        agent: exec.agent,
        callId: exec.callId,
        toolName: 'nushell',
        signal: exec.signal,
      },
    );
  };

  ctx.effect(() => {
    // 系统提示 section:解释退出码 marker 语义(位置紧邻官方 pwsh section)。
    (
      ctx as unknown as {
        systemPrompt?: {
          section(s: { name: string; order: number; text: string }): unknown;
        };
      }
    ).systemPrompt?.section({
      name: 'tool:nushell',
      order: NUSHELL_SECTION_ORDER,
      text:
        'The `nushell` tool runs Nushell (nu) source via `nu --no-config-file -c`. ' +
        'Write nu-native code: builtins and pipelines (`ls`, `glob`, `where`, `sort-by`, `get`, `select`, ' +
        '`each`, `open`, `save`, `lines`, `split row`, `uniq`, `length`). ' +
        'Do NOT shell out to `^cmd`, `^powershell`, or `^bash` for tasks nu covers — ' +
        'external calls lose structured pipelines and usually fail on quoting. ' +
        'Translations: cmd/bash `dir` → `ls`, `copy` → `cp`, `move` → `mv`, `del` → `rm`, ' +
        "`type`/`cat` → `open`, `findstr` → `where`/`find`, `echo x > f` → `'x' | save f`. " +
        "Windows paths: single quotes ('C:\\Users\\AI') or forward slashes (C:/Users/AI); " +
        'double-quoted strings process backslash escapes, so `\\U`, `\\A` etc. are parse errors. ' +
        'Environment variables read as `$env.NAME` (not `$env:NAME`); maybe-missing keys `$env.NAME? | default X`. ' +
        'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. ' +
        'A killed process is reported as `[killed by signal: X]` and a timeout as `[timed out after Nms]`. ' +
        'Each call runs in a fresh process: no state persists between calls — pass `workdir` instead of `cd`. ' +
        "Nu is parsed, not eval'd: command substitution `$(cmd)` does not exist — use `(cmd)`; " +
        'spread a command\'s output as arguments with `...(cmd)`; interpolate strings as `$"...(expr)"` ' +
        '(plain `"..."` never interpolates); no `&&` — separate with `;`; logical ops are keywords `and`/`or`; ' +
        'redirection is `out>`/`o+e>|` (not `>`/`2>&1`); discard output with `ignore`; ' +
        '`$?` is `$env.LAST_EXIT_CODE`, but prefer `do -i { ^cmd } | complete` for a struct {exit_code, stdout, stderr}. ' +
        '`mkdir` is recursive by default; `head -n`/`tail` are `first n`/`last`; text → table via `lines | split column`. ' +
        'For machine-readable results pass `outputFormat: "json"` (or pipe through `to json --raw`/`to nuon`) ' +
        'instead of parsing rendered tables. ' +
        (escalationModes.length > 0
          ? 'Commands run under a file sandbox; a blocked file operation is reported as ' +
            '`[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command. ' +
            'When a denial would clear with a wider mode, retry the exact same command once with `sandbox_permissions` ' +
            '(the narrowest wider mode that suffices) plus a one-sentence `justification`; never escalate speculatively.'
          : ''),
    });

    const nushellTool = defineTool({
      name: 'nushell',
      description:
        'Execute a Nushell command (`nu --no-config-file -c`) and return its stdout/stderr. ' +
        'Each call runs in a fresh nu process: no state (cwd, variables) persists between calls — ' +
        'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. ' +
        'Current harness environment facts are exposed through managed `DSH_*` environment variables. ' +
        'Long output is truncated; the full output is saved to a file whose path is reported. ' +
        'Write nu-native code — builtins and pipelines (`ls`, `glob`, `where`, `sort-by`, `open`, `save`, `get`, `length`). ' +
        'Do NOT shell out to `^cmd`/`^powershell`/`^bash` for tasks nu builtins cover, ' +
        'and do not use cmd/bash syntax (`dir`, `copy`, `move`, `del`, `type`, `findstr`, `echo x > f`). ' +
        "Windows paths: single quotes ('C:\\Users\\AI') or forward slashes (C:/Users/AI); " +
        'double-quoted strings process backslash escapes, so `\\U` is a parse error. ' +
        'Read env vars as `$env.NAME`. ' +
        'For machine-readable output (lists, records, tables) set `outputFormat` to "json"/"nuon" ' +
        'instead of parsing rendered tables. ' +
        (escalationModes.length > 0
          ? 'Commands may run under a file sandbox; a blocked file operation is reported as ' +
            '`[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. ' +
            'Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial.'
          : '') +
        ' Use it for nushell-native pipelines and structured data handling.',
      parameters: {
        command: {
          type: 'string',
          required: true,
          description:
            'Nu-native source: builtins and pipelines only; never shell out (`^cmd`, `^powershell`, `^bash`). ' +
            "No cmd/bash syntax (`dir`, `copy`, `type`, `echo x > f` → use `ls`, `cp`, `open`, `'x' | save f`). " +
            'No `$(cmd)` substitution (use `(cmd)`), no `&&` (use `;`), interpolation via `$"...(expr)"`. ' +
            'Windows paths in single quotes or with forward slashes; `\\U` etc. in double quotes are parse errors. ' +
            'Env vars: `$env.NAME`.',
        },
        description: {
          type: 'string',
          required: true,
          description:
            'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). ' +
            'Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status".',
        },
        timeoutMs: {
          type: 'number',
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); the process is killed on expiry.`,
        },
        workdir: {
          type: 'string',
          description:
            'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
        },
        outputFormat: {
          type: 'string',
          description:
            "Serialization of the command's final value: 'text' (default) returns raw stdout; " +
            "'json' pipes the final value through `to json --raw`; 'nuon' through `to nuon`. " +
            'Use "json" when the result is structured data (lists/records/tables) so it comes back machine-readable.',
        },
        stdin: {
          type: 'string',
          description:
            "Optional text piped to the command's stdin (e.g. input for a filter or a script read via `str join` after `lines`).",
        },
        ...(escalationModes.length > 0
          ? {
              sandbox_permissions: {
                type: 'string',
                enum: escalationModes,
                description:
                  'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
              },
              justification: {
                type: 'string',
                description:
                  'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
              },
            }
          : {}),
      },
      // 声明即承诺:execute 把 exec.signal 转发给 executor,可在预算内静默。
      timeoutMs: MAX_TIMEOUT_MS,
      // 无共享可变状态,进程级隔离,可并行调度。
      isConcurrencySafe: () => true,
      output: {
        schema: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'background' },
                jobId: { type: 'string', required: true },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, const: 'foreground' },
                exitCode: {
                  required: true,
                  oneOf: [{ type: 'integer' }, { type: 'null' }],
                },
                signal: {
                  required: true,
                  oneOf: [{ type: 'string' }, { type: 'null' }],
                },
                timedOut: { type: 'boolean', required: true },
                aborted: { type: 'boolean', required: true },
                timeoutMs: { type: 'number', required: true },
                stdout: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    spillPath: { type: 'string' },
                  },
                },
                stderr: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    text: { type: 'string', required: true },
                    truncated: { type: 'boolean', required: true },
                    spillPath: { type: 'string' },
                  },
                },
                // confining 组合下 canonicalNushellResult 会输出沙箱事实,
                // 声明必须覆盖实际输出(对齐官方 tool-bash 的 sandbox schema)。
                sandbox: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    mode: { type: 'string', required: true },
                    denied: { type: 'boolean', required: true },
                    enforcement: { type: 'string' },
                    runnerFailed: { type: 'boolean' },
                  },
                },
              },
            },
          ],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: renderNushellResult(
              value as NushellToolOutput,
              escalationModes,
            ),
          },
        ],
        presentationMeta: (_args, value) => value,
      },
      async execute(args, exec) {
        validateNushellArgs(args);
        // 参数配对校验(schema 表达不了的关联):单字段出现即抛。
        validateEscalationArgs(args.sandbox_permissions, args.justification);
        const standingPolicy = resolveSandboxPolicy(exec);
        let approvedMode: SandboxExecutionPolicy['mode'] | undefined;
        if (
          args.sandbox_permissions !== undefined &&
          args.justification !== undefined
        ) {
          if (standingPolicy === undefined) {
            throw new Error(
              'sandbox_permissions is not available in this composition (no sandboxing executor to escalate)',
            );
          }
          approvedMode = await approveNushellEscalation(
            args.sandbox_permissions,
            args.justification,
            exec,
            standingPolicy,
          );
        }
        let policy: SandboxExecutionPolicy | undefined = standingPolicy;
        if (approvedMode !== undefined && standingPolicy !== undefined) {
          policy = {
            mode: approvedMode,
            workspaceRoot: standingPolicy.workspaceRoot,
            ...(standingPolicy.sessionId !== undefined
              ? { sessionId: standingPolicy.sessionId }
              : {}),
          };
        }
        const workdir = resolveWorkdir(args.workdir, exec);
        const dshEnv = collectShellEnv(ctx, exec);
        const command = applyOutputFormat(args.command, args.outputFormat);
        if (args.run_in_background === true) {
          if (!backgroundEnabled) {
            throw new Error(
              'run_in_background is disabled for this deployment (enableRunInBackground: false)',
            );
          }
          if (exec.signal.aborted) {
            throw abortError();
          }
          const jobs = getJobs(ctx);
          if (jobs === undefined) {
            throw new Error(
              'background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs',
            );
          }
          const request: ShellExecRequest = {
            command,
            ...(workdir !== undefined ? { workdir } : {}),
            ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
            dshEnv,
            ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
          };
          // 后台无超时(接缝契约):resolve 后不携带 timeoutMs。
          const executor = activeExecutor();
          const proc = executor.start(executor.resolve(request));
          return {
            kind: 'background',
            jobId: jobs.start({
              kind: 'nushell',
              label: args.command,
              ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
              run: () => ({
                cancel: () => proc.kill(),
                done: proc.done.then(() => nushellJobOutcome(proc)),
                readOutput: () =>
                  renderNushellProcessRead(
                    proc.readOutput(),
                    proc.sandbox,
                    escalationModes,
                  ),
              }),
            }),
          } as const;
        }
        const request: ShellExecRequest = {
          command,
          ...(workdir !== undefined ? { workdir } : {}),
          ...(args.timeoutMs !== undefined
            ? { timeoutMs: args.timeoutMs }
            : {}),
          ...(args.stdin !== undefined ? { stdin: args.stdin } : {}),
          dshEnv,
          ...(policy !== undefined ? { sandboxPolicy: policy } : {}),
        };
        const executor = activeExecutor();
        const result = await executor.run(executor.resolve(request));
        if (result.aborted) {
          throw abortError();
        }
        return canonicalNushellResult(result);
      },
      presentCall: (args) => {
        if (args.run_in_background === true) {
          return {
            card: 'generic',
            title: args.command,
            kind: 'execute',
            rawInput: args.command,
            content: [{ type: 'text', text: args.description }],
          };
        }
        return {
          card: 'terminal',
          title: args.command,
          description: args.description,
          ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
        };
      },
      presentResult: (args, result) => {
        const meta = result.meta as NushellToolOutput | undefined;
        if (meta === undefined) {
          return undefined;
        }
        const block =
          result.content.length === 1 ? result.content[0] : undefined;
        const raw = block?.type === 'text' ? block.text : '';
        if (meta.kind === 'background' || result.isError) {
          return {
            card: 'generic',
            content: [
              {
                type: 'text',
                text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\``,
              },
            ],
          };
        }
        void args;
        return {
          card: 'terminal',
          output: renderNushellBody(meta),
          ...(meta.signal !== null
            ? { signal: meta.signal }
            : meta.exitCode !== null
              ? { exitCode: meta.exitCode }
              : {}),
        };
      },
    });

    const dispose = ctx.tools.register(nushellTool);
    // 后台进程生命周期归 ctx.subprocess(cordis 组合销毁统一终止)。
    return () => {
      dispose();
    };
  }, 'tool-nushell: prompt section and tool registration');
}
