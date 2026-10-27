/**
 * 记忆域的公开 API（**不含插件契约**）。
 *
 * 插件契约（`name` / `apply` / `inject` / `Config`）在
 * `src/entries/memory.ts`——它是 bundle 包里的第二个插件行。这里只导出
 * **领域能力**（schema、存储、纯函数、工具构建），供：
 * - 包根 barrel 汇总对外 API；
 * - 将来同包内的第三个插件行（如 `entries/wiki.ts`）直接复用；
 * - 单元测试按需取用。
 */

export { resolveConfig as resolveMemoryConfig } from './config.ts';
export type {
  ResolvedConfig as ResolvedMemoryConfig,
  ToolGroup as MemoryToolGroup,
} from './config.ts';
export {
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_TOKENS,
  DEFAULT_SPACE_NAME,
  TOOL_GROUPS as MEMORY_TOOL_GROUPS,
} from './config.ts';
export { buildTools as buildMemoryTools } from './tools/index.ts';
export { buildGroupedTools as buildMemoryGroupedTools } from './tools/index.ts';
export { MemoryStore } from './store.ts';
export type {
  MemorySearchParams,
  MemorySearchResult,
  MemoryWriteInput,
  MemoryWriteReceipt,
  SchemaSetupResult,
} from './store.ts';
export {
  EDGE_RELATIONS,
  MEMORY_KINDS,
  MEMORY_PROPERTIES,
  MEMORY_PROPERTY_KEY,
  MEMORY_STATUSES,
  MEMORY_TYPE_KEY,
  SCOPE_PROPERTIES,
  SCOPE_TYPE_KEY,
  SOURCE_CHANNELS,
} from './schema.ts';
export type { MemoryKind, MemoryStatus, EdgeRelation } from './schema.ts';
export { contentHash, normalizeContent } from './dedup.ts';
export {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  validateVector,
} from './embedding.ts';
export {
  applyTokenBudget,
  estimateTokens,
  fuseCandidates,
  rrfScore,
} from './recall.ts';
export { chunkText, queryTerms } from './chunk.ts';
export { propertyKey } from './tools/shared.ts';
export type { MemoryToolDeps } from './tools/shared.ts';
