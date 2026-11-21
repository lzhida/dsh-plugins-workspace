/**
 * dsh-open-design 连接层单测：退避、握手、失败不冒泡、重连与配置指纹。
 *
 * 全部用假客户端/假传输驱动，不 spawn 任何真实进程。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Mock } from 'vitest';

import type { Tool } from '@modelcontextprotocol/client';
import type { StdioServerParameters } from '@modelcontextprotocol/client/stdio';

import {
  computeBackoffDelay,
  computeConfigFingerprint,
  connect,
  RECONNECT_DEFAULTS,
} from './connection.ts';
import type {
  ConnectionLogger,
  ConnectionOptions,
  McpClientLike,
  McpTransportLike,
} from './connection.ts';

/** 上游工具样例。 */
const UPSTREAM_TOOLS = [
  {
    name: 'create_file',
    description: '创建文件',
    inputSchema: { type: 'object' },
  },
] as unknown as Tool[];

/** 基准连接配置（对应探测到的 Open Design stdio 启动方式）。 */
const OPTIONS: ConnectionOptions = {
  command: 'E:\\Programs\\Open Design\\Open Design.exe',
  args: [
    'E:\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs',
    'mcp',
  ],
  env: { ELECTRON_RUN_AS_NODE: '1' },
  cwd: 'E:\\Programs\\Open Design',
  startupTimeoutMs: 120_000,
  toolCallTimeoutMs: 60_000,
};

/** 假日志实现。 */
function createLogger(): ConnectionLogger & {
  log: Mock<(message: string) => void>;
  warn: Mock<(message: string) => void>;
  error: Mock<(message: string) => void>;
} {
  return {
    log: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
    error: vi.fn<(message: string) => void>(),
  };
}

/** 假客户端：每个方法都是 vi.fn，便于断言调用参数。 */
function createMockClient(): {
  client: McpClientLike;
  connect: Mock<() => Promise<void>>;
  listTools: Mock<() => Promise<{ tools: Tool[] }>>;
  callTool: Mock<() => Promise<{ content: never[] }>>;
  close: Mock<() => Promise<void>>;
} {
  const connect = vi.fn<() => Promise<void>>(async () => {});
  const listTools = vi.fn<() => Promise<{ tools: Tool[] }>>(async () => ({
    tools: UPSTREAM_TOOLS,
  }));
  const callTool = vi.fn<() => Promise<{ content: never[] }>>(async () => ({
    content: [],
  }));
  const close = vi.fn<() => Promise<void>>(async () => {});
  const client: McpClientLike = {
    connect,
    listTools,
    callTool,
    close,
  };
  return { client, connect, listTools, callTool, close };
}

