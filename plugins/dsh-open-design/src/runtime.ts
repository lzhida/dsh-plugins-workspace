/**
 * dsh-open-design 运行时：把「探测 → 合并配置 → 建立 MCP 连接 → 桥接上游工具」
 * 串成一条线。
 *
 * 设计要点：
 * - 探测只在启动时跑一次（配置卡 `autoDetect=false` 时跳过），
 *   之后由 `open_design_redetect` 诊断工具手动重跑。
 * - 配置卡字段是 volatile 的：宿主改动只替换 volatile 快照，不重启插件。
 *   因此运行时在每次工具调用前做一次「懒刷新」——重新摊平配置卡取值、
 *   重算生效配置，配置指纹变了才重建连接。
 * - 任何失败都只落日志，绝不冒泡成宿主插件异常。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import {
  createBridge,
  type BridgeHandle,
  type BridgeTarget,
} from './bridge.ts';
import {
  connect,
  LOG_PREFIX,
  type ConnectionOptions,
  type McpConnection,
} from './connection.ts';
import {
  CONFIG_FIELD_DEFAULTS,
  collectExplicitOverrides,
  isExplicitValue,
  resolveConfig,
  type ConfigField,
  type DetectedEnvironment,
  type OpenDesignConfig,
  type OpenDesignConfigInput,
} from './config.ts';
import { unwrapVolatileAs } from './core/volatile.ts';
import { detectOnce } from './detect/detector.ts';
import {
  DIAGNOSTIC_TOOL_COUNT,
  type DiagnosticReport,
  type DiagnosticRuntime,
} from './diag-tools.ts';
import {
  loadStoredConfig,
  resolveConfigDir,
  resolveConfigPath,
  saveStoredConfig,
} from './store.ts';

/** 上游 Open Design MCP 工具数量基线（随上游版本浮动，0.27.2 实测 22 个）。 */
export const UPSTREAM_TOOL_COUNT_BASELINE = 22;

/** 运行时的可替换依赖（单测用假实现替换真实探测/连接/目录）。 */
export interface RuntimeDeps {
  /** 安装环境探测（默认 `detectOnce`）。 */
  detect?: () => Promise<DetectedEnvironment>;
  /** 建立 MCP 连接（默认 `connect`）。 */
  connect?: (options: ConnectionOptions) => Promise<McpConnection>;
  /** 插件配置目录（默认 `~/.dsh/plugins/dsh-open-design`）。 */
  configDir?: string;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** 按结构比较两份配置值是否等值（数组/对象做 JSON 序列化比较）。 */
function sameFieldValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** 生效配置去掉 detected 快照后的稳定形态（用于「是否变化」比较）。 */
function stableConfig(config: OpenDesignConfig): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...config };
  delete rest.detected;
  return rest;
}

/** 把生效配置转成连接层参数。 */
function toConnectionOptions(config: OpenDesignConfig): ConnectionOptions {
  return {
    command: config.command,
    args: [...config.args],
    env: { ...config.env },
    cwd: config.cwd,
    startupTimeoutMs: config.startupTimeoutMs,
    toolCallTimeoutMs: config.toolCallTimeoutMs,
  };
}

/**
 * 插件运行时。
 *
 * 承担三件事：安装环境探测、配置合并与持久化、MCP 连接与工具桥接。
 */
export class OpenDesignRuntime implements DiagnosticRuntime {
  private readonly ctx: Context;
  private readonly cardInput: OpenDesignConfigInput;
  private readonly configDir: string;
  private overrides: OpenDesignConfigInput = {};
  private detected: DetectedEnvironment | null = null;
  /** 本次会话启动时的配置卡基线（用于识别用户的界面改动）。 */
  private cardBaseline: OpenDesignConfigInput = {};
  /** 当前生效配置。 */
  private config: OpenDesignConfig | null = null;
  private connection: McpConnection | null = null;
  private bridge: BridgeHandle | null = null;
  private bridgeServerName: string | null = null;
  private upstreamToolCount = 0;
  /** 最近一次同步中被跳过的上游工具名单（schema 不受宿主支持等）。 */
  private skippedTools: string[] = [];
  private syncChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly deps: RuntimeDeps;

  constructor(ctx: Context, configInput?: unknown, deps: RuntimeDeps = {}) {
    this.ctx = ctx;
    this.cardInput = (configInput ?? {}) as OpenDesignConfigInput;
    this.deps = deps;
    this.configDir = deps.configDir ?? resolveConfigDir();
  }

