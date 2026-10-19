/**
 * CLI 后端服务管理器：anytype-cli 的服务状态查询与最小拉起。
 *
 * 生命周期边界（安全设计）：
 * - 只执行 `service start`（OS 用户服务，生命周期归用户），**绝不**代为
 *   安装服务、创建 bot 账户或签发密钥——那些是用户主权动作，未完成时返回
 *   可操作指引（安装 → `auth create` → `space join` → `auth apikey create`
 *   → `service install`）；
 * - 健康判定与进程解耦：启动后轮询目标 API 的 `/v2/auth/whoami`，收到任意
 *   HTTP 响应（含 401）即视为服务已起；超时返回失败并附指引；
 * - 桌面端**纯检测**：不做任何桌面应用拉起（实测从其他进程上下文启动
 *   Anytype.exe 会立即退出，已移除该路径）。
 *
 * Node strip-only 约束：类禁用参数属性（构造器显式赋值）。
 */

import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';

import type { CliBackendSettings } from './config.ts';

/** 拉起器运行时配置（volatile 现读）。 */
export interface LauncherConfig {
  cli: CliBackendSettings;
}

/** 机读 envelope（schema_version 1）的最小解析形状。 */
export interface CliJsonEnvelope {
  schema_version: number;
  /** ready = 命令成功；unavailable/failed = 见 error。 */
  state: string;
  result: Record<string, unknown>;
  error?: { code?: string; message?: string } | null;
  next_action?: string;
}

/** `--json service status` 解析出的 CLI 运行状态。 */
export interface CliRuntimeStatus {
  /** envelope 解析成功。 */
  parsed: boolean;
  /** envelope.state（ready/unavailable/...）。 */
  state: string;
  /** CLI 版本号（如 v0.5.0）。 */
  cliVersion?: string;
  /** 账户已认证。 */
  authenticated: boolean;
  /** 内嵌 HTTP API 就绪。 */
  apiReady: boolean;
  apiOrigin?: string;
  serviceManager?: string;
  serviceInstalled?: boolean;
  serviceRunning?: boolean;
  serviceHealth?: string;
  /** 数据根路径（instance.work_path）。 */
  workPath?: string;
  /** 错误码（unavailable 时）。 */
  errorCode?: string;
  /** 原始输出（截断；解析失败时供透传）。 */
  detail: string;
}

/** bot 账户 login/create 的结果。 */
export interface CliAuthResult {
  ok: boolean;
  /** envelope.state（成功时 ready）；config-error = 配置缺失未执行。 */
  state: string;
  /** result 的账户字段（id/name 等）。 */
  account?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  /** 原始输出（截断）。 */
  detail: string;
}

/** CLI 服务状态（`anytype service status` 的尽力解析）。 */
export interface CliServiceStatus {
  /** CLI 二进制在 PATH/配置路径上可找到。 */
  binFound: boolean;
  /** 服务状态归类；unknown = 输出无法识别（附原文）。 */
  state: 'running' | 'stopped' | 'not-installed' | 'unknown';
  /** 原始输出（截断）。 */
  detail: string;
}

/** CLI 启动结果归类。 */
export type CliStartResult =
  'started' | 'already-running' | 'not-installed' | 'bin-not-found' | 'failed';

/** execFile 的 Promise 封装（注入点，测试 mock）。 */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/** 带 stdin 输入的 execFile（login --key-stdin 用；注入点）。 */
export type ExecFileStdinLike = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
  stdin: string,
) => Promise<{ stdout: string; stderr: string }>;

/** 默认 execFile：45s 超时（与 CLI 机读默认 deadline 同量级）。 */
function defaultExecFile(
  file: string,
  args: readonly string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: options.timeout, windowsHide: true },
      (err, stdout, stderr) => {
        if (err !== undefined && err !== null) {
          const wrapped = err as Error & { stdout?: string; stderr?: string };
          wrapped.stdout = String(stdout ?? '');
          wrapped.stderr = String(stderr ?? '');
          reject(wrapped);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

/** 默认带 stdin 的执行：一次性写入后关闭 stdin。 */
function defaultExecFileStdin(
  file: string,
  args: readonly string[],
  options: { timeout: number },
  stdin: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      [...args],
      { timeout: options.timeout, windowsHide: true },
      (err, stdout, stderr) => {
        if (err !== undefined && err !== null) {
          const wrapped = err as Error & { stdout?: string; stderr?: string };
          wrapped.stdout = String(stdout ?? '');
          wrapped.stderr = String(stderr ?? '');
          reject(wrapped);
          return;
        }
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    child.stdin?.write(stdin);
    child.stdin?.end();
  });
}

/** 健康轮询用的轻量 fetch 注入点（测试 mock）。 */
export type HealthFetchLike = (url: string) => Promise<Response>;

async function defaultHealthFetch(url: string): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(1500),
  });
}

