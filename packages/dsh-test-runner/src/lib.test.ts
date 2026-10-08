/**
 * dsh-test-runner 纯函数单测。
 *
 * 仓库 vitest 惯例:describe 用插件名, it 用中文动宾短句描述行为契约。
 * 零外部 mock — 全部纯函数 + 字面量断言,快速反馈。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPermissionStripPatch,
  dshHomeDir,
  DEFAULT_PORT,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  escapeRegExp,
  filterArgvPnpmDash,
  hasPermissionRow,
  isLikelyTestProfile,
  isPortBusy,
  packageDirOf,
  pluginLoadedRegex,
  profileDir,
  tokenedUrlRegex,
} from './lib.ts';

describe('dsh-test-runner (lib)', () => {
  describe('常量与默认值', () => {
    it('保留与 .agents/skills/.../test-e2e.ts 一致的默认值', () => {
      // 默认值历史:3865 是本机现状产物,3080 是上游默认。
      // 见 AGENTS.md "3080 是上游默认,3865 只是本机现状产物"。
      expect(DEFAULT_PORT).toBe(3865);
      expect(DEFAULT_PROFILE).toBe('e2e');
      expect(DEFAULT_TIMEOUT_MS).toBe(180_000);
    });
  });

  describe('cordis.patch.yml 补丁层构建', () => {
    it('hasPermissionRow 兼容任意缩进', () => {
      expect(hasPermissionRow('- id: permission\n  disabled: true')).toBe(true);
      expect(hasPermissionRow('  - id: permission\n  disabled: true')).toBe(
        true,
      );
      expect(hasPermissionRow('# nothing')).toBe(false);
      expect(hasPermissionRow('- id: tools\n  disabled: true')).toBe(false);
    });

    it('buildPermissionStripPatch:剥除 permission 行 + 紧邻 e2e 注释', () => {
      const before =
        '- id: tools\n' +
        '  disabled: false\n' +
        '# e2e patch 层:被测 local 执行器按设计非禁闭(独占 ctx.shell),与 dsh-base\n' +
        '# 的 permission presets(要求禁闭执行器)互斥,禁用之;e2e 不测升权流。\n' +
        '- id: permission\n' +
        '  disabled: true\n' +
        '- id: jobs\n';
      const after = buildPermissionStripPatch(before);
      expect(after).not.toBeNull();
      expect(after).not.toContain('- id: permission');
      expect(after).not.toContain('e2e patch 层');
      // 其它行不动。
      expect(after).toContain('- id: tools');
      expect(after).toContain('- id: jobs');
    });

    it('buildPermissionStripPatch:剥到无条目时补 `[]` 顶层数组占位', () => {
      const before =
        '# e2e patch 层:…\n' +
        '# 的 permission presets(…)\n' +
        '- id: permission\n' +
        '  disabled: true\n';
      const after = buildPermissionStripPatch(before);
      expect(after).toBe('[]\n');
    });

    it('buildPermissionStripPatch:无 permission 行 → 不动', () => {
      const before = '- id: tools\n';
      expect(buildPermissionStripPatch(before)).toBeNull();
    });
  });

  describe('路径与 token 解析', () => {
    it('packageDirOf:入口绝对路径 → 上两级', () => {
      expect(packageDirOf('/x/packages/dsh-taskboard/src/index.ts')).toBe(
        '/x/packages/dsh-taskboard',
      );
      expect(packageDirOf('C:\\x\\packages\\a\\src\\index.ts')).toBe(
        'C:/x/packages/a',
      );
    });

    it('filterArgvPnpmDash 过滤 pnpm 透传的 `--` 字面量', () => {
      expect(filterArgvPnpmDash(['--', 'a', 'b'])).toEqual(['a', 'b']);
      expect(filterArgvPnpmDash(['a', 'b'])).toEqual(['a', 'b']);
    });

    it('escapeRegExp 处理正则元字符', () => {
      expect(escapeRegExp('dsh-x.y')).toBe('dsh-x\\.y');
      expect(escapeRegExp('[a]+(b)')).toBe('\\[a\\]\\+\\(b\\)');
    });

    it('pluginLoadedRegex 锚到左方括号,避免路径/堆栈裸名假阳性', () => {
      const re = pluginLoadedRegex('packages/dsh-taskboard');
      // 命中结构化日志行:`[dsh-taskboard] plugin loaded`
      expect(re.test('[dsh-taskboard] plugin loaded')).toBe(true);
      // 命中代码中包名(如 `path/to/dsh-taskboard/src`)→ 不算。
      expect(re.test('path/to/dsh-taskboard/src/index.ts')).toBe(false);
      // 命中名字相似但不同的包(如 dsh-taskboard-extras)→ 不算。
      expect(re.test('[dsh-taskboard-extras] plugin loaded')).toBe(false);
    });

    it('tokenedUrlRegex 提取 dsh web banner 的 URL', () => {
      const re = tokenedUrlRegex();
      const m = re.exec('dsh web: http://127.0.0.1:3865/?token=abc');
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe('http://127.0.0.1:3865/?token=abc');
      expect(re.test('no banner here')).toBe(false);
    });
  });

  describe('isPortBusy', () => {
    it('fetcher resolve 即视为占用', async () => {
      const fake = (() =>
        Promise.resolve(
          new Response('', { status: 200 }),
        )) as unknown as typeof fetch;
      expect(await isPortBusy('http://x', fake)).toBe(true);
    });

    it('fetcher reject 视为空闲', async () => {
      const fake = (() =>
        Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
      expect(await isPortBusy('http://x', fake)).toBe(false);
    });
  });

  describe('test profile 分类', () => {
    it('isLikelyTestProfile 命中仓库约定名', () => {
      // 仓库内已存在的 test 用途 profile:
      expect(isLikelyTestProfile('e2e')).toBe(true);
      expect(isLikelyTestProfile('nutest')).toBe(true);
      expect(isLikelyTestProfile('git-smoke')).toBe(true);
      expect(isLikelyTestProfile('stats')).toBe(true);
      expect(isLikelyTestProfile('test')).toBe(true);
      expect(isLikelyTestProfile('foo-test')).toBe(true);
    });

    it('isLikelyTestProfile 排除非 test 用途', () => {
      expect(isLikelyTestProfile('web')).toBe(false);
      expect(isLikelyTestProfile('default')).toBe(false);
      expect(isLikelyTestProfile('desktop')).toBe(false);
    });
  });

  describe('DSH_HOME 解析与 profile 目录', () => {
    it('dshHomeDir 优先 DSH_HOME 环境变量', () => {
      expect(dshHomeDir({ DSH_HOME: '/custom/dsh' }, '/ignored')).toBe(
        '/custom/dsh',
      );
    });

    it('dshHomeDir 回退到注入的 homeDir 拼接 .dsh', () => {
      expect(dshHomeDir({}, '/Users/alice')).toBe('/Users/alice/.dsh');
      expect(dshHomeDir({}, 'C:/Users/alice')).toBe('C:/Users/alice/.dsh');
    });

    it('profileDir 在 home 后拼 profiles/<name>', () => {
      expect(profileDir('e2e', '/Users/alice/.dsh')).toBe(
        '/Users/alice/.dsh/profiles/e2e',
      );
      // 容忍末尾斜杠
      expect(profileDir('e2e', '/Users/alice/.dsh/')).toBe(
        '/Users/alice/.dsh/profiles/e2e',
      );
      // 容忍反斜杠
      expect(profileDir('e2e', 'C:/Users/alice/.dsh')).toBe(
        'C:/Users/alice/.dsh/profiles/e2e',
      );
    });
  });
});
