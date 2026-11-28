/**
 * 决策工具错误码闭集与返回信封（决策工具系列 2/11）。
 *
 * 契约来源：docs/decision-tools-contract.md §1.1（返回信封）与 §4（错误码表）。
 *
 * 硬规则：
 * - 错误码是**闭集**，实现不得新增未登记的码（§4 规则）。
 * - 工具失败返回 `{ ok:false, error }`，**不抛异常**（抛异常会被宿主包装、
 *   丢失错误码）。
 * - `error.message` 是可执行的中文短句（≤200 字符）。
 * - `error.details` 不得包含 apiKey。
 */

import type { JsonValue } from './types.ts';

/** §4 错误码闭集（16 条，顺序与契约一致）。 */
export const DECISION_ERROR_CODES = [
  'tool-disabled',
  'model-not-configured',
  'model-verify-failed',
  'model-call-failed',
  'model-timeout',
  'model-invalid-response',
  'model-unsupported-capability',
  'budget-exceeded',
  'invalid-arguments',
  'decision-not-found',
  'decision-id-invalid',
  'batch-item-failed',
  'sample-insufficient',
  'outcome-not-backfilled',
  'arbiter-unavailable',
  'fallback-disabled',
] as const;

export type DecisionErrorCode = (typeof DECISION_ERROR_CODES)[number];

export function isDecisionErrorCode(
  value: unknown,
): value is DecisionErrorCode {
  return (
    typeof value === 'string' &&
    (DECISION_ERROR_CODES as readonly string[]).includes(value)
  );
}

/** 契约 §1.1 失败信封。 */
export interface DecisionErrorEnvelope {
  code: DecisionErrorCode;
  message: string;
  retryable: boolean;
  details: Record<string, JsonValue>;
}

/** 各错误码的默认 retryable（契约 §4 第三列）。 */
const RETRYABLE_BY_CODE: Record<DecisionErrorCode, boolean> = {
  'tool-disabled': false,
  'model-not-configured': false,
  'model-verify-failed': true,
  'model-call-failed': true,
  'model-timeout': true,
  'model-invalid-response': true,
  'model-unsupported-capability': false,
  'budget-exceeded': false,
  'invalid-arguments': false,
  'decision-not-found': false,
  'decision-id-invalid': false,
  'batch-item-failed': true,
  'sample-insufficient': false,
  'outcome-not-backfilled': false,
  'arbiter-unavailable': true,
  'fallback-disabled': false,
};

export interface DecisionErrorOptions {
  /** 覆盖默认 retryable。 */
  retryable?: boolean;
  /** 结构化补充（HTTP 状态码、失败行索引等）；不得含 apiKey。 */
  details?: Record<string, JsonValue>;
}

/**
 * 构造失败信封。message 由调用方给出可执行中文短句，
 * 这里只做长度保护（超长截断，保证 ≤200 字符）。
 */
export function decisionError(
  code: DecisionErrorCode,
  message: string,
  options: DecisionErrorOptions = {},
): DecisionErrorEnvelope {
  const raw = message.trim() || code;
  const text = raw.length > 200 ? `${raw.slice(0, 197)}…` : raw;
  return {
    code,
    message: text,
    retryable: options.retryable ?? RETRYABLE_BY_CODE[code],
    details: options.details ?? {},
  };
}

/** 失败信封 → 工具失败返回体（与成功信封互斥，见 §1.1）。 */
export interface DecisionFailure {
  ok: false;
  error: DecisionErrorEnvelope;
}

export function failure(error: DecisionErrorEnvelope): DecisionFailure {
  return { ok: false, error };
}
