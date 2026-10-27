/**
 * dsh-anytype client 半区的契约测试（构建与发布契约 / 宿主插槽契约）。
 *
 * 覆盖四层：
 * 1. **包清单契约**：PKG_NAME 与 package.json 同步、exports['./client'] 指向
 *    构建产物、构建脚本链完整（防构建脚本被误删）；
 * 2. **字段契约**：客户端复刻的工具组名单与默认值逐项等于服务端 schema
 *    （client 半区不得 import 服务端源码，两份名单由本测试锁死）；
 * 3. **产物契约**：client/index.js 的 react external 纪律、主题 token 引用、
 *    样式挂载标记、无硬编码灰阶；沙箱 materialize 断言注册 id 与导出面；
 * 4. **插槽契约**：apply 注册的 keyed 插槽（名称 / key / locale）与
 *    dsh-llm-fallback 同款——key 必须是包名，否则 bundle 详情页不渲染配置卡。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_SLOT,
  DICT_NS,
  PKG_NAME,
  PLUGIN_NAME,
  ROW_MAIN,
  ROW_MEMORY,
} from '../client/src/constants.ts';
import { DICT } from '../client/src/dict.ts';
import {
  ANYTYPE_GROUPS,
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_CHARS,
  DEFAULT_MEMORY_STATUS,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SPACE_NAME,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  MEMORY_GROUPS,
} from '../client/src/lib/settings.ts';
import { apply } from '../client/src/plugin.tsx';
import {
  Config,
  DEFAULT_API_VERSION as SERVER_API_VERSION,
  DEFAULT_BASE_URL as SERVER_BASE_URL,
  DEFAULT_MAX_RESPONSE_CHARS as SERVER_MAX_RESPONSE_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS as SERVER_REQUEST_TIMEOUT_MS,
  TOOL_GROUPS as SERVER_ANYTYPE_GROUPS,
} from './anytype/config.ts';
import {
  DEFAULT_EMBEDDING_BATCH_SIZE as SERVER_EMBEDDING_BATCH_SIZE,
  DEFAULT_MEMORY_STATUS as SERVER_MEMORY_STATUS,
  DEFAULT_RECALL_LIMIT as SERVER_RECALL_LIMIT,
  DEFAULT_RECALL_MAX_TOKENS as SERVER_RECALL_MAX_TOKENS,
  DEFAULT_SPACE_NAME as SERVER_SPACE_NAME,
  TOOL_GROUPS as SERVER_MEMORY_GROUPS,
} from './memory/config.ts';

/** 读包目录下相对文件（产物 sanity 断言用）。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

// ── 1. 包清单与构建链 ────────────────────────────────────────────────

describe('dsh-anytype client 契约', () => {
  it('PKG_NAME 与 package.json 包名同步（boot graph 与 keyed 插槽双契约）', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      name: string;
      exports: Record<string, string>;
      scripts: Record<string, string>;
      dsh: { client?: Record<string, unknown> };
    };
    // __ModuleLoader__.load 的 id 若与包名不一致，web boot 抛
    // "loaded without registering"，client 配置卡整体失效。
    expect(PKG_NAME).toBe(pkg.name);
    // plugins.bundle.config 插槽 keyed by 包名，不一致则详情页不渲染配置卡。
    expect(pkg.exports['./client']).toBe('./client/index.js');
    // 客户端清单：web 平台 + 立即装载 + 三个服务依赖。
    expect(pkg.dsh.client).toBeDefined();
    const client = pkg.dsh.client as {
      platform: string;
      inject: string[];
    };
    expect(client.platform).toBe('web');
    for (const dependency of [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-settings',
    ]) {
      expect(client.inject, `${dependency} 应被声明`).toContain(dependency);
    }
  });

  it('构建链完整：client 产物由 scripts/build-client.ts 打出', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['build:client']).toContain('scripts/build-client.ts');
    const buildScript = readPackageFile('../scripts/build-client.ts');
    expect(buildScript).toContain('client/src/main.tsx');
    expect(buildScript).toContain('client/index.js');
    expect(buildScript).toContain('client/src/theme.css');
    expect(buildScript).toContain('@tailwindcss/cli');
  });

  it('客户端构建依赖全部声明在 package.json devDependencies', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys(pkg.devDependencies ?? {});
    for (const name of [
      'esbuild',
      'tailwindcss',
      '@tailwindcss/cli',
      'class-variance-authority',
      'clsx',
      'tailwind-merge',
      '@radix-ui/react-switch',
      '@radix-ui/react-checkbox',
      'react',
      'react-dom',
    ]) {
      expect(declared, `${name} 应声明在 devDependencies`).toContain(name);
    }
  });

  it('两个插件行的 namespace 与 cordis.patch.yml 的条目 id 同步', () => {
    const patch = readPackageFile('../cordis.patch.yml');
    expect(patch).toContain(`id: ${ROW_MAIN}`);
    expect(patch).toContain(`id: ${ROW_MEMORY}`);
  });
});

// ── 2. 字段契约（客户端复刻 vs 服务端 schema）────────────────────────

describe('客户端字段契约与服务端一致', () => {
  it('工具组名单逐项等于服务端 TOOL_GROUPS', () => {
    expect([...ANYTYPE_GROUPS]).toEqual([...SERVER_ANYTYPE_GROUPS]);
    expect([...MEMORY_GROUPS]).toEqual([...SERVER_MEMORY_GROUPS]);
  });

  it('默认值逐项等于服务端常量（防默认值漂移）', () => {
    expect(DEFAULT_BASE_URL).toBe(SERVER_BASE_URL);
    expect(DEFAULT_API_VERSION).toBe(SERVER_API_VERSION);
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(SERVER_REQUEST_TIMEOUT_MS);
    expect(DEFAULT_MAX_RESPONSE_CHARS).toBe(SERVER_MAX_RESPONSE_CHARS);
    expect(DEFAULT_SPACE_NAME).toBe(SERVER_SPACE_NAME);
    expect(DEFAULT_RECALL_LIMIT).toBe(SERVER_RECALL_LIMIT);
    expect(DEFAULT_RECALL_MAX_TOKENS).toBe(SERVER_RECALL_MAX_TOKENS);
    expect(DEFAULT_EMBEDDING_BATCH_SIZE).toBe(SERVER_EMBEDDING_BATCH_SIZE);
    expect(DEFAULT_MEMORY_STATUS).toBe(SERVER_MEMORY_STATUS);
  });

  it("apiKey 标 role('secret')：宿主下发时脱敏，客户端只写不读", () => {
    // 宿主 dsh-settings 的 redactSecrets 只认 `role('secret')`；标错 role
    // 会让明文密钥随 settings.describe 一起下发到浏览器。
    // schemastery 的 toJSON 用 refs 表 + uid 引用组织节点：根节点在
    // refs[uid]，其 dict 把字段名映射到子节点 uid。
    const json = Config.toJSON() as {
      uid: number;
      refs: Record<
        string,
        {
          type?: string;
          meta?: { role?: string; volatile?: boolean };
          dict?: Record<string, number>;
        }
      >;
    };
    const root = json.refs[String(json.uid)];
    const nodeOf = (key: string) =>
      json.refs[String(root?.dict?.[key])] as
        { meta?: { role?: string; volatile?: boolean } } | undefined;
    const apiKey = nodeOf('apiKey');
    expect(apiKey?.meta?.role).toBe('secret');
    // 仍是 volatile 字段（否则宿主会整条丢弃本条目的设置投影）。
    expect(apiKey?.meta?.volatile).toBe(true);
    // 其余字段不得被误标 secret（否则连接地址等也会从下发值里消失）。
    for (const key of Object.keys(root?.dict ?? {})) {
      if (key === 'apiKey') continue;
      expect(nodeOf(key)?.meta?.role, `${key} 不应标 secret`).not.toBe(
        'secret',
      );
    }
  });
});

// ── 3. 字典与产物 ────────────────────────────────────────────────────

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
    const client = readPackageFile('../client/index.js');
    for (const token of [
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-brand-primary',
      '--dsw-alias-switch-thumb',
    ]) {
      expect(client, `bundle 应引用 ${token}`).toContain(token);
    }
    expect(client).not.toContain('rgba(128,128,128');
  });

  it('bundle 无第二份 React（react / react-dom external 纪律）', () => {
    const client = readPackageFile('../client/index.js');
    expect(client).toContain('require("react")');
    expect(client).not.toContain('react-dom.production');
    expect(client).toContain('data-plugin-css');
  });
});

// ── 4. 沙箱 materialize（加载级 sanity）──────────────────────────────

describe('client 产物在模块表沙箱中注册成功', () => {
  it('id === PKG_NAME 且导出面完整（name / inject / apply）', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      name: string;
    };
    const source = readPackageFile('../client/index.js');
    const registered: Array<{
      id: string;
      factory: (require: (spec: string) => unknown) => unknown;
    }> = [];
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
    expect(registration.id).toBe(pkg.name);
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
    expect(exports.name).toBe(PLUGIN_NAME);
    expect(exports.inject).toContain('configForms');
    expect(exports.inject).toContain('slots');
    expect(typeof exports.apply).toBe('function');
  });
});

// ── 5. apply 行为（插槽注册）────────────────────────────────────────

/** 与 LocaleRuntime.bind/translate 同语义的最小 locale 假体（bind 按 ns 缓存）。 */
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

