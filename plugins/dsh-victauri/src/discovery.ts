import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { VictauriError } from './errors.ts';

/**
 * victauri discovery 目录扫描与实例解析。
 *
 * victauri 服务随 Tauri app 启动时,在 `%TEMP%/victauri/<pid>/` 下落三个文件:
 * - `metadata.json`: {"identifier","pid","port","product_name","started_at","version"}
 * - `port`:纯文本端口号(与 metadata.port 一致)
 * - `token`:UUID 形态的 Bearer token
 * 进程退出后目录残留(stale),因此多候选时按 started_at 降序排列并由调用方
 * 逐个探活(见 client.ts connectAuto);discovery 层只做纯文件系统扫描。
 */

/** 一个已发现的 victauri 实例(discovery 目录的解析结果)。 */
export interface VictauriInstance {
  /** 承载进程的 pid(也是 discovery 目录名) */
  pid: number;
  /** 服务监听端口 */
  port: number;
  /** Bearer token(token 文件内容,trim 后) */
  token: string;
  /** Tauri app bundle id(metadata.identifier);缺失为 null */
  identifier: string | null;
  /** 产品名(metadata.product_name);缺失为 null */
  productName: string | null;
  /** 启动时间 ISO 串(metadata.started_at);缺失为 null */
  startedAt: string | null;
  /** victauri 版本(metadata.version);缺失为 null */
  version: string | null;
  /** discovery 目录绝对路径 */
  dir: string;
}

/** discovery 扫描选项。 */
export interface DiscoveryOptions {
  /** discovery 根目录(可传多个,全部扫描后合并);默认见 discoveryRoots() */
  rootDir?: string | string[];
  /** 按 metadata.identifier(bundle id)过滤;undefined = 不过滤 */
  identifier?: string;
}

/**
 * 平台 discovery 根目录候选列表(按 victauri 文档次序):
 * - Windows:`%TEMP%/victauri`
 * - 类 Unix:`$XDG_RUNTIME_DIR/victauri`(目录私有) → `<tmp>/victauri-<uid>`
 *   → `~/.local/state/victauri`
 * 扫描时按序全部检查(目录不存在自然跳过)。
 */
export function discoveryRoots(): string[] {
  if (process.platform === 'win32') {
    return [join(os.tmpdir(), 'victauri')];
  }
  const roots: string[] = [];
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg) {
    roots.push(join(xdg, 'victauri'));
  }
  roots.push(join(os.tmpdir(), `victauri-${process.getuid?.() ?? 0}`));
  const stateHome =
    process.env['XDG_STATE_HOME'] ?? join(os.homedir(), '.local', 'state');
  roots.push(join(stateHome, 'victauri'));
  return roots;
}

/** 归一化扫描根列表:显式传入优先,否则平台默认。 */
function normalizeRoots(rootDir?: string | string[]): string[] {
  if (rootDir === undefined) return discoveryRoots();
  return Array.isArray(rootDir) ? rootDir : [rootDir];
}

/**
 * 扫描 discovery 根目录,返回全部可解析的实例目录(含 stale 残留)。
 * 单个目录损坏(缺文件/坏 JSON)不抛错——跳过并继续;根目录不存在时返回 []。
 * @throws VictauriError('no-instance') 目录存在但没有任何可解析实例?否——
 *   空结果同样返回 [],"无实例"的语义由 resolveLatest/connectAuto 表达。
 */
export function scanInstances(
  options: DiscoveryOptions = {},
): VictauriInstance[] {
  const roots = normalizeRoots(options.rootDir);
  const instances: VictauriInstance[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name);
    } catch {
      // 该根目录不存在(victauri 从未在此启动)→ 跳过
      continue;
    }
    for (const name of entries) {
      const dir = join(root, name);
      const parsed = readInstanceDir(dir);
      if (parsed) {
        instances.push(parsed);
      }
    }
  }
  return instances.filter((inst) => {
    if (options.identifier === undefined) return true;
    return inst.identifier === options.identifier;
  });
}

/**
 * 挑选 started_at 最新的实例;缺时间戳的条目排在最后。
 * 空列表返回 null(调用方据此报 no-instance)。
 */
export function pickLatest(
  instances: VictauriInstance[],
): VictauriInstance | null {
  if (instances.length === 0) return null;
  const sorted = [...instances].sort(compareByStartedDesc);
  const first = sorted[0];
  return first ?? null;
}

/** started_at 降序比较:缺失(null)视为最旧。 */
export function compareByStartedDesc(
  a: VictauriInstance,
  b: VictauriInstance,
): number {
  const ta = a.startedAt ? Date.parse(a.startedAt) : Number.NEGATIVE_INFINITY;
  const tb = b.startedAt ? Date.parse(b.startedAt) : Number.NEGATIVE_INFINITY;
  if (ta !== tb) return tb - ta;
  // 时间戳相同(或都缺)时用 pid 兜底,排序稳定可复现
  return b.pid - a.pid;
}

/** 按 started_at 降序返回全部候选(供 connectAuto 逐个探活)。 */
export function sortCandidates(
  instances: VictauriInstance[],
): VictauriInstance[] {
  return [...instances].sort(compareByStartedDesc);
}

/** 解析单个实例目录;任一关键文件缺失或解析失败返回 null(容错跳过)。 */
function readInstanceDir(dir: string): VictauriInstance | null {
  let metaRaw: string;
  let portRaw: string;
  let tokenRaw: string;
  try {
    statSync(dir);
    metaRaw = readFileSync(join(dir, 'metadata.json'), 'utf8');
    portRaw = readFileSync(join(dir, 'port'), 'utf8');
    tokenRaw = readFileSync(join(dir, 'token'), 'utf8');
  } catch {
    return null;
  }
  const token = tokenRaw.trim();
  if (token === '') return null;
  const port = Number.parseInt(portRaw.trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(metaRaw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    meta = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (key: string): string | null => {
    const value = meta[key];
    return typeof value === 'string' ? value : null;
  };
  return {
    pid:
      typeof meta['pid'] === 'number' ? meta['pid'] : Number.parseInt(dir, 10),
    port,
    token,
    identifier: str('identifier'),
    productName: str('product_name'),
    startedAt: str('started_at'),
    version: str('version'),
    dir,
  };
}

/**
 * 扫描并直接挑最新的单个实例(便捷入口)。
 * @throws VictauriError('no-instance') 无任何候选
 */
export function resolveLatestInstance(
  options: DiscoveryOptions = {},
): VictauriInstance {
  const list = scanInstances(options);
  const latest = pickLatest(list);
  if (!latest) {
    const hint =
      options.identifier !== undefined
        ? ` (filtered by identifier '${options.identifier}')`
        : '';
    throw new VictauriError(
      'no-instance',
      `no victauri instance found in discovery root${hint}`,
    );
  }
  return latest;
}
