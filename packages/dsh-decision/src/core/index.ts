/**
 * dsh-decision 核心层：配置面、决策底座与宿主类型面。
 *
 * 核心层只放「与具体决策点无关」的共用件：
 * - `config.ts`：配置 schema（volatile 字段 + 中英描述）；
 * - `decision.ts`：决策底座三件套（模型调用封装 / 置信度解析 /
 *   阈值判定），全部 fail-open，决策模型任何故障都不向调用方抛穿；
 * - `user-questions.ts`：宿主 `ctx.userQuestions` 的本地最小类型面。
 */

export {
  Config,
  desc,
  isVolatileLike,
  resolveConfig,
  setDescription,
  unwrapVolatile,
  volatileField,
} from './config.ts';
export type { ResolvedConfig, SchemaDescription } from './config.ts';

export {
  DECISION_MAX_TOKENS,
  buildDecisionStreamOptions,
  decide,
  decideByThreshold,
  parseDecisionResponse,
  runDecisionCall,
} from './decision.ts';
export type {
  DecisionCallInput,
  DecisionCallOptions,
  DecisionLlmLike,
  DecisionOutcome,
  DecisionParseResult,
  DecisionReport,
  DecisionThresholdResult,
  DecisionVerdict,
} from './decision.ts';

export type {
  UserQuestionAnswer,
  UserQuestionAnswerItem,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionRequestItem,
  UserQuestionsLike,
} from './user-questions.ts';
