// @vitest-environment jsdom
/**
 * AnytypeCard 渲染冒烟：真实 React 渲染（jsdom + createRoot）——证明两个
 * 渲染位、加载态、**密钥只写**语义、勾选→脏→保存的 mutate 载荷、两行各自
 * 的写入栅栏、revision 冲突与只读降级。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ROW_MAIN, ROW_MEMORY } from '../constants.ts';
import { DICT } from '../dict.ts';
import type {
  ConfigFormsFace,
  ConfigScope,
  ConfigSnapshot,
  DescribeFace,
  MutationOp,
  NamespaceView,
  TFn,
} from '../types.ts';
import { AnytypeCard } from './AnytypeCard.tsx';

/** Radix Switch/Checkbox 依赖 ResizeObserver（jsdom 未实现），空实现垫片。 */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const t: TFn = (key) => DICT.zh[key] ?? key;

/**
 * Poll until the probe passes (React 19 render is concurrent).
 *
 * 预算 300 轮 × 20ms ≈ 6s：探针快速通过时多出的间隔相对秒级测试时长可忽略。
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
  scope: ConfigScope;
  push(patch: Partial<ConfigSnapshot>): void;
  mutations: Array<{ ops: MutationOp[]; revision: number | undefined }>;
} {
  let snapshot: ConfigSnapshot = {
    status: 'ready',
    value: {},
    base: undefined,
    user: undefined,
    writable: true,
    revision: 1,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const mutations: Array<{ ops: MutationOp[]; revision: number | undefined }> =
    [];
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
        mutations.push({ ops: [...ops], revision });
        snapshot = {
          ...snapshot,
          revision: (snapshot.revision ?? 0) + 1,
        };
        return Promise.resolve(true);
      },
    },
    push(patch) {
      snapshot = { ...snapshot, ...patch };
      for (const fn of listeners) fn();
    },
    mutations,
  };
}

/** configForms 服务假体：两个插件行各一个 scope + describe 面（secret 状态）。 */
function fakeForms(
  options: {
    main?: Partial<ConfigSnapshot>;
    memory?: Partial<ConfigSnapshot>;
    secretSet?: boolean;
  } = {},
): {
  configForms: ConfigFormsFace;
  main: ReturnType<typeof fakeScope>;
  memory: ReturnType<typeof fakeScope>;
} {
  const main = fakeScope(options.main);
  const memory = fakeScope(options.memory);
  const namespaces: NamespaceView[] = [
    {
      ns: ROW_MAIN,
      autoGenerate: true,
      value: {},
      secrets: [{ path: ['apiKey'], set: options.secretSet === true }],
      revision: 1,
    },
    {
      ns: ROW_MEMORY,
      autoGenerate: true,
      value: {},
      secrets: [],
      revision: 1,
    },
  ];
  const describeFace: DescribeFace = {
    getSnapshot: () => ({
      status: 'ready',
      view: { namespaces, writable: true, hasDocument: true },
      error: null,
    }),
    subscribe() {
      return () => undefined;
    },
    ensure: () => Promise.resolve(),
  };
  const configForms: ConfigFormsFace = {
    get: (id) => (id === ROW_MAIN ? main.scope : memory.scope),
    whileServed: (_ns, register) => register(new Set([ROW_MAIN, ROW_MEMORY])),
    describe: () => describeFace,
  };
  return { configForms, main, memory };
}

