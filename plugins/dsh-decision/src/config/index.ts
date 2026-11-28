/**
 * config 目录 barrel：决策工具行的配置面（决策工具系列 2/11）。
 *
 * ask-gate 用 core/config.ts；本行配置字段更多（33 项）且语义不同
 * （fail-closed），因此独立目录，两行互不影响。
 */

export {
  DECISION_TOOL_NAMES,
  DECISION_TOOL_PREFIX,
  TOOL_SWITCH_KEYS,
  DEFAULT_BUDGET_MAX_CALLS_PER_DAY,
  DEFAULT_BUDGET_MAX_COST_USD_PER_DAY,
  DEFAULT_BUDGET_MAX_TOKENS_PER_DAY,
  DEFAULT_BUDGET_RESET_HOUR_UTC,
  DEFAULT_COST_PER_1K_TOKENS,
  DEFAULT_FALLBACK_MAX_CALLS_PER_DAY,
  DEFAULT_FALLBACK_MIN_CONFIDENCE,
  DEFAULT_FALLBACK_MODE,
  DEFAULT_FALLBACK_TIMEOUT_MS,
  DEFAULT_GATE_ALLOW_THRESHOLD,
  DEFAULT_LEDGER_MAX_ENTRIES,
  DEFAULT_SYSTEMONE_TIMEOUT_MS,
  FALLBACK_MODES,
  LOCAL_ONLY_TOOLS,
  Config,
  normalizeBaseUrl,
  resolveToolsConfig,
  toolSwitchOf,
} from './decision-tools.ts';
export type {
  DecisionToolName,
  FallbackMode,
  ResolvedToolsConfig,
} from './decision-tools.ts';
