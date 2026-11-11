/**
 * tag → npm 发布流水线:解析 `{短包名}-v{semver}` 形式的发布 tag,校验
 * 包存在性、短名唯一性与 tag/清单版本一致性后,仅对「公开包 + 正式版本」
 * 执行发布。prerelease 版本与私有包按约定明确跳过(不算错误);完整性问题
 * (tag 不指向已提交版本、短名歧义)直接失败。发布决策只接受**发布线上的
 * tag**:tag 必须存在且其指向的提交可从 main 到达(发布线守护,见
 * assertTagOnReleaseLine),贴合仓库 main(发布线)/ dev(集线)分支模型。
 * dry-run 全程预览,绝不触碰网络。
 *
 * 发布客户端(见 PublishClient):pnpm 为默认(本地);CI 走 `npm-stage` 的
 * OIDC 暂存发布(免 token,需 npm 包后台登记 trusted publisher;版本进暂存
 * 队列后由维护者人工放行)。不用 pnpm 发布的原因:pnpm 11 原生 publish 的
 * OIDC 在 CI 不可靠(见 pnpm/pnpm#11513),且 pnpm 无 stage 子命令。
 *
 * 版本递增与 CHANGELOG 由 Changesets 负责,tag 创建由 pkg-release.ts 的
 * tag 命令负责;本模块只消费 tag 字符串与 package.json 当前版本。
 *
 * 幂等守卫:非 dry-run 时先用 `npm view <pkg>@<version> version` 探测该版本
 * 是否已存在于 registry——已存在则跳过重复发布(结果标 alreadyPublished),
 * 让同一条流水线继续走后续步骤(如 CI 里的 GitHub Release),而不是让 npm
 * 以 EPUBLISHCONFLICT 把整条流水线拖红。探测失败按 fail-open 处理(视为
 * 未发布,交由 npm 裁决);dry-run 全程不触网(版本探测一并跳过)。
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ReleaseError, isSemver, parseSemver } from './core.ts';
import type { WorkspacePackage } from './core.ts';
import {
  commitReachableFrom,
  releaseLineRef,
  tagExists,
  worktreeIsClean,
} from './git.ts';
import { listWorkspacePackages } from './workspace.ts';

/** 从发布 tag 中解析出的引用:短包名 + 精确版本。 */
export interface ReleaseTagRef {
  readonly shortName: string;
  readonly version: string;
}

/**
 * 发布 tag 形态:`{短包名}-v{semver}`。短名与版本都以贪婪切分拿最后一组
 * `-v` 之后的整段,版本合法性交由 semver 校验兜底(如 `dsh-llm-fallback-v0.3.2`
 * 的短名本身含 `-`,不能按最后一个 `-` 硬切)。
 */
const RELEASE_TAG_PATTERN = /^(.+)-v(.+)$/;

/**
 * 解析 `{短包名}-v{semver}` 发布 tag;不符合约定(缺 `-v` 分隔、版本非
 * 合法 semver)返回 null,表示该 tag 与发布流水线无关。
 */
export function parseReleaseTag(tag: string): ReleaseTagRef | null {
  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) return null;
  const shortName = match[1]!;
  const version = match[2]!;
  if (!isSemver(version)) return null;
  return { shortName, version };
}

/**
 * 版本是否为正式版:semver 无 prerelease 段(如 `0.4.0-rc.1` 为预发布)。
 * build 元数据(`+build.5`)不影响正式性。非法版本抛 INVALID_CURRENT_VERSION。
 */
export function isStableVersion(version: string): boolean {
  return (
    parseSemver(version, 'INVALID_CURRENT_VERSION', '版本').prerelease ===
    undefined
  );
}

/** 跳过 npm 发布的原因(全部为预期行为,退出码 0)。 */
export type PublishSkipReason =
  'NOT_RELEASE_TAG' | 'PRERELEASE_VERSION' | 'PRIVATE_PACKAGE';

/** 发布决策失败的原因(完整性问题,非零退出)。 */
export type PublishFailReason =
  'PKG_NOT_FOUND' | 'PKG_AMBIGUOUS' | 'TAG_VERSION_MISMATCH';

/** 三态发布决策:publish(发)/ skip(跳过)/ fail(失败)。 */
export type PublishDecision =
  | {
      readonly action: 'publish';
      readonly tag: string;
      readonly pkg: WorkspacePackage;
      readonly version: string;
    }
  | {
      readonly action: 'skip';
      readonly tag: string;
      readonly reason: PublishSkipReason;
      readonly detail: string;
    }
  | {
      readonly action: 'fail';
      readonly tag: string;
      readonly reason: PublishFailReason;
      readonly detail: string;
    };

