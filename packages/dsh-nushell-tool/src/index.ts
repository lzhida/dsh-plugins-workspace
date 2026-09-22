import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptions,
} from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs';
import {
  defineTool,
  TOOL_ABORTED,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';

export const name = 'dsh-nushell-tool';
export const inject = ['tools', 'systemPrompt', 'shellEnv'];

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    nushell: 'nushell';
  }
}

/**
 * dsh-nushell-tool:为 DeepSeek Harness 注册独立的 `nushell` 工具,能力对齐
 * 官方 tool-pwsh(0.1.5-rc.2):前台/后台执行、canonical 结构化输出、
 * marker 渲染、截断 + spill 落盘、DSH_* 环境注入、系统提示 section、
 * 终端卡片 UI 呈现。命令经 `nu --no-config-file -c <command>` 子进程执行——
 * 禁用用户配置以保证可复现的干净求值环境。`nu` 通过 PATH 查找,缺失时报错,
 * 不打包 nushell。与官方 pwsh 的差异:nu 直接由本插件 spawn(无 ctx.shell
 * executor 中介),沙箱 escalation 通道不存在(PowerShell 专属),故不广告
 * `sandbox_permissions`/`justification`。
 */

/** `nushell` 工具的模型参数(形状与 parameters schema 一致)。 */
export interface NushellArgs {
  command: string;
  description: string;
  timeoutMs?: number;
  workdir?: string;
  run_in_background?: boolean;
}

/** 单次 nu 执行的结构化结果(spawn 内部形态,渲染前的原始流)。 */
export interface NushellRunResult {
  command: string;
  /** 进程退出码;被信号终止或未能启动时为 null。 */
  exitCode: number | null;
  /** 终止进程的信号名;正常退出为 null。 */
  signal: NodeJS.Signals | null;
  /** 是否因 timeout 参数被 Node 终止(区别于调用方取消)。 */
  timedOut: boolean;
  /** 实际生效的超时预算(默认/钳制后),渲染 timeout marker 用。 */
  timeoutMs: number;
  stdout: string;
  stderr: string;
}

/** 单流输出的 canonical 形态:模型可见文本 + 截断标记 + 完整输出落盘路径。 */
export interface NushellStreamOutput {
  text: string;
  truncated: boolean;
  spillPath?: string;
}

/** 前台运行的 canonical 输出(字段集对齐官方 tool-pwsh foreground 分支,无 sandbox)。 */
export interface NushellForegroundOutput {
  kind: 'foreground';
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  timeoutMs: number;
  stdout: NushellStreamOutput;
  stderr: NushellStreamOutput;
}

/** `nushell` 工具的 canonical 输出(oneOf:后台句柄 | 前台结果)。 */
export type NushellToolOutput =
  { kind: 'background'; jobId: string } | NushellForegroundOutput;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
/** 后台增量缓冲上限;超出丢头部并记为有损读(对齐官方 lossy read 语义)。 */
const MAX_JOB_BUFFER_CHARS = 200_000;
/** 系统提示 section 位置:SECTION_ORDERS.TOOL_PWSH(1010)与 TOOL_READ(1100)之间的空位。 */
const NUSHELL_SECTION_ORDER = 1015;

/** 请求超时钳制:非法值回退默认,下限 1ms,上限 MAX_TIMEOUT_MS。 */
export function resolveTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.trunc(timeoutMs), 1), MAX_TIMEOUT_MS);
}

/** 拼装 nu 参数行:`--no-config-file -c <command>`。 */
export function buildNuArgs(command: string): string[] {
  return ['--no-config-file', '-c', command];
}

/** 语义校验(文案对齐官方 validatePwshArgs);schema 校验由 defineTool 负责。 */
export function validateNushellArgs(args: NushellArgs): void {
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
}

/** 会话工作目录载体(窄化访问,避免对 dsh-agent 的类型依赖)。 */
interface SessionCwdCarrier {
  session?: { header?: { cwd?: string } };
}

/**
 * 解析显式 workdir:相对路径基于会话工作目录;未给时回退会话工作目录,
 * 再由 executor(execFile)默认进程 cwd。语义对齐官方 resolveWorkdir。
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

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;
type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => ChildProcess;

// execFile 的重载联合与单签名 ExecFileLike 无法被 TS 直接统一(回调变型),单点断言收敛。
const execFileLike = execFile as unknown as ExecFileLike;

/** 前台执行请求(workdir 已解析;env 为合并前的 DSH_* 增量)。 */
export interface NushellRunRequest {
  command: string;
  workdir?: string;
  timeoutMs?: number;
  dshEnv?: Record<string, string>;
}

