/**
 * dsh-test-runner 纯函数单测。
 *
 * 仓库 vitest 惯例:describe 用插件名, it 用中文动宾短句描述行为契约。
 * 零外部 mock — 全部纯函数 + 字面量断言,快速反馈。
 */
import { describe, expect, it } from 'vitest';
import {
  buildPermissionDisablePatch,
  buildPermissionStripPatch,
  dshHomeDir,
  DEFAULT_PORT,
  DEFAULT_PROFILE,
  DEFAULT_TIMEOUT_MS,
  escapeRegExp,
  filterArgvPnpmDash,
  hasPermissionRow,
  isLikelyTestProfile,
  isLocalNushellExecutor,
  isPortBusy,
  isSandboxNushellExecutor,
  needsPermissionDisable,
  needsPermissionStrip,
  packageDirOf,
  PERMISSION_DISABLE_BLOCK,
  permissionStripReason,
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

    it('PERMISSION_DISABLE_BLOCK 顶层是合法 YAML 数组段', () => {
      // 顶层数组条目必须是 `- id: permission` 形态;末尾需有换行使后续
      // 拼接不破坏 YAML 文档结构。
      expect(PERMISSION_DISABLE_BLOCK).toContain('- id: permission');
      expect(PERMISSION_DISABLE_BLOCK).toContain('  disabled: true');
      expect(PERMISSION_DISABLE_BLOCK.endsWith('\n')).toBe(true);
    });
  });

  describe('plugin 包名分类', () => {
    it('识别 dsh-nushell-local 为 local executor(需禁用 permission presets)', () => {
      expect(isLocalNushellExecutor('@lzhida/dsh-nushell-local')).toBe(true);
      expect(isLocalNushellExecutor('dsh-nushell-local')).toBe(true);
    });

    it('识别 dsh-nushell-sandbox 为 sandbox executor(保留 permission 栈)', () => {
      expect(isSandboxNushellExecutor('@lzhida/dsh-nushell-sandbox')).toBe(
        true,
      );
      expect(isSandboxNushellExecutor('dsh-nushell-sandbox')).toBe(true);
    });

    it('无关包名一律返回 false(不与 nushell 命名碰撞)', () => {
      expect(isLocalNushellExecutor('dsh-guided-goal')).toBe(false);
      expect(isLocalNushellExecutor('dsh-taskboard')).toBe(false);
      expect(isLocalNushellExecutor('dsh-nushell')).toBe(false); // combo 不算
      expect(isSandboxNushellExecutor('dsh-nushell')).toBe(false); // combo 不算
    });

    it('needsPermissionDisable 仅在存在 local executor 时为 true', () => {
      expect(needsPermissionDisable(['@lzhida/dsh-nushell-local'])).toBe(true);
      expect(
        needsPermissionDisable(['dsh-guided-goal', 'dsh-nushell-local']),
      ).toBe(true);
      expect(needsPermissionDisable(['dsh-guided-goal'])).toBe(false);
      expect(needsPermissionDisable(['dsh-nushell-sandbox'])).toBe(false);
      expect(needsPermissionDisable([])).toBe(false);
    });

    it('needsPermissionStrip 在 sandbox 或直跑时为 true', () => {
      expect(needsPermissionStrip(['dsh-nushell-sandbox'])).toBe(true);
      expect(needsPermissionStrip(['dsh-guided-goal'])).toBe(true);
      expect(needsPermissionStrip([])).toBe(true);
      // local 永远不剥(本来就没装)。
      expect(needsPermissionStrip(['dsh-nushell-local'])).toBe(false);
    });

    it('permissionStripReason 在 sandbox / 直跑时返回不同解释', () => {
      expect(permissionStripReason(['dsh-nushell-sandbox'])).toContain(
        'sandbox',
      );
      expect(permissionStripReason(['dsh-guided-goal'])).toContain('直跑');
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

    it('buildPermissionDisablePatch:local executor + 缺 permission 行 → 追加', () => {
      const before = '[]\n';
      const after = buildPermissionDisablePatch(before, [
        '@lzhida/dsh-nushell-local',
      ]);
      expect(after).not.toBeNull();
      expect(after).toContain('- id: permission');
      expect(after).toContain('  disabled: true');
      // 占位 `[]` 必须被剥离再追加(避免「[] + 追加行」双文档崩溃)。
      expect(after).not.toMatch(/^\[\]\s*$/m);
    });

    it('buildPermissionDisablePatch:local executor + 已有 permission 行 → 不动', () => {
      const before = '- id: permission\n  disabled: true\n';
      expect(
        buildPermissionDisablePatch(before, ['@lzhida/dsh-nushell-local']),
      ).toBeNull();
    });

    it('buildPermissionDisablePatch:非 local 场景 → 不动', () => {
      expect(
        buildPermissionDisablePatch('[]\n', ['dsh-guided-goal']),
      ).toBeNull();
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
      const after = buildPermissionStripPatch(before, [
        '@lzhida/dsh-nushell-sandbox',
      ]);
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
      const after = buildPermissionStripPatch(before, ['dsh-guided-goal']);
      expect(after).toBe('[]\n');
    });

    it('buildPermissionStripPatch:无 permission 行 → 不动', () => {
      const before = '- id: tools\n';
      expect(buildPermissionStripPatch(before, ['dsh-guided-goal'])).toBeNull();
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
