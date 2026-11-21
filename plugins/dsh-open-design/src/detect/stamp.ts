/**
 * dsh-open-design 探测模块（一）：Open Design sidecar 部署语义戳与命名管道端点推算。
 *
 * Open Design 的 sidecar 监督进程带一组 `--od-stamp-*` 标记（channel / namespace /
 * source / mode / app），它的命名管道名由「Windows 用户名 + 这组标记」做 SHA-256 后
 * 取十六进制前 32 位拼成（Open Design 侧 sidecar/dist/index.mjs 的 pipeDigest 实现）。
 * 本模块把这条规则复刻为纯函数，供 detector 用枚举出的管道名做比对。
 *
 * 路径语义统一走 `path.win32`：Open Design 是 Windows 应用，路径拼接必须与
 * Windows 语义一致，且与运行主机无关（便于跨平台单测断言）。
 */
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { win32 } from 'node:path';

import type { SidecarStamp } from '../config.ts';

/** Windows 命名管道根。 */
export const PIPE_ROOT = '\\\\.\\pipe\\';

/** 命名管道名前缀（摘要之前的一段）。 */
export const PIPE_PREFIX = 'open-design-sidecar-';

/** 摘要长度：SHA-256 十六进制前 32 位。 */
const DIGEST_LENGTH = 32;

/** 参与哈希的语义字段及其顺序（必须与 Open Design 侧保持一致）。 */
export const STAMP_FIELDS = [
  'channel',
  'namespace',
  'source',
  'mode',
  'app',
] as const;

/** 默认 channel 候选（覆盖 stable 与 release-stable 两条发布通道）。 */
export const DEFAULT_CHANNEL_CANDIDATES: readonly string[] = [
  'stable',
  'release-stable',
];

/** 枚举不到 namespaces 目录时使用的兜底 namespace。 */
export const FALLBACK_NAMESPACE = 'release-stable-win';

/** 固定的 source 取值。 */
export const FIXED_SOURCE = 'packaged';

/** 固定的 mode 取值。 */
export const FIXED_MODE = 'runtime';

/** MCP 客户端锁定的 app 取值。 */
export const FIXED_APP = 'daemon';

/** 一个候选语义戳及其对应的管道摘要与端点。 */
export interface StampCandidate {
  /** 语义戳本身。 */
  stamp: SidecarStamp;
  /** 管道摘要（十六进制 32 位）。 */
  digest: string;
  /** 完整命名管道端点。 */
  endpoint: string;
}

/** 构造候选集的可选入参。 */
export interface StampCandidateOptions {
  /** 哈希主体：Windows 用户名（os.userInfo().username）。 */
  principal: string;
  /** namespaces 目录；缺省时按 appDataDir 推导。 */
  namespaceDir?: string;
  /** 数据根目录（%APPDATA%）；缺省时取环境变量 APPDATA。 */
  appDataDir?: string;
  /** channel 候选；缺省为 DEFAULT_CHANNEL_CANDIDATES。 */
  channels?: readonly string[];
  /** 目录枚举实现（测试可注入），返回子目录名数组。 */
  readNamespaces?: (dir: string) => string[];
}

/** 把语义戳拼成参与哈希的键值串（字段顺序固定）。 */
export function sidecarStampKey(stamp: SidecarStamp): string {
  return STAMP_FIELDS.map((field) => `${field}=${stamp[field]}`).join('\n');
}

/** 计算语义戳对应的管道摘要：sha256(用户名 + '\n' + 键值串) 前 32 位十六进制。 */
export function computePipeDigest(
  principal: string,
  stamp: SidecarStamp,
): string {
  return createHash('sha256')
    .update(`${principal}\n${sidecarStampKey(stamp)}`)
    .digest('hex')
    .slice(0, DIGEST_LENGTH);
}

/** 计算语义戳对应的完整命名管道端点。 */
export function computePipeEndpoint(
  principal: string,
  stamp: SidecarStamp,
): string {
  return `${PIPE_ROOT}${PIPE_PREFIX}${computePipeDigest(principal, stamp)}`;
}

/**
 * 构造静态候选集：namespace 来自 namespaces 目录的子目录名枚举，
 * channel 取给定候选（缺省 stable / release-stable），source / mode / app 固定。
 *
 * 枚举失败或结果为空时退到兜底 namespace；兜底值始终参与候选（升级换通道后
 * 仍有机会命中已知可用组合）。
 */
export function buildStampCandidates(
  options: StampCandidateOptions,
): StampCandidate[] {
  const channels = options.channels ?? DEFAULT_CHANNEL_CANDIDATES;
  const namespaceDir =
    options.namespaceDir ?? defaultNamespaceDir(options.appDataDir);
  const namespaces = enumerateNamespaces(
    namespaceDir,
    options.readNamespaces ?? readNamespaces,
  );
  const candidates: StampCandidate[] = [];
  const seen = new Set<string>();
  for (const namespace of namespaces) {
    for (const channel of channels) {
      const stamp: SidecarStamp = {
        channel,
        namespace,
        source: FIXED_SOURCE,
        mode: FIXED_MODE,
        app: FIXED_APP,
      };
      const digest = computePipeDigest(options.principal, stamp);
      if (seen.has(digest)) continue;
      seen.add(digest);
      candidates.push({
        stamp,
        digest,
        endpoint: computePipeEndpoint(options.principal, stamp),
      });
    }
  }
  return candidates;
}

/** 从进程命令行解析 `--od-stamp-*` 标记；缺任一字段返回 null。 */
export function parseStampFlags(commandLine: string): SidecarStamp | null {
  if (!commandLine) return null;
  const read = (field: string): string | null => {
    const match = new RegExp(`--od-stamp-${field}=("[^"]*"|[^\\s"]+)`).exec(
      commandLine,
    );
    if (!match?.[1]) return null;
    return match[1].replace(/^"|"$/g, '');
  };
  const channel = read('channel');
  const namespace = read('namespace');
  const source = read('source');
  const mode = read('mode');
  const app = read('app');
  if (!channel || !namespace || !source || !mode || !app) return null;
  return { channel, namespace, source, mode, app };
}

/** 按 appDataDir 推导 namespaces 目录；缺省用 %APPDATA%。 */
export function defaultNamespaceDir(appDataDir?: string): string {
  const base = appDataDir ?? process.env.APPDATA ?? '';
  if (!base) return '';
  return win32.join(base, 'Open Design', 'namespaces');
}

/** 枚举 namespaces 目录下的子目录名；目录不可读时返回空数组。 */
function readNamespaces(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 枚举 namespace 候选：目录子目录名 + 兜底值，去重后按字典序返回。 */
function enumerateNamespaces(
  dir: string,
  reader: (dir: string) => string[],
): string[] {
  const names = new Set<string>();
  if (dir) {
    try {
      for (const name of reader(dir)) {
        if (name) names.add(name);
      }
    } catch {
      // 目录不可读：继续用兜底 namespace
    }
  }
  names.add(FALLBACK_NAMESPACE);
  return [...names].sort();
}