/** apply 的最小 ctx 假体：effect 立即执行，slots/configForms 记录。 */
function stubClientCtx(locale: ReturnType<typeof fakeLocale> | null): {
  ctx: Parameters<typeof apply>[0];
  slotRegistrations: Array<{
    options: { name: string; key?: string; locale?: string };
    component: unknown;
  }>;
  whileServedCalls: string[][];
  cleanups: Array<() => void>;
} {
  const slotRegistrations: Array<{
    options: { name: string; key?: string; locale?: string };
    component: unknown;
  }> = [];
  const whileServedCalls: string[][] = [];
  const cleanups: Array<() => void> = [];
  const scope = {
    getSnapshot: () => ({
      status: 'ready' as const,
      value: {},
      base: undefined,
      user: undefined,
      writable: true,
      revision: 1,
    }),
    subscribe: () => () => undefined,
    mutate: () => Promise.resolve(true),
  };
  const ctx = {
    effect(fn: () => unknown): void {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose as () => void);
    },
    ...(locale === null ? {} : { locale }),
    configForms: {
      get: () => scope,
      whileServed: (
        ns: string[],
        register: (served: ReadonlySet<string>) => () => void,
      ) => {
        whileServedCalls.push([...ns]);
        const dispose = register(new Set(ns));
        cleanups.push(dispose);
        return dispose;
      },
      describe: () => ({
        getSnapshot: () => ({
          status: 'ready' as const,
          view: undefined,
          error: null,
        }),
        subscribe: () => () => undefined,
        ensure: () => Promise.resolve(),
      }),
    },
    slots: {
      inject: (_name: string, registrar: () => unknown) => {
        const dispose = registrar();
        if (typeof dispose === 'function') cleanups.push(dispose as () => void);
        return () => undefined;
      },
      register: (
        options: { name: string; key?: string; locale?: string },
        component: unknown,
      ) => {
        slotRegistrations.push({ options, component });
        return () => undefined;
      },
    },
  };
  return { ctx, slotRegistrations, whileServedCalls, cleanups };
}

