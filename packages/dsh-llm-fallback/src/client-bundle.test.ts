import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { PKG_NAME } from '../client/src/constants.ts';
import { DICT } from '../client/src/dict.ts';
import {
  filteredCatalogGroups,
  modelMatches,
} from '../client/src/lib/catalog.ts';
import { apply } from '../client/src/plugin.tsx';

/** 读包目录下相对文件（产物 sanity 断言用）。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

// ── 构建与发布契约（包名/条目 id/导出/构建链）────────────────────────

describe('dsh-llm-fallback client 契约', () => {
  it('PKG_NAME 与 package.json 包名同步（boot graph 与 keyed 插槽双契约）', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      name: string;
      exports: Record<string, string>;
      scripts: Record<string, string>;
    };
    // __ModuleLoader__.load 的 id 若与包名不一致，web boot 抛
    // "loaded without registering"，client 配置卡整体失效——曾因包改名
    // 漏改该硬编码发布过坏版本(0.3.0)，此断言防回归。
    expect(PKG_NAME).toBe(pkg.name);
    // plugins.bundle.config 插槽 keyed by 包名，不一致则详情页不渲染配置卡。
    // （同一常量两用，上断言已覆盖；此处再锁 exports['./client'] 产物路径。）
    expect(pkg.exports['./client']).toBe('./client/index.js');
    // 构建链：client 产物由 scripts/build-client.ts 打出（防构建脚本被误删），
    // 且脚本包含 Tailwind CSS 管线（theme.css 编译 + @tailwindcss/cli）。
    expect(pkg.scripts['build:client']).toContain('scripts/build-client.ts');
    const buildScript = readPackageFile('../scripts/build-client.ts');
    expect(buildScript).toContain('client/src/main.tsx');
    expect(buildScript).toContain('client/index.js');
    expect(buildScript).toContain('client/src/theme.css');
    expect(buildScript).toContain('@tailwindcss/cli');
  });

  it('shadcn/ui 新依赖全部声明在 package.json devDependencies', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys(pkg.devDependencies ?? {});
    // 样式与组件体系依赖：Tailwind v4 + Radix 原语 + CVA 工具链。
    // 均为构建期依赖（bundle 进产物），保持 devDependencies 不进运行时。
    for (const name of [
      'tailwindcss',
      '@tailwindcss/cli',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
      '@radix-ui/react-switch',
      '@radix-ui/react-checkbox',
      '@radix-ui/react-scroll-area',
    ]) {
      expect(declared, `${name} 应声明在 devDependencies`).toContain(name);
    }
  });

  it('ENTRY_NS 与 cordis.patch.yml 的条目 id 同步（设置 namespace 契约）', () => {
    const patch = readPackageFile('../cordis.patch.yml');
    expect(patch).toContain('id: dsh-llm-fallback');
  });

  it('client 产物在模块表沙箱中注册成功且 id === PKG_NAME（加载级 sanity）', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      name: string;
    };
    const source = readPackageFile('../client/index.js');
    const registered: Array<{
      id: string;
      factory: (require: (spec: string) => unknown) => unknown;
    }> = [];
    // 产物顶层只执行 load 注册；模块体（含 react require 与 <style> 注入）
    // 在 factory 闭包内，materialize 时经宿主模块表解析。
    // react 桩：Radix 经 esbuild __toESM 互操作消费 react（按
    // getOwnPropertyNames 复制属性），因此必须提供真实属性对象而非 Proxy；
    // 模块作用域只创建组件/Context 不渲染，工厂透传、hooks 返回安全值。
    const REACT_EXPORT_NAMES = [
      'Children',
      'Component',
      'Fragment',
      'Profiler',
      'PureComponent',
      'StrictMode',
      'Suspense',
      'cloneElement',
      'createContext',
      'createElement',
      'createFactory',
      'createRef',
      'forwardRef',
      'isValidElement',
      'lazy',
      'memo',
      'startTransition',
      'unstable_act',
      'useCallback',
      'useContext',
      'useDebugValue',
      'useDeferredValue',
      'useEffect',
      'useId',
      'useImperativeHandle',
      'useInsertionEffect',
      'useLayoutEffect',
      'useMemo',
      'useOptimistic',
      'useReducer',
      'useRef',
      'useState',
      'useSyncExternalStore',
      'useTransition',
      'version',
    ];
    const reactStub: Record<string, unknown> = {};
    for (const name of REACT_EXPORT_NAMES) {
      if (name === 'Fragment' || name === 'StrictMode') {
        reactStub[name] = null;
      } else if (name === 'createContext') {
        reactStub[name] = () => ({ Provider: null, Consumer: null });
      } else if (name === 'forwardRef' || name === 'memo') {
        reactStub[name] = (fn: unknown) => fn;
      } else if (name === 'useRef') {
        reactStub[name] = () => ({ current: null });
      } else if (name === 'useMemo') {
        reactStub[name] = (compute: () => unknown) => compute();
      } else if (name === 'useCallback') {
        reactStub[name] = (fn: unknown) => fn;
      } else if (name === 'useState' || name === 'useReducer') {
        reactStub[name] = () => [null, () => undefined];
      } else if (name.startsWith('use')) {
        reactStub[name] = () => undefined;
      } else {
        reactStub[name] = () => null;
      }
    }
    // Radix 组件（react-primitive）经 jsx-runtime 与 react-dom 解析；
    // 宿主 seed 表提供两者，沙箱里给同形空实现即可完成 materialize。
    const jsxRuntimeStub = {
      jsx: () => null,
      jsxs: () => null,
      Fragment: null,
    };
    const reactDomStub = { flushSync: (fn: () => void) => fn() };
    const sandbox: Record<string, unknown> = {
      __ModuleLoader__: {
        load: (definition: (typeof registered)[number]) => {
          registered.push(definition);
        },
      },
    };
    runInNewContext(source, sandbox);
    const registration = registered[0];
    if (!registration) {
      throw new Error('client 产物未向 __ModuleLoader__ 注册');
    }
    // id 由构建脚本从 package.json 读取（banner 字面量防漂移双保险）。
    expect(registration.id).toBe(pkg.name);
    expect(source).toContain(pkg.name);
    // materialize：factory 执行（组件渲染路径由 FallbackCard.test.tsx 与
    // e2e 浏览器级验证覆盖）。
    const exports = registration.factory((spec: string) => {
      if (spec === 'react') return reactStub;
      if (spec === 'react/jsx-runtime') return jsxRuntimeStub;
      if (spec === 'react-dom') return reactDomStub;
      throw new Error(`沙箱未实现的宿主模块请求: ${spec}`);
    }) as {
      name: string;
      inject: string[];
      apply: unknown;
    };
    expect(exports.name).toBe('llm-fallback');
    expect(exports.inject).toContain('configForms');
    expect(typeof exports.apply).toBe('function');
  });
});

// ── 字典与主题 token ────────────────────────────────────────────────

describe('配置卡字典与主题', () => {
  it('字典 zh/en 键集一致且无空文案（缺译 / 漏译防回归）', () => {
    const zhKeys = Object.keys(DICT.zh).sort();
    const enKeys = Object.keys(DICT.en).sort();
    expect(zhKeys).toEqual(enKeys);
    expect(zhKeys.length).toBeGreaterThan(20);
    for (const [locale, dict] of Object.entries(DICT)) {
      for (const [key, value] of Object.entries(dict)) {
        expect(
          typeof value === 'string' && value.length > 0,
          `${locale}.${key} 应为非空字符串`,
        ).toBe(true);
      }
    }
  });

  it('样式产物接入 dsh 主题 token（明暗双模式），不再硬编码灰阶', () => {
    // Tailwind 语义 token 经 @theme inline 全部内联为宿主 --dsw-alias-*
    // var() 引用（客户端 Theme inspect 提供方列出的 alias token，明暗
    // 双模式各有定义）；产物即样式注入字符串的载体，直接断言。
    const client = readPackageFile('../client/index.js');
    for (const token of [
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-brand-primary',
      '--dsw-alias-switch-thumb',
    ]) {
      expect(client, `bundle 应引用 ${token}`).toContain(token);
    }
    // 旧硬编码灰阶 rgba(128,128,128,*) 是暗色模式混色看不清的根因，防回归。
    expect(client).not.toContain('rgba(128,128,128');
  });

  it('bundle 无第二份 React（react / react-dom external 纪律）', () => {
    const client = readPackageFile('../client/index.js');
    // 模块体保持 factory 内 require，由宿主 seed 表解析宿主副本；
    // 出现 react-dom 生产包 license 头 = 打包了第二份 React（hooks 跨副本
    // 调用会崩），构建断言之外再测一道。
    expect(client).toContain('require("react")');
    expect(client).not.toContain('react-dom.production');
    // Tailwind 产物已内联且带样式挂载标记（theme.ts 运行时注入）。
    expect(client).toContain('data-plugin-css');
  });
});

// ── 模型搜索过滤纯函数 ──────────────────────────────────────────────

describe('模型搜索过滤纯函数', () => {
  const groups = [
    {
      id: 'glm-coding-plan',
      models: [
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
        { id: 'glm-5.3', name: 'GLM 5.3' },
      ],
    },
    {
      id: 'deepseek',
      models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }],
    },
  ];

  it('空搜索词(含纯空白)不过滤,返回全部分组', () => {
    expect(filteredCatalogGroups(groups, '')).toHaveLength(2);
    expect(filteredCatalogGroups(groups, '   ')).toHaveLength(2);
  });

  it('按模型 id / 显示名 / provider 分组名大小写不敏感子串过滤', () => {
    // 模型 id
    const byId = filteredCatalogGroups(groups, 'FLASH');
    expect(byId).toHaveLength(1);
    expect(byId[0].id).toBe('glm-coding-plan');
    expect(byId[0].models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
    // 显示名
    const byName = filteredCatalogGroups(groups, 'deepseek chat');
    expect(byName).toHaveLength(1);
    expect(byName[0].models.map((m) => m.id)).toEqual(['deepseek-chat']);
    // provider 分组名命中 → 该组全部模型保留
    const byProvider = filteredCatalogGroups(groups, 'GLM-CODING');
    expect(byProvider).toHaveLength(1);
    expect(byProvider[0].models).toHaveLength(2);
    // 谓词与过滤管线结果一致
    expect(modelMatches(groups[1], groups[1].models[0], 'CHAT')).toBe(true);
    expect(modelMatches(groups[1], groups[1].models[0], 'glm')).toBe(false);
  });

  it('无任何命中时返回空数组(UI 据此渲染空态文案)', () => {
    expect(filteredCatalogGroups(groups, '不存在的模型')).toEqual([]);
  });
});

// ── apply 行为（stub ctx，不渲染）───────────────────────────────────

/** 与 LocaleRuntime.bind/translate 同语义的最小 locale 假体(bind 按 ns 缓存)。 */
function fakeLocale(initial: 'zh' | 'en' = 'zh'): {
  bind: (ns: string) => (key: string) => string;
  register: (ns: string, dict: unknown) => () => void;
  getSnapshot: () => { active: string; revision: number };
  subscribe: (fn: () => void) => () => void;
  switchTo: (lang: 'zh' | 'en') => void;
  registered: Map<string, unknown>;
} {
  let active = initial;
  let revision = 0;
  const registered = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const bound = new Map<string, (key: string) => string>();
  return {
    bind(ns) {
      let t = bound.get(ns);
      if (!t) {
        t = (key: string) => {
          const dict = registered.get(ns) as
            Record<string, Record<string, string>> | undefined;
          // 与 LocaleRuntime.translate 一致:激活语言 → en → key 原样
          return dict?.[active]?.[key] ?? dict?.en?.[key] ?? key;
        };
        bound.set(ns, t);
      }
      return t;
    },
    register(ns, dict) {
      registered.set(ns, dict);
      revision += 1;
      for (const fn of listeners) fn();
      return () => {
        registered.delete(ns);
      };
    },
    getSnapshot: () => ({ active, revision }),
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    switchTo(lang) {
      if (active === lang) return;
      active = lang;
      revision += 1;
      for (const fn of listeners) fn();
    },
    registered,
  };
}