function abortError(): Error {
  const error = new HarnessError('tool call aborted', TOOL_ABORTED);
  error.name = 'AbortError';
  return error;
}

/** spawn 选项组装:dshEnv 非空时并入进程 env。 */
function childEnv(
  dshEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (dshEnv === undefined || Object.keys(dshEnv).length === 0) {
    return undefined;
  }
  return { ...process.env, ...dshEnv };
}

/**
 * 执行一条 nushell 命令(前台)。非零退出与信号终止属正常工具结果(正常
 * resolve);基础设施失败(ENOENT、无法启动)与调用方取消时 reject——
 * 对齐官方"仅基础设施失败作为 isError 结果"的边界。子进程登记进
 * `children`,供插件卸载时统一击杀。
 */
export function runNushell(
  request: NushellRunRequest,
  exec: { signal: AbortSignal },
  children?: Set<ChildProcess>,
  spawnFn: ExecFileLike = execFileLike,
): Promise<NushellRunResult> {
  const timeoutMs = resolveTimeoutMs(request.timeoutMs);
  const env = childEnv(request.dshEnv);
  return new Promise<NushellRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawnFn(
        'nu',
        buildNuArgs(request.command),
        {
          ...(request.workdir !== undefined ? { cwd: request.workdir } : {}),
          timeout: timeoutMs,
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
          signal: exec.signal,
          ...(env !== undefined ? { env } : {}),
        },
        (error, stdout, stderr) => {
          children?.delete(child);
          if (error?.code === 'ENOENT') {
            reject(
              new Error(
                'nu executable not found: install Nushell and make sure it is on PATH (https://www.nushell.sh/)',
              ),
            );
            return;
          }
          if (exec.signal.aborted) {
            reject(abortError());
            return;
          }
          if (
            error !== null &&
            !error.killed &&
            child.exitCode === null &&
            child.signalCode === null
          ) {
            reject(new Error(`failed to start nu: ${error.message}`));
            return;
          }
          resolve({
            command: request.command,
            exitCode: child.exitCode,
            signal: child.signalCode,
            timedOut: Boolean(error?.killed),
            timeoutMs,
            stdout,
            stderr,
          });
        },
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    children?.add(child);
  });
}

/** 超限单流落盘(spill);落盘失败时 spillPath 缺省,渲染回退 (unavailable)。 */
async function toStreamOutput(
  stream: 'stdout' | 'stderr',
  raw: string,
): Promise<NushellStreamOutput> {
  if (raw.length <= MAX_OUTPUT_CHARS) {
    return { text: raw, truncated: false };
  }
  let spillPath: string | undefined;
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-nushell-tool-'));
    spillPath = path.join(dir, `${stream}.out.txt`);
    await writeFile(spillPath, raw, 'utf8');
  } catch {
    spillPath = undefined;
  }
  return { text: raw.slice(0, MAX_OUTPUT_CHARS), truncated: true, spillPath };
}

