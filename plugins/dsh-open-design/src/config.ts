/**
 * dsh-open-design 配置层：bundle 配置卡 schema（volatile）+ 配置合并语义。
 *
 * 合并优先级（自高而低）：
 *   1. overrides——用户显式意图（配置卡改动由运行时自动写入，也可在
 *      config.json 的 overrides 段手改；值等于 schema 默认值的项视为
 *      「回落默认语义」，不生效）
 *   2. 配置卡显式值（与 schema 默认值不同才算显式——宿主会补齐默认值）
 *   3. 探测填充（自动检测 Open Design 安装环境的结果）
 *
 * config.json 的 connection 段是「生效快照」（供查看、与 Zed 等客户端的
 * 参考注册对照），不参与合并；detected 段是最近一次探测的快照。
 *
 * 配置卡字段均为 volatile：面板改动即时生效但不落盘，跨会话保留由
 * 插件自己的 config.json 负责（见 store.ts）。
 */
import * as path from 'node:path';

import Schema from '@deepseek-ai/schemastery';
import { desc, setDescription, volatileField } from './core/volatile.ts';

/** Open Design 侧的部署语义维度，决定管道端点哈希。 */
export interface SidecarStamp {
  channel: string;
  namespace: string;
  source: string;
  mode: string;
  app: string;
}

/** 探测结果：安装环境与管道端点的快照。 */
export interface DetectedEnvironment {
  /** 探测方式：'pipe' | 'powershell' | 'none' */
  method: 'pipe' | 'powershell' | 'none';
  /** 命中的部署语义维度（method='none' 时为 null） */
  stamp: SidecarStamp | null;
  /** 命名管道端点，形如 \\.\pipe\open-design-sidecar-<32 hex> */
  endpoint: string;
  /** Open Design 可执行文件目录 */
  installDir: string;
  /** Open Design 数据目录（namespaces/<namespace>/data） */
  dataDir: string;
  /** MCP 守护进程脚本绝对路径 */
  daemonCliPath: string;
}

/** 生效的 MCP 连接配置。 */
export interface ResolvedConnectionConfig {
  source: string;
  serverName: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  startupTimeoutMs: number;
  toolCallTimeoutMs: number;
}

export interface OpenDesignConfig extends ResolvedConnectionConfig {
  /** 启动时是否自动探测 Open Design 安装环境 */
  autoDetect: boolean;
  /** 探测到的环境快照（只读，供诊断工具展示） */
  detected: DetectedEnvironment | null;
}

/** 配置来源的原始输入形态（全部可选，未填表示「未显式配置」）。 */
export interface OpenDesignConfigInput {
  autoDetect?: boolean;
  source?: string;
  serverName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  startupTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

export const DEFAULT_SERVER_NAME = 'open-design';
export const DEFAULT_SOURCE = 'custom';
export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60_000;

/**
 * 配置卡字段的 schema 默认值（必须与 Config schema 逐项一致）。
 *
 * 宿主在把配置交给插件之前会按 schema 补齐缺失字段（volatile 字段同样
 * 会被填成 `createVolatile(default)`），因此「值非空」并不能证明用户改过
 * ——只有与默认值不同才算显式设置。判定显式性一律走本表。
 */
export const CONFIG_FIELD_DEFAULTS = {
  autoDetect: true,
  source: DEFAULT_SOURCE,
  serverName: DEFAULT_SERVER_NAME,
  command: '',
  args: [] as string[],
  env: {} as Record<string, string>,
  cwd: '',
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
} as const;

/** 配置卡字段名。 */
export type ConfigField = keyof OpenDesignConfigInput;

/**
 * schemastery schema；导出名沿用 dsh 的 `Config` 契约
 * （loader 读取并投影成设置面板表单；入口必须 re-export）。
 */
export const Config = Schema.object({
  autoDetect: volatileField(
    setDescription(
      Schema.boolean().default(true),
      desc(
        'Detect the Open Design installation on startup.',
        '启动时自动检测 Open Design 安装环境。',
      ),
    ),
  ),
  source: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_SOURCE),
      desc(
        'Connection source label, mirrors the Open Design registration.',
        '连接来源标识，与 Open Design 注册信息保持一致。',
      ),
    ),
  ),
  serverName: volatileField(
    setDescription(
      Schema.string().default(DEFAULT_SERVER_NAME),
      desc(
        'MCP server name used as the tool namespace prefix.',
        'MCP 服务名，用作工具命名空间前缀。',
      ),
    ),
  ),
  command: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Absolute path of the Open Design executable (empty = auto detect).',
        'Open Design 可执行文件的绝对路径（留空表示自动探测）。',
      ),
    ),
  ),
  args: volatileField(
    setDescription(
      Schema.array(Schema.string()).default([]),
      desc(
        'Arguments passed to the Open Design executable.',
        '传给 Open Design 可执行文件的参数。',
      ),
    ),
  ),
  env: volatileField(
    setDescription(
      Schema.dict(Schema.string()).default({}),
      desc(
        'Environment variables for the MCP child process.',
        'MCP 子进程的环境变量。',
      ),
    ),
  ),
  cwd: volatileField(
    setDescription(
      Schema.string().default(''),
      desc(
        'Working directory for the MCP child process.',
        'MCP 子进程的工作目录。',
      ),
    ),
  ),
  startupTimeoutMs: volatileField(
    setDescription(
      Schema.natural().default(DEFAULT_STARTUP_TIMEOUT_MS),
      desc(
        'Milliseconds to wait for the MCP server to start.',
        '等待 MCP 服务启动的毫秒数。',
      ),
    ),
  ),
  toolCallTimeoutMs: volatileField(
    setDescription(
      Schema.natural().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
      desc(
        'Milliseconds to wait for a tool call to finish.',
        '单次工具调用超时毫秒数。',
      ),
    ),
  ),
});

