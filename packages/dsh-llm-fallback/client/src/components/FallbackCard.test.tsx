// @vitest-environment jsdom
/**
 * FallbackCard 渲染冒烟：真实 React 渲染（jsdom + createRoot，照
 * dsh-open-in-zed 先例）——证明两个渲染位、加载态、勾选→脏→保存的
 * mutate 载荷、revision 冲突与只读降级。
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DICT } from '../dict.ts';
import { FallbackCard } from './FallbackCard.tsx';
import type {
  ConfigSnapshot,
  MutationOp,
  RemoteSessionFace,
  TFn,
} from '../types.ts';

/** Poll until the probe passes (React 19 render is concurrent). */
async function waitFor(probe: () => boolean): Promise<void> {
  for (let round = 0; round < 100; round++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor: condition never became true');
}

/** configForms scope 假体：快照可推送、mutate 记录载荷。 */
function fakeScope(initial: Partial<ConfigSnapshot> = {}): {
  scope: {
    getSnapshot(): ConfigSnapshot;
    subscribe(fn: () => void): () => void;
    mutate(ops: MutationOp[], revision: number): Promise<void>;
  };
  push(patch: Partial<ConfigSnapshot>): void;
  mutations: Array<{ ops: MutationOp[]; revision: number }>;
} {
  let snapshot: ConfigSnapshot = {
    status: 'ready',
    value: {},
    writable: true,
    revision: 1,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const mutations: Array<{ ops: MutationOp[]; revision: number }> = [];
  return {
    scope: {
      getSnapshot: () => snapshot,
      subscribe(fn) {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
      mutate(ops, revision) {
        mutations.push({ ops, revision });
        return Promise.resolve();
      },
    },
    push(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const fn of listeners) fn();
    },
    mutations,
  };
}

/** remote.session 假体：单 provider 单模型目录。 */
function fakeSession(): RemoteSessionFace {
  return {
    modelCatalog: async () => ({
      ok: true,
      value: {
        groups: [{ id: 'prov', models: [{ id: 'm1', name: 'Model One' }] }],
      },
    }),
  };
}

const t: TFn = (key) => DICT.zh[key] ?? key;

describe('FallbackCard 渲染', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
  });

  /** 挂载一卡片（React 19 并发渲染，断言配合 waitFor 轮询）。 */
  function mount(node: React.ReactNode): HTMLDivElement {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(node);
    return host;
  }

  it('summary 视图只渲染一句话说明,不渲染表单', async () => {
    const { scope } = fakeScope();
    const div = mount(
      <FallbackCard
        t={t}
        scope={scope}
        session={fakeSession()}
        view="summary"
      />,
    );
    await waitFor(() => div.textContent !== '');
    expect(div.textContent).toBe(t('intro'));
    expect(div.textContent).not.toContain(t('save'));
  });

  it('非 ready 快照渲染载入/不可用文案', async () => {
    const { scope } = fakeScope({ status: 'loading' });
    const div = mount(
      <FallbackCard t={t} scope={scope} session={fakeSession()} />,
    );
    await waitFor(() => div.textContent === t('loading'));
    expect(div.textContent).toBe(t('loading'));
  });

  it('勾选模型 → 脏状态 → 保存调用 mutate 携带 6 个 op 与正确 revision', async () => {
    const fake = fakeScope();
    const div = mount(
      <FallbackCard t={t} scope={fake.scope} session={fakeSession()} />,
    );
    // 目录加载完成(模型名出现)
    await waitFor(() =>
      Boolean(
        [...div.querySelectorAll('label')].find((l) =>
          (l.textContent ?? '').includes('Model One'),
        ),
      ),
    );
    // 勾选 prov/m1(目录中的模型行)
    const modelLabel = [...div.querySelectorAll('label')].find((l) =>
      (l.textContent ?? '').includes('Model One'),
    );
    const checkbox = modelLabel?.querySelector('input');
    expect(checkbox).not.toBeNull();
    checkbox!.click();
    // 队列出现候选 + 脏状态提示
    await waitFor(() => div.textContent!.includes('prov / m1'));
    expect(div.textContent).toContain(t('dirty'));
    // 保存
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save'),
    );
    expect(saveButton).toBeDefined();
    saveButton!.click();
    await waitFor(() => fake.mutations.length > 0);
    const mutation = fake.mutations[0];
    expect(mutation.revision).toBe(1);
    expect(mutation.ops).toHaveLength(6);
    const chains = mutation.ops.find((op) => op.path[0] === 'fallbackChains');
    expect(chains?.value).toEqual([{ provider: 'prov', model: 'm1' }]);
    // 保存成功后草稿丢弃,脏状态消失
    await waitFor(() => !div.textContent!.includes(t('dirty')));
  });

  it('草稿期间快照 revision 变化 → 保存显示冲突文案', async () => {
    const fake = fakeScope();
    const div = mount(
      <FallbackCard t={t} scope={fake.scope} session={fakeSession()} />,
    );
    await waitFor(() =>
      Boolean(
        [...div.querySelectorAll('label')].find((l) =>
          (l.textContent ?? '').includes('Model One'),
        ),
      ),
    );
    const checkbox = [...div.querySelectorAll('label')]
      .find((l) => (l.textContent ?? '').includes('Model One'))
      ?.querySelector('input');
    checkbox!.click();
    await waitFor(() => div.textContent!.includes(t('dirty')));
    // 别处修改:revision 2(fake.push 同步调 setSnap,React 重渲染是调度的
    // ——与真实宿主的推送节奏一致;这里等一拍让卡片重渲染到新快照再点保存)
    fake.push({ revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save'),
    );
    saveButton!.click();
    await waitFor(() => div.textContent!.includes(t('conflict')));
    expect(fake.mutations).toHaveLength(0);
  });

  it('只读连接:保存按钮禁用并显示只读文案', async () => {
    const { scope } = fakeScope({ writable: false });
    const div = mount(
      <FallbackCard t={t} scope={scope} session={fakeSession()} />,
    );
    await waitFor(() => div.textContent!.includes(t('readonly')));
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save') || b.textContent === t('saving'),
    );
    expect(saveButton?.disabled).toBe(true);
  });
});
