/**
 * dsh-open-design 配置持久化：~/.dsh/plugins/dsh-open-design/config.json。
 *
 * 宿主配置卡的字段是 volatile 的（面板改动即时生效但不落盘），因此插件
 * 自己维护一份持久化配置：启动时读取作为基线，手动改动后写回。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  DetectedEnvironment,
  OpenDesignConfig,
  OpenDesignConfigInput,
} from './config.ts';

export const CONFIG_SCHEMA_VERSION = 1;
export const PLUGIN_DIR_NAME = 'dsh-open-design';
export const CONFIG_FILE_NAME = 'config.json';

/** 落盘的配置文档形态。 */
export interface StoredConfigDocument {
  schemaVersion: number;
  updatedAt: string;
  autoDetect: boolean;
  connection: OpenDesignConfigInput;
  /** 用户在配置卡上显式改过的字段（含显式清空的字段）。 */
  overrides?: OpenDesignConfigInput;
  /** 上次会话看到的配置卡基线快照（跨会话识别用户改动用）。 */
  baseline?: OpenDesignConfigInput;
  detected: DetectedEnvironment | null;
}

export interface StoredConfig {
  config: OpenDesignConfigInput;
  overrides: OpenDesignConfigInput;
  /** 持久化的卡面基线；文档缺失该段时为空对象（视为「无基线」）。 */
  baseline: OpenDesignConfigInput;
  detected: DetectedEnvironment | null;
}

/** 解析 DSH 宿主根目录（默认 ~/.dsh）。 */
export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const fromEnv = env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(home, '.dsh');
}

/** 解析插件自己的配置目录（~/.dsh/plugins/dsh-open-design）。 */
export function resolveConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(resolveDshHome(env, home), 'plugins', PLUGIN_DIR_NAME);
}

/** 解析配置文件绝对路径。 */
export function resolveConfigPath(configDir: string): string {
  return join(configDir, CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从记录里挑出配置输入字段（类型不符的字段直接丢弃）。 */
function parseConfigInput(
  record: Record<string, unknown>,
): OpenDesignConfigInput {
  return {
    autoDetect:
      typeof record.autoDetect === 'boolean' ? record.autoDetect : undefined,
    source: typeof record.source === 'string' ? record.source : undefined,
    serverName:
      typeof record.serverName === 'string' ? record.serverName : undefined,
    command: typeof record.command === 'string' ? record.command : undefined,
    args: Array.isArray(record.args)
      ? record.args.filter((item): item is string => typeof item === 'string')
      : undefined,
    env: isRecord(record.env)
      ? (Object.fromEntries(
          Object.entries(record.env).filter(
            ([, value]) => typeof value === 'string',
          ),
        ) as Record<string, string>)
      : undefined,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
    startupTimeoutMs:
      typeof record.startupTimeoutMs === 'number'
        ? record.startupTimeoutMs
        : undefined,
    toolCallTimeoutMs:
      typeof record.toolCallTimeoutMs === 'number'
        ? record.toolCallTimeoutMs
        : undefined,
  };
}

/** 校验并规整 detected 块；结构不合法时返回 null（宁缺勿错）。 */
function sanitizeDetected(raw: unknown): DetectedEnvironment | null {
  if (!isRecord(raw)) return null;
  const method = raw.method;
  if (method !== 'pipe' && method !== 'powershell' && method !== 'none') {
    return null;
  }
  const stampRecord = isRecord(raw.stamp) ? raw.stamp : null;
  const stampFields = [
    'channel',
    'namespace',
    'source',
    'mode',
    'app',
  ] as const;
  let stamp: DetectedEnvironment['stamp'] = null;
  if (stampRecord !== null) {
    if (!stampFields.every((field) => typeof stampRecord[field] === 'string')) {
      return null;
    }
    stamp = {
      channel: stampRecord.channel as string,
      namespace: stampRecord.namespace as string,
      source: stampRecord.source as string,
      mode: stampRecord.mode as string,
      app: stampRecord.app as string,
    };
  }
  return {
    method,
    stamp,
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    installDir: typeof raw.installDir === 'string' ? raw.installDir : '',
    dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : '',
    daemonCliPath:
      typeof raw.daemonCliPath === 'string' ? raw.daemonCliPath : '',
  };
}

/** 把落盘文档解析成配置输入；结构不合法时返回 null（调用方按「无持久化配置」处理）。 */
export function parseStoredDocument(raw: unknown): StoredConfig | null {
  if (!isRecord(raw)) return null;
  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version > CONFIG_SCHEMA_VERSION) return null;
  const connection = isRecord(raw.connection) ? raw.connection : {};
  const overrides = isRecord(raw.overrides) ? raw.overrides : {};
  const baseline = isRecord(raw.baseline) ? raw.baseline : {};
  return {
    config: parseConfigInput(connection),
    overrides: parseConfigInput(overrides),
    baseline: parseConfigInput(baseline),
    detected: sanitizeDetected(raw.detected),
  };
}

/** 读取持久化配置；文件不存在返回 null，其他读取/解析异常会先告警再返回 null。 */
export async function loadStoredConfig(
  configDir: string,
): Promise<StoredConfig | null> {
  let text: string;
  try {
    text = await readFile(resolveConfigPath(configDir), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return null;
    console.warn(
      `[dsh-open-design] 配置文件读取失败，已忽略：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
  try {
    return parseStoredDocument(JSON.parse(text));
  } catch (error) {
    console.warn(
      `[dsh-open-design] 配置文件内容损坏，已忽略（用户手改请检查 JSON 语法）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

/** 把生效配置写成持久化文档（旧文件先备份为 config.json.bak，再原子替换）。 */
export async function saveStoredConfig(
  configDir: string,
  config: OpenDesignConfig,
  now: Date = new Date(),
  overrides?: OpenDesignConfigInput,
  baseline?: OpenDesignConfigInput,
): Promise<string> {
  const path = resolveConfigPath(configDir);
  await mkdir(dirname(path), { recursive: true });
  const document: StoredConfigDocument = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    autoDetect: config.autoDetect,
    connection: {
      source: config.source,
      serverName: config.serverName,
      command: config.command,
      args: [...config.args],
      env: { ...config.env },
      cwd: config.cwd,
      startupTimeoutMs: config.startupTimeoutMs,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
    },
    overrides: { ...(overrides ?? {}) },
    baseline: { ...(baseline ?? {}) },
    detected: config.detected,
  };
  // 用户可能手改过 config.json（含 overrides 段）：覆盖前留一份 .bak，
  // 手改失误时还有退路。备份失败不阻断写入。
  try {
    await copyFile(path, `${path}.bak`);
  } catch {
    // 首次写入时旧文件不存在，属正常路径。
  }
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
  return path;
}