  /** 启动：读持久化意图 → 探测 → 合并 → 落盘 → 连接 → 同步上游工具。 */
  async start(): Promise<void> {
    try {
      const stored = await loadStoredConfig(this.configDir);
      this.overrides = { ...(stored?.overrides ?? {}) };
      this.detected = stored?.detected ?? null;

      const card = this.readCard();
      // 基线优先用持久化的卡面快照（跨会话也能识别「改回默认=清除意图」）；
      // 文件缺失或该段为空（旧格式）时退回当前卡面。
      const storedBaseline = stored?.baseline ?? {};
      this.cardBaseline =
        Object.keys(storedBaseline).length > 0
          ? { ...storedBaseline }
          : { ...card };
      this.overrides = {
        ...this.overrides,
        ...collectExplicitOverrides(card),
      };
      // 启动即做基线差分：新会话把卡改回默认时，立即清除上一会话的覆盖意图。
      this.applyCardEdits(card);

      // 探测开关按 effective 值判定（overrides > 卡显式 > 默认开），
      // 与 resolveConfig 同口径，避免卡面被宿主重置后误判用户意图。
      const effective = resolveConfig(card, this.detected, this.overrides);
      if (effective.autoDetect) {
        this.detected = await this.runDetection();
      }

      this.config = this.resolveFromSources();
      await this.persist();
      await this.ensureConnection();
      await this.syncUpstreamTools();
    } catch (error) {
      console.error(`${LOG_PREFIX}启动失败：${describeError(error)}`);
    }
  }

  /** 当前生效配置与连接状态快照。 */
  status(): DiagnosticReport {
    const config = this.config ?? this.resolveFromSources();
    const detected = this.detected;
    const connection = this.connection;
    return {
      autoDetect: config.autoDetect,
      serverName: config.serverName,
      source: config.source,
      command: config.command,
      args: [...config.args],
      env: { ...config.env },
      cwd: config.cwd,
      startupTimeoutMs: config.startupTimeoutMs,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      detectionMethod: detected?.method ?? 'none',
      installed: Boolean(detected?.installDir),
      stamp: detected?.stamp ?? null,
      endpoint: detected?.endpoint ?? '',
      installDir: detected?.installDir ?? '',
      dataDir: detected?.dataDir ?? '',
      daemonCliPath: detected?.daemonCliPath ?? '',
      connectionState: connection?.status.state ?? 'closed',
      failedAttempts: connection?.status.failedAttempts ?? 0,
      maxAttempts: connection?.status.maxAttempts ?? 0,
      lastError: connection?.status.lastError ?? null,
      upstreamToolCount: this.upstreamToolCount,
      upstreamSkippedTools: [...this.skippedTools],
      diagnosticToolCount: DIAGNOSTIC_TOOL_COUNT,
      configFile: resolveConfigPath(this.configDir),
    };
  }

  /** 重跑探测并按新结果刷新连接与工具。 */
  async redetect(): Promise<DiagnosticReport> {
    this.detected = await this.runDetection();
    this.config = this.resolveFromSources();
    await this.persist();
    await this.ensureConnection();
    await this.syncUpstreamTools();
    return this.status();
  }

  /** 关闭连接与已注册的上游工具。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.bridge?.dispose();
    this.bridge = null;
    const connection = this.connection;
    this.connection = null;
    if (!connection) return;
    try {
      await connection.close();
    } catch (error) {
      console.warn(`${LOG_PREFIX}关闭 MCP 连接失败：${describeError(error)}`);
    }
  }

  /** 读取配置卡当前值（摊平 volatile 快照）。 */
  private readCard(): OpenDesignConfigInput {
    return unwrapVolatileAs<OpenDesignConfigInput>(this.cardInput);
  }

  /** 按当前三层来源重算生效配置。 */
  private resolveFromSources(): OpenDesignConfig {
    const card = this.readCard();
    return resolveConfig(card, this.detected, this.overrides);
  }

  /** 跑一次安装环境探测。 */
  private async runDetection(): Promise<DetectedEnvironment> {
    console.log(`${LOG_PREFIX}正在检测 Open Design 安装环境…`);
    const detect = this.deps.detect ?? (() => detectOnce());
    const detected = await detect();
    console.log(
      `${LOG_PREFIX}探测结果：方式=${detected.method} 端点=${detected.endpoint || '(未命中)'} 安装目录=${detected.installDir || '(未找到)'}`,
    );
    return detected;
  }

  /** 把生效配置写回持久化文件（含 overrides 与卡面基线）。 */
  private async persist(): Promise<void> {
    if (!this.config) return;
    try {
      await saveStoredConfig(
        this.configDir,
        this.config,
        new Date(),
        this.overrides,
        this.cardBaseline,
      );
    } catch (error) {
      console.warn(`${LOG_PREFIX}持久化配置失败：${describeError(error)}`);
    }
  }

