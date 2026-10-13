import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/** 读包目录下相对文件(client bundle 不经打包,直接文本断言)。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

/** client bundle 导出的纯函数最小形状(只声明测试关心的部分)。 */
interface ClientExports {
  name: string;
  inject: string[];
  /** locale 字典(命名空间 'llm-fallback'),导出供测试断言 zh/en 键集一致。 */
  DICT: Record<'zh' | 'en', Record<string, string>>;
  apply: (ctx: unknown) => void;
  modelMatches: (
    group: { id: string },
    model: { id: string; name?: string },
    query: string,
  ) => boolean;
  filteredCatalogGroups: (
    groups: Array<{ id: string; models: Array<{ id: string; name?: string }> }>,
    query: string,
  ) => Array<{ id: string; models: Array<{ id: string; name?: string }> }>;
}

interface LoaderDefinition {
  id: string;
  factory: (require: (id: string) => unknown) => ClientExports;
}

/**
 * 在 node:vm 沙箱里执行 client bundle 顶层(仅注册模块定义,不渲染组件),
 * 再以最小 React stub 执行 factory,拿到导出的纯函数做行为断言。
 */
function loadClientExports(): { id: string; exports: ClientExports } {
  const source = readPackageFile('../client/index.js');
  const registered: LoaderDefinition[] = [];
  const sandbox: Record<string, unknown> = {
    __ModuleLoader__: {
      load: (definition: LoaderDefinition) => {
        registered.push(definition);
      },
    },
  };
  runInNewContext(source, sandbox);
  const definition = registered[0];
  if (!definition) {
    throw new Error('client bundle 未向 __ModuleLoader__ 注册模块定义');
  }
  // factory 体内对 react 只取 createElement/useState/useEffect/useMemo 引用,
  // 不渲染组件;最小 stub 即可。Card 渲染路径由 e2e 浏览器级验证覆盖。
  const reactStub = {
    createElement: () => null,
    useState: () => [null, () => undefined],
    useEffect: () => undefined,
    useMemo: (compute: () => unknown) => compute(),
  };
  return { id: definition.id, exports: definition.factory(() => reactStub) };
}

