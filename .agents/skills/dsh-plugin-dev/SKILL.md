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
  console.log(`[${name}] plugin loaded`)   // e2e 契约，见 §5.4
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

## 5. e2e 自验（真实 dsh 实例，四步标准流程，统一 `test` profile）

e2e **无专用脚本**：直接用 `pnpm dsh` 原生命令，在独立的 **`test` profile** 中编排一个真实 dsh Web 实例做「加载级」+「功能级」验证；真实效果由浏览器工具在同一实例上无缝接管。全程以仓库根为工作目录，**所有涉及测试执行的地方一律使用 `test` profile**。

**四步固定顺序**：

1. **Step 1** —— profile 解析（找到或创建，含残留预检）
2. **Step 2** —— 安装被测插件（默认 `link:`，其他方式须说明）
3. **Step 3** —— 启动服务 + 浏览器 MCP 能力预检（必要时自配置）+ 顺带盘点其他控制类插件/MCP
4. **Step 4** —— 加载级三断言 + 功能级逐项验证

**测试完毕的清理必须询问用户，禁止 agent 自动执行破坏性清理动作**（见 §5.6）。

### 5.1 Step 1 — profile 解析（找到或创建）

- 优先复用既有 profile：先查 `~/.dsh/profiles/` 是否已有 `test`；已有则做**残留预检**（profile/package.json 的 `dependencies` 与 `dsh.profile.bundles`、profile/cordis.patch.yml 中被测插件/fixture 条目、profile/node_modules 孤儿目录），有残留先**询问用户**保留为 fixture 还是清理。
- 不存在则创建：`pnpm dsh --profile test --from-default-profile web`（约 30-60s；命令非零退出但 profile 目录已生成 = 成功）。`--from-default-profile` **只拷 bundle 清单**，不继承 web profile 的用户补丁层——MCP insert 条目（chrome-devtools 等）不会随行，需按 §5.3 步骤自配置。
- 非 Web 目标（headless / tui 类验证）可基于 `default` 模板创建并说明差异；e2e 一律 `test` profile，**不**触碰 default profile 与已运行实例。
- 默认端口 `3865`（3080 是上游默认，本机常被占）；新机器 3080 空闲时可改用 `--port 3080`。

### 5.2 Step 2 — 安装被测插件（默认 link:，其他方式须说明）

```sh
# 0) 构建式插件预构建：link: 不触发任何生命周期脚本（pnpm 对 link: 不跑 prepare），
#    dist 缺失时宿主只报静默的 failed to import
pnpm --filter <pkg-name> build
# 1) link: 安装（--profile 必须置于 plugin 子命令之后，否则 too many arguments；
#    link: 后必须是绝对路径——相对路径按 pnpm 语义解析到 profile 目录而非 CWD）
pnpm dsh plugin --profile test add link:<仓库绝对路径>/packages/<name>
#    临时插件同理：link:<仓库绝对路径>/.agents/tmp/<kebab>
# 2) 核对注册：profile/package.json 的 dependencies 与 dsh.profile.bundles 应含被测包
```

**`link:` 是默认与推荐方式**，因它指向 TS 源码入口（`main: src/index.ts`）即可直接加载，便于迭代。**其他安装方式仅当被测对象就是安装链路本身**时使用，并必须明确说明与 `link:` 的差异：

| 安装方式 | 命令示例 | 适用 | 已知约束 |
|----------|----------|------|----------|
| `link:` | `plugin add link:<abs>/packages/<n>` | 默认；本地开发迭代 | TS 源码入口依赖 Node 原生 type-stripping（仅 `link:` 下可用） |
| npm registry | `plugin add @scope/<pkg>@<exact>` | 验证实体安装 / 修复 e2e | 必须**精确版本号**（registry 元数据分钟级边缘缓存，`@latest` 易命中未传播旧版）；实体安装必须 JS 入口（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`） |
| git | `plugin add <git-url>#<ref>` | 验证 git 安装 | 同样必须 JS 入口；git 依赖消费方需 `allowBuilds` 放行 |
| tarball | `plugin add <pkg>-<ver>.tgz` | 验证打包完整性 | 同样必须 JS 入口；首次 add 中断重跑会丢 `dsh.profile.bundles` 注册 |

