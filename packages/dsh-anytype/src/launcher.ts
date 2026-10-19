/**
 * 双后端拉起器：桌面端应用启动 + anytype-cli 服务管理。
 *
 * 生命周期边界（安全设计）：
 * - 桌面端以 **detached** 方式拉起（GUI 进程独立存活，插件/宿主卸载绝不终止）；
 * - CLI 只执行 `service start`（OS 用户服务，生命周期归用户），**绝不**代为
 *   安装服务、创建 bot 账户或签发密钥——那些是用户主权动作，未完成时返回
 *   可操作指引；
 * - 健康判定与进程解耦：拉起后轮询目标 API 的 `/v2/auth/whoami`，收到任意
 *   HTTP 响应（含 401）即视为服务已起；超时返回失败并附指引。
 *
 * Node strip-only 约束：类禁用参数属性（构造器显式赋值）。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

import type { BackendSettings } from './config.ts';
import { desktopExeCandidates } from './config.ts';

/** 拉起器运行时配置（volatile 现读）。 */
export interface LauncherConfig {
  desktop: BackendSettings;
  cli: BackendSettings;
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

/** 拉起/启动结果归类。 */
export type DesktopLaunchResult = 'launched' | 'exe-not-found' | 'failed';
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
  desktopMs: number;
  cliMs: number;
  intervalMs: number;
}

/** 默认轮询预算：桌面端 90s（GUI 启动慢）、CLI 30s、间隔 1s。 */
const DEFAULT_BUDGETS: PollBudgets = {
  desktopMs: 90_000,
  cliMs: 30_000,
  intervalMs: 1000,
};

/**
 * 双后端拉起器。`config` 每次调用现读（volatile 热生效）；
 * `spawnImpl`/`healthFetch`/`execFileImpl`/`budgets` 为测试注入点。
 */
export class BackendLauncher {
  /** 配置现读入口。 */
  private readonly config: () => LauncherConfig;
  /** 桌面端 exe 拉起（注入点；默认 node:child_process spawn detached）。 */
  private readonly spawnImpl: (exe: string) => Promise<void>;
  /** 健康探测 fetch（注入点）。 */
  private readonly healthFetch: HealthFetchLike;
  /** CLI 命令执行（注入点）。 */
  private readonly execFileImpl: ExecFileLike;
  /** 轮询预算（测试可缩短）。 */
  private readonly budgets: PollBudgets;

  constructor(
    config: () => LauncherConfig,
    spawnImpl?: (exe: string) => Promise<void>,
    healthFetch?: HealthFetchLike,
    execFileImpl?: ExecFileLike,
    budgets?: Partial<PollBudgets>,
  ) {
    this.config = config;
    this.spawnImpl =
      spawnImpl ??
      ((exe) =>
        new Promise<void>((resolve, reject) => {
          // spawn detached + unref：GUI 进程独立于宿主存活，插件卸载绝不终止它。
          void import('node:child_process').then(({ spawn }) => {
            try {
              const child = spawn(exe, [], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
              });
              child.on('error', (err) => reject(err));
              child.unref();
              // 给同步 spawn 错误（ENOENT 等）一个事件循环拍
              setTimeout(() => resolve(), 50);
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        }));
    this.healthFetch = healthFetch ?? defaultHealthFetch;
    this.execFileImpl = execFileImpl ?? defaultExecFile;
    this.budgets = { ...DEFAULT_BUDGETS, ...budgets };
  }

  /**
   * 解析桌面端 exe 路径：显式 `desktopPath` 优先（存在性校验），
   * 否则按标准安装位置候选探测。
   *
   * @returns 找到的路径，或 undefined（附候选清单供错误提示）。
   */
  resolveDesktopExe(): { exe?: string; tried: string[] } {
    const configured = this.config().desktop.binPath;
    if (configured.length > 0) {
      return existsSync(configured)
        ? { exe: configured, tried: [configured] }
        : { tried: [configured] };
    }
    const candidates = desktopExeCandidates();
    for (const candidate of candidates) {
      if (existsSync(candidate)) return { exe: candidate, tried: candidates };
    }
    return { tried: candidates };
  }

  /**
   * 拉起桌面端应用（detached）并轮询健康（上限 90s）。
   * 已健康（服务本就在跑）时直接返回 launched。
   */
  async launchDesktop(): Promise<DesktopLaunchResult> {
    const { desktop } = this.config();
    if (await healthyOnce(desktop.url, this.healthFetch)) return 'launched';
    const { exe } = this.resolveDesktopExe();
    if (exe === undefined) return 'exe-not-found';
    try {
      await this.spawnImpl(exe);
    } catch {
      return 'failed';
    }
    return (await pollUntilHealthy(
      desktop.url,
      this.budgets.desktopMs,
      this.budgets.intervalMs,
      this.healthFetch,
    ))
      ? 'launched'
      : 'failed';
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
      const lower = detail.toLowerCase();
      if (lower.includes('not installed') || lower.includes('not-installed')) {
        return { binFound: true, state: 'not-installed', detail };
      }
      if (lower.includes('running') || lower.includes('active')) {
        return { binFound: true, state: 'running', detail };
      }
      if (lower.includes('stopped') || lower.includes('inactive')) {
        return { binFound: true, state: 'stopped', detail };
      }
      return { binFound: true, state: 'unknown', detail };
    } catch (err) {
      const wrapped = err as Error & { stdout?: string; stderr?: string };
      const output = `${wrapped.stdout ?? ''}\n${wrapped.stderr ?? ''}`.trim();
      const combined = `${output}\n${wrapped.message ?? ''}`
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
      if (lower.includes('not installed') || lower.includes('not-installed')) {
        return { binFound: true, state: 'not-installed', detail: combined };
      }
      if (lower.includes('running') || lower.includes('active')) {
        return { binFound: true, state: 'running', detail: combined };
      }
      if (lower.includes('stopped') || lower.includes('inactive')) {
        return { binFound: true, state: 'stopped', detail: combined };
      }
      return { binFound: true, state: 'unknown', detail: combined };
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

/** 面向用户的 autoStart 失败指引（按后端与结果归类）。 */
export function autoStartHint(
  backend: 'desktop' | 'cli',
  result: string,
): string {
  if (backend === 'desktop') {
    if (result === 'exe-not-found') {
      return 'Desktop auto-start failed: Anytype.exe not found. Set desktopPath in Settings → Plugins → dsh-anytype (e.g. the scoop/standard install location), or start the desktop app manually.';
    }
    return 'Desktop auto-start failed: the app did not become healthy in time. Start the Anytype desktop app manually and check its login state.';
  }
  if (result === 'not-installed' || result === 'bin-not-found') {
    return 'CLI auto-start is unavailable: anytype-cli is not installed. See https://github.com/anyproto/anytype-cli — then: `anytype auth create <name>` → `anytype space join <invite>` → `anytype auth apikey create <name> --all-spaces --read-write` → `anytype service install` → `anytype service start`, and put the CLI key into cliKey.';
  }
  if (result === 'already-running') {
    return 'CLI service reports already running but the API did not answer — check `anytype service status` and whether cliKey matches a key created on this CLI instance.';
  }
  return 'CLI service start failed or did not become healthy in time. Check `anytype service status` output.';
}
