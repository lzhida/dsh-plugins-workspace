/**
 * 客户端半区构建：直接产出 web shell 的惰性 CJS 注册壳（对照
 * dsh-open-in-zed / dsh-taskboard 的同款配置）。
 *
 * 关键：esbuild `--format=cjs` 的入口模块体在产物顶层执行（顶层
 * `require("react")`），而宿主以 classic script 加载 combo——顶层没有
 * require。因此用 banner/footer 把整个产物包进 factory 闭包：顶层只有
 * `window.__ModuleLoader__.load({ id, factory })`，模块体副作用（含
 * react 解析）在宿主 materialize 时经 factory 形参 require 提供。
 *
 * id 必须与 package.json 包名一致（此处从清单读取，杜绝硬编码漂移），
 * 否则宿主 boot graph arrive() 抛 "loaded without registering"。
 * react 保持 external——绝不可打包第二份 React（hooks 跨副本调用会崩）。
 *
 * 运行：node scripts/build-client.ts（Node 22+ 原生 type-stripping 直跑）。
 *
 * @module dsh-llm-fallback/scripts/build-client
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string };

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
  external: ['react'],
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
