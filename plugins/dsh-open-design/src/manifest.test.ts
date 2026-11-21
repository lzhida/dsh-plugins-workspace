/**
 * 包元数据与文档互锚契约测试：插件行 id、package.json 依赖策略、
 * README 与代码常量必须一致（工具数、安装命令、配置文件路径）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DIAGNOSTIC_TOOL_COUNT } from './diag-tools.ts';
import { UPSTREAM_TOOL_COUNT_BASELINE } from './runtime.ts';
import { name as pluginName } from './index.ts';

interface PackageManifest {
  name: string;
  version: string;
  private: boolean;
  main: string;
  types: string;
  files: string[];
  exports: Record<string, string>;
  description: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dsh: { bundle: { patch: string } };
}

function readPackageFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    'utf8',
  );
}

const packageRoot = new URL('..', import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL('package.json', packageRoot), 'utf8'),
) as PackageManifest;

const readme = readPackageFile('../README.md');
const patch = readPackageFile('../cordis.patch.yml');

describe('dsh-open-design 包元数据', () => {
  it('包名与作用域符合仓库约定，且为私有包', () => {
    expect(manifest.name).toBe('@zhidal/dsh-open-design');
    expect(manifest.private).toBe(true);
    expect(manifest.description.length).toBeGreaterThan(0);
  });

  it('入口与导出指向真实存在的文件', () => {
    expect(manifest.main).toBe('src/index.ts');
    expect(manifest.types).toBe('src/index.ts');
    expect(manifest.exports['.']).toBe('./src/index.ts');
    for (const relative of [manifest.main, manifest.types]) {
      expect(
        readFileSync(new URL(relative, packageRoot), 'utf8').length,
      ).toBeGreaterThan(0);
    }
  });

  it('files 白名单包含源码、patch 与说明文档', () => {
    expect(manifest.files).toContain('src');
    expect(manifest.files).toContain('docs');
    expect(manifest.files).toContain('cordis.patch.yml');
    expect(manifest.files).toContain('README.md');
  });

  it('dsh.bundle.patch 指向存在的 cordis.patch.yml', () => {
    expect(manifest.dsh.bundle.patch).toBe('./cordis.patch.yml');
    expect(readPackageFile('../cordis.patch.yml').length).toBeGreaterThan(0);
  });

  it('dsh-tools 只作为 peer/dev 依赖，不进 dependencies', () => {
    expect(manifest.dependencies?.['@deepseek-ai/dsh-tools']).toBeUndefined();
    expect(manifest.peerDependencies?.['@deepseek-ai/dsh-tools']).toBeDefined();
    expect(manifest.devDependencies?.['@deepseek-ai/dsh-tools']).toBeDefined();
    expect(manifest.dependencies?.['@deepseek-ai/cordis']).toBeUndefined();
    expect(
      manifest.dependencies?.['@modelcontextprotocol/client'],
    ).toBeDefined();
  });

  it('插件行 id 与入口导出的 name 一致，且指向真实入口文件', () => {
    const idMatch = patch.match(/^\s*-\s+id:\s*(\S+)\s*$/m);
    expect(idMatch).not.toBeNull();
    expect(idMatch?.[1]).toBe(pluginName);

    const nameMatch = patch.match(/^\s+name:\s*'([^']+)'\s*$/m);
    expect(nameMatch).not.toBeNull();
    const entry = nameMatch?.[1] ?? '';
    expect(entry.startsWith('./')).toBe(true);
    expect(
      readFileSync(new URL(entry.replace('./', ''), packageRoot), 'utf8')
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('dsh-open-design README 与代码互锚', () => {
  it('包含安装命令与配置卡字段表', () => {
    expect(readme).toContain(
      'dsh plugin add link:<仓库绝对路径>/plugins/dsh-open-design',
    );
    for (const field of [
      'autoDetect',
      'source',
      'serverName',
      'command',
      'args',
      'env',
      'cwd',
      'startupTimeoutMs',
      'toolCallTimeoutMs',
    ]) {
      expect(readme).toContain(field);
    }
  });

  it('指出插件自己的配置文件目录', () => {
    expect(readme).toContain('~/.dsh/plugins/dsh-open-design/config.json');
  });

  it('工具数口径与代码常量一致', () => {
    expect(DIAGNOSTIC_TOOL_COUNT).toBe(2);
    expect(UPSTREAM_TOOL_COUNT_BASELINE).toBe(22);
    expect(readme).toContain(`${DIAGNOSTIC_TOOL_COUNT} 个诊断工具`);
    expect(readme).toContain(`${UPSTREAM_TOOL_COUNT_BASELINE} 个`);
  });

  it('记录日志前缀、诊断工具名与故障排查章节', () => {
    expect(readme).toContain('[dsh-open-design]');
    expect(readme).toContain('open_design_status');
    expect(readme).toContain('open_design_redetect');
    expect(readme).toContain('故障排查');
  });
});

describe('dsh-open-design 详情文档与代码互锚', () => {
  it('docs/DETAIL.md 存在且记录工具数口径', () => {
    expect(manifest.files).toContain('docs');
    const detail = readPackageFile('../docs/DETAIL.md');
    expect(detail).toContain(`${DIAGNOSTIC_TOOL_COUNT} 个`);
    expect(detail).toContain(`${UPSTREAM_TOOL_COUNT_BASELINE} 个`);
    expect(detail).toContain('open_design_status');
    expect(detail).toContain('open_design_redetect');
  });

  it('详情文档记录配置卡字段、配置文件路径与故障排查', () => {
    const detail = readPackageFile('../docs/DETAIL.md');
    for (const field of [
      'autoDetect',
      'source',
      'serverName',
      'command',
      'args',
      'env',
      'cwd',
      'startupTimeoutMs',
      'toolCallTimeoutMs',
    ]) {
      expect(detail).toContain(field);
    }
    expect(detail).toContain('~/.dsh/plugins/dsh-open-design/config.json');
    expect(detail).toContain('故障排查');
  });
});
