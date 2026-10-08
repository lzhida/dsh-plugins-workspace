/**
 * Obsidian CLI subprocess runner。
 *
 * 设计要点:
 * - 纯函数:不直接调 `child_process`,而是把 spawn 抽成 RunnerSpawner
 *   注入,便于单测里用 vi.fn() 替换成假体;
 * - argv 拼装:与 Obsidian 官方约定一致 — `obsidian <command> key=value
 *   key2=value2 ...`;布尔标志以 `key=true` 形式存在(与官方文档示例
 *   `obsidian create path=... content=... overwrite` 兼容,我们的
 *   `overwrite=true` 等价语义);
 * - 错误归一:Obsidian 进程的 stdout 以前缀 "Error:" 表示语义错误(但
 *   退出码 0) — 这条约定是 Obsidian 官方固定行为,runner 必须把它转
 *   化为 `OBSIDIAN_PROTOCOL_ERROR`;
 * - 超时与硬上限:默认 30s,上限 600s;
 * - 输出截断:stdout 上限 20k,stderr 上限 4k。
 */

import { spawn } from 'node:child_process';

import {
  OBSIDIAN_DEFAULT_TIMEOUT_MS,
  OBSIDIAN_ERROR_PREFIX,
  OBSIDIAN_MAX_TIMEOUT_MS,
  OBSIDIAN_STDERR_CAP,
  OBSIDIAN_STDOUT_CAP,
  type ObsidianCallResult,
  ObsidianError,
} from './types.ts';
import type { ObsidianCommandSpec } from './types.ts';

/** spawn 抽象,便于单测注入。 */
export interface RunnerSpawner {
  /** 同步 spawn 子进程;返回 pid + 由调用方持有的 stdio 流。 */
  spawn(args: {
    readonly command: string;
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
  }): RunnerChild;
}

/** 子进程抽象(只暴露 runner 需要的接口)。 */
export interface RunnerChild {
  readonly pid: number | undefined;
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): void;
  on(event: 'error', listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** 基于 node:child_process 的默认 spawner(供生产环境使用)。 */
export const defaultSpawner: RunnerSpawner = {
  spawn({ command, argv, cwd, env, signal }) {
    const child = spawn(command, [...argv], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // AbortSignal 与 stdio:'pipe' 的交互:不传 windowsHide,跨平台一致。
      // 我们手动监听 signal -> child.kill。
      signal: undefined,
    });
    // 绑定 abort:中止时强制杀子进程。
    if (signal) {
      const onAbort = (): void => {
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      child.once('exit', () => signal.removeEventListener('abort', onAbort));
    }
    return child as unknown as RunnerChild;
  },
};

/** Runner 构造选项。 */
export interface ObsidianRunnerOptions {
  /** Obsidian 可执行文件名(默认 `obsidian`;可被单测覆盖成假体)。 */
  readonly executable?: string;
  /** spawn 抽象(默认用 child_process)。 */
  readonly spawner?: RunnerSpawner;
  /** 工作目录(默认 process.cwd())。 */
  readonly cwd?: string;
  /** 注入到子进程的环境变量(默认继承 process.env)。 */
  readonly env?: NodeJS.ProcessEnv;
  /** 当前时刻(测试可注入,生产 = () => Date.now())。 */
  readonly now?: () => number;
}

/** Obsidian CLI 调用描述(由 tools 层构造)。 */
export interface ObsidianInvocation {
  /** 命令 spec。 */
  readonly spec: ObsidianCommandSpec;
  /** 参数值(name -> value);布尔标志传 `true` 时拼为 `name=true`。 */
  readonly args: Readonly<Record<string, string | boolean | undefined>>;
  /** 全局参数:指定 vault(对应 Obsidian CLI 的 `vault=<name>`)。 */
  readonly vault?: string;
  /** 超时(毫秒;0 或负数视为不设超时)。 */
  readonly timeoutMs?: number;
  /** 取消信号(由宿主 exec.signal 传入)。 */
  readonly signal?: AbortSignal;
}

/**
 * 执行一次 Obsidian CLI 调用。
 *
 * @param invocation 一次调用的全部输入
 * @param options Runner 构造选项
 * @returns 调用的 stdout/stderr/argv/duration
 * @throws ObsidianError(OBSIDIAN_INVALID_INPUT|OBSIDIAN_CLI_NOT_FOUND|
 *         OBSIDIAN_SPAWN_FAILED|OBSIDIAN_TIMEOUT|OBSIDIAN_NONZERO_EXIT|
 *         OBSIDIAN_PROTOCOL_ERROR)
 */
export async function runObsidian(
  invocation: ObsidianInvocation,
  options: ObsidianRunnerOptions = {},
): Promise<ObsidianCallResult> {
  const spec = invocation.spec;
  const argv = buildArgv(spec, invocation.args, invocation.vault);
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const executable = options.executable ?? 'obsidian';
  const now = options.now ?? Date.now;
  const timeoutMs = clampTimeout(invocation.timeoutMs);
  const spawner = options.spawner ?? defaultSpawner;

  // 1. 必填参数校验(在 spawn 前失败,避免无谓的进程开销)。
  for (const p of spec.params) {
    if (!p.required) continue;
    const v = invocation.args[p.name];
    if (v === undefined || v === null || v === '') {
      throw new ObsidianError(
        `[OBSIDIAN_INVALID_INPUT] 命令 \`${spec.name}\` 缺少必填参数 \`${p.name}\``,
        'OBSIDIAN_INVALID_INPUT',
        { command: spec.name, param: p.name },
      );
    }
  }

  // 2. spawn(用 try/catch 包住,捕获 ENOENT 等同步失败)。
  let child: RunnerChild;
  try {
    child = spawner.spawn({
      command: executable,
      argv,
      cwd,
      env,
      signal: invocation.signal ?? new AbortController().signal,
    });
  } catch (err) {
    throw classifySpawnError(err, executable);
  }

  const startedAt = now();
  // 3. 收集 stdout/stderr(限长截断,避免巨大响应阻塞 model 上下文)。
  const stdoutPromise = drainStream(child.stdout, OBSIDIAN_STDOUT_CAP);
  const stderrPromise = drainStream(child.stderr, OBSIDIAN_STDERR_CAP);

  // 4. 等待 exit 或 error。
  const exitResult = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    err?: Error;
  }>((resolve) => {
    let settled = false;
    const finish = (v: {
      code: number | null;
      signal: NodeJS.Signals | null;
      err?: Error;
    }): void => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    child.on('exit', (code, signal) => finish({ code, signal }));
    child.on('error', (err) => finish({ code: null, signal: null, err }));
  });

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const durationMs = now() - startedAt;

  // 5. spawn 阶段失败(例如 ENOENT / EACCES)。
  if (exitResult.err) {
    throw classifySpawnError(exitResult.err, executable);
  }

  // 6. Obsidian 约定:stdout 以 "Error:" 开头即视为语义错误(退出码 0)。
  if (stdout.startsWith(OBSIDIAN_ERROR_PREFIX)) {
    throw new ObsidianError(
      `[OBSIDIAN_PROTOCOL_ERROR] ${stdout.trim()}`,
      'OBSIDIAN_PROTOCOL_ERROR',
      { command: spec.name, stdout, exitCode: exitResult.code ?? 0 },
    );
  }

  // 7. 退出码非 0(罕见 — Obsidian 多数语义错误走 stdout 协议)。
  if (exitResult.code !== 0) {
    throw new ObsidianError(
      `[OBSIDIAN_NONZERO_EXIT] obsidian ${spec.name} 退出码 ${exitResult.code}${stderr ? `, stderr=${stderr}` : ''}`,
      'OBSIDIAN_NONZERO_EXIT',
      { command: spec.name, exitCode: exitResult.code, stderr },
    );
  }

  // 8. 超时附带说明(若用户在 timeoutMs 内已 exit,这里走不到;
  //    但若 AbortSignal 触发,会在 spawn 层强杀子进程)。
  if (timeoutMs > 0 && durationMs > timeoutMs) {
    throw new ObsidianError(
      `[OBSIDIAN_TIMEOUT] obsidian ${spec.name} 超过 ${timeoutMs}ms`,
      'OBSIDIAN_TIMEOUT',
      { command: spec.name, timeoutMs, durationMs },
    );
  }

  return {
    exitCode: exitResult.code,
    stdout,
    stderr,
    argv: [executable, ...argv],
    durationMs,
  };
}

