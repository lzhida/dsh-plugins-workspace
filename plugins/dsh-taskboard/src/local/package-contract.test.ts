/**
 * 契约测试：vendored 产物的可加载性、依赖纪律与「与上游逐字一致」的内容级约束。
 *
 * 这些断言对应 scripts/build.ts 的构建断言，但跑在 vitest 里（仓库根零配置
 * vitest，默认发现 src 目录下的 test 文件），保证 CI 的 `pnpm test` 也能守住。
 *
 * 前提：产物已构建（仓库 install 会触发本包 prepare → build；本地可用
 * `pnpm --filter @zhidal/dsh-taskboard build` 补齐）。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/** 包根目录（src/local/ → ../../）。 */
const pkgRoot = new URL('../../', import.meta.url);

/**
 * docs/upstream-sha256.txt 自身的 sha256。
 *
 * 该清单是「上游原始哈希」的唯一真源，一旦被改写，上游逐字性校验就失去意义，
 * 故在此钉死：任何改动都必须显式更新本常量（说明为什么上游清单变了）。
 */
const UPSTREAM_MANIFEST_SHA256 =
  'af564ba2125bf8e8fa4d5cce094e251409b734d75d79409441749c88285360c2';

/** 产物路径。 */
const distIndex = fileURLToPath(new URL('dist/index.js', pkgRoot));
const distInvariant = fileURLToPath(new URL('dist/invariant.js', pkgRoot));
const distClient = fileURLToPath(new URL('dist/client/index.js', pkgRoot));

/** 包清单。 */
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('package.json', pkgRoot)), 'utf8'),
) as {
  name: string;
  main: string;
  exports: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: { node?: string; dsh?: string };
  dsh: { client?: { platform?: string; inject?: string[] } };
};

/** 递归收集 src/ 下的 .ts/.tsx 相对路径（排除本地新增的 src/local）。 */
function collectVendoredSources(dir: URL): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'local') continue;
      found.push(...collectVendoredSources(new URL(`${entry.name}/`, dir)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(entry.name);
    }
  }
  return found;
}

/** 递归收集 src/ 下的 .ts/.tsx 相对路径（含 src/local），用于完整性核对。 */
function collectAllSources(dir: URL, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...collectAllSources(new URL(`${entry.name}/`, dir), rel));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      found.push(rel);
    }
  }
  return found;
}

/** 读取哈希清单（docs/upstream-sha256.txt 或 docs/local-sha256.txt）。 */
function readHashManifest(relative: string): Map<string, string> {
  const manifestPath = fileURLToPath(new URL(relative, pkgRoot));
  const manifest = new Map<string, string>();
  for (const raw of readFileSync(manifestPath, 'utf8').split('\n')) {
    const line = raw.trimEnd();
    if (!line || line.startsWith('#')) continue;
    const match = /^([0-9a-f]{64})\s\s(.+)$/.exec(line);
    if (!match) throw new Error(`哈希清单格式异常: ${line}`);
    manifest.set(match[2], match[1]);
  }
  return manifest;
}

/** 本地补丁登记项（docs/local-patches.json）。 */
interface LocalPatch {
  /** 该文件在上游的原始 sha256（须与上游清单一致）。 */
  upstreamSha256: string;
  /** 改动理由（必填）。 */
  reason: string;
}

/** 读取本地补丁清单（docs/local-patches.json）。 */
function readLocalPatches(): Map<string, LocalPatch> {
  const raw = readFileSync(
    fileURLToPath(new URL('docs/local-patches.json', pkgRoot)),
    'utf8',
  );
  const parsed = JSON.parse(raw) as {
    files?: Record<string, LocalPatch>;
  };
  const patches = new Map<string, LocalPatch>();
  for (const [rel, patch] of Object.entries(parsed.files ?? {})) {
    patches.set(rel, patch);
  }
  return patches;
}

/** 计算 src/ 下某个文件的 sha256。 */
function sha256Of(rel: string): string {
  return createHash('sha256')
    .update(readFileSync(fileURLToPath(new URL(`src/${rel}`, pkgRoot))))
    .digest('hex');
}

