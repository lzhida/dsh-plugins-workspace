import { execFile } from 'node:child_process';
import type {
  ChildProcess,
  ExecFileException,
  ExecFileOptions,
} from 'node:child_process';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-nushell-tool';
export const inject = ['tools'];

/**
 * dsh-nushell-tool:为 DeepSeek Harness 注册独立的 `nushell` 工具。
 *
 * 模型显式调用,与内置 bash 工具并存;命令经
 * `nu --no-config-file -c <command>` 子进程执行——禁用用户配置以保证
 * 可复现的干净求值环境。`nu` 通过 PATH 查找,缺失时报错,不打包 nushell。
 */

/** 单次 nu 执行的结构化结果(渲染为模型可见文本前的内部形态)。 */
export interface NushellRunResult {
  command: string;
  /** 进程退出码;被信号终止或未能启动时为 null。 */
  exitCode: number | null;
  /** 终止进程的信号名;正常退出为 null。 */
  signal: NodeJS.Signals | null;
  /** 是否因 timeout 参数被 Node 终止(区别于调用方取消)。 */
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** spawn/等待阶段的异常描述(如 EACCES);正常结束为 undefined。 */
  error?: string;
}

/** `nushell` 工具的模型参数。 */
export interface NushellArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 600_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;

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

/**
 * 执行一条 nushell 命令。非零退出属正常工具结果(正常 resolve);
 * 仅 nu 缺失(ENOENT)与调用方取消时 reject。子进程登记进 `children`,
 * 供插件卸载时统一击杀。
 */
export function runNushell(
  args: NushellArgs,
  exec: { signal: AbortSignal },
  children?: Set<ChildProcess>,
  spawn: ExecFileLike = execFileLike,
): Promise<NushellRunResult> {
  return new Promise<NushellRunResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(
        'nu',
        buildNuArgs(args.command),
        {
          cwd: args.cwd,
          timeout: resolveTimeoutMs(args.timeoutMs),
          maxBuffer: MAX_BUFFER_BYTES,
          windowsHide: true,
          signal: exec.signal,
        },
        (error, stdout, stderr) => {
          children?.delete(child);
          if (error?.code === 'ENOENT') {
            reject(
              new Error(
                '未找到 nu 可执行文件:请安装 Nushell 并确保其在 PATH 中(https://www.nushell.sh/)',
              ),
            );
            return;
          }
          if (exec.signal.aborted) {
            reject(new Error('nushell 命令已随调用取消而中止'));
            return;
          }
          resolve({
            command: args.command,
            exitCode: child.exitCode,
            signal: child.signalCode,
            timedOut: Boolean(error?.killed),
            stdout,
            stderr,
            error: error && !error.killed ? error.message : undefined,
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

/** 单流输出截断,保留截断位置提示。 */
function truncateStream(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[输出已截断,原始长度 ${text.length} 字符]`;
}

/** 把结构化执行结果渲染为模型可见文本:状态行 + stdout/stderr 两段。 */
export function renderNushellResult(result: NushellRunResult): string {
  let status: string;
  if (result.error !== undefined) {
    status = `命令执行失败: ${result.error}`;
  } else if (result.timedOut) {
    status = `命令超时被终止(signal: ${result.signal ?? 'unknown'})`;
  } else if (result.signal !== null) {
    status = `进程被信号终止: ${result.signal}`;
  } else {
    status = `exit code: ${result.exitCode}`;
  }
  const stdout = truncateStream(result.stdout);
  const stderr = truncateStream(result.stderr);
  return [
    status,
    '--- stdout ---',
    stdout.length > 0 ? stdout : '(空)',
    '--- stderr ---',
    stderr.length > 0 ? stderr : '(空)',
  ].join('\n');
}

export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`);

  ctx.effect(() => {
    const children = new Set<ChildProcess>();
    const run = (
      args: NushellArgs,
      exec: { signal: AbortSignal },
    ): Promise<NushellRunResult> => runNushell(args, exec, children);

    const nushellTool = defineTool({
      name: 'nushell',
      description:
        'Run a command with the Nushell (nu) shell and return its exit code, stdout, and stderr. ' +
        'Use it for nushell-native pipelines and structured data handling; the built-in bash tool stays available.',
      parameters: {
        command: {
          type: 'string',
          required: true,
          description:
            'Nushell source executed as a single `nu --no-config-file -c` program.',
        },
        cwd: {
          type: 'string',
          description:
            'Working directory for the command; defaults to the harness process cwd.',
        },
        timeoutMs: {
          type: 'integer',
          description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}); the process is killed with SIGTERM on expiry.`,
        },
      },
      // 声明即承诺:execute 把 exec.signal 转发给子进程,可在预算内静默。
      timeoutMs: MAX_TIMEOUT_MS,
      // 无共享可变状态,进程级隔离,可并行调度。
      isConcurrencySafe: () => true,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return renderNushellResult(await run(args, exec));
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
  }, 'nushell-tool: tool registration and child cleanup');
}
