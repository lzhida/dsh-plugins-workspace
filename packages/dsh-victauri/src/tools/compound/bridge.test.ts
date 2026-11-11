/**
 * compound 桥运行时透传测试（gap-list T-5）：
 * compound 15 个工具与 standalone 共用 createRestBridgeTool 工厂，
 * 此前 0 运行时覆盖——用 logs（含 since_seq integer 校验与闭集枚举）
 * 与 route（未知顶层参数放行）验证「客户端校验 → 透传」链路。
 */
import { describe, expect, it } from 'vitest';

import type { VictauriClient } from '../../client.ts';
import { COMPOUND_TOOL_SPECS } from './catalog.ts';
import { createRestBridgeTool } from '../standalone/bridge.ts';

/**
 * 最小 mock client:记录调用入参。
 * 计数用对象承载(闭包引用),避免解构基础类型得到值快照导致断言恒旧。
 */
function mockClient(impl: () => Promise<unknown>): {
  client: VictauriClient;
  state: { calls: number };
} {
  const state = { calls: 0 };
  const client = {
    callTool: async () => {
      state.calls += 1;
      return impl();
    },
  } as unknown as VictauriClient;
  return { client, state };
}

const specOf = (name: string) =>
  COMPOUND_TOOL_SPECS.find((spec) => spec.name === name)!;

describe('compound 桥运行时透传(共用 standalone 工厂)', () => {
  it('logs.since_seq 类型错在客户端前置拒绝,请求不发出', async () => {
    const { client, state } = mockClient(async () => ({}));
    const tool = createRestBridgeTool(specOf('logs'), {
      getClient: async () => client,
    });
    await expect(
      tool.execute({ action: 'backend', since_seq: '7' }, {} as never),
    ).rejects.toThrow(/must be an integer/);
    expect(state.calls).toBe(0);
  });

  it('logs 未知 action 枚举报错(闭集校验含 backend/backend_digest/stdout)', async () => {
    const { client, state } = mockClient(async () => ({}));
    const tool = createRestBridgeTool(specOf('logs'), {
      getClient: async () => client,
    });
    await expect(tool.execute({ action: 'nope' }, {} as never)).rejects.toThrow(
      /must be one of/,
    );
    expect(state.calls).toBe(0);
    // 闭集含 0.10.2 新动作:合法值不被本地拒绝
    const result = (await tool.execute(
      { action: 'backend_digest' },
      {} as never,
    )) as Record<string, unknown>;
    expect(state.calls).toBe(1);
    expect(result).not.toHaveProperty('error');
  });

  it('route 未知顶层参数放行且以 ignored_args 可观测(M-4,透传语义不变)', async () => {
    const { client, state } = mockClient(async () => ({ added: true }));
    const tool = createRestBridgeTool(specOf('route'), {
      getClient: async () => client,
    });
    const result = (await tool.execute(
      {
        action: 'add',
        pattern: 'https://example.com/api',
        behavior: 'fulfill',
        totally_unknown_key: 1,
      },
      {} as never,
    )) as Record<string, unknown>;
    expect(state.calls).toBe(1);
    // 未知键照常透传(上游静默忽略,行为不变),结果顶层只附加提示键
    expect(result).toEqual({
      added: true,
      ignored_args: ['totally_unknown_key'],
    });
  });

  it('上游正式别名(recording.label / window.webview_label|window|window_label)不误报(M-4,V2 中-1)', async () => {
    const { client, state } = mockClient(async () => ({ ok: true }));
    const recordingTool = createRestBridgeTool(specOf('recording'), {
      getClient: async () => client,
    });
    const recordingResult = (await recordingTool.execute(
      { action: 'list_checkpoints', label: 'cp' },
      {} as never,
    )) as Record<string, unknown>;
    expect(state.calls).toBe(1);
    // checkpoint_label 的 serde alias label 真实消费,不得报 ignored
    expect('ignored_args' in recordingResult).toBe(false);

    const windowTool = createRestBridgeTool(specOf('window'), {
      getClient: async () => client,
    });
    const windowResult = (await windowTool.execute(
      { action: 'list', webview_label: 'a', window: 'b', window_label: 'c' },
      {} as never,
    )) as Record<string, unknown>;
    expect(state.calls).toBe(2);
    // WindowParams.label 的三个 serde alias 全部真实消费
    expect('ignored_args' in windowResult).toBe(false);
  });
});
