/**
 * 测试用内存台账（LedgerStore 窄接口的替身）。
 *
 * 行为对齐 host/store.ts 的 mutate 语义：mutator 收到一份新鲜草稿，返回
 * undefined 表示放弃写入；mutator 抛错时草稿不落盘（错误原样冒泡）。
 * 只供本目录单测使用，不参与构建。
 */

import {
  emptyLedger,
  type BoardSettings,
  type TaskLedger,
  type TaskRecord,
} from '../shared/protocol.ts';
import type { LedgerStore } from './task-writer.ts';

/** 变更事件记录。 */
export interface FakeStoreEvent {
  /** 事件类型（与上游 store.mutate 的 kind 同名）。 */
  kind: 'task-created' | 'task-updated' | 'comment-added';
  /** 本次变更涉及的任务 id。 */
  ids: string[];
}

/** 内存台账：实现 LedgerStore，并额外提供测试需要的播种与事件观察能力。 */
export interface FakeStore extends LedgerStore {
  /** 变更事件序列（按发生顺序）。 */
  readonly events: FakeStoreEvent[];
  /** 直接塞入一张卡（用于构造前置/跨项目等场景）。 */
  seed(task: TaskRecord): void;
  /** 覆盖看板设置。 */
  setSettings(settings: BoardSettings | undefined): void;
}

/** 构造一个内存台账。 */
export function createFakeStore(options?: {
  settings?: BoardSettings;
}): FakeStore {
  let ledger: TaskLedger = { ...emptyLedger(), settings: options?.settings };
  const events: FakeStoreEvent[] = [];
  return {
    events,
    snapshot: () => structuredClone(ledger),
    get: (id) => {
      const found = ledger.tasks.find((task) => task.id === id);
      return found === undefined ? undefined : structuredClone(found);
    },
    seed: (task) => {
      ledger = { ...ledger, tasks: [...ledger.tasks, structuredClone(task)] };
    },
    setSettings: (settings) => {
      ledger = { ...ledger, settings };
    },
    mutate: async (kind, mutator) => {
      const draft = structuredClone(ledger);
      const changed = mutator(draft);
      if (changed === undefined) {
        return { ledger: structuredClone(ledger), changed: [] };
      }
      ledger = { ...draft, revision: ledger.revision + 1 };
      events.push({ kind, ids: changed.map((task) => task.id) });
      return {
        ledger: structuredClone(ledger),
        changed: structuredClone(changed),
      };
    },
  };
}
