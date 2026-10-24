/**
 * 召回融合：RRF + 乘性 boost + token 预算（纯函数）。
 *
 * ## 为什么是 RRF 而不是加权分数
 *
 * Anytype 的全文搜索**只返回有序结果、没有相关度分数**。但 RRF（Reciprocal
 * Rank Fusion）本来就只用**名次**不用分数：
 *
 *     score(d) = Σ_arm 1 / (k + rank_arm(d)),  k = 60
 *
 * 名次天然可比、量纲一致，不需要把「Anytype 的相关性」与「余弦相似度」
 * 硬拉到同一尺度上——这是多臂融合里最省事也最稳的做法。
 *
 * ## 为什么次级信号是乘性的
 *
 * recency（新鲜度）、confidence（置信）、proof（佐证）都是**旁证**而非
 * 相关性本身。乘性加权保证：主相关性低的候选不会被高置信度抬上来；
 * 加性加权则会让次要信号压过主信号（低相关 + 高置信 → 排在高相关之后
 * 的前面，正是加性的典型失效）。
 *
 *     final = relevance × recency^0.2 × confidence^0.2 × proof^0.1
 */

/** 召回臂。 */
export type RecallArm = 'lexical' | 'vector' | 'links';

/** RRF 常数 k（取 Hindsight 与 Graphiti 的共同取值 60）。 */
export const RRF_K = 60;

/** 参与融合的候选（各臂的结果已按 rank 归并到同一 objectId）。 */
export interface RecallCandidate {
  /** 记忆对象 id。 */
  objectId: string;
  /** 一行事实（对象 name）。 */
  name: string;
  /** 正文摘要。 */
  excerpt: string;
  /** 记忆种类。 */
  kind: string;
  /** 记忆状态。 */
  status: string;
  /** 写入方：agent / user。 */
  origin: string;
  /** 置信度 1-10。 */
  confidence?: number;
  /** 重要度 1-10。 */
  importance?: number;
  /** 佐证计数。 */
  proofCount?: number;
  /** 被召回次数（自度量，写回时用）。 */
  accessCount?: number;
  /** 写入时间（ISO）。 */
  createdAt?: string;
  /** 有效期起点（ISO）。 */
  validFrom?: string;
  /** 作用域对象 id。 */
  scopeId?: string;
  /** 来源对象 id。 */
  sourceId?: string;
  /** 内容哈希（幂等键，溯源用）。 */
  contentHash?: string;
  /** 更新时间（ISO）。 */
  updatedAt?: string;
  /** 各臂命中的名次（1-based）；未命中则缺省。 */
  ranks?: Partial<Record<RecallArm, number>>;
  /** 向量臂得分（0-1，缺失时按 0 处理）。 */
  vectorScore?: number;
}

/** 融合后的结果项。 */
export interface RecallItem extends RecallCandidate {
  /** 融合分（RRF × 乘性 boost）。 */
  score: number;
  /** RRF 原始分。 */
  rrf: number;
  /** 命中了哪些臂。 */
  armsHit: RecallArm[];
}

/** 召回调参。 */
export interface FusionOptions {
  /** 参与融合的臂（默认全部）。 */
  arms?: RecallArm[];
  /** 是否包含 draft 态（默认 true：agent 自己写的记忆自己也要能看见）。 */
  includeDraft?: boolean;
  /** 是否包含 disputed 态（默认 true）。 */
  includeDisputed?: boolean;
  /** 参与融合的时限（用于 recency 计算；缺省用当前时间）。 */
  now?: number;
  /** RRF 常数。 */
  k?: number;
}

/** 计算 RRF 融合分（只吃名次，不吃分数）。 */
export function rrfScore(
  ranks: Partial<Record<RecallArm, number>>,
  k: number = RRF_K,
): number {
  let sum = 0;
  for (const rank of Object.values(ranks)) {
    if (typeof rank !== 'number' || rank <= 0) continue;
    sum += 1 / (k + rank);
  }
  return sum;
}

/**
 * 新鲜度乘子：线性衰减到 0.1 下限。
 *
 * @param iso - 时间戳（ISO 字符串）。
 * @param now - 当前时间（毫秒）。
 * @returns ∈ [0.1, 1]。
 */
export function recencyBoost(iso: string | undefined, now: number): number {
  if (!iso) return 0.5;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0.5;
  const days = Math.max(0, (now - t) / 86_400_000);
  return Math.min(1, Math.max(0.1, 1 - days / 365));
}

/**
 * 归一化数值到 [0.1, 1] 的乘子（1-10 分制 → 0.1-1）。
 */
export function scaleBoost(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5;
  const clamped = Math.min(10, Math.max(1, value));
  return 0.1 + (clamped / 10) * 0.9;
}

