/**
 * systemone 目录 barrel（决策工具系列 2/11）。
 *
 * 下游只从 `../systemone/index.ts` 导入，不深引内部文件——
 * 8/11 真实活体 e2e 与 6/11 设置页都走这个面。
 */

export {
  IMAGES_DANGER_HEADER,
  MAX_QUESTIONS_PER_CALL,
  SYSTEMONE_ENDPOINT_PATH,
  buildSystemOneEndpoint,
  buildSystemOneHeaders,
  callSystemOne,
  verifySystemOne,
} from './client.ts';
export type {
  FetchLike,
  SystemOneCallOptions,
  SystemOneHttpConfig,
  VerifyResult,
} from './client.ts';
export {
  DECISION_ERROR_CODES,
  decisionError,
  failure,
  isDecisionErrorCode,
} from './errors.ts';
export type {
  DecisionErrorEnvelope,
  DecisionErrorCode,
  DecisionFailure,
} from './errors.ts';
export type {
  JsonValue,
  SystemOneAsset,
  SystemOneCallResult,
  SystemOneInvalidAnswer,
  SystemOneNormalizedUsage,
  SystemOneParsedAnswer,
  SystemOneQuestion,
  SystemOneQuestionType,
} from './types.ts';
