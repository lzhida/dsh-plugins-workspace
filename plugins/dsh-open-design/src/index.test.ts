/**
 * 插件行契约测试：loader 三符号、装载日志、工具注册面与工具名唯一性。
 */
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './index.ts';
import {
  DIAGNOSTIC_TOOL_COUNT,
  REDETECT_TOOL_NAME,
  STATUS_TOOL_NAME,
} from './diag-tools.ts';

interface StubCtx {
  ctx: Context;
  tools: ToolDefinition[];
  disposers: Array<() => void>;
}

/** 最小 cordis 上下文假体：effect 立即执行，清理函数收集。 */
function stubCtx(): StubCtx {
  const tools: ToolDefinition[] = [];
  const disposers: Array<() => void> = [];
  const ctx = {
    effect: (fn: () => (() => void) | void) => {
      const disposer = fn();
      if (typeof disposer === 'function') disposers.push(disposer);
    },
    tools: {
      register: (tool: ToolDefinition) => {
        tools.push(tool);
        return () => {};
      },
    },
  } as unknown as Context;
  return { ctx, tools, disposers };
}

async function tempConfigDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'dsh-open-design-'));
}

/** 等插件的异步启动流程跑完（日志留在 spy 窗口内，测试输出更干净）。 */
async function flushAsyncStartup(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** 假的 MCP 连接（避免测试真的拉起子进程）。 */
function fakeConnection() {
  return {
    listTools: async () => [],
    callTool: async () => ({ content: [] }),
    close: async () => {},
    reconfigure: async () => {},
    status: {
      state: 'connected' as const,
      failedAttempts: 0,
      maxAttempts: 10,
    },
  };
}

const DETECTED = {
  method: 'pipe' as const,
  stamp: {
    channel: 'stable',
    namespace: 'release-stable-win',
    source: 'packaged',
    mode: 'runtime',
    app: 'daemon',
  },
  endpoint: '\\\\.\\pipe\\open-design-sidecar-6eec4ea0e7395b977771b1af7124c1b9',
  installDir: 'E:\\Programs\\Open Design',
  dataDir: 'C:\\data',
  daemonCliPath: 'E:\\daemon-cli.mjs',
};

describe('dsh-open-design 插件行', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('导出 loader 依赖的三符号', () => {
    expect(name).toBe('dsh-open-design');
    expect(inject).toContain('tools');
    expect(typeof apply).toBe('function');
  });

  it('装载后打印带前缀的日志并注册两个诊断工具', async () => {
    const log = vi.spyOn(console, 'log');
    const { ctx, tools } = stubCtx();
    apply(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection(),
        configDir: 'C:\\does-not-matter',
      },
    );
    await flushAsyncStartup();

    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some((line) => line.includes('[dsh-open-design] plugin loaded')),
    ).toBe(true);
    expect(
      lines.some((line) =>
        line.includes(
          `[dsh-open-design] registered ${DIAGNOSTIC_TOOL_COUNT} diagnostic tools`,
        ),
      ),
    ).toBe(true);
    expect(tools).toHaveLength(DIAGNOSTIC_TOOL_COUNT);
    expect(tools.map((tool) => tool.name)).toEqual([
      STATUS_TOOL_NAME,
      REDETECT_TOOL_NAME,
    ]);
  });

  it('所有日志行都带插件前缀', async () => {
    const log = vi.spyOn(console, 'log');
    const { ctx } = stubCtx();
    apply(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection(),
        configDir: 'C:\\does-not-matter',
      },
    );
    await flushAsyncStartup();

    for (const call of log.mock.calls) {
      expect(String(call[0]).startsWith('[dsh-open-design]')).toBe(true);
    }
  });

  it('卸载时 effect 的清理函数被调用且不抛错', async () => {
    const { ctx, disposers } = stubCtx();
    apply(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection(),
        configDir: 'C:\\does-not-matter',
      },
    );
    await flushAsyncStartup();

    expect(disposers.length).toBeGreaterThan(0);
    for (const dispose of disposers) expect(() => dispose()).not.toThrow();
  });

  it('工具名唯一（诊断工具不与上游命名空间冲突）', async () => {
    const { ctx, tools } = stubCtx();
    apply(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection(),
        configDir: 'C:\\does-not-matter',
      },
    );
    await flushAsyncStartup();

    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const toolName of names) {
      expect(toolName.startsWith('mcp__open-design__')).toBe(false);
    }
  });

  it('冒烟：装配后配置文件真的写进指定目录', async () => {
    const dir = await tempConfigDir();
    const { ctx } = stubCtx();
    apply(
      ctx,
      {},
      {
        detect: async () => DETECTED,
        connect: async () => fakeConnection(),
        configDir: dir,
      },
    );
    await flushAsyncStartup();

    const raw = JSON.parse(
      await readFile(join(dir, 'config.json'), 'utf8'),
    ) as {
      schemaVersion: number;
      connection: { command: string };
      detected: { method: string } | null;
    };
    expect(raw.schemaVersion).toBe(1);
    expect(raw.connection.command).toBe(
      'E:\\Programs\\Open Design\\Open Design.exe',
    );
    expect(raw.detected?.method).toBe('pipe');
  });
});