describe('dsh-llm-fallback', () => {
  it('client bundle 注册 id 与 PKG_NAME 同步 package.json 包名(boot graph 契约)', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      name: string;
    };
    const client = readPackageFile('../client/index.js');
    // __ModuleLoader__.load 的 id 若与包名不一致,web boot 抛
    // "loaded without registering",client 配置卡整体失效——曾因包改名漏改
    // 该硬编码发布过坏版本(0.3.0),此断言防回归。
    expect(client).toContain(`id: '${pkg.name}',`);
    // plugins.bundle.config 插槽 keyed by 包名,不一致则详情页不渲染配置卡。
    expect(client).toContain(`var PKG_NAME = '${pkg.name}';`);
  });

  it('client bundle 模型目录容器限高并内部滚动(不撑长设置页外层滚动条)', () => {
    const client = readPackageFile('../client/index.js');
    const block = client.match(/catalogScroll: \{[^}]*\}/);
    // 样式块存在,且 maxHeight 与 overflowY: 'auto' 成对出现——只限高不滚动
    // 会裁掉列表,只滚动不限高则外层滚动条仍被撑长。
    expect(block).not.toBeNull();
    expect(block?.[0]).toContain('maxHeight: 280');
    expect(block?.[0]).toContain("overflowY: 'auto'");
  });

  it('client bundle 提供模型搜索框(过滤谓词 + 受控输入 + 中英空态文案)', () => {
    const client = readPackageFile('../client/index.js');
    // 中英字典均有搜索占位与空态文案
    expect(client).toContain(`catalogSearch: '搜索模型`);
    expect(client).toContain(`catalogSearch: 'Search models`);
    expect(client).toContain(`catalogNoMatch: '没有匹配的模型'`);
    expect(client).toContain(`catalogNoMatch: 'No matching models'`);
    // 搜索态与过滤管线存在,输入框受控
    expect(client).toContain(`var searchState = useState('')`);
    expect(client).toContain('function modelMatches(');
    expect(client).toContain('function filteredCatalogGroups(');
    expect(client).toContain('setSearch(event.target.value)');
  });

  it('client bundle 颜色接入 dsh 主题 token(暗色模式可读),不再硬编码灰阶', () => {
    const client = readPackageFile('../client/index.js');
    // 客户端 Theme inspect 提供方列出的 alias token:
    // 文本 / 次级文本 / 两级边框 / 抬升表面 / 品牌色(明暗双模式各有定义)。
    for (const token of [
      '--dsw-alias-label-primary',
      '--dsw-alias-label-secondary',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-brand-primary',
    ]) {
      expect(client).toContain(token);
    }
    // 旧硬编码灰阶 rgba(128,128,128,*) 是暗色模式混色看不清的根因,防回归。
    expect(client).not.toContain('rgba(128,128,128');
  });

  describe('模型搜索过滤(client 导出的纯函数)', () => {
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
      const { exports } = loadClientExports();
      expect(exports.filteredCatalogGroups(groups, '')).toHaveLength(2);
      expect(exports.filteredCatalogGroups(groups, '   ')).toHaveLength(2);
    });

    it('按模型 id / 显示名 / provider 分组名大小写不敏感子串过滤', () => {
      const { exports } = loadClientExports();
      // 模型 id
      const byId = exports.filteredCatalogGroups(groups, 'FLASH');
      expect(byId).toHaveLength(1);
      expect(byId[0]?.id).toBe('glm-coding-plan');
      expect(byId[0]?.models.map((m) => m.id)).toEqual(['glm-5.3-flash']);
      // 显示名
      const byName = exports.filteredCatalogGroups(groups, 'deepseek chat');
      expect(byName).toHaveLength(1);
      expect(byName[0]?.models.map((m) => m.id)).toEqual(['deepseek-chat']);
      // provider 分组名命中 → 该组全部模型保留
      const byProvider = exports.filteredCatalogGroups(groups, 'GLM-CODING');
      expect(byProvider).toHaveLength(1);
      expect(byProvider[0]?.models).toHaveLength(2);
      // 谓词与过滤管线结果一致
      expect(
        exports.modelMatches(groups[1]!, groups[1]!.models[0]!, 'CHAT'),
      ).toBe(true);
      expect(
        exports.modelMatches(groups[1]!, groups[1]!.models[0]!, 'glm'),
      ).toBe(false);
    });

    it('无任何命中时返回空数组(UI 据此渲染空态文案)', () => {
      const { exports } = loadClientExports();
      expect(exports.filteredCatalogGroups(groups, '不存在的模型')).toEqual([]);
    });
  });

  // ── 国际化(0.3.3):跟随 dsh 语言配置 ─────────────────────────────

  describe('配置卡国际化', () => {
    it('字典 zh/en 键集一致且无空文案(缺译 / 漏译防回归)', () => {
      const { exports } = loadClientExports();
      const zhKeys = Object.keys(exports.DICT.zh).sort();
      const enKeys = Object.keys(exports.DICT.en).sort();
      expect(zhKeys).toEqual(enKeys);
      expect(zhKeys.length).toBeGreaterThan(20);
      for (const [locale, dict] of Object.entries(exports.DICT)) {
        for (const [key, value] of Object.entries(dict)) {
          expect(
            typeof value === 'string' && value.length > 0,
            `${locale}.${key} 应为非空字符串`,
          ).toBe(true);
        }
      }
    });

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

    /** client apply 的最小 ctx 假体:effect 立即执行,slots/configForms 记录。 */
    function stubClientCtx(locale: ReturnType<typeof fakeLocale> | null): {
      ctx: unknown;
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
        effect(fn: () => () => void): void {
          const dispose = fn();
          if (typeof dispose === 'function') cleanups.push(dispose);
        },
        ...(locale === null ? {} : { locale }),
        configForms: {
          get: () => scope,
          whileServed: (_ns: string[], register: () => () => void) => {
            const dispose = register();
            if (typeof dispose === 'function') cleanups.push(dispose);
          },
        },
        slots: {
          inject: (_name: string, registrar: () => void) => registrar(),
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
      };
      return { ctx, slotRegistrations, cleanups };
    }

    function configCardRegistration(
      slotRegistrations: Array<{
        options: { name: string; key?: string; locale?: string };
        component: unknown;
      }>,
    ): { options: { name: string; key?: string; locale?: string } } {
      const registration = slotRegistrations.find(
        (r) => r.options.name === 'plugins.bundle.config',
      );
      expect(registration, 'plugins.bundle.config 插槽未注册').toBeDefined();
      return registration!;
    }

    it('跟随 dsh 语言配置:注册 llm-fallback 命名空间,t 按激活语言即时解析', () => {
      const { exports } = loadClientExports();
      const locale = fakeLocale('zh');
      const { ctx, slotRegistrations } = stubClientCtx(locale);
      expect(() => exports.apply(ctx)).not.toThrow();
      // 字典已注册进 locale 服务
      expect(locale.registered.has('llm-fallback')).toBe(true);
      // 配置卡挂在 keyed 插槽上,key = 包名、locale = 字典命名空间
      const registration = configCardRegistration(slotRegistrations);
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
      const { exports } = loadClientExports();
      const { ctx, slotRegistrations, cleanups } = stubClientCtx(null);
      expect(() => exports.apply(ctx)).not.toThrow();
      // 卡片仍注册(静态英文回退),只是没有字典注册副作用
      configCardRegistration(slotRegistrations);
      expect(cleanups.length).toBeGreaterThan(0);
    });

    it('卡片订阅 locale 快照(LocaleFace 契约),语言切换时重渲染', () => {
      const client = readPackageFile('../client/index.js');
      // 订阅 + revision 比较(bump 本地状态强制刷新)
      expect(client).toContain('locale.subscribe(function () {');
      expect(client).toContain('locale.getSnapshot().revision');
      // locale 缺失守卫(静态英文回退路径)
      expect(client).toContain('DICT.en[key]');
    });
  });
});
