/**
 * 配额感知自适应冷却(src/quota.ts)单元测试。
 * 样本全部来自真实报错取证(2026-10):
 * - MiniMax:官方错误码文档 + GitHub 真实报文(Token Plan 2056 + resets at ISO);
 * - GLM:bigmodel 官方错误码文档措辞(1308/1310,next_flush_time 渲染格式
 *   官方未公布,按 `YYYY-MM-DD HH:mm` 通用形态覆盖;TODO:实测后补样本);
 * - antirion 网关中文包装形态(本地轨迹 2026-10-27 实录,无重置时间)。
 */
import { describe, expect, it } from 'vitest';

import type { LlmFailure } from '@deepseek-ai/dsh-llm';

import {
  isQuotaLikeFailure,
  parseResetTimeMs,
  resolveCooldownDuration,
} from './quota.ts';

/** 构造失败 fixture(只覆盖 LlmFailure 的最小字段)。 */
function failure(code: string, message = 'fake failure'): LlmFailure {
  return { code, message };
}

/** 决策时刻:2026-05-15 12:00 UTC(真实报文样本的 3 小时前)。 */
const NOW = Date.UTC(2026, 4, 15, 12, 0, 0);
/** MiniMax 真实报文里的重置时刻:2026-05-15T15:00:00Z。 */
const MINIMAX_RESET = Date.UTC(2026, 4, 15, 15, 0, 0);

/** resolveCooldownDuration 的标准输入(逐用例覆写)。 */
function opts(
  over: Partial<Parameters<typeof resolveCooldownDuration>[1]> = {},
): Parameters<typeof resolveCooldownDuration>[1] {
  return {
    cooldownMs: 300_000,
    quotaEnabled: true,
    quotaCooldownMs: 18_000_000,
    cooldownCapMs: 604_800_000,
    now: NOW,
    ...over,
  };
}

describe('parseResetTimeMs(报错重置时间提取)', () => {
  it('提取 MiniMax 英文真实报文的 ISO UTC 重置时间', () => {
    const message =
      'HTTP 429: usage limit exceeded, 5-hour usage limit reached for ' +
      'Token Plan Starter (0/0 used), resets at 2026-05-15T15:00:00Z (2056)';
    expect(parseResetTimeMs(message, NOW)).toBe(MINIMAX_RESET);
  });

  it('提取带时区偏移的 ISO 时间(+08:00)', () => {
    // 2026-06-01T09:30:00+08:00 == 2026-06-01T01:30:00Z
    const message = '您的限额将在 2026-06-01T09:30:00+08:00 重置';
    expect(parseResetTimeMs(message, NOW)).toBe(Date.UTC(2026, 5, 1, 1, 30, 0));
  });

  it('提取 GLM 中文 naive 时间并按宿主本地时区解析', () => {
    const message =
      '429 已达到 5,000,000 tokens 的使用上限。您的限额将在 2026-06-01 08:00 重置';
    // naive 无时区标记 → 按宿主本地时区构造(GLM 为中国服务);期望值用
    // 同一构造方式计算,测试本身与时区无关;选 17 天后的时刻避免边缘时区
    // 下落到现在之前。
    expect(parseResetTimeMs(message, NOW)).toBe(
      new Date(2026, 5, 1, 8, 0, 0).getTime(),
    );
  });

  it('提取英文相对时长(retry after N minutes)', () => {
    const message = '429 usage limit exceeded, retry after 25 minutes';
    expect(parseResetTimeMs(message, NOW)).toBe(NOW + 25 * 60_000);
  });

  it('提取中文相对时长(N 小时后重试)', () => {
    const message = '用量已达上限,请 2 小时后重试';
    expect(parseResetTimeMs(message, NOW)).toBe(NOW + 2 * 3_600_000);
  });

  it('不把窗口名(5-hour usage limit)误读为相对时长', () => {
    // 真实报文里的「5-hour」是窗口名;无锚定措辞时不得当作 5 小时时长
    const message =
      'usage limit exceeded, 5-hour usage limit reached for Token Plan Starter (2056)';
    expect(parseResetTimeMs(message, NOW)).toBeNull();
  });

  it('报错不含重置关键词时不提取任何日期(套餐到期日等无关日期防误读)', () => {
    expect(
      parseResetTimeMs('account plan expires at 2026-06-01 08:00', NOW),
    ).toBeNull();
  });

  it('重置时间在过去时视为过期信息返回 null', () => {
    expect(
      parseResetTimeMs(
        'usage limit exceeded, resets at 2020-01-01T00:00:00Z',
        NOW,
      ),
    ).toBeNull();
  });

  it('空报错返回 null', () => {
    expect(parseResetTimeMs('', NOW)).toBeNull();
  });
});

