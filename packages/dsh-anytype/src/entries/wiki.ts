/**
 * dsh-anytype-wiki 插件入口——AI 笔记知识库（AI 写、人看）。
 *
 * ## 定位（看板卡 t-mvuclosk-ho441r）
 *
 * 一个由 **AI 写笔记、人类查看审核** 的 Anytype 笔记空间。它**不是记忆
 * 系统**：不做 agent 自动召回、不自动注入上下文、没有向量/Index 层、没有
 * 记忆生命周期（supersede/衰减/embedding 一概不引入）——agent 的持久记忆
 * 由 hindsight/mnemon 等专门设施承担。wiki 的读取只发生在 AI 明确调用
 * `wiki_get` / `wiki_list` 时（续写参考、人类核对）。
 *
 * ## 工具面（6 个工具 / 5 项能力，MVP）
 *
 * - `wiki_setup`：幂等初始化笔记 space/类型/属性 schema；
 * - `wiki_write`：按标题查重创建/更新笔记（默认 draft 态 + source 溯源；
 *   更新正文会把状态重置回 draft 待重审）；
 * - `wiki_review`：待审列表 + approve/reject/archive 裁决写回（If-Match
 *   并发保护）；
 * - `wiki_get` / `wiki_list`：只读查看；
 * - `wiki_lint`：失效链接/孤立页巡检（只产出建议，不改数据）。
 *
 * ## 与其它插件行的关系
 *
 * 与 `entries/memory.ts` 同构：`inject: ['tools', 'systemPrompt', 'anytype']`
 * ——复用插件行①提供的连接服务，**连接配置只填一次**；本行只持有笔记
 * 语义配置（空间名/id、工具组开关）。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';

import type { AnytypeService } from '../services/anytype.ts';
import type { ResolvedConfig } from '../wiki/config.ts';
import { resolveConfig } from '../wiki/config.ts';
import { buildTools } from '../wiki/tools/index.ts';
import { WikiStore } from '../wiki/store.ts';

/** Cordis 插件名（loader 依赖）。 */
export const name = 'dsh-anytype-wiki';
/**
 * 依赖注入：工具注册表 + system-prompt + 连接服务（由插件行①提供）。
 */
export const inject: string[] = ['tools', 'systemPrompt', 'anytype'];

/** 指引 section 名（轨迹核查用）。 */
export const SECTION_NAME = 'tool:dsh-anytype-wiki';
/** 指引 section 排序（排在 memory 归档行之后）。 */
export const SECTION_ORDER = 2971;

/**
 * 笔记库写作纪律与用途指引（system-prompt section）。
 *
 * 只写笔记库用途与写作纪律——**没有任何记忆指引**（不教模型「把事实存进
 * wiki」、不承诺自动召回）。
 *
 * @param enabled - 工具是否已注册（关闭时告知模型工具不可用）。
 * @returns PromptSection。
 */
export function wikiGuidanceSection(enabled: boolean): PromptSection {
  const text = enabled
    ? [
        '## AI Wiki (dsh-anytype-wiki)',
        '',
        'An Anytype space of notes that YOU write and the HUMAN reads and reviews. It is NOT a memory system: nothing is recalled automatically and nothing from it is injected into your context — read notes only via wiki_get / wiki_list when you explicitly need them, and never treat the wiki as your memory.',
        '',
        '- wiki_setup: prepare the wiki space and schema (idempotent — run once, repeats create nothing).',
        '- wiki_write: create a note or update the note with the same title (title is the dedup key; no duplicate pages). New notes start as draft; replacing the body resets the note to draft for re-review. ALWAYS state source (where the content came from). Link related notes with markdown links (anytype://object?objectId=...) to grow the graph.',
        '- wiki_get / wiki_list: read notes (full text / queue overview) before writing related ones.',
        "- wiki_review: list the pending queue, or apply the HUMAN'S decision (approve / reject / archive). Never adjudicate on your own initiative.",
        '- wiki_lint: report broken links and orphan pages (suggestions only — it never modifies notes).',
        '',
        'Writing discipline: one topic per note; cite the source; prefer updating an existing note over creating a near-duplicate. Statuses: draft (you wrote it, human review pending) → approved (human accepted) → archived (rejected or retired).',
      ].join('\n')
    : [
        '## AI Wiki (dsh-anytype-wiki)',
        '',
        'The AI wiki tools are disabled in settings — no wiki_* tools are available in this session.',
      ].join('\n');
  return { name: SECTION_NAME, order: SECTION_ORDER, text };
}

/**
 * 插件入口：注册指引 section 与 wiki_* 工具。
 *
 * @param ctx - cordis 上下文。
 * @param configInput - loader 传入的配置（volatile 引用嵌套或普通值）。
 */
export function apply(ctx: Context, configInput?: unknown): void {
  console.log(`[${name}] plugin loaded`);

  let resolved: ResolvedConfig;
  try {
    resolved = resolveConfig(configInput);
  } catch (err) {
    console.error(
      `[${name}] failed to read config, falling back to defaults: ${(err as Error).message}`,
    );
    resolved = resolveConfig(undefined);
  }

  // 指引 section：enabled 与否都要在（关闭时告知模型工具不可用）。
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section(
      wikiGuidanceSection(resolved.enabled),
    );
    return () => dispose();
  }, 'dsh-anytype-wiki: guidance section');

  if (!resolved.enabled) {
    console.log(`[${name}] disabled by config — no tools registered`);
    return;
  }

  const service = ctx.get('anytype') as AnytypeService | undefined;
  if (!service) {
    throw new Error(
      'the "anytype" service is unavailable — the dsh-anytype row must be loaded first (check cordis.patch.yml order)',
    );
  }
  const store = new WikiStore(service.client);

  // volatile 配置每次工具调用现读；读挂了保上次的好值。
  let lastGood = resolved;
  const readConfig = (): ResolvedConfig => {
    try {
      lastGood = resolveConfig(configInput);
    } catch {
      // keep last good
    }
    return lastGood;
  };

  const grouped = buildTools(store, readConfig);
  let registeredCount = 0;
  for (const [group, definitions] of grouped) {
    if (resolved.disabledGroups.has(group)) continue;
    for (const definition of definitions) {
      ctx.tools.register(definition);
      registeredCount += 1;
    }
  }
  console.log(`[${name}] registered ${registeredCount} wiki tools`);
}

export { resolveConfig, Config } from '../wiki/config.ts';
export type { ResolvedConfig, ToolGroup } from '../wiki/config.ts';
