import { defineConfig } from 'tsdown';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

/**
 * 客户端半区构建：直接产出 web shell 的惰性 CJS 注册壳（对照
 * dsh-taskboard 的同款配置）。宿主提供的模块（react）经工厂注入的
 * require 解析；产物 client/index.js 与源码一起提交，重建用
 * `pnpm build:client`。id 必须与 package.json 包名一致，否则宿主
 * boot graph arrive() 抛 "loaded without registering"。
 */
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
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
