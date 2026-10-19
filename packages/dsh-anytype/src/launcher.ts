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

import { execFile } from 'node:child_process';

import type { CliBackendSettings } from './config.ts';

/** 拉起器运行时配置（volatile 现读）。 */
export interface LauncherConfig {
  cli: CliBackendSettings;
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

/** 默认 execFile：15s 超时、captures stdout/stderr。 */
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
 * `healthFetch`/`execFileImpl`/`budgets` 为测试注入点。
 */
export class CliLauncher {
  /** 配置现读入口。 */
  private readonly config: () => LauncherConfig;
  /** 健康探测 fetch（注入点）。 */
  private readonly healthFetch: HealthFetchLike;
  /** CLI 命令执行（注入点）。 */
  private readonly execFileImpl: ExecFileLike;
  /** 轮询预算（测试可缩短）。 */
  private readonly budgets: PollBudgets;

  constructor(
    config: () => LauncherConfig,
    healthFetch?: HealthFetchLike,
    execFileImpl?: ExecFileLike,
    budgets?: Partial<PollBudgets>,
  ) {
    this.config = config;
    this.healthFetch = healthFetch ?? defaultHealthFetch;
    this.execFileImpl = execFileImpl ?? defaultExecFile;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
  }

  /**
   * 查询 CLI 安装与服务状态（尽力解析；输出格式随 CLI 版本可能变化）。
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