/** 假传输：只提供一个可断言的 close。 */
function createMockTransport(): {
  transport: McpTransportLike;
  close: Mock<() => Promise<void>>;
} {
  const close = vi.fn<() => Promise<void>>(async () => {});
  const transport: McpTransportLike = { close };
  return { transport, close };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dsh-open-design connection', () => {
  it('按指数退避算出重连间隔并封顶', () => {
    expect(computeBackoffDelay(1, 500, 30_000)).toBe(500);
    expect(computeBackoffDelay(2, 500, 30_000)).toBe(1000);
    expect(computeBackoffDelay(3, 500, 30_000)).toBe(2000);
    expect(computeBackoffDelay(10, 500, 30_000)).toBe(30_000);
    expect(computeBackoffDelay(0, 500, 30_000)).toBe(500);
  });

  it('握手时带上启动超时并以刷新模式列出工具', async () => {
    const { client, connect: connectMock, listTools } = createMockClient();
    const { transport } = createMockTransport();
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport: () => transport,
    });

    expect(connectMock).toHaveBeenCalledWith(transport, { timeout: 120_000 });
    expect(connection.status.state).toBe('connected');

    const tools = await connection.listTools();
    expect(tools).toEqual(UPSTREAM_TOOLS);
    expect(listTools).toHaveBeenCalledWith(undefined, {
      cacheMode: 'refresh',
      timeout: 60_000,
    });
    await connection.close();
  });

  it('调用上游工具时带上工具名与参数', async () => {
    const { client, callTool } = createMockClient();
    const { transport } = createMockTransport();
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport: () => transport,
    });

    await connection.callTool('create_file', { path: 'a.txt' });
    expect(callTool).toHaveBeenCalledWith(
      { name: 'create_file', arguments: { path: 'a.txt' } },
      { timeout: 60_000 },
    );
    await connection.close();
  });

  it('子进程启动失败时不抛错并进入重连', async () => {
    const { client } = createMockClient();
    const logger = createLogger();
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport: () => {
        throw new Error('spawn ENOENT Open Design.exe');
      },
      logger,
    });

    expect(connection.status.state).toBe('reconnecting');
    expect(connection.status.lastError).toContain('spawn ENOENT');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('[dsh-open-design]'),
    );
    await connection.close();
  });

  it('连接意外断开后按退避重新连上', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const { transport } = createMockTransport();
    const clients: McpClientLike[] = [];
    const createClient = vi.fn(() => {
      const { client } = createMockClient();
      clients.push(client);
      return client;
    });

    const connection = await connect(OPTIONS, {
      createClient,
      createTransport: () => transport,
      logger,
    });
    expect(createClient).toHaveBeenCalledTimes(1);

    // 模拟上游进程退出：客户端的 onclose 钩子被触发。
    clients[0]?.onclose?.();
    expect(connection.status.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(500);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(connection.status.state).toBe('connected');
    await connection.close();
  });

  it('重连次数超过上限后放弃连接', async () => {
    vi.useFakeTimers();
    const logger = createLogger();
    const { client } = createMockClient();
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport: () => {
        throw new Error('spawn ENOENT');
      },
      logger,
      policy: { maxAttempts: 1 },
    });
    expect(connection.status.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(500);
    expect(connection.status.state).toBe('failed');
    expect(connection.status.failedAttempts).toBe(2);
    await connection.close();
  });

  it('配置指纹变化时重建连接', async () => {
    const { client } = createMockClient();
    const { transport } = createMockTransport();
    const createTransport = vi.fn((params: StdioServerParameters) => {
      expect(params.command).toBeTypeOf('string');
      return transport;
    });
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport,
    });
    expect(createTransport).toHaveBeenCalledTimes(1);

    await connection.reconfigure({
      ...OPTIONS,
      command: 'E:\\Other\\Open Design.exe',
    });
    expect(createTransport).toHaveBeenCalledTimes(2);

    // 指纹没变就不重建，避免把同一份配置反复重启成新进程。
    await connection.reconfigure({
      ...OPTIONS,
      command: 'E:\\Other\\Open Design.exe',
    });
    expect(createTransport).toHaveBeenCalledTimes(2);
    await connection.close();
  });

  it('配置指纹只覆盖命令参数环境与工作目录', () => {
    const base = computeConfigFingerprint(OPTIONS);
    expect(
      computeConfigFingerprint({ ...OPTIONS, env: { A: '1', B: '2' } }),
    ).toBe(computeConfigFingerprint({ ...OPTIONS, env: { B: '2', A: '1' } }));
    expect(computeConfigFingerprint({ ...OPTIONS, cwd: 'D:\\other' })).not.toBe(
      base,
    );
    expect(computeConfigFingerprint({ ...OPTIONS, args: ['x'] })).not.toBe(
      base,
    );
    // 超时不参与指纹：改超时不必重建子进程。
    expect(
      computeConfigFingerprint({ ...OPTIONS, startupTimeoutMs: 1_000 }),
    ).toBe(base);
  });

  it('指纹相同时超时改动即时生效且不重建子进程', async () => {
    const { client, callTool } = createMockClient();
    const { transport } = createMockTransport();
    const createTransport = vi.fn(() => transport);
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport,
    });
    expect(createTransport).toHaveBeenCalledTimes(1);

    // 指纹不变（仅超时变化）：不重建子进程，但新超时立即作用于后续调用。
    await connection.reconfigure({ ...OPTIONS, toolCallTimeoutMs: 5_000 });
    expect(createTransport).toHaveBeenCalledTimes(1);
    await connection.callTool('create_file', {});
    expect(callTool).toHaveBeenLastCalledWith(
      { name: 'create_file', arguments: {} },
      { timeout: 5_000 },
    );
    await connection.close();
  });

  it('关闭连接时终止客户端与子进程', async () => {
    const { client, close: closeClient } = createMockClient();
    const { transport, close: closeTransport } = createMockTransport();
    const connection = await connect(OPTIONS, {
      createClient: () => client,
      createTransport: () => transport,
    });

    await connection.close();
    expect(closeClient).toHaveBeenCalledTimes(1);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(connection.status.state).toBe('closed');
  });

  it('默认重连策略与宿主一致', () => {
    expect(RECONNECT_DEFAULTS).toEqual({
      enabled: true,
      initialDelayMs: 500,
      maxDelayMs: 30_000,
      maxAttempts: 10,
    });
  });
});
