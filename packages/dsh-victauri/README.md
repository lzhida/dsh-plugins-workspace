# dsh-victauri

[dsh](https://github.com/lzhida/dsh-plugins-workspace)（DeepSeek Harness）插件：Victauri 桥接。

把 [Victauri](https://github.com/4da-systems/Victauri)（Tauri 应用内嵌的 MCP 服务器）暴露的 **35 个调试/测试工具**全量桥接为 dsh 原生工具，并桥接 `victauri` CLI 能力（check / test / doctor / coverage 等），让 dsh 会话具备 **Tauri 框架开发测试环境**。

## 工作原理

- **主通道 · REST 直连**：读取 Victauri discovery 目录（Windows `%TEMP%\victauri\<pid>\{metadata.json, port, token}`；类 Unix 按官方三级回退）拿到 `token` / `port`，直接 `POST /api/tools/{tool_name}` 执行工具，零中间层。
- **辅通道 · CLI 桥**：spawn 本机 `victauri` CLI（`check` / `doctor` / `test` / `coverage` 等子命令），补足 HTTP 面之外的工程能力。
- **连接惰性建立**：插件装载不做 discovery；首次工具调用才自动探活（`started_at` 最新优先），Tauri app 未启动不影响插件加载。

## 安装

> 本插件收录在 [dsh-plugins-workspace](https://github.com/lzhida/dsh-plugins-workspace) monorepo 的
> [packages/dsh-victauri](https://github.com/lzhida/dsh-plugins-workspace/tree/main/packages/dsh-victauri)。

### 方式一：npm 安装（推荐）

```sh
dsh plugin add @zhidal/dsh-victauri
```

### 方式二：link 安装（开发/本地）

```sh
# 在 dsh 工作区执行（--profile 须置于 plugin 之后；link: 后必须是绝对路径）
pnpm dsh plugin --profile test add link:<仓库绝对路径>/packages/dsh-victauri
```

### 方式三：git 实体安装（monorepo 子目录）

```sh
# github: 简写 + &path: 子目录（pnpm 安装 git monorepo 子目录的标准语法）
dsh plugin add github:lzhida/dsh-plugins-workspace#main&path:packages/dsh-victauri
```

本插件为**构建式发行**（`main` 指向 esbuild 产出的 `dist/index.js`，`prepare`/`prepack` 自动构建），git/npm 安装可直接使用。

- **构建工具不进运行时依赖**：`esbuild` 与 `typescript` 都在 `devDependencies`——发布产物已预构建在 `dist/` 里随包分发，消费端不需要构建工具。留在 `dependencies` 会让 **pnpm 11 消费者安装直接失败**（`ERR_PNPM_IGNORED_BUILDS`：pnpm 11 默认拦截依赖的构建脚本并以非 0 退出；npm 11 同场景只警告）。
- **`@deepseek-ai/cordis` 在 `dependencies`**：发布包的 `dist/index.d.ts` 引用其 `Context` 类型（**仅类型级**，运行时已被 esbuild 内联），必须让消费者安装树里必然可得。版本锁 `~4.0.5` 以对齐 `@deepseek-ai/dsh-tools` 的 peer 范围（消费方自带 cordis 4.1.0 会装出两份，且跨副本的 `Context` 类型不兼容，报 TS2345）。
- **pnpm 11 装 git 依赖**：pnpm 默认拦截 git 依赖的 `prepare` 脚本（`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`），需在消费侧 `pnpm-workspace.yaml` 的 `allowBuilds` 放行本包（键需含完整 git spec + commit sha）；npm 消费者无此限制。
- **公开面只有包根**：`exports` 白名单放行包根与 `./package.json`，`dist/tools/**` 等深导入一律不可见（这些路径本就没有对应运行时文件）；发布包的类型声明只保留公开 `.d.ts`。本插件**没有浏览器半区**（不发布 `./client` 入口、不注册右栏页签、不注册任何 HTTP 路由）。
- **产物是纯 ESM，包的 Node 下限是 22.12**：包内只有 `dist/index.js`（`"type": "module"`），没有 CJS 产物。ESM 消费方 `import` 任意 Node ≥ 22 即可，但 **CJS 消费方**用 `require()` 需要 Node **≥ 22.12**（更早版本报 `ERR_REQUIRE_ESM`）—— 因此 `engines.node` 收窄为 `>=22.12`，让不兼容的 Node 在安装期就收到 `EBADENGINE` 提示（npm/pnpm 默认只警告，`engine-strict` 才会硬失败）。

## 配置

| 字段               | 类型     | 默认    | 说明                                                                                                                                   |
| ------------------ | -------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `appIdentifier`    | string   | `''`    | 按 Tauri app bundle id 过滤实例（discovery `metadata.identifier`，对应 victauri bridge 的 `--app` 语义）；留空 = 自动选最新实例        |
| `portOverride`     | number   | 空      | 固定服务端口（须出现在 discovery 中）；留空 = 自动发现                                                                                 |
| `cliPath`          | string   | `''`    | `victauri` CLI 可执行文件路径；留空 = 平台默认（win32 为 `victauri.exe`）                                                              |
| `requestTimeoutMs` | number   | `30000` | REST 请求超时毫秒（`wait_for` 动态预算与 `trace`/`introspect` 声明预算 90s 可按工具覆盖，上限 120s，见 docs/TOOLS.md「请求超时语义」） |
| `disabledTools`    | string[] | `[]`    | 不注册的工具全名列表（`victauri_` 前缀全名）                                                                                           |

## 工具清单

Victauri 全量 **35 个工具** + 1 个 CLI 桥工具 + 1 个 CLI 探测工具 + 1 个工具发现工具 + 1 个桥接体检工具 = **39 个 dsh 工具**：

- **standalone 批（20 个）**——单动作用途，参数 1:1 透传：
  `victauri_app_info` `victauri_app_state` `victauri_assert_semantic` `victauri_check_ipc_integrity` `victauri_detect_ghost_commands` `victauri_dom_snapshot` `victauri_eval_js` `victauri_find_elements` `victauri_get_diagnostics` `victauri_get_memory_stats` `victauri_get_plugin_info` `victauri_get_registry` `victauri_invoke_command` `victauri_list_app_dir` `victauri_query_db` `victauri_read_app_file` `victauri_resolve_command` `victauri_screenshot` `victauri_verify_state` `victauri_wait_for`
- **compound 批（15 个）**——复合工具，`action` 参数选择子动作：
  `victauri_animation` `victauri_css` `victauri_explain` `victauri_fault` `victauri_input` `victauri_inspect` `victauri_interact` `victauri_introspect` `victauri_logs` `victauri_navigate` `victauri_recording` `victauri_route` `victauri_storage` `victauri_trace` `victauri_window`
- **CLI 桥（1 个）**——`victauri_cli`：透传 `victauri` CLI 子命令（13 个：`init` / `check` / `test` / `record` / `doctor` / `watch` / `invoke` / `tools` / `call` / `bridge` / `coverage` / `run` / `logs`；`tools` / `call` 需 CLI ≥ 0.10.1，`run` / `logs` 需 ≥ 0.10.2，`invoke` 在 0.10.3 仍与 `call` 并存；上游另有 `setup` 与 clap 内置 `help`，本插件有意不接）；`doctor` 的 PASS/FAIL/WARN 明细额外解析进结构化输出（原始 stdout 始终保留，解析失败回退原文）；长驻子命令（`watch` / `bridge` / `run`，以及 `logs` 的 `--follow` 模式）须配合 `timeout_ms`，超时返回 `timed_out=true` + `partial=true` + 超时前已捕获的部分输出；`watch` = 递归监视测试目录的 `.rs` 变化并重跑**应用工程的** `cargo test`（与 `victauri test` 内置冒烟套件不是同一套测试；多轮效果应重复跑项目自身 `cargo test`，`test` / `coverage` 是活体 app 上的另一套、不能替代）；`bridge` = 面向第三方 MCP 宿主的 stdio→HTTP 代理（上游 CLI 无 `--http`/`--port`，HTTP 端点在 victauri app 进程内，本插件已有 REST 主通道直连同款工具，工具调用面与 bridge 所代理的同一套工具等价），在本通道仅作诊断性短时使用、拿不到 stdio 交互会话（跨 app 重启是**重建**后端会话，不是会话存活）；子命令提示按探测到的 CLI 版本门控（`doctor` 恒定提示**不提供** `--json`：0.8.8 实测报 unexpected argument，0.10.3 源码亦无该选项）。
- **CLI 探测（1 个）**——`victauri_cli_status`：探测本机 `victauri` CLI 可用性（版本号 + 实际命中路径 + 子命令口径）；CLI 未安装时返回 `status=not_found` 并附安装指引（scoop / mise / cargo install victauri），结果缓存 60s（`refresh=true` 强制重探）。命中路径取 **PATH 顺序下第一个实际命中**的可执行文件（可能与 `where.exe victauri` 首条不同，均为有效安装位置）。
- **工具发现（1 个）**——`victauri_tools_list`：只读查询服务端当前实际工具面（`GET /api/tools`），并把服务端清单与插件静态暴露面的**双向差异**以 `warnings` 告警呈现（`not_exposed`=服务端有而插件没暴露；`missing_on_server`=插件暴露而服务端没有），告警只提示不阻断；工具面保持静态注册，服务端新增工具不会自动变成 dsh 工具（详见 [docs/TOOLS.md](docs/TOOLS.md)「工具发现」）。
- **桥接体检（1 个）**——`victauri_doctor`：只读体检，一条命令回答「这个工作区现在能不能用本插件开发调试 Tauri 应用」（详见下节）。

工具详情、必填参数与 compound `action` 枚举表见 [docs/TOOLS.md](docs/TOOLS.md)。

## 桥接体检（victauri_doctor）

`victauri_doctor` 是**只读体检工具**：不调用任何上游工具、不写任何文件，**永不抛错**（任何异常都折进报告的检查项）。它把「开发 Tauri 项目时自动启用验证」这件事收敛成一次调用，六项检查：

| 检查项          | 判定口径                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`     | 工作区有 `tauri.conf.json`（查 `src-tauri/` 与根目录两处布局）→ 是 Tauri 项目                                                       |
| `dependency`    | `Cargo.toml` 声明 `victauri-plugin` 依赖、`[features]` 定义 `victauri` 特征、`default` 是否启用该特征                               |
| `live-instance` | 本机 discovery 目录里的实例**逐个探活**（带 Bearer 的 `GET /info`，单实例 2s 预算）；区分「无任何目录」与「有目录全死（退出残留）」 |
| `tool-face`     | 服务端 `GET /api/tools` 清单与插件静态暴露面比对（复用 `victauri_tools_list` 的差异算法）                                           |
| `debug-build`   | `src-tauri/target/debug` 是否已有构建产物（首次调试提醒先构建）                                                                     |
| `cli`           | 本机 `victauri` CLI 可用性（不可用时附安装指引；不影响 REST 工具面）                                                                |

- **参数**：`workspace`（Tauri 项目根的绝对路径；缺省取宿主进程 cwd）、`identifier`（按 bundle id 过滤实例，选填）、`probe_timeout_ms`（单实例探活预算，缺省 2000）。
- **沿用插件配置**：体检工具在宿主侧注册时会继承插件设置——`cliPath` 作为 CLI 探测目标、`appIdentifier` 作为实例过滤范围（工具入参优先）。
- **结论**：`verdict` = `ready`（全过）/ `partial`（有 warn 无 fail）/ `blocked`（有 fail）；`checks[]` 给逐项结论，`summary` 给一句话汇总。
- **短路规则**：不是 Tauri 项目时 `dependency` / `live-instance` / `tool-face` / `debug-build` 直接 `skip`，`cli` 始终执行。
- **不外泄敏感物**：实例只报 `pid` / `version` / 产品名，**不报 port 与 token**；上游错误的 message 含 `http://127.0.0.1:<port>`，体检输出里一律替换为固定文案。

### 宿主前置条件（重要）

本插件**只声明 `tools` 与 `skills` 两个硬依赖**（`export const inject` 与 `cordis.patch.yml` 行级 `inject` 一致），**不声明 `webServer`**：cordis 的 inject 是硬依赖，任一 inject 服务未就绪，fiber 直接进入 `INACTIVE`，`apply` 根本不执行，**全部工具与 skill 会一起消失**。本插件没有 web 面、不注册任何 HTTP 路由，因此无需也不应引入 `webServer` 依赖。

### 端口与 token 的边界

- 插件**直连**上游 `http://127.0.0.1:<victauri 端口>`（REST 主通道的设计如此），token 只在宿主半区读取与使用，**不进入模型上下文、不进入工具返回值**。
- 插件**不注册**任何 HTTP 路由，也没有浏览器面板——不存在「同源路由」「页面直连上游端口」这类浏览器面问题。

## 行为约定

- **错误不抛栈**：连接失败 / HTTP 错误 / 工具执行失败统一返回结构化 `{error: {kind, message, hint}}`，`hint` 含自检指引（启动 app → `victauri check` → 跑 demo-app 验证链路）。
- **图像结果落盘**：`victauri_screenshot` / `victauri_trace`（frames）/ `victauri_animation`（scrub `capture=true`）的 base64 图像统一落盘 `%TEMP%\dsh-victauri\`，单图返回 `{path, mime_type, bytes}`，多帧返回 `paths[]`，不占模型上下文（详见 [docs/TOOLS.md](docs/TOOLS.md)「图像结果通道」）。
- **按工具差异化超时**：`victauri_wait_for` 请求预算 = `timeout_ms` + 5s 余量，`victauri_trace` / `victauri_introspect` 固定 90s 声明预算（上限 120s）；其余工具沿用 `requestTimeoutMs`（默认 30000）不变（详见 [docs/TOOLS.md](docs/TOOLS.md)「请求超时语义」）。
- **工具面差异告警**：服务端新增工具**不会**自动注册为 dsh 工具（工具面静态，避免 schema 契约漂移）；用 `victauri_tools_list` 查差异，`not_exposed` 说明插件版本落后于服务端，需升级插件后才能调用新工具。
- **别名兼容**：`victauri_eval_js`（`code`/`expression`）与 `victauri_query_db`（`query`/`sql`）双命名兼容，以实测名优先；别名键不透传服务端。
- **后端日志三段式（0.10.2 起）**：`victauri_invoke_command` 传 `with_logs=true` 拿 `backend_log_cursor` → `victauri_wait_for` 传 `condition:'log'` + `since_seq:<cursor>` 阻塞到匹配的后端行（`level` / `fields` 过滤，匹配脱敏后文本）→ `victauri_logs` `action='backend_digest'` 摘要盘点；`since_seq` 为向前分页游标（返回游标之后最旧的条目）。
- **任意 JSON 值参数**：`victauri_assert_semantic` / `victauri_wait_for` 的 `expected` 与 `victauri_storage` 的 `value` 接受任意 JSON 值（数值/对象/数组/布尔/`null`），透传时**不字符串化**（详见 [docs/TOOLS.md](docs/TOOLS.md)「任意 JSON 值参数」）。
- **元素查找 0.10.3 新参**：`victauri_find_elements` 支持 `title_attr` / `attribute` / `attribute_value` / `text_exact` / `include_hidden`（true 才返回隐藏元素）；同版本起可访问名与 visible/enabled 为诚实计算值。
- **数组包装**：顶层数组结果包装为 `{items: [...]}`（dsh 工具契约要求顶层 object）；上游 victauri 的 `logs` 部分动作返回的是裸数组（bare array），读结果先取 `items`（详见 [docs/TOOLS.md](docs/TOOLS.md)「数组结果的形状」）。
- **版本兼容**：参数 schema 以 victauri 0.10.3（官方文档 + CHANGELOG）为基线，与 0.8.8（本机桥实测）及 0.10.2（cargo registry 源码）双源核对对齐，字段级差异在工具 description 内以 `[实测]` / `[文档]` / `[源码]` / `[桥]` 标注。

## 故障排查

| 现象                                      | 处置                                                                                                                                                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具返回 `no-live-instance`               | Tauri app 未启动或未接入 victauri-plugin：以 **debug 构建**启动 app（release 构建的 victauri 桥是 no-op）并确认 `Builder.plugin(victauri_plugin::init())` 已接入                                                                                                |
| 工具返回 `no-instance`                    | discovery 目录无记录：确认 app 以 victauri-plugin 启动过；多实例/多 app 时配置 `appIdentifier` 或 `portOverride` 收敛目标                                                                                                                                       |
| `auth`（401/403）/ `http-error`           | token 失效（app 重启后 discovery 更新）或实例退出：auth(401/403)、网络层失败与连接失败会**自动重置缓存**并在下次调用重新发现（读到新 token/port）；`invalid-params`(400)/`not-found`(404)/`rate-limited`(429)/5xx/超时/工具级失败不复位（服务在线，复位无意义） |
| `cli-error`（CLI 桥）                     | `victauri` CLI 不在 PATH：先跑 `victauri_cli_status` 看探测结论；再配置 `cliPath` 指向可执行文件或按提示 `scoop install victauri` / `mise install victauri` / `cargo install victauri`                                                                          |
| 注册的工具偏多                            | 配置 `disabledTools` 列出不需要的工具全名                                                                                                                                                                                                                       |
| `victauri_doctor` 报 `workspace` fail     | 传的工作区不是 Tauri 项目根：把 `workspace` 指向含 `src-tauri/tauri.conf.json`（或根 `tauri.conf.json`）的目录重试                                                                                                                                              |
| `victauri_doctor` 报 `dependency` fail    | `Cargo.toml` 没声明 `victauri-plugin`：先接入 victauri 插件（`Builder.plugin(victauri_plugin::init())`），可选依赖还需在 `[features]` 定义并默认启用 `victauri` 特征                                                                                            |
| `victauri_doctor` 报 `live-instance` warn | 无任何目录 = 应用还没以 victauri-plugin 启动过；有目录全死 = 退出进程的残留，请重新启动 app                                                                                                                                                                     |
| 39 个工具全部消失                         | 插件整体没装载（不是单个工具失败）：确认 `src/index.ts` 的 `export const inject` 与 `cordis.patch.yml` 的行级 `inject` **都只声明** `tools` 与 `skills`——cordis 的 inject 是硬依赖，见上「宿主前置条件」                                                        |

## 开发

本插件收录在 dsh-plugins-workspace pnpm monorepo（`packages/dsh-victauri`）；lint / format / test
由仓库根统一执行，包级命令用 `--filter` 定向：

```sh
pnpm install                                        # 根安装（子包 prepare 自动构建 dist）
pnpm --filter @zhidal/dsh-victauri build            # esbuild 产出 dist/index.js + tsc 产出类型声明 + 剪掉内部声明（只留公开 .d.ts）
                                                    # 注：源码若出现 /// <reference path|types=...>，构建会失败——tsc 的声明 emit 会丢弃
                                                    #     该指令，产出的 .d.ts 会留下消费者解析不到的悬空类型名（须改用显式 import type）
pnpm --filter @zhidal/dsh-victauri typecheck        # tsc --noEmit（仅本包）
pnpm --filter @zhidal/dsh-victauri smoke            # demo-app 本地冒烟（半自动 e2e，见下）
pnpm typecheck && pnpm lint && pnpm test            # 仓库根统一门禁（typecheck 递归全部子包；vitest 全仓发现 src/**/*.test.ts）
```

内置 e2e demo Tauri app 见 [demo-app/](demo-app/)（开发测试链路用，不进 CI）。

> 插件**没有浏览器半区**：不发布 `./client` 入口、不注册右栏页签、不注册任何 HTTP 路由，
> 因此也没有 `client/index.js` 之类的浏览器产物需要排除。

### 本地冒烟（`pnpm smoke`）

`pnpm smoke` 一条命令跑完 demo-app 的半自动 e2e：构建 demo-app（`cargo build --features victauri`）
→ 启动 → 轮询 discovery 就绪 → 经 REST 主通道冒烟 10 项检查 → PASS/FAIL 摘要 → 结束进程树。
覆盖 6 个核心工具（`get_plugin_info` / `app_info` / `eval_js` / `dom_snapshot` / `invoke_command` / `logs`）
与 `/health`、`/info`、`/api/tools` 三个端点，含「无 token → 401」认证闸门检查。

- **边界：不进 CI**。需要 Rust 工具链（cargo）、会真的拉起一个 Tauri 窗口，并依赖本机
  `%TEMP%\victauri` discovery 目录——与 [demo-app/README.md](demo-app/README.md) 的现状决策一致。
- 退出码：`0` 全部通过 / `1` 有检查失败 / `2` 前置条件或环境不满足。
- 可调环境变量：`SMOKE_SKIP_BUILD=1`（跳过构建）、`SMOKE_BUILD_TIMEOUT_MS`（默认 600000）、
  `SMOKE_DISCOVERY_TIMEOUT_MS`（默认 60000）、`SMOKE_REQUEST_TIMEOUT_MS`（默认 20000）、
  `SMOKE_SELFTEST=1`（追加一项故意失败的检查，用于验证失败路径退出码）。
- 端口顺延：脚本从 discovery 的 `port` 文件读实际端口（默认 7373，被占时服务端顺延到下一个空闲端口，
  如 7374），不硬编码端口。

发布相关见 [docs/release.md](docs/release.md)：本包沿用 workspace 统一发布体系——
Changesets 管版本与 CHANGELOG，git tag 形如 `dsh-victauri-vX.Y.Z`（短包名-vX.Y.Z），由仓库根
`.github/workflows/release.yml`（`*-v*` tag 触发）执行 OIDC 暂存发布（仅公开包正式版；
tag 必须打在 main 可达的提交上）。

## License

MIT © lzhida
