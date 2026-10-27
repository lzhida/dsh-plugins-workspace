/**
 * 子包发布辅助核心纯函数:semver 解析、git tag 名生成与包名解析。
 * 无任何文件系统与 git 依赖,便于单测全覆盖。
 *
 * 版本递增与 CHANGELOG 由 Changesets 负责(.changeset/),本目录只承担
 * `{短包名}-v{X.Y.Z}` 形式的 git tag 发布(见 workflow.ts 与 README.md)。
 */

/** 发布辅助相关的结构化错误码。 */
export type ReleaseErrorCode =
  | 'USAGE'
  | 'WORKSPACE_CONFIG'
  | 'PKG_NOT_FOUND'
  | 'PKG_AMBIGUOUS'
  | 'PKG_MANIFEST_INVALID'
  | 'PKG_VERSION_MISSING'
  | 'INVALID_CURRENT_VERSION'
  | 'TAG_EXISTS'
  | 'TAG_NOT_FOUND'
  | 'TAG_NOT_ON_MAIN'
  | 'RELEASE_LINE_NOT_FOUND'
  | 'TAG_VERSION_MISMATCH'
  | 'DIRTY_WORKTREE'
  | 'NOT_A_GIT_REPO'
  | 'GIT_FAILURE'
  | 'PUBLISH_FAILED';

/** 结构化错误:CLI 按 code 输出文案并以非零码退出,测试按 code 断言。 */
export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;

  constructor(code: ReleaseErrorCode, message: string) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

/** workspace 内一个受版本管理的子包。 */
export interface WorkspacePackage {
  /** 完整包名,如 `@zhidal/dsh-taskboard`。 */
  readonly name: string;
  /** 不含 scope 的短名,与包目录名一致,作为 git tag 前缀。 */
  readonly shortName: string;
  /** 当前 semver 版本。 */
  readonly version: string;
  /** package.json 的 private 字段(true 的包不发布 npm,仅做仓库内版本标记)。 */
  readonly isPrivate: boolean;
  /** 相对仓库根目录的 posix 风格目录,如 `packages/dsh-taskboard`。 */
  readonly dir: string;
}

/** 解析后的 semver 各段(build 元数据不参与比较,解析时忽略)。 */
export interface SemverParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** 预发布段(如 `rc.1`),无则缺省。 */
  readonly prerelease?: string;
}

/** semver 2.0.0 官方正则(含预发布与 build 元数据段)。 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** 解析 semver 字符串;失败时以指定错误码与文案抛出 ReleaseError。 */
export function parseSemver(
  version: string,
  code: ReleaseErrorCode,
  messagePrefix: string,
): SemverParts {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) {
    throw new ReleaseError(
      code,
      `${messagePrefix}:"${version}" 不是合法的 semver(如 1.2.3、1.2.3-rc.1)`,
    );
  }
  const parts: SemverParts = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] === undefined ? {} : { prerelease: match[4] }),
  };
  return parts;
}

/** 生成 git tag 名:`{短包名}-v{版本}`,如 `dsh-taskboard-v0.2.0`。 */
export function tagFor(shortName: string, version: string): string {
  return `${shortName}-v${version}`;
}

/** 版本是否为合法 semver(parseSemver 的不抛错探测版,用于 tag 解析过滤)。 */
export function isSemver(version: string): boolean {
  return SEMVER_PATTERN.test(version);
}

/** 从完整包名提取短名(最后一个 `/` 之后的段);无 scope 时原样返回。 */
export function shortNameOf(name: string): string {
  const idx = name.lastIndexOf('/');
  return idx >= 0 ? name.slice(idx + 1) : name;
}

/**
 * 把用户输入的包名解析为 workspace 包:先精确匹配完整名(`@scope/short`),
 * 再精确匹配短名(`short`);零命中或命中多个时分别抛错。
 */
export function resolvePackageName(
  query: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage {
  const fullHits = packages.filter((pkg) => pkg.name === query);
  const hits =
    fullHits.length > 0
      ? fullHits
      : packages.filter((pkg) => pkg.shortName === query);
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) {
    const available = packages.map((pkg) => pkg.name).join(', ');
    throw new ReleaseError(
      'PKG_NOT_FOUND',
      `找不到包 "${query}";workspace 中可用: ${available || '(无子包)'}`,
    );
  }
  const names = hits.map((pkg) => pkg.name).join(', ');
  throw new ReleaseError(
    'PKG_AMBIGUOUS',
    `包名 "${query}" 命中多个包,请使用完整包名: ${names}`,
  );
}
