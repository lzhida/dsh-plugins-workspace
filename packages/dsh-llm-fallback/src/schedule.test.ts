/**
 * 时段计划(schedule)纯函数行为契约测试。
 *
 * 测试策略:所有 `now` 用 `new Date(y, m, d, h, min).getTime()` 构造——
 * 该构造按运行机器本地时区解释,窗口匹配同样按本地墙钟求值,因此断言
 * 与运行机器的时区无关(确定性)。窗口边界(半开区间)、跨夜回绕、
 * 全天、星期过滤、目标通配与解析容错逐项覆盖。
 */

import { describe, expect, it } from 'vitest';

import type { Candidate } from './state.ts';
import {
  isScheduleBlocked,
  parseTimeToMinutes,
  resolveSchedule,
  resolveScheduleRules,
  resolveWindow,
  targetMatches,
  windowMatches,
} from './schedule.ts';

/** 按本地时区构造某天某时刻的时间戳(分钟粒度)。 */
function localTime(
  hour: number,
  minute = 0,
  weekdayOneToSeven = 3, // 默认周三(任意固定日,配合 days=null 的窗口)
): number {
  // 2026-10-14 是周三(ISO 3),10-11 是周日(ISO 7)——day = 11 + weekday。
  const dayOfMonth = 11 + weekdayOneToSeven;
  // 月份用 9(=10 月,本地时区)。
  return new Date(2026, 9, dayOfMonth, hour, minute).getTime();
}

const candidate: Candidate = {
  provider: 'deepseek-account',
  model: 'deepseek-chat',
};

/** 收窄到 resolveWindow/resolveScheduleRules 的 error 分支并返回消息。 */
function err(r: object): string {
  return (r as { error: string }).error;
}

describe('schedule.parseTimeToMinutes', () => {
  it('解析 H:mm 与 HH:mm 为分钟数', () => {
    expect(parseTimeToMinutes('0:00')).toBe(0);
    expect(parseTimeToMinutes('8:30')).toBe(510);
    expect(parseTimeToMinutes('23:59')).toBe(1439);
  });

  it('拒绝非法时间(越界/缺冒号/非字符串/多余空白以外形态)', () => {
    expect(parseTimeToMinutes('24:00')).toBeNull();
    expect(parseTimeToMinutes('12:60')).toBeNull();
    expect(parseTimeToMinutes('1230')).toBeNull();
    expect(parseTimeToMinutes('abc')).toBeNull();
    expect(parseTimeToMinutes('')).toBeNull();
    expect(parseTimeToMinutes(510)).toBeNull();
    expect(parseTimeToMinutes(null)).toBeNull();
  });

  it('容忍首尾空白', () => {
    expect(parseTimeToMinutes(' 8:30 ')).toBe(510);
  });
});

describe('schedule.resolveWindow', () => {
  it('常规窗口(start<end)不跨夜非全天', () => {
    const w = resolveWindow({ start: '08:30', end: '12:00' });
    expect('error' in w).toBe(false);
    if (!('error' in w)) {
      expect(w.startMinutes).toBe(510);
      expect(w.endMinutes).toBe(720);
      expect(w.wraps).toBe(false);
      expect(w.allDay).toBe(false);
      expect(w.days).toBeNull();
    }
  });

  it('跨夜窗口(start>end)标记 wraps', () => {
    const w = resolveWindow({ start: '22:00', end: '06:00' });
    expect('error' in w).toBe(false);
    if (!('error' in w)) expect(w.wraps).toBe(true);
  });

  it('start==end 标记全天', () => {
    const w = resolveWindow({ start: '09:00', end: '09:00' });
    expect('error' in w).toBe(false);
    if (!('error' in w)) expect(w.allDay).toBe(true);
  });

  it('days 非空时归一为 ISO 星期集合', () => {
    const w = resolveWindow({ start: '09:00', end: '10:00', days: [1, 5, 3] });
    expect('error' in w).toBe(false);
    if (!('error' in w)) expect([...(w.days ?? [])].sort()).toEqual([1, 3, 5]);
  });

  it('空 days 数组等同每天(null)', () => {
    const w = resolveWindow({ start: '09:00', end: '10:00', days: [] });
    expect('error' in w).toBe(false);
    if (!('error' in w)) expect(w.days).toBeNull();
  });

  it('拒绝非法 start/end 与越界 days,错误消息不含路径前缀', () => {
    expect(err(resolveWindow({ start: '9:600', end: '10:00' }))).toContain(
      'start',
    );
    expect(err(resolveWindow({ start: '08:30', end: 'x' }))).toContain('end');
    expect(
      err(resolveWindow({ start: '08:30', end: '10:00', days: [0] })),
    ).toContain('days');
    expect(
      err(resolveWindow({ start: '08:30', end: '10:00', days: [8] })),
    ).toContain('days');
    expect(err(resolveWindow({}))).toContain('start');
  });
});