/**
 * 按 tag 对 workspace 包清单做发布决策(纯函数,不碰文件系统与网络):
 * 非 release tag → skip;短名无命中/多命中或版本不一致 → fail;
 * prerelease 或私有包 → skip;其余 → publish。
 */
export function decidePublish(input: {
  readonly tag: string;
  readonly packages: readonly WorkspacePackage[];
}): PublishDecision {
  const { tag, packages } = input;
  const ref = parseReleaseTag(tag);
  if (!ref) {
    return {
      action: 'skip',
      tag,
      reason: 'NOT_RELEASE_TAG',
      detail: `tag "${tag}" 不符合 {短包名}-v{semver} 约定,与发布流水线无关`,
    };
  }
  const hits = packages.filter((pkg) => pkg.shortName === ref.shortName);
  if (hits.length === 0) {
    const available = packages.map((pkg) => pkg.shortName).join(', ');
    return {
      action: 'fail',
      tag,
      reason: 'PKG_NOT_FOUND',
      detail: `tag 短名 "${ref.shortName}" 在 workspace 中没有对应包(可用: ${available || '(无子包)'})`,
    };
  }
  if (hits.length > 1) {
    const names = hits.map((pkg) => pkg.name).join(', ');
    return {
      action: 'fail',
      tag,
      reason: 'PKG_AMBIGUOUS',
      detail: `tag 短名 "${ref.shortName}" 命中多个包: ${names};tag 只编码短名,请保证包目录(短名)唯一`,
    };
  }
  const pkg = hits[0]!;
  if (pkg.version !== ref.version) {
    return {
      action: 'fail',
      tag,
      reason: 'TAG_VERSION_MISMATCH',
      detail: `tag 版本 ${ref.version} 与 ${pkg.dir}/package.json 的当前版本 ${pkg.version} 不一致;请确认 tag 指向版本号已提交的那个 commit`,
    };
  }
  if (!isStableVersion(ref.version)) {
    return {
      action: 'skip',
      tag,
      reason: 'PRERELEASE_VERSION',
      detail: `${pkg.name} ${ref.version} 是 prerelease,按约定不发布 npm(仅作仓库内版本标记)`,
    };
  }
  if (pkg.isPrivate) {
    return {
      action: 'skip',
      tag,
      reason: 'PRIVATE_PACKAGE',
      detail: `${pkg.name} 是私有包(private: true),不发布 npm`,
    };
  }
  return { action: 'publish', tag, pkg, version: ref.version };
}

/**
 * 发布客户端:
 * - `pnpm`(默认):本地与常规场景,带 `--no-git-checks`;
 * - `npm`:CI 的 OIDC trusted publishing 直发(npm ≥ 11.5.1;provenance 自动
 *   生成,无需 --provenance);npm 2026 起对此标记 Not recommended;
 * - `npm-stage`(CI 现行):OIDC 暂存发布——版本进 npm 暂存队列,由维护者
 *   人工 `npm stage approve`(2FA)放行后才公开,强供应链安全;`npm stage
 *   publish` 在 trusted publishing 下始终允许,无需勾选 Allow npm publish。
 *   CI 不用 pnpm 发布的原因:pnpm 11 原生 publish 的 OIDC 在 CI 不可靠
 *   (pnpm/pnpm#11513),且 pnpm 无 stage 子命令。
 */
export type PublishClient = 'pnpm' | 'npm' | 'npm-stage';

/** 组装发布参数:scoped 包补 `--access public`;npm 系客户端无 git 检查项。 */
export function publishArgsFor(
  client: PublishClient,
  pkg: WorkspacePackage,
): string[] {
  const access = pkg.name.startsWith('@') ? ['--access', 'public'] : [];
  if (client === 'pnpm') {
    return ['publish', '--no-git-checks', ...access];
  }
  if (client === 'npm-stage') {
    return ['stage', 'publish', ...access];
  }
  return ['publish', ...access];
}

/** 注入给 publishForTag 的发布执行器(测试注入替身,默认走子进程)。 */
export type PublishRunner = (input: {
  readonly cwd: string;
  /** 发布 CLI 名:'pnpm' | 'npm'('npm-stage' 时仍为 'npm')。 */
  readonly command: string;
  readonly args: readonly string[];
}) => void;

/**
 * 默认发布执行器:在包目录下同步执行 `<command> publish ...`,stdio 直接
 * 透传(发布日志实时可见);非零退出抛 PUBLISH_FAILED。
 */
