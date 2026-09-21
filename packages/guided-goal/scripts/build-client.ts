/**
 * client bundle 构建脚本(esbuild)。
 *
 * 社区标准实践(TS/JSX 源码 → esbuild 一步打包 → 产物入库):
 * - 产物 client/index.js 提交进仓库,宿主 dsh client-modules 直读磁盘,
 *   加载链保持零构建、零转译(与官方 dsh-client-ui-settings、goal-planner 同构)。
 * - banner/footer 注入 CJS-in-factory 注册壳:id 必须与包名一致,
 *   factory 必须返回 module.exports。
 * - react 与 @deepseek-ai/* 为 external,运行时由宿主模块表解析。
 */
import { build } from 'esbuild';

const BANNER = [
  '/* eslint-disable */',
  'globalThis.__ModuleLoader__.load({',
  '  id: "@dsh-plugins/guided-goal",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
].join('\n');
const FOOTER = ['    return module.exports;', '  },', '});'].join('\n');

async function main(): Promise<void> {
  await build({
    entryPoints: ['client/src/index.tsx'],
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    external: ['react', '@deepseek-ai/*'],
    banner: { js: BANNER },
    footer: { js: FOOTER },
    outfile: 'client/index.js',
    logLevel: 'info',
  });
}

await main();
