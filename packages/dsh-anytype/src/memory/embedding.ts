/**
 * 向量承载与相似度（纯函数）。
 *
 * ## 谁算向量
 *
 * **外部 agent 算，插件只搬运**。插件不内置任何嵌入模型、不持有模型
 * API Key、不发起任何非 localhost 请求——这是「纯本地 anytype 持久记忆」
 * 方案的核心约束之一。
 *
 * ## 存在哪
 *
 * Anytype 桌面端 API **没有向量检索、也没有向量存储**（活体实测确认）。
 * 本版选择把向量作为**记忆对象的一个 text 属性**（`embedding`）承载：
 * base64(Float32Array)，768 维 ≈ 3072 B ≈ 4.1 KB 文本。代价与降级链
 * 见 `docs/06-llm-vector-delegation.md`。
 *
 * ## 模型/维度绑定
 *
 * 不同模型的向量处在不同向量空间，混算会产出「看起来有分数、实则无意义」
 * 的结果——这类错误不会报错，只会静默降低召回质量。故向量与
 * `embedding_model` + `embedding_dim` 绑定，不匹配即剔除并告警。
 */

import { Buffer } from 'node:buffer';

/** 向量编码后的最大字节数（768 维 float32 = 3072 B）。 */
export const MAX_VECTOR_DIM = 4096;

/** 向量校验结果。 */
export interface VectorValidation {
  /** 是否合法。 */
  ok: boolean;
  /** 维度（非有限值时为 0）。 */
  dim: number;
  /** 不合法原因（合法时为 undefined）。 */
  error?: string;
}

/**
 * 校验外部 agent 提供的向量。
 *
 * @param vector - 数值数组。
 * @returns 校验结果（维度、错误原因）。
 */
export function validateVector(vector: unknown): VectorValidation {
  if (!Array.isArray(vector)) {
    return { ok: false, dim: 0, error: 'vector must be an array of numbers' };
  }
  if (vector.length === 0) {
    return { ok: false, dim: 0, error: 'vector must not be empty' };
  }
  if (vector.length > MAX_VECTOR_DIM) {
    return {
      ok: false,
      dim: vector.length,
      error: `vector dimension ${vector.length} exceeds the supported maximum ${MAX_VECTOR_DIM}`,
    };
  }
  for (const v of vector) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return {
        ok: false,
        dim: vector.length,
        error: 'vector must contain only finite numbers',
      };
    }
  }
  return { ok: true, dim: vector.length };
}

/**
 * 把向量编码为 base64(Float32Array)（小端）。
 *
 * @param vector - 数值数组。
 * @returns base64 文本（可直接写入 Anytype text 属性）。
 */
export function encodeVector(vector: readonly number[]): string {
  const floats = Float32Array.from(vector);
  return Buffer.from(
    floats.buffer,
    floats.byteOffset,
    floats.byteLength,
  ).toString('base64');
}

/**
 * 解码 base64(Float32Array) 向量。
 *
 * @param encoded - base64 文本。
 * @returns 数值数组；非法输入返回 null（不抛错——脏数据不应炸掉召回）。
 */
export function decodeVector(encoded: unknown): number[] | null {
  if (typeof encoded !== 'string' || encoded.length === 0) return null;
  try {
    const buf = Buffer.from(encoded, 'base64');
    if (buf.byteLength === 0 || buf.byteLength % 4 !== 0) return null;
    const floats = new Float32Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    );
    return Array.from(floats);
  } catch {
    return null;
  }
}

/**
 * 余弦相似度。
 *
 * @param a - 向量 a。
 * @param b - 向量 b。
 * @returns 相似度 ∈ [-1, 1]；维度不符或零向量返回 0。
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