describe('isQuotaLikeFailure(配额型失败识别)', () => {
  it('QUOTA / ACCOUNT_QUOTA 码直接命中(不读 message)', () => {
    expect(isQuotaLikeFailure(failure('QUOTA'))).toBe(true);
    expect(isQuotaLikeFailure(failure('ACCOUNT_QUOTA'))).toBe(true);
    expect(isQuotaLikeFailure(failure('QUOTA', ''))).toBe(true);
  });

  it('RATE_LIMIT + antirion 中文真实样本(业务码 2056)命中', () => {
    expect(
      isQuotaLikeFailure(
        failure('RATE_LIMIT', '429 已达到 Token Plan 用量上限 (2056)'),
      ),
    ).toBe(true);
  });

  it('RATE_LIMIT + GLM 1308 中文措辞命中', () => {
    expect(
      isQuotaLikeFailure(
        failure('RATE_LIMIT', '已达到 5,000,000 tokens 的使用上限 (1308)'),
      ),
    ).toBe(true);
  });

  it('RATE_LIMIT + MiniMax 英文 usage limit 措辞命中', () => {
    expect(
      isQuotaLikeFailure(
        failure(
          'RATE_LIMIT',
          'usage limit exceeded, resets at 2026-05-15T15:00:00Z',
        ),
      ),
    ).toBe(true);
  });

  it('瞬时 RATE_LIMIT(无配额信号)不命中', () => {
    expect(
      isQuotaLikeFailure(failure('RATE_LIMIT', '429 too many requests')),
    ).toBe(false);
  });

  it('非限流族失败码不命中(即便 message 带配额措辞)', () => {
    expect(
      isQuotaLikeFailure(failure('SERVER', '503 usage limit exceeded')),
    ).toBe(false);
    expect(isQuotaLikeFailure(failure('TIMEOUT', '用量上限'))).toBe(false);
  });
});

describe('resolveCooldownDuration(冷却时长决策)', () => {
  it('普通失败维持默认固定档(与旧版行为一致)', () => {
    const result = resolveCooldownDuration(
      failure('SERVER', '503 no healthy deployment'),
      opts(),
    );
    expect(result).toEqual({
      durationMs: 300_000,
      source: 'default',
      untilMs: NOW + 300_000,
    });
  });

  it('配额型无重置时间(antirion 中文样本)用配额档', () => {
    const result = resolveCooldownDuration(
      failure('RATE_LIMIT', '429 已达到 Token Plan 用量上限 (2056)'),
      opts(),
    );
    expect(result).toEqual({
      durationMs: 18_000_000,
      source: 'quota-window',
      untilMs: NOW + 18_000_000,
    });
  });

  it('报错带重置时间(MiniMax 真实样本)直接采用,差值 3 小时', () => {
    const result = resolveCooldownDuration(
      failure(
        'RATE_LIMIT',
        'HTTP 429: usage limit exceeded, 5-hour usage limit reached for ' +
          'Token Plan Starter (0/0 used), resets at 2026-05-15T15:00:00Z (2056)',
      ),
      opts(),
    );
    expect(result.source).toBe('reported-reset');
    expect(result.durationMs).toBe(MINIMAX_RESET - NOW);
    expect(result.untilMs).toBe(MINIMAX_RESET);
  });

  it('重置时间远超上限时被 clamp 到 cooldownCapMs', () => {
    const result = resolveCooldownDuration(
      failure('QUOTA', 'quota exhausted, resets at 2026-08-15T15:00:00Z'),
      opts({ cooldownCapMs: 604_800_000 }), // 7 天
    );
    expect(result.source).toBe('reported-reset');
    expect(result.durationMs).toBe(604_800_000);
    expect(result.untilMs).toBe(NOW + 604_800_000);
  });

  it('配额档为 0 时配额型也走默认档(关闭延长)', () => {
    const result = resolveCooldownDuration(
      failure('RATE_LIMIT', '429 已达到 Token Plan 用量上限 (2056)'),
      opts({ quotaCooldownMs: 0 }),
    );
    expect(result.source).toBe('default');
    expect(result.durationMs).toBe(300_000);
  });

  it('总开关关闭时全部走默认档', () => {
    const result = resolveCooldownDuration(
      failure('QUOTA', 'quota exhausted, resets at 2026-08-15T15:00:00Z'),
      opts({ quotaEnabled: false }),
    );
    expect(result.source).toBe('default');
    expect(result.durationMs).toBe(300_000);
  });

  it('重置时间在过去时降级配额档', () => {
    const result = resolveCooldownDuration(
      failure('QUOTA', 'usage limit exceeded, resets at 2020-01-01T00:00:00Z'),
      opts(),
    );
    expect(result.source).toBe('quota-window');
    expect(result.durationMs).toBe(18_000_000);
  });
});
