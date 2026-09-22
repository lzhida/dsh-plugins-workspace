import { ShellExecutor } from '@deepseek-ai/dsh-shell';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
  ShellSandboxInfo,
} from '@deepseek-ai/dsh-shell';
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess';
import {
  clampTimeout,
  deadline,
  MAX_TIMER_DELAY_MS,
  timeoutOf,
} from '@deepseek-ai/dsh-timeout';
import type {
  ConfinedArgv,
  SandboxExecutionPolicy,
  SandboxMode,
  SandboxPolicy,
} from '@deepseek-ai/dsh-sandbox';
// 模块增强激活:为 cordis Context 补上 sandbox/sandboxPolicy 服务类型。
// 侧效应形式——pure import type 会被 noUnusedLocals 拦下。
import '@deepseek-ai/dsh-sandbox-policy';
import type { Context } from '@deepseek-ai/cordis';

// e2e 契约:模块装载(loader import)时输出 `[目录名] ` 前缀日志行。
// Service 为惰性实例化,constructor 在无人消费 ctx.shell 前不会执行,
// 因此装载日志必须挂在模块顶层。
console.log('[dsh-nushell-sandbox] sandbox shell executor module loaded');

/**
 * dsh-nushell-sandbox:受沙箱约束的本地 Nushell shell executor,与
 * `@lzhida/dsh-nushell-local` 互斥的 `ctx.shell` 提供方(接缝单实现,
 * cordis 重复注册 fail loud——与官方 dsh-bash-local / dsh-bash-sandbox
 * 的组合关系一致)。每条命令的 argv 经 `ctx.sandbox.confine` 包装后由
 * `ctx.subprocess` 受限 spawn:runner 链按平台选择(win32 为 ACL 受限
 * 令牌 runner),缺 policy 时经 `ctx.sandboxPolicy` 解析缺省,拒绝与
 * runner 失败按 ConfinedArgv 携带的方言分类进 `ShellSandboxInfo`。
 * nu 语言自身无沙箱等价物不构成障碍:confinement 是进程级 argv 包装,
 * 对被包装的 shell 方言透明(已实测:Windows ACL runner 真实约束 nu
 * 的文件写入,read-only 拒绝、workspace-write 放行工作区内)。
 *
 * 与 dsh-nushell-local 是同构的独立实现而非子类:官方 shell 家族的
 * local/sandbox 执行器互不 import,共享面下沉在 dsh-shell 接缝类型。
 */

/** executor 运行时配置(全部可选,缺省值见 {@link DEFAULT_NUSHELL_CONFIG})。 */
export interface NushellSandboxConfig {
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
  Required<NushellSandboxConfig>,
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
    throw new Error(
      `nushell-sandbox: ${name} must be a positive finite number`,
    );
  }
}

