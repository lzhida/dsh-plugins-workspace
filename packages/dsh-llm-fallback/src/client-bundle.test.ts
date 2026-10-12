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
});
