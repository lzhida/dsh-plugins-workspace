# @zhidal/dsh-taskboard

vendored 版 **dsh-taskboard**（上游 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard) v0.10.1，Apache-2.0）——把第三方任务看板插件收进本 monorepo，与「看板模式」插件（`@zhidal/dsh-kanban-mode`）用 bundle 组合发布。

## 它是什么

宿主权威的任务台账 + 十个 `taskboard_*` agent 工具：

- **台账**：任务、评论、验收清单、执行记录全部落宿主本地账本（`dsh-taskboard.json`），Web GUI 侧栏实时看板（SSE）。
- **十个工具**：`taskboard_list` / `taskboard_get` / `taskboard_create` / `taskboard_update` / `taskboard_move` / `taskboard_comment_add` / `taskboard_comments` / `taskboard_delete` / `taskboard_checklist` / `taskboard_execution_report`。
- **项目边界**：认领与写入按 workspace（项目）划界，跨项目前置引用会被拒绝（`dependency must belong to the same project: <id>`）。
- **依赖门禁**（上游 0.10.0 新增）：卡可声明 `blockedBy` 前置；前置满足口径 = 同项目 ∧ 未删 ∧ 状态 ∈ {`in_review`, `done`}`；四类门禁（agent / manual / scheduled / review）可在看板设置里逐项关闭。
- **依赖总开关**（上游 0.10.1 新增「启用任务依赖」）：**上游缺省关闭，本仓把缺省钉为开启**（`docs/local-patches.json` 第 16 条登记偏离，见 [`docs/local-changes.md`](./docs/local-changes.md)）——依赖门禁在本仓默认生效；在看板设置里显式关闭后行为与上游一致。
- **执行面**：任务级模型、任务级 agent 预设（`presetId`）、任务级权限、**官方 worktree 隔离**（软依赖 `@deepseek-ai/dsh-experimental-worktree` 的 `ctx.worktrees` 服务；默认分支 `task/<标题>+<任务ID>`）。
- **定时调度**：宿主侧 cron；错过窗口不补跑（一次性卡回退为认领模式，周期卡保留后续窗口）；并发上限默认 3。

## 与上游的差异

上游 `src/` 下共 63 个文件，**47 个逐字一致**（`docs/upstream-sha256.txt` 存有逐文件 SHA256 清单，契约测试逐项核对），本地扩展集中在 `src/local/`。**本包有意改动了 16 个上游文件**——worktree 隔离改用官方服务（见下节）、依赖总开关缺省开启（见「依赖总开关」条），所有改动逐条登记在 [`docs/local-patches.json`](./docs/local-patches.json)（文件 + 上游原始 sha256 + 理由），当前本地哈希见 [`docs/local-sha256.txt`](./docs/local-sha256.txt)，逐条说明见 [`docs/local-changes.md`](./docs/local-changes.md)；许可与署名见 [`NOTICE.md`](./NOTICE.md) 与 [`LICENSE`](./LICENSE)。

## Worktree 隔离：改用官方服务（本仓本地改造）

本包**不再自建 worktree 能力**（上游的 `prepareWorktree` / `removeWorktree` / 多仓镜像 `prepareMirror` 已全部移除），隔离层改为**软依赖**官方插件 `@deepseek-ai/dsh-experimental-worktree`（由官方 bundle `@deepseek-ai/dsh-experimental-forge-bundle` 提供，服务名 `ctx.worktrees`）：

- **创建**：`ctx.worktrees.create(agent, { name: 分支名, from: 基线提交 })` → 返回 `{ path, branch, baseCommit, repositoryRoot }`；宿主会把该执行会话的有效工作目录切到该检出（会话头 `cwd` 不变，故工作区归属、侧栏分组、文件沙箱边界均不受影响）。
- **缺席即降级**：宿主未启用官方服务时，任务**不报错阻塞**，而是降级为 `isolation:none` 并在执行记录与任务详情页注明「请启用官方 @deepseek-ai/dsh-experimental-forge-bundle 以使用 worktree 隔离」。
- **单仓库**：官方服务只服务一个仓库（池为 `<repo>/.agents/worktrees/<branch>`），上游的**多仓库整区镜像已禁用**；历史遗留的多仓 `branches` 记录仍按仓库合并。
- **续跑语义变化**：官方服务拒绝覆盖既有分支，故同一任务重跑时**优先续用仍存活的检出**（`workingDirectory.set` 指回原检出）；检出已丢失时才会新建，旧版「每次执行重置为全新基线」的行为不再存在。
- **回收**：官方服务把回收挂在**会话归档**事件上（默认 `retainOnArchive=false` 时回收干净且未被引用的检出，**分支保留**）；任务结算不触发回收。检出有未提交修改（含未跟踪文件）时官方拒绝删除，本包的删除入口（任务详情页「🗑 删除 worktree」、⚙ 诊断「遗留 worktree 清理」）同样拒绝并给出提示。
- 决策过程、实测命令与输出见 [`docs/official-worktree-spike.md`](./docs/official-worktree-spike.md)。

## 安装

本包是 **构建式发行**（`main` → `dist/index.js`）：实体安装（npm / git / tarball）可用，TS 源码入口只支持 `link:`。

```sh
# 开发：先构建产物，再装进 profile
pnpm --filter @zhidal/dsh-taskboard build
pnpm dsh --profile <profile> plugin add link:<仓库绝对路径>/plugins/dsh-taskboard
```

插件行由本包的 `cordis.patch.yml` 提供（行 id `dsh-taskboard`，与上游一致 → loader 按 id 去重，**不会出现两套调度器**）。浏览器半区由 `package.json` 的 `dsh.client` 声明加载。

## 已知限制

- **worktree 隔离依赖官方插件**：需宿主启用 `@deepseek-ai/dsh-experimental-forge-bundle`（内含 worktree / tool-worktree 等插件行）。缺席时任务自动降级为原目录执行（不报错），但**不会**再自建 worktree。
- **官方服务为单仓库**：工作区含多个 git 仓库时，只有根仓库获得隔离检出；上游的多仓整区镜像已禁用（历史多仓分支记录仍可按仓合并）。
- **官方回收挂在会话归档**：任务完成/取消本身不回收检出；检出与分支需在任务详情页手动删除，或在会话归档后由官方服务回收（检出有未提交修改时官方保留并仅告警）。
- **重跑不再重置基线**：官方服务拒绝覆盖既有分支，同一任务重跑优先续用存活检出（见上节）。
- 上游测试未随 npm 包发布，本仓 vendored 副本零上游测试；行为回归由本仓契约测试与实机 e2e 覆盖。
- `engines.node` 取 `>=22.18`：源码实测未用 Node 24 专属 API，但构建脚本 `node scripts/build.ts` 依赖 Node 原生 type-stripping（22.18 起默认开启），而 `prepare`/`prepack` 会触发构建——**构建下限即安装下限**。
- `engines.dsh` 取 `>=0.2.2-rc.3`（对齐上游 README 建议）；宿主桌面运行时 0.2.2-rc.5 满足。**宿主低于该版本时安装会被 dsh 兼容性守卫直接拒绝并自动回滚**（实测：dsh 0.2.1-rc.2 上 `plugin add` 报 `installation rejected: Plugin @zhidal/dsh-taskboard@0.1.0 is incompatible with dsh 0.2.1-rc.2: requirements {"engines.dsh":">=0.2.2-rc.3"}`）；降级运行需走 `dsh plugin allow-version` 显式豁免，不建议。
- 发布 tarball 不含 `tsconfig.json`（其 `extends` 指向仓库根配置，tarball 内不存在），tarball 内跑不了 `npm run typecheck`；**构建不受影响**——构建脚本已固定 `absWorkingDir` 并内联 `tsconfigRaw`，实测在无 tsconfig 环境下重建可得到与工作区字节一致的产物。
- `esbuild` 放在 `dependencies`（而非 devDependencies）：实体安装会触发 `prepare` → 构建，而 pnpm 对 git 依赖不保证安装 devDependencies。`@deepseek-ai/*` 则**只作 devDependency 且只 `import type`**，绝不进入运行时依赖。
