# Changesets 工作流

子包版本递增与 CHANGELOG 由 [Changesets](https://github.com/changesets/changesets) 负责,
`{短包名}-v{X.Y.Z}` 形式的 git tag 发布由 `scripts/pkg-release.ts` 补足(Changesets
原生 tag 硬编码为 `pkg@version`,格式不可配置;Tauri 官方插件 monorepo 的
`{pkg}-v{X.Y.Z}` tag 约定经核实正是本仓库要求的形式)。设计决策见
`scripts/release/README.md`。

## 日常流程

```sh
pnpm changeset              # 1. 声明一次变更:选包、选 semver 档位、写摘要(生成 .changeset/*.md)
pnpm changeset:version      # 2. 消费 changeset 文件:写回版本号 + 生成各包 CHANGELOG.md
git add . && git commit     # 3. 人工审阅后提交,合入 dev(建议: chore(release): 发布新版本)
git switch main && git merge dev
                            # 4. 把集线合入发布线(main)——发布线守护要求 tag 可从 main 到达
pnpm release tag --all      # 5. 在 main 上为尚无 tag 的子包批量打 {短名}-v{X.Y.Z} annotated tag
git push --follow-tags      # 6. push 永远由你手动执行,工具绝不自动 push
                            # 7. 公开包正式版 tag 推送后,.github/workflows/release.yml
                            #    自动发布 npm(prerelease 与私有包自动跳过);
                            #    pnpm changeset:publish 保留为手动备用路径
```

## 本仓库的关键配置(`config.json`)

- `baseBranch: dev` —— 与仓库 `main`(发布线)/ `dev`(集成线)分支模型对齐;
- `privatePackages: { version: true, tag: false }` —— 私有包（当前仓库仅剩公开包
  `@zhidal/dsh-llm-fallback`，此规则面向未来新增的私有插件包）
  同样参与版本递增与 CHANGELOG,但 Changesets 不为任何人打 `name@version` tag
  (tag 语义统一交给 `pnpm release tag`,保持 `{短名}-v{X.Y.Z}` 单一形态);
- `access: public` —— `@zhidal/dsh-llm-fallback` 走 npm 公开发行所需;
- `commit: false` —— `changeset version` 的结果不自动提交,由人审阅后提交。
