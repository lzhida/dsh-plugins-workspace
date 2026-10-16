# Repository Guidelines

## Project Overview

dsh（deepseek harness）插件 monorepo：TypeScript + cordis（`@deepseek-ai/cordis`）插件集合，pnpm workspaces 单层结构。插件默认以 TS 源码形态被宿主 dsh loader 直接加载——**没有构建步骤、不产出 dist**；需要实体安装（git/npm/tarball）的插件必须以 JS 为入口。当前仅包含 `packages/dsh-llm-fallback`（构建式发行，见下）。

## Architecture & Data Flow

- **加载链**：宿主 dsh loader 按插件包 `main` 字段 import 插件入口 → 调用 `apply(ctx)`。TS 源码入口（`main: "src/index.ts"`）依赖 Node 原生 type-stripping，**只在 `link:` 安装下可用**——实体安装（git/npm/tarball，落盘于 profile 的 node_modules）会被 Node 以 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 拒绝，宿主只报静默的 `failed to import`。需要支持实体安装的插件必须以 JS 为入口（见 `packages/dsh-llm-fallback` 的 dist 方案）。
- **插件契约三符号**（见 `packages/dsh-llm-fallback/src/index.ts`）：
  - `export const name`——loader 依赖的字符串标识，必须与插件语义一致；
  - `export function apply(ctx: Context)`——cordis 安装钩子，在此注册能力/副作用；
  - 业务辅助纯函数（如 `greet`）。
- **生命周期**：副作用一律用 `ctx.effect(fn)` 注册。`fn` **立即执行**，其返回的函数在插件卸载时被 cordis 自动调用（事件监听、定时器、连接的清理都走这条路径，勿手写 removeListener/clearInterval 之外的反注册逻辑）。
- **依赖注入**：需要其他服务时 `export const inject = ['tools']`，框架保证 `ctx.tools` 就绪后才调 `apply`（`dsh-tool-nushell` 即用此模式；该插件已在 2026-10-08 整包下线，示例仅供契约参考）。
- **依赖策略**：`@deepseek-ai/cordis` 只放插件的 `devDependencies` 且仅 `import type` 引入——运行时由宿主提供，插件不打包框架。

## Key Directories

- `packages/<plugin-name>/`——一个插件一个目录（`pnpm-workspace.yaml` 收录 `packages/*`）
  - `src/index.ts` 插件入口；`src/*.test.ts` 测试与源码同目录
- 根目录——全部工具链配置集中于此；子包 tsconfig 仅 `extends` 根配置，不重复设置

## Development Commands

```sh
pnpm install        # 安装依赖并自动执行 lefthook install（根 prepare）；
                    # 同时会执行 workspace 成员的 prepare（构建式插件自动产出 dist）
pnpm lint           # ESLint 检查（lint:fix 自动修）
pnpm format         # Prettier 写入（format:check 只校验）
pnpm typecheck      # 递归各包 tsc --noEmit
pnpm test           # vitest run（集中在根，子包无 test 脚本）
pnpm changeset       # 声明一次子包变更（选包、semver 档位、摘要 → .changeset/*.md）
pnpm changeset:version   # 消费 changeset：写回版本号 + 生成各包 CHANGELOG.md
pnpm changeset:publish   # 发布公开包到 npm（目前仅 @zhidal/dsh-llm-fallback）
pnpm release list    # 列出子包版本与 tag 预览
                     # tag <包名|--all>：为当前已提交版本补 {短名}-v{X.Y.Z} tag（--all 幂等批量）
                     # publish <tag>：按 tag 决策并发布 npm（仅公开包正式版；prerelease/私有包跳过）
                     # --dry-run 预览；永不自动 push
```

新增插件的最小步骤：建 `packages/my-plugin/`，仿照 `packages/dsh-llm-fallback/package.json`（`type: "module"`、`devDependencies` 含 cordis、`scripts.typecheck`；其 `main` 指向 esbuild 构建的 dist——若插件只走 `link:` 安装可用 TS 源码入口 `main: "src/index.ts"`），tsconfig extends 根配置即可，无需其他注册动作。

## Subpackage Versioning & Release

