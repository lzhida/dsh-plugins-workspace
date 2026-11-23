/**
 * dsh-taskboard 构建脚本（vendored 版）：一次产出三个产物。
 *
 *   - dist/index.js         宿主半区（ESM，node22，零运行时 @deepseek-ai 依赖）
 *   - dist/invariant.js     invariant 伴生插件（ESM，node22）
 *   - dist/client/index.js  浏览器半区（CJS，chrome120，__ModuleLoader__ 壳）
 *
 * 与上游的差异：上游用 tsdown（三份 config），本仓统一用 esbuild（见仓库
 * AGENTS.md「构建式发行」与 plugins/dsh-victauri、plugins/dsh-anytype 先例）。
 *
 * 关键约束：
 *   - 宿主半区的 @deepseek-ai/* 全部是 `import type`，编译期擦除 → 构建
 *     产物零运行时 @deepseek-ai 引用（断言 3 守住这条纪律：写错成值导入会
 *     在安装侧把宿主包顶替掉）。
 *   - react / react-dom / react/jsx-runtime 在浏览器半区保持 external：
 *     宿主平台的 seed 表提供它们，打包第二份 React 会让 hooks 跨副本调用
 *     而崩（断言 4、5 守住）。
 *   - 浏览器半区必须包进 factory 闭包：CJS 入口模块体在产物顶层执行
 *     （顶层 require("react")），而宿主以 classic script 加载组合产物——
 *     顶层没有 require（见 plugins/dsh-anytype/scripts/build-client.ts）。
 *
 * 运行：node scripts/build.ts（Node 22+ 原生 type-stripping 直跑）。
 *
 * @module dsh-taskboard/scripts/build
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** 包清单（id 必须与包名一致，否则宿主 boot graph arrive() 抛「loaded without registering」）。 */
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

/** 产物绝对路径。 */
const distIndex = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const distInvariant = fileURLToPath(
  new URL('../dist/invariant.js', import.meta.url),
);
const distClient = fileURLToPath(
  new URL('../dist/client/index.js', import.meta.url),
);

/**
 * 构建工作目录固定为包目录：esbuild 的 sourcemap 与产物注释里的源码相对路径
 * 以工作目录为基准，不固定的话「从仓库根跑」与「从包目录跑」会产出字节不同
 * （语义相同）的产物。
 */
const pkgRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * 内联编译选项，替代磁盘上的 tsconfig 发现：esbuild 若自动发现 tsconfig.json，
 * 产物会随「tsconfig 是否在场」「extends 能否解析」而变（如 CJS 产物的
 * "use strict" 与模块发射顺序）。内联后无论在仓库里还是发布 tarball 里重建，
 * 产物字节都一致。
 */
const tsconfigRaw = {
  compilerOptions: {
    strict: true,
    jsx: 'react-jsx',
    target: 'ES2022',
  },
} as const;

/** 读产物文本（断言用）。 */
function readOut(path: string): string {
  return readFileSync(path, 'utf8');
}

/** 宿主半区断言：零运行时 @deepseek-ai 引用 + 插件名与 inject 形状完整。 */
function assertHostBundle(source: string): void {
  if (
    /from\s*["']@deepseek-ai\//.test(source) ||
    /require\(["']@deepseek-ai\//.test(source)
  ) {
    throw new Error(
      'build: 宿主半区残留 @deepseek-ai 运行时引用（应为 import type，编译期擦除）',
    );
  }
  if (!source.includes('dsh-taskboard')) {
    throw new Error('build: 宿主半区产物缺少插件名 dsh-taskboard');
  }
}

/** invariant 伴生插件断言：同样零运行时 @deepseek-ai 引用 + 插件名完整。 */
function assertInvariantBundle(source: string): void {
  if (
    /from\s*["']@deepseek-ai\//.test(source) ||
    /require\(["']@deepseek-ai\//.test(source)
  ) {
    throw new Error(
      'build: invariant 半区残留 @deepseek-ai 运行时引用（应为 import type）',
    );
  }
  if (!source.includes('dsh-taskboard-invariant')) {
    throw new Error(
      'build: invariant 半区产物缺少插件名 dsh-taskboard-invariant',
    );
  }
}

/** 浏览器半区断言：react external 纪律 + ModuleLoader 壳 + 包名一致。 */
function assertClientBundle(source: string): void {
  if (!source.includes('require("react")')) {
    throw new Error(
      'build: 浏览器半区未保持 react external（无 require("react")）',
    );
  }
  if (source.includes('react-dom.production')) {
    throw new Error(
      'build: 浏览器半区打包了第二份 react-dom（react external 纪律被破坏）',
    );
  }
  if (!source.includes('__ModuleLoader__.load')) {
    throw new Error('build: 浏览器半区缺少 __ModuleLoader__ 注册壳');
  }
  if (!source.includes(pkg.name)) {
    throw new Error(
      `build: 浏览器半区 ModuleLoader id 与包名不一致（${pkg.name}）`,
    );
  }
}

// ── 宿主半区 ────────────────────────────────────────────────────────────
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  absWorkingDir: pkgRoot,
  tsconfigRaw,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // @deepseek-ai/* 与 schemastery 交回宿主解析（实际已被 import type 擦除，
  // 这里只是安全网：任何值导入都会在安装侧顶替宿主包）。
  external: ['@deepseek-ai/*', 'schemastery'],
  outfile: distIndex,
});

// ── invariant 伴生插件 ─────────────────────────────────────────────────
await build({
  entryPoints: [fileURLToPath(new URL('../src/invariant.ts', import.meta.url))],
  absWorkingDir: pkgRoot,
  tsconfigRaw,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external: ['@deepseek-ai/*', 'schemastery'],
  outfile: distInvariant,
});

// ── 浏览器半区 ──────────────────────────────────────────────────────────
await build({
  entryPoints: [
    fileURLToPath(new URL('../src/client/index.ts', import.meta.url)),
  ],
  absWorkingDir: pkgRoot,
  tsconfigRaw,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome120',
  minify: true,
  sourcemap: true,
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  outfile: distClient,
  banner: {
    js:
      'globalThis.__ModuleLoader__.load({ id: ' +
      JSON.stringify(pkg.name) +
      ', factory: function (require) { var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
});

assertHostBundle(readOut(distIndex));
assertInvariantBundle(readOut(distInvariant));
assertClientBundle(readOut(distClient));

console.log(
  `build: ${distIndex}\nbuild: ${distInvariant}\nbuild: ${distClient}`,
);
