/**
 * 包级契约测试：零本地状态、工具名唯一、插件行装载面。
 *
 * 「零本地状态」是本包最硬的约束（记忆正文/属性/关系/向量全部落在 Anytype
 * 对象内），故断言放在**包根**：扫描整个 `src/`（而不是某个子目录），
 * 任何一处引入文件写入或本地数据库都会让本测试失败。
 */

import type { Context } from '@deepseek-ai/cordis';
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { apply as applyAnytype } from './entries/anytype.ts';
import { apply as applyMemory } from './entries/memory.ts';
import { AnytypeService } from './services/anytype.ts';

/** 递归列出目录下的 .ts 文件（排除测试自身）。 */
function listSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSources(full, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** 最小 cordis 上下文假体（两个插件行共用）。 */
function stubCtx(): {
  ctx: Context;
  sections: PromptSection[];
  tools: ToolDefinition[];
  disposers: Array<() => void>;
  provided: Map<string, unknown>;
} {
  const sections: PromptSection[] = [];
  const tools: ToolDefinition[] = [];
  const disposers: Array<() => void> = [];
  const provided = new Map<string, unknown>();
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    provide: (key: string, value: unknown) => {
      provided.set(key, value);
      return () => provided.delete(key);
    },
    get: (key: string) => provided.get(key),
    systemPrompt: {
      section: (section: PromptSection) => {
        sections.push(section);
        return () => {};
      },
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool);
      },
    },
  } as unknown as Context;
  return { ctx, sections, tools, disposers, provided };
}

/** 构造一份连接服务（供记忆插件行复用）。 */
function makeService(): AnytypeService {
  return new AnytypeService(() => ({
    baseUrl: 'http://127.0.0.1:31009',
    apiKey: '',
    apiVersion: '2025-11-08',
    requestTimeoutMs: 30_000,
    maxResponseChars: 20_000,
  }));
}

describe('dsh-anytype bundle 包', () => {
  it('零本地状态：整个 src/ 里不存在任何文件写入路径', () => {
    const dir = new URL('./', import.meta.url).pathname.replace(/^\//, '');
    const files = listSources(dir);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from 'node:fs'/);
      expect(source, file).not.toMatch(
        /writeFileSync|appendFileSync|mkdirSync|createWriteStream/,
      );
      expect(source, file).not.toMatch(/from 'node:sqlite'/);
    }
  });

  it('两个插件行注册的工具名互不重复（合计 46 个）', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, tools, provided } = stubCtx();
    applyAnytype(ctx);
    provided.set('anytype', makeService());
    applyMemory(ctx);
    const names = tools.map((t) => t.name);
    expect(names).toHaveLength(46);
    expect(new Set(names).size).toBe(46);
    expect(names.some((n) => n.startsWith('anytype_'))).toBe(true);
    expect(names.some((n) => n.startsWith('memory_'))).toBe(true);
    log.mockRestore();
  });

  it('插件行①以具名服务 anytype 提供连接能力', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { ctx, provided } = stubCtx();
    applyAnytype(ctx);
    expect(provided.has('anytype')).toBe(true);
    const service = provided.get('anytype');
    expect(service).toBeInstanceOf(AnytypeService);
    expect((service as AnytypeService).client.baseUrl).toBe(
      'http://127.0.0.1:31009',
    );
    log.mockRestore();
  });

  it('配置归属：连接类字段只在插件行①，记忆行不出现 apiKey/baseUrl', async () => {
    const { Config: anytypeConfig } = await import('./anytype/config.ts');
    const { Config: memoryConfig } = await import('./memory/config.ts');
    // schemastery 的对象 schema 运行时以 `dict` 持有字段表（类型未公开暴露）。
    const fieldsOf = (config: unknown): string[] =>
      Object.keys((config as { dict: Record<string, unknown> }).dict);
    const anytypeFields = fieldsOf(anytypeConfig);
    const memoryFields = fieldsOf(memoryConfig);

    // 连接类字段归插件行①（设置面板里只出现一次）
    for (const field of [
      'baseUrl',
      'apiKey',
      'apiVersion',
      'requestTimeoutMs',
      'maxResponseChars',
    ]) {
      expect(anytypeFields).toContain(field);
      expect(memoryFields).not.toContain(field);
    }
    // 记忆行只留语义类字段
    for (const field of [
      'spaceName',
      'spaceId',
      'defaultStatus',
      'recallLimit',
      'recallMaxTokens',
      'embeddingBatchSize',
    ]) {
      expect(memoryFields).toContain(field);
      expect(anytypeFields).not.toContain(field);
    }
  });
});
