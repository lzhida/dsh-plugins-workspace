# 子包版本管理与发布(Changesets + tag 助手)

子包版本管理采用 **[Changesets](https://github.com/changesets/changesets)**
作为版本递增与 CHANGELOG 引擎(`.changeset/` 目录,`@changesets/cli` devDependency);
`scripts/` 下只保留一个轻量 **tag 助手**,补足 Changesets 不支持的
`{短包名}-v{X.Y.Z}` git tag 语义。纯 TypeScript,由 `jiti` 直跑,无构建步骤。

## 选型结论(2026-10-12,按用户要求切换)

| 候选方案                                                   | 结论 | 原因                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Changesets(现行)**                                       | ✅   | JS monorepo 事实标准:changeset 文件声明变更 → `version` 统一写回版本与 CHANGELOG → `publish` 发布 npm;私有包可配 `privatePackages.version: true` 一并参与版本管理;对之前不满足的 tag 格式缺口,以薄 tag 助手补足                                                                              |
| 自研 release CLI(上一版)                                   | ❌   | 已按用户要求废弃:bump/提交/CHANGELOG 均为重复造轮子,缺少变更声明工作流与变更日志产出;仅 tag 助手部分保留沿用                                                                                                                                                                                 |
| Tauri 官方插件 monorepo 同款(`.changes/` + `changes` 工具) | 借鉴 | [plugins-workspace v2](https://github.com/tauri-apps/plugins-workspace) 的 git tag 实际形态为 `updater-v2.13.3`、`shell-js-v2.5.0`,即 `{pkg}-v{X.Y.Z}`——与本仓库 tag 约定完全一致,本仓库沿用该 tag 约定;但其 `changes` 工具面向 Rust+JS 混合仓库、生态较小,JS 仓库仍以 Changesets 为标准选择 |
| pnpm 原生(`pnpm -r exec npm version` 等)                   | ❌   | 无集中版本/CHANGELOG/tag 语义,多包联动易错                                                                                                                                                                                                                                                   |

## 用法

```sh
# —— 版本管理(Changesets)——
pnpm changeset              # 声明一次变更:选包、选 semver 档位、写摘要
pnpm changeset:version      # 消费 changeset 文件:写回版本号 + 生成各包 CHANGELOG.md
pnpm changeset:publish      # 手动发布公开包到 npm(自动流水线的备用路径)

# —— tag 发布(本工具,tag 名 = {短包名}-v{X.Y.Z})——
pnpm release list                       # 子包清单:包名 / 版本 / 可见性 / tag 名预览
pnpm release tag dsh-taskboard          # 为当前已提交版本补打 annotated tag
pnpm release tag --all                  # 批量:尚无 tag 的子包全打,已有的跳过(幂等)
pnpm release tag --all --dry-run        # 预览将创建/跳过哪些 tag,零副作用

# —— npm 发布流水线(tag 推送触发,CI 自动;本地可 dry-run)——
pnpm release publish dsh-llm-fallback-v0.3.2           # 按tag决策并发布(公开包正式版)
pnpm release publish dsh-llm-fallback-v0.3.2 --dry-run # 只预览三态决策,不发npm
```

推荐发布流(与 `.changeset/README.md` 一致;发布线守护要求 tag 可从 main 到达):

```sh
pnpm changeset            # 1. 声明变更
pnpm changeset:version    # 2. 版本 + CHANGELOG 落盘
git add . && git commit   # 3. 人工审阅后提交,合入 dev(建议: chore(release): 发布新版本)
git switch main && git merge dev
                          # 4. 把集线合入发布线(main)——发布线守护的前提
pnpm release tag --all    # 5. 在 main 上批量打 {短名}-v{X.Y.Z} annotated tag
git push --follow-tags    # 6. push 永远由你手动执行,工具绝不自动 push
                          # 7. 公开包正式版 tag 推送后,Release 流水线自动发到
                          #    npm 暂存队列;去 npmjs.com 包页(或 `npm stage
                          #    approve`,2FA)人工放行,版本才公开可安装
```

## 发布流水线(tag 推送 → npm 暂存 → 人工放行)

`.github/workflows/release.yml` 监听 `push: tags: ['*-v*']`,检出 tag 指向的
commit,先跑与 CI 完全相同的门禁链(format:check → lint → typecheck → test),
再执行 `pnpm release publish "${{ github.ref_name }}" --client npm-stage`,
与本地 CLI 共用 `scripts/release/publish.ts` 的同一套决策逻辑:

| tag 形态                                        | 决策      | 行为                                                                                                           |
| ----------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `{短名}-v{正式版}`,短名命中唯一**公开**包       | `publish` | CI 执行 `npm stage publish --access public`(OIDC 暂存);本地默认 `pnpm publish --no-git-checks --access public` |
| `{短名}-v{预发布版}`(如 `-rc.1`)                | `skip`    | 按约定不发 npm,退出 0 并留日志                                                                                 |
| `{短名}-v{正式版}` 但包为 `private: true`       | `skip`    | 私有包不发 npm,退出 0 并留日志                                                                                 |
| 不符合 `{短名}-v{semver}` 约定的 tag            | `skip`    | 与流水线无关,退出 0                                                                                            |
| 短名无对应包 / 短名命中多个 scope 包            | `fail`    | `PKG_NOT_FOUND` / `PKG_AMBIGUOUS`,非零退出                                                                     |
| tag 版本 ≠ tag 指向 commit 上 package.json 版本 | `fail`    | `TAG_VERSION_MISMATCH`,非零退出                                                                                |
| tag 指向的提交不可从发布线 main 到达            | `fail`    | `TAG_NOT_ON_MAIN`,非零退出(发布线守护,见下)                                                                    |
| tag 在仓库中不存在(版本恰好与清单一致)          | `fail`    | `TAG_NOT_FOUND`,非零退出                                                                                       |

前置与边界:

- **凭证(现行:npm OIDC trusted publishing + 暂存发布,免 token)**:CI 用
  GitHub 的短时 OIDC id-token 向 npm 换取一次性凭证,仓库无需任何 npm secret。
  发布模式为 npm 推荐的**暂存发布**:工作流执行 `npm stage publish` 把版本送进
  暂存队列(后台可见、不可安装),维护者去 npmjs.com 包页 Staged versions 审阅
  放行,或本地 `npm stage approve <stage-id>`(2FA)后才公开。暂存命令在
  trusted publishing 下始终允许,**无需勾选 Allow npm publish**(即 npm 提示
  "Not recommended" 的那个直发勾选,保持不勾即可)。前置是一次性人工登记
  (2026-10-13 起):npmjs.com → `@zhidal/dsh-llm-fallback` 包页 → Settings →
  Trusted Publisher,登记 `lzhida/dsh-plugins-workspace` + workflow
  `release.yml`。npm 自动生成 provenance attestation,无需 `--provenance`。
  CI 固定 `--client npm-stage`(npm ≥ 11.5.1,Node 24 内置版满足),因 pnpm 11
  原生 publish 的 OIDC 在 CI 尚不可靠(见 pnpm/pnpm#11513)且 pnpm 无 stage
  子命令。
- **凭证(备选:granular token)**:若临时退回 token 方案,`NPM_TOKEN` 必须是
  **Granular Access Token** 且创建时勾选 **Bypass 2FA**(npm 自 2025-12-09 起
  永久吊销经典 token;所有包默认强制 2FA,未勾 Bypass 2FA 的 token 发布时会被
  要求 OTP,CI 中直接失败),并把 workflow 发布步骤改回 `pnpm publish` 路径。
- **本地发布**:本地手动 `pnpm publish` 被 2FA 拦下属预期安全行为——按提示输
  OTP,或 `PNPM_CONFIG_OTP=<码>` 免交互;本地 `--client npm-stage` 同样只进
  暂存队列,放行动作永远在人工手里。
- **发布线守护(main 可达性,2026-10-13 起)**:publish 决策要求 tag 存在且其
  指向的提交可从发布线 main 到达(相等或为其祖先;发布线 ref 本地 `main`
  优先,回退 `origin/main`——CI 按 tag 检出是 detached HEAD,`release.yml`
  以 `fetch-depth: 0` 拉全量历史保证 ref 齐全)。从 dev 等集线提交直接打的
  tag 推送后 CI 以 `TAG_NOT_ON_MAIN` 失败,发布一律走「dev 合入 main →
  在 main 上打 tag」;dry-run 同样校验,预览与真实发布结果一致。
- **发布内容即 tag 内容**:非 dry-run 的 publish 前强制工作树干净
  (`pnpm publish` 打包的是工作树而非 tag 指向的提交,脏树会造成脱节);
  CI 全新检出天然干净,本地执行加 `--allow-dirty` 可显式越过。
- **构建**:发布触发各包自带 `prepack`(如 dsh-llm-fallback 自动 esbuild 出
  dist),流水线无需额外构建步骤。
- **不变式**:工具与流水线都不 push、不创建 GitHub Release、不做 dist-tag
  管理(Trusted Publisher 的 Allow npm dist-tag 保持关闭);prerelease 想发
  npm 时仍走手动 `pnpm changeset:publish` / `pnpm publish`(带 dist-tag 自理)。

## 语义与边界

- **tag 命名**:短包名(不含 npm scope,与包目录同名)+ `-v` + 精确版本
  (如 `dsh-taskboard-v0.2.0`),与 Tauri 官方插件 monorepo 的 tag 形态一致,
  同仓库多插件的发布标记互不干扰。Changesets 原生 tag 硬编码为
  `pkg@version`(`changeset publish` / `changeset git-tag` 均不可配置格式),
  故配置 `privatePackages.tag: false` 全部关掉,tag 语义由本工具统一。
- **tag 前提**:tag 指向 HEAD,因此当前版本号必须已提交;脏工作树默认拒绝
  (避免 tag 名与提交内容脱节),`--allow-dirty` 是显式逃生门。
- **幂等批量**:`tag --all` 对已有同名 tag 的包跳过而非报错,可安全重复执行;
  单包 `tag <包名>` 遇已存在 tag 则显式 `TAG_EXISTS` 报错。
- **版本合法性**:打 tag 前校验清单版本为合法 semver(`INVALID_CURRENT_VERSION`),
  防止把垃圾版本打进 tag;版本递增/降级防护由 Changesets 负责。
- **workspace 模式**:只支持 `pnpm-workspace.yaml` 中字面目录与单层通配
  (`packages/*`);复杂 glob 显式报错,不静默漏包。
- **私有包**:`private: true` 的包经 `privatePackages.version: true` 同样参与
  版本递增与 CHANGELOG;tag 是仓库内的发布标记,与 npm publish 解耦,
  仅 `@zhidal/dsh-llm-fallback` 走 npm 公开发行。
- **永不自动 push**:`git push --follow-tags` 由人执行。

## 结构

```
.changeset/
  config.json          Changesets 配置(baseBranch=dev、privatePackages.version=true/tag=false)
  README.md            Changesets 工作流说明
scripts/
  pkg-release.ts       CLI 入口(list / tag <包名|--all> / publish <tag>,参数解析、输出、退出码)
  release/
    core.ts            纯函数:semver 解析校验、tag 名生成、包名解析、ReleaseError(16 种错误码)
    workspace.ts       workspace 模式解析、子包发现(只读)
    git.ts             git 子进程薄封装(结构化错误)+ 发布线解析与可达性判定
    workflow.ts        tagPackage / tagAllPackages 编排(dry-run、脏树与 tag 冲突检查)
    publish.ts         发布流水线:parseReleaseTag / isStableVersion / decidePublish 纯函数 + 发布编排(pnpm/npm 双客户端,发布线 main 可达性守护)
    *.test.ts          单测 + 临时 git 仓库端到端回归
.github/workflows/
  ci.yml               push/PR 门禁(镜像本地提交前检查链)
  release.yml          tag 推送 → npm 发布流水线(门禁 + release publish 决策,OIDC 免 token)
```

错误以 `ReleaseError { code }` 结构化抛出:`PKG_NOT_FOUND`、`PKG_AMBIGUOUS`、
`INVALID_CURRENT_VERSION`、`TAG_EXISTS`、`TAG_NOT_FOUND`、`TAG_NOT_ON_MAIN`、
`RELEASE_LINE_NOT_FOUND`、`TAG_VERSION_MISMATCH`、
`DIRTY_WORKTREE`、`NOT_A_GIT_REPO`、`GIT_FAILURE`、`WORKSPACE_CONFIG`、
`PKG_VERSION_MISSING`、`PKG_MANIFEST_INVALID`、`PUBLISH_FAILED`、
`USAGE`;CLI 以非零码退出并打印 `[CODE] 文案`。