describe('dsh-taskboard（vendored）包契约', () => {
  it('产物齐备：宿主半区、invariant、浏览器半区', () => {
    expect(existsSync(distIndex)).toBe(true);
    expect(existsSync(distInvariant)).toBe(true);
    expect(existsSync(distClient)).toBe(true);
  });

  it('包清单的入口指向真实产物', () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(existsSync(fileURLToPath(new URL(pkg.main, pkgRoot)))).toBe(true);
    for (const target of Object.values(pkg.exports)) {
      if (target === './package.json') continue;
      expect(existsSync(fileURLToPath(new URL(target, pkgRoot)))).toBe(true);
    }
  });

  it('浏览器半区声明存在且声明 slots 注入', () => {
    expect(pkg.dsh.client?.platform).toBe('web');
    expect(pkg.dsh.client?.inject).toContain('slots');
  });

  it('宿主半区导出插件契约：name / inject / apply', async () => {
    const mod = (await import(distIndex)) as {
      name?: string;
      inject?: string[];
      apply?: unknown;
    };
    expect(mod.name).toBe('dsh-taskboard');
    expect(mod.inject).toEqual(['tools', 'systemPrompt']);
    expect(typeof mod.apply).toBe('function');
  });

  it('invariant 伴生插件导出正确的插件名', async () => {
    const mod = (await import(distInvariant)) as { name?: string };
    expect(mod.name).toBe('dsh-taskboard-invariant');
  });

  it('宿主半区零运行时 @deepseek-ai 引用（值导入会顶替宿主包）', () => {
    const source = readFileSync(distIndex, 'utf8');
    expect(source).not.toMatch(/from\s*["']@deepseek-ai\//);
    expect(source).not.toMatch(/require\(["']@deepseek-ai\//);
  });

  it('invariant 产物同样零运行时 @deepseek-ai 引用', () => {
    const source = readFileSync(distInvariant, 'utf8');
    expect(source).not.toMatch(/from\s*["']@deepseek-ai\//);
    expect(source).not.toMatch(/require\(["']@deepseek-ai\//);
  });

  it('运行时依赖不含 @deepseek-ai/*（会顶替宿主包并导致实例启动失败）', () => {
    const runtime = pkg.dependencies ?? {};
    for (const name of Object.keys(runtime)) {
      expect(name, `dependencies 不得包含 ${name}`).not.toMatch(
        /^@deepseek-ai\//,
      );
    }
    // 构建工具必须在 dependencies：git 安装会触发 prepare → build，
    // 而 pnpm 对 git 依赖不保证安装 devDependencies。
    expect(Object.keys(runtime)).toContain('esbuild');
    expect(pkg.devDependencies?.esbuild).toBeUndefined();
  });

  it('浏览器半区保持 react external 且不打包第二份 react-dom', () => {
    const source = readFileSync(distClient, 'utf8');
    expect(source).toContain('require("react")');
    expect(source).not.toContain('react-dom.production');
  });

  it('浏览器半区带 __ModuleLoader__ 注册壳且 id 与包名一致', () => {
    const source = readFileSync(distClient, 'utf8');
    expect(source).toContain('__ModuleLoader__.load');
    expect(source).toContain(pkg.name);
  });

  it('浏览器半区可在宿主沙箱中执行并交出正确的模块导出', () => {
    const source = readFileSync(distClient, 'utf8');
    const reactStub = {
      createElement: () => ({}),
      useState: () => [undefined, () => undefined],
      useRef: () => ({ current: null }),
      useEffect: () => undefined,
      useMemo: () => undefined,
      useCallback: () => () => undefined,
      useSyncExternalStore: () => undefined,
    };
    const jsxStub = {
      jsx: () => ({}),
      jsxs: () => ({}),
      Fragment: Symbol('Fragment'),
    };
    let registration:
      | {
          id?: string;
          factory?: (require: (id: string) => unknown) => unknown;
        }
      | undefined;

    const sandbox: Record<string, unknown> = {
      console,
      setTimeout,
      clearTimeout,
      __ModuleLoader__: {
        load: (reg: typeof registration) => {
          registration = reg;
        },
      },
    };

    runInNewContext(source, sandbox);

    expect(registration, '产物未向 __ModuleLoader__ 注册').toBeDefined();
    expect(registration?.id).toBe(pkg.name);
    expect(typeof registration?.factory).toBe('function');

    const mod = registration?.factory?.((id: string) => {
      if (id === 'react') return reactStub;
      if (id === 'react/jsx-runtime') return jsxStub;
      if (id === 'react-dom') return { createPortal: () => ({}) };
      throw new Error(`产物请求了未预期的模块: ${id}`);
    }) as { name?: string; inject?: string[]; apply?: unknown };

    expect(mod.name).toBe('dsh-taskboard/client');
    expect(typeof mod.apply).toBe('function');
  });

  it('cordis.patch.yml 的插件名与包名一致（loader 按 name 找模块、按 id 去重）', () => {
    const patch = readFileSync(
      fileURLToPath(new URL('cordis.patch.yml', pkgRoot)),
      'utf8',
    );
    expect(patch).toContain(`name: '${pkg.name}'`);
    expect(patch).toContain('id: dsh-taskboard');
  });

  it('上游哈希清单本身未被改写（upstream-sha256.txt 永远是上游原始哈希）', () => {
    const digest = createHash('sha256')
      .update(
        readFileSync(
          fileURLToPath(new URL('docs/upstream-sha256.txt', pkgRoot)),
        ),
      )
      .digest('hex');
    expect(
      digest,
      'docs/upstream-sha256.txt 被改写了；它必须永远保持上游原始哈希，重新 vendoring 上游时同步更新本常量',
    ).toBe(UPSTREAM_MANIFEST_SHA256);
  });

  it('vendored 源码逐字一致：未被有意改动的文件与上游 SHA256 清单逐项核对', () => {
    const manifest = readHashManifest('docs/upstream-sha256.txt');
    const patches = readLocalPatches();
    const localManifest = readHashManifest('docs/local-sha256.txt');
    expect(manifest.size).toBe(63);

    const actual = new Set(collectAllSources(new URL('src/', pkgRoot)));
    // src/local 是本仓新增，不在清单内；其余必须与清单一一对应。
    const listed = new Set(manifest.keys());
    for (const rel of actual) {
      if (rel.startsWith('local/')) continue;
      expect(listed.has(rel), `清单缺少文件: ${rel}`).toBe(true);
    }
    for (const rel of listed) {
      expect(actual.has(rel), `多出文件: ${rel}`).toBe(true);
    }

    for (const [rel, expected] of manifest) {
      const digest = sha256Of(rel);
      const patch = patches.get(rel);
      if (patch === undefined) {
        // 未登记的文件必须与上游逐字一致——任何额外改动都会在这里被捕获。
        expect(
          digest,
          `${rel} 与上游不一致（改动须登记到 docs/local-patches.json）`,
        ).toBe(expected);
        continue;
      }
      // 被有意改动的文件：上游原始哈希仍须与上游清单一致（清单没被改写）。
      expect(
        patch.upstreamSha256,
        `${rel} 登记的上游哈希与上游清单不一致`,
      ).toBe(expected);
      // 当前本地哈希须与 docs/local-sha256.txt 一致。
      expect(
        localManifest.get(rel),
        `docs/local-sha256.txt 缺少 ${rel} 的当前哈希`,
      ).toBe(digest);
    }

    // 补丁清单与本地哈希清单双向一致：登记了但没哈希 / 有哈希但没登记都算漂移。
    for (const rel of patches.keys()) {
      expect(
        manifest.has(rel),
        `补丁清单登记了不在上游清单内的文件: ${rel}`,
      ).toBe(true);
      expect(localManifest.has(rel), `docs/local-sha256.txt 缺少 ${rel}`).toBe(
        true,
      );
    }
    for (const rel of localManifest.keys()) {
      expect(
        patches.has(rel),
        `${rel} 有本地哈希但未登记改动理由（漏登记的改动会被立刻捕获）`,
      ).toBe(true);
    }
  });

  it('被有意改动的上游文件都登记了改动理由', () => {
    const patches = readLocalPatches();
    expect(patches.size).toBeGreaterThan(0);
    for (const [rel, patch] of patches) {
      expect(patch.reason.trim().length, `${rel} 缺少改动理由`).toBeGreaterThan(
        0,
      );
      expect(patch.upstreamSha256, `${rel} 的上游哈希格式异常`).toMatch(
        /^[0-9a-f]{64}$/,
      );
    }
  });

  it('vendored 源码文件数与上游一致（63 个 ts/tsx，src/local 除外）', () => {
    expect(collectVendoredSources(new URL('src/', pkgRoot)).length).toBe(63);
  });
});