/** 单次健康探测：收到任意 HTTP 响应（含 401）即视为服务已起。 */
async function healthyOnce(
  baseUrl: string,
  fetchImpl: HealthFetchLike,
): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl}/v2/auth/whoami`);
    await response.text();
    return true;
  } catch {
    return false;
  }
}

/** 轮询直到 healthy 或超时。 */
async function pollUntilHealthy(
  baseUrl: string,
  budgetMs: number,
  intervalMs: number,
  fetchImpl: HealthFetchLike,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await healthyOnce(baseUrl, fetchImpl)) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return healthyOnce(baseUrl, fetchImpl);
}

/** 健康轮询预算（毫秒；可注入缩短测试耗时）。 */
export interface PollBudgets {
  cliMs: number;
  intervalMs: number;
}

/** 默认轮询预算：CLI 30s、间隔 1s。 */
const DEFAULT_BUDGETS: PollBudgets = { cliMs: 30_000, intervalMs: 1000 };

/**
 * CLI 服务管理器。`config` 每次调用现读（volatile 热生效）；
 * `healthFetch`/`execFileImpl`/`execStdinImpl`/`serveSpawnImpl`/`budgets`
 * 为测试注入点。
 */
export class CliLauncher {
  /** 配置现读入口。 */
  private readonly config: () => LauncherConfig;
  /** 健康探测 fetch（注入点）。 */
  private readonly healthFetch: HealthFetchLike;
  /** CLI 命令执行（注入点）。 */
  private readonly execFileImpl: ExecFileLike;
  /** 带 stdin 的 CLI 命令执行（login --key-stdin；注入点）。 */
  private readonly execStdinImpl: ExecFileStdinLike;
  /** serve detached 拉起（注入点）。 */
  private readonly serveSpawnImpl: (
    exe: string,
    args: readonly string[],
  ) => Promise<void>;
  /** 轮询预算（测试可缩短）。 */
  private readonly budgets: PollBudgets;
  /**
   * 机读变更操作的 durable operation id（按操作键记忆）：CLI 侧以
   * operation id 为幂等键——「Resume the same operation ID for a mutation」
   * 语义要求重试时复用同一 id，而非每次新开。
   */
  private readonly operationIds = new Map<string, string>();

  constructor(
    config: () => LauncherConfig,
    healthFetch?: HealthFetchLike,
    execFileImpl?: ExecFileLike,
    budgets?: Partial<PollBudgets>,
    execStdinImpl?: ExecFileStdinLike,
    serveSpawnImpl?: (exe: string, args: readonly string[]) => Promise<void>,
  ) {
    this.config = config;
    this.healthFetch = healthFetch ?? defaultHealthFetch;
    this.execFileImpl = execFileImpl ?? defaultExecFile;
    this.execStdinImpl = execStdinImpl ?? defaultExecFileStdin;
    this.serveSpawnImpl =
      serveSpawnImpl ??
      ((exe, args) =>
        new Promise<void>((resolve, reject) => {
          try {
            // serve 是服务进程：detached + unref，独立于宿主存活，
            // 插件卸载绝不终止它。
            const child = spawn(exe, [...args], {
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            child.on('error', (err) => reject(err));
            child.unref();
            setTimeout(() => resolve(), 50);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }));
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
  }

  /** 取（或生成）某个操作键的 durable operation id（重试复用同一 id）。 */
  private operationIdFor(key: string): string {
    const existing = this.operationIds.get(key);
    if (existing !== undefined) return existing;
    const id = randomUUID().replaceAll('-', '');
    this.operationIds.set(key, id);
    return id;
  }

  /**
   * 机读执行：`<bin> --json <args>`，解析版本化 envelope。
   * 注意：CLI 机读命令失败时也常在 stdout 输出完整 envelope
   * （如 `state: "unavailable"`），因此非零退出不放弃解析。
   */
  private async execJson(
    args: readonly string[],
  ): Promise<{ envelope: CliJsonEnvelope; raw: string }> {
    const binPath = this.config().cli.binPath;
    let stdout: string;
    let stderr: string;
    try {
      const result = await this.execFileImpl(binPath, ['--json', ...args], {
        timeout: 50_000,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (err) {
      const wrapped = err as Error & { stdout?: string; stderr?: string };
      stdout = wrapped.stdout ?? '';
      stderr = wrapped.stderr ?? '';
    }
    const raw = `${stdout}\n${stderr}`.trim();
    try {
      const envelope = JSON.parse(stdout) as CliJsonEnvelope;
      return { envelope, raw: raw.slice(0, 800) };
    } catch {
      const reason = stderr.trim().slice(0, 200) || raw.slice(0, 200);
      throw new Error(`CLI did not return a JSON envelope: ${reason}`);
    }
  }

  /**
   * 机读查询 CLI 运行状态（`--json service status`）：
   * 账户认证态、内嵌 API 就绪度、服务安装/运行/管理器类型、数据路径。
   * 解析失败（二进制缺失/老版本无 --json）时 parsed=false，调用方降级。
   */
  async authStatus(): Promise<CliRuntimeStatus> {
    const base: CliRuntimeStatus = {
      parsed: false,
      state: 'unknown',
      authenticated: false,
      apiReady: false,
      detail: '',
    };
    let envelope: CliJsonEnvelope;
    let raw: string;
    try {
      const json = await this.execJson(['service', 'status']);
      envelope = json.envelope;
      raw = json.raw;
    } catch (err) {
      base.detail = err instanceof Error ? err.message : String(err);
      return base;
    }
    const result = envelope.result ?? {};
    const account = readRecord(result.account);
    const api = readRecord(result.api);
    const service = readRecord(result.service);
    const instance = readRecord(result.instance);
    return {
      parsed: true,
      state: envelope.state,
      cliVersion: readText(result.cli_version),
      authenticated: account?.authenticated === true,
      apiReady: api?.ready === true,
      apiOrigin: readText(api?.configured_origin) || undefined,
      serviceManager: readText(service?.manager) || undefined,
      serviceInstalled: service?.installed === true,
      serviceRunning: service?.running === true,
      serviceHealth: readText(service?.health) || undefined,
      workPath: readText(instance?.work_path) || undefined,
      errorCode: readText(envelope.error?.code) || undefined,
      detail: raw,
    };
  }

  /**
   * `anytype auth login --key-stdin`：用配置中的 `cliAccountKey` 登录
   * bot 账户。key 经 stdin 传入——不进命令行、不进会话轨迹。
   */
  async login(): Promise<CliAuthResult> {
    const cli = this.config().cli;
    if (cli.accountKey.length === 0) {
      return {
        ok: false,
        state: 'config-error',
        errorMessage:
          'cliAccountKey is empty. Create a bot account first (`anytype auth create <name>`, or the anytype_cli_create tool) and put its account key into cliAccountKey.',
        detail: '',
      };
    }
    const args = ['auth', 'login', '--key-stdin'];
    if (cli.listenAddress.length > 0) {
      args.push('--listen-address', cli.listenAddress);
    }
    if (cli.networkConfig.length > 0) {
      args.push('--network-config', cli.networkConfig);
    }
    // 机读变更操作必须携带 durable operation id（幂等键；登录键固定复用）
    args.push('--operation-id', this.operationIdFor('__login__'));
    try {
      const { stdout, stderr } = await this.execStdinImpl(
        cli.binPath,
        ['--json', ...args],
        { timeout: 50_000 },
        cli.accountKey,
      );
      return authResultFromRaw(stdout, stderr);
    } catch (err) {
      const wrapped = err as Error & { stdout?: string; stderr?: string };
      return authResultFromRaw(wrapped.stdout ?? '', wrapped.stderr ?? '');
    }
  }

  /**
   * `anytype auth create <name>`：用配置中的 `cliAccountName` 创建 bot
   * 账户（生成本机数据目录并将凭证存入系统 keyring）。
   */
  async create(): Promise<CliAuthResult> {
    const cli = this.config().cli;
    if (cli.accountName.length === 0) {
      return {
        ok: false,
        state: 'config-error',
        errorMessage:
          'cliAccountName is empty. Set the bot account name in Settings → Plugins → dsh-anytype first.',
        detail: '',
      };
    }
    const args = ['auth', 'create', cli.accountName];
    if (cli.listenAddress.length > 0) {
      args.push('--listen-address', cli.listenAddress);
    }
    if (cli.networkConfig.length > 0) {
      args.push('--network-config', cli.networkConfig);
    }
    // 机读变更操作必须携带 durable operation id（幂等键；按账户名复用，
    // 使「Resume the same operation ID」的重试语义成立），
    // 以及「空实例」断言：--expect-account none（已有账户时拒绝创建）
    args.push(
      '--operation-id',
      this.operationIdFor(`create:${cli.accountName}`),
    );
    args.push('--expect-account', 'none');
    try {
      const { stdout, stderr } = await this.execFileImpl(
        cli.binPath,
        ['--json', ...args],
        { timeout: 50_000 },
      );
      return authResultFromRaw(stdout, stderr);
    } catch (err) {
      const wrapped = err as Error & { stdout?: string; stderr?: string };
      return authResultFromRaw(wrapped.stdout ?? '', wrapped.stderr ?? '');
    }
  }

  /**
   * serve 回退：detached 启动 `anytype serve --listen-address X`
   * （服务进程独立存活，插件卸载不终止）并轮询「本地节点存活」
   * （机读 `service status` 的 envelope 从 unavailable 翻转为 ready，
   * 上限 30s）。服务管理器不可用（如本机 Windows）时的拉起路径；
   * 也是 login/create 这类 RPC 变更操作的节点前置条件。
   */
  async serveStart(): Promise<CliStartResult> {
    if (await this.nodeAlive()) return 'already-running';
    const { cli } = this.config();
    const args = ['serve', '--listen-address', cli.listenAddress];
    try {
      await this.serveSpawnImpl(cli.binPath, args);
    } catch {
      return 'bin-not-found';
    }
    const deadline = Date.now() + this.budgets.cliMs;
    while (Date.now() < deadline) {
      if (await this.nodeAlive()) return 'started';
      await new Promise((resolve) =>
        setTimeout(resolve, this.budgets.intervalMs),
      );
    }
    return (await this.nodeAlive()) ? 'started' : 'failed';
  }

  /**
   * 本地节点存活判定：机读 `service status` 的 envelope 解析成功且
   * state 不再是 unavailable（节点 down 时 CLI 报 rpc_unavailable）。
   */
  private async nodeAlive(): Promise<boolean> {
    const status = await this.authStatus();
    return status.parsed && status.state !== 'unavailable';
  }

  /**
   * 查询 CLI 安装与服务状态（人读输出尽力解析；机读解析走 authStatus）。
   */
  async cliServiceStatus(): Promise<CliServiceStatus> {
    const binPath = this.config().cli.binPath;
    try {
      const { stdout, stderr } = await this.execFileImpl(
        binPath,
        ['service', 'status'],
        { timeout: 15_000 },
      );
      const detail = `${stdout}\n${stderr}`.trim().slice(0, 400);
      return { binFound: true, ...classifyCliOutput(detail) };
    } catch (err) {
      const wrapped = err as Error & { stdout?: string; stderr?: string };
      const combined =
        `${wrapped.stdout ?? ''}\n${wrapped.stderr ?? ''}\n${wrapped.message ?? ''}`
          .trim()
          .slice(0, 400);
      const lower = combined.toLowerCase();
      if (
        lower.includes('enoent') ||
        lower.includes('not found') ||
        lower.includes('cannot find') ||
        lower.includes('不被识别') ||
        lower.includes('找不到')
      ) {
        return { binFound: false, state: 'not-installed', detail: combined };
      }
      // 非零退出但能跑起来 = 二进制存在；按输出归类
      return { binFound: true, ...classifyCliOutput(combined) };
    }
  }

  /**
   * 启动 CLI 服务（`anytype service start`）并轮询健康（上限 30s）。
   * 仅启动已安装的服务——安装/建户/签发密钥是用户主权动作，本方法绝不代办。
   */
  async startCliService(): Promise<CliStartResult> {
    const { cli } = this.config();
    if (await healthyOnce(cli.url, this.healthFetch)) return 'already-running';
    try {
      await this.execFileImpl(cli.binPath, ['service', 'start'], {
        timeout: 15_000,
      });
    } catch (err) {
      const wrapped = err as Error & { stdout?: string; stderr?: string };
      const combined =
        `${wrapped.stdout ?? ''}\n${wrapped.stderr ?? ''}\n${wrapped.message ?? ''}`.toLowerCase();
      if (
        combined.includes('not installed') ||
        combined.includes('not-installed') ||
        combined.includes('enoent') ||
        combined.includes('不被识别') ||
        combined.includes('找不到')
      ) {
        return 'not-installed';
      }
      if (combined.includes('already running')) return 'already-running';
      return 'failed';
    }
    return (await pollUntilHealthy(
      cli.url,
      this.budgets.cliMs,
      this.budgets.intervalMs,
      this.healthFetch,
    ))
      ? 'started'
      : 'failed';
  }
}

/** 按输出关键词归类 CLI 服务状态（running / stopped / not-installed / unknown）。 */
function classifyCliOutput(detail: string): {
  state: CliServiceStatus['state'];
  detail: string;
} {
  const lower = detail.toLowerCase();
  if (lower.includes('not installed') || lower.includes('not-installed')) {
    return { state: 'not-installed', detail };
  }
  if (lower.includes('running') || lower.includes('active')) {
    return { state: 'running', detail };
  }
  if (lower.includes('stopped') || lower.includes('inactive')) {
    return { state: 'stopped', detail };
  }
  return { state: 'unknown', detail };
}

/** envelope.result 成员的 record 安全读取。 */
function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 未知值的安全文本读取（undefined/对象 → 空串）。 */
function readText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}

/**
 * 把 login/create 的原始输出解析为 CliAuthResult：
 * 优先解析机读 envelope（非零退出也常带完整 envelope），失败透传原文。
 */
function authResultFromRaw(stdout: string, stderr: string): CliAuthResult {
  const raw = `${stdout}\n${stderr}`.trim();
  try {
    const envelope = JSON.parse(stdout) as CliJsonEnvelope;
    const result = envelope.result ?? {};
    const account = readRecord(result.account);
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result)) {
      // 账户字段直出；capabilities/limits 等大对象仅保留 account 与消息类字段
      if (key === 'account' || key === 'message' || key === 'warning') {
        filtered[key] = value;
      }
    }
    return {
      ok: envelope.state === 'ready',
      state: envelope.state,
      account,
      errorCode: readText(envelope.error?.code) || undefined,
      errorMessage: readText(envelope.error?.message) || undefined,
      detail:
        JSON.stringify(filtered, null, 2).slice(0, 800) || raw.slice(0, 400),
    };
  } catch {
    return {
      ok: false,
      state: 'unparsed',
      errorMessage: raw.slice(0, 400) || 'CLI returned no output',
      detail: raw.slice(0, 400),
    };
  }
}

/** 面向用户的 CLI autoStart 失败指引（按结果归类）。 */
export function cliAutoStartHint(result: CliStartResult): string {
  if (result === 'not-installed' || result === 'bin-not-found') {
    return 'CLI auto-start is unavailable: anytype-cli is not installed. See https://github.com/anyproto/anytype-cli — then: `anytype auth create <name>` → `anytype space join <invite>` → `anytype auth apikey create <name> --all-spaces --read-write` → `anytype service install` → `anytype service start`, and put the CLI key into cliKey.';
  }
  if (result === 'already-running') {
    return 'CLI service reports already running but the API did not answer — check `anytype service status` and whether cliKey matches a key created on this CLI instance.';
  }
  return 'CLI service start failed or did not become healthy in time. Check `anytype service status` output.';
}
