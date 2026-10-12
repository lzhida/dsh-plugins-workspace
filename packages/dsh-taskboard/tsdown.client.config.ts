import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

/**
 * 客户端半区构建：直接产出 web shell 的惰性 CJS 注册壳。
 * 宿主提供的模块（react、@deepseek-ai/*）经工厂注入的 require 解析，
 * 模块副作用延迟到物化时才执行：
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ...body...; return module.exports } })
 *
 * 产物 client/index.js 与源码一起提交（本仓库 UI 插件的「零构建直载 +
 * 预构建客户端产物」模式，对照 dsh-guided-goal）；重建用 `pnpm build:client`。
 * id 必须与 package.json 包名一致，否则宿主 boot graph arrive() 抛
 * "loaded without registering"。
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: 'cjs',
  outDir: 'client',
  clean: true,
  sourcemap: false,
  external: [/^@deepseek-ai\//, /^react(-dom)?(\/.*)?$/, /^schemastery$/],
  target: 'chrome120',
  minify: true,
  outputOptions: {
    entryFileNames: 'index.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {`,
    intro:
      'var module = { exports: {} }; var exports = module.exports; Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    footer: 'return module.exports; } });',
  },
});
