import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { name as pluginName } from './index.ts';

/** npm 发布元数据里与本包相关的字段形状(只声明测试关心的部分)。 */
interface PackageManifest {
  name: string;
  version: string;
  license?: string;
  main?: string;
  types?: string;
  exports?: Record<string, { types?: string; default?: string } | string>;
  files?: string[];
  homepage?: string;
  repository?: {
    type?: string;
    url?: string;
    directory?: string;
  };
  publishConfig?: { access?: string };
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dsh?: { bundle?: { patch?: string } };
}

/** 读包目录下相对文件(与 llm-fallback 的 manifest.test.ts 同一模式)。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

const pkg = JSON.parse(readPackageFile('../package.json')) as PackageManifest;

/** GitHub 仓库内本插件子目录的 URL(npm 官网 Homepage 链接的目标)。 */
const REPO_DIR_URL =
  'https://github.com/lzhida/dsh-plugins-workspace/tree/main/packages/dsh-victauri';

/** 运行时依赖(消费端安装树里必然可得的三个包)。 */
const RUNTIME_DEPS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
];

describe('dsh-victauri', () => {
  describe('npm 发布元数据(repository/homepage)', () => {
    it('显式 homepage 指向插件子目录 README,而非 monorepo 根目录', () => {
      // 包缺显式 homepage 时,npm 自动回退生成仓库根目录链接,
      // 官网 Homepage 跳不到插件目录——此断言防回归。
      expect(pkg.homepage).toBe(`${REPO_DIR_URL}#readme`);
    });

    it('repository 带 directory,仓库链接落到 monorepo 内本插件子目录', () => {
      expect(pkg.repository?.type).toBe('git');
      expect(pkg.repository?.url).toBe(
        'git+https://github.com/lzhida/dsh-plugins-workspace.git',
      );
      expect(pkg.repository?.directory).toBe('packages/dsh-victauri');
    });

    it('homepage 路径与 repository.directory 同源一致(目录迁移时两处须同步改)', () => {
      // 从 homepage URL 提取仓库内目录(去掉 "/lzhida/dsh-plugins-workspace/tree/<分支>/" 前缀),
      // 必须与 repository.directory 相等——迁移时两处不同步,链接就会跳错目录。
      const homepage = pkg.homepage ?? '';
      expect(homepage).not.toBe('');
      const directoryFromHomepage = new URL(homepage).pathname
        .replace(/^\/lzhida\/dsh-plugins-workspace\/tree\/[^/]+\//, '')
        .replace(/\/$/, '');
      expect(directoryFromHomepage).toBe(pkg.repository?.directory);
    });
  });

  describe('发布入口与产物面', () => {
    it('main/types 指向构建产物(esbuild bundle + 声明剪枝后的公开声明)', () => {
      expect(pkg.main).toBe('dist/index.js');
      expect(pkg.types).toBe('dist/index.d.ts');
    });

    it('exports 只放行包根与 package.json(深导入一律不可见)', () => {
      expect(pkg.exports?.['.']).toEqual({
        types: './dist/index.d.ts',
        default: './dist/index.js',
      });
      expect(pkg.exports?.['./package.json']).toBe('./package.json');
      expect(Object.keys(pkg.exports ?? {})).toEqual(['.', './package.json']);
    });

    it('files 白名单只含 dist/docs/cordis.patch.yml(src 与 demo-app 不入 tarball)', () => {
      expect(pkg.files).toEqual(['dist', 'docs', 'cordis.patch.yml']);
      expect(pkg.files).not.toContain('src');
      expect(pkg.files).not.toContain('demo-app');
    });

    it('bundle 打包线声明包内补丁文件(插件随 dsh plugin add 即装载)', () => {
      expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    });
  });

  describe('发布可见性与版本', () => {
    it('公开发布(非 private)+ MIT 许可', () => {
      expect(pkg.publishConfig?.access).toBe('public');
      expect(pkg.license).toBe('MIT');
    });

    it('版本为合法 semver(发布 tag 由该版本推导)', () => {
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    });

    it('插件 name 与包名 kebab 段一致(dsh plugin 行标识不得漂移)', () => {
      expect(pluginName).toBe('dsh-victauri');
      expect(pkg.name).toBe('@zhidal/dsh-victauri');
      expect(pkg.name.split('/')[1]).toBe(pluginName);
    });
  });

  describe('依赖分置', () => {
    it('运行时三件套在 dependencies(公开 .d.ts 引用其类型,消费端须可得)', () => {
      for (const dep of RUNTIME_DEPS) {
        expect(Object.keys(pkg.dependencies ?? {})).toContain(dep);
      }
    });

    it('构建与测试工具不进 dependencies(消费端不装 esbuild/typescript)', () => {
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain('esbuild');
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain('typescript');
      expect(Object.keys(pkg.devDependencies ?? {})).toContain('esbuild');
      expect(Object.keys(pkg.devDependencies ?? {})).toContain('typescript');
    });

    it('dsh-llm 只能是 devDependency(dist 声明不得引用宿主私有类型)', () => {
      expect(Object.keys(pkg.devDependencies ?? {})).toContain(
        '@deepseek-ai/dsh-llm',
      );
      expect(Object.keys(pkg.dependencies ?? {})).not.toContain(
        '@deepseek-ai/dsh-llm',
      );
    });
  });
});