/** apply 的最小 ctx 假体:effect 立即执行,slots/configForms 记录。 */
function stubClientCtx(locale: ReturnType<typeof fakeLocale> | null): {
  ctx: Parameters<typeof apply>[0];
  slotRegistrations: Array<{
    options: { name: string; key?: string; locale?: string };
    component: unknown;
  }>;
  cleanups: Array<() => void>;
} {
  const slotRegistrations: Array<{
    options: { name: string; key?: string; locale?: string };
    component: unknown;
  }> = [];
  const cleanups: Array<() => void> = [];
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: {},
      writable: true,
      revision: 1,
    }),
    subscribe: () => () => undefined,
    mutate: () => Promise.resolve(),
  };
  const ctx = {
    effect(fn: () => unknown): void {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose as () => void);
    },
    ...(locale === null ? {} : { locale }),
    configForms: {
      get: () => scope,
      whileServed: (_ns: string[], register: () => unknown) => {
        const dispose = register();
        if (typeof dispose === 'function') cleanups.push(dispose as () => void);
      },
    },
    slots: {
      inject: (_name: string, registrar: () => unknown) => registrar(),
      register: (
        options: { name: string; key?: string; locale?: string },
        component: unknown,
      ) => {
        // 与 ctx.slots.register(options, component) 形态一致:第一个参数
        // 就是注册 options({name, key, locale, inject})。
        slotRegistrations.push({ options, component });
        return () => undefined;
      },
    },
    remote: { session: { modelCatalog: () => Promise.resolve({ ok: false }) } },
  };
  return { ctx, slotRegistrations, cleanups };
}

