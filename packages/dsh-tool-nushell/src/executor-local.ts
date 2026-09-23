import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHELL_SETTINGS_NAMESPACE,
  ShellExecutor,
} from '@deepseek-ai/dsh-shell';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import {
  clampTimeout,
  deadline,
  MAX_TIMER_DELAY_MS,
  timeoutOf,
} from '@deepseek-ai/dsh-timeout';
import type { Context } from '@deepseek-ai/cordis';
// 副作用导入:激活 dsh-settings 对 cordis Context 的 `ctx.settings` 类型增强。
import '@deepseek-ai/dsh-settings';
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
 */

/** executor 运行时配置(全部可选,缺省值见 {@link DEFAULT_NUSHELL_CONFIG})。 */
export interface NushellLocalConfig {
  /** 后台兜底工作目录;前台请求未带 workdir 时使用,再回退进程 cwd。 */
  cwd?: string;
  /** 默认超时毫秒数。 */
  timeoutMs?: number;
  /** 超时上限(请求值钳制边界)。 */
  maxTimeoutMs?: number;
  /** 单流在内存中收集的字节预算(超出落 spill)。 */
  maxOutputBytes?: number;
  /** 单流 spill 文件字节上限。 */
  maxSpillBytes?: number;
  /** SIGTERM → SIGKILL 宽限期。 */
  graceMs?: number;
  /** nu 可执行文件路径;缺省走 PATH 查找的 `nu`。 */
  nuPath?: string;
}

/** 默认超时代码:capability-owned,与官方 shell 家族(bash/pwsh)共享。 */
const NU_TIMEOUT = 'BASH_TIMEOUT';

const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;

export const DEFAULT_NUSHELL_CONFIG: Omit<
  Required<NushellLocalConfig>,
  'cwd'
