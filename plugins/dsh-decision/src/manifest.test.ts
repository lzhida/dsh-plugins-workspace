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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { name as askGateName } from './entries/ask-gate.ts';
import { name as decisionToolsName } from './entries/decision-tools.ts';
import { DECISION_TOOL_NAMES, TOOL_SWITCH_KEYS } from './config/index.ts';

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

/**
 * 扫描 monorepo 内其他插件源码里 defineTool 注册的工具名。
 *
 * 契约 §1.2 的「零冲突」结论就是基于全仓扫描得出的——把它变成常驻断言，
 * 别的插件新增同名工具时这里立刻变红。非 monorepo 布局（单包安装）时
 * 扫描不到文件，返回空数组，断言自动跳过。
 */
function collectRepoToolNames(): string[] {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const pluginsDir = `${repoRoot}plugins`;
  if (!existsSync(pluginsDir)) return [];
  const pattern = /defineTool\(\s*\{[^}]{0,400}?name:\s*'([a-z][a-z0-9_]*)'/g;
  const names: string[] = [];
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const srcDir = `${pluginsDir}/${plugin.name}/src`;
    if (!existsSync(srcDir)) continue;
    for (const file of readdirSync(srcDir, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!file.isFile() || !file.name.endsWith('.ts')) continue;
      const full = `${file.parentPath}/${file.name}`;
      const text = readFileSync(full, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const found = match[1];
        if (found) names.push(found);
      }
    }
  }
  return names;
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
    for (const [key, target] of Object.entries(pkg.exports ?? {})) {
      // './client' 指向构建产物（client/dist/index.js）——构建结果不入库
      // （根 .gitignore 的 dist/ 通配），故不参与「文件存在」断言。
      if (key === './client') continue;
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
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(askGateName);
    expect(rows[1].id).toBe(decisionToolsName);
  });

  it('patch 的插件行 name 指向真实入口文件', () => {
    const rows = parseInsertedRows(patch);
    for (const row of rows) {
      const relative = row.name.replace(/^\.\//, '');
      expect(existsSync(`${packageRoot}${relative}`)).toBe(true);
    }
  });

  it('同名冲突守卫：decision_ 工具名唯一且不与既有工具名撞名', () => {
    // 契约 §1.2：十工具名闭集；前缀 decision_ 与宿主/本仓既有工具零冲突。
    expect(new Set(DECISION_TOOL_NAMES).size).toBe(DECISION_TOOL_NAMES.length);
    for (const toolName of DECISION_TOOL_NAMES) {
      expect(toolName.startsWith('decision_')).toBe(true);
      // 与宿主既有工具名不撞名（ask_user_question 由 ask-gate 行注册）。
      expect(toolName).not.toBe('ask_user_question');
    }
    // 两行插件名互不相同（同名会让 loader 定位到错误的行）。
    expect(decisionToolsName).not.toBe(askGateName);
    // 工具名不得与任何插件行 id 撞名（行 id 会出现在工具注册面上）。
    for (const row of parseInsertedRows(patch)) {
      expect(DECISION_TOOL_NAMES).not.toContain(row.id);
    }
    // 与 monorepo 内其他插件已注册的 defineTool 工具名零冲突。
    const repoToolNames = collectRepoToolNames();
    if (repoToolNames.length > 0) {
      for (const toolName of DECISION_TOOL_NAMES) {
        expect(
          repoToolNames,
          `工具名 ${toolName} 与仓库内既有工具名冲突`,
        ).not.toContain(toolName);
      }
    }
  });

  it('工具数与开关数四口径一致（实现闭集 / README / 契约书 / 开关映射）', () => {
    // 口径一：实现侧闭集恒为十工具 + 十开关。
    expect(DECISION_TOOL_NAMES).toHaveLength(10);
    expect(Object.keys(TOOL_SWITCH_KEYS)).toHaveLength(10);
    // 每个工具恰有一个开关字段，且开关字段互不重复。
    const switchFields = Object.values(TOOL_SWITCH_KEYS);
    expect(new Set(switchFields).size).toBe(switchFields.length);
    for (const toolName of DECISION_TOOL_NAMES) {
      expect(TOOL_SWITCH_KEYS[toolName]).toBeTruthy();
    }

    // 口径二/三：README 与契约书都逐个列出十个工具名。
    const readme = readPackageFile('../README.md');
    const contract = readPackageFile('../docs/decision-tools-contract.md');
    for (const toolName of DECISION_TOOL_NAMES) {
      expect(readme, `README 工具清单缺 ${toolName}`).toContain(toolName);
      expect(contract, `契约书工具表缺 ${toolName}`).toContain(toolName);
    }

    // 口径四：README 的「共 N 个」计数与开关数量与实现一致。
    expect(readme).toContain('共 10 个');
    expect(readme).toContain('tools*Enabled`（10 个）');
    // 口径五：README 工具表行数恰好为十行（防「多写一个工具名但计数没改」漂移）。
    const tableRows = readme
      .split('\n')
      .filter((line) => /^\| `decision_[a-z_]+`/.test(line));
    expect(tableRows).toHaveLength(DECISION_TOOL_NAMES.length);
  });

  it('patch 含让位行：出厂 tool-ask-user 停用，避免同名工具重复注册', () => {
    expect(patch).toMatch(/- id: tool-ask-user\s*\n\s*disabled: true/);
  });

  it('框架只出现在 devDependencies（运行时由宿主提供）', () => {
    expect(pkg.dependencies?.['@deepseek-ai/cordis']).toBeUndefined();
    expect(pkg.devDependencies?.['@deepseek-ai/cordis']).toBeDefined();
  });
});
