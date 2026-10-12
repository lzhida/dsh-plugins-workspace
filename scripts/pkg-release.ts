#!/usr/bin/env node
/**
 * dsh-plugins-workspace 子包发布辅助 CLI(jiti 直跑,无构建)。
 *
 * 版本递增与 CHANGELOG 由 Changesets 负责:
 *   pnpm changeset            # 声明一次变更(选包、semver 档位、摘要)
 *   pnpm changeset:version    # 写回版本号 + 生成各包 CHANGELOG.md
 *   pnpm changeset:publish    # 发布公开包到 npm(目前仅 @zhidal/dsh-llm-fallback)
 *
 * 本 CLI 只负责 Changesets 不覆盖的最后一环——`{短包名}-v{X.Y.Z}` 形式的
 * git tag 发布(Changesets 原生 tag 硬编码为 pkg@version 且格式不可配置;
 * Tauri 官方插件 monorepo 的 tag 实际形态正是 `{pkg}-v{X.Y.Z}`,与本仓库
 * 约定一致)。工具绝不自动 push。
 *
 * 用法(pnpm 透传参数):
 *   pnpm release list
 *   pnpm release tag <包名> [--dry-run] [--allow-dirty]
 *   pnpm release tag --all  [--dry-run] [--allow-dirty]
 */
import { ReleaseError, tagFor } from './release/core.ts';
import type { WorkspacePackage } from './release/core.ts';
import { findRepoRoot } from './release/git.ts';
import { tagAllPackages, tagPackage } from './release/workflow.ts';
import type { TagAllOutcome, TagOutcome } from './release/workflow.ts';
import { listWorkspacePackages } from './release/workspace.ts';

const HELP_TEXT = `dsh-plugins-workspace 子包发布辅助

版本递增与 CHANGELOG 走 Changesets:
  pnpm changeset              声明一次变更(生成 .changeset/*.md)
  pnpm changeset:version      版本号 + CHANGELOG 落盘(提交由你执行)
  pnpm changeset:publish      发布公开包到 npm(仅 @zhidal/dsh-llm-fallback)

本工具(tag 发布,tag 名 = {短包名}-v{X.Y.Z}):
  pnpm release list
      列出全部子包:包名 / 当前版本 / 可见性 / tag 名预览
  pnpm release tag <包名> [选项]
      为子包当前版本(须已提交)补打 annotated tag
  pnpm release tag --all [选项]
      为当前版本尚无 tag 的子包批量补打;已有 tag 的包跳过(幂等)

选项:
  --dry-run      只预览全部步骤与结果,不动 git
  --allow-dirty  忽略未提交改动检查(不推荐)
  -h, --help     显示本帮助

推荐发布流: changeset → version → 人工提交 → release tag --all → git push --follow-tags
(push 永远由你手动执行)。`;

interface ParsedArgs {
  readonly command: string | undefined;
  readonly positional: readonly string[];
  readonly dryRun: boolean;
  readonly allowDirty: boolean;
  readonly all: boolean;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let dryRun = false;
  let allowDirty = false;
  let all = false;
  for (const arg of argv) {
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--allow-dirty') {
      allowDirty = true;
    } else if (arg === '--all') {
      all = true;
    } else if (arg.startsWith('-')) {
      throw new ReleaseError(
        'USAGE',
        `未知参数 "${arg}";支持 --dry-run、--allow-dirty、--all、--help`,
      );
    } else {
      positional.push(arg);
    }
  }
  return {
    command: positional.shift(),
    positional,
    dryRun,
    allowDirty,
    all,
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
    case undefined:
      console.log(HELP_TEXT);
      return;
    default:
      throw new ReleaseError(
        'USAGE',
        `未知命令 "${String(args.command)}";可用: list | tag(详见 pnpm release --help)`,
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