> = {
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

/** 拒绝无法运行的配置段:正数/有限性由 schema 表达不了,在写入处拒绝。 */
export function assertServiceableNushellConfig(
  config: Omit<Required<NushellLocalConfig>, 'cwd'>,
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

export class NushellLocalExecutor extends ShellExecutor {
  static inject = ['subprocess'];

  /** 接缝标记:tool 层探针据此识别 nushell 执行器(见 executor-runtime.ts)。 */
  readonly runtime = NUSHELL_RUNTIME;

  /**
   * settings 命名空间 schema(与官方 PwshLocalExecutor.Config 同构):
   * 数值字段带 schemastery 缺省;cwd/nuPath 无缺省——语义是「未设时回退」
   * (cwd 回退进程 cwd,nuPath 回退 {@link resolveNuPath} 候选链)。
   */
  static Config = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(DEFAULT_NUSHELL_CONFIG.timeoutMs),
    maxTimeoutMs: z.number().default(DEFAULT_NUSHELL_CONFIG.maxTimeoutMs),
    maxOutputBytes: z.number().default(DEFAULT_NUSHELL_CONFIG.maxOutputBytes),
    maxSpillBytes: z.number().default(DEFAULT_NUSHELL_CONFIG.maxSpillBytes),
    graceMs: z.number().default(DEFAULT_NUSHELL_CONFIG.graceMs),
    nuPath: z.string(),
  });

  /** 当前权威配置来源:settings 解析段,settings 未挂载时回退组合入口。 */
  private source: () => NushellLocalConfig;
  /** 最近一次可见的声明 nuPath(onChange 去重)。 */
  private declaredNuPath: string | undefined;
  /** 声明值经候选链解析后的可执行文件(argv 实际使用)。 */
  private resolvedNuPath: string;

  /** 生效配置:settings 段或组合入口,缺省字段由 DEFAULT 兜底(cwd 回退进程 cwd)。 */
  get config(): Required<NushellLocalConfig> {
    const source = this.source();
    return {
      cwd: source.cwd ?? process.cwd(),
      timeoutMs: source.timeoutMs ?? DEFAULT_NUSHELL_CONFIG.timeoutMs,
      maxTimeoutMs: source.maxTimeoutMs ?? DEFAULT_NUSHELL_CONFIG.maxTimeoutMs,
      maxOutputBytes:
        source.maxOutputBytes ?? DEFAULT_NUSHELL_CONFIG.maxOutputBytes,
      maxSpillBytes:
        source.maxSpillBytes ?? DEFAULT_NUSHELL_CONFIG.maxSpillBytes,
      graceMs: source.graceMs ?? DEFAULT_NUSHELL_CONFIG.graceMs,
      nuPath: source.nuPath ?? DEFAULT_NUSHELL_CONFIG.nuPath,
    };
  }

  constructor(ctx: Context, config: NushellLocalConfig = {}) {
    super(ctx);
    this.source = () => config;
    this.declaredNuPath = config.nuPath;
    this.resolvedNuPath = resolveNuPath(config.nuPath);
    assertServiceableNushellConfig(this.config);
    // settings 热更新(与官方 pwsh-local 同一接缝):组合入口登记为 shell
    // 命名空间的 base 层;用户在设置层改 `nuPath` 后经 setSource 切换来源、
    // onChange 重解析。声明值不变时 onChange 幂等。
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(
        ctx,
        SHELL_SETTINGS_NAMESPACE,
        NushellLocalExecutor.Config,
        config as Required<NushellLocalConfig>,
        {
          validate: (value) => assertServiceableNushellConfig(value),
          setSource: (current) => {
            this.source = current;
          },
          onChange: () => {
            const declared = this.source().nuPath;
            if (declared === this.declaredNuPath) return;
            this.declaredNuPath = declared;
            this.resolvedNuPath = resolveNuPath(declared);
          },
        },
      );
    });
  }

  /**
   * 把请求解析成完整 spec:workdir 取请求值(否则配置 cwd,再回退进程
   * cwd),timeoutMs 取请求值并按默认/上限钳制,stdout 预算取请求值。
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'nushell-local: request.timeoutMs',
    );
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes;
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes);
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
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
    return [this.resolvedNuPath, '--no-config-file', '-c', spec.command];
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
      spill: { maxBytes: this.config.maxSpillBytes },
    });
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes),
      },
      graceMs: this.config.graceMs,
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

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return this.runArgv(spec, this.argv(spec));
  }

  /** 按精确 argv 的前台运行(沙箱子类在此重新包装)。 */
  async runArgv(spec: ShellExecSpec, argv: string[]): Promise<ShellRunResult> {
    const d = deadline(spec.signal, spec.timeoutMs, NU_TIMEOUT);
    try {
      const handle = this.ctx.subprocess.spawn(
        this.spawnSpec(spec, spec.stdoutMaxBytes, d.signal, argv),
      );
      const outcome = await handle.done;
      const collected = NushellLocalExecutor.collected(handle);
      const timedOut = timeoutOf(d.signal, NU_TIMEOUT) !== undefined;
      const aborted = d.signal.aborted && !timedOut;
      return {
        ...outcome,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: finalOutput(collected.stdout),
        stderr: annotateStream(finalOutput(collected.stderr)),
      };
    } finally {
      d[Symbol.dispose]();
    }
  }

  start(spec: ShellExecSpec): ShellProcess {
    return this.startArgv(spec, this.argv(spec));
  }

  /** 按精确 argv 的后台启动;无 executor 超时(接缝契约:后台不设时)。 */
  startArgv(spec: ShellExecSpec, argv: string[]): ShellProcess {
    const running = this.ctx.subprocess.spawn(
      this.spawnSpec(spec, this.config.maxOutputBytes, spec.signal, argv),
    );
    const collected = NushellLocalExecutor.collected(running);
    let providerFailureNote: string | undefined;
    const consumeProviderFailure = (): string => {
      const note = providerFailureNote ?? '';
      providerFailureNote = undefined;
      return note;
    };
    let stdoutOffset = 0;
    let stderrOffset = 0;
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: running.done.then(
        (outcome) => {
          if (proc.status === 'running') {
            proc.status =
              spec.signal?.aborted === true || outcome.signal !== null
                ? 'killed'
                : 'completed';
          }
          proc.exitCode = outcome.exitCode;
          proc.signal = outcome.signal;
        },
        (error) => {
          proc.status = 'killed';
          let detail = 'unprintable provider failure';
          try {
            detail = String(error);
          } catch {
            /* keep sentinel */
          }
          providerFailureNote = `subprocess failed before reporting an outcome: ${detail}`;
        },
      ),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset);
        const err = collected.stderr.readFrom(stderrOffset);
        stdoutOffset = out.nextOffset;
        stderrOffset = err.nextOffset;
        const annotatedErr = annotateStream(err);
        const providerFailure = consumeProviderFailure();
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
        running.terminate();
        return true;
      },
    };
    return proc;
  }
}

export default NushellLocalExecutor;