/** 触发 React 受控输入的 onChange（直接赋值不触发 React 事件）。 */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AnytypeCard 渲染', () => {
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

  /** 按 aria-label 找输入框。 */
  function inputByLabel(div: HTMLElement, label: string): HTMLInputElement {
    const input = div.querySelector(`input[aria-label="${label}"]`);
    if (!input) throw new Error(`未找到输入框: ${label}`);
    return input as HTMLInputElement;
  }

  /** 按文案找按钮。 */
  function buttonByText(div: HTMLElement, text: string): HTMLButtonElement {
    const button = [...div.querySelectorAll('button')].find(
      (b) => b.textContent === text,
    );
    if (!button) throw new Error(`未找到按钮: ${text}`);
    return button as HTMLButtonElement;
  }

  it('summary 视图只渲染一句话说明，不渲染表单', async () => {
    const { configForms } = fakeForms();
    const div = mount(
      <AnytypeCard t={t} configForms={configForms} view="summary" />,
    );
    await waitFor(() => div.textContent !== '');
    expect(div.textContent).toBe(t('intro'));
    // summary 位不渲染表单控件（保存按钮不存在）
    expect(div.querySelector('button')).toBeNull();
  });

  it('非 ready 快照渲染载入/不可用文案', async () => {
    const { configForms } = fakeForms({
      main: { status: 'loading' },
      memory: { status: 'loading' },
    });
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent === t('loading'));
    expect(div.textContent).toBe(t('loading'));
  });

  it('改 baseUrl → 脏状态 → 保存调用行①的 mutate 携带正确 op 与 revision', async () => {
    const { configForms, main, memory } = fakeForms();
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('sectionConnection')));

    const input = inputByLabel(div, t('baseUrl'));
    setInputValue(input, 'http://127.0.0.1:32000');
    await waitFor(() => div.textContent!.includes(t('dirty')));

    buttonByText(div, t('save')).click();
    await waitFor(() => main.mutations.length > 0);
    expect(main.mutations[0]!.revision).toBe(1);
    expect(main.mutations[0]!.ops).toEqual([
      { op: 'set', path: ['baseUrl'], value: 'http://127.0.0.1:32000' },
    ]);
    // 记忆行没改动 → 不产生写入
    expect(memory.mutations).toHaveLength(0);
    // 保存成功后草稿丢弃
    await waitFor(() => !div.textContent!.includes(t('dirty')));
  });

  it('密钥只写：未改动时载荷不含 apiKey，输入新值才写，点清除发 unset', async () => {
    const { configForms, main } = fakeForms({ secretSet: true });
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('sectionConnection')));

    // 已配置徽标（值不显示在输入框里）
    expect(div.textContent).toContain(t('apiKeySet'));
    const secret = inputByLabel(div, t('apiKey'));
    expect(secret.value).toBe('');

    // 只改别的字段 → 载荷不含 apiKey
    setInputValue(inputByLabel(div, t('apiVersion')), '2026-01-01');
    await waitFor(() => div.textContent!.includes(t('dirty')));
    buttonByText(div, t('save')).click();
    await waitFor(() => main.mutations.length > 0);
    // 等保存走完（草稿丢弃、脏状态消失）——否则下一轮编辑会被随后的
    // discard 抹掉（真实界面里保存期间控件是禁用的，测试需显式等）。
    await waitFor(() => !div.textContent!.includes(t('dirty')));
    expect(
      main.mutations[0]!.ops.some((op) => op.path[0] === 'apiKey'),
      '未改动的密钥不得进入写入载荷',
    ).toBe(false);

    // 输入新密钥 → 载荷含 set apiKey
    main.mutations.length = 0;
    setInputValue(inputByLabel(div, t('apiKey')), 'anytype_secret');
    await waitFor(() => div.textContent!.includes(t('dirty')));
    buttonByText(div, t('save')).click();
    await waitFor(() => main.mutations.length > 0);
    const op = main.mutations[0]!.ops.find((o) => o.path[0] === 'apiKey');
    expect(op).toEqual({
      op: 'set',
      path: ['apiKey'],
      value: 'anytype_secret',
    });
  });

  it('显式清除密钥发 unset op（回落组合层默认值）', async () => {
    const { configForms, main } = fakeForms({ secretSet: true });
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('sectionConnection')));
    const clear = [...div.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === t('apiKeyClear'),
    );
    expect(clear).toBeDefined();
    (clear as HTMLButtonElement).click();
    await waitFor(() => div.textContent!.includes(t('dirty')));
    buttonByText(div, t('save')).click();
    await waitFor(() => main.mutations.length > 0);
    expect(main.mutations[0]!.ops).toEqual([{ op: 'unset', path: ['apiKey'] }]);
  });

  it('记忆行字段写入行②的 scope（连接行不产生写入）', async () => {
    const { configForms, main, memory } = fakeForms();
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('sectionMemory')));
    setInputValue(inputByLabel(div, t('spaceName')), 'Notes');
    await waitFor(() => div.textContent!.includes(t('dirty')));
    buttonByText(div, t('save')).click();
    await waitFor(() => memory.mutations.length > 0);
    expect(memory.mutations[0]!.ops).toEqual([
      { op: 'set', path: ['spaceName'], value: 'Notes' },
    ]);
    expect(main.mutations).toHaveLength(0);
  });

  it('工具组勾选写入 disabledGroups 数组', async () => {
    const { configForms, main } = fakeForms();
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('disabledGroups')));
    const checkbox = div.querySelector(
      'button[role="checkbox"][aria-label="generic"]',
    );
    expect(checkbox).not.toBeNull();
    (checkbox as HTMLButtonElement).click();
    await waitFor(() => div.textContent!.includes(t('dirty')));
    buttonByText(div, t('save')).click();
    await waitFor(() => main.mutations.length > 0);
    const op = main.mutations[0]!.ops.find(
      (o) => o.path[0] === 'disabledGroups',
    );
    expect(op).toEqual({
      op: 'set',
      path: ['disabledGroups'],
      value: ['generic'],
    });
  });

  it('草稿期间快照 revision 变化 → 保存显示冲突文案且不写入', async () => {
    const { configForms, main } = fakeForms();
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('sectionConnection')));
    setInputValue(inputByLabel(div, t('baseUrl')), 'http://127.0.0.1:32000');
    await waitFor(() => div.textContent!.includes(t('dirty')));
    // 别处修改：revision 2（推送后卡片重渲染，等一拍再点保存）
    main.push({ revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    buttonByText(div, t('save')).click();
    await waitFor(() => div.textContent!.includes(t('conflict')));
    expect(main.mutations).toHaveLength(0);
  });

  it('非法 API 地址：保存被阻止并给出提示', async () => {
    const { configForms, main } = fakeForms();
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('sectionConnection')));
    setInputValue(inputByLabel(div, t('baseUrl')), 'not-a-url');
    await waitFor(() => div.textContent!.includes(t('dirty')));
    buttonByText(div, t('save')).click();
    await waitFor(() => div.textContent!.includes(t('invalidBaseUrl')));
    expect(main.mutations).toHaveLength(0);
  });

  it('只读连接：保存按钮禁用并显示只读文案', async () => {
    const { configForms } = fakeForms({
      main: { writable: false },
      memory: { writable: false },
    });
    const div = mount(<AnytypeCard t={t} configForms={configForms} />);
    await waitFor(() => div.textContent!.includes(t('readonly')));
    const save = buttonByText(div, t('save'));
    expect(save.disabled).toBe(true);
  });
});
