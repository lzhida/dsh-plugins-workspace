/**
 * 依赖总开关（上游 0.10.1 新增 `dependenciesEnabled`）的语义契约测试。
 *
 * 覆盖四件事：
 * 1. 缺省语义——上游缺省**关闭**（`settings?.dependenciesEnabled ?? false`）；
 * 2. 四类门禁（agent / manual / scheduled / review）随总开关一起关停；
 * 3. `assertNotReferenced`（删除 / 归档被引用任务时的保护）随总开关早退；
 * 4. `asBoardSettings` 对 `dependenciesEnabled` 的布尔校验。
 *
 * 这些函数在 `shared/dependencies.ts` 与 `shared/protocol.ts`（上游 vendored
 * 文件），本地层与宿主层共用同一真源，因此用例放在 src/local（不计入
 * 「63 个 vendored 文件」的逐字基线）。
 */

import { describe, expect, it } from 'vitest';
import {
  assertNotReferenced,
  dependenciesEnabled,
  gateEnabled,
} from '../shared/dependencies.ts';
import { asBoardSettings } from '../shared/protocol.ts';
import { createFakeStore } from './fake-store.ts';
import { createTask, type TaskWriterDeps } from './task-writer.ts';
import type { Actor } from '../shared/protocol.ts';

/** 固定时钟，保证断言可复现。 */
const NOW = 1_700_000_000_000;

/** 记录者。 */
const actor: Actor = { kind: 'agent', sessionId: 'sess-1' };

/** 构造写手依赖（台账 + 固定时钟）。 */
function writerFor(store: ReturnType<typeof createFakeStore>): TaskWriterDeps {
  return {
    store,
    now: () => NOW,
    settings: () => store.snapshot().settings,
  };
}

describe('dsh-taskboard 依赖总开关（上游 0.10.1）', () => {
  describe('缺省语义', () => {
    it('未设置看板设置时视为关闭', () => {
      expect(dependenciesEnabled(undefined)).toBe(false);
    });

    it('看板设置里没有 dependenciesEnabled 字段时视为关闭', () => {
      expect(dependenciesEnabled({})).toBe(false);
    });

    it('显式关（false）与显式开（true）按值透传', () => {
      expect(dependenciesEnabled({ dependenciesEnabled: false })).toBe(false);
      expect(dependenciesEnabled({ dependenciesEnabled: true })).toBe(true);
    });
  });

  describe('门禁随总开关关停', () => {
    it('总开关关闭时四类门禁一律关停（即便逐项开关为开）', () => {
      const settings = {
        dependenciesEnabled: false,
        dependencyGates: {
          agent: true,
          manual: true,
          scheduled: true,
          review: true,
        },
      };
      expect(gateEnabled(settings, 'agent')).toBe(false);
      expect(gateEnabled(settings, 'manual')).toBe(false);
      expect(gateEnabled(settings, 'scheduled')).toBe(false);
      expect(gateEnabled(settings, 'review')).toBe(false);
    });

    it('总开关开启时逐项门禁开关各自生效', () => {
      const settings = {
        dependenciesEnabled: true,
        dependencyGates: { agent: false, review: true },
      };
      expect(gateEnabled(settings, 'agent')).toBe(false);
      expect(gateEnabled(settings, 'manual')).toBe(true);
      expect(gateEnabled(settings, 'scheduled')).toBe(true);
      expect(gateEnabled(settings, 'review')).toBe(true);
    });
  });

  describe('被引用任务的删除 / 归档保护随总开关早退', () => {
    it('总开关关闭时允许删除被引用的前置任务', async () => {
      const store = createFakeStore();
      store.setSettings({ dependenciesEnabled: true });
      const prior = await createTask(
        { title: '前置', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      await createTask(
        {
          title: '后继',
          workspaceId: 'ws-1',
          urgency: 'normal',
          blockedBy: [prior.id],
        },
        actor,
        writerFor(store),
      );
      store.setSettings({ dependenciesEnabled: false });

      expect(() =>
        assertNotReferenced(store.snapshot(), prior.id),
      ).not.toThrow();
    });

    it('总开关开启时删除被引用的前置任务报「被引用」', async () => {
      const store = createFakeStore();
      store.setSettings({ dependenciesEnabled: true });
      const prior = await createTask(
        { title: '前置', workspaceId: 'ws-1', urgency: 'normal' },
        actor,
        writerFor(store),
      );
      const target = await createTask(
        {
          title: '后继',
          workspaceId: 'ws-1',
          urgency: 'normal',
          blockedBy: [prior.id],
        },
        actor,
        writerFor(store),
      );

      expect(() => assertNotReferenced(store.snapshot(), prior.id)).toThrow(
        `task is referenced by: 后继 (${target.id})`,
      );
    });
  });

  describe('asBoardSettings 对 dependenciesEnabled 的解析', () => {
    it('显式布尔值被透传', () => {
      expect(
        asBoardSettings({ dependenciesEnabled: true }).dependenciesEnabled,
      ).toBe(true);
      expect(
        asBoardSettings({ dependenciesEnabled: false }).dependenciesEnabled,
      ).toBe(false);
    });

    it('缺省时不写入该字段（落到 dependenciesEnabled 的缺省关闭语义）', () => {
      expect(asBoardSettings({}).dependenciesEnabled).toBeUndefined();
      expect(dependenciesEnabled(asBoardSettings({}))).toBe(false);
    });

    it('非布尔值报 dependenciesEnabled must be a boolean', () => {
      expect(() => asBoardSettings({ dependenciesEnabled: 'yes' })).toThrow(
        'dependenciesEnabled must be a boolean',
      );
    });
  });
});
