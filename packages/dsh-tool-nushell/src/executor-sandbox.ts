import {
  SandboxUnavailableError,
  classifyRunnerFailure,
  isRunnerSpawnFailure,
  matchesSignature,
} from '@deepseek-ai/dsh-sandbox';
import type {
  ConfinedArgv,
  SandboxEnforcement,
  SandboxMode,
  SandboxPolicy,
  RunnerFailureRule,
} from '@deepseek-ai/dsh-sandbox';
// 模块增强激活:为 cordis Context 补上 sandbox/sandboxPolicy 服务类型。
// 侧效应形式——pure import type 会被 noUnusedLocals 拦下。
import '@deepseek-ai/dsh-sandbox-policy';
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellExecution,
  ShellProcess,
  ShellRunResult,
} from '@deepseek-ai/dsh-shell';
import type { Context } from '@deepseek-ai/cordis';

import { NUSHELL_RUNTIME } from './executor-runtime.ts';
import { NushellLocalExecutor } from './executor-local.ts';
import type { NushellLocalConfig } from './executor-local.ts';

/**
 * Nushell 受沙箱约束执行器实现(归宿:tool 包)。作为
 * `dsh-nushell-sandbox` 的组合行挂载时是 `ctx.shell` 提供方(与
 * `@lzhida/dsh-nushell-local` 互斥,接缝单实现,cordis 重复注册
 * fail loud——与官方 dsh-pwsh-local / dsh-pwsh-sandbox 的组合关系一致);
 * 由 dsh-tool-nushell 内部实例化时是直跑模式的 confining 执行核心,
 * 不占接缝。每条命令的 argv 在 `executeArgv` 准备期经 `ctx.sandbox.confine`
 * (0.1.7 起为异步,支持取消)包装后由 `ctx.subprocess` 受限 spawn:
 * runner 链按平台选择(win32 为 ACL 受限令牌 runner),缺 policy 时经
 * `ctx.sandboxPolicy` 解析缺省;拒绝与 runner 失败按 ConfinedArgv 携带的
 * 方言,前台在 `result()` 投影、后台在 `onProcessDone` 结算点分别分类进
 * `ShellSandboxInfo`(官方诊断助手 {@link isRunnerSpawnFailure} /
 * {@link classifyRunnerFailure} / {@link matchesSignature})。
 * nu 语言自身无沙箱等价物不构成障碍:confinement 是进程级 argv 包装,
 * 对被包装的 shell 方言透明(已实测:Windows ACL runner 真实约束 nu
 * 的文件写入,read-only 拒绝、workspace-write 放行工作区内)。
 *
 * 0.1.7 起与本地执行器改为「子类复用」(对齐官方 pwsh 家族):confining
 * 形态只是把 argv 准备换成 confine 包装,进程机制/截止/输出全部继承。
 */

/** executor 运行时配置(与本地执行器同构,全部字段可为活值访问器)。 */
export type NushellSandboxConfig = NushellLocalConfig;

/** 配置共用于两个执行器:数值边界/回退语义一致。 */
export {
  annotateWrappedNu,
  assertServiceableNushellConfig,
  candidateNuPaths,
  DEFAULT_NUSHELL_CONFIG,
  liveValue,
  peekField,
  resolveNuPath,
} from './executor-local.ts';
export type { LiveField, NuPathExists } from './executor-local.ts';

/** 一次受限执行的 per-process 分类材料(保留到结算点,防重叠调用串味)。 */
interface ProcessFacts {
  mode: SandboxMode;
  enforcement: SandboxEnforcement;
  denialSignatures: readonly string[];
  runnerFailureRules: readonly RunnerFailureRule[];
  runnerProgram: string | undefined;
  workdir: string;
}

/**
 * 受沙箱约束的 Nushell executor:注册为 `ctx.shell`(与 nushell-local
 * 互斥)。`sandboxMode` 恒非 undefined——tool 层据此公布 sandbox 升权
 * 字段(官方语义:bash/pwsh 工具只在挂载沙箱执行器时公布升权)。
 */
export class NushellSandboxExecutor extends NushellLocalExecutor {
  static override inject = ['subprocess', 'sandbox', 'sandboxPolicy'];

  /** 接缝标记:tool 层探针据此识别 nushell 执行器(见 executor-runtime.ts)。 */
  override readonly runtime = NUSHELL_RUNTIME;

  /** 本 executor 默认套用的沙箱模式(部署缺省,fail-safe 由策略服务保证)。 */
  private readonly mode: SandboxMode;

  /** per-process 分类材料:provider 可能在重叠调用间变换 wrap,禁止共享最新值。 */
  private readonly processFacts = new Map<ShellProcess, ProcessFacts>();

  constructor(ctx: Context, config: NushellSandboxConfig = {}) {
    super(ctx, config);
    this.mode = ctx.sandboxPolicy.defaultMode;
  }

  /** 配置的缺省模式——tool 层读取的 confining 能力事实。 */
  override get sandboxMode(): SandboxMode {
    return this.mode;
  }