describe('配置卡插槽注册（apply 行为）', () => {
  it('注册 keyed 插槽：key = 包名、locale = 字典命名空间', () => {
    const locale = fakeLocale('zh');
    const { ctx, slotRegistrations, whileServedCalls } = stubClientCtx(locale);
    expect(() => apply(ctx)).not.toThrow();
    // 守卫覆盖两个插件行的 namespace
    expect(whileServedCalls[0]).toEqual([ROW_MAIN, ROW_MEMORY]);
    const registration = slotRegistrations.find(
      (r) => r.options.name === CONFIG_SLOT,
    );
    if (!registration) {
      throw new Error('plugins.bundle.config 插槽未注册');
    }
    expect(registration.options.key).toBe(PKG_NAME);
    expect(registration.options.locale).toBe(DICT_NS);
  });

  it('跟随 dsh 语言配置：字典注册进 locale 服务，t 按激活语言即时解析', () => {
    const locale = fakeLocale('zh');
    const { ctx } = stubClientCtx(locale);
    expect(() => apply(ctx)).not.toThrow();
    expect(locale.registered.has(DICT_NS)).toBe(true);
    const t = locale.bind(DICT_NS);
    expect(t('title')).toBe('Anytype 配置');
    locale.switchTo('en');
    expect(t('title')).toBe('Anytype configuration');
    expect(t('save')).toBe('Save');
  });

  it('locale 服务缺失（组合未含 dsh-client-locale）时 apply 不抛，配置卡降级注册', () => {
    const { ctx, slotRegistrations, cleanups } = stubClientCtx(null);
    expect(() => apply(ctx)).not.toThrow();
    expect(
      slotRegistrations.find((r) => r.options.name === CONFIG_SLOT),
    ).toBeDefined();
    expect(cleanups.length).toBeGreaterThan(0);
  });
});