/** 前台结果 → canonical 输出(aborted 恒 false:取消走 reject 路径)。 */
export async function canonicalNushellResult(
  result: NushellRunResult,
): Promise<NushellForegroundOutput> {
  return {
    kind: 'foreground',
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    aborted: false,
    timeoutMs: result.timeoutMs,
    stdout: await toStreamOutput('stdout', result.stdout),
    stderr: await toStreamOutput('stderr', result.stderr),
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
 * canonical 输出 → 模型可见文本:主体 + timeout/signal/exit marker,
 * 干净退出(0、无信号)无 marker——对齐官方 renderPwshResult(无沙箱分支)。
 */
export function renderNushellResult(value: NushellToolOutput): string {
  if (value.kind === 'background') {
    return `started background job ${value.jobId}`;
  }
  let body = renderNushellBody(value);
  const markers: string[] = [];
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

/** 后台进程结算 → job outcome;信号终止记 killed,非零退出照报不判失败。 */
export function nushellJobOutcome(
  code: number | null,
  signal: NodeJS.Signals | null,
): JobOutcome {
  if (signal !== null) {
    return { status: 'killed', detail: `signal: ${signal}` };
  }
  return { status: 'completed', detail: `exit code: ${code ?? 0}` };
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
 * 启动后台 nu 进程并产出 job 句柄:增量缓冲由 readOutput 消费,积压超限
 * 记有损并在下次读取时附提示;cancel 击杀进程;close/error 结算 outcome。
 */
function startNushellProcess(request: NushellRunRequest): JobHooks {
  const child = spawn('nu', buildNuArgs(request.command), {
    ...(request.workdir !== undefined ? { cwd: request.workdir } : {}),
    ...(childEnv(request.dshEnv) !== undefined
      ? { env: childEnv(request.dshEnv) }
      : {}),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const buffer = { pending: '', lossy: false };
  const append = (chunk: string): void => {
    buffer.pending += chunk;
    if (buffer.pending.length > MAX_JOB_BUFFER_CHARS) {
      buffer.pending = buffer.pending.slice(-MAX_JOB_BUFFER_CHARS);
      buffer.lossy = true;
    }
  };
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', append);
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', append);
  let settled = false;
  const done = new Promise<JobOutcome>((resolve) => {
    child.once('error', (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ status: 'failed', detail: err.message });
    });
    child.once(
      'close',
      (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(nushellJobOutcome(code, signal));
      },
    );
  });
  return {
    cancel: () => {
      if (!settled) {
        child.kill();
      }
    },
    done,
    readOutput: (): string => {
      const delta = buffer.pending;
      buffer.pending = '';
      if (!buffer.lossy) {
        return delta;
      }
      buffer.lossy = false;
      const glue = delta.length > 0 && !delta.endsWith('\n') ? '\n' : '';
      return `${delta}${glue}[some output was dropped from memory; full output: (unavailable)]`;
    },
  };
}

/** 插件运行时配置;enableRunInBackground 默认开启,对齐官方 Config 语义。 */
export interface Config {
  enableRunInBackground?: boolean;
}

export function apply(ctx: Context, config: Config = {}): void {
  console.log(`[${name}] plugin loaded`);
  const backgroundEnabled = config.enableRunInBackground ?? true;

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
        'The `nushell` tool runs a command with the Nushell (nu) shell (`nu --no-config-file -c`). ' +
        'Non-zero exits are reported as `[exit code: N]` markers; investigate failures before moving on. ' +
        'A killed process is reported as `[killed by signal: X]` and a timeout as `[timed out after Nms]`. ' +
        'Each call runs in a fresh process: no state persists between calls.',
    });

    const children = new Set<ChildProcess>();

    const nushellTool = defineTool({
      name: 'nushell',
      description:
        'Execute a Nushell command (`nu --no-config-file -c`) and return its stdout/stderr. ' +
        'Each call runs in a fresh nu process: no state (cwd, variables) persists between calls — ' +
        'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. ' +
        'Current harness environment facts are exposed through managed `DSH_*` environment variables. ' +
        'Long output is truncated; the full output is saved to a file whose path is reported. ' +
        'Use it for nushell-native pipelines and structured data handling; the built-in bash tool stays available.',
      parameters: {
        command: {
          type: 'string',
          required: true,
          description: 'The Nushell command to execute.',
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
      },
      // 声明即承诺:execute 把 exec.signal 转发给子进程,可在预算内静默。
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
              },
            },
          ],
        },
        render: (_args, value) => [
          {
            type: 'text',
            text: renderNushellResult(value as NushellToolOutput),
          },
        ],
        presentationMeta: (_args, value) => value,
      },
      async execute(args, exec) {
        validateNushellArgs(args);
        const workdir = resolveWorkdir(args.workdir, exec);
        const dshEnv = collectShellEnv(ctx, exec);
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
          const request: NushellRunRequest = {
            command: args.command,
            ...(workdir !== undefined ? { workdir } : {}),
            dshEnv,
          };
          return {
            kind: 'background',
            jobId: jobs.start({
              kind: 'nushell',
              label: args.command,
              ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
              run: () => startNushellProcess(request),
            }),
          } as const;
        }
        const result = await runNushell(
          {
            command: args.command,
            ...(workdir !== undefined ? { workdir } : {}),
            ...(args.timeoutMs !== undefined
              ? { timeoutMs: args.timeoutMs }
              : {}),
            dshEnv,
          },
          exec,
          children,
        );
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
    return () => {
      dispose();
      for (const child of children) {
        child.kill();
      }
      children.clear();
    };
  }, 'nushell-tool: prompt section, tool registration and child cleanup');
}