describe('schedule.resolveScheduleRules', () => {
  it('空与非数组输入归一为空规则列表', () => {
    expect(resolveScheduleRules([])).toEqual([]);
    expect(resolveScheduleRules(undefined)).toEqual([]);
    expect(resolveScheduleRules('nope')).toEqual([]);
  });

  it('合法规则通过校验并保留 targets 原文', () => {
    const rules = resolveScheduleRules([
      {
        targets: ['deepseek-account/*', 'openai/gpt-4o'],
        windows: [{ start: '08:30', end: '00:30' }],
      },
    ]);
    expect('error' in rules).toBe(false);
    if (!('error' in rules)) {
      expect(rules).toHaveLength(1);
      expect(rules[0]!.targets).toEqual([
        'deepseek-account/*',
        'openai/gpt-4o',
      ]);
      expect(rules[0]!.windows).toHaveLength(1);
    }
  });

  it('新建未填的占位规则(targets/windows 双空)静默跳过', () => {
    expect(resolveScheduleRules([{}, { targets: [], windows: [] }])).toEqual(
      [],
    );
  });

  it('拒绝缺 targets / 空 targets / 无斜杠 targets / 空 windows', () => {
    expect(
      err(
        resolveScheduleRules([{ windows: [{ start: '1:00', end: '2:00' }] }]),
      ),
    ).toContain('targets');
    expect(
      err(
        resolveScheduleRules([
          { targets: [], windows: [{ start: '1:00', end: '2:00' }] },
        ]),
      ),
    ).toContain('targets');
    expect(
      err(
        resolveScheduleRules([
          {
            targets: ['noseparator'],
            windows: [{ start: '1:00', end: '2:00' }],
          },
        ]),
      ),
    ).toContain('provider/model');
    expect(
      err(resolveScheduleRules([{ targets: ['a/b'], windows: [] }])),
    ).toContain('windows');
    expect(err(resolveScheduleRules([{ targets: ['a/b'] }]))).toContain(
      'windows',
    );
  });

  it('窗口错误消息携带规则与窗口下标前缀', () => {
    const result = resolveScheduleRules([
      { targets: ['a/b'], windows: [{ start: '1:00', end: '2:00' }] },
      { targets: ['c/d'], windows: [{ start: '25:00', end: '2:00' }] },
    ]);
    expect((result as { error: string }).error).toContain(
      'scheduleRules[1].windows[0].start',
    );
  });
});

