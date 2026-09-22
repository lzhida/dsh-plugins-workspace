import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { JobHooks, JobOutcome } from '@deepseek-ai/dsh-jobs';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type {
  ShellExecRequest,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import {
  defineTool,
  TOOL_ABORTED,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';

export const name = 'dsh-tool-nushell';
export const inject = ['tools', 'systemPrompt', 'shellEnv', 'shell'];

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    nushell: 'nushell';
  }
}

/**
 * tool-nushell:为 DeepSeek Harness 注册独立的 `nushell` 工具,执行经
 * `ctx.shell` 能力接缝——nushell-local executor 负责进程管理与预算,本
 * 插件只负责模型契约(参数校验、canonical 输出、marker 渲染、后台 job、
 * 系统提示 section、UI 呈现)。能力面与官方 tool-pwsh 对齐;沙箱
 * escalation 为 PowerShell 专属通道,不提供。
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

/** 后台增量读 → `job_output` delta;有损读附 spill 路径提示(无沙箱注记)。 */
export function renderNushellProcessRead(read: ShellProcessRead): string {
  const notices: string[] = [];
  if (read.lossy) {
    const paths = [read.stdoutSpillPath, read.stderrSpillPath].filter(
      (p) => p !== undefined,
    );
    notices.push(
      `[some output was dropped from memory; full output: ${paths.length > 0 ? paths.join(', ') : '(unavailable)'}]`,
    );
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
        'instead of parsing rendered tables.',
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
        'Use it for nushell-native pipelines and structured data handling; the built-in bash tool stays available.',
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
          };
          // 后台无超时(接缝契约):resolve 后不携带 timeoutMs。
          const proc = ctx.shell.start(ctx.shell.resolve(request));
          return {
            kind: 'background',
            jobId: jobs.start({
              kind: 'nushell',
              label: args.command,
              ...(exec.agent !== undefined ? { owner: exec.agent } : {}),
              run: () => ({
                cancel: () => proc.kill(),
                done: proc.done.then(() => nushellJobOutcome(proc)),
                readOutput: () => renderNushellProcessRead(proc.readOutput()),
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
        };
        const result = await ctx.shell.run(ctx.shell.resolve(request));
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
