/**
 * 发布流水线工作流回归测试。
 *
 * 守护 `.github/workflows/release.yml` 与 tag → npm 发布约定不漂移：
 * - YAML 语法有效且为 prettier 规范格式（与 `pnpm format:check` 一致）；
 * - 触发面仅 tag 推送（`*-v*`,即 `{短包名}-v{semver}` 约定形态）；
 * - 引用的 pnpm 脚本真实存在于根 package.json；
 * - 发布前门禁链顺序与本地一致:format:check → lint → typecheck → test;
 * - 认证走 npm OIDC trusted publishing(免 token,不引用 NPM_TOKEN);
 * - 安装使用 --frozen-lockfile,第三方 action 按主版本号固定;
 * - 最小权限(contents: read + id-token: write)与 registry 接线;
 * - Node 24 保证内置 npm ≥ 11.5.1(OIDC 发布最低要求)。
 *
 * YAML 语法校验复用根 devDependencies 中的 prettier(内含 YAML parser),
 * 语义断言走结构化文本检查,不新增任何依赖。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { beforeAll, describe, expect, it } from 'vitest';
import { blockOf, pnpmInvocationsOf, tagsOf } from './workflow-text.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = join(repoRoot, '.github', 'workflows', 'release.yml');
const pkgPath = join(repoRoot, 'package.json');

const WORKFLOW_RELATIVE_PATH = '.github/workflows/release.yml';

/** 门禁链中必须按此顺序出现的脚本 */
const GATE_CHAIN = ['format:check', 'lint', 'typecheck', 'test'] as const;

/** pnpm 内建命令,不属于根 package.json 的 scripts,存在性校验时跳过 */
const PNPM_BUILTIN_COMMANDS = new Set(['install']);

interface RootPackage {
  scripts?: Record<string, string>;
  engines?: { node?: string };
}

describe('release-workflow', () => {
  let workflow = '';
  let pkg: RootPackage = {};

  beforeAll(async () => {
    workflow = await readFile(workflowPath, 'utf8');
    pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as RootPackage;
  });

  it('工作流文件存在', () => {
    expect(workflow.length).toBeGreaterThan(0);
  });

  it('YAML 语法有效且符合 prettier 规范格式', async () => {
    const config = await prettier.resolveConfig(workflowPath);
    const formatted = await prettier.format(workflow, {
      ...(config ?? {}),
      parser: 'yaml',
    });
    expect(formatted).toBe(workflow);
  });

  it('触发面仅 tag 推送,匹配 {短名}-v{semver} 约定形态', () => {
    const onBlock = blockOf(workflow, 'on');
    expect(onBlock, '缺少 push 触发').toContain('push:');
    expect(onBlock, '发布流水线不应监听分支推送').not.toContain('branches:');
    expect(onBlock, '发布流水线不应监听 PR').not.toContain('pull_request:');

    const tags = tagsOf(blockOf(onBlock.trimEnd(), 'push'), 'push 触发');
    expect(tags).toContain('*-v*');
  });

  it('引用的每个 pnpm 脚本都存在于根 package.json', () => {
    const scripts = pkg.scripts ?? {};
    for (const invocation of pnpmInvocationsOf(workflow)) {
      if (PNPM_BUILTIN_COMMANDS.has(invocation)) continue;
      expect(
        scripts[invocation],
        `${WORKFLOW_RELATIVE_PATH} 调用了根 package.json 中不存在的脚本 pnpm ${invocation}`,
      ).toBeTypeOf('string');
    }
  });

  it('发布前门禁链顺序与本地一致:format:check → lint → typecheck → test', () => {
    const gateInvocations = pnpmInvocationsOf(workflow).filter((invocation) =>
      (GATE_CHAIN as readonly string[]).includes(invocation),
    );
    expect(gateInvocations).toEqual([...GATE_CHAIN]);
  });

  it('发布步骤调用 pnpm release publish --client npm-stage 并注入 tag 名', () => {
    expect(workflow).toMatch(
      /run:\s*pnpm release publish "\$\{\{ github\.ref_name \}\}" --client npm-stage/,
    );
  });

  it('暂存发布模式:stage 命令进队列,人工 approve 后才公开', () => {
    expect(workflow).toMatch(/npm stage publish/);
  });

  it('免 token 认证:不引用任何 npm token secret,凭 OIDC id-token 发布', () => {
    expect(
      workflow,
      '迁移 trusted publishing 后不得再引用 NPM_TOKEN',
    ).not.toMatch(/secrets\.NPM_TOKEN/);
    expect(workflow).not.toMatch(/NODE_AUTH_TOKEN/);
  });

  it('npm 认证接线:setup-node 配置官方 registry-url', () => {
    expect(workflow).toMatch(/registry-url:\s*https:\/\/registry\.npmjs\.org/);
  });

  it('安装使用 --frozen-lockfile,lockfile 漂移时直接失败', () => {
    expect(workflow).toMatch(/run:\s*pnpm install\s+--frozen-lockfile/);
  });

  it('第三方 action 均按主版本号固定,不含浮动 ref', () => {
    const uses = [...workflow.matchAll(/uses:\s*(\S+)@(\S+)/g)];
    expect(uses.length, '工作流应至少引用一个 action').toBeGreaterThan(0);
    for (const [, action, ref] of uses) {
      expect(ref, `action ${action} 的 ref 必须是主版本标签(如 v4)`).toMatch(
        /^v\d+$/,
      );
    }
  });

  it('最小权限:contents: read + id-token: write(OIDC 换取发布凭证)', () => {
    expect(workflow).toMatch(/permissions:\s*\r?\n\s+contents:\s*read/);
    expect(workflow).toMatch(/\r?\n\s+id-token:\s*write/);
  });

  it('Node 版本不低于 engines 下限', () => {
    const enginesNode = pkg.engines?.node ?? '';
    const floorMatch = enginesNode.match(/(\d+)/);
    if (!floorMatch) {
      throw new Error(
        `根 package.json engines.node 无法解析: ${enginesNode || '(缺失)'}`,
      );
    }
    const floor = Number(floorMatch[1]);

    const versionMatch = workflow.match(/node-version:\s*\$?\{?\{?\s*(\d+)/);
    if (!versionMatch) {
      throw new Error('工作流缺少 node-version 配置');
    }
    const version = Number(versionMatch[1]);
    expect(
      version,
      `发布流水线 Node ${version} 低于 engines 下限 ${floor}`,
    ).toBeGreaterThanOrEqual(floor);
  });

  it('固定 Node 24:内置 npm ≥ 11.5.1,满足 OIDC trusted publishing 最低要求', () => {
    const versionMatch = workflow.match(/node-version:\s*(\d+)/);
    expect(
      versionMatch ? Number(versionMatch[1]) : 0,
      'OIDC 发布要求 npm ≥ 11.5.1(Node 22 内置 npm 10.x 不够),发布流水线须用 Node 24',
    ).toBe(24);
  });
});
