/**
 * 客户端半区构建：直接产出 web shell 的惰性 CJS 注册壳（对照
 * dsh-open-in-zed / dsh-taskboard 的同款配置）+ Tailwind v4 内联 CSS。
 *
 * 关键：esbuild `--format=cjs` 的入口模块体在产物顶层执行（顶层
 * `require("react")`），而宿主以 classic script 加载 combo——顶层没有
 * require。因此用 banner/footer 把整个产物包进 factory 闭包：顶层只有
 * `window.__ModuleLoader__.load({ id, factory })`，模块体副作用（含
 * react 解析与 <style> 注入）在宿主 materialize 时经 factory 形参
 * require 提供。
 *
 * id 必须与 package.json 包名一致（此处从清单读取，杜绝硬编码漂移），
 * 否则宿主 boot graph arrive() 抛 "loaded without registering"。
 *
 * react / react/jsx-runtime 保持 external——宿主平台 seed 表提供两者，
 * 绝不可打包第二份 React（hooks 跨副本调用会崩）；CSS 无独立产物通道，
 * Tailwind 编译结果（@tailwindcss/cli 子进程编译 client/src/theme.css）
 * 经 esbuild define 以 __TAILWIND_CSS__ 字符串注入，运行时由 theme.ts
 * 同步挂载 <style data-plugin>（宿主 claimStyles/removeOwnedStyles 负责
 * 认领与清理，见 theme.ts 注释）。
 *
 * 构建断言（防回归，失败即退出非零）：
 * 1. Tailwind 产物非空、无 preflight（无 box-sizing 规则）、含宿主 token；
 * 2. bundle 内 require("react") 保持 external、无第二份 react-dom（生产
 *    license 头）、含宿主 token 引用、无硬编码灰阶、含样式挂载标记。
 *
 * 运行：node scripts/build-client.ts（Node 22+ 原生 type-stripping 直跑）。
 *
 * @module dsh-llm-fallback/scripts/build-client
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const nodeRequire = createRequire(import.meta.url);
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

const themeCssPath = fileURLToPath(
  new URL('../client/src/theme.css', import.meta.url),
);

/**
 * Tailwind v4 CLI 编译 theme.css → minified CSS 文本（stdout 捕获，零
 * 临时文件）。CLI 入口经包清单 bin 字段解析，避免硬编码 dist 路径漂移。
 */
function compileTailwindCss(): string {
  const cliManifestPath = nodeRequire.resolve('@tailwindcss/cli/package.json');
  const cliManifest = JSON.parse(readFileSync(cliManifestPath, 'utf8')) as {
    bin: string | Record<string, string>;
  };
  const bin =
    typeof cliManifest.bin === 'string'
      ? cliManifest.bin
      : Object.values(cliManifest.bin)[0];
  const cliEntry = resolve(dirname(cliManifestPath), bin);
  return execFileSync(
    process.execPath,
    [cliEntry, '-i', themeCssPath, '--minify'],
    {
      cwd: dirname(themeCssPath),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
}

/** Tailwind 产物断言：非空、无 preflight、宿主 token 已内联。 */
function assertCompiledCss(css: string): void {
  if (css.trim().length < 200) {
    throw new Error(
      'build-client: Tailwind 编译产物过小（' +
        css.length +
        ' bytes），utilities 未生成——检查 @source 扫描范围',
    );
  }
  // 卡片嵌宿主 DOM，preflight 全局 reset 会污染宿主页面，必须禁用：
  // granular import（theme.css + utilities.css）下产物不应出现任何
  // box-sizing 声明（utilities 从不产出该属性，preflight 必产）。
  if (css.includes('box-sizing')) {
    throw new Error(
      'build-client: Tailwind 产物含 box-sizing——preflight 未禁用',
    );
  }
  if (!css.includes('--dsw-alias-')) {
    throw new Error('build-client: Tailwind 产物无宿主主题 token 引用');
  }
}

/** bundle 产物断言：react external 纪律 + 样式注入 + token 引用。 */
function assertBundle(source: string): void {
  // react 保持 external：模块体必须仍是 factory 内 require("react")，
  // 由宿主 seed 表解析；出现 react-dom 生产包 license 头 = 打包了第二份
  // React（hooks 跨副本调用会崩），立即失败。
  if (!source.includes('require("react")')) {
    throw new Error(
      'build-client: bundle 未保持 react external（无 require("react")）',
    );
  }
  if (source.includes('react-dom.production')) {
    throw new Error(
      'build-client: bundle 打包了第二份 react-dom（react external 纪律被破坏）',
    );
  }
  if (!source.includes('--dsw-alias-')) {
    throw new Error(
      'build-client: bundle 无宿主主题 token 引用（CSS 未注入？）',
    );
  }
  if (!source.includes('data-plugin-css')) {
    throw new Error(
      'build-client: bundle 缺少样式挂载标记（theme.ts 未进 bundle？）',
    );
  }
  // 旧版硬编码灰阶（暗色模式混色根因）防回归。
  if (source.includes('rgba(128,128,128')) {
    throw new Error('build-client: bundle 含硬编码灰阶 rgba(128,128,128,*)');
  }
}

const css = compileTailwindCss();
assertCompiledCss(css);

await build({
  entryPoints: [
    fileURLToPath(new URL('../client/src/main.tsx', import.meta.url)),
  ],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'chrome120',
  minify: true,
  sourcemap: true,
  // react-dom 同样 external：@radix-ui/react-primitive（switch/checkbox/
  // scroll-area 的公共依赖）依赖它，宿主 seed 表提供，绝不打包副本。
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  define: { __TAILWIND_CSS__: JSON.stringify(css) },
  outfile: fileURLToPath(new URL('../client/index.js', import.meta.url)),
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

assertBundle(
  readFileSync(
    fileURLToPath(new URL('../client/index.js', import.meta.url)),
    'utf8',
  ),
);

const bundleStat = pathToFileURL(
  fileURLToPath(new URL('../client/index.js', import.meta.url)),
);
console.log(
  `build-client: tailwind css ${css.length}B inlined; bundle ${bundleStat.pathname}`,
);
