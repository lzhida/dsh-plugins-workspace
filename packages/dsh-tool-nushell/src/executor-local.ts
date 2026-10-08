import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ShellExecutor } from '@deepseek-ai/dsh-shell';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
} from '@deepseek-ai/dsh-subprocess';
import {
  clampTimeout,
  deadline,
  MAX_TIMER_DELAY_MS,
  timeoutOf,
} from '@deepseek-ai/dsh-timeout';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';

import { NUSHELL_RUNTIME } from './executor-runtime.ts';

/**
 * Nushell 本地执行器实现(归宿:tool 包)。经 `ctx.subprocess` 委托
 * 执行;作为 `dsh-nushell-local` 的组合行挂载时向宿主注入 `ctx.shell`
 * 能力——nushell 以一等 shell 身份进入官方 shell 家族(与
 * dsh-pwsh-local 对 PowerShell 的角色一致);由 dsh-tool-nushell 内部
 * 实例化时是直跑模式的执行核心,不占接缝。前台/后台执行、
 * 有界输出、spill 文件与受管终止都是 subprocess 服务的机制;本 executor
 * 只负责按配置供给预算并拼装 nu 方言的 argv(`nu --no-config-file -c`,
 * 禁用用户配置保证可复现的干净求值环境)。沙箱:nu 无语言级沙箱等价物,
 * 保持基类 `sandboxMode` 缺省(无沙箱),不做 confining 子类。
 *
 * 0.1.7 契约:执行器单一入口 `execute(spec)` 返回执行句柄
 * `ShellExecution`(进程句柄 + `result()` 前台投影),前台/后台是调用方
 * 等待方式的属性;`onExpiry: 'none'` 不设截止时间(后台/升格调用由调用方
 * 自行设界)。配置采用 0.1.7 活值形态:`static Config` 声明 + 全字段
 * volatile,loader 注入 `{ get() }` 快照访问器实现设置层热更新;直跑模式
 * 传普通值,{@link liveValue} 统一读取。
 */

/**
 * 活值字段:0.1.7 loader 对 `static Config` 的 volatile 字段注入
 * `{ get() }` 快照访问器(设置层编辑热生效);组合入口与直跑模式传普通值。
 */
export type LiveField<T> = T | { get(): T };

/** 读一次活值字段:访问器取当前快照,普通值原样返回(直跑模式无热更新)。 */
export function liveValue<T>(field: LiveField<T>): T {
  if (typeof field === 'object' && field !== null && 'get' in field) {
    return (field as { get(): T }).get();
  }
  return field;
}

/** 读一个可缺省的活值字段,未设(缺字段或快照为 undefined)时回退缺省值。 */
function field<T>(value: LiveField<T | undefined> | undefined, fallback: T): T {
  const current = peekField(value);
  return current === undefined || current === null ? fallback : current;
}

/** 读一个可缺省的活值字段,字段缺失或快照为 undefined 时返回 undefined。 */
export function peekField<T>(
  value: LiveField<T | undefined> | undefined,
): T | undefined {
  return value === undefined ? undefined : liveValue(value);
}

/** executor 运行时配置(全部字段可为活值访问器;缺省值见 {@link DEFAULT_NUSHELL_CONFIG})。 */
export interface NushellLocalConfig {
  /** 后台兜底工作目录;前台请求未带 workdir 时使用,再回退进程 cwd。 */
  cwd?: LiveField<string | undefined>;
  /** 默认超时毫秒数。 */
  timeoutMs?: LiveField<number | undefined>;
  /** 超时上限(请求值钳制边界)。 */
  maxTimeoutMs?: LiveField<number | undefined>;
  /** 单流在内存中收集的字节预算(超出落 spill)。 */
  maxOutputBytes?: LiveField<number | undefined>;
  /** 单流 spill 文件字节上限。 */
  maxSpillBytes?: LiveField<number | undefined>;
  /** SIGTERM → SIGKILL 宽限期。 */
  graceMs?: LiveField<number | undefined>;
  /** nu 可执行文件路径;缺省走 PATH 查找的 `nu`。 */
  nuPath?: LiveField<string | undefined>;
}