describe('schedule.resolveSchedule', () => {
  it('enabled 默认关闭(仅显式 true 开启,存量用户零行为变化)', () => {
    expect(resolveSchedule(undefined, []).enabled).toBe(false);
    expect(resolveSchedule(false, []).enabled).toBe(false);
    expect(resolveSchedule('yes', []).enabled).toBe(false);
    expect(resolveSchedule(true, []).enabled).toBe(true);
  });

  it('规则非法时抛出含路径前缀的错误(调用方保留 last-good;占位规则除外)', () => {
    // 半配置(只填 targets 未填 windows)→ 非法
    expect(() => resolveSchedule(true, [{ targets: ['a/b'] }])).toThrow(
      /Invalid dsh-llm-fallback config: scheduleRules\[0\]/,
    );
    // 窗口值非法 → 非法(路径前缀含规则与窗口下标)
    expect(() =>
      resolveSchedule(true, [
        { targets: ['a/b'], windows: [{ start: 'x', end: '2:00' }] },
      ]),
    ).toThrow(/scheduleRules\[0\]\.windows\[0\]\.start/);
    // 全空占位规则 → 跳过,不抛
    expect(() =>
      resolveSchedule(true, [{ targets: [], windows: [] }]),
    ).not.toThrow();
  });
});

describe('schedule.windowMatches', () => {
  const normal = resolveWindow({ start: '08:30', end: '12:00' });
  const overnight = resolveWindow({ start: '22:00', end: '06:00' });
  const allDay = resolveWindow({ start: '09:00', end: '09:00' });

  it('半开区间:起点命中、终点不命中', () => {
    if ('error' in normal) throw new Error('unreachable');
    expect(windowMatches(normal, 510, 3)).toBe(true); // 08:30 含
    expect(windowMatches(normal, 719, 3)).toBe(true);
    expect(windowMatches(normal, 720, 3)).toBe(false); // 12:00 不含
    expect(windowMatches(normal, 509, 3)).toBe(false);
  });

  it('跨夜窗口:起点后或终点前均命中', () => {
    if ('error' in overnight) throw new Error('unreachable');
    expect(windowMatches(overnight, 22 * 60, 3)).toBe(true); // 22:00 含
    expect(windowMatches(overnight, 23 * 60 + 30, 3)).toBe(true); // 23:30
    expect(windowMatches(overnight, 5 * 60 + 59, 3)).toBe(true); // 05:59
    expect(windowMatches(overnight, 6 * 60, 3)).toBe(false); // 06:00 不含
    expect(windowMatches(overnight, 21 * 60 + 59, 3)).toBe(false); // 21:59
  });

  it('全天窗口任意时刻命中', () => {
    if ('error' in allDay) throw new Error('unreachable');
    expect(windowMatches(allDay, 0, 3)).toBe(true);
    expect(windowMatches(allDay, 1439, 3)).toBe(true);
  });

  it('days 过滤:非生效星期不命中(即使时刻在窗内)', () => {
    const weekdayOnly = resolveWindow({
      start: '08:00',
      end: '09:00',
      days: [1, 2, 3, 4, 5],
    });
    if ('error' in weekdayOnly) throw new Error('unreachable');
    expect(windowMatches(weekdayOnly, 8 * 60 + 30, 3)).toBe(true); // 周三
    expect(windowMatches(weekdayOnly, 8 * 60 + 30, 6)).toBe(false); // 周六
    expect(windowMatches(weekdayOnly, 8 * 60 + 30, 7)).toBe(false); // 周日
  });
});

describe('schedule.targetMatches', () => {
  it('精确 provider/model 匹配', () => {
    expect(targetMatches('deepseek-account/deepseek-chat', candidate)).toBe(
      true,
    );
    expect(targetMatches('deepseek-account/deepseek-reasoner', candidate)).toBe(
      false,
    );
    expect(targetMatches('openai/deepseek-chat', candidate)).toBe(false);
  });

  it('provider/* 通配覆盖该 provider 全部模型', () => {
    expect(targetMatches('deepseek-account/*', candidate)).toBe(true);
    expect(
      targetMatches('deepseek-account/*', {
        provider: 'deepseek-account',
        model: 'future-model',
      }),
    ).toBe(true);
    expect(targetMatches('openai/*', candidate)).toBe(false);
  });

  it('无斜杠目标不命中任何候选(解析层已拒绝,此处为防御)', () => {
    expect(targetMatches('deepseek-account', candidate)).toBe(false);
  });
});

