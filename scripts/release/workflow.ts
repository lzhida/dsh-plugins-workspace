/**
 * tag 发布编排:为子包当前版本(应已随 `changeset version` 提交)补打
 * `{短名}-v{X.Y.Z}` annotated tag。支持单包与批量(--all,跳过已有 tag)
 * 以及 dry-run 全流程预览;绝不自动 push。
 *
 * 版本递增与提交由 Changesets 负责,本模块只消费 package.json 的当前版本。
 * tag message 内容源为包 CHANGELOG.md 中该版本的段落(见 changelog.ts):
 * 首行 `{包名} v{版本}`,空行后接更新说明;段落缺失时降级为纯首行,
 * 打 tag 永不因 CHANGELOG 缺失而失败。
 */
import {
  ReleaseError,
  parseSemver,
  resolvePackageName,
  tagFor,
} from './core.ts';
import type { WorkspacePackage } from './core.ts';
import { buildTagMessage, readChangelogSection } from './changelog.ts';
import {
  createAnnotatedTag,
  currentBranch,
  tagExists,
  worktreeIsClean,
} from './git.ts';
import { listWorkspacePackages } from './workspace.ts';

/** tag 命令共用的选项。 */
export interface TagOptions {
  /** 仓库根目录(绝对路径);CLI 层负责由 cwd 解析。 */
  readonly rootDir: string;
  /** 忽略脏工作树检查(不推荐,逃生门)。 */
  readonly allowDirty?: boolean;
  /** 只预览不落盘。 */
  readonly dryRun?: boolean;
}

/** 单个包的 tag 结果。 */
export interface TagOutcome {
  readonly pkg: WorkspacePackage;
  readonly version: string;
  readonly tag: string;
  readonly branch: string;
  /** annotated tag 的完整 message(subject + 空行 + CHANGELOG 段落)。 */
  readonly message?: string;
  readonly dryRun: boolean;
}

/** 批量 tag 的结果:created 为新打的,skipped 为 tag 已存在的。 */
export interface TagAllOutcome {
  readonly created: readonly TagOutcome[];
  readonly skipped: readonly TagOutcome[];
  readonly branch: string;
  readonly dryRun: boolean;
}

function assertTagAvailable(rootDir: string, tag: string): void {
  if (tagExists(rootDir, tag)) {
    throw new ReleaseError(
      'TAG_EXISTS',
      `tag ${tag} 已存在;如确需重打,先执行 git tag -d ${tag}`,
    );
  }
}

function assertCleanWorktree(
  rootDir: string,
  allowDirty: boolean,
  reason: string,
): void {
  if (allowDirty || worktreeIsClean(rootDir)) return;
  throw new ReleaseError(
    'DIRTY_WORKTREE',
    `工作树存在未提交改动,${reason};请先提交或暂存(stash),确有必要时加 --allow-dirty`,
  );
}

/** 校验清单版本是合法 semver,防止把非法版本号打进 tag。 */
function assertValidVersion(pkg: WorkspacePackage): string {
  parseSemver(
    pkg.version,
    'INVALID_CURRENT_VERSION',
    `包 ${pkg.name} 的当前版本非法,请先修正 package.json`,
  );
  return pkg.version;
}

/** 组装 tag message:subject + 空行 + 该版本 CHANGELOG 段落(缺失降级)。 */
function buildMessageFor(
  rootDir: string,
  pkg: WorkspacePackage,
  version: string,
): string {
  const section = readChangelogSection(rootDir, pkg.dir, version);
  return buildTagMessage(pkg.name, version, section);
}

function tagOne(input: {
  rootDir: string;
  pkg: WorkspacePackage;
  allowDirty: boolean;
  dryRun: boolean;
}): TagOutcome {
  const { rootDir, pkg, allowDirty, dryRun } = input;
  const version = assertValidVersion(pkg);
  const tag = tagFor(pkg.shortName, version);
  assertTagAvailable(rootDir, tag);
  const branch = currentBranch(rootDir);
  const message = buildMessageFor(rootDir, pkg, version);
  if (dryRun) return { pkg, version, tag, branch, message, dryRun: true };
  assertCleanWorktree(
    rootDir,
    allowDirty,
    'tag 将指向 HEAD 而非当前工作树内容',
  );
  createAnnotatedTag(rootDir, tag, message);
  return { pkg, version, tag, branch, message, dryRun: false };
}

/**
 * 为单个子包当前版本补打 annotated tag(前提:该版本号已在提交中)。
 * 脏工作树时默认拒绝——tag 指向 HEAD,不代表未提交的内容。
 */
export function tagPackage(input: TagOptions & { query: string }): TagOutcome {
  const { rootDir, allowDirty = false, dryRun = false } = input;
  const pkg = resolvePackageName(input.query, listWorkspacePackages(rootDir));
  return tagOne({ rootDir, pkg, allowDirty, dryRun });
}

/**
 * 为 workspace 全部子包批量补打当前版本的 annotated tag:
 * 已有同名 tag 的包跳过(幂等,可重复执行),其余逐个创建。
 * 脏工作树时在打第一个 tag 之前整体拒绝,保证批量原子性。
 */
export function tagAllPackages(input: TagOptions): TagAllOutcome {
  const { rootDir, allowDirty = false, dryRun = false } = input;
  const packages = listWorkspacePackages(rootDir);
  if (packages.length === 0) {
    throw new ReleaseError(
      'WORKSPACE_CONFIG',
      'workspace 中未发现任何子包,无 tag 可打',
    );
  }
  const branch = currentBranch(rootDir);
  if (!dryRun) {
    assertCleanWorktree(
      rootDir,
      allowDirty,
      'tag 将指向 HEAD 而非当前工作树内容',
    );
  }
  const created: TagOutcome[] = [];
  const skipped: TagOutcome[] = [];
  for (const pkg of packages) {
    const version = assertValidVersion(pkg);
    const tag = tagFor(pkg.shortName, version);
    const outcome: TagOutcome = { pkg, version, tag, branch, dryRun };
    if (tagExists(rootDir, tag)) {
      skipped.push(outcome);
      continue;
    }
    const message = buildMessageFor(rootDir, pkg, version);
    if (dryRun) {
      created.push({ ...outcome, message });
      continue;
    }
    createAnnotatedTag(rootDir, tag, message);
    created.push({ ...outcome, message });
  }
  return { created, skipped, branch, dryRun };
}
