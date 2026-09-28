import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

/**
 * 把 React 仪表盘(client/src)打包为提交产物 web/app.js:
 * - IIFE + production React 内联,单文件零运行时依赖;
 * - serve 与 export(单文件网页)共用该产物。
 */

const root = fileURLToPath(new URL('..', import.meta.url));

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
