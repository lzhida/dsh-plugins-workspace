/**
 * 配置卡的纯逻辑层：字段归一、草稿模型、写入载荷构造。
 *
 * 与服务端 `src/anytype/config.ts` / `src/memory/config.ts` 的关系：
 * - 字段**默认值**与**工具组名单**在本文件复刻一份（client 半区不得 import
 *   服务端源码——那会把 schemastery 与 HTTP 客户端打进浏览器产物）；
 *   `src/client-bundle.test.ts` 断言两份名单/默认值逐项一致（防漂移）；
 * - 归一化语义同样对齐服务端 `resolveConfig`（非法值回落默认，绝不抛错）。
 *
 * 草稿模型：每行一份草稿（null = 无未保存编辑），草稿只存**被改过的字段**
 * （partial），因此「脏判定」= 草稿存在且有变更；保存载荷按字段顺序生成
 * `set` op，密钥字段另走「只写」通道（见 ApiKeyEdit）。
 *
 * @module dsh-anytype/client/lib/settings
 */

import type { MutationOp } from '../types.ts';

// ── 常量（与服务端 schema 对齐，由契约测试锁定）──────────────────────

/** Anytype 本地 API 默认地址（服务端 DEFAULT_BASE_URL）。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:31009';

/** `Anytype-Version` 请求头默认值（服务端 DEFAULT_API_VERSION）。 */
export const DEFAULT_API_VERSION = '2025-11-08';

/** 单请求超时默认值（服务端 DEFAULT_REQUEST_TIMEOUT_MS）。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 工具结果文本截断上限默认值（服务端 DEFAULT_MAX_RESPONSE_CHARS）。 */
export const DEFAULT_MAX_RESPONSE_CHARS = 20_000;

/** 默认记忆空间名（服务端 DEFAULT_SPACE_NAME）。 */
export const DEFAULT_SPACE_NAME = 'Agent Memory';

/** 召回默认条数（服务端 DEFAULT_RECALL_LIMIT）。 */
export const DEFAULT_RECALL_LIMIT = 20;

/** 召回默认 token 预算（服务端 DEFAULT_RECALL_MAX_TOKENS）。 */
export const DEFAULT_RECALL_MAX_TOKENS = 4096;

/** 向量投影单批条数（服务端 DEFAULT_EMBEDDING_BATCH_SIZE）。 */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 20;

/** AI 写入记忆的默认审核态（服务端 DEFAULT_MEMORY_STATUS）。 */
export const DEFAULT_MEMORY_STATUS = 'draft';

/** 插件行①的工具组（服务端 src/anytype/config.ts 的 TOOL_GROUPS）。 */
export const ANYTYPE_GROUPS = [
  'connection',
  'search',
  'space',
  'object',
  'collection',
  'type',
  'property',
  'member',
  'schema',
  'generic',
] as const;

/** 插件行②的工具组（服务端 src/memory/config.ts 的 TOOL_GROUPS）。 */
export const MEMORY_GROUPS = [
  'setup',
  'write',
  'read',
  'agent',
  'diag',
] as const;

/** 插件行①的字段写入顺序（载荷 op 顺序稳定，便于测试断言）。 */
export const MAIN_FIELD_ORDER = [
  'enabled',
  'baseUrl',
  'apiVersion',
  'requestTimeoutMs',
  'maxResponseChars',
  'disabledGroups',
] as const;

/** 插件行②的字段写入顺序。 */
export const MEMORY_FIELD_ORDER = [
  'enabled',
  'spaceName',
  'spaceId',
  'defaultStatus',
  'recallLimit',
  'recallMaxTokens',
  'embeddingBatchSize',
  'disabledGroups',
] as const;

// ── 表单模型 ─────────────────────────────────────────────────────────

/** 插件行①的可编辑字段值。 */
export interface MainValues {
  enabled: boolean;
  baseUrl: string;
  apiVersion: string;
  requestTimeoutMs: number;
  maxResponseChars: number;
  disabledGroups: string[];
}

/** 插件行②的可编辑字段值。 */
export interface MemoryValues {
  enabled: boolean;
  spaceName: string;
  spaceId: string;
  defaultStatus: string;
  recallLimit: number;
  recallMaxTokens: number;
  embeddingBatchSize: number;
  disabledGroups: string[];
}

/**
 * 密钥字段的编辑态。
 *
 * - `keep`：不改动（保存载荷**不含** apiKey —— 绝不误写空串清掉密钥）；
 * - `set`：写入用户新输入的密钥；
 * - `unset`：用户显式清除（回落组合层默认值）。
 */
export type ApiKeyEdit =
  { mode: 'keep' } | { mode: 'set'; value: string } | { mode: 'unset' };

/** 插件行①的草稿（只存被改过的字段 + 密钥编辑态 + 写入栅栏）。 */
export interface MainDraft {
  /** 建立草稿时的条目 revision（保存时与最新 revision 比对 → 冲突检测）。 */
  revision: number | undefined;
  /** 被改过的字段。 */
  fields: Partial<MainValues>;
  /** 密钥编辑态。 */
  apiKey: ApiKeyEdit;
}

/** 插件行②的草稿。 */
export interface MemoryDraft {
  revision: number | undefined;
  fields: Partial<MemoryValues>;
}

// ── 归一化（对齐服务端 resolveConfig 的防御语义）────────────────────