/**
 * 由探测结果推导 MCP 连接参数（探测填充层，供运行时与合并逻辑共用）。
 *
 * 探测未命中（method='none'）时 command/args 为空、env 不注入任何变量
 * ——包括 ELECTRON_RUN_AS_NODE，避免带着误导性的半套环境值落盘。
 */
export function deriveDetectedConnection(
  detected: DetectedEnvironment | null,
): { command: string; args: string[]; env: Record<string, string> } {
  const endpoint = detected?.endpoint ?? '';
  const command = detected?.installDir
    ? path.win32.join(detected.installDir, 'Open Design.exe')
    : '';
  const args = detected?.daemonCliPath ? [detected.daemonCliPath, 'mcp'] : [];
  const env: Record<string, string> = {};
  if (!command) return { command, args, env };
  if (detected?.dataDir) env.OD_DATA_DIR = detected.dataDir;
  if (endpoint) env.OD_SIDECAR_CLIENT_ENDPOINT = endpoint;
  env.OD_MCP_BOOTSTRAP_COMMAND = command;
  env.OD_MCP_BOOTSTRAP_ARGS = JSON.stringify(['--headless']);
  env.ELECTRON_RUN_AS_NODE = '1';
  return { command, args, env };
}

/**
 * 判断配置来源里的某字段是否被用户显式设置。
 *
 * 只有与 schema 默认值不同才算显式：宿主在交付配置前会按 schema 补齐
 * 缺失字段（volatile 字段被填成 `createVolatile(default)`），「非空」
 * 因此不再能区分「用户填的」与「宿主填的」。
 */
export function isExplicitValue(field: ConfigField, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  const fallback = CONFIG_FIELD_DEFAULTS[field];
  if (typeof fallback === 'boolean') return value !== fallback;
  if (typeof fallback === 'number')
    return typeof value === 'number' && value !== fallback;
  if (typeof fallback === 'string')
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim() !== fallback
    );
  if (Array.isArray(fallback)) return Array.isArray(value) && value.length > 0;
  return (
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length > 0
  );
}

/**
 * 收集配置来源里「与 schema 默认值不同」的字段。
 *
 * 用途：插件启动时把宿主已持久化的配置卡值合并进 overrides。
 */
export function collectExplicitOverrides(
  cardInput: OpenDesignConfigInput | undefined,
): OpenDesignConfigInput {
  const card = (cardInput ?? {}) as OpenDesignConfigInput;
  const overrides: OpenDesignConfigInput = {};
  for (const field of Object.keys(CONFIG_FIELD_DEFAULTS) as ConfigField[]) {
    const value = card[field];
    if (isExplicitValue(field, value)) {
      (overrides as Record<string, unknown>)[field] = value;
    }
  }
  return overrides;
}

/**
 * 合并多层配置来源，得到最终生效的连接配置。
 *
 * 优先级（自高而低）：
 *   1. overrides——用户显式意图（值等于 schema 默认值的项视为无效，
 *      即「回落默认语义」）；
 *   2. 配置卡的显式值（与 schema 默认值不同才算显式）；
 *   3. 探测填充（deriveDetectedConnection 的推导结果）。
 */
export function resolveConfig(
  cardInput: OpenDesignConfigInput | undefined,
  detected: DetectedEnvironment | null,
  overrides?: OpenDesignConfigInput | undefined,
): OpenDesignConfig {
  const card = (cardInput ?? {}) as OpenDesignConfigInput;
  const userOverrides = (overrides ?? {}) as OpenDesignConfigInput;
  const fill = deriveDetectedConnection(detected);

  const pick = <T>(field: ConfigField, fallback: T): T => {
    const override = userOverrides[field];
    if (isExplicitValue(field, override)) return override as T;
    const fromCard = card[field];
    if (isExplicitValue(field, fromCard)) return fromCard as T;
    return fallback;
  };

  return {
    autoDetect: pick('autoDetect', true),
    source: pick('source', DEFAULT_SOURCE),
    serverName: pick('serverName', DEFAULT_SERVER_NAME),
    command: pick('command', fill.command),
    args: [...pick('args', fill.args)],
    env: { ...pick('env', fill.env) },
    cwd: pick('cwd', ''),
    startupTimeoutMs: pick('startupTimeoutMs', DEFAULT_STARTUP_TIMEOUT_MS),
    toolCallTimeoutMs: pick('toolCallTimeoutMs', DEFAULT_TOOL_CALL_TIMEOUT_MS),
    detected: detected ?? null,
  };
}
