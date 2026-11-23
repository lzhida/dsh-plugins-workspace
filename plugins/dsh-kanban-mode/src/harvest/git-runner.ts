/**
 * 收割 git 基建:git 子进程封装(capture / 退出码 / 错误分类)。
 *
 * 设计依据 docs/harvest-design.md §4/§6:收割管线的全部 git 动作都经由本面
 * spawn 真实 git 子进程;本面只负责「执行 + 退出码 + 错误分类」,不含任何
 * 收割语义(审查/变基/合并语义在 inspect.ts 与后续管线中组合)。
 *
 * 错误分类(GitRunnerError.kind,三类可操作错误 + 版本过低):
 * - `git-missing`:git 二进制未能启动(spawn ENOENT,未安装或不在 PATH);
 * - `not-a-repo`:目标目录不是 git 仓库(stderr 含 not a git repository);
 * - `command-failed`:其余失败(未知子命令、分支不存在、超时、进程启动异常等);
 * - `git-too-old`:git 版本低于要求(requireVersionAtLeast 版本探测)。
 *
 * 输出策略:stdout/stderr 按字节上限收集,超限后停止追加、只继续排空事件
 * 不阻塞进程——子进程自然退出,拿到真实退出码并标记 truncated(大输出截断
 * 不阻塞,对应收割 1/6 卡「边界情况」要求)。
 *
 * @module dsh-kanban-mode/harvest/git-runner
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';

/** 默认输出上限(字节),超过后停止收集并标记截断(与上游结算证据 maxBuffer 同量级口径)。 */
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** 默认命令超时(毫秒):覆盖 rev-parse / status / log / diff 等快速只读查询。 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** 版本探测专用超时(毫秒):`git --version` 是进程级快查。 */
const VERSION_TIMEOUT_MS = 5_000;

/**
 * 固定注入的 git 全局配置:`core.quotePath=false` 防止非 ASCII 文件名
 * (中文路径很常见)在 diff/log 输出里被转义成八进制序列,保证 changedFiles
 * 等清单直接可读可匹配。作为全局参数置于子命令之前,对所有子命令生效。
 */
const QUOTE_PATH_ARGS = ['-c', 'core.quotePath=false'] as const;

/** 错误分类码。前三类来自命令执行,`git-too-old` 来自版本探测判定。 */
export type GitErrorKind =
  'git-missing' | 'not-a-repo' | 'command-failed' | 'git-too-old';

/** 结构化 git 版本号。 */
export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** 归一化版本文本(如 `2.56.1`),供可操作错误文案直接引用。 */
  readonly raw: string;
}

/** 一次 capture 的可选项。 */
export interface GitCaptureOptions {
  /** 工作目录(仓库根或其子目录);缺省继承当前进程 cwd。 */
  readonly cwd?: string;
  /** 命令超时(毫秒);缺省 {@link DEFAULT_TIMEOUT_MS}。 */
  readonly timeoutMs?: number;
  /** stdout/stderr 各自的字节收集上限;缺省 {@link DEFAULT_MAX_OUTPUT_BYTES}。 */
  readonly maxOutputBytes?: number;
}

/** 一次底层执行的完整结果:`ok` 即退出码为 0。 */
export interface GitCaptureResult {
  readonly ok: boolean;
  /** 子进程退出码;进程未能启动(spawn 失败)时为 null。 */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 输出超上限被截断(退出码仍然真实)。 */
  readonly truncated: boolean;
  /** 触发超时、进程被终止。 */
  readonly timedOut: boolean;
}

/** 构造 GitRunnerError 的附加明细。 */
export interface GitRunnerErrorDetails {
  readonly args?: readonly string[];
  readonly exitCode?: number | null;
  readonly stderr?: string;
}

/** git 执行的可操作错误:kind 供调用方分类处理,message 供直接展示。 */
export class GitRunnerError extends Error {
  readonly kind: GitErrorKind;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(
    kind: GitErrorKind,
    message: string,
    details: GitRunnerErrorDetails = {},
  ) {
    super(message);
    this.name = 'GitRunnerError';
    this.kind = kind;
    this.args = details.args ?? [];
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? '';
  }
}