export const runPublishCommand: PublishRunner = ({ cwd, command, args }) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error !== undefined) {
    throw new ReleaseError(
      'PUBLISH_FAILED',
      `无法执行 ${command}(${result.error.message});请确认 ${command} 已安装并在 PATH 中`,
    );
  }
  if (result.status !== 0) {
    throw new ReleaseError(
      'PUBLISH_FAILED',
      `${command} ${args.join(' ')} 失败(exit ${String(result.status)}),发布中止`,
    );
  }
};

/** publishForTag 的结果:决策 + 发布处理结果(+ 预览的命令)。 */
export interface PublishOutcome {
  readonly decision: PublishDecision;
  readonly dryRun: boolean;
  /** 仅 decision 为 publish 时存在:将要执行(dry-run 为预览)的发布命令。 */
  readonly command?: string;
  /**
   * publish 决策已被处理:要么真实执行了发布命令,要么因版本已存在而
   * 幂等跳过(此时 `skipped` = 'already-published',未执行任何命令)。
   */
  readonly published: boolean;
  /**
   * 版本此前已存在于 npm registry,本次按幂等跳过重复发布(未执行发布命令)。
   * 首发场景常见:新包首发无法走 CI 的 OIDC(须先有包才能登记 trusted
   * publisher),由维护者本地发布;随后 tag 推上去再跑同一条流水线时,
   * 版本已在 registry → 跳过而不是让 npm 以 EPUBLISHCONFLICT 报错。
   */
  readonly alreadyPublished?: boolean;
  /** 本次未执行发布命令的原因;未跳过时不存在。 */
  readonly skipped?: 'already-published';
  /**
   * registry 版本探测结论(仅 publish 决策路径有值;skip/fail 路径不探测)。
   * `unknown` 表示探测失败,按 fail-open 继续发布(真实失败原因由 npm 报出)。
   */
  readonly probe?: VersionProbeResult;
}

/**
 * registry 版本探测的三态结论:
 * - `exists`:该版本已发布;
 * - `missing`:包或版本不存在(可安全发布);
 * - `unknown`:探测本身失败(网络/权限等),无法判定——按 fail-open 处理
 *   (视为未发布,交给 npm 自己裁决),不阻断发布。
 */
export type VersionProbeResult = 'exists' | 'missing' | 'unknown';

/** 版本探测函数的输入(包名 + 精确版本)。 */
export interface VersionProbeInput {
  readonly pkgName: string;
  readonly version: string;
}

/** 版本探测函数:返回该版本在 registry 的存在状态。 */
export type VersionProbe = (input: VersionProbeInput) => VersionProbeResult;

/** 子进程执行结果的最小形状(便于测试注入替身)。 */
export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 子进程执行器:返回执行结果(测试可注入替身)。 */
export type SpawnRunner = (
  command: string,
  args: readonly string[],
) => SpawnResult;

/**
 * 解析 `npm view <pkg>@<version> version --json` 的执行结果:
 * 退出码 0 且 stdout 非空 → 版本存在;退出码非 0 且 stderr 命中 E404 →
 * 包或版本不存在;其余(网络抖动、registry 报错等)→ 无法判定。
 */
export function parseVersionProbeResult(outcome: {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}): VersionProbeResult {
  if (outcome.status === 0) {
    return outcome.stdout.trim().length > 0 ? 'exists' : 'missing';
  }
  if (/E404/.test(outcome.stderr)) return 'missing';
  return 'unknown';
}

/** 默认子进程执行器:同步执行并收集输出(Windows 下 npm 为 .cmd,需 shell)。 */
const defaultSpawn: SpawnRunner = (command, args) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    timeout: 30_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/**
 * 构造基于 `npm view <pkg>@<version> version --json` 的版本探测器。
 * 只读、不发布;探测失败返回 `unknown`(调用方按 fail-open 处理)。
 * 抽出工厂是为了让默认实现也能被单测覆盖(注入 spawn 替身)。
 */
export function createNpmVersionExists(
  spawn: SpawnRunner = defaultSpawn,
): VersionProbe {
  return ({ pkgName, version }) =>
    parseVersionProbeResult(
      spawn('npm', ['view', `${pkgName}@${version}`, 'version', '--json']),
    );
}

/** 默认版本探测器(真实调 npm CLI)。 */
export const npmVersionExists: VersionProbe = createNpmVersionExists();

/**
 * 发布线守护:publish 决策落地前,tag 必须存在,且其指向的提交可从发布线
 * main 到达(相等或为其祖先均算)。语义:只有进入发布线(main)的版本才代表
 * 「已发布状态」——从 dev 等集线提交直接打的 tag 会被拒绝,防止未合入发布线
 * 的内容走 CI 发到 npm。发布线 ref 由 releaseLineRef 解析(本地 main 优先,
 * 回退 origin/main,兼容 CI 的 tag 检出);dry-run 同样校验(纯只读),
 * 让预览与真实发布看到同一结果。
 */