/** 把 spec + args + 可选 vault 拼成 Obsidian CLI 接受的 argv 数组。 */
export function buildArgv(
  spec: ObsidianCommandSpec,
  args: Readonly<Record<string, string | boolean | undefined>>,
  vault?: string,
): string[] {
  const out: string[] = [spec.name];
  if (vault) out.push(`vault=${vault}`);
  for (const p of spec.params) {
    const v = args[p.name];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'boolean') {
      // 布尔标志:true 拼为 `name=true`(与官方 `obsidian ... overwrite` 等价);
      // false 视为未提供(不拼)。
      if (v) out.push(`${p.name}=true`);
    } else {
      out.push(`${p.name}=${v}`);
    }
  }
  return out;
}

/** 超时夹到合法区间。 */
export function clampTimeout(value: number | undefined): number {
  if (!value || value <= 0) return OBSIDIAN_DEFAULT_TIMEOUT_MS;
  if (value > OBSIDIAN_MAX_TIMEOUT_MS) return OBSIDIAN_MAX_TIMEOUT_MS;
  return value;
}

/** 错误归一(ENOENT -> OBSIDIAN_CLI_NOT_FOUND,其它 -> OBSIDIAN_SPAWN_FAILED)。 */
function classifySpawnError(err: unknown, executable: string): ObsidianError {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      return new ObsidianError(
        `[OBSIDIAN_CLI_NOT_FOUND] 找不到 \`${executable}\` 可执行文件`,
        'OBSIDIAN_CLI_NOT_FOUND',
        { executable },
      );
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return new ObsidianError(
    `[OBSIDIAN_SPAWN_FAILED] ${message}`,
    'OBSIDIAN_SPAWN_FAILED',
    {
      executable,
      original: message,
    },
  );
}

/** 消费一个 ReadableStream 直到 EOF,文本去尾随空白;超过 cap 截断并加标记。 */
async function drainStream(
  stream: NodeJS.ReadableStream,
  cap: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    // 不调 setEncoding,直接以 Buffer 形式接收,避免按字符计数的歧义;
    // 最终 toString('utf8') 一次。
    stream.on('data', (chunk: Buffer | string) => {
      if (truncated) return;
      const buf =
        typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      if (total + buf.length > cap) {
        const remain = cap - total;
        if (remain > 0) {
          chunks.push(buf.subarray(0, remain));
          total += remain;
        }
        truncated = true;
        // 继续读但不累积(避免阻塞子进程 pipe);resolve 在 end 时触发。
        return;
      }
      chunks.push(buf);
      total += buf.length;
    });
    stream.on('end', () => {
      const text = Buffer.concat(chunks)
        .toString('utf8')
        .replace(/\r?\n$/, '');
      resolve(truncated ? `${text}\n[truncated to ${cap} chars]` : text);
    });
    stream.on('error', reject);
  });
}
