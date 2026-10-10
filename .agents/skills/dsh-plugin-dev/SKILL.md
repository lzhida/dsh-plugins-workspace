---
name: dsh-plugin-dev
description: 开发 DeepSeek Harness (dsh) 插件：从零脚手架新插件包、cordis 契约与 ctx.effect 生命周期、defineTool 工具开发，到 e2e（真实 dsh 实例手工 CLI 编排）的 Web UI 级自验与提交门禁。当任务涉及创建、修改或验证 dsh 插件（packages/*/src、apply(ctx)、ctx.effect、defineTool、e2e 自验）时使用。
---

# dsh 插件开发工作流

本 skill 针对 **本 monorepo 的真实工具链**（pnpm workspaces + vitest + lefthook + dsh 原生 CLI），把「能跑」的插件开发流程压缩为可照抄的步骤。背景知识见文末延伸阅读。

## 1. 仓库速览

- 插件以 **TS 源码** 被宿主 dsh loader 直接加载——**默认无构建步骤、不产出 dist**，`package.json` 的 `main` 直指 `src/index.ts`（例外：`dsh-llm-fallback` 为构建式发行，`main` 指 esbuild 打包的 `dist/index.js`）。
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
  console.log(`[${name}] plugin loaded`)   // e2e 契约，见 §5.2
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

## 5. e2e 自验（真实 dsh 实例，手工 CLI 编排）

e2e **无专用脚本**：直接用 `pnpm dsh` 原生命令，在独立 profile 中编排一个真实 dsh Web 实例做「加载级」验证；真实效果由浏览器工具在同一实例上无缝接管（§5.3）。全程以仓库根为工作目录。

### 5.1 编排流程（照抄即可）

```sh
# 0) 预检：默认端口 3865 空闲（3080 是上游默认，本机被占）；全局 ~/.dsh 已存在
# 1) profile 引导（仅首次；约 30-60s；命令非零退出但 profile 目录已生成 = 成功）
pnpm dsh --profile e2e --from-default-profile web
# 2) 构建式插件预构建（package.json 有 scripts.build 的包，如 dsh-llm-fallback）：
#    link: 安装不触发任何生命周期脚本（pnpm 对 link: 不跑 prepare），
#    dist 缺失时宿主只报静默的 failed to import
pnpm --filter <pkg-name> build
# 3) 安装被测插件（--profile 必须置于 plugin 子命令之后，否则 too many arguments；
#    link: 后必须是绝对路径——相对路径按 pnpm 语义解析到 profile 目录而非 CWD）
pnpm dsh plugin --profile e2e add link:<仓库绝对路径>/packages/<name>
#    临时插件同理：pnpm dsh plugin --profile e2e add link:<仓库绝对路径>/.agents/tmp/<kebab>
# 4) 启动 Web UI（进程前台长跑即保活；带 token 的 UI 地址 banner 可能 40s+ 才打印）
pnpm dsh --profile e2e --no-open --port 3865
# 5) 断言通过、浏览器验证完成后，结束进程（Ctrl/C 或杀进程树）并清理
pnpm dsh plugin --profile e2e remove <pkg-name>
```

### 5.2 三项断言（加载级）

1. **加载日志契约**：实例输出出现 `[<name>] ` 前缀格式的日志行（如 `[my-plugin] plugin loaded`）——插件 `apply` 时必须打印。按该结构化格式匹配，路径/堆栈中出现裸包名**不算**加载成功。类式插件（`extends Service`，如 shell executor）为惰性实例化，装载日志须打在**模块顶层**。
2. **端口可达**：`http://127.0.0.1:3865` 有响应。
3. **UI 页面健康**：打开 banner 打印的带 token URL，页面状态 <400（auth 中间件对带 token 首访返回 303 属健康——认证决策流由后续会话续接）。

### 5.3 浏览器级验证（真实效果，chrome devtool MCP 接管）

装载级断言不发起模型调用；凭证全局共享，**真实调用验证可在同一 profile 无缝继续**。保持 §5.1 步骤 4 的实例不退出，用浏览器工具打开 tokened URL：

1. **页面健康**：标题 `DeepSeek Harness`，console 无与目标插件相关的错误（web-all/git-graph 等生态噪音可忽略）；
2. **插件面板**：设置 → 插件 →「已安装」分组中目标插件显示「已启用」；
3. **真实调用**：新会话发自然任务（需要专测某工具时在任务里点名该工具），发送后等响应，展开「N 次工具调用」核查参数；
4. **轨迹核查（比 UI 可靠）**：从 `~/.dsh/sessions/--<cwd-dir>--/session-*/session.v3.jsonl.zstd` 流式解压（Node `zstandard` 多帧流式读，`decompress()` 只出首帧），提取 `tool/call` 的 arguments 逐项核查；
5. **纯净 profile 对比法**（排除 hindsight 记忆污染）：记忆会把过往成功经验注入新会话——验证「默认行为」必须用无记忆环境。建独立 profile（`pnpm dsh --profile <name> --from-default-profile web` 引导 + add 被测包），跑零工具暗示的任务，从该 profile 轨迹核实工具选择；
6. **提示词契约**：description/section 等引导文案是行为定义，测试里加「存在性断言」（如 `toContain('Do NOT shell out')`）防回归删除。

### 5.4 注意事项

- **profile 隔离**：profile 只隔离**插件列表**，`DSH_HOME` 共享全局 `~/.dsh`（模型凭证不隔离）；不触碰默认 profile 与已运行实例。**不要在 default profile 上跑 e2e**。
- **清理义务**：profile 只隔离插件列表——测完必须 `plugin remove` 被测插件并结束实例（§5.1 步骤 5），残留会进入后续会话。
- **agent 自驱**：dsh agent 会话内可用后台 job 方式执行同一流程（步骤 4 后台长跑 + 浏览器/MCP 工具接管验证），步骤与 §5.1 完全一致；清理同样必须显式执行。
- **permission presets 互斥**（仅非禁闭执行器类插件）：被测插件独占 `ctx.shell` 且非 confining 时，permission presets 构造期检查抛错（要求禁闭执行器）——在该 profile 的 `cordis.patch.yml` 顶层追加 `- id: permission` + `  disabled: true`（附注释行说明缘由），测完剥离恢复官方 permission 栈。

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