构建式插件（如 `dsh-llm-fallback`）无论哪种安装方式都先 build 一次，再加 client bundle（`./client/index.js` 入口）；`cordis.patch.yml` 内的 `name: <pkg>` 与 `package.json#name` 必须一致，否则 web boot 静默失败。

### 5.3 Step 3 — 启动服务 + 浏览器 MCP 能力预检与自配置

```sh
# 启动 Web UI（进程后台长跑即保活；带 token 的 UI 地址 banner 可能 40s+ 才打印）
pnpm dsh --profile test --no-open --port 3865
```

**MCP 能力预检序列**（在浏览器工具派上用场之前完成）：

1. **本会话工具清单**：确认是否已有 `mcp__chrome__*`（chrome-devtools MCP）；同时盘点其他控制类插件/MCP（`mcp__victauri__*` 等），避免验证手段重复建设。
2. **所属 dsh profile 补丁层**：`pnpm dsh --profile <当前 profile> --dump-config | grep mcp` 看组合树中是否存在 mcp-client 实例；或直接读 `~/.dsh/profiles/<当前 profile>/cordis.patch.yml` 与 `~/.dsh/cordis.patch.yml` 查 `- insert:` 条目。

**缺失时的自配置**：向验证 agent 所在 profile 的 `cordis.patch.yml` 追加 `- insert:` 块（**必须 insert，不能平级 id 覆盖**——bundle 层不存在该条目，id 覆盖会报 entry not found 被丢弃）：

```yaml
- insert:
    - id: mcp-chrome-devtools-win
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome
        transport: stdio
        command: chrome-devtools-mcp
        args:
          - '--executablePath=C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
          - '--no-usage-statistics'
          - '--isolated'
      disabled: !!js process.platform !== 'win32'
    - id: mcp-chrome-devtools-linux
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome
        transport: stdio
        command: chrome-devtools-mcp
        args:
          - '--executablePath=/usr/bin/microsoft-edge-stable'
          - '--no-usage-statistics'
          - '--isolated'
      disabled: !!js process.platform === 'win32'
```

写入后 HMR 或重启实例生效（`chrome-devtools-mcp` 经 mise shim 在 PATH）。**注意**：被测 profile 本身不需要浏览器 MCP——浏览器工具从验证侧连被测实例的 UI；只有「agent 自驱」模式（验证 agent 会话跑在被测 profile 内）才需给被测 profile 配。

### 5.4 Step 4a — 加载级三断言

实例输出出现后，逐项断言：

1. **加载日志契约**：实例输出出现 `[<name>] ` 前缀格式的日志行（如 `[my-plugin] plugin loaded`）——插件 `apply` 时必须打印。按该结构化格式匹配，路径/堆栈中出现裸包名**不算**加载成功。类式插件（`extends Service`，如 shell executor）为惰性实例化，装载日志须打在**模块顶层**。
2. **端口可达**：`http://127.0.0.1:3865` 有响应。
3. **UI 页面健康**：打开 banner 打印的带 token URL，页面状态 <400（auth 中间件对带 token 首访返回 303 属健康——认证决策流由后续会话续接）。

### 5.5 Step 4b — 功能级逐项验证

**方法论**：从插件 README / 本次变更说明提取「本次更新特性清单」，逐项映射到验证手段（UI 配置面 / 行为契约面 / 轨迹与日志面），形成可勾选清单后逐项执行。

保持 §5.3 实例不退出，用浏览器工具打开 tokened URL：

