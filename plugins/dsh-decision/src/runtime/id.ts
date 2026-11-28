/**
 * decisionId 生成与校验（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §5.2。
 * 格式：`dec_` + 26 位 Crockford Base32（ULID 同构）——前 10 位是毫秒
 * 时间戳（48 bit，有序），后 16 位是 80 bit 随机数。
 * 正则：`^dec_[0-9A-HJKMNP-TV-Z]{26}$`（不含 I、L、O、U）。
 */

import { randomBytes } from 'node:crypto';

export const DECISION_ID_PATTERN = /^dec_[0-9A-HJKMNP-TV-Z]{26}$/;

/** Crockford Base32 字母表（去掉 I、L、O、U）。 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const BASE = 32;

/** 生成一个新 decisionId（时间前缀有序，随机后缀唯一）。 */
export function newDecisionId(now: number = Date.now()): string {
  let time = Math.max(0, Math.floor(now));
  let timePart = '';
  for (let i = 0; i < TIME_CHARS; i += 1) {
    timePart = CROCKFORD[time % BASE] + timePart;
    time = Math.floor(time / BASE);
  }
  const bytes = randomBytes(RANDOM_CHARS);
  let randomPart = '';
  for (let i = 0; i < RANDOM_CHARS; i += 1) {
    randomPart += CROCKFORD[bytes[i] % BASE];
  }
  return `dec_${timePart}${randomPart}`;
}

/** 校验 decisionId 格式（recheck/history 入口先过这一关再查账本）。 */
export function isValidDecisionId(value: unknown): boolean {
  return typeof value === 'string' && DECISION_ID_PATTERN.test(value);
}
