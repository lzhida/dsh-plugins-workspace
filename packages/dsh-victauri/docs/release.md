# 发布说明（dsh-victauri · workspace 统一发布体系）

> 本包收录在 [dsh-plugins-workspace](https://github.com/lzhida/dsh-plugins-workspace) monorepo，
> **版本管理、CHANGELOG、git tag 与 npm 发布全部沿用仓库根统一体系**（见根 `AGENTS.md` 与
> `scripts/release/README.md`），本文件只记录包级差异与刻意依赖设计。

## 一、发布流程（workspace 口径速览）

1. **声明变更**：`pnpm changeset` 选 `@zhidal/dsh-victauri` + semver 档位 + 摘要 → `.changeset/*.md`。
2. **消费变更**：`pnpm changeset:version` 写回版本号并生成 `packages/dsh-victauri/CHANGELOG.md`（提交由人执行）。
3. **合发布线**：`dev` 验证后合入 `main`（分支模型：`main` 发布 / `dev` 集线；tag 只从 `main` 打）。
4. **打 tag**：`pnpm release tag dsh-victauri` → `dsh-victauri-vX.Y.Z`（annotated，`{短包名}-v{版本}`）。
5. **推送**（永远由人执行）：`git push --follow-tags` → 仓库根 `.github/workflows/release.yml`
   由 `*-v*` tag 触发，跑门禁链后按 tag 三态决策发布——仅「公开包 + 正式版本」真正发布（OIDC 暂存发布）。
6. **发布线守护**：tag 必须存在且指向 main 可达的提交（`TAG_NOT_ON_MAIN` 拒绝集线提交上的 tag）；
   tag 版本与 `package.json` 不一致以 `TAG_VERSION_MISMATCH` 失败。

### 首版 0.1.0 的例外

首发即 `0.1.0`（`npm view @zhidal/dsh-victauri` 为 E404，包名未被占用），**不经 changeset**：
版本号已在 `package.json` 落定，合 main 后直接 `pnpm release tag dsh-victauri` → 推送 → 发布。
这与 `@zhidal/dsh-patent@0.1.0` 的首发口径一致；changesets 从后续版本开始使用。

## 二、包级刻意依赖设计（保留自原仓库实测结论）

以下边界经原仓库实测论证（2026-11-09），**改动前必须重新核对**：

| 设计点                                               | 现状                                                                                                     | 原因（实测）                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `esbuild` / `typescript` 在 `devDependencies`        | 产物预构建随包分发（`dist/`），消费端不需要构建工具                                                      | 留在 `dependencies` 会让 **pnpm 11 消费者安装直接 exit 1**（`ERR_PNPM_IGNORED_BUILDS`：pnpm 11 默认拦截依赖构建脚本；依赖包自身声明 `pnpm.onlyBuiltDependencies` 无效，只有消费侧 `allowBuilds` 能放行）。代价：pnpm 11 装 git 依赖默认拦 `prepare`（需消费侧 `allowBuilds` 写含 commit sha 的完整 spec）；npm 消费者不受影响           |
| `@deepseek-ai/cordis` 在 `dependencies`，钉 `~4.0.5` | `dist/index.d.ts` 引用其 `Context` 类型（仅类型级，运行时已被 esbuild 内联），须在消费者安装树中必然可得 | `~4.0.5` 对齐 `@deepseek-ai/dsh-tools` 的 peer 范围：消费方自带 cordis 4.1.0 会装出两份，跨副本 `Context` 带 unique-symbol 品牌键不兼容，报 `TS2345`（运行时不受影响，cordis 品牌符号走 `Symbol.for`）。变体「移入 `peerDependencies`」可消除 TS2345 但会让不装 cordis 的消费者缺类型——当前按 dependencies 口径（声明面必然可解析优先） |
| `@deepseek-ai/schemastery` 钉 `~3.18.5`              | 与 `dsh-tools@0.2.1-rc.2` 的依赖同源                                                                     | `^3.18.4` 在 npm 无 lockfile 安装时解析到 3.19.0 → 树内两份 schemastery → 声明 emit 不可移植（`TS2742`），npm 装 git 依赖时 prepare 构建失败。实测 3.18.5 与 3.19.0 三份产物 SHA256 相同、运行时行为一致。**联动风险**：`dsh-tools` 升到依赖 `~3.19.x` 时本包必须同步核对 schemastery 范围，否则双副本复发                              |
| `engines.node: ">=22.12"`                            | 产物是纯 ESM（只有 `dist/index.js`，无 CJS 产物）                                                        | CJS 消费方 `require()` 需 Node ≥ 22.12（更早报 `ERR_REQUIRE_ESM`）；收窄让不兼容 Node 在安装期收到 `EBADENGINE` 提示                                                                                                                                                                                                                    |
| 声明剪枝 `scripts/prune-dist-declarations.mjs`       | build 第三段：可达性闭包剪掉内部 `.d.ts`，只留 index/client/config/discovery/json 5 个公开声明           | 发布声明不再引用 `@deepseek-ai/dsh-llm/types`——类型面不依赖 dsh-llm（npm 默认 `auto-install-peers` 仍会因 dsh-tools 的 peer 顺带装上它）。构建前自检禁行首 `/// <reference path>`：tsc 声明 emit 会丢弃该指令，留下消费者解析不到的悬空类型名（须改用显式 `import type`）；`path=` 阻断、`types=` 只告警                                |
| `files: ["dist", "cordis.patch.yml"]`                | `README.md`/`LICENSE` 由 npm 强制包含；`src/` 不入包                                                     | 包内零源码；sourcemap 保留映射但 `--sources-content=false` 不外泄源码正文                                                                                                                                                                                                                                                               |

## 三、发布后验证

| #   | 验证项            | 做法                                                                                           | 期望                                                                                               |
| --- | ----------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | npm 版本列表      | `npm view @zhidal/dsh-victauri versions`                                                       | 含新版本号                                                                                         |
| 2   | tarball 可取      | `npm view @zhidal/dsh-victauri@<ver> dist.tarball`                                             | 返回 tarball URL                                                                                   |
| 3   | 隔离 profile 装包 | 独立测试 profile 执行 `pnpm dsh plugin --profile <隔离profile> add @zhidal/dsh-victauri@<ver>` | 插件装上且自动激活（`cordis.patch.yml` 生效，插件行出现在插件列表）                                |
| 4   | 工具面口径        | 安装后调 `victauri_tools_list`                                                                 | 39 个工具（35 Victauri + CLI 桥 + CLI 探测 + 工具发现 + 桥接体检），与 README / docs/TOOLS.md 同源 |

**硬约束**：端到端验证一律在隔离测试 profile 内做；严禁在宿主 profile 安装开发版插件；严禁强杀宿主 DSH 进程。

## 四、命令速查（包级）

```bash
pnpm --filter @zhidal/dsh-victauri build       # esbuild → tsc 声明 → 剪枝（三段）
pnpm release list                              # 包名 / 版本 / tag 名预览
pnpm release tag dsh-victauri --dry-run        # 预览
pnpm release tag dsh-victauri                  # 实打 annotated tag（main 上）
pnpm release publish dsh-victauri-vX.Y.Z --dry-run   # 预览发布决策
```

推送、npm 放行等动作的完整口径见仓库根 `AGENTS.md` 与 `scripts/release/README.md`。
