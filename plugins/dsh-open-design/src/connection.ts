/**
 * Open Design MCP 连接层：拉起 stdio 子进程、握手、调用、重连与关闭。
 *
 * 语义对齐宿主的 `@deepseek-ai/dsh-mcp-client` 连接层，但只保留本插件需要的最小面：
 *
 * - 连接失败（Open Design 未安装、路径失效、端口被占）绝不冒泡到宿主。
 *   宿主插件实例不应该因为「用户还没装 Open Design」而整体失效，
 *   所以失败只落日志并消耗重连预算，恢复的责任由重连策略承担。
 * - 握手超时用 `startupTimeoutMs`，工具调用超时用 `toolCallTimeoutMs`。
 * - 重连为指数退避（500ms 起、30s 封顶、最多 10 次）；
 *   连接稳定存活超过一个稳定窗口后失败预算重置（与宿主一致：窗口取 maxDelayMs）。
 * - 日志一律带 `[dsh-open-design] ` 前缀，宿主据此识别本插件的日志行。
 */

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import type { StdioServerParameters } from '@modelcontextprotocol/client/stdio';

/** 插件日志前缀：宿主按前缀识别「本插件产生的日志行」。 */
export const LOG_PREFIX = '[dsh-open-design] ';

/** 稳定窗口：连接连续存活超过该时长后，重连失败预算重置。 */
export const RECONNECT_STABILITY_WINDOW_MS = 30_000;

/** 重连策略。 */
export interface ReconnectPolicy {
  /** 是否允许重连。 */
  enabled: boolean;
  /** 首次重连的退避时长（毫秒）。 */
  initialDelayMs: number;
  /** 退避上限（毫秒），同时也是稳定窗口的默认时长。 */
  maxDelayMs: number;
  /** 最多连续重连次数，超过即放弃（宿主会注销该服务器的全部工具）。 */
  maxAttempts: number;
}

/** 重连策略默认值（与宿主 dsh-mcp-client 一致）。 */
export const RECONNECT_DEFAULTS: Readonly<ReconnectPolicy> = Object.freeze({
  enabled: true,
  initialDelayMs: 500,
  maxDelayMs: RECONNECT_STABILITY_WINDOW_MS,
  maxAttempts: 10,
});

/** 连接配置：描述「怎么把 Open Design 的 MCP 服务端拉起来」。 */
export interface ConnectionOptions {
  /** 可执行文件路径（Open Design.exe）。 */
  command: string;
  /** 启动参数。 */
  args: string[];
  /** 子进程环境变量（会覆盖 SDK 的默认继承白名单）。 */
  env?: Record<string, string>;
  /** 子进程工作目录。 */
  cwd?: string;
  /** 握手（连接 + initialize）超时，毫秒。 */
  startupTimeoutMs: number;
  /** 工具调用超时，毫秒。 */
  toolCallTimeoutMs: number;
}

/** 日志接口：默认走 console，测试里可注入假实现。 */
export interface ConnectionLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * 最小 MCP 传输契约。
 * 只声明连接层真正用到的成员，这样单测可以塞一个纯对象当假传输。
 */
export interface McpTransportLike {
  close?(): Promise<void>;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

/** 最小 MCP 客户端契约（真实实现是 `@modelcontextprotocol/client` 的 `Client`）。 */
export interface McpClientLike {
  connect(
    transport: McpTransportLike,
    options?: { timeout?: number },
  ): Promise<void>;
  listTools(
    params?: unknown,
    options?: { timeout?: number; cacheMode?: 'use' | 'refresh' | 'bypass' },
  ): Promise<{ tools: Tool[] }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { timeout?: number },
  ): Promise<CallToolResult>;
  close(): Promise<void>;
  onclose?: () => void;
}

/** 依赖注入点：单测用假实现替换真实的子进程与客户端。 */
export interface ConnectionDeps {
  /** 创建 MCP 客户端。 */
  createClient?: () => McpClientLike;
  /** 创建 stdio 传输（真实实现会 spawn 子进程）。 */
  createTransport?: (params: StdioServerParameters) => McpTransportLike;
  /** 日志实现。 */
  logger?: ConnectionLogger;
  /** 时钟（重连退避与稳定窗口判定用）。 */
  now?: () => number;
  /** 重连策略覆盖。 */
  policy?: Partial<ReconnectPolicy>;
}

/** 连接状态机的状态。 */
export type ConnectionState =
  'connecting' | 'connected' | 'reconnecting' | 'failed' | 'closed';

