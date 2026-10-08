import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type {
  ShellExecRequest,
  ShellExecution,
  ShellExecutor,
  ShellProcess,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell';
import { parseExitStatus } from '@deepseek-ai/dsh-shell';
import {
  approveEscalation,
  escalationHintMarker,
  ESCALATION_TARGETS,
  sandboxDenialMarker,
  sandboxPermissionsDescription,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox';
import type {
  SandboxExecutionPolicy,
  SandboxEnforcement,
  SandboxMode,
} from '@deepseek-ai/dsh-sandbox';
import {
  defineTool,
  TOOL_ABORTED,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
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
 * job、系统提示 section、UI 呈现);能力面与 0.1.7 官方 tool-pwsh 对齐:
 * 前台调用经 jobs 升格(promoteOnTimeout——到点不杀命令,转为后台 job
 * 并交回 job id),后台/升格共用 job 的 pull-sources 输出环;沙箱升权
 * 字段只在 confining 形态公布,词汇与审批次序复用共享的 dsh-sandbox
 * escalation 通道。
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

/**
 * defineTool 从 parameters schema 推导的宽调用形状(outputFormat 值域收窄
 * 前是 string;canonical 类型 NushellArgs 由调用方持有)。
 */
export type NushellToolArgs = Omit<NushellArgs, 'outputFormat'> & {
  outputFormat?: string;
};

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
  /** 前台升格等待时被 job_kill 主动停止的原因(job 包装层合并)。 */
  stopped?: string;
  /** 沙箱事实;非沙箱 executor 不携带。 */
  sandbox?: {
    mode: SandboxMode;
    denied: boolean;
    enforcement?: SandboxEnforcement;
    runnerFailed?: boolean;
  };
}

/** 升格输出:命令到点未完,转为后台 job 并交回已产出输出。 */
export interface NushellPromotedOutput {
  kind: 'promoted';
  jobId: string;
  timeoutMs: number;
  output: string;
}

/** `nushell` 工具的 canonical 输出(oneOf:后台句柄 | 升格 | 前台结果)。 */
export type NushellToolOutput =
  | { kind: 'background'; jobId: string }
  | NushellPromotedOutput
  | NushellForegroundOutput;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
/** 系统提示 section 位置:SECTION_ORDERS.TOOL_PWSH(1010)与 TOOL_READ(1100)之间的空位。 */
const NUSHELL_SECTION_ORDER = 1015;

/** 工具运行时配置 schema(loader 投影设置表单;变更重载插件生效)。 */
export const Config = z.object({
  enableRunInBackground: z.boolean().default(true),
  promoteOnTimeout: z.boolean().default(true),
});

/** 插件运行时配置(apply 第二参;executor 字段不进 schema,仅组合行直配)。 */
export interface NushellToolConfig {
  /** run_in_background 参数开关,默认开启。 */
  enableRunInBackground?: boolean;
  /** 前台到点升格为 job(而非杀掉),默认开启;依赖 jobs 组合。 */
  promoteOnTimeout?: boolean;
  /**
   * 内部直跑执行器的配置透传(nuPath/cwd/超时与输出预算);仅在直跑
   * 模式读取,接缝模式由执行器组合行的自身配置接管。
   */
  executor?: NushellLocalConfig;
}

/**
 * 语义校验(文案对齐官方 validatePwshArgs);schema 校验由 defineTool 负责。
 * 参数接受 defineTool 从 parameters schema 推导的宽形状——outputFormat
 * 值域在此收窄为三值枚举,canonical 类型(NushellArgs)由调用方持有。
 */
export function validateNushellArgs(args: NushellToolArgs): void {
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
  // 参数配对校验(schema 表达不了的关联):单字段出现即抛。
  validateEscalationArgs(args.sandbox_permissions, args.justification);
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
  session?: { header?: { cwd?: string }; id?: string };
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

/**
 * 后台 job 注册契约(窄化 ctx.get('jobs'),避免对宿主类型布局的依赖;
 * 形状对齐 0.1.7 JobRegistry:pull-sources 输出环 + wait/read/kill/remove)。
 */
interface NushellJobRegistry {
  start(spec: {
    kind: 'nushell';
    label: string;
    owner?: unknown;
    output?: readonly {
      channel?: string;
      read(fromByte: number): {
        text: string;
        nextOffset: number;
        lossy: boolean;
        spillPath?: string;
      };
    }[];
    run(job: { id: string }): JobHooks;
  }): string;
  kill(
    id: string,
    caller?: unknown,
    reason?: string,
  ): 'requested' | 'already-finished';
  wait(
    id: string,
    timeoutMs: number,
    caller?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: string; detail?: string }>;
  read(
    id: string,
    caller?: unknown,
  ): {
    chunks: readonly { channel?: string; text: string }[];
    lossy: boolean;
    job: { output?: { spillPaths?: string[] } };
  };
  remove(id: string, caller?: unknown): void;
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

/** 沙箱事实中值得进终端 detail 的部分:runner 失败或拒绝(含升权 hint)。 */
function sandboxNotes(
  sandbox: ShellSandboxInfo | undefined,
  escalationModes: readonly string[],
): string[] {
  if (sandbox?.runnerFailed) {
    return [
      '[sandbox: the sandbox runner itself failed under ' +
        `${sandbox.mode} mode — the command did not run; this is a sandbox problem, not a command failure]`,
    ];
  }
  if (sandbox?.denied) {
    const notes = [sandboxDenialMarker(sandbox.mode)];
    if (escalationModes.length > 0) {
      notes.push(escalationHintMarker('command'));
    }
    return notes;
  }
  return [];
}

/**
 * 后台进程结算 → job outcome;信号终止记 killed,非零退出照报不判失败。
 * 沙箱事实并入 detail(job 的终态一行是 status 线与 roster 行都会展示的)。
 */
export function nushellJobOutcome(
  proc: Pick<ShellProcess, 'status' | 'exitCode' | 'signal' | 'sandbox'>,
  escalationModes: readonly string[] = [],
): JobOutcome {
  const base: JobOutcome =
    proc.status === 'killed'
      ? {
          status: 'killed',
          detail:
            proc.signal !== null
              ? `signal: ${proc.signal}`
              : 'killed before exit',
        }
      : { status: 'completed', detail: `exit code: ${proc.exitCode ?? 0}` };
  const notes = sandboxNotes(proc.sandbox, escalationModes);
  return notes.length === 0
    ? base
    : { ...base, detail: `${base.detail}; ${notes.join(' ')}` };
}

/**
 * 进程的非消费流观察读 → registry pull sources(注册后由 registry 按自己
 * 的节奏泵进输出环;spawn 发生在 starter 内,读时句柄未就绪则返回空)。
 */
function processSources(
  proc: () => ShellProcess | undefined,
): NonNullable<Parameters<NushellJobRegistry['start']>[0]['output']> {
  const source = (channel: string) => ({
    channel,
    read: (fromByte: number) => {
      const live = proc();
      return live === undefined
        ? { text: '', nextOffset: fromByte, lossy: false }
        : live.observed[channel as 'stdout' | 'stderr'].readFrom(fromByte);
    },
  });
  return [source('stdout'), source('stderr')];
}

/**
 * 异步准备(start)适配为同步 job hooks:句柄在 registry 准入后才 spawn,
 * 不外泄半初始化的进程;取消时先 abort 再 kill,结算携带 provider 失败。
 */
function processJob(
  start: (signal: AbortSignal) => Promise<ShellExecution>,
  outcome: (proc: ShellExecution) => JobOutcome,
): JobHooks & { process: () => ShellExecution | undefined } {
  const controller = new AbortController();
  let process: ShellExecution | undefined;
  return {
    process: () => process,
    cancel: (reason) => {
      if (controller.signal.aborted) return;
      controller.abort(reason);
      process?.kill();
    },
    done: (async () => {
      try {
        process = await start(controller.signal);
        try {
          if (controller.signal.aborted) process.kill();
        } finally {
          await process.done;
        }
        return outcome(process);
      } catch (error) {
        return {
          status:
            controller.signal.aborted && process === undefined
              ? 'killed'
              : 'failed',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    })(),
  };
}

/** 前台 shell 结果 → canonical 输出(aborted 原样携带:取消方自行转 AbortError)。 */
export function canonicalNushellResult(
  result: ShellRunResult,
): NushellForegroundOutput {
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: result.aborted,
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
 * stopped/signal/exit marker,干净退出(0、无信号)无 marker——对齐官方
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
  if (value.kind === 'promoted') {
    return renderNushellPromoted(value);
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
  if (value.stopped !== undefined) {
    markers.push(`[stopped: ${value.stopped}]`);
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

/**
 * 升格调用 → 模型可见文本:停止等待时已产出的输出 + 仍在前台运行的
 * marker 与 job 交接指引(对齐官方 renderPromoted)。
 */
function renderNushellPromoted(promoted: NushellPromotedOutput): string {
  const output =
    promoted.output.length > 0
      ? promoted.output.endsWith('\n')
        ? promoted.output
        : `${promoted.output}\n`
      : '';
  return (
    output +
    `[still running after ${promoted.timeoutMs}ms; moved to background job ${promoted.jobId}]\n` +
    'The command keeps running in the background. You will be notified when it finishes; ' +
    'read newer output with job_output, stop it with job_kill.'
  );
}

/**
 * 一次消费性 registry 读的 ring chunks → 升格结果内嵌的输出文本:
 * stdout chunks 按序,随后所有 stderr chunks 合并成一个 `[stderr]` 段,
 * 使交回输出与后续 job_output 读完全同形(对齐官方 ringDelta)。
 */
function ringDelta(
  chunks: readonly { channel?: string; text: string }[],
): string {
  const out = chunks
    .filter((chunk) => chunk.channel !== 'stderr')
    .map((chunk) => chunk.text)
    .join('');
  const err = chunks
    .filter((chunk) => chunk.channel === 'stderr')
    .map((chunk) => chunk.text)
    .join('');
  const separator = out.length > 0 && !out.endsWith('\n') ? '\n' : '';
  return out + (err.length > 0 ? `${separator}[stderr]\n${err}` : '');
}

/**
 * 升格时嵌入的一次消费读渲染:产出文本 + 丢字提示(报 job 的 spill 文件)
 * + 沙箱注记;后续 job_output 经 job 工具渲染同一个环(对齐官方
 * renderJobRead)。
 */
function renderNushellJobRead(
  delta: string,
  lossy: boolean,
  spillPaths: readonly string[],
  sandbox: ShellSandboxInfo | undefined,
  escalationModes: readonly string[] = [],
): string {
  const notices: string[] = [];
  if (lossy) {
    notices.push(
      `[some output was dropped from memory; full output: ${spillPaths.length > 0 ? spillPaths.join(', ') : '(unavailable)'}]`,
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
    return delta;
  }
  const glue = delta.length > 0 && !delta.endsWith('\n') ? '\n' : '';
  return `${delta}${glue}${notices.join('\n')}`;
}

export function apply(ctx: Context, config: NushellToolConfig = {}): void {
  console.log(`[${name}] plugin loaded`);
  const backgroundEnabled = config.enableRunInBackground ?? true;
  const promoteOnTimeout =
    (config.promoteOnTimeout ?? true) && backgroundEnabled;

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
      // inject/reflect 一律无操作。直跑模式配置为普通值(无活值热更新,
      // nuPath 变更重装插件生效)。
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
   * 0.1.7 语义:复述 effective mode 无需审批即放行。
   */
  const approveNushellEscalation = async (
    mode: string,
    justification: string,
    exec: ToolRunContext,
    standingPolicy: SandboxExecutionPolicy,
  ): Promise<SandboxExecutionPolicy['mode']> => {
    if (escalationModes.length === 0 || !activeConfining()) {
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

    /**
     * `nushell` 工具的一次注册。带 job registry 时,前台调用先以 job 形态
     * 启动(`onExpiry: 'none'`,等待期到点升格而非杀掉);不带则前台执行,
     * 由 executor 截止时间杀掉。
     */
    const nushellTool = (jobs: NushellJobRegistry | undefined) => {
      const background = jobs !== undefined;
      const promote = background && promoteOnTimeout;
      /** 注册命令为 job;进程在 starter 内(registry 准入后)才 spawn。 */
      const startJob = (
        registry: NushellJobRegistry,
        args: NushellToolArgs,
        exec: ToolRunContext,
        spec: ReturnType<ShellExecutor['resolve']>,
      ) => {
        let proc: ShellExecution | undefined;
        let stopped: string | undefined;
        const agentId = (exec.agent as unknown as { id?: string })?.id;
        return {
          id: registry.start({
            kind: 'nushell',
            label: args.command,
            ...(agentId !== undefined ? { owner: agentId } : {}),
            output: processSources(() => proc),
            run: () => {
              const hooks = processJob(
                async (signal) => {
                  proc = await activeExecutor().execute({
                    ...spec,
                    signal,
                  });
                  return proc;
                },
                (started) => nushellJobOutcome(started, escalationModes),
              );
              return {
                done: hooks.done,
                cancel: (reason?: string) => {
                  stopped = reason;
                  hooks.cancel(reason);
                },
              };
            },
          }),
          process: () => proc,
          stopped: () => stopped,
        };
      };
      /** 等待已注册的前台命令直到结算或超时(超时即升格)。 */
      const waitOnJob = async (
        registry: NushellJobRegistry,
        attached: ReturnType<typeof startJob>,
        exec: ToolRunContext,
        spec: ReturnType<ShellExecutor['resolve']>,
      ): Promise<NushellToolOutput> => {
        const owner = (exec.agent as unknown as SessionCwdCarrier | undefined)
          ?.session?.id;
        const timeoutMs = spec.timeoutMs;
        /**
         * 以本次调用名义停掉 job 并等到结算:结算记为 awaited,不会紧跟
         * 一条完成通知;模型从未见过 job id,记录随调用一起离场。
         */
        const stop = async (reason: string) => {
          registry.kill(attached.id, owner, reason);
          const settled = await registry.wait(attached.id, timeoutMs, owner);
          if (settled.status !== 'running' && settled.status !== 'stopping') {
            registry.remove(attached.id, owner);
          }
          return settled;
        };
        let view;
        try {
          view = await registry.wait(
            attached.id,
            timeoutMs,
            owner,
            exec.signal,
          );
        } catch {
          await stop('tool call aborted');
          throw abortError();
        }
        if (
          (view.status === 'running' || view.status === 'stopping') &&
          attached.process() === undefined
        ) {
          await stop('timed out during preparation');
          return {
            kind: 'foreground',
            exitCode: null,
            signal: null,
            timedOut: true,
            aborted: false,
            timeoutMs,
            stdout: { text: '', truncated: false },
            stderr: { text: '', truncated: false },
            ...(spec.sandboxPolicy !== undefined
              ? {
                  sandbox: {
                    mode: spec.sandboxPolicy.mode,
                    denied: false,
                  },
                }
              : {}),
          };
        }
        if (view.status === 'running' || view.status === 'stopping') {
          // 升格:命令到点未完,交回 job id 与已产出输出,进程继续跑。
          const read = registry.read(attached.id, owner);
          return {
            kind: 'promoted',
            jobId: attached.id,
            timeoutMs,
            output: renderNushellJobRead(
              ringDelta(read.chunks),
              read.lossy,
              read.job.output?.spillPaths ?? [],
              attached.process()?.sandbox,
              escalationModes,
            ),
          };
        }
        registry.remove(attached.id, owner);
        const proc = attached.process();
        if (proc === undefined) {
          throw new Error(view.detail);
        }
        const result = await proc.result();
        const stopped = attached.stopped();
        return {
          ...canonicalNushellResult(result),
          ...(stopped !== undefined ? { stopped } : {}),
        };
      };

      return defineTool({
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
            description: promote
              ? `Timeout in milliseconds. The executor applies its configured default and cap; on expiry the command moves to the background as a job instead of being killed.`
              : `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); the process is killed on expiry.`,
          },
          workdir: {
            type: 'string',
            description:
              'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
          },
          ...(background
            ? {
                run_in_background: {
                  type: 'boolean',
                  description:
                    'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
                },
              }
            : {}),
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
                  enum: [...escalationModes],
                  description: sandboxPermissionsDescription('command'),
                },
                justification: {
                  type: 'string',
                  description:
                    "Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access. Use the language of the user's current request.",
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
                  kind: { type: 'string', required: true, const: 'promoted' },
                  jobId: { type: 'string', required: true },
                  timeoutMs: { type: 'number', required: true },
                  output: { type: 'string', required: true },
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
                  stopped: { type: 'string' },
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
          if (args.run_in_background === true) {
            if (!backgroundEnabled) {
              throw new Error(
                'run_in_background is disabled for this deployment (enableRunInBackground: false)',
              );
            }
            if (jobs === undefined) {
              throw new Error(
                'background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs',
              );
            }
            if (exec.signal.aborted) {
              throw abortError();
            }
            return {
              kind: 'background',
              jobId: startJob(
                jobs,
                args,
                exec,
                activeExecutor().resolve({
                  ...request,
                  onExpiry: 'none',
                }),
              ).id,
            } as const;
          }
          if (jobs !== undefined && promote) {
            // 升格路径:前台调用以 job 形态启动(不设 executor 截止),
            // 等待期到点交回 job id,而非杀掉命令。
            const spec = activeExecutor().resolve({
              ...request,
              onExpiry: 'none',
            });
            let attached: ReturnType<typeof startJob> | undefined;
            try {
              attached = startJob(jobs, args, exec, spec);
            } catch (error) {
              (
                ctx as unknown as {
                  logger?: { warn(message: string): void };
                }
              ).logger?.warn(
                `nushell: job registration refused, running in the foreground with the timeout kill instead: ${String(error)}`,
              );
            }
            if (attached !== undefined) {
              return waitOnJob(jobs, attached, exec, spec);
            }
          }
          const result = await (
            await activeExecutor().execute(
              activeExecutor().resolve({
                ...request,
                signal: exec.signal,
              }),
            )
          ).result();
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
          const block =
            result.content.length === 1 ? result.content[0] : undefined;
          if (block === undefined || block.type !== 'text') {
            return undefined;
          }
          const raw = block.text;
          const isBackground =
            typeof args === 'object' &&
            args !== null &&
            args.run_in_background === true;
          // presentationMeta 即 canonical 输出(见 output.presentationMeta);
          // 升格结果走 generic console 卡,与后台/错误一致。
          const isPromoted =
            (result.meta as NushellToolOutput | undefined)?.kind === 'promoted';
          if (isBackground || isPromoted || result.isError) {
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
          // 完成的前台调用:从渲染文本反解退出状态 pill(官方 parseExitStatus
          // 契约——terminal 卡自带 exit 状态,正文里不再重复渲染)。
          const { body, ...exit } = parseExitStatus(raw);
          return {
            card: 'terminal',
            output: body,
            ...exit,
          };
        },
      });
    };

    if (!backgroundEnabled) {
      return ctx.tools.register(nushellTool(undefined));
    }
    let foregroundOnly =
      getJobs(ctx) === undefined
        ? ctx.tools.register(nushellTool(undefined))
        : undefined;
    ctx.inject(['jobs'], (jobCtx) => {
      foregroundOnly?.();
      foregroundOnly = undefined;
      const unregister = ctx.tools.register(
        nushellTool(jobCtx.jobs as unknown as NushellJobRegistry),
      );
      jobCtx.effect(
        () => () => {
          unregister();
          // jobs 组合先行卸载而本插件仍在:回退为无 job 的前台形态。
          if (ctx.fiber.state === 2) {
            foregroundOnly = ctx.tools.register(nushellTool(undefined));
          }
        },
        'tool-nushell: downgrade to foreground-only on jobs detach',
      );
    });
    return () => {
      foregroundOnly?.();
      foregroundOnly = undefined;
    };
  }, 'tool-nushell: prompt section and tool registration');
}
