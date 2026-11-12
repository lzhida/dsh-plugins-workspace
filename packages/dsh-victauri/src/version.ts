import { readFileSync } from 'node:fs';

/**
 * 插件版本号。
 *
 * package.json 是唯一真源：这里在运行期读出副本，避免 `changeset:version`
 * 改版本后源码常量漂移（2026-11-12 的 0.1.1 发布就因常量残留 0.1.0 导致
 * CI 单元测试失败）。读不到 package.json 时直接抛错，不做静默兜底——
 * 版本号错了比启动失败更难排查。
 *
 * 路径口径：源码态为 `src/version.ts` → `../package.json`；打包后内联进
 * `dist/index.js` → 同样是 `../package.json`，两者都指向包根的 package.json。
 */
function readPackageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const { version } = JSON.parse(raw) as { version?: string };
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('[dsh-victauri] package.json 缺少 version 字段');
  }
  return version;
}

export const PLUGIN_VERSION = readPackageVersion();
