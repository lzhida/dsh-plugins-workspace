---
name: dsh-plugin-dev
description: 开发 DeepSeek Harness (dsh) 插件：从零脚手架新插件包、cordis 契约与 ctx.effect 生命周期、defineTool 工具开发，到 pnpm test:e2e 的 Web UI 级自验与提交门禁。当任务涉及创建、修改或验证 dsh 插件（packages/*/src、apply(ctx)、ctx.effect、defineTool、test:e2e）时使用。
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

```sh
pnpm test:e2e                                  # 默认验证 packages/hello-plugin
pnpm test:e2e -- packages/my-plugin/src/index.ts        # 任意插件（packages 内）
pnpm test:e2e -- .agents/tmp/my-plugin/src/index.ts     # 临时插件（.agents/tmp）
```

- 机制：以隔离 `DSH_HOME=.agents/e2e-dsh-home` + 独立 profile（缺失时自动从官方 web 模板引导）启动真实 dsh Web UI，断言后自动清理进程。
- **加载日志契约**：插件 `apply` 时必须打印 `[name] ` 前缀格式的日志行（如 `[my-plugin] plugin loaded`）。e2e 按 `\[name\]` 结构化正则匹配——路径/堆栈中出现裸包名**不算**加载成功。
- 首次运行会引导 profile（约 30-60s）；默认端口 3865（`E2E_PORT` 可覆盖）；与 `~/.dsh` 零接触。

### 浏览器级验证（Web 效果，可选）

```sh
E2E_KEEP_MS=180000 pnpm test:e2e -- packages/my-plugin/src/index.ts
```

断言通过后实例保持存活，运行器打印带 token 的 UI 地址（dsh 的 banner 可能耗 40s+，运行器会自动等待）。用 chrome-devtool MCP 之类的浏览器工具打开该地址：

1. 页面健康：标题 `DeepSeek Harness`，console 无错误；
2. 插件效果可见：设置 → 插件 → 插件列表 → 「全局插件」分组中目标插件显示「已启用」；
3. 工具被模型实际调用需模型凭证——纯本地验证到此为止。

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
