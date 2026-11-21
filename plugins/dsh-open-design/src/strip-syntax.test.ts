/**
 * strip-only 语法守卫（真机等价加载）。
 *
 * 宿主以 TS 源码直载插件（Node --experimental-strip-types）：只「擦类型」，
 * 不做参数属性/枚举/namespace 等需要转换的语法——tsc 对这些完全放行，
 * 只有真机加载才报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX（系列 4/6 真机
 * 联调发现 HttpError 参数属性即此坑）。本测试用子进程按宿主同款方式
 * import 插件入口，把这类违规挡进门禁。
 *
 * @module dsh-open-design/strip-syntax
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('dsh-open-design', () => {
  it('宿主 strip-only 加载插件入口不报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX', () => {
    // vitest 的 import.meta.url 可能带 ?v= 查询，fileURLToPath 对带查询的
    // file URL 会抛错——先剥掉 search 再解析同目录入口。
    const moduleUrl = new URL(import.meta.url);
    moduleUrl.search = '';
    const entry = pathToFileURL(
      fileURLToPath(new URL('./index.ts', moduleUrl)),
    ).href;
    const script = [
      `import(${JSON.stringify(entry)})`,
      `.then(() => console.log('STRIP_OK'))`,
      `.catch((err) => { console.error(err && err.message ? err.message : String(err)); process.exit(1); })`,
    ].join('');
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '-e', script],
      { encoding: 'utf8', timeout: 60_000 },
    );
    expect(
      result.status,
      `stderr=${result.stderr.slice(0, 600)} stdout=${result.stdout.slice(0, 300)}`,
    ).toBe(0);
    expect(result.stdout).toContain('STRIP_OK');
    expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
  });
});
