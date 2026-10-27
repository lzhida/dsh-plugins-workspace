/**
 * GitHub Release 创建编排:按发布 tag 复用与 npm 发布**同一套三态决策**
 * (decidePublish),仅对 publish 决策(公开包 + 正式版本)创建 GitHub
 * Release;skip 决策不碰网络直接返回;fail 决策抛 ReleaseError。
 *
 * release notes 内容源为包 CHANGELOG.md 中该版本的段落(与 annotated tag
 * message 同源,见 changelog.ts)——tag 页、Release 页、CHANGELOG 三处
 * 内容一致。段落缺失时用兜底文案,不阻塞。
 *
 * 执行器走 `gh release create <tag> --title ... --notes ...`(cwd 为仓库根;
 * 凭证由调用环境提供,CI 为 GH_TOKEN=${{ github.token }},runner 预装 gh)。
 * Release 已存在(如流水线重放)按幂等成功处理,不算失败。
 *
 * 与 publishForTag 的关系:本模块**不替代**也不内嵌 npm 发布——npm 暂存
 * (publish 命令)与 GitHub Release 创建是发布流水线里两个显式步骤,CI 在
 * 暂存成功后调用本模块;本地可在发布后手动执行同一子命令补建。
 */
import { spawnSync } from 'node:child_process';
import { ReleaseError } from './core.ts';
import { buildReleaseNotes, readChangelogSection } from './changelog.ts';
import { decidePublish } from './publish.ts';
import type { PublishDecision } from './publish.ts';
import { listWorkspacePackages } from './workspace.ts';

/** gh 执行器结果:alreadyExists 标记幂等命中(release 已创建过)。 */
export interface GhRunnerResult {
  readonly alreadyExists?: boolean;
}

/** gh 执行器注入接口(测试替身;默认 runGhCommand 走子进程)。 */
export type GhRunner = (input: {
  readonly cwd: string;
  readonly command: string;
  readonly args: readonly string[];
}) => GhRunnerResult | void;

/**
 * 默认 gh 执行器:在仓库根同步执行 gh 子命令;stdout 透传(`gh release
 * create` 会打印 release URL),stderr 捕获用于幂等判定与错误信息。
 * 不经 shell:gh 在 Windows 上是真实二进制(gh.exe,非 npm/pnpm 那类 .cmd
 * 垫片),直接 spawn 避免 args 里的空格/引号被 cmd 二次解释。
 * 非零退出抛 PUBLISH_FAILED——唯一豁免是 release 已存在(幂等,如流水线
 * 重放),返回 { alreadyExists: true } 按成功处理。
 */
export const runGhCommand: GhRunner = ({ cwd, command, args }) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  if (result.error !== undefined) {
    throw new ReleaseError(
      'PUBLISH_FAILED',
      `无法执行 ${command}(${result.error.message});请确认 gh 已安装并在 PATH 中,且 GH_TOKEN/GITHUB_TOKEN 已配置`,
    );
  }
  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim();
    // 幂等:该 tag 的 release 已创建过 → 按成功处理(重放安全)
    if (result.status === 1 && /already.?exists/i.test(stderr)) {
      return { alreadyExists: true };
    }
    throw new ReleaseError(
      'PUBLISH_FAILED',
      `gh ${args.join(' ')} 失败(exit ${String(result.status)}): ${stderr}`,
    );
  }
  return {};
};

/** githubReleaseForTag 的结果。 */
export interface GithubReleaseOutcome {
  /** 完整三态决策(publish / skip),供调用方输出原因与版本信息。 */
  readonly decision: PublishDecision;
  readonly dryRun: boolean;
  /** 决策为 publish 且(非 dry-run)实际创建了 Release。 */
  readonly created: boolean;
  /** Release 已存在(幂等命中,未重复创建)。 */
  readonly alreadyExists: boolean;
  /** release notes(CHANGELOG 段落或兜底文案;skip 时为 null)。 */
  readonly notes: string | null;
  /** 仅 publish 决策存在:dry-run 为预览的完整命令。 */
  readonly command?: string;
}

/**
 * 按发布 tag 决策并创建 GitHub Release:
 * - fail 决策 → 抛 ReleaseError,调用方非零退出;
 * - skip 决策 → 原样返回(不碰 gh),notes 为 null;
 * - publish 决策 → notes 取包 CHANGELOG 该版本段(缺失走兜底文案),执行
 *   `gh release create`;dry-run 只返回将执行的命令与 notes 预览。
 *
 * 不重复 npm 发布侧的发布线守护(assertTagOnReleaseLine):创建 Release
 * 以 npm 暂存成功为前置(CI 编排顺序保证),决策所需的完整性与可见性校验
 * 已由 decidePublish 覆盖。
 */
export function githubReleaseForTag(input: {
  readonly rootDir: string;
  readonly tag: string;
  readonly dryRun?: boolean;
  readonly exec?: GhRunner;
}): GithubReleaseOutcome {
  const { rootDir, tag, dryRun = false, exec = runGhCommand } = input;
  const decision = decidePublish({
    tag,
    packages: listWorkspacePackages(rootDir),
  });
  if (decision.action === 'fail') {
    throw new ReleaseError(decision.reason, decision.detail);
  }
  if (decision.action === 'skip') {
    return {
      decision,
      dryRun,
      created: false,
      alreadyExists: false,
      notes: null,
    };
  }
  const { pkg, version } = decision;
  const notes = buildReleaseNotes(
    pkg.name,
    version,
    readChangelogSection(rootDir, pkg.dir, version),
  );
  const args = [
    'release',
    'create',
    tag,
    '--title',
    `${pkg.name} v${version}`,
    '--notes',
    notes,
    '--verify-tag',
  ];
  const command = `gh ${args.join(' ')}(cwd: repo root)`;
  if (dryRun) {
    return {
      decision,
      dryRun: true,
      created: false,
      alreadyExists: false,
      notes,
      command,
    };
  }
  const result = exec({ cwd: rootDir, command: 'gh', args });
  const alreadyExists = result?.alreadyExists === true;
  return {
    decision,
    dryRun: false,
    created: !alreadyExists,
    alreadyExists,
    notes,
  };
}
