/**
 * S-2 重发现机制单测（backlog-A）：
 * - shouldResetClient 触发矩阵（auth 401/403 与网络层 http-error 复位，其余不复位）；
 * - ReconnectingVictauriClient 包装层：复位类错误回调 onReset 且原样重抛，
 *   不复位类不触发，成功调用零改动直通。
 */
import { describe, expect, it } from 'vitest';

import { ReconnectingVictauriClient, shouldResetClient } from './index.ts';
import { VictauriClient, type VictauriClientLike } from './client.ts';
import {
  VictauriError,
  VictauriHttpError,
  VictauriTimeoutError,
} from './errors.ts';

/** 最小内层客户端桩：四个公开面默认直通，可按面覆盖。 */
function fakeInner(
  overrides: Partial<VictauriClientLike> = {},
): VictauriClient {
  return {
    callTool: async () => 'ok',
    info: async () => ({ version: '0.10.3' }),
    listTools: async () => [],
    health: async () => true,
    ...overrides,
  } as unknown as VictauriClient;
}

describe('shouldResetClient(S-2 重发现触发矩阵)', () => {
  it('401/403 与网络层 http-error 复位;400/404/429/5xx/超时/tool-error/未知异常不复位', () => {
    // auth 分流(401/403)→复位
    expect(shouldResetClient(new VictauriHttpError(401, 'x', 'ctx'))).toBe(
      true,
    );
    expect(shouldResetClient(new VictauriHttpError(403, 'x', 'ctx'))).toBe(
      true,
    );
    // 其余 HTTP(服务在线)→不复位
    expect(shouldResetClient(new VictauriHttpError(400, 'x', 'ctx'))).toBe(
      false,
    );
    expect(shouldResetClient(new VictauriHttpError(404, 'x', 'ctx'))).toBe(
      false,
    );
    expect(shouldResetClient(new VictauriHttpError(429, 'x', 'ctx'))).toBe(
      false,
    );
    expect(shouldResetClient(new VictauriHttpError(500, 'x', 'ctx'))).toBe(
      false,
    );
    // 超时→不复位(eval 长任务常见)
    expect(shouldResetClient(new VictauriTimeoutError('http://x', 1000))).toBe(
      false,
    );
    // 网络层 fetch 失败(实例可能已退出)→复位
    expect(
      shouldResetClient(new VictauriError('http-error', 'fetch failed')),
    ).toBe(true);
    // 工具级失败与非结构化异常→不复位
    expect(shouldResetClient(new VictauriError('tool-error', 'x'))).toBe(false);
    expect(shouldResetClient(new Error('plain'))).toBe(false);
  });
});

describe('ReconnectingVictauriClient(S-2 包装层)', () => {
  it('复位类错误触发 onReset 且原样重抛;不复位类不触发;成功直通零改动', async () => {
    let resets = 0;
    const inner = fakeInner({
      callTool: async (name: string) => {
        if (name === 'dead') {
          throw new VictauriHttpError(401, 'unauth', 'callTool(dead)');
        }
        if (name === 'toolfail') {
          throw new VictauriError('tool-error', 'upstream said no');
        }
        if (name === 'slow') {
          throw new VictauriTimeoutError('http://x', 5);
        }
        return `ok:${name}`;
      },
    });
    const wrapped = new ReconnectingVictauriClient(inner, () => {
      resets += 1;
    });
    // 成功直通:四个公开面零改动
    expect(await wrapped.callTool('alive')).toBe('ok:alive');
    expect(await wrapped.info()).toEqual({ version: '0.10.3' });
    expect(await wrapped.listTools()).toEqual([]);
    expect(await wrapped.health()).toBe(true);
    expect(resets).toBe(0);
    // 401 → 复位一次 + 原样重抛
    await expect(wrapped.callTool('dead')).rejects.toBeInstanceOf(
      VictauriHttpError,
    );
    expect(resets).toBe(1);
    // tool-error / timeout → 不复位,错误原样重抛
    await expect(wrapped.callTool('toolfail')).rejects.toBeInstanceOf(
      VictauriError,
    );
    await expect(wrapped.callTool('slow')).rejects.toBeInstanceOf(
      VictauriTimeoutError,
    );
    expect(resets).toBe(1);
    // info 路径同样走复位矩阵
    const inner2 = fakeInner({
      info: async () => {
        throw new VictauriHttpError(403, 'x', 'info');
      },
    });
    const wrapped2 = new ReconnectingVictauriClient(inner2, () => {
      resets += 1;
    });
    await expect(wrapped2.info()).rejects.toBeInstanceOf(VictauriHttpError);
    expect(resets).toBe(2);
  });
});