function assertTagOnReleaseLine(rootDir: string, tag: string): void {
  if (!tagExists(rootDir, tag)) {
    throw new ReleaseError(
      'TAG_NOT_FOUND',
      `tag ${tag} 在本仓库不存在;发布以 git tag 指向的提交为准,请先用 pnpm release tag 创建`,
    );
  }
  const line = releaseLineRef(rootDir);
  if (!commitReachableFrom(rootDir, `refs/tags/${tag}`, line)) {
    throw new ReleaseError(
      'TAG_NOT_ON_MAIN',
      `tag ${tag} 指向的提交不可从发布线 ${line} 到达;发布只接受发布线上的 tag——请先在 main 上打 tag,或把该提交合入 main 后重新发布`,
    );
  }
}

/**
 * 按发布 tag 走完整决策并在决策为 publish 时执行发布:
 * - fail 决策 → 抛 ReleaseError(码即失败原因),调用方非零退出;
 * - skip 决策 → 原样返回,不执行任何命令;
 * - publish 决策 → 先过发布线守护(tag 存在且可从 main 到达,dry-run 同样
 *   生效);非 dry-run 时再要求工作树干净(发布打包的是工作树而非 tag 指向
 *   的内容,脏树会造成 tag 与发布内容脱节),然后执行;客户端由 `client`
 *   决定(默认 pnpm,CI 暂存发布传 'npm-stage')。
 */
export function publishForTag(input: {
  readonly rootDir: string;
  readonly tag: string;
  readonly dryRun?: boolean;
  readonly allowDirty?: boolean;
  readonly client?: PublishClient;
  readonly exec?: PublishRunner;
  readonly versionExists?: VersionProbe;
}): PublishOutcome {
  const {
    rootDir,
    tag,
    dryRun = false,
    allowDirty = false,
    client = 'pnpm',
    exec = runPublishCommand,
    versionExists = npmVersionExists,
  } = input;
  const decision = decidePublish({
    tag,
    packages: listWorkspacePackages(rootDir),
  });
  if (decision.action === 'fail') {
    throw new ReleaseError(decision.reason, decision.detail);
  }
  if (decision.action === 'skip') {
    return { decision, dryRun, published: false };
  }
  const { pkg } = decision;
  assertTagOnReleaseLine(rootDir, tag);
  const args = publishArgsFor(client, pkg);
  // 可执行二进制:pnpm 客户端为 pnpm;npm / npm-stage 都由 npm CLI 执行
  const bin = client === 'pnpm' ? 'pnpm' : 'npm';
  const command = `${bin} ${args.join(' ')}(cwd: ${pkg.dir})`;
  if (dryRun) {
    // dry-run 全程不触网:版本探测也一并跳过(预览只给命令,不查 registry)
    return { decision, dryRun: true, command, published: false };
  }
  // 幂等守卫:版本此前已发布(首发本地手工发布后再推 tag 的常见路径)→ 跳过
  // 重复发布,让流水线继续走后续步骤(如 CI 里的 GitHub Release),而不是
  // 让 npm 以 EPUBLISHCONFLICT 报错把整条流水线拖红。探测放在脏树门禁
  // 之前:版本已存在时本次本就不发布,不该被脏树挡住。
  // 探测本身异常(如探测器抛错)按 fail-open 处理:视为未发布继续,真实
  // 失败原因交由 npm 报出——不让一次探测故障把发布整体卡死。
  let probe: VersionProbeResult;
  try {
    probe = versionExists({
      pkgName: pkg.name,
      version: decision.version,
    });
  } catch {
    probe = 'unknown';
  }
  if (probe === 'exists') {
    return {
      decision,
      dryRun: false,
      command,
      published: true,
      alreadyPublished: true,
      skipped: 'already-published',
      probe,
    };
  }
  if (!allowDirty && !worktreeIsClean(rootDir)) {
    throw new ReleaseError(
      'DIRTY_WORKTREE',
      `工作树存在未提交改动,发布会打包工作树而非 tag ${tag} 指向的内容;请先提交,确有必要时加 --allow-dirty`,
    );
  }
  // probe === 'unknown':探测失败按 fail-open 继续发布(真实失败原因由 npm 报出)
  exec({ cwd: join(rootDir, pkg.dir), command: bin, args });
  return { decision, dryRun: false, command, published: true, probe };
}