/** 布尔归一：仅 `false` 视为关闭，其余回落默认（与服务端一致）。 */
export function normalizeBool(input: unknown, fallback: boolean): boolean {
  if (input === true || input === false) return input;
  return fallback;
}

/** 字符串归一：非字符串回落默认。 */
export function normalizeText(input: unknown, fallback: string): string {
  return typeof input === 'string' ? input : fallback;
}

/** 正整数归一：非法/非正回落默认（与服务端 resolvePositiveInt 一致）。 */
export function normalizePositiveInt(input: unknown, fallback: number): number {
  const raw = Number(input);
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.floor(raw);
}

/** 工具组归一：只保留已知组名（与服务端 disabledGroups 归一一致）。 */
export function normalizeGroups(
  input: unknown,
  known: readonly string[],
): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    const name = String(item);
    if (known.includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** 插件行①的已保存值归一（宿主快照 → 表单模型）。 */
export function readMainValues(value: unknown): MainValues {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    enabled: normalizeBool(raw.enabled, true),
    baseUrl: normalizeText(raw.baseUrl, DEFAULT_BASE_URL),
    apiVersion: normalizeText(raw.apiVersion, DEFAULT_API_VERSION),
    requestTimeoutMs: normalizePositiveInt(
      raw.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    maxResponseChars: normalizePositiveInt(
      raw.maxResponseChars,
      DEFAULT_MAX_RESPONSE_CHARS,
    ),
    disabledGroups: normalizeGroups(raw.disabledGroups, ANYTYPE_GROUPS),
  };
}

/** 插件行②的已保存值归一。 */
export function readMemoryValues(value: unknown): MemoryValues {
  const raw = (value ?? {}) as Record<string, unknown>;
  return {
    enabled: normalizeBool(raw.enabled, true),
    spaceName: normalizeText(raw.spaceName, DEFAULT_SPACE_NAME),
    spaceId: normalizeText(raw.spaceId, ''),
    defaultStatus: normalizeText(raw.defaultStatus, DEFAULT_MEMORY_STATUS),
    recallLimit: normalizePositiveInt(raw.recallLimit, DEFAULT_RECALL_LIMIT),
    recallMaxTokens: normalizePositiveInt(
      raw.recallMaxTokens,
      DEFAULT_RECALL_MAX_TOKENS,
    ),
    embeddingBatchSize: normalizePositiveInt(
      raw.embeddingBatchSize,
      DEFAULT_EMBEDDING_BATCH_SIZE,
    ),
    disabledGroups: normalizeGroups(raw.disabledGroups, MEMORY_GROUPS),
  };
}

// ── 草稿合并与脏判定 ───────────────────────────────────────────────

/** 已保存值 + 草稿 → 当前视图值。 */
export function mergeMain(
  saved: MainValues,
  draft: MainDraft | null,
): MainValues {
  if (draft === null) return saved;
  return { ...saved, ...draft.fields };
}

/** 已保存值 + 草稿 → 当前视图值。 */
export function mergeMemory(
  saved: MemoryValues,
  draft: MemoryDraft | null,
): MemoryValues {
  if (draft === null) return saved;
  return { ...saved, ...draft.fields };
}

/** 插件行①是否有未保存改动。 */
export function isDirtyMain(draft: MainDraft | null): boolean {
  if (draft === null) return false;
  if (Object.keys(draft.fields).length > 0) return true;
  if (draft.apiKey.mode === 'unset') return true;
  if (draft.apiKey.mode === 'set') {
    return draft.apiKey.value.trim().length > 0;
  }
  return false;
}

/** 插件行②是否有未保存改动。 */
export function isDirtyMemory(draft: MemoryDraft | null): boolean {
  if (draft === null) return false;
  return Object.keys(draft.fields).length > 0;
}

// ── 写入载荷 ─────────────────────────────────────────────────────────

/** 插件行①的写入载荷（按 MAIN_FIELD_ORDER 稳定排序 + 密钥 op）。 */
export function buildMainOps(draft: MainDraft): MutationOp[] {
  const ops: MutationOp[] = [];
  for (const key of MAIN_FIELD_ORDER) {
    if (!(key in draft.fields)) continue;
    ops.push({
      op: 'set',
      path: [key],
      value: draft.fields[key] as unknown,
    });
  }
  if (draft.apiKey.mode === 'set') {
    // 留空 = 不改动：**绝不**写空串把已配置的密钥清掉。
    if (draft.apiKey.value.trim().length > 0) {
      ops.push({ op: 'set', path: ['apiKey'], value: draft.apiKey.value });
    }
  } else if (draft.apiKey.mode === 'unset') {
    ops.push({ op: 'unset', path: ['apiKey'] });
  }
  return ops;
}

/** 插件行②的写入载荷。 */
export function buildMemoryOps(draft: MemoryDraft): MutationOp[] {
  const ops: MutationOp[] = [];
  for (const key of MEMORY_FIELD_ORDER) {
    if (!(key in draft.fields)) continue;
    ops.push({
      op: 'set',
      path: [key],
      value: draft.fields[key] as unknown,
    });
  }
  return ops;
}

// ── 校验 ─────────────────────────────────────────────────────────────

/** API 地址是否合法（留空视为非法——服务端会回落默认地址，静默回落易误解）。 */
export function isValidBaseUrl(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 两个值是否等价（数组按元素序比较，其余按 Object.is）。 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  return Object.is(a, b);
}