/**
 * 佐证计数乘子（proof=0 → 0.5；≥3 → 1.0）。
 */
export function proofBoost(proofCount: number | undefined): number {
  if (typeof proofCount !== 'number' || !Number.isFinite(proofCount))
    return 0.5;
  if (proofCount <= 0) return 0.5;
  return Math.min(1, 0.5 + proofCount * 0.1667);
}

/**
 * 最终分：RRF × 乘性旁证。
 *
 * @param candidate - 候选。
 * @param options - 融合选项（now 用于 recency）。
 * @returns 最终分。
 */
export function finalScore(
  candidate: RecallCandidate,
  options: FusionOptions = {},
): { score: number; rrf: number } {
  const k = options.k ?? RRF_K;
  const now = options.now ?? Date.now();
  const rrf = rrfScore(candidate.ranks ?? {}, k);
  const recency = recencyBoost(candidate.createdAt, now);
  const confidence = scaleBoost(candidate.confidence);
  const proof = proofBoost(candidate.proofCount);
  return {
    score: rrf * recency ** 0.2 * confidence ** 0.2 * proof ** 0.1,
    rrf,
  };
}

/** 状态过滤：默认排除 archived / superseded。 */
export function isVisibleStatus(
  status: string,
  options: FusionOptions = {},
): boolean {
  if (status === 'archived' || status === 'superseded') return false;
  if (status === 'draft') return options.includeDraft !== false;
  if (status === 'disputed') return options.includeDisputed !== false;
  return true;
}

/**
 * 融合多臂结果。
 *
 * @param candidates - 已按 objectId 归并、每臂带 rank 的候选。
 * @param options - 融合选项。
 * @returns 按最终分降序排列的结果项。
 */
export function fuseCandidates(
  candidates: readonly RecallCandidate[],
  options: FusionOptions = {},
): RecallItem[] {
  const arms = options.arms ?? (['lexical', 'vector', 'links'] as RecallArm[]);
  const allowed = new Set<RecallArm>(arms);
  const items: RecallItem[] = [];
  for (const candidate of candidates) {
    if (!isVisibleStatus(candidate.status, options)) continue;
    const ranks: Partial<Record<RecallArm, number>> = {};
    for (const [arm, rank] of Object.entries(candidate.ranks ?? {})) {
      if (!allowed.has(arm as RecallArm)) continue;
      if (typeof rank === 'number' && rank > 0) {
        ranks[arm as RecallArm] = rank;
      }
    }
    // 所有臂都被排除该候选时，仅当向量臂有分也一并保留（纯向量召回场景）。
    if (Object.keys(ranks).length === 0 && !candidate.vectorScore) continue;
    const { score, rrf } = finalScore({ ...candidate, ranks }, options);
    items.push({
      ...candidate,
      ranks,
      score,
      rrf,
      armsHit: Object.keys(ranks) as RecallArm[],
    });
  }
  return items.sort((a, b) => b.score - a.score);
}

/**
 * 估算 token 数（CJK 每字约 1 token，ASCII 约 4 字符 1 token）。
 *
 * @param text - 文本。
 * @returns 估算 token 数。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else if (code < 128) {
      ascii += 1;
    } else {
      cjk += 1;
    }
  }
  return cjk + Math.ceil(ascii / 4);
}

/** token 预算截断结果。 */
export interface BudgetResult<T> {
  /** 放得下的条目。 */
  items: T[];
  /** 是否因预算截断。 */
  truncated: boolean;
  /** 因预算被丢弃的条目数。 */
  omittedCount: number;
}

/**
 * 按 token 预算截断结果（**只计正文**，元数据免费）。
 *
 * 装不下就跳过继续装（与 Hindsight 的预算策略一致）；最差情况至少保留
 * 第一条——宁可给一条，也不给空结果。
 *
 * @param items - 已排序条目。
 * @param maxTokens - 预算。
 * @param textOf - 取条目的计费文本（默认 excerpt）。
 * @returns 截断结果。
 */
export function applyTokenBudget<T>(
  items: readonly T[],
  maxTokens: number,
  textOf: (item: T) => string = (item) =>
    String((item as { excerpt?: string }).excerpt ?? ''),
): BudgetResult<T> {
  const kept: T[] = [];
  let used = 0;
  let omitted = 0;
  for (const item of items) {
    const cost = estimateTokens(textOf(item));
    if (kept.length > 0 && used + cost > maxTokens) {
      omitted += 1;
      continue;
    }
    kept.push(item);
    used += cost;
  }
  return { items: kept, truncated: omitted > 0, omittedCount: omitted };
}