1. **页面健康**：标题 `DeepSeek Harness`，console 无与目标插件相关的错误（web-all/git-graph 等生态噪音可忽略）；
2. **插件面板**：设置 → 插件 →「已安装」分组中目标插件显示「已启用」；
3. **配置面**：本次更新涉及的所有配置项（开关、列表、规则编辑器、主题变量等）均能在配置卡中正确渲染、保存即时生效、保存·放弃 + revision 冲突检测；
4. **行为契约面**：本次更新的功能逻辑逐一验证（窗口/规则/事件触发/降级路径等），发会话任务触发真实调用，展开「N 次工具调用」核查参数；
5. **真实调用**：新会话发自然任务（需要专测某工具时在任务里点名该工具），发送后等响应，核查响应符合行为契约；
6. **轨迹核查（比 UI 可靠）**：从 `~/.dsh/sessions/--<cwd-dir>--/session-*/session.v3.jsonl.zstd` 流式解压（Node `zstandard` 多帧流式读，`decompress()` 只出首帧），提取 `tool/call` 的 arguments 逐项核查；
7. **纯净 profile 对比法**（排除 hindsight 记忆污染）：记忆会把过往成功经验注入新会话——验证「默认行为」必须用无记忆环境。建独立 profile（`pnpm dsh --profile <name> --from-default-profile web` 引导 + add 被测包；`<name>` 须另起名，勿复用主测试 profile `test`），跑零工具暗示的任务，从该 profile 轨迹核实工具选择；
8. **提示词契约**：description/section 等引导文案是行为定义，测试里加「存在性断言」（如 `toContain('Do NOT shell out')`）防回归删除。

**验证完毕：所有项打勾、证据齐备后，进入 §5.6 清理决策点。**

### 5.6 测试完毕——清理决策必须询问用户（重点）

**测试验证全部 PASS 后，先不清理**；向用户提交「测试产物清单」供选择：

- 安装的插件（`link:` 实体 / 节点链接）；
- profile `cordis.patch.yml` 中本次新增/修改的条目（含 fixture 配置如 broken-model provider、agent-default-model 改写等）；
- node_modules 孤儿目录；
- 工作区被改动的文件（构建产物、临时 scratch、未提交修改）；
- 后台实例进程。

询问决策维度（可多选）：

- **全部清理，恢复干净态**（执行 `plugin remove` + 剥离 patch 条目 + 清孤儿 + 删 scratch + 结束实例）；
- **保留为 fixture**（profile + 插件原样留着，下次复用——参考历史 `llmfb-entity-test` 脚手架的复用方式）；
- **部分清理**（用户逐项圈选要清/要留的）。

**原则**：插件是否清理是**用户决策**而非 agent 自动行为。破坏性动作（plugin remove、patch 回滚、删 scratch、结束实例）一律先经用户确认。

### 5.7 注意事项

- **profile 隔离**：profile 只隔离**插件列表**，`DSH_HOME` 共享全局 `~/.dsh`（模型凭证不隔离）；不触碰默认 profile 与已运行实例。**e2e 一律在 `test` profile 上执行，不要在 default profile 上跑**。
- **agent 自驱**：dsh agent 会话内可用后台 job 方式执行同一流程（Step 3 后台长跑 + 浏览器/MCP 工具接管验证），步骤与 §5.1–§5.6 完全一致；清理同样**必须询问用户**。
- **permission presets 互斥**（仅非禁闭执行器类插件）：被测插件独占 `ctx.shell` 且非 confining 时，permission presets 构造期检查抛错（要求禁闭执行器）——在该 profile 的 `cordis.patch.yml` 顶层追加 `- id: permission` + `  disabled: true`（附注释行说明缘由）；该条目属于「本次新增/修改」应在 §5.6 清理询问中由用户决策。
- **避免重复配置**：§5.3 能力预检的盘点同时给出「当前 dsh agent 已有 MCP 清单」，防止为同一能力重复配置（如同时存在 victauri 与 tauri-mcp 时只保留一个）。

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
