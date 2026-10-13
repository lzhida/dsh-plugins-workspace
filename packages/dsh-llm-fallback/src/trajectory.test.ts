/**
 * 轨迹写入单元测试。
 *
 * 覆盖:
 * - effectiveMaxSwitches:链长/maxRetries 取小、退化输入(链长 1、负值、非有限值);
 * - recordFallbackScheduled / recordFallbackStarted:
 *   - session 缺失 → no-op 不抛;
 *   - 正常路径 → session.append 收到正确的事件类型与 payload;
 *   - append 抛错 → 被吞掉(console.error 一次),绝不外泄。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FALLBACK_RETRY_POLICY_KEY,
  effectiveMaxSwitches,
  recordFallbackScheduled,
  recordFallbackStarted,
  type TrajectorySession,
} from './trajectory.ts';

describe('effectiveMaxSwitches', () => {
  it('取链长-1 与 maxRetries 的较小者', () => {
    expect(effectiveMaxSwitches(4, 10)).toBe(3);
    expect(effectiveMaxSwitches(4, 2)).toBe(2);
    expect(effectiveMaxSwitches(2, 5)).toBe(1);
  });

  it('链长 1(无备选)→ 0', () => {
    expect(effectiveMaxSwitches(1, 5)).toBe(0);
  });

  it('非法输入(0 / 负值 / 非有限值)→ 0', () => {
    expect(effectiveMaxSwitches(0, 5)).toBe(0);
    expect(effectiveMaxSwitches(3, -1)).toBe(0);
    expect(effectiveMaxSwitches(3, Number.NaN)).toBe(0);
    expect(effectiveMaxSwitches(3, Number.POSITIVE_INFINITY)).toBe(0);
    expect(effectiveMaxSwitches(Number.NaN, 5)).toBe(0);
  });
});

describe('recordFallbackScheduled', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const eventData = {
    retryId: 'rid-1',
    turn: 1,
    step: 2,
    provider: 'deepseek',
    mode: 'normal' as const,
    policyKey: FALLBACK_RETRY_POLICY_KEY,
    retry: 1,
    maxRetries: 2,
    delayMs: 500,
    failure: { code: 'RATE_LIMIT', message: 'too many requests' },
  };

  it('session 缺失(旧宿主未注入 agent)→ no-op 不抛', () => {
    expect(() => recordFallbackScheduled(undefined, eventData)).not.toThrow();
  });

  it('正常路径 → session.append("llm/retry", data) 原样透传 payload', () => {
    const appends: Array<{ type: string; data: unknown }> = [];
    const session: TrajectorySession = {
      append(type, data) {
        appends.push({ type, data });
        return undefined;
      },
    };
    recordFallbackScheduled(session, eventData);
    expect(appends).toEqual([{ type: 'llm/retry', data: eventData }]);
  });

  it('append 抛错 → 被吞掉并 console.error 一次,不外泄', () => {
    const session: TrajectorySession = {
      append() {
        throw new Error('session closed');
      },
    };
    expect(() => recordFallbackScheduled(session, eventData)).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('recordFallbackStarted', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const startedData = { retryId: 'rid-1', turn: 1, step: 2, retry: 1 };

  it('session 缺失 → no-op 不抛', () => {
    expect(() => recordFallbackStarted(undefined, startedData)).not.toThrow();
  });

  it('正常路径 → session.append("llm/retry-started", data) 原样透传 payload', () => {
    const appends: Array<{ type: string; data: unknown }> = [];
    const session: TrajectorySession = {
      append(type, data) {
        appends.push({ type, data });
        return undefined;
      },
    };
    recordFallbackStarted(session, startedData);
    expect(appends).toEqual([{ type: 'llm/retry-started', data: startedData }]);
  });

  it('append 抛错 → 被吞掉并 console.error 一次,不外泄', () => {
    const session: TrajectorySession = {
      append() {
        throw new Error('session closed');
      },
    };
    expect(() => recordFallbackStarted(session, startedData)).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