/** 连接状态快照（诊断用）。 */
export interface ConnectionStatus {
  /** 当前状态。 */
  state: ConnectionState;
  /** 已连续失败（=已消耗）的重连次数。 */
  failedAttempts: number;
  /** 重连次数上限。 */
  maxAttempts: number;
  /** 最近一次错误描述。 */
  lastError?: string;
}

/** 对外的 MCP 连接句柄。 */
export interface McpConnection {
  /** 列出上游工具；尚未连上时等待重连成功。 */
  listTools(): Promise<Tool[]>;
  /** 调用上游工具。 */
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
  /** 关闭连接、终止子进程并停止重连。 */
  close(): Promise<void>;
  /** 配置指纹变化时重建底层连接（指纹不变则不做任何事）。 */
  reconfigure(options: ConnectionOptions): Promise<void>;
  /** 当前状态快照。 */
  readonly status: ConnectionStatus;
}

/**
 * 指数退避时长（纯函数，便于单测）。
 *
 * @param attempt 第几次重试（从 1 开始；第 1 次即返回初始延迟）。
 * @param initialDelayMs 初始延迟。
 * @param maxDelayMs 延迟上限。
 */
export function computeBackoffDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
): number {
  const normalizedAttempt =
    Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1;
  const base =
    Number.isFinite(initialDelayMs) && initialDelayMs > 0 ? initialDelayMs : 0;
  const cap = Number.isFinite(maxDelayMs) && maxDelayMs > 0 ? maxDelayMs : base;
  return Math.min(cap, base * 2 ** (normalizedAttempt - 1));
}

/**
 * 配置指纹：只覆盖「决定子进程身份」的四项（命令、参数、环境、工作目录）。
 *
 * 超时类参数不参与指纹——重建子进程没有必要；它们由 `reconfigure`
 * 单独同步到 `this.options`，下一次 `listTools`/`callTool` 即用新值。
 * 环境变量按键排序，保证序列化结果与插入顺序无关。
 */
export function computeConfigFingerprint(options: ConnectionOptions): string {
  const env = Object.entries(options.env ?? {}).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return JSON.stringify({
    command: options.command,
    args: [...options.args],
    env: Object.fromEntries(env),
    cwd: options.cwd ?? '',
  });
}

/** 默认日志实现：写 console，行首带插件前缀。 */
const consoleLogger: ConnectionLogger = {
  log: (message) => {
    console.log(message);
  },
  warn: (message) => {
    console.warn(message);
  },
  error: (message) => {
    console.error(message);
  },
};

/** 默认客户端工厂：MCP SDK 的 Client。 */
function defaultCreateClient(): McpClientLike {
  return new Client({ name: 'dsh-open-design', version: '0.0.1' });
}

/** 默认传输工厂：stdio 子进程（会 spawn Open Design.exe）。 */
function defaultCreateTransport(
  params: StdioServerParameters,
): McpTransportLike {
  return new StdioClientTransport(params);
}

/** 把错误规整成一行文本。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 定时器尽量 unref：宿主退出时不该被一个待触发的重连定时器吊住。
 * 假定时器（vitest）不一定带 unref，故先探测再调用。
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const candidate = timer as { unref?: () => void };
  if (typeof candidate.unref === 'function') candidate.unref();
}

/** 连接控制器：真正的状态机都藏在这里。 */
class McpConnectionController implements McpConnection {
  private options: ConnectionOptions;
  private readonly createClient: () => McpClientLike;
  private readonly createTransport: (
    params: StdioServerParameters,
  ) => McpTransportLike;
  private readonly logger: ConnectionLogger;
  private readonly now: () => number;
  private readonly policy: ReconnectPolicy;

