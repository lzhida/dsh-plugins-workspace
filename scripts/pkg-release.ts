#!/usr/bin/env node
/**
 * dsh-plugins-workspace 子包发布辅助 CLI(jiti 直跑,无构建)。
 *
 * 版本递增与 CHANGELOG 由 Changesets 负责:
 *   pnpm changeset            # 声明一次变更(选包、semver 档位、摘要)
 *   pnpm changeset:version    # 写回版本号 + 生成各包 CHANGELOG.md
 *   pnpm changeset:publish    # 发布公开包到 npm(目前仅 @zhidal/dsh-llm-fallback)
 *
 * 本 CLI 承担 Changesets 不覆盖的两环:
 *   1. `tag` —— `{短包名}-v{X.Y.Z}` 形式的 git tag 发布(Changesets 原生
 *      tag 硬编码为 pkg@version 且格式不可配置;Tauri 官方插件 monorepo 的
 *      tag 实际形态正是 `{pkg}-v{X.Y.Z}`,与本仓库约定一致);
 *   2. `publish` —— 按 tag 决策并发布 npm(仅公开包 + 正式版本;prerelease
 *      与私有包跳过)。CI 中由 .github/workflows/release.yml 在 tag 推送时
 *      自动执行同一逻辑。
 * 工具绝不自动 push。
 *
 * 用法(pnpm 透传参数):
 *   pnpm release list
 *   pnpm release tag <包名> [--dry-run] [--allow-dirty]
 *   pnpm release tag --all  [--dry-run] [--allow-dirty]
 *   pnpm release publish <tag> [--dry-run] [--allow-dirty]
 */
import { ReleaseError, tagFor } from './release/core.ts';
import type { WorkspacePackage } from './release/core.ts';
import { findRepoRoot } from './release/git.ts';
import { publishForTag } from './release/publish.ts';
import type { PublishOutcome } from './release/publish.ts';
import { tagAllPackages, tagPackage } from './release/workflow.ts';
import type { TagAllOutcome, TagOutcome } from './release/workflow.ts';
import { listWorkspacePackages } from './release/workspace.ts';

const HELP_TEXT = `dsh-plugins-workspace 子包发布辅助

版本递增与 CHANGELOG 走 Changesets:
  pnpm changeset              声明一次变更(生成 .changeset/*.md)
  pnpm changeset:version      版本号 + CHANGELOG 落盘(提交由你执行)
  pnpm changeset:publish      发布公开包到 npm(仅 @zhidal/dsh-llm-fallback)

本工具(tag 名 = {短包名}-v{X.Y.Z}):
  pnpm release list
      列出全部子包:包名 / 当前版本 / 可见性 / tag 名预览
  pnpm release tag <包名> [选项]
      为子包当前版本(须已提交)补打 annotated tag
  pnpm release tag --all [选项]
      为当前版本尚无 tag 的子包批量补打;已有 tag 的包跳过(幂等)
  pnpm release publish <tag> [选项]
      按发布 tag 决策并发布 npm:仅「公开包 + 正式版本」会真正发布,
      prerelease 与私有包明确跳过(退出 0);tag 与清单版本不一致报错。
      发布线守护:tag 必须存在且指向的提交可从 main 到达(TAG_NOT_ON_MAIN),
      从 dev 等集线提交打的 tag 会被拒绝。
      推送 tag 后由 .github/workflows/release.yml 自动执行同一逻辑
      (CI 用 --client npm-stage 走 OIDC 暂存发布,免 token;发布后需
      维护者在 npm 后台或 npm stage approve 人工放行)。

选项:
  --dry-run      只预览全部步骤与结果,不动 git / 不发 npm
  --allow-dirty  忽略未提交改动检查(不推荐)
  --client <名>  发布客户端:pnpm(默认) | npm(直发) | npm-stage(暂存,CI 用)
  -h, --help     显示本帮助

推荐发布流: changeset → version → 人工提交 → dev 合入 main →
在 main 上 release tag --all → git push --follow-tags
(发布线守护:tag 指向的提交须可从 main 到达,否则发布以 TAG_NOT_ON_MAIN 拒绝;
 公开包正式版 tag 推送后自动发 npm;push 永远由你手动执行)。`;

interface ParsedArgs {
  readonly command: string | undefined;
  readonly positional: readonly string[];
  readonly dryRun: boolean;
  readonly allowDirty: boolean;
  readonly all: boolean;
  readonly client: 'pnpm' | 'npm' | 'npm-stage';
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let dryRun = false;
  let allowDirty = false;
  let all = false;
  let client: 'pnpm' | 'npm' | 'npm-stage' = 'pnpm';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--allow-dirty') {
      allowDirty = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg === '--client') {
      const value = argv[i + 1];
      if (value !== 'pnpm' && value !== 'npm' && value !== 'npm-stage') {
        throw new ReleaseError(
          'USAGE',
          `--client 需要 "pnpm"、"npm" 或 "npm-stage" 参数(收到: ${value ?? '(缺失)'});npm-stage 用于 CI 的 OIDC 暂存发布`,
        );
      }
      client = value;
      i += 1;
    } else if (arg?.startsWith('-')) {
      throw new ReleaseError(
        'USAGE',
        `未知参数 "${arg}";支持 --dry-run、--allow-dirty、--all、--client <pnpm|npm|npm-stage>、--help`,
      );
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return {
    command: positional.shift(),
    positional,
    dryRun,
    allowDirty,
    all,
    client,
  };
}