describe('schedule.isScheduleBlocked', () => {
  const weekdayWindow = [{ start: '08:30', end: '12:00' }];

  it('禁用或无规则时恒为 false', () => {
    const off = resolveSchedule(false, [
      { targets: ['deepseek-account/*'], windows: weekdayWindow },
    ]);
    const empty = resolveSchedule(true, []);
    expect(isScheduleBlocked(off, candidate, localTime(9))).toBe(false);
    expect(isScheduleBlocked(empty, candidate, localTime(9))).toBe(false);
  });

  it('窗口内且目标命中 → 阻塞(通配含未来模型)', () => {
    const schedule = resolveSchedule(true, [
      { targets: ['deepseek-account/*'], windows: weekdayWindow },
    ]);
    expect(isScheduleBlocked(schedule, candidate, localTime(9))).toBe(true);
    expect(
      isScheduleBlocked(
        schedule,
        { provider: 'deepseek-account', model: 'new-model' },
        localTime(9),
      ),
    ).toBe(true);
  });

  it('窗口外不阻塞(边界:12:00 起放行)', () => {
    const schedule = resolveSchedule(true, [
      { targets: ['deepseek-account/*'], windows: weekdayWindow },
    ]);
    expect(isScheduleBlocked(schedule, candidate, localTime(8, 29))).toBe(
      false,
    );
    expect(isScheduleBlocked(schedule, candidate, localTime(12, 0))).toBe(
      false,
    );
    expect(isScheduleBlocked(schedule, candidate, localTime(11, 59))).toBe(
      true,
    );
  });

  it('非生效星期不阻塞', () => {
    const schedule = resolveSchedule(true, [
      {
        targets: ['deepseek-account/*'],
        windows: [{ start: '08:30', end: '12:00', days: [6, 7] }],
      },
    ]);
    // 周三 09:00:窗口只在周末生效 → 不阻塞
    expect(isScheduleBlocked(schedule, candidate, localTime(9, 0, 3))).toBe(
      false,
    );
    // 周六 09:00:阻塞
    expect(isScheduleBlocked(schedule, candidate, localTime(9, 0, 6))).toBe(
      true,
    );
  });

  it('跨夜窗口按本地墙钟命中', () => {
    const schedule = resolveSchedule(true, [
      {
        targets: ['deepseek-account/*'],
        windows: [{ start: '22:00', end: '06:00' }],
      },
    ]);
    expect(isScheduleBlocked(schedule, candidate, localTime(23, 30))).toBe(
      true,
    );
    expect(isScheduleBlocked(schedule, candidate, localTime(5, 0))).toBe(true);
    expect(isScheduleBlocked(schedule, candidate, localTime(12, 0))).toBe(
      false,
    );
  });

  it('多规则任一命中即阻塞(目标×窗口独立判定)', () => {
    const schedule = resolveSchedule(true, [
      { targets: ['openai/*'], windows: weekdayWindow },
      {
        targets: ['deepseek-account/deepseek-chat'],
        windows: [{ start: '20:00', end: '21:00' }],
      },
    ]);
    // deepseek-chat 在 20:00-21:00 被第二条规则阻塞;openai 目标与它无关
    expect(isScheduleBlocked(schedule, candidate, localTime(20, 30))).toBe(
      true,
    );
    expect(isScheduleBlocked(schedule, candidate, localTime(9))).toBe(false);
    expect(
      isScheduleBlocked(
        schedule,
        { provider: 'openai', model: 'gpt-4o' },
        localTime(9),
      ),
    ).toBe(true);
    expect(
      isScheduleBlocked(
        schedule,
        { provider: 'openai', model: 'gpt-4o' },
        localTime(20, 30),
      ),
    ).toBe(false); // openai 规则窗口在上午,20:30 不阻塞
  });
});
