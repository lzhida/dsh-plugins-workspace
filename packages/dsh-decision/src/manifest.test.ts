/**
 * 包元数据（manifest）契约防回归测试。
 *
 * 本包的「身份」散在三处，任何一处漂移都会让插件在宿主里加载不到：
 * - `package.json` 的 `main` / `exports` / `files` / `dsh.bundle.patch`；
 * - 包内 `cordis.patch.yml` 的插件行 id 与让位行；
 * - 入口文件导出的插件名（loader 以 id 定位行、以 name 找模块）。
 *
 * 本测试把三处互锚：改包结构却没改 patch（或反之）时在此变红。
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { name as askGateName } from './entries/ask-gate.ts';

/** npm 发布元数据里与本包相关的字段形状（只声明测试关心的部分）。 */
interface PackageManifest {
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  types?: string;
  files?: string[];
  exports?: Record<string, string>;
  dsh?: {
    bundle?: {
      patch?: string;
    };
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** 读包目录下相对文件。 */
function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

/** 包根目录绝对路径（src/ 的上一级）。 */
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

const pkg = JSON.parse(readPackageFile('../package.json')) as PackageManifest;
const patch = readPackageFile('../cordis.patch.yml');

/** 从 patch 里解析 insert 出来的插件行（id + name）。 */
function parseInsertedRows(text: string): { id: string; name: string }[] {
  const rows: { id: string; name: string }[] = [];
  let pendingId: string | undefined;
  for (const line of text.split('\n')) {
    const idMatch = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (idMatch) {
      pendingId = idMatch[1];
      continue;
    }
    const nameMatch = /^\s+name:\s*'([^']+)'\s*$/.exec(line);
    if (nameMatch && pendingId !== undefined) {
      rows.push({ id: pendingId, name: nameMatch[1] });
      pendingId = undefined;
    }
  }
  return rows;
}

describe('dsh-decision manifest', () => {
  it('包名符合 @zhidal/ scope 约定', () => {
    expect(pkg.name).toBe('@zhidal/dsh-decision');
  });

  it('当前为私有包（未发布 npm），README 同步声明', () => {
    // 本包是 TS 源码入口（main 指 src/index.ts），实体安装会被 Node 的
    // type-stripping 拒绝，因此只能 link: 安装——不发布 npm。
    expect(pkg.private).toBe(true);
    expect(readPackageFile('../README.md')).toContain('私有包');
  });

  it('main / types / exports 指向的文件真实存在', () => {
    expect(pkg.main).toBe('src/index.ts');
    expect(
      existsSync(fileURLToPath(new URL('../src/index.ts', import.meta.url))),
    ).toBe(true);
    expect(
      existsSync(fileURLToPath(new URL('../src/cordis.d.ts', import.meta.url))),
    ).toBe(true);
    for (const target of Object.values(pkg.exports ?? {})) {
      expect(existsSync(`${packageRoot}${target}`)).toBe(true);
    }
  });

  it('files 白名单含 src / cordis.patch.yml / README.md（随包交付）', () => {
    expect(pkg.files).toContain('src');
    expect(pkg.files).toContain('cordis.patch.yml');
    expect(pkg.files).toContain('README.md');
  });

  it('dsh.bundle.patch 指向存在的 patch 文件', () => {
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    expect(existsSync(`${packageRoot}cordis.patch.yml`)).toBe(true);
  });

  it('patch 的插件行 id 与入口导出的 name 一致（loader 以 id 定位行）', () => {
    const rows = parseInsertedRows(patch);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(askGateName);
  });

  it('patch 的插件行 name 指向真实入口文件', () => {
    const rows = parseInsertedRows(patch);
    const relative = rows[0].name.replace(/^\.\//, '');
    expect(existsSync(`${packageRoot}${relative}`)).toBe(true);
  });

  it('patch 含让位行：出厂 tool-ask-user 停用，避免同名工具重复注册', () => {
    expect(patch).toMatch(/- id: tool-ask-user\s*\n\s*disabled: true/);
  });

  it('框架只出现在 devDependencies（运行时由宿主提供）', () => {
    expect(pkg.dependencies?.['@deepseek-ai/cordis']).toBeUndefined();
    expect(pkg.devDependencies?.['@deepseek-ai/cordis']).toBeDefined();
  });
});