- 子包版本管理走 **Changesets**（`.changeset/` + `@changesets/cli`，2026-10-12 由自研 CLI 切换而来）：`pnpm changeset` 声明变更 → `pnpm changeset:version` 写回版本号并生成各包 CHANGELOG.md（提交由人执行）→ `pnpm changeset:publish` 发布公开包到 npm（目前仅 `@zhidal/dsh-llm-fallback`）。`privatePackages: { version: true, tag: false }`——私有包同样参与版本递增与 CHANGELOG。
- git tag 发布由 `scripts/pkg-release.ts`（jiti 直跑零构建）补足：tag 名固定 `{短包名}-v{X.Y.Z}`（如 `dsh-llm-fallback-v0.5.0`），与插件一一对应；`pnpm release tag --all` 幂等批量为当前版本补 tag。Changesets 原生 tag 硬编码 `pkg@version` 且格式不可配置，故全部关闭，tag 语义由本工具统一（该 `{pkg}-v{X.Y.Z}` 形态与 Tauri 官方插件 monorepo 实际 tag 约定一致）。
- npm 发布流水线由 `.github/workflows/release.yml` 承担（2026-10-12 新增，2026-10-13 迁移 OIDC 暂存发布）：推送 `*-v*` tag 自动触发，先跑与 CI 相同的门禁链，再按 `scripts/release/publish.ts` 的三态决策执行——仅「公开包 + 正式版本」真正发布：CI 走 `--client npm-stage` 的 OIDC 暂存发布（免 token，`npm stage publish` 进暂存队列，维护者在 npm 后台或 `npm stage approve` 人工放行后才公开；前置是在 npm 包后台登记 trusted publisher；本地默认 `pnpm publish`）；`dsh-llm-fallback` 经 `prepack` 自动构建 dist；prerelease（如 `-rc.1`）与 private 包明确跳过（退出 0），tag 与清单版本不一致/短名无对应包直接失败。发布线守护（2026-10-13 起）：tag 必须存在且指向的提交可从 main 到达（`TAG_NOT_ON_MAIN`），发布 tag 一律在 dev 合入 main 后于 main 上打；工作流以 `fetch-depth: 0` 拉全量历史解析发布线（本地 `main` 优先，回退 `origin/main`）。备选 token 方案的 `NPM_TOKEN` 必须是 **Granular Access Token** 且创建时勾选 **Bypass 2FA**（npm 2025-12-09 起经典 token 已全部吊销、包默认强制 2FA，未勾选则发布被 OTP 验证码拦下）。
- agent 只可跑 `--dry-run`、`list` 与 `changeset status`；实际 version 提交/tag/publish 属发布动作，须用户明确授意后由用户执行或经确认后代跑，push 一律留给用户。
- 设计决策与语义边界见 `scripts/release/README.md` 与 `.changeset/README.md`。

## Code Conventions & Common Patterns

- **命名**：插件包名 `@lzhida/<kebab-case>`（已发布 npm 的插件用 `@zhidal` scope——当前账号仅拥有该用户 scope，如 `@zhidal/dsh-llm-fallback`）；`export const name` 与插件 kebab 名一致。
- **ESM-only**：全仓 `type: "module"`，禁止 CJS；`verbatimModuleSyntax` 强制类型导入写 `import type`。
- **严格 TS**：`strict` + `noUnusedLocals/noUnusedParameters`；函数写显式返回类型。
- **格式**：Prettier 仅 `singleQuote: true`，其余默认；提交时 lint-staged 自动对暂存文件跑 `eslint --fix` + `prettier --write`。
- **资源清理模式**：`ctx.effect(() => { ...; return () => cleanup() })`（参考 `src/index.ts:9-16`）。
- **Git**：中文 Conventional Commits（`chore:/feat:/fix:`）；分支模型 `main`（发布）/ `dev`（集线）：开发走 `feat/*`、`fix/*` 分支并合入 `dev`，验证后再合入 `main`；不直接提交 main；push 由用户执行。

## Important Files

- `.agents/skills/dsh-plugin-dev/SKILL.md`——插件开发/测试唯一 skill：脚手架、cordis 契约、defineTool、e2e 手工 CLI 流程（profile 引导 → 构建 → 安装 → 三断言 → 清理）与提交门禁
- `lefthook.yml` + 根 `package.json` 的 `lint-staged` 块——钩子与暂存区门禁行为
- `tsconfig.base.json` / `eslint.config.ts` / `.prettierrc.json`——质量门禁，改动需谨慎
- `pnpm-workspace.yaml`——包收录 + `allowBuilds`；新依赖需要构建脚本时必须在此追加白名单（pnpm 11 默认拦截构建脚本）

## Runtime/Tooling Preferences