/**
 * 把一次失败的原始信息归类为错误码(纯函数,单测直接覆盖)。
 * 判定顺序:超时 → 进程未启动(ENOENT=git 缺失,其余=启动失败)→ stderr
 * 含 `not a git repository` → 非 git 目录 → 其余归命令失败。
 */
export function classifyGitFailure(input: {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stderr: string;
}): GitErrorKind {
  if (input.timedOut) return 'command-failed';
  if (input.exitCode === null) {
    return input.stderr.includes('ENOENT') ? 'git-missing' : 'command-failed';
  }
  return input.stderr.toLowerCase().includes('not a git repository')
    ? 'not-a-repo'
    : 'command-failed';
}

/** 解析 `git --version` 的标准输出(纯函数):支持 `2.56.1.windows.1` / `2.38` 等形态。 */
export function parseGitVersion(stdout: string): GitVersion | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout.trim());
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  if (
    !Number.isFinite(major) ||
    !Number.isFinite(minor) ||
    !Number.isFinite(patch)
  ) {
    return undefined;
  }
  return { major, minor, patch, raw: `${major}.${minor}.${patch}` };
}

/** 版本比较:v 是否 ≥ min(纯函数)。 */
export function versionAtLeast(v: GitVersion, min: GitVersion): boolean {
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/** Windows 路径分隔符归一:反斜杠统一为 POSIX 斜杠(收割输出清单统一口径)。 */
export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** git-runner 的窄接口:收割管线与 inspect 只依赖这四个能力。 */
export interface GitRunner {
  /**
   * 执行 `git <args>` 并返回完整结果;**永不抛**——spawn 失败、超时、非零
   * 退出都折叠进结果(ok=false),由调用方按退出码/语义判定(如
   * `merge-base --is-ancestor` 的 exit 1 是语义而非失败)。
   */
  capture(
    args: readonly string[],
    options?: GitCaptureOptions,
  ): Promise<GitCaptureResult>;
  /** 执行并要求成功;失败时抛 {@link GitRunnerError}(已按三类分类)。 */
  captureOrThrow(
    args: readonly string[],
    options?: GitCaptureOptions,
  ): Promise<GitCaptureResult>;
  /** 探测本机 git 版本;git 缺失抛 `git-missing`,输出无法解析抛 `command-failed`。 */
  version(): Promise<GitVersion>;
  /** 要求 git 版本 ≥ min:满足则返回当前版本,不足抛 `git-too-old`(可操作文案)。 */
  requireVersionAtLeast(min: GitVersion): Promise<GitVersion>;
}

/** createGitRunner 的可选项。 */
export interface GitRunnerOptions {
  /**
   * git 二进制名或绝对路径;缺省 `git`(走 PATH 查找)。测试可注入一个
   * 不存在的名字来模拟「git 未安装」路径。
   */
  readonly gitBinary?: string;
}

/**
 * 执行一条 git 命令(底层 spawn,永不抛):手动收集 stdout/stderr,
 * 超限截断不阻塞,超时终止进程。
 */
function runGitProcess(
  binary: string,
  args: readonly string[],
  options: GitCaptureOptions,
): Promise<GitCaptureResult> {
  return new Promise<GitCaptureResult>((resolve) => {
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let child: ChildProcess;
    try {
      child = spawn(binary, [...QUOTE_PATH_ARGS, ...args], {
        cwd: options.cwd,
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      // spawn 同步抛出(个别平台限制):折叠为失败结果,与异步路径同形。
      resolve({
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: `spawn ${binary} failed: ${err instanceof Error ? err.message : String(err)}`,
        truncated: false,
        timedOut: false,
      });
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let truncated = false;
    let timedOut = false;
    let settled = false;

    /** 挂接输出收集:超限后停止追加、继续排空事件(进程自然退出拿真实退出码)。 */
    const attach = (
      stream: Readable | null,
      chunks: Buffer[],
      state: { bytes: number },
    ): void => {
      if (stream === null) return;
      stream.on('data', (chunk: Buffer) => {
        if (state.bytes >= maxOutputBytes) {
          truncated = true;
          return;
        }
        chunks.push(chunk);
        state.bytes += chunk.length;
        if (state.bytes > maxOutputBytes) truncated = true;
      });
    };
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    attach(child.stdout, stdoutChunks, stdoutState);
    attach(child.stderr, stderrChunks, stderrState);

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0 && !timedOut,
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
        timedOut,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (err) => {
      // spawn 失败(如 ENOENT):进程从未启动。把原始错误写入 stderr,
      // 供 classifyGitFailure 识别 ENOENT 并归类 git-missing。
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      stderrChunks.push(
        Buffer.from(`spawn ${binary} failed (${code}): ${err.message}`),
      );
      finish(null);
    });
    child.on('close', (exitCode) => finish(exitCode));
  });
}

/** 把失败结果转成带分类的可操作错误。 */
function failureToError(
  args: readonly string[],
  result: GitCaptureResult,
  cwd: string | undefined,
): GitRunnerError {
  const cmdline = `git ${args.join(' ')}`;
  const kind = classifyGitFailure({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stderr: result.stderr,
  });
  if (kind === 'git-missing') {
    return new GitRunnerError(
      'git-missing',
      'git 不可用:未能启动 git 进程(spawn ENOENT)。请确认 git 已安装并在 PATH 中',
      { args, stderr: result.stderr },
    );
  }
  if (kind === 'not-a-repo') {
    return new GitRunnerError(
      'not-a-repo',
      `${cwd ?? '(未指定目录)'} 不是 git 仓库(命令:${cmdline})。请确认路径指向 git 仓库或 worktree`,
      { args, exitCode: result.exitCode, stderr: result.stderr },
    );
  }
  if (result.timedOut) {
    return new GitRunnerError(
      'command-failed',
      `git 命令超时,进程已被终止:${cmdline}`,
      { args, exitCode: result.exitCode, stderr: result.stderr },
    );
  }
  if (result.exitCode === null) {
    // 进程启动失败但不是 ENOENT(如权限问题):如实报告原始错误。
    return new GitRunnerError(
      'command-failed',
      `git 进程启动失败:${result.stderr.trim()}`,
      { args, stderr: result.stderr },
    );
  }
  return new GitRunnerError(
    'command-failed',
    `git 命令失败(exit ${result.exitCode}):${cmdline};${result.stderr.trim().slice(0, 300)}`,
    { args, exitCode: result.exitCode, stderr: result.stderr },
  );
}

/**
 * 构造真实 git 子进程封装。生产用缺省 `git`;测试可注入 `gitBinary` 模拟
 * git 缺失路径。
 */
export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const binary = options.gitBinary ?? 'git';
  const capture = (
    args: readonly string[],
    captureOptions?: GitCaptureOptions,
  ): Promise<GitCaptureResult> =>
    runGitProcess(binary, args, captureOptions ?? {});
  const captureOrThrow = async (
    args: readonly string[],
    captureOptions?: GitCaptureOptions,
  ): Promise<GitCaptureResult> => {
    const result = await capture(args, captureOptions);
    if (result.ok) return result;
    throw failureToError(args, result, captureOptions?.cwd);
  };
  const version = async (): Promise<GitVersion> => {
    const result = await captureOrThrow(['--version'], {
      timeoutMs: VERSION_TIMEOUT_MS,
    });
    const parsed = parseGitVersion(result.stdout);
    if (parsed === undefined) {
      throw new GitRunnerError(
        'command-failed',
        `无法解析 git 版本输出:「${result.stdout.trim().slice(0, 100)}」`,
        { args: ['--version'], stderr: result.stderr },
      );
    }
    return parsed;
  };
  const requireVersionAtLeast = async (
    min: GitVersion,
  ): Promise<GitVersion> => {
    const current = await version();
    if (!versionAtLeast(current, min)) {
      throw new GitRunnerError(
        'git-too-old',
        `git 版本过低(当前 ${current.raw},需要 ≥ ${min.raw})。请升级 git 后重试(冲突预检 merge-tree 等能力依赖新版本)`,
        {
          args: ['--version'],
          stderr: `current=${current.raw} required=${min.raw}`,
        },
      );
    }
    return current;
  };
  return { capture, captureOrThrow, version, requireVersionAtLeast };
}
