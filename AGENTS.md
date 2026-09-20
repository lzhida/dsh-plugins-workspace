# Repository Guidelines

## Project Overview

dsh（deepseek harness）插件 monorepo：TypeScript + cordis（`@deepseek-ai/cordis`）插件集合，pnpm workspaces 单层结构。插件以 TS 源码形态被宿主 dsh loader 直接加载——**没有构建步骤，不产出 dist**。当前唯一包 `packages/hello-plugin`，同时是新插件的模板。

## Architecture & Data Flow

- **加载链**：宿主 dsh loader 按插件包 `main` 字段 import TS 源码（`packages/hello-plugin/package.json` → `main: "src/index.ts"`）→ 调用 `apply(ctx)`。
- **插件契约三符号**（见 `packages/hello-plugin/src/index.ts`）：
  - `export const name`——loader 依赖的字符串标识，必须与插件语义一致；
  - `export function apply(ctx: Context)`——cordis 安装钩子，在此注册能力/副作用；
  - 业务辅助纯函数（如 `greet`）。
- **生命周期**：副作用一律用 `ctx.effect(fn)` 注册。`fn` **立即执行**，其返回的函数在插件卸载时被 cordis 自动调用（事件监听、定时器、连接的清理都走这条路径，勿手写 removeListener/clearInterval 之外的反注册逻辑）。
- **依赖注入**：需要其他服务时 `export const inject = ['tools']`，框架保证 `ctx.tools` 就绪后才调 `apply`（hello-plugin 未用到，但属 cordis 标准模式）。
- **依赖策略**：`@deepseek-ai/cordis` 只放插件的 `devDependencies` 且仅 `import type` 引入——运行时由宿主提供，插件不打包框架。

## Key Directories

- `packages/<plugin-name>/`——一个插件一个目录（`pnpm-workspace.yaml` 收录 `packages/*`）
  - `src/index.ts` 插件入口；`src/*.test.ts` 测试与源码同目录
- 根目录——全部工具链配置集中于此；子包 tsconfig 仅 `extends` 根配置，不重复设置

## Development Commands

```sh
pnpm install        # 安装依赖并自动执行 lefthook install（prepare 脚本）
pnpm lint           # ESLint 检查（lint:fix 自动修）
pnpm format         # Prettier 写入（format:check 只校验）
pnpm typecheck      # 递归各包 tsc --noEmit
pnpm test           # vitest run（集中在根，子包无 test 脚本）
pnpm test:e2e       # e2e：真实 dsh Web UI 加载验证（默认 hello-plugin，详见 Testing & QA）
```

新增插件的最小步骤：建 `packages/my-plugin/`，仿照 `packages/hello-plugin/package.json`（`type: "module"`、`main: "src/index.ts"`、`devDependencies` 含 cordis、`scripts.typecheck`），tsconfig extends 根配置即可，无需其他注册动作。

## Code Conventions & Common Patterns

- **命名**：插件包名 `@dsh-plugins/<kebab-case>`；`export const name` 与插件 kebab 名一致。
- **ESM-only**：全仓 `type: "module"`，禁止 CJS；`verbatimModuleSyntax` 强制类型导入写 `import type`。
- **严格 TS**：`strict` + `noUnusedLocals/noUnusedParameters`；函数写显式返回类型。
- **格式**：Prettier 仅 `singleQuote: true`，其余默认；提交时 lint-staged 自动对暂存文件跑 `eslint --fix` + `prettier --write`。
- **资源清理模式**：`ctx.effect(() => { ...; return () => cleanup() })`（参考 `src/index.ts:9-16`）。
- **Git**：中文 Conventional Commits（`chore:/feat:/fix:`）；不直接提交 main，工作走 `feat/*`、`fix/*` 分支；push 由用户执行。

## Important Files

- `packages/hello-plugin/src/index.ts`——新插件的模板（最小契约 + effect 清理范例）
- `packages/hello-plugin/src/index.test.ts`——测试三件套范例（`stubCtx` + fake timers + `vi.spyOn`）
- `scripts/test-e2e.mjs`——e2e 运行器：真实 dsh Web UI 加载验证，支持任意插件路径参数
- `lefthook.yml` + 根 `package.json` 的 `lint-staged` 块——钩子与暂存区门禁行为
- `tsconfig.base.json` / `eslint.config.js` / `.prettierrc.json`——质量门禁，改动需谨慎
- `pnpm-workspace.yaml`——包收录 + `allowBuilds`；新依赖需要构建脚本时必须在此追加白名单（pnpm 11 默认拦截构建脚本）

## Runtime/Tooling Preferences

- Node ≥22（`engines`），包管理器锁定 pnpm 11（`packageManager` 字段），勿用 npm/yarn。
- **纯 TypeScript**：源码与工具链配置均为 `.ts`（`scripts/*.ts` 由 tsx 运行，`eslint.config.ts` 由 ESLint 加载）；仓库内无 `.js`/`.mjs` 源文件。
- TypeScript 锁 5.x 稳定线——typescript-eslint 8 的 peer 范围是 `<6.1.0`，勿升级 TS 7。
- 插件禁止引入构建步骤；`dist`、`coverage` 等产物目录已入 `.gitignore`。
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

### E2E（Web UI 加载级验证）

- 命令：`pnpm test:e2e`（默认验证 hello-plugin）；验证任意插件：`pnpm test:e2e -- packages/<name>/src/index.ts`（可传多个）
- 机制：运行器以仓库内隔离的 `DSH_HOME=.agents/e2e-dsh-home` + 独立 profile（默认 `e2e`，**缺失时自动从官方 web 模板引导**）启动 `pnpm dsh --profile e2e --patch <overlay> --no-open --port <port>`，patch overlay（`- insert` 列表、插件绝对路径）由运行器生成到 `.agents/tmp/e2e/`
- 三项断言：① 进程输出出现插件加载日志——**契约：插件 `apply` 时须打印 `[name] ` 前缀格式的日志行**（如 `[hello-plugin] plugin loaded`），e2e 按该结构化格式匹配，路径中出现裸包名不算 ② Web 服务端口可访问 ③ 若捕获到带 token 的 UI URL 则页面须返回 <400；结束自动 taskkill 进程树并清理 overlay
- 与本机已运行的 dsh 实例完全隔离：DSH_HOME 重定向（不触碰 `~/.dsh`），默认端口 3865——**3080 是上游默认，3865 只是本机现状产物**（本机 3080 被已运行实例占用）；新机器 3080 空闲时可回归 `E2E_PORT=3080` 或改回默认值
- 环境变量：`E2E_PORT`（3865）、`E2E_TIMEOUT_MS`（180000）、`E2E_DSH_PROFILE`（e2e）
- 前提：`@deepseek-ai/dsh` 在根 devDependencies；`pnpm-workspace.yaml` 的 `allowBuilds` 已批准其原生依赖（node-pty/koffi/protobufjs/@google/genai/dsh-subprocess-local），新增依赖需构建脚本时照此追加
