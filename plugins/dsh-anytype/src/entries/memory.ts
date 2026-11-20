/**
 * dsh-anytype-memory 插件入口（bundle 内的第二个插件行）。
 *
 * ## 它在包里的角色
 *
 * 与插件行①（`entries/anytype.ts`，通用 Anytype 工具）并列，是同一个
 * bundle 包里的**第二个插件行**——由包的 `cordis.patch.yml` 一次性声明并
 * 激活，用户装一次包即得到两个插件。
 *
 * ## 与插件行①的关系：service 组合
 *
 * 记忆插件**不自带连接配置**：apiKey / baseUrl 由插件行①注册的
 * `AnytypeService` 持有，本插件行 `inject: ['anytype']` 等待它就绪后
 * 复用同一个客户端——**连接配置只填一次**（设置面板里也没有第二份
 * apiKey 字段）。
 *
 * 本插件行自己的配置只有**语义类**字段：记忆空间（spaceName/spaceId）、
 * 新记忆的默认审核态、召回预算、向量投影批大小、工具组开关。
 *
 * 依赖注入：`tools`（注册工具）+ `systemPrompt`（注册指引 section）+
 * `anytype`（连接服务，由插件行①提供）。缺失时插件停在 PENDING（cordis
 * 语义，与官方 `inject: ['tools']` 的插件同款）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

import { resolveConfig } from '../memory/config.ts';
import { MemoryStore } from '../memory/store.ts';
import { buildTools } from '../memory/tools/index.ts';
import type { AnytypeService } from '../services/anytype.ts';

/** Cordis 插件名（loader 依赖）。 */
export const name = 'dsh-anytype-memory';

/**
 * 依赖注入：工具注册表 + system-prompt + **连接服务**。
 *
 * `anytype` 由插件行①（`dsh-anytype`）提供；它就绪前本插件行不加载。
 */
export const inject: string[] = ['tools', 'systemPrompt', 'anytype'];

/** 指引 section 名（包名空间防撞）。 */
export const SECTION_NAME = 'tool:dsh-anytype-memory';

/** section order：工具使用指引档位（PLUGIN 类，与宿主各 section 同档）。 */
export const SECTION_ORDER = 2970;

/** 构造 agent 使用指引 section（纯函数，测试直连）。 */
export function memoryGuidanceSection(enabled: boolean): PromptSection {
  const text = enabled
    ? `Anytype persistent memory tools (memory_*) are available. They store agent memory INSIDE a designated Anytype space: every memory is an Anytype object with typed properties (memory_kind, memory_status, memory_confidence, memory_content_hash) and controlled edges (memory_relates_to, memory_derived_from, memory_contradicts, memory_supersedes, memory_mentions). The plugin keeps no local files and runs no model.

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
 * @param ctx - cordis 上下文（tools / systemPrompt / anytype 已由 inject 保证就绪）。
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

  // 4. 取连接服务（inject 保证已就绪）——同一把钥匙，配置只填一次。
  const service = ctx.get('anytype') as AnytypeService | undefined;
  if (!service) {
    throw new Error(
      'the "anytype" service is unavailable — the dsh-anytype plugin row must be enabled (it provides the Anytype connection).',
    );
  }
  const store = new MemoryStore(service.client);

  // 5. 按组注册工具（disposer 自动附着插件，卸载即注销）。
  const grouped = buildTools(store, () => {
    // 每次执行现读 volatile 配置（空间/预算/状态等热生效）。
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
export { resolveConfig, Config } from '../memory/config.ts';
export type { ResolvedConfig, ToolGroup } from '../memory/config.ts';