describe('配置卡国际化（apply 行为）', () => {
  it('跟随 dsh 语言配置:注册 llm-fallback 命名空间,t 按激活语言即时解析', () => {
    const locale = fakeLocale('zh');
    const { ctx, slotRegistrations } = stubClientCtx(locale);
    expect(() => apply(ctx)).not.toThrow();
    // 字典已注册进 locale 服务
    expect(locale.registered.has('llm-fallback')).toBe(true);
    // 配置卡挂在 keyed 插槽上,key = 包名、locale = 字典命名空间
    const registration = slotRegistrations.find(
      (r) => r.options.name === 'plugins.bundle.config',
    );
    if (!registration) {
      throw new Error('plugins.bundle.config 插槽未注册');
    }
    expect(registration.options.key).toBe('@zhidal/dsh-llm-fallback');
    expect(registration.options.locale).toBe('llm-fallback');
    // bind 按 ns 缓存:测试拿到的 t 与卡片内部用的同一实例
    const t = locale.bind('llm-fallback');
    expect(t('title')).toBe('模型回退');
    // 模拟 设置 → 通用 → 语言 切到 English:同一 t 立即解析为英文
    locale.switchTo('en');
    expect(t('title')).toBe('Model fallback');
    expect(t('save')).toBe('Save');
  });

  it('locale 服务缺失(组合未含 dsh-client-locale)时 apply 不抛,配置卡降级注册', () => {
    const { ctx, slotRegistrations, cleanups } = stubClientCtx(null);
    expect(() => apply(ctx)).not.toThrow();
    // 卡片仍注册(静态英文回退),只是没有字典注册副作用
    expect(
      slotRegistrations.find((r) => r.options.name === 'plugins.bundle.config'),
    ).toBeDefined();
    expect(cleanups.length).toBeGreaterThan(0);
  });
});
