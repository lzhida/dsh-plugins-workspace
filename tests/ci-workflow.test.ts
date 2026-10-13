/**
 * CI 工作流回归测试。
 *
 * 守护 `.github/workflows/ci.yml` 与仓库实际的门禁约定不漂移：
 * - YAML 语法有效且为 prettier 规范格式（与 `pnpm format:check` 一致）；
 * - 触发面覆盖 main/dev 分支模型的 push 与 pull_request；
 * - 工作流引用的每个 pnpm 脚本都真实存在于根 package.json；
 * - 门禁链顺序与本地门禁一致：format:check → lint → typecheck → test；
 * - 安装使用 --frozen-lockfile，第三方 action 按主版本号固定；
 * - 最小权限（contents: read）与并发取消就位；
 * - Node 矩阵覆盖 engines 下限且均不低于它。
 *
 * 说明：仓库为 pnpm 隔离 node_modules，传递依赖不可直接 import，
 * 因此 YAML 语法校验复用根 devDependencies 中的 prettier（内含 YAML parser），
 * 语义断言走结构化文本检查，不新增任何依赖。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { beforeAll, describe, expect, it } from 'vitest';
import { blockOf, branchesOf, pnpmInvocationsOf } from './workflow-text.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = join(repoRoot, '.github', 'workflows', 'ci.yml');
const pkgPath = join(repoRoot, 'package.json');

const WORKFLOW_RELATIVE_PATH = '.github/workflows/ci.yml';

/** 门禁链中必须按此顺序出现的脚本 */
const GATE_CHAIN = ['format:check', 'lint', 'typecheck', 'test'] as const;

/** pnpm 内建命令，不属于根 package.json 的 scripts，存在性校验时跳过 */
const PNPM_BUILTIN_COMMANDS = new Set(['install']);

interface RootPackage {
  scripts?: Record<string, string>;
  engines?: { node?: string };
}

describe('ci-workflow', () => {
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

  it('触发面覆盖 main/dev 的 push 与 pull_request,并支持手动触发', () => {
    const onBlock = blockOf(workflow, 'on');
    expect(onBlock, '缺少 push 触发').toContain('push:');
    expect(onBlock, '缺少 pull_request 触发').toContain('pull_request:');
    expect(onBlock, '缺少 workflow_dispatch 手动触发').toContain(
      'workflow_dispatch:',
    );

    const pushBranches = branchesOf(
      blockOf(onBlock.trimEnd(), 'push'),
      'push 触发',
    );
    const prBranches = branchesOf(
      blockOf(onBlock.trimEnd(), 'pull_request'),
      'pull_request 触发',
    );
    expect(pushBranches).toEqual(expect.arrayContaining(['main', 'dev']));
    expect(prBranches).toEqual(expect.arrayContaining(['main', 'dev']));
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

  it('门禁链顺序与本地一致:format:check → lint → typecheck → test', () => {
    const gateInvocations = pnpmInvocationsOf(workflow).filter((invocation) =>
      (GATE_CHAIN as readonly string[]).includes(invocation),
    );
    expect(gateInvocations).toEqual([...GATE_CHAIN]);
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

  it('最小权限 contents: read,且配置了并发取消', () => {
    expect(workflow).toMatch(/permissions:\s*\r?\n\s+contents:\s*read/);
    expect(workflow).toMatch(/concurrency:\s*\r?\n/);
    expect(workflow).toMatch(/cancel-in-progress:\s*true/);
  });

  it('Node 矩阵覆盖 engines 下限且均不低于它', () => {
    const enginesNode = pkg.engines?.node ?? '';
    const floorMatch = enginesNode.match(/(\d+)/);
    if (!floorMatch) {
      throw new Error(
        `根 package.json engines.node 无法解析: ${enginesNode || '(缺失)'}`,
      );
    }
    const floor = Number(floorMatch[1]);

    const matrixMatch = workflow.match(/node:\s*\[([^\]]*)\]/);
    if (!matrixMatch) {
      throw new Error('工作流缺少 node 版本矩阵');
    }
    const versions = matrixMatch[1]
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((version) => Number.isFinite(version));

    expect(versions.length, 'node 矩阵不应为空').toBeGreaterThan(0);
    for (const version of versions) {
      expect(
        version,
        `矩阵中的 Node ${version} 低于 engines 下限 ${floor}`,
      ).toBeGreaterThanOrEqual(floor);
    }
    expect(versions, `node 矩阵应覆盖 engines 下限 ${floor}`).toContain(floor);
  });
});