/** 生效配置快照:活值访问器已归一为普通值(每次读取即时快照)。 */
export interface NushellResolvedConfig {
  cwd: string;
  timeoutMs: number;
  maxTimeoutMs: number;
  maxOutputBytes: number;
  maxSpillBytes: number;
  graceMs: number;
  nuPath: string;
}

/** 默认超时代码:capability-owned,与官方 shell 家族(bash/pwsh)共享。 */
const NU_TIMEOUT = 'BASH_TIMEOUT';

const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;

export const DEFAULT_NUSHELL_CONFIG: Omit<NushellResolvedConfig, 'cwd'> = {
  timeoutMs: 30_000,
  maxTimeoutMs: 600_000,
  maxOutputBytes: 64_000,
  maxSpillBytes: DEFAULT_MAX_SPILL_BYTES,
  graceMs: 3_000,
  nuPath: 'nu',
};

/**
 * 模型友好环境覆盖:关掉会污染工具输出的颜色与分页器(`TERM=dumb` 是
 * POSIX 概念,nushell 跨平台,与 pwsh-local 一致地不设置)。
 */
const ENV_OVERRIDES: Record<string, string> = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
};

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`nushell-local: ${name} must be a positive finite number`);
  }
}

/** 拒绝无法运行的配置段:正数/有限性由 schema 表达不了,在每次使用处拒绝。 */
export function assertServiceableNushellConfig(
  config: Omit<NushellResolvedConfig, 'cwd'>,
): void {
  assertPositiveFinite('timeoutMs', config.timeoutMs);
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs);
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes);
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes);
  assertPositiveFinite('graceMs', config.graceMs);
  if (config.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `nushell-local: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
}

/**
 * Windows 上的 nu 候选可执行文件:PATH 逐项 + 常见安装点(scoop shims /
 * Program Files / cargo bin)。与 pwsh 的 newest-first 有意不同:PATH 优先,
 * 尊重用户活跃安装(scoop shims 通常在 PATH 上)。仅 win32 语义——POSIX
 * 的 spawn 本身按 PATH 解析,无需探测(与 pwsh-local 同理)。
 */
export function candidateNuPaths(env: NodeJS.ProcessEnv): string[] {
  const candidates: string[] = [];
  for (const entry of (env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '');
    if (trimmed.length > 0) candidates.push(join(trimmed, 'nu.exe'));
  }
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  candidates.push(join(programFiles, 'nu', 'bin', 'nu.exe'));
  const userProfile = env.USERPROFILE ?? '';
  const scoopHome =
    env.SCOOP || (userProfile.length > 0 ? join(userProfile, 'scoop') : '');
  if (scoopHome.length > 0) candidates.push(join(scoopHome, 'shims', 'nu.exe'));
  const cargoHome =
    env.CARGO_HOME ||
    (userProfile.length > 0 ? join(userProfile, '.cargo') : '');
  if (cargoHome.length > 0) candidates.push(join(cargoHome, 'bin', 'nu.exe'));
  return candidates;
}

/** 存在性探测:符号链接不穿透的文件检查(lstat),测试可注入替身。 */
export type NuPathExists = (candidate: string) => boolean;

function nuFileExists(candidate: string): boolean {
  return lstatSync(candidate, { throwIfNoEntry: false })?.isFile() ?? false;
}

/**
 * 解析 nu 可执行文件:显式 `nuPath` 配置优先;Windows 上依次探测
 * {@link candidateNuPaths}(PATH → 常见安装点),全未命中兜底 PATH 语义的
 * `nu`;POSIX 直接交给 PATH。纯函数:env/platform/exists 全部显式参数化,
 * 测试无需真实文件系统。
 */
export function resolveNuPath(
  configured: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: NuPathExists = nuFileExists,
): string {
  if (configured !== undefined && configured.length > 0) return configured;
  if (platform === 'win32') {
    for (const candidate of candidateNuPaths(env)) {
      if (exists(candidate)) return candidate;
    }
  }
  return 'nu';
}

/** 把已结算的 collect-mode reader 投影成最终 CollectedOutput 形状。 */
function finalOutput(reader: {
  readFrom(offset: number): {
    text: string;
    lossy: boolean;
    spillPath?: string;
  };
}): {
  text: string;
  truncated: boolean;
  spillPath?: string;
} {
  const read = reader.readFrom(0);
  return {
    text: read.text,
    truncated: read.lossy,
    ...(read.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  };
}

/**
 * 已知 nu 包装层特征 → 诊断注记。案例:本机 scoop 版 nu 被 pi-natives
 * 注入包装,`nu -c` 对部分 payload(metadata/error make/带引号 print)报
 * syntax error 且错误列号漂移超过命令长度——注入代码有解析缺陷,脚本
 * 文件方式不受影响。命中特征时在 stderr 尾部附提示,引导换官方 nu。
 */
const WRAPPED_NU_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /pi-natives/i,
    'the nu binary appears to be wrapped by an injected "pi-natives" layer; ' +
      '`nu -c` mis-parses some payloads (metadata, error make, quoted print) ' +
      'with column numbers drifting past the command length — ' +
      'point nuPath at an official nu build',
  ],
];

/** stderr 命中已知包装特征时附诊断注记,否则原样返回。 */
export function annotateWrappedNu(stderrText: string): string {
  for (const [pattern, note] of WRAPPED_NU_PATTERNS) {
    if (pattern.test(stderrText)) {
      const glue =
        stderrText.length > 0 && !stderrText.endsWith('\n') ? '\n' : '';
      return `${stderrText}${glue}[nushell-local: ${note}]`;
    }
  }
  return stderrText;
}

/** 对 collect 流形状做 stderr 注记(前台结算与后台增量共用),保持其余字段。 */
function annotateStream<T extends { text: string }>(stream: T): T {
  const annotated = annotateWrappedNu(stream.text);
  return annotated === stream.text ? stream : { ...stream, text: annotated };
}

/** 手写 withResolvers:仓库 TS lib 为 ES2022,无 Promise.withResolvers。 */
function withResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class NushellLocalExecutor extends ShellExecutor {
  static inject = ['subprocess'];

  /** 接缝标记:tool 层探针据此识别 nushell 执行器(见 executor-runtime.ts)。 */
  readonly runtime = NUSHELL_RUNTIME;

  /**
   * 设置表单 schema(0.1.7 SettingsForms 时代:静态声明即注册,全部字段
   * volatile——用户在设置层修改后经活值访问器热生效,无需重载插件;
   * cwd/nuPath 无缺省——语义是「未设时回退」:cwd 回退进程 cwd,
   * nuPath 回退 {@link resolveNuPath} 候选链)。与官方 PwshLocalExecutor.Config 同构。
   */
  static Config = z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(DEFAULT_NUSHELL_CONFIG.timeoutMs).volatile(),
    maxTimeoutMs: z
      .number()
      .default(DEFAULT_NUSHELL_CONFIG.maxTimeoutMs)
      .volatile(),
    maxOutputBytes: z
      .number()
      .default(DEFAULT_NUSHELL_CONFIG.maxOutputBytes)
      .volatile(),
    maxSpillBytes: z
      .number()
      .default(DEFAULT_NUSHELL_CONFIG.maxSpillBytes)
      .volatile(),
    graceMs: z.number().default(DEFAULT_NUSHELL_CONFIG.graceMs).volatile(),
    nuPath: z.string().volatile(),
  });

  /** 声明态配置:loader 活值访问器或普通值,读取时经 {@link liveValue} 归一。 */
  protected readonly config: NushellLocalConfig;
  /** 最近一次可见的声明 nuPath 值(解析值变化时才重新探测候选链)。 */
  private declaredNuPath: string | undefined;
  /** 声明值经候选链解析后的可执行文件(argv 实际使用)。 */
  private cachedNuPath: string;

  constructor(ctx: Context, config: NushellLocalConfig = {}) {
    super(ctx);
    this.config = config;
    this.declaredNuPath = peekField(config.nuPath);
    this.cachedNuPath = resolveNuPath(this.declaredNuPath);
  }

  /**
   * 当前生效的 nu 可执行文件:声明值变化(设置层 volatile 热更——同一
   * 访问器对象内的快照更新)时重新探测候选链;身份不变的访问器也要比对
   * 解析值,故这里比较的是值而非访问器引用。
   */
  protected get nuPath(): string {
    const declared = peekField(this.config.nuPath);
    if (declared !== this.declaredNuPath) {
      this.cachedNuPath = resolveNuPath(declared);
      this.declaredNuPath = declared;
    }
    return this.cachedNuPath;
  }

  /** 生效配置快照:活值取当前值,缺省字段由 DEFAULT 兜底(cwd 回退进程 cwd)。 */
  protected get resolved(): NushellResolvedConfig {
    const c = this.config;
    return {
      cwd: field(c.cwd, process.cwd()),
      timeoutMs: field(c.timeoutMs, DEFAULT_NUSHELL_CONFIG.timeoutMs),
      maxTimeoutMs: field(c.maxTimeoutMs, DEFAULT_NUSHELL_CONFIG.maxTimeoutMs),
      maxOutputBytes: field(
        c.maxOutputBytes,
        DEFAULT_NUSHELL_CONFIG.maxOutputBytes,
      ),
      maxSpillBytes: field(
        c.maxSpillBytes,
        DEFAULT_NUSHELL_CONFIG.maxSpillBytes,
      ),
      graceMs: field(c.graceMs, DEFAULT_NUSHELL_CONFIG.graceMs),
      nuPath: field(c.nuPath, DEFAULT_NUSHELL_CONFIG.nuPath),
    };
  }

  /**
   * 把请求解析成完整 spec:workdir 取请求值(否则配置 cwd,再回退进程
   * cwd),timeoutMs 取请求值并按默认/上限钳制,stdout 预算取请求值,
   * onExpiry 缺省 'kill'(到点杀)。
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const cfg = this.resolved;
    assertServiceableNushellConfig(cfg);
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      cfg.timeoutMs,
      cfg.maxTimeoutMs,
      'nushell-local: request.timeoutMs',
    );
    const stdoutMaxBytes = request.stdoutMaxBytes ?? cfg.maxOutputBytes;
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes);
    return {
      command: request.command,
      workdir: request.workdir ?? cfg.cwd ?? process.cwd(),
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: request.sandboxPolicy,
    };
  }

  /** 一次已解析 spec 的 nu 调用 argv——供 confining 子类包装的 argv 层接缝。 */
  argv(spec: ShellExecSpec): string[] {
    return [this.nuPath, '--no-config-file', '-c', spec.command];
  }

  /** 把已解析 spec 加上映射后的 argv,组成完整的 subprocess spawn。 */
  spawnSpec(
    spec: ShellExecSpec,
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
    argv: string[],
  ): Parameters<Context['subprocess']['spawn']>[0] {
    const collect = (maxBytes: number) => ({
      maxBytes,
      spill: { maxBytes: this.resolved.maxSpillBytes },
    });
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.resolved.maxOutputBytes),
      },
      graceMs: this.resolved.graceMs,
      signal,
      env: {
        ...ENV_OVERRIDES,
        ...spec.env,
        ...spec.dshEnv,
      },
    };
  }

  /** executor 自己请求的 collect-mode readers(按接缝契约必然存在)。 */
  static collected(handle: SubprocessHandle): {
    stdout: NonNullable<SubprocessHandle['collected']>['stdout'] & object;
    stderr: NonNullable<SubprocessHandle['collected']>['stderr'] & object;
  } {
    const { stdout, stderr } = handle.collected;
    if (stdout === undefined || stderr === undefined) {
      throw new Error(
        'nushell-local: subprocess implementation dropped a requested collect stream',
      );
    }
    return { stdout, stderr };
  }

  /**
   * 执行一次已解析 spec:`execute` 是 0.1.7 的单一入口,前台/后台由调用方
   * 等待方式决定——`await` 返回句柄的 `result()` 即前台,保留句柄即后台。
   */
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    return this.executeArgv(spec, this.argv(spec));
  }

  /**
   * 按精确 argv 的执行(沙箱子类经此在准备期包装 argv)。生命周期、环境、
   * 输出、截止与取消语义对齐官方 pwsh-local 的 executeArgv:
   * - `onExpiry: 'kill'` 到点杀并按 first-cause 分类 timedOut/aborted;
   *   `'none'` 不设截止,只响应调用方 signal。
   * - 准备期(argv 为函数)取消/到点分别走抛错与「已结算的 timedOut 空句柄」。
   * - spawn 失败:句柄按 killed 结算、读路径带 provider 失败注记,
   *   `result()` 以同一失败拒绝(仅基础设施失败才拒绝)。
   * - `onStarted` 在句柄发布前同步安装 per-process 事实(沙箱分类键)。
   */
  async executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare:
      string[] | ((signal: AbortSignal) => Promise<string[]> | string[]),
    onStarted?: (proc: ShellProcess) => void,
  ): Promise<ShellExecution> {
    let spawnSignal: AbortSignal | undefined;
    let classify: () => { timedOut: boolean; aborted: boolean };
    let disarm = (): void => {};
    if (spec.onExpiry === 'kill') {
      const d = deadline(spec.signal, spec.timeoutMs, NU_TIMEOUT);
      spawnSignal = d.signal;
      classify = () => {
        const timedOut = timeoutOf(d.signal, NU_TIMEOUT) !== undefined;
        return {
          timedOut,
          aborted: d.signal.aborted && !timedOut,
        };
      };
      disarm = () => {
        d[Symbol.dispose]();
      };
    } else {
      spawnSignal = spec.signal;
      classify = () => ({
        timedOut: false,
        aborted: spec.signal?.aborted === true,
      });
    }

    let argv: string[] = [];
    let preparationTimedOut = false;
    if (typeof argvOrPrepare === 'function') {
      const signal = spawnSignal ?? new AbortController().signal;
      const cancelled = withResolvers<never>();
      const abort = (): void => {
        cancelled.reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        argv = await Promise.race([
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return argvOrPrepare(signal);
          }),
          cancelled.promise,
        ]);
        signal.throwIfAborted();
      } catch (error) {
        if (!classify().timedOut) {
          disarm();
          throw error;
        }
        preparationTimedOut = true;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    } else {
      argv = argvOrPrepare;
    }

    let running: SubprocessHandle | undefined;
    let syncSpawnError: { error: unknown } | undefined;
    try {
      if (!preparationTimedOut) {
        running = this.ctx.subprocess.spawn(
          this.spawnSpec(spec, spec.stdoutMaxBytes, spawnSignal, argv),
        );
      }
    } catch (error) {
      syncSpawnError = { error };
    }

    /** 未 spawn(准备期到点)时的空读替身。 */
    const emptyReader = {
      readFrom: (): SubprocessOutputRead => ({
        text: '',
        lossy: false,
        nextOffset: 0,
      }),
    };
    const collected =
      running !== undefined
        ? NushellLocalExecutor.collected(running)
        : { stdout: emptyReader, stderr: emptyReader };
    const spawnThrow = (): unknown => syncSpawnError?.error;
    const spawned: Promise<SubprocessOutcome> = preparationTimedOut
      ? Promise.resolve({ exitCode: null, signal: null })
      : running !== undefined
        ? running.done
        : Promise.reject(spawnThrow());

    let providerError: unknown;
    let providerNote: string | undefined;
    let providerNoteReported = false;
    const consumeProviderNote = (): string => {
      if (providerNote === undefined || providerNoteReported) return '';
      providerNoteReported = true;
      return providerNote;
    };
    /** 非消费 stderr 观察读:provider 失败后整个流就是失败注记。 */
    const observedStderr = {
      readFrom: (fromByte: number) => {
        if (providerNote === undefined) {
          return collected.stderr.readFrom(fromByte);
        }
        const note = Buffer.from(providerNote, 'utf8');
        return {
          text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'),
          nextOffset: note.length,
          lossy: false,
        };
      },
    };

    let stdoutOffset = 0;
    let stderrOffset = 0;
    let resultPromise: Promise<ShellRunResult> | undefined;
    const proc: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: {
        stdout: collected.stdout,
        stderr: observedStderr,
      },
      done: spawned.then(
        (outcome) => {
          if (proc.status === 'running') {
            proc.status =
              spawnSignal?.aborted === true || outcome.signal !== null
                ? 'killed'
                : 'completed';
          }
          proc.exitCode = outcome.exitCode;
          proc.signal = outcome.signal;
          this.onProcessDone(
            proc,
            collected.stderr.readFrom(0).text,
            false,
            undefined,
          );
          disarm();
        },
        (error) => {
          if (
            running !== undefined &&
            (proc.status === 'killed' || spawnSignal?.aborted === true)
          ) {
            // 我方终止引发的 provider 报错:按正常 killed 结算,不算失败。
            proc.status = 'killed';
            this.onProcessDone(
              proc,
              collected.stderr.readFrom(0).text,
              false,
              undefined,
            );
            disarm();
            return;
          }
          proc.status = 'killed';
          providerError = error;
          let detail = 'unprintable provider failure';
          try {
            detail = String(error);
          } catch {
            /* keep sentinel */
          }
          providerNote = `subprocess failed before reporting an outcome: ${detail}`;
          this.onProcessDone(proc, providerNote, true, providerError);
          disarm();
        },
      ),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset);
        const err = collected.stderr.readFrom(stderrOffset);
        stdoutOffset = out.nextOffset;
        stderrOffset = err.nextOffset;
        const annotatedErr = annotateStream(err);
        const providerFailure = consumeProviderNote();
        const failureSeparator =
          annotatedErr.text.length > 0 && !annotatedErr.text.endsWith('\n')
            ? '\n'
            : '';
        const errText =
          annotatedErr.text +
          (providerFailure.length > 0
            ? `${failureSeparator}${providerFailure}`
            : '');
        const separator =
          out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : '';
        return {
          delta:
            out.text +
            (errText.length > 0 ? `${separator}[stderr]\n${errText}` : ''),
          lossy: out.lossy || err.lossy,
          ...(out.spillPath !== undefined
            ? { stdoutSpillPath: out.spillPath }
            : {}),
          ...(err.spillPath !== undefined
            ? { stderrSpillPath: err.spillPath }
            : {}),
        };
      },
      kill: () => {
        if (proc.status !== 'running') return false;
        proc.status = 'killed';
        running?.terminate();
        return true;
      },
      result: () => {
        resultPromise ??= proc.done.then(() => {
          if (providerNote !== undefined) throw providerError;
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            ...classify(),
            timeoutMs: spec.timeoutMs,
            stdout: finalOutput(collected.stdout),
            stderr: annotateStream(finalOutput(collected.stderr)),
          };
        });
        return resultPromise;
      },
    };
    if (!preparationTimedOut) {
      onStarted?.(proc);
    }
    return proc;
  }

  /**
   * 结算钩子:子类在句柄上附加执行事实(本基类有意为空;镜像官方
   * pwsh-local/bash-local——其沙箱消费方在结算点分类 runner 失败与拒绝)。
   * 子类覆写以 (proc, stderr, providerRejected, providerError) 消费事实。
   */
  protected onProcessDone(
    proc: ShellProcess,
    stderr: string,
    providerRejected: boolean,
    providerError: unknown,
  ): void {
    void proc;
    void stderr;
    void providerRejected;
    void providerError;
  }
}

export default NushellLocalExecutor;
