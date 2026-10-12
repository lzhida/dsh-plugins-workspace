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
pnpm changeset:publish      # 发布公开包到 npm(目前仅 @zhidal/dsh-llm-fallback)

# —— tag 发布(本工具,tag 名 = {短包名}-v{X.Y.Z})——
pnpm release list                       # 子包清单:包名 / 版本 / 可见性 / tag 名预览
pnpm release tag dsh-taskboard          # 为当前已提交版本补打 annotated tag
pnpm release tag --all                  # 批量:尚无 tag 的子包全打,已有的跳过(幂等)
pnpm release tag --all --dry-run        # 预览将创建/跳过哪些 tag,零副作用
```

推荐发布流(与 `.changeset/README.md` 一致):

```sh
pnpm changeset            # 1. 声明变更
pnpm changeset:version    # 2. 版本 + CHANGELOG 落盘
git add . && git commit   # 3. 人工审阅后提交(建议: chore(release): 发布新版本)
pnpm release tag --all    # 4. 批量打 {短名}-v{X.Y.Z} annotated tag
pnpm changeset:publish    # 5. (可选)发布 npm
git push --follow-tags    # 6. push 永远由你手动执行,工具绝不自动 push
```

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
  pkg-release.ts       tag 助手 CLI 入口(list / tag <包名|--all>,参数解析、输出、退出码)
  release/
    core.ts            纯函数:semver 解析校验、tag 名生成、包名解析、ReleaseError(11 种错误码)
    workspace.ts       workspace 模式解析、子包发现(只读)
    git.ts             git 子进程薄封装(结构化错误)
    workflow.ts        tagPackage / tagAllPackages 编排(dry-run、脏树与 tag 冲突检查)
    *.test.ts          单测 + 临时 git 仓库端到端回归
```

错误以 `ReleaseError { code }` 结构化抛出:`PKG_NOT_FOUND`、`PKG_AMBIGUOUS`、
`INVALID_CURRENT_VERSION`、`TAG_EXISTS`、`DIRTY_WORKTREE`、`NOT_A_GIT_REPO`、
`GIT_FAILURE`、`WORKSPACE_CONFIG`、`PKG_VERSION_MISSING`、`PKG_MANIFEST_INVALID`、
`USAGE`;CLI 以非零码退出并打印 `[CODE] 文案`。
