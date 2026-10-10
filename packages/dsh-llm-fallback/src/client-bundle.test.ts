import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** 读包目录下相对文件(client bundle 不经打包,直接文本断言)。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

describe('dsh-llm-fallback', () => {
  it('client bundle 注册 id 与 PKG_NAME 同步 package.json 包名(boot graph 契约)', () => {
    const pkg = JSON.parse(readPackageFile('../package.json')) as {
      name: string;
    };
    const client = readPackageFile('../client/index.js');
    // __ModuleLoader__.load 的 id 若与包名不一致,web boot 抛
    // "loaded without registering",client 配置卡整体失效——曾因包改名漏改
    // 该硬编码发布过坏版本(0.3.0),此断言防回归。
    expect(client).toContain(`id: '${pkg.name}',`);
    // plugins.bundle.config 插槽 keyed by 包名,不一致则详情页不渲染配置卡。
    expect(client).toContain(`var PKG_NAME = '${pkg.name}';`);
  });
});
