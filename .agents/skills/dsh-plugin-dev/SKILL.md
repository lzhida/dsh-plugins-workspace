---
name: dsh-plugin-dev
description: 开发 DeepSeek Harness (dsh) 插件：从零脚手架新插件包、cordis 契约与 ctx.effect 生命周期、defineTool 工具开发，到 e2e 实例编排脚本的 Web UI 级自验与提交门禁。当任务涉及创建、修改或验证 dsh 插件（packages/*/src、apply(ctx)、ctx.effect、defineTool、e2e 自验）时使用。
---

# dsh 插件开发工作流

本 skill 针对 **本 monorepo 的真实工具链**（pnpm workspaces + tsx + lefthook + 自研 e2e 运行器），把「能跑」的插件开发流程压缩为可照抄的步骤。背景知识见文末延伸阅读。

## 1. 仓库速览

- 插件以 **TS 源码** 被宿主 dsh loader 直接加载——**无构建步骤、不产出 dist**，`package.json` 的 `main` 直指 `src/index.ts`。
- 一个插件一个目录：`packages/<kebab-name>/`；测试与源码同目录 `src/*.test.ts`（vitest）。
- 全仓 ESM（`type: "module"`）+ `verbatimModuleSyntax`：类型导入必须写 `import type`。

## 2. 新插件脚手架（照抄即可）

```
packages/my-plugin/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts        # 插件入口
    └── index.test.ts   # vitest 行为测试
```

`package.json`（`name` 与目录 kebab 名一致；cordis 只进 devDependencies、仅 `import type` 引入——运行时由宿主提供）：

```json
{
  "name": "@dsh-plugins/my-plugin",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "typecheck": "tsc --noEmit" },
  "devDependencies": { "@deepseek-ai/cordis": "^4.0.2" }
}
```

`tsconfig.json`：

```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`src/index.ts`（契约三符号：`name` / `apply` / 业务纯函数）：

```ts
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export function apply(ctx: Context): void {
  console.log(`[${name}] plugin loaded`)   // e2e 契约，见 §5
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log(`[${name}] heartbeat`)
    }, 5000)
    return () => clearInterval(timer)      // 卸载时自动调用
  })
}
```

临时验证插件可放 `.agents/tmp/<kebab>/`（gitignored）：同样结构，**无需 pnpm install**，跳过 vitest，直接走 §5 e2e。

## 3. cordis 核心语义（写对的关键）

- `apply(ctx)` 在插件安装时被调用，用于注册能力；`export const name` 是 loader 依赖的标识。
- **`ctx.effect(fn)`：`fn` 立即执行，`fn` 返回的函数在插件卸载时被框架自动调用**。事件监听、定时器、连接的清理一律走这条路径；不要手写 removeListener/clearInterval 之外的反注册逻辑。写测试 stub 时必须模拟「立即执行」语义。
- 依赖注入：`export const inject = ['tools']`——框架保证 `ctx.tools` 就绪后才调 `apply`。依赖无人提供时插件**静默停在 PENDING**（无任何报错），排查用 `ctx.registry` 遍历 `FiberState.PENDING`。
- 插件三种形态：函数式（推荐）/ 对象式 / 类式（向其他插件提供服务时用 `extends Service`）。

## 4. 工具开发（defineTool）

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'   // 声明合并：ctx.tools / 'tools/result' 事件获得类型

export const name = 'my-tool-plugin'
export const inject = ['tools']

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'my-tool',
      description: '…',
      parameters: { input: { type: 'string', required: true, description: '…' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        return `echo: ${args.input}`
      },
    }),
  )
}
```

要点：注册 disposer 自动附着到插件（卸载即注销）；`parameters` 规约转 JSON Schema 并在 execute 前校验；组合中需有 `@deepseek-ai/dsh-system-prompt` / `@deepseek-ai/dsh-tools` 提供方，否则 PENDING。

## 5. e2e 自验（Web UI 加载级）

e2e 编排脚本随本 skill 分发：`.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts`（以仓库根为工作目录运行）：

```sh
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts                                       # 默认验证 packages/dsh-guided-goal
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- packages/my-plugin/src/index.ts     # 任意插件（可传多个）
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- .agents/tmp/my-plugin/src/index.ts  # 临时插件（.agents/tmp）
```

- 机制：走真实 dsh——全局 `~/.dsh` + 独立 profile（`~/.dsh/profiles/<name>`，缺失时自动从官方 web 模板引导）启动 Web UI：profile 隔离**插件列表**，模型凭证全局共享，不触碰默认 profile 与已运行实例。断言后自动卸载被测插件恢复 profile 干净态。脚本只做**实例编排**（启动+装插件+三断言+保活）；真实效果验证由 AI 经浏览器工具接管（见下）。
- **加载日志契约**：插件 `apply` 时必须打印 `[name] ` 前缀格式的日志行（如 `[my-plugin] plugin loaded`）。e2e 按 `\[name\]` 结构化正则匹配——路径/堆栈中出现裸包名**不算**加载成功。类式插件（`extends Service`，如 shell executor）为惰性实例化，装载日志须打在**模块顶层**。
- 首次运行会引导 profile（约 30-60s）；默认端口 3865（`E2E_PORT` 可覆盖）。

### 验证层级（同一环境）

装载级断言（本脚本）不发起模型调用；因为凭证全局共享，**真实调用验证可在同一 profile 无缝继续**（`E2E_KEEP_MS` 保活后浏览器接管，或直接在会话发任务）。

清理义务：profile 只隔离插件列表——脚本结束已自动 `plugin remove`；手动建 profile 测完同样要 `pnpm dsh plugin --profile <name> remove <包名>`，避免被测插件残留进后续会话。

### 真实测试操作（chrome devtool MCP 接管，核心方法论）

脚本断言只覆盖「装载」；「真实效果」用浏览器工具完成。`E2E_KEEP_MS=180000` 保活实例并拿 tokened URL 后：

1. **页面健康**：标题 `DeepSeek Harness`，console 无与目标插件相关的错误（web-all/git-graph 等生态噪音可忽略）；
2. **插件面板**：设置/全局面板 → 插件 →「已安装」分组中目标插件 switch 显示「已启用」；
3. **真实调用**：新会话发自然任务（如需专测语法合规则加「用 nushell 工具」前缀），发送后等响应，展开「N 次工具调用」核查 command；
4. **轨迹核查（比 UI 可靠）**：从 `~/.dsh/sessions/--<cwd-dir>--/session-*/session.v3.jsonl.zstd` 流式解压（Node `zstandard` 多帧流式读，`decompress()` 只出首帧），提取 `tool/call` 的 `arguments.command` 逐项核查；
5. **纯净 profile 对比法**（排除 hindsight 记忆污染）：记忆会把过往成功经验注入新会话——验证「默认行为」必须用无记忆环境。建独立 profile（`pnpm dsh --profile <name> --from-default-profile web` 引导 + add 被测包），跑零工具暗示的任务，从该 profile 轨迹核实工具选择；
6. **提示词契约**：description/section 等引导文案是行为定义，测试里加「存在性断言」（如 `toContain('Do NOT shell out')`）防回归删除。

## 5bis. agent 自驱测试流程（`@lzhida/dsh-test-runner`）

当 dsh agent 自己需要"测试一个插件"时（不是开发者 shell 手跑），使用 `dsh-test-runner` 宿主插件提供的 5 个分步工具。流程与上节 shell 脚本等价，但 agent 可在每步之间插入人类可读的中间报告、并发发起其它调用、或在失败时按上下文灵活重试。

**5 步法**（每个工具独立可调用，agent 决定串行或并发的节奏）：

| 步骤 | 工具 | 用途 |
| --- | --- | --- |
| 1 | `test_runner_review_profiles` | 审查 `~/.dsh/profiles/` 标记 test 用途 profile；`createIfMissing=true` 时基于官方 web 模板新建 |
| 2 | `test_runner_install` | 把被测插件装入 test profile（自动维护 cordis.patch.yml 兼容 local executor） |
| 3 | `test_runner_boot` | 后台启动 `dsh web`，返回 `sessionId` + tokened URL；cordis effect 卸载时强 kill |
| 4 | `test_runner_run_assertions` | 轮询收集三项断言（`[<name>]` 加载日志 / 端口可达 / tokened URL 页面 < 400），**可重复调用直到就绪** |
| 5 | `test_runner_cleanup` | 显式 kill 进程 + 卸载被测插件，恢复 profile 干净态 |

**三种调用路径**（按 agent 上下文选最合适的一种）：

1. **直接 CLI（开发者自跑）**：走 `npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts` —— 与上节脚本相同。
2. **后台 job + 浏览器接管**：用 `test_runner_boot` + `E2E_KEEP_MS` 等价的 `timeoutMs` 让进程长跑；用浏览器/MCP 工具打开返回的 tokened URL 做真实验证。
3. **dsh agent 会话内调用**：在任意 dsh 会话中加载 `dsh-test-runner`（已 `dsh plugin add link:packages/dsh-test-runner`），模型按 5 步法串行/并发调用工具，由 system-prompt section 引导协议。**清理必须显式**——后台 web 与被测插件会残留进后续会话。

**审计清单（DoD 风格）**：
- ✅ 加载日志契约：`apply` 必打印 `[<name>]` 前缀（避免路径/堆栈中裸包名假阳性）。
- ✅ 默认 port=3865（3080 是上游默认；本机 3080 被占）；`TEST_RUNNER_PORT` 可覆盖。
- ✅ profile 隔离插件列表，模型凭证全局共享；`test_runner_cleanup` 显式卸载恢复干净态。
- ✅ local executor 自动禁 permission presets（与 test-e2e.ts 行为一致）。
- ✅ 不要在 default profile 上跑 e2e —— 工具描述里硬编码了警告。

**实现边界**：
- 纯逻辑（端口检测 / 补丁层剥离 / token 解析 / 超时预算）下沉到 `packages/dsh-test-runner/src/lib.ts`，27 个 vitest 覆盖。
- 副作用（spawn dsh / 读 `~/.dsh` / 写 cordis.patch.yml）封装在 `src/runner.ts`，经 `defineTool` 暴露给 dsh agent。
- 命名 `tool:test-runner`，`order: 2850`（TOOL_REPORT 2900 与 TOOL_SUBAGENT 2800 之间的空档）。

## 6. 门禁链（提交前必过）

```sh
pnpm format && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
```

- 分支模型：开发走 `feat/*`、`fix/*` → 合入 `dev` → 验证后合入 `main`；提交信息中文 Conventional Commits；pre-commit 自动 lint-staged，pre-push 跑 `pnpm test`。
- 已知坑位（勿重踩）：TS 锁 5.x（typescript-eslint 8 peer `<6.1.0`）；pnpm 11 默认拦截依赖构建脚本，新依赖需在 `pnpm-workspace.yaml` 的 `allowBuilds` 追加 `true`；cordis `ctx.effect` stub 必须立即执行回调。

## 延伸阅读

- 官方教程：第一个插件 <https://deepseek-harness.github.io/deepseek-harness/develop/basic/> · 工具开发 <https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool.md> · Cordis HMR <https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr.md>
- 社区 skill（通用向，可对照）：green-dalii/dsh-plugin-dev-skill（SKILL.md + References/，含 LLM 适配器/发布/能力分层）· dsh-io/dsh-plugin-skill
- dsh 原生 skill 发现：`<projectRoot>/.agents/skills`（rank 200）、`.dsh/skills`（rank 100）、`$DSH_HOME/skills`（rank 400）；目录名须与 frontmatter `name` 一致