  private client: McpClientLike | undefined;
  private transport: McpTransportLike | undefined;
  private connectedAt: number | undefined;
  private failedAttempts = 0;
  private closed = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private waiters: Array<{
    resolve: (client: McpClientLike) => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  private state: ConnectionState = 'connecting';
  private lastError: string | undefined;
  private fingerprint: string;

  constructor(options: ConnectionOptions, deps: ConnectionDeps) {
    this.options = cloneOptions(options);
    this.createClient = deps.createClient ?? defaultCreateClient;
    this.createTransport = deps.createTransport ?? defaultCreateTransport;
    this.logger = deps.logger ?? consoleLogger;
    this.now = deps.now ?? Date.now;
    this.policy = { ...RECONNECT_DEFAULTS, ...deps.policy };
    this.fingerprint = computeConfigFingerprint(this.options);
  }

  /** 建立首条连接。失败不抛——只记日志并进入重连。 */
  async start(): Promise<void> {
    await this.attempt();
  }

  get status(): ConnectionStatus {
    return {
      state: this.state,
      failedAttempts: this.failedAttempts,
      maxAttempts: this.policy.maxAttempts,
      lastError: this.lastError,
    };
  }

  async listTools(): Promise<Tool[]> {
    const client = await this.awaitClient();
    const result = await client.listTools(undefined, {
      cacheMode: 'refresh',
      timeout: this.options.toolCallTimeoutMs,
    });
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const client = await this.awaitClient();
    return await client.callTool(
      { name, arguments: args },
      { timeout: this.options.toolCallTimeoutMs },
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.state = 'closed';
    this.clearRetryTimer();
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connectedAt = undefined;
    this.rejectWaiters(new Error(`${LOG_PREFIX}MCP 连接已关闭`));
    await this.disposeGeneration(client, transport);
  }

  async reconfigure(options: ConnectionOptions): Promise<void> {
    if (this.closed) return;
    const fingerprint = computeConfigFingerprint(options);
    // 指纹没变就不重建：避免把同一份配置反复重启成新进程。
    // 但超时类参数不在指纹里——它们同样要同步，保证改动即时生效。
    if (fingerprint === this.fingerprint) {
      this.options = cloneOptions(options);
      return;
    }
    this.fingerprint = fingerprint;
    this.options = cloneOptions(options);
    this.clearRetryTimer();
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connectedAt = undefined;
    // 配置变了等于重新开始，给足重连预算。
    this.failedAttempts = 0;
    this.state = 'connecting';
    await this.disposeGeneration(client, transport);
    await this.attempt();
  }

  /** 跑一次连接尝试；失败一律内部消化，转成重连。 */
  private async attempt(): Promise<void> {
    if (this.closed) return;
    this.state = this.failedAttempts > 0 ? 'reconnecting' : 'connecting';
    const params: StdioServerParameters = {
      command: this.options.command,
      args: [...this.options.args],
      ...(this.options.env ? { env: { ...this.options.env } } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
    };
    let transport: McpTransportLike | undefined;
    let client: McpClientLike | undefined;
    try {
      transport = this.createTransport(params);
      client = this.createClient();
      this.bindGeneration(transport, client);
      await client.connect(transport, {
        timeout: this.options.startupTimeoutMs,
      });
      if (this.closed) {
        // 连接期间宿主已经关掉了插件：把刚拉起来的一代立刻收掉。
        await this.disposeGeneration(client, transport);
        return;
      }
      this.client = client;
      this.transport = transport;
      this.connectedAt = this.now();
      this.failedAttempts = 0;
      this.state = 'connected';
      this.lastError = undefined;
      this.flushWaiters(client);
      this.log(`已连接 Open Design MCP 服务端：${params.command}`);
    } catch (error) {
      await this.disposeGeneration(client, transport);
      this.handleFailure(error);
    }
  }

  /** 给这一代挂上「意外断开」的钩子。 */
  private bindGeneration(
    transport: McpTransportLike,
    client: McpClientLike,
  ): void {
    transport.onerror = (error) => {
      this.warn(`MCP 传输层报错：${errorMessage(error)}`);
    };
    client.onclose = () => {
      // 只有当前代被关闭才算「意外断开」；我们主动关闭旧代时不会触发重连。
      if (this.client === client) this.handleUnexpectedClose();
    };
  }

  /** 连接意外断开：收掉当前代并按策略重连。 */
  private handleUnexpectedClose(): void {
    if (this.closed) return;
    const connectedAt = this.connectedAt;
    this.client = undefined;
    this.transport = undefined;
    this.connectedAt = undefined;
    this.state = 'reconnecting';
    this.warn('Open Design MCP 连接已断开');
    this.scheduleReconnect(connectedAt);
  }

  /** 连接失败：记日志并进入重连预算。 */
  private handleFailure(error: unknown): void {
    const message = errorMessage(error);
    this.lastError = message;
    this.warn(`连接 Open Design MCP 服务端失败：${message}`);
    this.scheduleReconnect(this.connectedAt);
  }

  /**
   * 安排下一次重连。
   *
   * @param connectedAt 上一代成功连接的时刻（未连接过时为 undefined）。
   */
  private scheduleReconnect(connectedAt: number | undefined): void {
    if (this.closed) return;
    if (!this.policy.enabled) {
      this.state = 'failed';
      this.rejectWaiters(new Error(`${LOG_PREFIX}重连已禁用，MCP 连接不可用`));
      this.error('重连已禁用，放弃连接 Open Design MCP 服务端');
      return;
    }
    // 稳定窗口内成功存活过：上一次连接是健康的长连接，失败预算重置。
    if (
      connectedAt !== undefined &&
      this.now() - connectedAt >= this.policy.maxDelayMs
    ) {
      this.failedAttempts = 0;
    }
    this.failedAttempts += 1;
    if (this.failedAttempts > this.policy.maxAttempts) {
      this.state = 'failed';
      this.rejectWaiters(
        new Error(
          `${LOG_PREFIX}重连次数超过上限（${this.policy.maxAttempts} 次），MCP 连接不可用`,
        ),
      );
      this.error(
        `重连次数超过上限（${this.policy.maxAttempts} 次），放弃连接 Open Design MCP 服务端`,
      );
      return;
    }
    const delay = computeBackoffDelay(
      this.failedAttempts,
      this.policy.initialDelayMs,
      this.policy.maxDelayMs,
    );
    this.state = 'reconnecting';
    this.warn(
      `${delay}ms 后重试连接（第 ${this.failedAttempts}/${this.policy.maxAttempts} 次）`,
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.attempt();
    }, delay);
    unrefTimer(this.retryTimer);
  }

  /** 等待一条可用连接。 */
  private awaitClient(): Promise<McpClientLike> {
    if (this.closed) {
      return Promise.reject(new Error(`${LOG_PREFIX}MCP 连接已关闭`));
    }
    if (this.client) return Promise.resolve(this.client);
    if (this.state === 'failed') {
      return Promise.reject(
        new Error(
          `${LOG_PREFIX}MCP 连接不可用：${this.lastError ?? '未知原因'}`,
        ),
      );
    }
    return new Promise<McpClientLike>((resolve, reject) => {
      const waiter: {
        resolve: (client: McpClientLike) => void;
        reject: (error: Error) => void;
        timer?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };
      // 重连窗口有预算上限（退避封顶 × maxAttempts），但仍可能长达数分钟；
      // 等待侧以调用超时兜底，避免工具调用在无反馈的等待中挂死。
      const timeout = this.options.toolCallTimeoutMs;
      if (Number.isFinite(timeout) && timeout > 0) {
        waiter.timer = setTimeout(() => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new Error(
              `${LOG_PREFIX}等待 MCP 连接就绪超时（${timeout}ms），已取消本次调用`,
            ),
          );
        }, timeout);
        unrefTimer(waiter.timer);
      }
      this.waiters.push(waiter);
    });
  }

