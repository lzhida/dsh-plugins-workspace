# NOTICE

## @zhidal/dsh-taskboard

This product includes software developed at
[cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard).

- Upstream project: `cloader/dsh-taskboard`
- Upstream version vendored: **0.10.1**（取自本机 npm 安装包 `dsh-taskboard@0.10.1`）
- Upstream license: Apache License 2.0 — full text in [`LICENSE`](./LICENSE)
  (`Copyright 2026 cloader` — 该版权归属取自上游 `package.json` 的 `author` 字段；
  上游 LICENSE 正文与 README 均未出现该字样，此处为按作者署名推定)
- Upstream README (English, upstream docs): [`docs/upstream-readme.md`](./docs/upstream-readme.md)

### Modifications

本包是上游源码的 vendored 副本（`src/` 下 63 个文件，其中 47 个与上游逐字一致，
16 个为有意改动并逐条登记），本仓在**构建与依赖口径**上做了适配，另加少量本地扩展。
逐条改动与理由见 [`docs/local-changes.md`](./docs/local-changes.md)。

摘要：

- 包名改为 `@zhidal/dsh-taskboard`，产物入口由 `lib/` 改为 `dist/`；
- 构建工具由 `tsdown` 改为 `esbuild`（与本仓其它构建式插件一致），并固定
  `absWorkingDir` + 内联 `tsconfigRaw`，使产物字节不随构建环境漂移；
- `esbuild` 移入 `dependencies`（实体安装会触发 `prepare` → 构建，pnpm 对 git
  依赖不保证安装 devDependencies）；`@deepseek-ai/*` 依赖全部保留在
  `devDependencies` 且仅 `import type` 使用（宿主运行时提供，绝不进入
  `dependencies`）；
- `engines.node` 由 `>=24.9.0` 改为 `>=22.18`（实测源码未使用 Node 24 专属
  API；下限由构建脚本的原生 type-stripping 需求决定），`engines.dsh` 取
  `>=0.2.2-rc.3`（对齐上游 README 建议）；
- 新增 `scripts/build.ts`（esbuild 三产物构建 + 构建断言）、`src/local/`
  （本仓本地扩展与契约测试）与 `docs/upstream-sha256.txt`（上游源码哈希清单，
  用于内容级的一致性校验）；
- **本仓本地改造（看板官方集成系列 1/3）**：worktree 隔离不再自建，改用官方
  `@deepseek-ai/dsh-experimental-worktree` 的 `ctx.worktrees` 服务（软依赖，
  缺席即降级为原目录执行）；上游的多仓库整区镜像能力随之停用（官方服务为
  单仓库）。涉及的上游文件改动逐条登记在 [`docs/local-patches.json`](./docs/local-patches.json)，
  实测记录见 [`docs/official-worktree-spike.md`](./docs/official-worktree-spike.md)。