function formatPackage(pkg: WorkspacePackage, nameWidth: number): string {
  const visibility = pkg.isPrivate ? 'private' : 'public ';
  return `${pkg.name.padEnd(nameWidth)}  ${pkg.version.padEnd(10)}  ${visibility}  tag: ${tagFor(pkg.shortName, pkg.version)}`;
}

function printList(rootDir: string): void {
  const packages = listWorkspacePackages(rootDir);
  if (packages.length === 0) {
    console.log('workspace 中未发现任何子包');
    return;
  }
  const nameWidth = Math.max(...packages.map((pkg) => pkg.name.length));
  for (const pkg of packages) {
    console.log(formatPackage(pkg, nameWidth));
  }
}

function printTag(outcome: TagOutcome): void {
  const prefix = outcome.dryRun ? '[dry-run] ' : '';
  console.log(`${prefix}✔ ${outcome.pkg.name} v${outcome.version}`);
  if (outcome.dryRun) {
    console.log(`${prefix}将打 tag: ${outcome.tag}`);
    console.log(`${prefix}未产生任何改动;去掉 --dry-run 执行实际打 tag`);
    return;
  }
  console.log(`✔ 已创建 tag: ${outcome.tag}(annotated,指向 HEAD)`);
  console.log(`未自动 push;发布到远端请执行: git push origin ${outcome.tag}`);
}

function printTagAll(outcome: TagAllOutcome): void {
  const prefix = outcome.dryRun ? '[dry-run] ' : '';
  for (const item of outcome.created) {
    console.log(
      `${prefix}✔ ${item.pkg.name} v${item.version} → ${item.tag}${outcome.dryRun ? '' : '(annotated,指向 HEAD)'}`,
    );
  }
  for (const item of outcome.skipped) {
    console.log(
      `  - ${item.pkg.name} v${item.version}:tag ${item.tag} 已存在,跳过`,
    );
  }
  if (outcome.dryRun) {
    console.log(
      `${prefix}将创建 ${outcome.created.length} 个 tag,跳过 ${outcome.skipped.length} 个;未产生任何改动`,
    );
    return;
  }
  console.log(
    `完成:新建 ${outcome.created.length} 个,跳过 ${outcome.skipped.length} 个`,
  );
  console.log('未自动 push;发布到远端请执行: git push --follow-tags');
}

function printPublish(outcome: PublishOutcome): void {
  const { decision } = outcome;
  if (decision.action === 'skip') {
    console.log(`- 跳过 npm 发布(${decision.reason}): ${decision.detail}`);
    return;
  }
  const prefix = outcome.dryRun ? '[dry-run] ' : '';
  if (decision.action === 'publish') {
    console.log(
      `${prefix}✔ 发布决策: ${decision.pkg.name}@${decision.version}(tag ${decision.tag})`,
    );
    if (outcome.dryRun) {
      console.log(`${prefix}将执行: ${outcome.command ?? ''}`);
      console.log(`${prefix}未产生任何改动;去掉 --dry-run 执行实际发布`);
      return;
    }
    console.log(`✔ 已发布: ${decision.pkg.name}@${decision.version}`);
    return;
  }
  // fail 决策已在 publishForTag 内抛 ReleaseError,此处仅为穷尽性兜底
  throw new ReleaseError(decision.reason, decision.detail);
}

function runCommand(args: ParsedArgs, rootDir: string): void {
  switch (args.command) {
    case 'list': {
      printList(rootDir);
      return;
    }
    case 'tag': {
      if (args.all) {
        const outcome = tagAllPackages({
          rootDir,
          dryRun: args.dryRun,
          allowDirty: args.allowDirty,
        });
        printTagAll(outcome);
        return;
      }
      if (args.positional.length < 1) {
        throw new ReleaseError(
          'USAGE',
          '缺少参数;用法: pnpm release tag <包名> [--dry-run] [--allow-dirty](或 tag --all)',
        );
      }
      const outcome = tagPackage({
        rootDir,
        query: args.positional[0],
        dryRun: args.dryRun,
        allowDirty: args.allowDirty,
      });
      printTag(outcome);
      return;
    }
    case 'publish': {
      if (args.positional.length < 1) {
        throw new ReleaseError(
          'USAGE',
          '缺少 tag 参数;用法: pnpm release publish <tag> [--dry-run](tag 形如 dsh-llm-fallback-v0.3.2)',
        );
      }
      const outcome = publishForTag({
        rootDir,
        tag: args.positional[0],
        dryRun: args.dryRun,
        allowDirty: args.allowDirty,
        client: args.client,
      });
      printPublish(outcome);
      return;
    }
    case undefined:
      console.log(HELP_TEXT);
      return;
    default:
      throw new ReleaseError(
        'USAGE',
        `未知命令 "${String(args.command)}";可用: list | tag | publish(详见 pnpm release --help)`,
      );
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    console.log(HELP_TEXT);
    return;
  }
  const args = parseArgs(argv);
  const rootDir = findRepoRoot(process.cwd());
  runCommand(args, rootDir);
}

try {
  main();
} catch (error) {
  if (error instanceof ReleaseError) {
    console.error(`✗ [${error.code}] ${error.message}`);
    process.exit(1);
  }
  throw error;
}