  /** 建立或重建 MCP 连接（连接参数未变时由连接层自行跳过重建）。 */
  private async ensureConnection(): Promise<void> {
    const config = this.config;
    if (!config) return;
    if (!config.command) {
      console.warn(
        `${LOG_PREFIX}未解析到 Open Design 可执行文件，跳过 MCP 连接；可在配置卡手填 command/args/env。`,
      );
      return;
    }
    const options = toConnectionOptions(config);
    if (this.connection && this.bridgeServerName === config.serverName) {
      await this.connection.reconfigure(options);
      return;
    }
    if (this.connection) {
      // 服务名变了：工具命名空间随之改变，需要换装桥接；进程本身仍可复用。
      await this.connection.reconfigure(options);
    } else {
      const open = this.deps.connect ?? connect;
      this.connection = await open(options);
    }
    this.bridge?.dispose();
    this.bridge = createBridge(
      this.toolTarget(),
      config.serverName,
      (name, args) => this.callUpstream(name, args),
    );
    this.bridgeServerName = config.serverName;
  }

  /** 宿主工具注册面。 */
  private toolTarget(): BridgeTarget {
    return {
      register: (definition: unknown) =>
        this.ctx.tools.register(definition as ToolDefinition),
    };
  }

  /**
   * 把配置卡相对基线的变化合并进 overrides：
   * 改成非默认值 → 记为用户意图；改回默认值 → 删除该意图（回落探测/默认）。
   * 返回是否有任何改动（含仅基线变化——基线也要落盘供跨会话差分）。
   */
  private applyCardEdits(card: OpenDesignConfigInput): boolean {
    let touched = false;
    for (const field of Object.keys(CONFIG_FIELD_DEFAULTS) as ConfigField[]) {
      if (sameFieldValue(this.cardBaseline[field], card[field])) continue;
      touched = true;
      if (isExplicitValue(field, card[field])) {
        (this.overrides as Record<string, unknown>)[field] = card[field];
        console.log(`${LOG_PREFIX}配置卡 ${field} 已更新`);
      } else {
        delete (this.overrides as Record<string, unknown>)[field];
        console.log(`${LOG_PREFIX}配置卡 ${field} 已回落默认语义`);
      }
    }
    if (touched) this.cardBaseline = { ...card };
    return touched;
  }

  /** 懒刷新：配置卡改动在下次工具调用前生效。 */
  private async refresh(): Promise<void> {
    if (this.disposed) return;
    const card = this.readCard();
    const cardTouched = this.applyCardEdits(card);

    const next = this.resolveFromSources();
    const previous = this.config;
    this.config = next;

    const changed =
      JSON.stringify(stableConfig(next)) !==
      JSON.stringify(stableConfig(previous ?? next));
    // 基线变化但生效配置未变时只补落盘（供下次会话差分），不重连。
    if (!changed && !cardTouched) return;

    console.log(`${LOG_PREFIX}检测到配置变化，刷新 MCP 连接…`);
    await this.persist();
    if (!changed) return;
    await this.ensureConnection();
    await this.syncUpstreamTools();
  }

  /**
   * 对外暴露的上游工具调用口（宿主半区 HTTP 路由用）。
   *
   * 复用本 runtime 已有的 MCP 连接（不另起子进程），语义与工具桥接一致：
   * 先懒刷新配置，再走 callTool；连接不可用时抛可读错误。
   */
  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    return await this.callUpstream(name, args);
  }

  /** 调用上游 MCP 工具。 */
  private async callUpstream(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    await this.refresh();
    const connection = this.connection;
    if (!connection) {
      throw new Error(
        'MCP 连接不可用：请确认已安装 Open Design，或在配置卡填写 command/args/env。',
      );
    }
    return await connection.callTool(name, args);
  }

  /** 拉取上游工具清单并整体换装到宿主工具面。 */
  private async syncUpstreamTools(): Promise<void> {
    this.syncChain = this.syncChain.then(async () => {
      const connection = this.connection;
      if (!connection || this.disposed) return;
      try {
        const tools = await connection.listTools();
        if (this.disposed) return;
        const result = this.bridge?.syncTools(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
          })),
        );
        this.upstreamToolCount = result?.registered ?? tools.length;
        this.skippedTools = result?.skipped ?? [];
        console.log(
          `${LOG_PREFIX}已注册 ${this.upstreamToolCount} 个 Open Design 工具`,
        );
      } catch (error) {
        console.warn(`${LOG_PREFIX}同步上游工具失败：${describeError(error)}`);
      }
    });
    await this.syncChain;
  }
}
