/**
 * dsh-anytype-memory 插件入口。
 *
 * 职责：
 * - 导出 loader 依赖的 name / apply / inject 与设置面板契约 Config；
 * - apply() 内：
 *   1. 打印 `[dsh-anytype-memory] plugin loaded`（e2e 装载契约）；
 *   2. 注册 system-prompt 使用指引 section（工具正确组合的说明书：
 *      先 setup、写前读、向量自算、审核边界）；
 *   3. 按 `enabled` 与 `disabledGroups` 经 `ctx.tools.register` 注册工具，
 *      disposer 自动随插件卸载注销。
 *
 * 配置全部是 volatile 字段（设置面板可编辑、保存即生效）：
 * - apiKey/baseUrl/超时/截断/召回预算等由 client 在每次请求前现读——面板里
 *   改完 key 无需重载插件，下一次工具调用即用新值；
 * - `enabled` / `disabledGroups` 影响的是「注册哪些工具」，属于装载期
 *   决策，改动后需重载插件（宿主 HMR / 重启）才生效。
 *
 * **零本地状态**：本插件不写任何本地文件——记忆正文、属性、关系与向量全部
 * 落在 Anytype 对象内；检索走 Anytype 自身的 search/filter/sorts/fields。
 *
 * 依赖注入：`tools`（注册工具）+ `systemPrompt`（注册指引 section）。
 * 二者都由 dsh web/base bundle 提供；缺失时插件停在 PENDING（cordis 语义）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

import { resolveConfig } from './config.ts';
import { buildTools } from './tools/index.ts';

/** Cordis 插件名（loader 依赖）；与包名 kebab 段一致。 */
export const name = 'dsh-anytype-memory';

/** 依赖注入：工具注册表 + system-prompt。 */
export const inject: string[] = ['tools', 'systemPrompt'];

/** 指引 section 名（包名空间防撞）。 */
export const SECTION_NAME = 'tool:dsh-anytype-memory';

/** section order：工具使用指引档位（PLUGIN 类，与宿主各 section 同档）。 */
export const SECTION_ORDER = 2970;

/** 构造 agent 使用指引 section（纯函数，测试直连）。 */
export function memoryGuidanceSection(enabled: boolean): PromptSection {
  const text = enabled
    ? `Anytype persistent memory tools (memory_*) are available. They store agent memory INSIDE a designated Anytype space: every memory is an Anytype object with typed properties (kind, status, confidence, content_hash) and controlled edges (relates_to, derived_from, contradicts, supersedes, mentions). The plugin keeps no local files and runs no model.

## How to use them

- **Set up once**: memory_setup is idempotent — it resolves or creates the memory space, creates the "memory" type with its field list, and attaches missing properties. Run it before the first memory_write.
- **Write, but read first**: memory_write deduplicates by content hash and searches for nearby memories; it returns conflicts[] for YOU to adjudicate (merge / supersede / create). It never overwrites stored text and never lowers confidence. Writes land as draft for human review.
- **Recall**: memory_recall fuses three arms — lexical (Anytype full-text), vector (cosine over embeddings you computed and stored via memory_set_embedding) and relations (controlled edges) — with RRF plus recency/confidence/proof weighting, then truncates to a token budget. Pass query_vector AND embedding_model to enable the vector arm; vectors from different models are never mixed.
- **You own the models**: the plugin never calls an LLM or an embedding model. Use memory_candidates for zero-LLM chunking plus nearby memories, do the extraction and merge decisions yourself, and store vectors with memory_set_embedding.
- **Keep the context small**: recall returns excerpts and ids, never the whole library; open one memory with memory_get.
- **Search is eventually consistent**: Anytype's full-text index lags a few seconds behind writes (measured ~3-6s, sometimes longer). A recall issued right after a write can legitimately return nothing — retry once after a few seconds, or use memory_list (structural) to confirm the memory exists. memory_doctor runs a self-test that reports whether Chinese keyword recall is reliable on the current build.
- **Human control**: memories you write are draft until a human approves (memory_review) or edits them in Anytype. Use memory_review only when the user explicitly asks. The plugin never invalidates a human-written memory (origin=user) on its own.
- **Errors are actionable**: a connection error usually means the Anytype desktop app is not running; API errors carry status, code and hints.`
    : `The dsh-anytype-memory plugin is installed but tool registration is disabled (enabled=false in its settings) or all groups are excluded. No memory_* tools exist in this session. The user can enable them in Settings → Plugins → dsh-anytype-memory (plugin reload required).`;
  return {
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text,
  };
}

/**
 * 插件入口。
 *
 * @param ctx - cordis 上下文（tools / systemPrompt 已由 inject 保证就绪）。
 * @param configInput - loader 投影的用户配置（volatile 引用嵌套，可 undefined）。
 */
export function apply(ctx: Context, configInput?: unknown): void {
  // e2e 契约：装载日志 `[name] ` 前缀格式，e2e 运行器按此结构化匹配。
  console.log(`[${name}] plugin loaded`);

  // 1. 解析配置；非法输入降级为默认（不抛错、不阻塞宿主）。
  let resolved;
  try {
    resolved = resolveConfig(configInput);
  } catch (err) {
    console.error(`[${name}] invalid config:`, err);
    resolved = resolveConfig(undefined);
  }

  // 2. system-prompt 使用指引 section：始终注册——enabled=false 时它告知
  //    agent「工具存在但停用」，避免模型面对用户请求凭空造工具。
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section(
      memoryGuidanceSection(resolved.enabled),
    );
    return () => dispose();
  }, 'dsh-anytype-memory: guidance section');

  // 3. enabled=false → 不注册任何工具
  if (!resolved.enabled) {
    console.log(`[${name}] disabled by config; no tools registered`);
    return;
  }

  // 4. 按组注册工具（disposer 自动附着插件，卸载即注销）。
  const grouped = buildTools(() => {
    // 每次执行现读 volatile 配置（baseUrl/apiKey/超时/截断热生效）。
    let current = resolved;
    try {
      current = resolveConfig(configInput);
    } catch {
      // 保留 last good
    }
    return current;
  });
  let registeredCount = 0;
  for (const [group, definitions] of grouped) {
    if (resolved.disabledGroups.has(group)) continue;
    for (const definition of definitions) {
      ctx.tools.register(definition);
      registeredCount += 1;
    }
  }
  console.log(`[${name}] registered ${registeredCount} memory tools`);
}

// re-export：loader 通过 `plugin.Config` 读 schemastery schema 生成设置面板
// （collectConfigSchemas）；不 re-export 会让设置面板不渲染本插件字段。
export { resolveConfig, Config } from './config.ts';
export type { ResolvedConfig, ToolGroup } from './config.ts';
export {
  DEFAULT_BASE_URL,
  DEFAULT_API_VERSION,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SPACE_NAME,
  TOOL_GROUPS,
} from './config.ts';
export { buildTools, buildGroupedTools } from './tools/index.ts';
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
