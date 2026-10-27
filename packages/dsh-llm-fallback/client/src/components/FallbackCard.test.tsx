// @vitest-environment jsdom
/**
 * FallbackCard 渲染冒烟：真实 React 渲染（jsdom + createRoot，照
 * dsh-open-in-zed 先例）——证明两个渲染位、加载态、勾选→脏→保存的
 * mutate 载荷、revision 冲突与只读降级。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DICT } from '../dict.ts';
import { DEFAULT_TIME_WINDOW_RULES } from '../lib/settings.ts';
import { FallbackCard } from './FallbackCard.tsx';
import type {
  ConfigSnapshot,
  MutationOp,
  RemoteSessionFace,
  TFn,
} from '../types.ts';

/** Radix ScrollArea 依赖 ResizeObserver（jsdom 未实现），空实现垫片。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

/**
 * Poll until the probe passes (React 19 render is concurrent).
 *
 * 预算 300 轮 × 20ms ≈ 6s:全量并发跑时本文件的 worker 可能被其他文件的
 * 计算饿死数秒,原 100×10ms(≈1s)预算在争抢下会被耗尽(预存 flaky,
 * 单文件重跑必过);探针快速通过时多出的 20ms 间隔相对秒级测试时长可忽略。
 */
async function waitFor(probe: () => boolean): Promise<void> {
  for (let round = 0; round < 300; round++) {
    if (probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
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

/**
 * remote.session 假体（可定制）：groups + failures 可注入,ok=false 模拟
 * 目录加载失败(stale 判定的"不误标"路径)。failures 条目 = 宿主把
 * listModels 抛错的 provider 隔离进 failures 而非 groups 的形态。
 */
function fakeSessionOf(
  groups: Array<{ id: string; models: Array<{ id: string; name?: string }> }>,
  failures: Array<{ id: string; name: string; message: string }> = [],
  ok = true,
): RemoteSessionFace {
  return {
    modelCatalog: async () => ({ ok, value: { groups, failures } }),
  };
}

/** 已保存配置:队列含一个有效候选与一个失效候选(prov/ghost 不在目录)。 */
const QUEUE_WITH_GHOST = {
  enabled: true,
  fallbackChains: [
    { provider: 'prov', model: 'm1', displayName: 'prov/m1' },
    { provider: 'prov', model: 'ghost', displayName: 'prov/ghost' },
  ],
};

const t: TFn = (key) => DICT.zh[key] ?? key;

describe('FallbackCard 渲染', () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    root?.unmount();
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
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

  it('勾选模型 → 脏状态 → 保存调用 mutate 携带 8 个 op(含时间窗)与正确 revision', async () => {
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
    // 勾选 prov/m1(目录中的模型行;Radix Checkbox 渲染为 role=checkbox 按钮)
    const modelLabel = [...div.querySelectorAll('label')].find((l) =>
      (l.textContent ?? '').includes('Model One'),
    );
    const checkbox = modelLabel?.querySelector('button[role="checkbox"]');
    expect(checkbox).not.toBeNull();
    (checkbox as HTMLButtonElement).click();
    // 队列出现候选(显示名实时取目录 name,路由键作副文本) + 脏状态提示
    await waitFor(() => div.textContent!.includes('prov/m1'));
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
    // 保存载荷与配置字段同步:6 个基础字段 + 时间窗两字段 = 8 op
    expect(mutation.ops).toHaveLength(8);
    const chains = mutation.ops.find((op) => op.path[0] === 'fallbackChains');
    expect(chains?.value).toEqual([{ provider: 'prov', model: 'm1' }]);
    const twEnabled = mutation.ops.find(
      (op) => op.path[0] === 'timeWindowEnabled',
    );
    expect(twEnabled?.value).toBe(false);
    const twRules = mutation.ops.find((op) => op.path[0] === 'timeWindowRules');
    expect(twRules?.value).toEqual([]);
    // 保存成功后草稿丢弃,脏状态消失
    await waitFor(() => !div.textContent!.includes(t('dirty')));
  });

  it('时间窗开关开启时自动填入官方预置模板,保存载荷同步携带(冲突检测同链路)', async () => {
    const fake = fakeScope();
    const div = mount(
      <FallbackCard t={t} scope={fake.scope} session={fakeSession()} />,
    );
    await waitFor(() => div.textContent!.includes(t('timeWindowEnabled')));
    // 时间窗开关(aria-label 与冷却/总开关区分)
    const twSwitch = [...div.querySelectorAll('button[role="switch"]')].find(
      (b) => b.getAttribute('aria-label') === t('timeWindowEnabled'),
    );
    expect(twSwitch).toBeDefined();
    (twSwitch as HTMLButtonElement).click();
    // D3 预置:规则为空时开启 → 自动填入官方模板(match 输入已带 deepseek-*)
    await waitFor(() =>
      Boolean(div.querySelector(`input[aria-label^="${t('twMatchLabel')}"]`)),
    );
    const matchInput = div.querySelector(
      `input[aria-label^="${t('twMatchLabel')}"]`,
    ) as HTMLInputElement;
    expect(matchInput.value).toBe('deepseek-*');
    expect(div.textContent).toContain(t('dirty'));
    // 保存 → 8 op,timeWindowEnabled=true + 预置规则原样写出
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save'),
    )!;
    saveButton.click();
    await waitFor(() => fake.mutations.length > 0);
    expect(fake.mutations[0]!.ops).toHaveLength(8);
    const enabledOp = fake.mutations[0]!.ops.find(
      (op) => op.path[0] === 'timeWindowEnabled',
    );
    expect(enabledOp?.value).toBe(true);
    const rulesOp = fake.mutations[0]!.ops.find(
      (op) => op.path[0] === 'timeWindowRules',
    );
    expect(rulesOp?.value).toEqual(DEFAULT_TIME_WINDOW_RULES);
  });

  it('时间窗规则非法(空 match / 空 窗口)时保存被阻止并提示', async () => {
    const fake = fakeScope({
      value: {
        timeWindowEnabled: true,
        timeWindowRules: [{ match: '', action: 'block', windows: [] }],
      },
    });
    const div = mount(
      <FallbackCard t={t} scope={fake.scope} session={fakeSession()} />,
    );
    await waitFor(() => div.textContent!.includes(t('twInvalid')));
    // 非法态直接可见(保存闸提示);点击保存 → 不产生 mutate
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save'),
    )!;
    saveButton.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.mutations).toHaveLength(0);
    expect(div.textContent).toContain(t('twInvalid'));
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
      ?.querySelector('button[role="checkbox"]');
    (checkbox as HTMLButtonElement).click();
    await waitFor(() => div.textContent!.includes(t('dirty')));
    // 别处修改:revision 2(fake.push 同步调 setSnap,React 重渲染是调度的
    // ——与真实宿主的推送节奏一致;这里等一拍让卡片重渲染到新快照再点保存。
    // 保存判定读 React state 的 snap.revision,重渲染未落地就点击会走保存
    // 而非冲突;50ms 给并发渲染调度留裕量,与 waitFor 同属并发缓冲)
    fake.push({ revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
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

  it('失效条目渲染失效徽标,有效条目不标;显示名实时取目录 name', async () => {
    const { scope } = fakeScope({ value: QUEUE_WITH_GHOST });
    const div = mount(
      <FallbackCard t={t} scope={scope} session={fakeSession()} />,
    );
    // 两条候选都渲染且目录名已解析:'Model One' 来自目录异步加载
    // (idle→loading→ready 经 effect + 微任务链),只等队列渲染(prov/ghost)
    // 就断言目录名会与加载竞速,worker 饥饿下即 flaky——探测条件必须
    // 覆盖断言条件,断言本身不再有竞态窗口
    await waitFor(
      () =>
        div.textContent!.includes('prov/ghost') &&
        div.textContent!.includes('Model One'),
    );
    expect(div.textContent).toContain('Model One');
    // 失效徽标只出现在 ghost 行(m1 行无徽标);目录异步加载,徽标等它就绪
    const staleBadges = () =>
      [...div.querySelectorAll('span')].filter(
        (s) => s.textContent === t('stale'),
      );
    await waitFor(() => staleBadges().length === 1);
    // 徽标所在行含 ghost 路由键(失效行),不含 m1(有效行)
    const staleRow = staleBadges()[0]!.closest('div.rounded-md');
    expect(staleRow?.textContent).toContain('prov/ghost');
    expect(staleRow?.textContent).not.toContain('Model One');
  });

  it('目录加载失败(ok=false)→ 不标失效(不误标)', async () => {
    const { scope } = fakeScope({ value: QUEUE_WITH_GHOST });
    const div = mount(
      <FallbackCard
        t={t}
        scope={scope}
        session={fakeSessionOf([], [], false)}
      />,
    );
    // 队列照常渲染(条目文本回退路由键)
    await waitFor(() => div.textContent!.includes('prov/ghost'));
    // 目录加载失败文案出现,stale 徽标绝不出现
    await waitFor(() => div.textContent!.includes(t('catalogError')));
    expect(div.textContent).not.toContain(t('stale'));
  });

  it('一键清理:失效条目从队列移除并变脏,保存载荷不含失效项', async () => {
    const fake = fakeScope({ value: QUEUE_WITH_GHOST });
    const div = mount(
      <FallbackCard t={t} scope={fake.scope} session={fakeSession()} />,
    );
    await waitFor(() =>
      Boolean(
        [...div.querySelectorAll('button')].find((b) =>
          (b.getAttribute('aria-label') ?? '').startsWith(t('clearStale')),
        ),
      ),
    );
    // 清理按钮带失效计数
    const clearButton = [...div.querySelectorAll('button')].find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith(t('clearStale')),
    )!;
    expect(clearButton.textContent).toContain('(1)');
    clearButton.click();
    // ghost 从队列消失,m1 保留,进入脏状态
    await waitFor(
      () =>
        !div.textContent!.includes('prov/ghost') &&
        div.textContent!.includes('prov/m1'),
    );
    expect(div.textContent).toContain(t('dirty'));
    // 保存 → 载荷只含有效候选
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save'),
    )!;
    saveButton.click();
    await waitFor(() => fake.mutations.length > 0);
    const chains = fake.mutations[0]!.ops.find(
      (op) => op.path[0] === 'fallbackChains',
    );
    expect(chains?.value).toEqual([{ provider: 'prov', model: 'm1' }]);
  });

  it('保存路径剔除:用户编辑其他字段时直接保存,写入载荷自动不含失效项', async () => {
    const fake = fakeScope({ value: QUEUE_WITH_GHOST });
    const div = mount(
      <FallbackCard t={t} scope={fake.scope} session={fakeSession()} />,
    );
    await waitFor(() => div.textContent!.includes('prov/ghost'));
    // 用户切换 enabled 开关(与失效项无关的编辑)→ dirty
    const enabledSwitch = [...div.querySelectorAll('button[role="switch"]')][0];
    expect(enabledSwitch).toBeDefined();
    (enabledSwitch as HTMLButtonElement).click();
    await waitFor(() => div.textContent!.includes(t('dirty')));
    // 直接保存(未点清理)→ 载荷仍剔除失效项(显式保存动作的一部分)
    const saveButton = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === t('save'),
    )!;
    saveButton.click();
    await waitFor(() => fake.mutations.length > 0);
    const chains = fake.mutations[0]!.ops.find(
      (op) => op.path[0] === 'fallbackChains',
    );
    expect(chains?.value).toEqual([{ provider: 'prov', model: 'm1' }]);
    const enabledOp = fake.mutations[0]!.ops.find(
      (op) => op.path[0] === 'enabled',
    );
    expect(enabledOp?.value).toBe(false);
  });
});