  private flushWaiters(client: McpClientLike): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(client);
    }
  }

  private rejectWaiters(error: Error): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const waiter of pending) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /** 关掉一代的客户端与传输（传输负责终止子进程）。 */
  private async disposeGeneration(
    client: McpClientLike | undefined,
    transport: McpTransportLike | undefined,
  ): Promise<void> {
    if (client) {
      try {
        await client.close();
      } catch (error) {
        this.warn(`关闭 MCP 客户端失败：${errorMessage(error)}`);
      }
    }
    if (transport) {
      try {
        await transport.close?.();
      } catch (error) {
        this.warn(`关闭 MCP 传输层失败：${errorMessage(error)}`);
      }
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private log(message: string): void {
    this.logger.log(`${LOG_PREFIX}${message}`);
  }

  private warn(message: string): void {
    this.logger.warn(`${LOG_PREFIX}${message}`);
  }

  private error(message: string): void {
    this.logger.error(`${LOG_PREFIX}${message}`);
  }
}

/** 复制配置，避免外部改动影响已建立的连接状态。 */
function cloneOptions(options: ConnectionOptions): ConnectionOptions {
  return {
    ...options,
    args: [...options.args],
    ...(options.env ? { env: { ...options.env } } : {}),
  };
}

/**
 * 建立（或接管）一条 Open Design MCP 连接。
 *
 * 该函数**不会因为连接失败而抛错**：失败只落日志并进入重连策略，
 * 调用方拿到的句柄会在重连成功后自动恢复可用。
 */
export async function connect(
  options: ConnectionOptions,
  deps: ConnectionDeps = {},
): Promise<McpConnection> {
  const controller = new McpConnectionController(options, deps);
  await controller.start();
  return controller;
}
