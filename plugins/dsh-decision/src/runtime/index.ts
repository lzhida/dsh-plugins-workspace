/**
 * runtime 目录 barrel（决策工具系列 2/11）。
 *
 * 工具层（3/11 起）只从这里导入统一调用层与守卫；
 * 账本持久化（5/11）与兜底裁判（7/11）替换实现时也走这个面。
 */

export {
  budgetExceeded,
  budgetWindow,
  createPassthroughBudgetGate,
  createWindowedBudgetGate,
  sumWindowUsage,
} from './budget.ts';
export type {
  BudgetCheckRequest,
  BudgetCheckResult,
  BudgetGate,
  BudgetWindow,
} from './budget.ts';
export {
  createNoopFallbackHook,
  runDecisionCall,
  runFallbackJudge,
  runLowConfidenceFallback,
} from './call.ts';
export type {
  DecisionCallDeps,
  DecisionCallOk,
  DecisionCallRequest,
  DecisionCallResult,
  FallbackAttemptResult,
  FallbackHook,
  FallbackJudgement,
  FallbackMeta,
  FallbackOutcome,
  FallbackTrigger,
  FallbackTriggerKind,
  LowConfidenceEvaluation,
  LowConfidenceFallbackResult,
} from './call.ts';
export {
  buildJudgePrompt,
  extractJudgeJson,
  judgeModeAllowed,
  judgeOnce,
  parseJudgeAnswers,
  resolveJudgeRoute,
} from './judge.ts';
export type {
  JudgeAnswer,
  JudgeDeps,
  JudgeMode,
  JudgeOutcome,
  JudgeQuestionType,
  JudgeRequest,
  JudgeResult,
  JudgeRoute,
  JudgeRouteOrigin,
  JudgeUsage,
} from './judge.ts';
export {
  AUTO_FALLBACK_TOOLS,
  createAutoFallbackHook,
  judgeAnswerToParsed,
  judgeRouteSummary,
} from './fallback.ts';
export type { AutoFallbackDeps } from './fallback.ts';
export {
  checkModelReady,
  checkToolEnabled,
  fingerprintOf,
  gateAllowThresholdOf,
  isModelConfigured,
} from './guard.ts';
export type { VerifySnapshot } from './guard.ts';
export { DECISION_ID_PATTERN, isValidDecisionId, newDecisionId } from './id.ts';
export {
  createMemoryLedger,
  estimateCostUsd,
  truncateSummary,
} from './ledger.ts';
export { createFileLedger, resolveLedgerPath } from './ledger-file.ts';
export type {
  CostEstimate,
  CostRates,
  LedgerEntry,
  LedgerMode,
  LedgerOutcome,
  LedgerPayload,
  LedgerSink,
  LedgerSource,
  LedgerUsage,
} from './ledger.ts';
