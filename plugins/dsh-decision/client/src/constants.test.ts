/**
 * decision-tools 客户端常量与 patch 行的同步锚定测试（决策工具系列 11/11 收口）。
 *
 * 背景：11/11 的真实 UI 验证抓到一个**只靠单元测试发现不了**的缺陷——
 * `ENTRY_NS` 写成包名派生的 `dsh-decision`，而宿主是按 namespace 取配置
 * scope 的；scope 取不到 → `configForms.whileServed` 不触发 → 插件详情页
 * **不渲染配置卡**（host 半区的验证路由照常工作，看起来像「设置页没做出来」）。
 *
 * 本测试把 ENTRY_NS 与 `cordis.patch.yml` 的 insert 行 id 硬锚在一起：
 * 任何一侧改名都会在此变红，不必等到真实 UI 验证才发现。
 *
 * @module dsh-decision/client/constants.test
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ENTRY_NS, PKG_NAME, PLUGIN_NAME } from './constants.ts';

const patch = readFileSync(
  fileURLToPath(new URL('../../cordis.patch.yml', import.meta.url)),
  'utf8',
);

const pkg = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../package.json', import.meta.url)),
    'utf8',
  ),
) as { name?: string };

/** 取出 patch 里 insert 出来的全部行 id。 */
function insertedRowIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const matched = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (matched) ids.push(matched[1]);
  }
  return ids;
}

describe('decision-tools 客户端常量', () => {
  it('PKG_NAME 与 package.json 的 name 一致（module loader id + 插槽 key）', () => {
    expect(PKG_NAME).toBe(pkg.name);
  });

  it('ENTRY_NS 必须是 cordis.patch.yml 里的真实插件行 id', () => {
    const rowIds = insertedRowIds(patch);
    expect(rowIds.length).toBeGreaterThan(0);
    expect(
      rowIds,
      `ENTRY_NS=${ENTRY_NS} 在 cordis.patch.yml 的插件行 id 里找不到（取不到配置 scope → 详情页不渲染配置卡）`,
    ).toContain(ENTRY_NS);
  });

  it('ENTRY_NS 指向决策工具行（而非 ask-gate 行）', () => {
    expect(ENTRY_NS).toBe(PLUGIN_NAME);
    expect(ENTRY_NS).toBe('decision-tools');
    expect(ENTRY_NS).not.toBe('ask-gate');
  });
});
