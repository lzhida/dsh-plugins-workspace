/**
 * 确定性文本切块（纯函数，零 LLM）。
 *
 * 用途：把一段会话/文档切成**候选记忆片段**，交给 agent 用自己的 LLM
 * 蒸馏成原子事实。插件只负责「切」——**不做抽取、不做判断、不跑模型**。
 *
 * 切块规则（为什么这么切）：
 * - **先按段落聚合**：语义边界优先，段落是作者/说话人自己划出的边界；
 * - **超长段落再按句子切**：中英文标点都认，避免把一句话劈成两半；
 * - **尾部碎片并回上一块**：孤立的几十个字对 LLM 抽取没有价值，反而制造
 *   噪声候选；
 * - **相邻块保留 10% 重叠**：一句话被切在边界上时，重叠保证语义完整。
 *
 * 默认参数：目标 400 字、硬上限 800 字、重叠 10%（40 字）。
 */

/** 切块参数。 */
export interface ChunkOptions {
  /** 目标块长度（字符）。 */
  targetChars?: number;
  /** 单块硬上限（字符）。 */
  maxChars?: number;
  /** 相邻块重叠（字符）。 */
  overlapChars?: number;
  /** 小于该长度的尾块并回上一块。 */
  minTailChars?: number;
}

/** 切块结果（类型别名：工具输出需要隐式索引签名）。 */
export type Chunk = {
  /** 块序号（0 起）。 */
  index: number;
  /** 块文本。 */
  text: string;
};

/** 默认目标块长度。 */
export const DEFAULT_TARGET_CHARS = 400;

/** 默认单块硬上限。 */
export const DEFAULT_MAX_CHARS = 800;

/** 默认尾块并回阈值。 */
export const DEFAULT_MIN_TAIL_CHARS = 50;

/** 句子终止符（中英文）。 */
const SENTENCE_END = /[。！？；.!?;\n]/;

/**
 * 把文本切成候选片段。
 *
 * @param text - 原始文本。
 * @param options - 切块参数。
 * @returns 块数组（按顺序）。
 */
export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetChars ?? DEFAULT_TARGET_CHARS;
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = options.overlapChars ?? Math.floor(target * 0.1);
  const minTail = options.minTailChars ?? DEFAULT_MIN_TAIL_CHARS;

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // 超长段落 → 按句子拆；仍超长 → 硬切。
  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= max) {
      pieces.push(paragraph);
      continue;
    }
    let buffer = '';
    for (const sentence of splitSentences(paragraph)) {
      if (buffer.length + sentence.length > max && buffer.length > 0) {
        pieces.push(buffer.trim());
        buffer = '';
      }
      if (sentence.length > max) {
        for (let i = 0; i < sentence.length; i += max) {
          pieces.push(sentence.slice(i, i + max));
        }
        continue;
      }
      buffer += sentence;
    }
    if (buffer.trim().length > 0) pieces.push(buffer.trim());
  }

  // 聚合到目标长度。
  const blocks: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    if (buffer.length > 0 && buffer.length + piece.length + 1 > target) {
      blocks.push(buffer.trim());
      const tail = overlap > 0 ? buffer.slice(-overlap).trim() : '';
      buffer = tail.length > 0 ? `${tail}\n${piece}` : piece;
    } else {
      buffer = buffer.length > 0 ? `${buffer}\n${piece}` : piece;
    }
  }
  if (buffer.trim().length > 0) blocks.push(buffer.trim());

  // 尾块过小 → 并回上一块。
  if (blocks.length >= 2) {
    const last = blocks[blocks.length - 1];
    if (last.length < minTail) {
      blocks[blocks.length - 2] = `${blocks[blocks.length - 2]}\n${last}`;
      blocks.pop();
    }
  }

  return blocks.map((b, index) => ({ index, text: b }));
}

/**
 * 按句子边界切分（保留标点）。
 *
 * @param text - 文本。
 * @returns 句子数组。
 */
function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (SENTENCE_END.test(ch)) {
      sentences.push(current);
      current = '';
    }
  }
  if (current.length > 0) sentences.push(current);
  return sentences;
}

/**
 * 从文本里抽取用于全文检索的关键词（词元）。
 *
 * 英文按空格切词；中文**短串整体保留**（≤4 字，如「持久记忆」——它本身
 * 就是完整词，比切碎更好用），长串才退化为 2-gram（避免超长无空格文本
 * 变成不可用的整句查询）。
 *
 * 目的是给 Anytype 的全文搜索一个「像查询的查询」，而不是做语义检索
 * （语义由向量臂负责）。
 *
 * @param text - 文本。
 * @param limit - 最多返回多少个词元。
 * @returns 词元数组（去重、保序）。
 */
export function queryTerms(text: string, limit = 12): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const push = (term: string): void => {
    const t = term.trim();
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    terms.push(t);
  };

  const latin = text.match(/[A-Za-z0-9_][A-Za-z0-9_-]{1,}/g) ?? [];
  for (const word of latin) push(word.toLowerCase());

  const cjk = text.replace(/[^\u3400-\u9fff]+/g, ' ');
  for (const run of cjk.split(/\s+/)) {
    if (run.length < 2) continue;
    if (run.length <= 4) {
      push(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length && terms.length < limit; i += 1) {
      push(run.slice(i, i + 2));
    }
  }
  return terms.slice(0, limit);
}
