/**
 * `@zhidal/dsh-decision` —— 决策域通用组合包。
 *
 * ## 包结构
 *
 * 决策域按「决策点」切插件行，每个决策点一个入口文件，命名 `<决策点>-gate`：
 *
 * - `src/entries/ask-gate.ts` = 插件行 **ask-gate**：接管模型侧提问工具
 *   `ask_user_question`（总开关关闭＝直通原版提问；开启＝先问决策模型，
 *   置信度达标自动作答并落账 meta，否则 fail-open 放行真实提问）。
 * - `src/entries/decision-tools.ts` = 插件行 **decision-tools**（决策工具
 *   系列 2/11 起落地、3/11 起注册工具）：fail-closed 的 decision_* 工具族 + systemone HTTP
 *   client + 统一调用层（记账/预算/兜底挂点）；已注册
 *   `decision_decide` / `decision_gate` / `decision_rerank` / `decision_batch` /
 *   `decision_locate` / `decision_usage`（5/11）/ `decision_history` /
 *   `decision_recheck`（8/11）/ `decision_calibrate` / `decision_arbiter`
 *   （10/11，共 10 个）；本行未配置或
 *   未验证决策模型时显式报错。
 * - `src/core/` = 与具体决策点无关的共用件：配置面（`config.ts`）、
 *   决策 core（`decision.ts`：调用封装 / 响应解析 / 阈值判定）与宿主
 *   `userQuestions` 的本地最小类型面（`user-questions.ts`）。
 * - `src/config/` = decision-tools 行的配置面（33 字段，契约 §6）；
 * - `src/systemone/` = systemone 决策接口 HTTP client（契约 §2）；
 * - `src/runtime/` = 统一调用层：守卫 / decisionId / 账本（内存 + JSONL 文件落盘）/
 *   预算闸（直通 + 日窗口真实闸）/ 兜底挂点（契约 §8）；
 * - `src/tools/` = 决策工具本体（decide/gate 由 3/11、rerank/batch 由 4/11、
 *   locate/usage 由 5/11、history/recheck 由 8/11、calibrate/arbiter 由 10/11
 *   落地，其余卡继续追加）；
 * - `src/services/` = 决策点的执行层（ask-gate 的直通提问与门控决策辅助
 *   在 `services/ask-gate.ts`，decision-tools 的运行时组装在
 *   `services/decision-tools.ts`）。
 *
 * ## 插件契约导出
 *
 * loader 依赖三符号：`name` / `apply` / `inject`；`Config` 经 re-export
 * 让宿主设置面板渲染本插件的可编辑字段（不 re-export 会整块丢弃）。
 */

export {
  apply,
  ASK_USER_QUESTION_DESCRIPTION,
  ASK_USER_QUESTION_OUTPUT,
  ASK_USER_QUESTION_PARAMETERS,
  ASK_USER_QUESTION_TOOL,
  inject,
  name,
} from './entries/ask-gate.ts';

// decision-tools 行（命名重导出避免与 ask-gate 的三符号冲突）。
export {
  apply as decisionToolsApply,
  inject as decisionToolsInject,
  name as decisionToolsName,
  createDecisionToolsRuntime,
} from './entries/decision-tools.ts';

export { Config, resolveConfig } from './core/config.ts';
export type { ResolvedConfig, SchemaDescription } from './core/config.ts';

export {
  Config as DecisionToolsConfig,
  DECISION_TOOL_NAMES,
  DECISION_TOOL_PREFIX,
  resolveToolsConfig,
} from './config/index.ts';
export type { ResolvedToolsConfig } from './config/index.ts';
export { callSystemOne, verifySystemOne } from './systemone/index.ts';
export type { SystemOneCallResult, VerifyResult } from './systemone/index.ts';
export { runDecisionCall } from './runtime/index.ts';
export type { DecisionCallResult } from './runtime/index.ts';

export {
  DECIDE_TOOL,
  GATE_TOOL,
  RERANK_TOOL,
  BATCH_TOOL,
  LOCATE_TOOL,
  USAGE_TOOL,
  HISTORY_TOOL,
  RECHECK_TOOL,
  CALIBRATE_TOOL,
  ARBITER_TOOL,
  createDecideTool,
  createGateTool,
  createRerankTool,
  createBatchTool,
  createLocateTool,
  createUsageTool,
  createHistoryTool,
  createRecheckTool,
  createCalibrateTool,
  createArbiterTool,
} from './tools/index.ts';
export {
  planDecide,
  buildDecideState,
  estimateDecidePromptTokens,
  mapAnswerToDecideAnswer,
  aggregateAnswers,
  computeAgreement,
  runDecide,
} from './tools/index.ts';
export {
  planGate,
  buildGateQuestions,
  buildGateState,
  decideVerdict,
  runGate,
} from './tools/index.ts';
export {
  planRerank,
  compositeScore,
  rankCandidates,
  runRerank,
} from './tools/index.ts';
export { planBatch, mapBounded, runBatch } from './tools/index.ts';
export {
  planLocate,
  parseLocateBox,
  deriveBoxGeometry,
  runLocate,
} from './tools/index.ts';
export {
  planUsage,
  aggregateUsage,
  computeBurnRate,
  percentileNearestRank,
  runUsage,
  USAGE_WINDOW_VALUES,
} from './tools/index.ts';
export {
  planHistory,
  filterHistoryEntries,
  runHistory,
} from './tools/index.ts';
export {
  planRecheck,
  buildRecheckQuestion,
  buildRecheckState,
  computeDrift,
  runRecheck,
} from './tools/index.ts';
export {
  planCalibrate,
  collectCalibrateEntries,
  computeCalibrateMetrics,
  buildCalibrateBuckets,
  runCalibrate,
  CALIBRATE_WINDOWS,
} from './tools/index.ts';
export {
  planArbiter,
  buildArbiterQuestionFromEntry,
  buildArbiterQuestionFromPlan,
  mapArbiterVerdict,
  computeArbiterDisagreement,
  runArbiter,
} from './tools/index.ts';
export {
  buildJudgementPrompt,
  estimatePromptTokens,
  stringifyDetail,
} from './tools/index.ts';
export type {
  DecideAnswer,
  AggregatedAnswer,
  DecidePlan,
  GateDecision,
  GatePlan,
  GateVerdict,
  RerankOutput,
  RerankPlan,
  BatchOutput,
  BatchPlan,
  LocateOutput,
  LocatePlan,
  UsageOutput,
  UsagePlan,
  UsageMetrics,
  HistoryOutput,
  HistoryEntryView,
  HistoryPlan,
  RecheckOutput,
  RecheckPlan,
  DriftKind,
  DriftResult,
  CalibrateOutput,
  CalibratePlan,
  CalibrateMetrics,
  CalibrateBucket,
  CalibrateSample,
  CalibrateExcluded,
  CalibrateOverconfidence,
  CalibrateWindow,
  ArbiterOutput,
  ArbiterPlan,
  ArbiterVerdict,
  ArbiterQuestionPlan,
  ArbiterQuestionType,
  ArbiterOriginal,
} from './tools/index.ts';

export type {
  UserQuestionAnswer,
  UserQuestionAnswerItem,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionRequestItem,
  UserQuestionsLike,
} from './core/user-questions.ts';

export {
  askThroughUserQuestions,
  toAskGateAnswerItem,
  toUserQuestionItem,
} from './services/ask-gate.ts';
export type {
  AskGateAnswer,
  AskGateAnswerItem,
  AskGateOption,
  AskGateQuestion,
} from './services/ask-gate.ts';
