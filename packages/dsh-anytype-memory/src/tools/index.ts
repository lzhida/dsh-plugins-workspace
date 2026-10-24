/**
 * 工具组装：按组构建全部记忆工具，供注册层按 `disabledGroups` 过滤。
 *
 * 组与工具清单（16 个）：
 * - setup: memory_setup
 * - write: memory_write, memory_update, memory_link, memory_supersede,
 *          memory_archive, memory_review
 * - read:  memory_recall, memory_get, memory_list, memory_search, memory_stats
 * - agent: memory_candidates, memory_set_embedding, memory_suggest_links
 * - diag:  memory_doctor
 *
 * 写工具（write 组）统一暴露 `dry_run`（预演）与 `idempotency_key`（防重）。
 */

import { AnytypeClient } from '@lzhida/dsh-anytype-core';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';

import type { ResolvedConfig, ToolGroup } from '../config.ts';
import { MemoryStore } from '../store.ts';
import { buildAgentTools } from './agent.ts';
import { buildDiagTools } from './diag.ts';
import { buildReadTools } from './read.ts';
import { buildSetupTools } from './setup.ts';
import type { MemoryToolDeps } from './shared.ts';
import { buildWriteTools } from './write.ts';

/** 全部工具按组组装（注册层按 disabledGroups 过滤后逐个 register）。 */
export function buildGroupedTools(
  deps: MemoryToolDeps,
): Map<ToolGroup, ToolDefinition[]> {
  return new Map<ToolGroup, ToolDefinition[]>([
    ['setup', buildSetupTools(deps)],
    ['write', buildWriteTools(deps)],
    ['read', buildReadTools(deps)],
    ['agent', buildAgentTools(deps)],
    ['diag', buildDiagTools(deps)],
  ]);
}

/**
 * 组装客户端、存储与全部工具（index.ts 的唯一装配入口）。
 *
 * @param config - volatile 配置现读入口。
 * @returns 组标识 → 工具定义列表。
 */
export function buildTools(
  config: () => ResolvedConfig,
): Map<ToolGroup, ToolDefinition[]> {
  const deps: MemoryToolDeps = {
    store: new MemoryStore(
      new AnytypeClient(() => {
        const cfg = config();
        return {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          apiVersion: cfg.apiVersion,
          timeoutMs: cfg.requestTimeoutMs,
        };
      }),
    ),
    config,
  };
  return buildGroupedTools(deps);
}
