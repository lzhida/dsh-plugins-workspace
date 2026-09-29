import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 前端构建产物:
 * 1. web/app.js — 独立面板(serve/export 用),IIFE + production React 内联;
 * 2. client/index.js — dsh 客户端插件(ModuleLoader CJS-in-factory 提交产物),
 *    react/react/jsx-runtime 使用宿主运行时实例(external),CSS 以文本内联由
 *    插件在运行时注入 <style>;
 * 3. web/styles.css — 独立页样式,始终从 client/src/dashboard.css 同步,
 *    避免独立/导出页样式与源码脱节。
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

copyFileSync(`${root}client/src/dashboard.css`, `${root}web/styles.css`);
