/**
 * CLI 版本解析与比较（纯函数，无副作用）。
 *
 * 独立成文件的原因：版本门控（`cli-hints.ts`）与版本探测（`tools/cli-status.ts`）
 * 必须共用同一套比较口径——版本号必须按**数值段**比较，
 * `0.10.0` 高于 `0.8.8`；字符串比较会得出相反结论（`'0.10.0' < '0.8.8'`）。
 */

/** 解析出的版本三元组（忽略预发布/构建后缀）。 */
export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * 从任意文本中提取语义化版本（如 `victauri 0.8.8` → 0.8.8）。
 *
 * @param text - 待解析文本；null/undefined 返回 null。
 * @returns 版本三元组；文本里没有 `x.y.z` 形态返回 null。
 */
export function parseVersion(
  text: string | null | undefined,
): ParsedVersion | null {
  if (typeof text !== 'string') return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (match === null) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * 比较两个版本号：a<b → -1，a===b → 0，a>b → 1。
 *
 * @returns 比较结果；任一侧不可解析返回 null（调用方按「未知」处理）。
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return null;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return 0;
}

/**
 * version 是否 ≥ min。
 *
 * 版本未知/不可解析一律 false——门控提示宁可不给，也不外推。
 */
export function isAtLeast(
  version: string | null | undefined,
  min: string,
): boolean {
  const cmp = compareVersions(version, min);
  return cmp !== null && cmp >= 0;
}

/**
 * version 是否 < max（用于「旧版本才有/旧版本没有」的门控）。
 *
 * 版本未知/不可解析一律 false——门控提示宁可不给，也不外推。
 */
export function isBelow(
  version: string | null | undefined,
  max: string,
): boolean {
  const cmp = compareVersions(version, max);
  return cmp !== null && cmp < 0;
}