  /**
   * 把请求解析成完整 spec:数值/预算语义继承本地执行器;sandboxPolicy
   * 缺省时经共享策略服务解析(会话 cwd 即边界)。
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      ...super.resolve(request),
      sandboxPolicy: request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve(),
    };
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const policy = spec.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();
    const { mode } = policy;
    if (mode === 'danger-full-access') {
      // 策略明确放弃限制:不包装,事实字段如实报告该模式。
      return NushellSandboxExecutor.decorateResult(
        await super.execute(spec),
        (result) => ({ ...result, sandbox: { mode, denied: false } }),
      );
    }
    let confined: ConfinedArgv | undefined;
    // fail-closed:无可用 runner 时 confine 抛 SANDBOX_UNAVAILABLE,
    // 决不静默回退到未受限 argv。confinement 走 executeArgv 的准备期闭包:
    // 截止、取消与准备期到点语义由基类统一保证。
    const execution = await this.executeArgv(
      spec,
      async (signal) => {
        const prepared = await this.confine(spec, { ...policy, mode }, signal);
        signal.throwIfAborted();
        confined = prepared;
        return prepared.argv;
      },
      (proc) => {
        const facts = confined;
        if (facts !== undefined) {
          this.processFacts.set(proc, {
            mode,
            enforcement: facts.enforcement,
            denialSignatures: facts.denialSignatures,
            runnerFailureRules: facts.runnerFailureRules,
            runnerProgram: facts.argv[0],
            workdir: spec.workdir,
          });
        }
      },
    );
    return NushellSandboxExecutor.decorateResult(
      execution,
      (result) => {
        if (confined === undefined) {
          return { ...result, sandbox: { mode, denied: false } };
        }
        const { enforcement, denialSignatures, runnerFailureRules } = confined;
        // runner 自身失败 = 命令从未运行:前台抛 SANDBOX_UNAVAILABLE,
        // 这是沙箱问题而非命令失败(fail-closed,不给未受限输出)。
        const runnerFailure = classifyRunnerFailure(
          result.exitCode,
          result.stderr.text,
          runnerFailureRules,
        );
        if (runnerFailure !== undefined) {
          throw new SandboxUnavailableError(mode, runnerFailure.detail);
        }
        return {
          ...result,
          sandbox: {
            mode,
            denied: matchesSignature(
              result.exitCode,
              result.stderr.text,
              denialSignatures,
            ),
            enforcement,
          },
        };
      },
      (error) => {
        if (spec.signal?.aborted === true) spec.signal.throwIfAborted();
        if (
          confined !== undefined &&
          isRunnerSpawnFailure(error, confined.argv[0], spec.workdir)
        ) {
          throw new SandboxUnavailableError(mode, String(error));
        }
        throw error;
      },
    );
  }

  /**
   * 原地装饰句柄的前台投影(只 memoize 一次,句柄保持同一对象身份——
   * per-process facts 与 `onProcessDone` 都以实例为键)。
   */
  private static decorateResult(
    execution: ShellExecution,
    map: (result: ShellRunResult) => ShellRunResult,
    mapError?: (error: unknown) => ShellRunResult,
  ): ShellExecution {
    const base = execution.result.bind(execution);
    let decorated: Promise<ShellRunResult> | undefined;
    execution.result = () => {
      decorated ??= base().then(map, mapError);
      return decorated;
    };
    return execution;
  }

  /**
   * 结算点盖章:runner 失败优先于策略拒绝,信号死亡不算拒绝。provider
   * 拒绝时以 runner 证据为准(official diagnostics 助手判 argv[0] 归属)。
   */
  protected override onProcessDone(
    proc: ShellProcess,
    stderr: string,
    providerRejected: boolean,
    providerError: unknown,
  ): void {
    const facts = this.processFacts.get(proc);
    if (facts !== undefined) {
      this.processFacts.delete(proc);
      const runnerFailed = providerRejected
        ? isRunnerSpawnFailure(
            providerError,
            facts.runnerProgram,
            facts.workdir,
          )
        : classifyRunnerFailure(
            proc.exitCode,
            stderr,
            facts.runnerFailureRules,
          ) !== undefined;
      proc.sandbox = {
        mode: facts.mode,
        denied:
          !runnerFailed &&
          matchesSignature(proc.exitCode, stderr, facts.denialSignatures),
        enforcement: facts.enforcement,
        ...(runnerFailed ? { runnerFailed } : {}),
      };
    }
    super.onProcessDone(proc, stderr, providerRejected, providerError);
  }

  /**
   * 经 `ctx.sandbox` provider 包装一次 nu 调用。provider 错误原样传播;
   * 返回的 argv 直接交给本地执行器的 subprocess 路径。
   */
  private confine(
    spec: ShellExecSpec,
    policy: SandboxPolicy,
    signal?: AbortSignal,
  ): Promise<ConfinedArgv> {
    return this.ctx.sandbox.confine(this.argv(spec), policy, signal);
  }
}

export default NushellSandboxExecutor;
