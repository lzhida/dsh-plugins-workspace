/**
 * 记忆去重与冲突候选（纯函数，零 HTTP、零本地状态）。
 *
 * ## 幂等键：content_hash
 *
 * Anytype v2 没有唯一约束，但**属性等值过滤是原生的**——所以幂等可以
 * 完全交给 Anytype：把归一化内容的哈希写成一个普通 text 属性，写入前
 * 先用 `filter: <key> = "<hash>"` 查一次，命中即返回既有对象。
 *
 *     content_hash = sha256(scope_id | kind | normalize(content))
 *
 * 归一化 = trim + 折叠连续空白 + Unicode NFC。三步的理由：
 * - trim：首尾空白无信息量；
 * - 折叠空白：同一事实的不同排版（换行/缩进/多空格）应视为同一条；
 * - NFC：避免「é 的组合形式 vs 预组合形式」这类等价写法漏判。
 *
 * 大小写**不**归一：中文无大小写问题，英文大小写差异往往携带信息
 * （如 `JSON` 与 `json`），一律折叠会引入误判。
 */

import { createHash } from 'node:crypto';

/** 归一化记忆正文（trim + 折叠空白 + NFC）。 */
export function normalizeContent(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * 计算记忆的 content_hash。
 *
 * @param scopeId - 作用域标识（空间 id + 可选 scope 对象 id）。
 * @param kind - 记忆种类（不同种类不视为重复）。
 * @param content - 记忆正文（内部会归一化）。
 * @returns 十六进制 sha256。
 */
export function contentHash(
  scopeId: string,
  kind: string,
  content: string,
): string {
  const payload = `${scopeId}\n${kind}\n${normalizeContent(content)}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * 构造按 content_hash 精确查找的 filter 片段。
 *
 * @param propertyKey - 真实属性 key（bootstrap 读回，可能不等于 'content_hash'）。
 * @param hash - content_hash 值。
 * @returns filter 表达式片段（可直接拼进更大的 filter 串）。
 */
export function contentHashFilter(propertyKey: string, hash: string): string {
  return `${propertyKey} = "${hash.replace(/"/g, '\\"')}"`;
}

/** 冲突候选（写前读返回给 agent 裁决）。 */
export interface ConflictCandidate {
  /** 候选记忆对象 id。 */
  objectId: string;
  /** 记忆种类。 */
  kind: string;
  /** 状态。 */
  status: string;
  /** 有效期起点。 */
  validFrom?: string;
  /** 正文摘要（供 agent 判断是否重复/矛盾）。 */
  excerpt: string;
}

/** 冲突候选过滤：只保留状态为「仍有效」的候选（archived/superseded 不必再裁决）。 */
export function liveConflicts(
  candidates: readonly ConflictCandidate[],
): ConflictCandidate[] {
  return candidates.filter(
    (c) => c.status !== 'archived' && c.status !== 'superseded',
  );
}