/** 拒绝无法运行的配置段:正数/有限性由 schema 表达不了,在写入处拒绝。 */
export function assertServiceableNushellConfig(
  config: Omit<Required<NushellSandboxConfig>, 'cwd'>,
): void {
  assertPositiveFinite('timeoutMs', config.timeoutMs);
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs);
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes);
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes);
  assertPositiveFinite('graceMs', config.graceMs);
  if (config.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `nushell-sandbox: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    );
  }
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
 * 已知 nu 包装层特征 → 诊断注记(与 dsh-nushell-local 同一案例集)。
 * 包装注入层有解析缺陷时的引导提示在沙箱形态下同样适用。
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
      return `${stderrText}${glue}[nushell-sandbox: ${note}]`;
    }
  }
  return stderrText;
}

/** 对 collect 流形状做 stderr 注记(前台结算与后台增量共用),保持其余字段。 */
function annotateStream<T extends { text: string }>(stream: T): T {
  const annotated = annotateWrappedNu(stream.text);
  return annotated === stream.text ? stream : { ...stream, text: annotated };
}

/**
 * 一次受限执行的方言分类:先按 RunnerFailureRule 识别 runner 自身失败
 * (命令从未运行),再按 denialSignatures 识别策略拒绝(命令运行且被
 * 内核拦下)。两个判定互斥使用,与官方 fail-closed 分类次序一致。
 */
export function classifySandboxFacts(
  confined: Pick<ConfinedArgv, 'denialSignatures' | 'runnerFailureRules'>,
  exitCode: number | null,
  stderrText: string,
): { denied: boolean; runnerFailed: boolean } {
  const lines = stderrText.split('\n');
  for (const rule of confined.runnerFailureRules) {
    if (
      rule.allowedExitCodes !== undefined &&
      (exitCode === null || !rule.allowedExitCodes.includes(exitCode))
    ) {
      continue;
    }
    const candidates = lines.filter(
      (line) =>
        !rule.informationalLines?.some(
          (benign) => line.trim().toLowerCase() === benign.trim().toLowerCase(),
        ),
    );
    if (
      candidates.some((line) =>
        rule.fatalSignatures.some((sig) =>
          line.toLowerCase().includes(sig.toLowerCase()),
        ),
      )
    ) {
      return { denied: false, runnerFailed: true };
    }
  }
  const lowered = stderrText.toLowerCase();
  const denied = confined.denialSignatures.some((sig) =>
    lowered.includes(sig.toLowerCase()),
  );
  return { denied, runnerFailed: false };
}

/**
 * 受沙箱约束的 Nushell executor:注册为 `ctx.shell`(与 nushell-local
 * 互斥)。`sandboxMode` 恒非 undefined——tool 层据此公布 sandbox 升权
 * 字段(官方语义:bash/pwsh 工具只在挂载沙箱执行器时公布升权)。
 */
export class NushellSandboxExecutor extends ShellExecutor {
  static inject = ['subprocess', 'sandbox', 'sandboxPolicy'];

  /** 校验后的生效配置(手动默认值在构造时应用)。 */
  readonly config: Required<NushellSandboxConfig>;

  constructor(ctx: Context, config: NushellSandboxConfig = {}) {
    super(ctx);
    this.config = {
      cwd: config.cwd ?? process.cwd(),
      timeoutMs: config.timeoutMs ?? DEFAULT_NUSHELL_CONFIG.timeoutMs,
      maxTimeoutMs: config.maxTimeoutMs ?? DEFAULT_NUSHELL_CONFIG.maxTimeoutMs,
      maxOutputBytes:
        config.maxOutputBytes ?? DEFAULT_NUSHELL_CONFIG.maxOutputBytes,
      maxSpillBytes:
        config.maxSpillBytes ?? DEFAULT_NUSHELL_CONFIG.maxSpillBytes,
      graceMs: config.graceMs ?? DEFAULT_NUSHELL_CONFIG.graceMs,
      nuPath: config.nuPath ?? DEFAULT_NUSHELL_CONFIG.nuPath,
    };
    assertServiceableNushellConfig(this.config);
  }

  /**
   * 本 executor 默认套用的沙箱模式:透传共享策略服务的部署缺省
   * (fail-safe 为 read-only)。非 undefined 即向 tool 层宣告 confining。
   */
  override get sandboxMode(): SandboxMode {
    return this.ctx.sandboxPolicy.defaultMode;
  }

  /**
   * 把请求解析成完整 spec:workdir/timeout/预算语义与 nushell-local
   * 一致;sandboxPolicy 缺省时经共享策略服务解析(会话 cwd 即边界)。
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs,
      this.config.maxTimeoutMs,
      'nushell-sandbox: request.timeoutMs',
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
      sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
    };
  }

  /** 一次已解析 spec 的 nu 调用 argv(`nu --no-config-file -c`)。 */
  argv(spec: ShellExecSpec): string[] {
    return [this.config.nuPath, '--no-config-file', '-c', spec.command];
  }

  /** 把已解析 spec 加上(已包装的)argv,组成完整的 subprocess spawn。 */
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
        'nushell-sandbox: subprocess implementation dropped a requested collect stream',
      );
    }
    return { stdout, stderr };
  }

  /**
   * 解析本次执行的实际 policy。接缝契约:spec 应来自 {@link resolve}
   * (已带 policy);直呼 run/start 的进程内消费者在此兜底解析。
   */
  private policyOf(spec: ShellExecSpec): SandboxExecutionPolicy {
    return spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const policy = this.policyOf(spec);
    if (policy.mode === 'danger-full-access') {
      // 策略明确放弃限制:不包装,事实字段如实报告该模式。
      const result = await this.runWrapped(spec, this.argv(spec));
      return {
        ...result,
        sandbox: { mode: policy.mode, denied: false },
      };
    }
    // fail-closed:无可用 runner 时 confine 抛 SANDBOX_UNAVAILABLE,
    // 决不静默回退到未受限 argv。
    const confinedPolicy: SandboxPolicy = { ...policy, mode: policy.mode };
    const confined = this.ctx.sandbox.confine(this.argv(spec), confinedPolicy);
    const result = await this.runWrapped(spec, confined.argv);
    const facts = classifySandboxFacts(
      confined,
      result.exitCode,
      result.stderr.text,
    );
    return {
      ...result,
      sandbox: {
        mode: policy.mode,
        denied: facts.denied,
        enforcement: confined.enforcement,
        runnerFailed: facts.runnerFailed,
      },
    };
  }

  /** 前台运行:受管超时/取消语义与 nushell-local 相同,argv 由调用方给。 */
  private async runWrapped(
    spec: ShellExecSpec,
    argv: string[],
  ): Promise<ShellRunResult> {
    const d = deadline(spec.signal, spec.timeoutMs, NU_TIMEOUT);
    try {
      const handle = this.ctx.subprocess.spawn(
        this.spawnSpec(spec, spec.stdoutMaxBytes, d.signal, argv),
      );
      const outcome = await handle.done;
      const collected = NushellSandboxExecutor.collected(handle);
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

  override start(spec: ShellExecSpec): ShellProcess {
    const policy = this.policyOf(spec);
    if (policy.mode === 'danger-full-access') {
      return this.startWrapped(spec, this.argv(spec), {
        mode: policy.mode,
        denied: false,
      });
    }
    const confinedPolicy: SandboxPolicy = { ...policy, mode: policy.mode };
    const confined = this.ctx.sandbox.confine(this.argv(spec), confinedPolicy);
    // 后台不做 stderr 反推:输出缓冲是 job 的消费流,executor 旁路读取会
    // 竞态丢数据。denied 恒 false(未观察到拒绝事实);nu 自身的拒绝文本
    // 仍经 [stderr] 增量呈现给模型。runner 在 spawn 前失败由结算分支
    // 如实标 runnerFailed。
    return this.startWrapped(spec, confined.argv, {
      mode: policy.mode,
      denied: false,
      enforcement: confined.enforcement,
    });
  }

  /**
   * 后台启动:无 executor 超时(接缝契约),argv 由调用方给。给出
   * {@link facts} 时在结算点盖上沙箱事实——结算的 provider 失败分支
   * 意味着 runner 在报告结果前就失败了,fail-closed 地标 runnerFailed。
   */
  private startWrapped(
    spec: ShellExecSpec,
    argv: string[],
    facts?: ShellSandboxInfo,
  ): ShellProcess {
    const running = this.ctx.subprocess.spawn(
      this.spawnSpec(spec, this.config.maxOutputBytes, spec.signal, argv),
    );
    const collected = NushellSandboxExecutor.collected(running);
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
          if (facts !== undefined) proc.sandbox = facts;
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
          if (facts !== undefined) {
            proc.sandbox = { ...facts, runnerFailed: true };
          }
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

export default NushellSandboxExecutor;