- Node ≥22（`engines`），包管理器锁定 pnpm 11（`packageManager` 字段），勿用 npm/yarn。
- **纯 TypeScript**：源码与工具链配置均为 `.ts`（`eslint.config.ts` 由 ESLint 加载）；仓库内无 `.js`/`.mjs` 源文件。
- TypeScript 锁 5.x 稳定线——typescript-eslint 8 的 peer 范围是 `<6.1.0`，勿升级 TS 7。
- 插件默认禁止引入构建步骤；`dist`、`coverage` 等产物目录已入 `.gitignore`。**例外**：`dsh-llm-fallback` 为构建式发行（esbuild 打包 `dist/index.js`，`main` 指 dist，`prepare`/`prepack` 自动构建）——因为 Node 拒绝对 realpath 位于 node_modules 之下的 `.ts` 文件做 type-stripping（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），TS 源码入口在 git/npm/tarball 实体安装下必然加载失败；其他 TS 插件如需支持实体安装，照此模式改造（构建依赖 esbuild、运行时依赖放 `dependencies`——pnpm 对 git 依赖不保证安装 devDeps；git 安装的消费方还需在 allowBuilds 放行且 pnpm 要求 sha 全形态键，详见 dsh-llm-fallback README）。
- remote origin：`github:lzhida/dsh-plugins-workspace`（push 操作留给用户）。
- 编辑器（如 Zed）的 ESLint 行内提示若不识别 `eslint.config.ts`，属编辑器集成限制；CLI 门禁 `pnpm lint` 始终权威。

## Testing & QA

- Vitest 5，**零配置**（无 `vitest.config.*`），默认发现全仓 `src/**/*.test.ts`；依赖提升自根，子包无需声明。
- 测试文件与源码同目录 `*.test.ts`；`describe` 用插件名，`it` 用中文动宾短句描述行为契约。
- 既定 mock 模式（照抄 `src/index.test.ts`）：
  - `stubCtx()` 最小模拟 cordis Context——只实现 `effect`，且回调**立即执行**、清理函数收集进数组；
  - 定时器用 `vi.useFakeTimers()` + `vi.advanceTimersByTime()`；
  - `vi.spyOn(console, 'log')` 静默计数，`afterEach` 里 `vi.useRealTimers()` + `vi.restoreAllMocks()` 还原。
- 提交前门禁链：手动跑 `pnpm lint && pnpm typecheck && pnpm test`；pre-commit 钩子自动跑 lint-staged，pre-push 跑 `pnpm test`。

### E2E（真实 dsh 实例，四步标准流程）

- **无专用脚本**：完整流程在 `.agents/skills/dsh-plugin-dev/SKILL.md` §5，按四步标准顺序执行：① profile 解析 → ② 安装被测插件 → ③ 启动 + 浏览器 MCP 预检 → ④ 加载级三断言 + 功能级逐项验证。**测试完毕的清理必须询问用户**，禁止 agent 自动执行破坏性清理动作（见 SKILL.md §5.6）。
- **profile**：统一用 `test`；复用前做残留预检（package.json dependencies、cordis.patch.yml、node_modules 孤儿）；不存在则 `pnpm dsh --profile test --from-default-profile web` 创建。`--from-default-profile` 只拷 bundle 清单，不继承 web profile 的用户补丁层。
- **安装**：默认 `pnpm dsh plugin --profile test add link:<仓库绝对路径>/packages/<name>`（**`--profile` 须置于 `plugin` 之后；`link:` 后必须是绝对路径**）；构建式插件先 `pnpm --filter <pkg> build`；其他安装方式（npm/git/tarball）仅当被测对象就是安装链路时使用，并须按 SKILL.md §5.2 表逐项注明约束。
- **MCP 能力预检**（浏览器验证前必跑）：① 本会话是否已有 `mcp__chrome__*` 工具；② `pnpm dsh --profile <p> --dump-config | grep mcp` 查 mcp-client 实例；缺失时自配置为所属 profile `cordis.patch.yml` 的 `- insert:` 块（**必须 insert，不能平级 id 覆盖**——bundle 层不存在该条目），HMR/重启生效。顺带盘点其他控制类插件/MCP（victauri 桥等），避免重复建设。
- **加载级三断言**：① 实例输出出现 `[<name>] ` 前缀格式的日志行（按结构化格式匹配，路径中裸包名不算）② 端口可达（默认 3865；3080 是上游默认，本机被占）③ tokened UI URL 状态 <400。
- **功能级逐项验证**：从 README/变更说明派生「本次更新特性清单」→ 映射到 UI 配置面 / 行为契约面 / 轨迹与日志面 → 逐项打勾。轨迹核查：`~/.dsh/sessions/--<cwd-dir>--/session-*/session.v3.jsonl.zstd` 流式解压。纯净 profile 对比法用于排除 hindsight 记忆污染。
- **测试完毕的清理**：先不清理，提交产物清单（已装插件、patch 新增/修改条目、孤儿目录、工作区改动、后台实例）由用户选择「全部清理 / 保留为 fixture / 部分清理」；破坏性动作一律先经用户确认。
- 前提：`@deepseek-ai/dsh` 在根 devDependencies；`pnpm-workspace.yaml` 的 `allowBuilds` 已批准其原生依赖（node-pty/koffi/protobufjs/@google/genai/dsh-subprocess-local），新增依赖需构建脚本时照此追加。
