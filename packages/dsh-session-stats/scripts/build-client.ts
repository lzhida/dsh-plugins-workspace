import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/**
 * 两个前端构建产物:
 * 1. web/app.js — 独立面板(serve/export 用),IIFE + production React 内联;
 * 2. client/index.js — dsh 客户端插件(ModuleLoader CJS-in-factory 提交产物),
 *    react/react/jsx-runtime 使用宿主运行时实例(external),CSS 以文本内联由
 *    插件在运行时注入 <style>。
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const PACKAGE_ID = '@lzhida/dsh-session-stats';

await build({
  entryPoints: [`${root}client/src/app.tsx`],
  outfile: `${root}web/app.js`,
  bundle: true,
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});

await build({
  entryPoints: [`${root}client/src/entry.tsx`],
  outfile: `${root}client/index.js`,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'],
  loader: { '.css': 'text' },
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: {
    js: `globalThis.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: function (require) { var module = { exports: {} };`,
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
});
