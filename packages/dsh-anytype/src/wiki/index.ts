/**
 * 笔记域的公开 API（**不含插件契约**）。
 *
 * 插件契约（`name` / `apply` / `inject` / `Config`）在
 * `src/entries/wiki.ts`——它是 bundle 包里的第三个插件行。这里只导出
 * **领域能力**（schema、存储、纯函数、工具构建），供：
 * - 包根 barrel 汇总对外 API；
 * - 单元测试按需取用。
 */

export { resolveConfig as resolveWikiConfig } from './config.ts';
export type {
  ResolvedConfig as ResolvedWikiConfig,
  ToolGroup as WikiToolGroup,
} from './config.ts';
export {
  DEFAULT_SPACE_NAME as DEFAULT_WIKI_SPACE_NAME,
  TOOL_GROUPS as WIKI_TOOL_GROUPS,
} from './config.ts';
export { buildTools as buildWikiTools } from './tools/index.ts';
export { buildGroupedTools as buildWikiGroupedTools } from './tools/index.ts';
export { WikiStore } from './store.ts';
export type {
  PropertySummary as WikiPropertySummary,
  SchemaSetupResult as WikiSchemaSetupResult,
  SearchRow as WikiSearchRow,
  TypeSummary as WikiTypeSummary,
  WikiNoteUpdateInput,
  WikiNoteUpdateReceipt,
  WikiNoteWriteInput,
  WikiReviewInput,
  WikiSearchParams,
  WikiSearchResult,
  WikiWriteReceipt,
} from './store.ts';
export {
  planWikiBootstrap,
  resolveWikiPropertyKeys,
  REVIEW_DECISION_TO_STATUS,
  REVIEW_DECISIONS as WIKI_REVIEW_DECISIONS,
  WIKI_PROPERTIES,
  WIKI_PROPERTY_KEY,
  WIKI_STATUSES,
  WIKI_TYPE_KEY,
  WIKI_TYPE_SPEC,
} from './schema.ts';
export type {
  PropertyFormat,
  PropertySpec,
  ReviewDecision,
  TypeSpec as WikiTypeSpec,
  WikiBootstrapPlan,
  WikiStatus,
} from './schema.ts';
export { propertyKey as wikiPropertyKey } from './tools/shared.ts';
export type { WikiToolDeps } from './tools/shared.ts';
