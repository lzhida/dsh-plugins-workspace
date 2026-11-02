---
name: dsh-plugin-dev
description: 开发与维护 DeepSeek Harness (dsh) 插件及 bundle 包内的插件行——脚手架新插件包、cordis 契约与 ctx.effect 生命周期、defineTool 工具与类型契约、新增/下线/归档插件行的完整接线面与留痕面、客户端侧栏面板插槽注册、真实 test profile 实例的加载级断言与活体全链路验证，直到中文 Conventional Commits 提交门禁与看板交接。当用户要创建、修改、验证、下线或归档 dsh 插件（packages/*/src、apply(ctx)、ctx.effect、defineTool、cordis.patch.yml insert 行、sidebar.panellist、e2e 自验、提交收尾）时使用。
whenToUse: 触发词——「写个 dsh 插件」「加一个插件行」「新增工具」「下线/归档某个插件行」「插件侧栏面板」「插件 e2e 自验」「起 test profile 实例验证」「插件改动提交」。也用于 bundle 单包（packages/dsh-anytype 一类）内新增/下线插件行时的接线清单、defineTool 类型契约与工具计数口径对齐、cordis.patch.yml insert 行增删、守卫测试改写、加载级三断言与直驱活体后端的 e2e 脚本、门禁四连与中文 Conventional Commits 提交收尾。
---

# dsh 插件开发工作流

本 skill 针对 **本 monorepo 的真实工具链**（pnpm workspaces + vitest + lefthook + dsh 原生 CLI），把「能跑」的插件开发流程压缩为可照抄的步骤。覆盖三种典型活儿：① 独立插件包从零脚手架；② **bundle 单包内新增 / 下线 / 归档一个插件行**；③ 插件改动自验（加载级 + 活体全链路）后收尾提交。背景知识见文末延伸阅读。

## Steps

### 1. 仓库速览

- 插件以 **TS 源码** 被宿主 dsh loader 直接加载——**默认无构建步骤、不产出 dist**，`package.json` 的 `main` 直指 `src/index.ts`（例外：`dsh-llm-fallback` 为构建式发行，`main` 指 esbuild 打包的 `dist/index.js`）。
- 一个插件一个目录：`packages/<kebab-name>/`；测试与源码同目录 `src/*.test.ts`（vitest）。
- 全仓 ESM（`type: "module"`）+ `verbatimModuleSyntax`：类型导入必须写 `import type`。
- **bundle 单包多插件行**（`packages/dsh-anytype` 一类）：一个 npm 包内并存多个插件行，每行 = `src/entries/<name>.ts` 入口 + `src/<域>/**` 实现；**包级 `cordis.patch.yml` 里的 `- insert:` 行决定哪些行被宿主装载**，`src/index.ts` 做 barrel 汇总导出。

### 2. 新插件脚手架（照抄即可）

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
  console.log(`[${name}] plugin loaded`)   // e2e 契约，见 §7.4
  ctx.effect(() => {
    const timer = setInterval(() => {
      console.log(`[${name}] heartbeat`)
    }, 5000)
    return () => clearInterval(timer)      // 卸载时自动调用
  })
}
```

临时验证插件可放 `.agents/tmp/<kebab>/`（gitignored）：同样结构，**无需 pnpm install**，跳过 vitest，直接走 §7 e2e。

### 3. cordis 核心语义（写对的关键）

- `apply(ctx)` 在插件安装时被调用，用于注册能力；`export const name` 是 loader 依赖的标识。
- **`ctx.effect(fn)`：`fn` 立即执行，`fn` 返回的函数在插件卸载时被框架自动调用**。事件监听、定时器、连接的清理一律走这条路径；不要手写 removeListener/clearInterval 之外的反注册逻辑。写测试 stub 时必须模拟「立即执行」语义。
- 依赖注入：`export const inject = ['tools']`——框架保证 `ctx.tools` 就绪后才调 `apply`。依赖无人提供时插件**静默停在 PENDING**（无任何报错），排查用 `ctx.registry` 遍历 `FiberState.PENDING`。
- 插件三种形态：函数式（推荐）/ 对象式 / 类式（向其他插件提供服务时用 `extends Service`）。
- **插件行入口文件**（bundle 单包场景）`src/entries/<name>.ts` 导出：`name` / `inject` / `apply(ctx)` / `Config`（配置 schema，供 bundle 配置卡渲染）。工具注册、装载日志都写在这个入口的 `apply` 里。

### 4. 工具开发（defineTool）

#### 4.1 基本形态

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

#### 4.2 类型契约：返回值与入参（写错必被 typecheck 打回）

- **`execute` 必须显式标注返回类型 `Promise<Record<string, JsonValue>>`**（`JsonValue` 沿用同仓既有工具定义处的类型来源，不要自造）。返回体里**不得出现 `undefined`——用 `null`**（`JsonValue` 不含 `undefined`）。
- **object 型入参必须带 `additionalProperties: true`**，否则与 `ParameterPropertySpec` 不匹配（TS2322）。
- 数组 / 对象字段若 TS 推断与 `JsonValue` 不兼容，用 `as JsonValue` 显式标注（例：`broken_links: broken as JsonValue`）。
- 测试里访问未在类型上出现的字段（如 `results[0].error`）会在 `as` 断言里报 TS2339——在断言里补 `error?: unknown` 即可，不要去改实现类型。

#### 4.3 工具计数口径（四处必须一致）

工具数量（以及工具名集合）要在这**四处**同时对上，任何一处漏改都会被契约测试或评审打回：

1. 实现文件头注释里写的工具数；
2. `README.md` 的插件行表；
3. `docs/bundle-architecture.md`；
4. 包级契约测试的断言（如 `expect(tools.length).toBe(6)`）。

**易错点**：`get` 与 `list` 是**两个**工具——先按「一个业务概念一个工具」估数会少算一个（5 vs 6）。改完工具就同步四处。

### 5. bundle 包内的插件行

#### 5.1 结构

```
packages/dsh-anytype/
├── package.json            # exports 子路径 + description
├── cordis.patch.yml        # 各插件行的 - insert: 注册行（决定装载）
├── README.md               # 插件行表
├── docs/
│   ├── README.md
│   └── bundle-architecture.md   # §4「如何新增一个插件行」= 权威清单
└── src/
    ├── index.ts            # barrel：export * from './entries/<name>.ts'
    ├── entries/
    │   ├── memory.ts       # name / inject / apply / Config
    │   └── wiki.ts
    └── wiki/               # 某个域的实现
        ├── schema.ts  store.ts  config.ts  index.ts
        ├── tools/*.ts      # 一个工具一个文件
        └── *.test.ts
```

#### 5.2 新增一个插件行：完整接线面（照清单办）

> 权威清单以 `docs/bundle-architecture.md` §4「如何新增一个插件行」为准；下面是与本仓实践对齐的逐项落点，**一项都不能少**：

1. `src/<域>/`：`schema.ts`（词表/属性常量）、`store.ts`（后端读写，含幂等 bootstrap）、`config.ts`（配置）、`tools/*.ts`（每个工具一个文件）、域 `index.ts` barrel、同目录 `*.test.ts` 单测。
2. `src/entries/<name>.ts`：导出 `name` / `inject` / `apply(ctx)` / `Config`；`apply` 里注册工具并打印装载日志 `[<name>] plugin loaded` 与 `[<name>] registered N <prefix> tools`。
3. 包级 `cordis.patch.yml`：追加该插件行的 `- insert:` 行（与既有行并列，注释块写清该行定位）。
4. `src/index.ts`：barrel 导出该入口（`export * from './entries/<name>.ts'`）。
5. `package.json`：`exports` 加对应子路径（`'./<name>'`）；`description` 写清该插件行定位。
6. `README.md` 插件行表加一行（工具数一并对上）。
7. `docs/README.md` 与 `docs/bundle-architecture.md` 同步该行的定位与工具数。
8. `.changeset/<name>.md`：声明该包 **minor**，正文写清新插件行定位。
9. 包级契约测试：断言工具数、工具名前缀、工具名唯一。
10. **类型契约自检**（§4.2）：每个 `execute` 显式 `Promise<Record<string, JsonValue>>`、返回体无 `undefined`、object 入参带 `additionalProperties: true`。

#### 5.3 下线 / 归档一个插件行（代码保留、可一键恢复）

- **唯一生效改动**：从包级 `cordis.patch.yml` 移除该插件行的 `- insert:` 注册行。`src/<name>/**`（含 `src/entries/<name>.ts`）**源码保留**。
- **恢复方式**：把该 insert 行追加回 insert 列表即可（实现与导出都还在，无需改代码）——把这句话写进留痕面。
- **留痕面（必须同步四处）**：`cordis.patch.yml` 的注释块（归档原因 + 归档日期 + 恢复方式）、`package.json` `description`、`README.md` 插件行表、`docs/bundle-architecture.md`（+ `docs/README.md` 若含插件行表）。
- **验证面（可观测断言）**：
  - 实例日志**不再出现**该插件行的 `[dsh-<name>]` 前缀行；
  - `registered N tools` 计数按归档前后变化（如 46 → 30）；
  - 系统提示词里不再残留该插件行的指引（断言锚点用**渲染文案**而非内部 section id，并同时给出目标插件残留的**负向断言**）。

#### 5.4 改写挡路的守卫测试（改语义，不删测试）

归档插件行会让既有守卫测试挡路（如 `client-bundle.test.ts:130` 断言 patch **同时含两个**插件行 id）。处理方式：

1. 先定位并读懂这条断言的语义；
2. **改写**为「主行在 / 归档行不在」的语义（用集合包含/不包含断言），**不删除该测试**；
3. 跑一遍确认它现在守的是新语义。

#### 5.5 旧独立包被并进 bundle 后，代码去哪了

不要只看当前工作树就断言「代码不存在」。用 git 历史定位：

```sh
git log --oneline --all -- packages/<name>          # 该包的历史提交
git log --all --grep=<关键词>                        # 按关键词找并入 bundle 的那次提交
```

确认两件事：① 当前是 **bundle 单包结构**（多个插件行共存于一个包）；② 插件行的注册位置 = 包级 `cordis.patch.yml` 的 `- insert:` 行 + `src/entries/<name>.ts` 入口。

### 6. 客户端侧栏面板（sidebar.panellist）

在插件里加一个左侧栏面板（如展示 anytype 连接状态）时：

1. **注册形态**：在 `sidebar.panellist` 插槽注册**图标位** + `main` 插槽注册**内容位**；用 `ctx.layout.selectPanel(id | null)` 做开合；**面板 id 用常量声明**（如 `const WIKI_PANEL_ID = 'dsh-anytype-wiki'`），不要散落字面量。
2. **数据通道（面板要从宿主侧拿数据）**——两条可执行路径，任选：
   - **host 半区同源 HTTP 路由**：host 侧 `ctx.inject(['webServer'])` → `ctx.webServer.register({ kind: 'prefix' | 'exact', path, handler })`，`handler` 是 node http 的 `(req, res)`；客户端直接 `fetch` 同源路径。可再配 SSE（hello 事件 + 心跳）做推送。
   - **命令桥接**：`ctx.remote.commands.execute()` 调宿主服务方法（一次实现、两处调用）。
   - 参考实例：`dsh-mnemon`（面板注册形态）、`dsh-taskboard`（host 半区 `/dsh-taskboard/*` 路由 + 客户端 fetch）。
3. **样式**：只用 `--dsw-alias-*` token；**不用 iframe**；文案走 `dict.ts` 双语字典。
4. **数据来源**：复用宿主已有能力（如 `AnytypeClient.probeDesktop()`，2s 超时），**不新造重复的探测逻辑**。

### 7. e2e 自验（真实 dsh 实例，四步标准流程，统一 `test` profile）

e2e **无专用脚本**：直接用 `pnpm dsh` 原生命令，在独立的 **`test` profile** 中编排一个真实 dsh Web 实例做「加载级」+「功能级」验证；真实效果由浏览器工具（**dsh-browser 插件 `dsh_browser_*` 优先**，选型见 §7.3）在同一实例上无缝接管。全程以仓库根为工作目录，**所有涉及测试执行的地方一律使用 `test` profile**。

**四步固定顺序**：

1. **Step 1** —— profile 解析（找到或创建，含残留预检）
2. **Step 2** —— 安装被测插件（默认 `link:`，其他方式须说明）
3. **Step 3** —— 启动服务 + 浏览器验证工具预检（**`dsh_browser_*` 优先，零配置可用**；仅两者皆无时才回退 MCP 自配置，见 §7.3）
4. **Step 4** —— 加载级三断言 + 功能级逐项验证（含直驱活体后端的全链路脚本，见 §7.6）

**测试完毕的清理必须询问用户，禁止 agent 自动执行破坏性清理动作**（见 §7.9）。

#### 7.1 Step 1 — profile 解析（找到或创建）

- 优先复用既有 profile：先查 `~/.dsh/profiles/` 是否已有 `test`；已有则做**残留预检**（profile/package.json 的 `dependencies` 与 `dsh.profile.bundles`、profile/cordis.patch.yml 中被测插件/fixture 条目、profile/node_modules 孤儿目录），有残留先**询问用户**保留为 fixture 还是清理。
- 不存在则创建：`pnpm dsh --profile test --from-default-profile web`（约 30-60s；命令非零退出但 profile 目录已生成 = 成功）。`--from-default-profile` **只拷 bundle 清单**，不继承 web profile 的用户补丁层。验证侧浏览器工具不受此影响——`dsh_browser_*` 是宿主级能力、与 profile 无关；仅 MCP 回退路径才需按 §7.3 自配置。
- 非 Web 目标（headless / tui 类验证）可基于 `default` 模板创建并说明差异；e2e 一律 `test` profile，**不**触碰 default profile 与已运行实例。
- 端口：文档默认端口是 `3865`，但**它不是事实**——起实例前先探端口、再按实际监听端口断言（见 §7.4）。

#### 7.2 Step 2 — 安装被测插件（默认 link:，其他方式须说明）

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

> bundle 单包场景：被测对象是**包内的一个插件行**时，装的是**包**（`link:<abs>/packages/<bundle>`），行是否装载由包级 `cordis.patch.yml` 的 insert 行决定——改行后需重启/重载实例再断言。

#### 7.3 Step 3 — 启动服务 + 浏览器验证工具预检（dsh-browser 优先，MCP 回退）

```sh
# 启动 Web UI（进程后台长跑即保活；带 token 的 UI 地址 banner 可能 40s+ 才打印）
pnpm dsh --profile test --no-open --port 3865
```

**启动命令不要带位置参数**：`pnpm dsh --profile test web` 会报 `too many arguments. Expected 0 arguments but got 1: web`（exit 1，实例根本没起来）；要指定 app 就先 `pnpm dsh --help` 查当前 CLI 用法，默认 app 即为 web。

**起实例前环境预检**：查默认端口 3865 是否被占用、确认残留 node 进程归属（是不是上一轮遗留的实例），再决定能否起 test 实例。

**浏览器验证工具选型**（在浏览器工具派上用场之前完成，按优先级）：

1. **首选：dsh-browser 插件（`dsh_browser_*` 工具族）**——dsh 主流方式，宿主级内置浏览器，**零 profile 配置**。预检动作仅需确认本会话工具清单已有 `dsh_browser_open` / `dsh_browser_a11y` / `dsh_browser_click` 等；顺带盘点其他控制类插件/MCP（`mcp__victauri__*` 等），避免验证手段重复建设。
2. **回退：chrome-devtools MCP（`mcp__chrome__*`）**——仅当本会话无 `dsh_browser_*`（插件未装且无法即时安装），或被测对象就是 MCP 链路本身时启用。先查补丁层：`pnpm dsh --profile <当前 profile> --dump-config | grep mcp` 看组合树中是否存在 mcp-client 实例；或直接读 `~/.dsh/profiles/<当前 profile>/cordis.patch.yml` 与 `~/.dsh/cordis.patch.yml` 查 `- insert:` 条目。

**MCP 回退时的自配置**：向验证 agent 所在 profile 的 `cordis.patch.yml` 追加 `- insert:` 块（**必须 insert，不能平级 id 覆盖**——bundle 层不存在该条目，id 覆盖会报 entry not found 被丢弃）：

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

写入后 HMR 或重启实例生效（`chrome-devtools-mcp` 经 mise shim 在 PATH）。**注意**：被测 profile 本身不需要任何浏览器工具——浏览器工具从验证侧连被测实例的 UI；只有「agent 自驱」模式（验证 agent 会话跑在被测 profile 内）才需给被测 profile 配。

#### 7.4 Step 4a — 加载级三断言

实例输出出现后，逐项断言：

1. **加载日志契约**：实例输出出现 `[<name>] ` 前缀格式的日志行（如 `[my-plugin] plugin loaded`）——插件 `apply` 时必须打印。按该结构化格式匹配，路径/堆栈中出现裸包名**不算**加载成功。类式插件（`extends Service`，如 shell executor）为惰性实例化，装载日志须打在**模块顶层**。工具型插件再加一条：日志里出现 `[<name>] registered N <prefix> tools`（N = §4.3 口径的工具数）。
2. **端口可达**：**按实际监听端口断言**——先探文档默认端口（3865），失败再探候选端口（3080、实例 banner 打印的端口）。文档默认端口不是唯一事实；tokened UI URL 要用真实端口拼。
3. **UI 页面健康**：打开 banner 打印的带 token URL，页面状态 <400（auth 中间件对带 token 首访返回 303 属健康——认证决策流由后续会话续接）。

#### 7.5 Step 4b — 功能级逐项验证

**方法论**：从插件 README / 本次变更说明提取「本次更新特性清单」，逐项映射到验证手段（UI 配置面 / 行为契约面 / 轨迹与日志面），形成可勾选清单后逐项执行。

保持 §7.3 实例不退出，用浏览器工具（首选 `dsh_browser_open`）打开 tokened URL：

1. **页面健康**：标题 `DeepSeek Harness`，console 无与目标插件相关的错误（web-all/git-graph 等生态噪音可忽略）；
2. **插件面板**：设置 → 插件 →「已安装」分组中目标插件显示「已启用」；
3. **配置面**：本次更新涉及的所有配置项（开关、列表、规则编辑器、主题变量等）均能在配置卡中正确渲染、保存即时生效、保存·放弃 + revision 冲突检测；
4. **行为契约面**：本次更新的功能逻辑逐一验证（窗口/规则/事件触发/降级路径等），发会话任务触发真实调用，展开「N 次工具调用」核查参数；
5. **真实调用**：新会话发自然任务（需要专测某工具时在任务里点名该工具），发送后等响应，核查响应符合行为契约；
6. **轨迹核查（比 UI 可靠）**：从 `~/.dsh/sessions/--<cwd-dir>--/session-*/` 取**最新版本号**的轨迹文件（当前为 `session.v4.jsonl.zstd`；老实例可能是 v3）。**多帧 zstd 必须逐帧解**——用纯 JS 解码器解帧，单帧便捷函数（如 `decompress()`）只出首帧。提取 `tool/call` 的 arguments 逐项核查；
7. **系统提示词断言**：锚点用**渲染文案**而不是内部 section id；同时给出目标插件残留的**负向断言**（该插件指引不再出现）；
8. **纯净 profile 对比法**（排除 hindsight 记忆污染）：记忆会把过往成功经验注入新会话——验证「默认行为」必须用无记忆环境。建独立 profile（`pnpm dsh --profile <name> --from-default-profile web` 引导 + add 被测包；`<name>` 须另起名，勿复用主测试 profile `test`），跑零工具暗示的任务，从该 profile 轨迹核实工具选择；
9. **提示词契约**：description/section 等引导文案是行为定义，测试里加「存在性断言」（如 `toContain('Do NOT shell out')`）防回归删除。

**验证完毕：所有项打勾、证据齐备后，进入 §7.9 清理决策点。**

#### 7.6 直驱插件代码打活体后端（绕过 UI 的全链路脚本）

除了 UI 验证，还要证明「工具实现真的打通了真实后端」时，写一个**直驱脚本**：绕过会话/UI，直接 import 包内源码里的工具实现去调活体后端。

```sh
# .agents/tmp/<name>-e2e.ts —— Node ≥22 原生 type-stripping
node .agents/tmp/<name>-e2e.ts
```

规则：

- 脚本落 `.agents/tmp/`（gitignored，绝不提交），直接 `import` 包内 `src/**` 的实现函数逐个调用；
- **输出必须可判定**：每步打印 JSON 结果，最后打印 PASS/FAIL 摘要与关键计数（创建/命中/失败数），失败时打印完整栈；
- 调用 store 层时注意**空串语义 ≠ undefined**：实现内部按 `.length` 判断，传 `undefined` 会炸 `Cannot read properties of undefined (reading 'length')`，传 `''` 才是「未指定」的正确表达；
- 链路覆盖建议：setup（幂等 ×2）→ write（建/更新查重）→ review（决策）→ get → list → lint，能直接暴露后端契约问题；
- 产物清理（归档测试笔记、删探针对象）**必须先经用户确认**——活体后端上的数据不是沙箱。

#### 7.7 外部 API 返回 400 / 字段缺失时的排查顺序

1. **先读错误体里的清单**：多数 API 会在错误里回「已知键/已知属性列表」（如 `unknown property keys … known property keys: …`）——这是权威目录，比猜字段名快得多；
2. 用清单里**真实存在的键**重发一个最小请求，确认通路；
3. 再改实现（过滤语法、等号/双等号、字段名大小写这类细节，先用最小请求验证一次再写进代码）；
4. **把改法写进实现文件头注释**，避免下次重踩同一坑。

#### 7.8 浏览器 e2e 定位失败与输入的替代手法

- **按文本点不到**（`element not found`）：改用 `dsh_browser_execute` 按 `aria-label` 查出元素再点击；
- **输入框赋值不生效**：先看节点类型——**输入框往往是 contenteditable DIV**（不是 input），赋值无效，改用 `dsh_browser_type`；
- 定位失败时优先用 `dsh_browser_a11y`（语义角色/名称/状态）看结构，比文本猜测稳。

#### 7.9 测试完毕——清理决策必须询问用户（重点）

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

#### 7.10 注意事项

- **profile 隔离**：profile 只隔离**插件列表**，`DSH_HOME` 共享全局 `~/.dsh`（模型凭证不隔离）；不触碰默认 profile 与已运行实例。**e2e 一律在 `test` profile 上执行，不要在 default profile 上跑**。
- **agent 自驱**：dsh agent 会话内可用后台 job 方式执行同一流程（Step 3 后台长跑 + 浏览器工具（`dsh_browser_*` 优先）接管验证），步骤与 §7.1–§7.9 完全一致；清理同样**必须询问用户**。
- **permission presets 互斥**（仅非禁闭执行器类插件）：被测插件独占 `ctx.shell` 且非 confining 时，permission presets 构造期检查抛错（要求禁闭执行器）——在该 profile 的 `cordis.patch.yml` 顶层追加 `- id: permission` + `  disabled: true`（附注释行说明缘由）；该条目属于「本次新增/修改」应在 §7.9 清理询问中由用户决策。
- **避免重复建设**：§7.3 预检的盘点同时给出「当前 dsh agent 已有浏览器/MCP 工具清单」——已有 `dsh_browser_*` 就不再配 chrome-devtools MCP；同一能力只保留一个（如同时存在 victauri 与 tauri-mcp 时只保留一个）。

### 8. 门禁链（提交前必过）

```sh
pnpm format          # Prettier 写入，归一改动文件（format:check 只校验）
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

- **必须显式记录每条命令的退出码与真实输出**（贴输出，不写「应该没问题」）。`format:check` 打印 `[warn] <file>` 即失败——先 `pnpm format` 写入再复验。
- 分支模型：开发走 `feat/*`、`fix/*` → 合入 `dev` → 验证后合入 `main`；提交信息中文 Conventional Commits；pre-commit 自动 lint-staged，pre-push 跑 `pnpm test`。
- 已知坑位（勿重踩）：TS 锁 5.x（typescript-eslint 8 peer `<6.1.0`）；pnpm 11 默认拦截依赖构建脚本，新依赖需在 `pnpm-workspace.yaml` 的 `allowBuilds` 追加 `true`；cordis `ctx.effect` stub 必须立即执行回调。

### 9. 提交收尾（用户授权后）

**先拿到用户明确授权**（对话里出现「提交」「帮我提交」等），再执行：

1. **分支**：`git checkout -b feat/<slug>`（基线是 `dev`），**不直接在 main/master 上提交**；
2. **暂存范围**：`git add <相关包目录> .changeset/<name>.md`——只加本次改动面，**不**加 `.agents/tmp/`、日志、dump 等一次性产物（暂存后用 `git status --short` 复核一遍）；
3. **commit**：Conventional Commits + **中文 subject**（如 `feat(dsh-anytype): 新增 dsh-anytype-wiki 插件行（AI 笔记知识库）`），body 写清定位与影响面；pre-commit 会跑 lint-staged；
4. **提交后复核**：`git branch --show-current` / `git log -1 --format='%h %s'` / `git status --short`（应为**空**）；
5. **不执行 `git push`**——push、force-push、rebase 已推送历史一律留给用户。

### 10. 看板交接（taskboard）

插件改动落在看板卡上时，按状态机走：

1. `taskboard_get` 读状态与评论（评论视为最新需求；卡若被系统退回 `todo`，先 `move(ifVersion=…, in_progress)` 重新置为进行中再动手）；
2. 实现并自验 → `taskboard_execution_report` 提交结构化报告（摘要 / 改动文件 / 自验 / 风险）→ `taskboard_comment_add` 留补充细节；
3. `taskboard_checklist` **逐项**勾选验收清单，**每项 note 必须含真实命令/输出证据**（文件路径、行号、命令输出摘要）。**每勾一次卡版本 +1**，下一次必须用上一条返回的**新 ifVersion**（串行推进，不要并发勾）；
4. 全部勾完 `taskboard_move` 到 **in_review**；
5. **绝不自行移 done**——那是用户的确认动作；清单全勾也不等于完成。`backlog` 任务属未授权执行。

## Pitfalls

| 现象 | 根因 | 处理 |
|------|------|------|
| `pnpm dsh --profile test web` → `too many arguments. Expected 0 arguments but got 1: web`，实例没起 | CLI 不接受位置参数 | 去掉 `web`（默认即 web app）；不确定先 `pnpm dsh --help` |
| 探 3865 为 False，但实例其实活着 | 实际监听端口不是文档默认端口（3080） | 端口断言按**实际监听端口**，探候选端口；tokened UI 也用真实端口拼 |
| typecheck TS2322：返回值不匹配 `Record<string, JsonValue>` | execute 返回体含 `undefined` / 推断不兼容 | 显式标 `Promise<Record<string, JsonValue>>`；`undefined` 改 `null`；数组字段 `as JsonValue` |
| typecheck TS2322：object 入参不匹配 `ParameterPropertySpec` | object 型入参缺 `additionalProperties` | 补 `additionalProperties: true` |
| typecheck TS2339：`results[0].error` 不在类型上 | 断言访问了未声明字段 | 在 `as` 断言里补 `error?: unknown`，别改实现类型 |
| 契约测试数出的工具数与实现差 1 | `get` 与 `list` 是两个工具 | 按 §4.3 把数量同步到代码头注释 / README / docs / 契约测试四处 |
| setup 场景断言拿不到 `options` | 该场景一次性铺满了全部属性 | 按场景拆分属性清单 |
| `format:check` 报十几个 `[warn] <file>` | 新文件未按 Prettier 归一 | `pnpm format` 写入后复验 `format:check` |
| 外部 API 400 `unknown property keys` | 用了不存在的字段名 | 先读错误里的 known keys 清单，取真实键重试最小请求，再改实现（§7.7） |
| 外部查询过滤语法 parse error | 等号/双等号写法不对 | 用最小请求先验一次（如单等号 vs 双等号）再写进实现 |
| 直驱脚本 `Cannot read properties of undefined (reading 'length')` | store 层可选参数传了 `undefined` | 传空串 `''`（实现按 `.length` 判空） |
| 守卫测试因插件行归档而挡路 | 旧断言要求 patch 同时含两个插件行 id | 改写为「主行在 / 归档行不在」语义，**不删测试**（§5.4） |
| 会话轨迹只解出第一帧 | zstd 是多帧，单帧便捷函数只出首帧 | 用纯 JS 解码器逐帧解；轨迹文件取最新版本号（v4） |
| 浏览器按文本点不到按钮 | 文本选择器不匹配 | `dsh_browser_execute` 按 `aria-label` 查元素再点击（§7.8） |
| 输入框赋值没生效 | 输入框是 contenteditable DIV | 改用 `dsh_browser_type` |
| 看板勾选报版本冲突 | 卡版本已被前一步推进 | 重新读卡，用上一条返回的新 `ifVersion`，只重试一次 |
| 直接改了 `src/<name>/**` 以为下线成功 | 下线的生效点不在代码 | 下线只改 `cordis.patch.yml` 的 insert 行；源码保留即可恢复（§5.3） |

## Verification

**新增一个 bundle 插件行**
- 接线面十项（§5.2）逐项对照落盘：域目录 / entries 入口四符号 / patch insert 行 / barrel 导出 / package.json exports 子路径 / description / README 插件行表 / docs 两处 / changeset(minor) / 契约测试。
- `pnpm lint` / `pnpm format:check` / `pnpm typecheck` / `pnpm test` **四条命令真实输出全绿**（贴输出，不写「应该没问题」）。
- 工具数 N 在四处一致（§4.3）；实例日志出现 `[<name>] plugin loaded` + `registered N <prefix> tools`，N 与代码一致。
- 活体全链路脚本（§7.6）跑通并输出可判定结果。
- 看板卡停在 **in_review**，验收清单逐项勾选、每项 note 含真实命令/输出证据，**未自行移到 done**。

**下线 / 归档一个插件行**
- 包级 `cordis.patch.yml` 里该 insert 行已移除；`src/<name>/**` 源码仍在（恢复方式已写进留痕面）。
- 留痕面四处同步：patch 注释块（含归档原因/日期/恢复方式）、package.json description、README 插件行表、docs。
- 改写后的守卫测试仍存在且通过。
- 实例日志不再出现 `[dsh-<name>]` 前缀行；`registered N tools` 计数按归档前后变化（如 46 → 30）；系统提示词无该插件残留（负向断言通过）。

**侧栏面板**
- `sidebar.panellist` 图标位 + `main` 内容位注册可见，`ctx.layout.selectPanel(id | null)` 可开合，面板 id 为常量。
- 数据通道可执行：host 半区 `ctx.inject(['webServer'])` + `ctx.webServer.register({kind, path, handler})` 提供只读路由供客户端 fetch，或 `ctx.remote.commands.execute` 桥接宿主服务方法。
- 样式只用 `--dsw-alias-*` token、无 iframe；文案在 `dict.ts` 双语齐备；数据来源复用宿主已有能力（如 `probeDesktop()` 2s 超时）。

**提交收尾**
- 分支 `feat/*`、基线 `dev`；`git add` 只含相关包目录与 changeset；commit 为中文 Conventional Commits；提交后 `git status --short` 为空；**未 push**。

## 延伸阅读

- 官方教程：第一个插件 <https://deepseek-harness.github.io/deepseek-harness/develop/basic/> · 工具开发 <https://deepseek-harness.github.io/deepseek-harness/develop/basic/tool.md> · Cordis HMR <https://deepseek-harness.github.io/deepseek-harness/develop/cordis-tutorial/06-composition-and-hmr.md>
- 社区 skill（通用向，可对照）：green-dalii/dsh-plugin-dev-skill（SKILL.md + References/，含 LLM 适配器/发布/能力分层）· dsh-io/dsh-plugin-skill
- dsh 原生 skill 发现：`<projectRoot>/.agents/skills`（rank 200）、`.dsh/skills`（rank 100）、`$DSH_HOME/skills`（rank 400）；目录名须与 frontmatter `name` 一致
- 本仓权威文档：插件包内 `docs/bundle-architecture.md`（§4「如何新增一个插件行」= 新增插件行的权威清单）
