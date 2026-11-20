import { spawn } from 'node:child_process';

import { CLI_ACTIONS, type CliAction } from './cli-hints.ts';
import { VictauriError } from './errors.ts';

/** CLI 默认超时:test/record/watch 类子命令可能较慢,取 2 分钟量级。 */
export const CLI_DEFAULT_TIMEOUT_MS = 120_000;

/** 单路输出捕获上限(stdout/stderr 各自):超出截断,防止常驻 watch 撑爆内存。 */
const MAX_STREAM_BYTES = 512 * 1024;

/** CLI 运行结果:退出码(null=被信号终止或超时强杀)、双路输出、超时标记。 */
export interface CliRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** runVictauriCli 选项。 */
export interface CliRunOptions {
  /** CLI 参数列表(子命令 + 参数,如 ['doctor','--json']) */
  args: string[];
  /** victauri 可执行文件路径;默认按平台解析(victauri.exe / victauri) */
  cliPath?: string;
  /** 超时毫秒;默认 CLI_DEFAULT_TIMEOUT_MS */
  timeoutMs?: number;
  /** 子进程工作目录 */
  cwd?: string;
  /** 追加环境变量(合并到 process.env) */
  env?: Record<string, string>;
}

/**
 * 平台默认 CLI 路径:Windows 上 Node 的 spawn 不做 PATHEXT 解析,
 * 必须显式 '.exe' 后缀才能从 PATH 命中(scoop 安装的 victauri.exe)。
 */
export function resolveCliPath(cliPath?: string): string {
  if (cliPath !== undefined) return cliPath;
  return process.platform === 'win32' ? 'victauri.exe' : 'victauri';
}

/**
 * spawn victauri CLI 并等待退出。
 *
 * - stdout/stderr 全量捕获(单路截断 MAX_STREAM_BYTES);
 * - 超时 → kill 子进程,timedOut=true,exitCode=null;
 * - spawn 自身失败(ENOENT 等)→ VictauriError('cli-error')。
 */
export function runVictauriCli(options: CliRunOptions): Promise<CliRunResult> {
  const cliPath = resolveCliPath(options.cliPath);
  const timeoutMs = options.timeoutMs ?? CLI_DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cliPath, options.args, {
        cwd: options.cwd,
        ...(options.env !== undefined
          ? { env: { ...process.env, ...options.env } }
          : {}),
        windowsHide: true,
      });
    } catch (err) {
      reject(
        new VictauriError(
          'cli-error',
          `spawn ${cliPath} failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_STREAM_BYTES) {
        stdoutTruncated = true;
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_STREAM_BYTES) {
        stderrTruncated = true;
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(
        new VictauriError(
          'cli-error',
          `spawn ${cliPath} failed: ${err.message}`,
        ),
      );
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stdoutTruncated) stdout += '\n[truncated]';
      if (stderrTruncated) stderr += '\n[truncated]';
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}

/**
 * victauri CLI 已知子命令（0.10.3 上游顺序，0.8.8 实测为其子集）：
 * init/check/test/record/doctor/watch/invoke/tools/call/bridge/coverage/run/logs
 * （上游另有 setup 与本插件有意不接，clap 内置 help 不是可路由 action）。
 *
 * 口径唯一来源已上移到 `src/cli-hints.ts` 的 `CLI_ACTION_SPECS`
 * （子命令 + 语义 + 版本门控提示同表维护）；此处仅做转发，
 * 保证既有 `from '../cli.ts'` 的引用面不变。
 */
export { CLI_ACTIONS };

export type { CliAction };

/** action 合法性守卫(工具入参校验,enum 之外给出可读错误)。 */
export function isCliAction(value: string): value is CliAction {
  return (CLI_ACTIONS as readonly string[]).includes(value);
}
