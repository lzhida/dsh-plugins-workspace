/**
 * 工具组装：按组构建全部笔记工具，供注册层按 `disabledGroups` 过滤。
 *
 * 组与工具清单（6 个工具 / 5 项能力，评审记录见看板卡 t-mvuclosk-ho441r
 * DoD⑦）：
 * - setup:  wiki_setup
 * - write:  wiki_write
 * - review: wiki_review
 * - read:   wiki_get, wiki_list（只读）
 * - lint:   wiki_lint（只读巡检）
 *
 * **工具清单评审结论**：没有任何记忆召回、向量、Index、自动注入类工具；
 * wiki 不是记忆系统——读取只发生在 AI 明确调用 wiki_get/wiki_list 时。
 * 写工具统一暴露 `dry_run`（预演）；wiki_write 另有 `idempotency_key`。
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { ResolvedConfig, ToolGroup } from '../config.ts';
import { WikiStore } from '../store.ts';
import { buildLintTools } from './lint.ts';
import { buildReadTools } from './read.ts';
import { buildReviewTools } from './review.ts';
import { buildSetupTools } from './setup.ts';
import type { WikiToolDeps } from './shared.ts';
import { buildWriteTools } from './write.ts';

/** 全部工具按组组装（注册层按 disabledGroups 过滤后逐个 register）。 */
export function buildGroupedTools(
  deps: WikiToolDeps,
): Map<ToolGroup, ToolDefinition[]> {
  return new Map<ToolGroup, ToolDefinition[]>([
    ['setup', buildSetupTools(deps)],
    ['write', buildWriteTools(deps)],
    ['review', buildReviewTools(deps)],
    ['read', buildReadTools(deps)],
    ['lint', buildLintTools(deps)],
  ]);
}

/**
 * 组装全部工具（插件行的唯一装配入口）。
 *
 * @param store - 笔记存储（由 `AnytypeService` 提供的共享客户端构造）——
 *   **不在此自建 client**：连接配置归插件行①，本插件行不持有钥匙。
 * @param config - volatile 配置现读入口（语义类：空间/工具组）。
 * @returns 组标识 → 工具定义列表。
 */
export function buildTools(
  store: WikiStore,
  config: () => ResolvedConfig,
): Map<ToolGroup, ToolDefinition[]> {
  const deps: WikiToolDeps = { store, config };
  return buildGroupedTools(deps);
}
