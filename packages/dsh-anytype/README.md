# @lzhida/dsh-anytype

把 **Anytype v2 本地 API**（Anytype 桌面应用内置，官方 [`@anyproto/anytype-mcp`](https://github.com/anyproto/anytype-mcp) 的后端）封装为一组 dsh 原生工具（`defineTool`），让 dsh 会话里的 agent 直接读写你的 Anytype 知识库。

与「配置 dsh-mcp-client 桥接官方 MCP 子进程」相比：无 `npx -y` 子进程与网络下载、工具名/参数为 agent 手工设计、API key 走 dsh 设置面板（volatile 保存即生效）。

## 前置条件

1. **任一后端在运行**：Anytype 桌面应用（本地 API 默认 `http://127.0.0.1:31009`）或 [anytype-cli](https://github.com/anyproto/anytype-cli)（默认 `http://127.0.0.1:31012`，headless 独立 bot 账户数据面）；
2. 对应后端的 API key：桌面端在 App Settings → API Keys → `Create new`；CLI 用 `anytype auth apikey create <name> --all-spaces --read-write`（v2 需 scoped key）；
3. dsh 组合中存在 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt` 提供方（web/base bundle 自带），否则插件停在 PENDING。

## 安装（开发态）

```sh
pnpm dsh plugin --profile <profile> add link:<仓库绝对路径>/packages/dsh-anytype
```

纯 TS 源码入口（`main: src/index.ts`），仅支持 `link:` 安装；实体安装（npm/git）需先按 `dsh-llm-fallback` 模式加 esbuild dist。

## 双后端模型

|          | 桌面端（desktop）                          | anytype-cli（cli）                                                                                               |
| -------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| API 地址 | `http://127.0.0.1:31009`                   | `http://127.0.0.1:31012`                                                                                         |
| 账户     | 用户主账户，实时本地库                     | **独立 bot 账户**（`anytype auth create`，不支持 mnemonic 登录），仅访问被邀请加入的 space，数据经 any-sync 同步 |
| key 来源 | 桌面应用 API Keys                          | `anytype auth apikey create`（与桌面端 key **互不通用**）                                                        |
| 启动方式 | **自行打开桌面应用**（插件只检测，不拉起） | `anytype service install` + `service start`（或 `cliAutoStart` 允许插件 start）                                  |

`backend: auto`（默认）桌面端优先；**仅网络层不可达**且 CLI 已配置（`cliKey` 非空）才切换——鉴权失败不切换（换后端 = 换账户数据面）。每个工具结果携带 `backend` 字段标明实际数据面。

**桌面端纯检测**：插件不会尝试启动桌面应用（实测从其他进程上下文启动 Anytype.exe 会立即退出，不可靠）；桌面端不可达时切 CLI 或报可操作错误。

**CLI 回退的前提（一次性 bot 初始化，可在会话里用工具完成大半）**：

1. 安装 anytype-cli 并把可执行文件路径填进 `cliPath`；
2. 会话里调 `anytype_cli_create`（账户名取自 `cliAccountName`）——创建 bot 账户（真实副作用：本机数据目录 + 系统 keyring）；
3. 在桌面应用里把 bot 邀请进目标 space（邀请链接走 `anytype space join`，涉密不进插件）；
4. 用 `anytype auth apikey create <name> --all-spaces --read-write` 签发 key 并填进 `cliKey`；
5. 此后桌面端关闭时，`cliAutoStart: true` 会自动拉起：`service start` 优先，服务管理器不支持/失败回退 detached `anytype serve`。

未配置 `cliKey` 时，桌面端不可达 = 无可用后端（不会启动一个没有可用 key 的 CLI 服务）。

**安全边界**：`cliAutoStart` 只做最小拉起（`service start` / detached `serve`）；`anytype_cli_login` 的账户 key 经 **stdin** 传入（不进命令行、不进会话轨迹）；插件绝不代为安装 CLI、签发密钥或加入 space——那些是用户主权动作。被拉起的进程独立存活，插件卸载不终止。

**CLI 内嵌 MCP（补充路径）**：anytype-cli 的 HTTP API 自带 `/mcp/full`（streamable HTTP，同一 api key）——如需原生 MCP 接入可把 dsh-mcp-client 指向它；本插件仍是精排工具路径。

## 配置（Settings → Plugins → dsh-anytype）

| 字段               | 默认                     | 说明                                                                                       |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| `enabled`          | `true`                   | 总开关；关闭后不注册任何工具（指引 section 保留）                                          |
| `backend`          | `auto`                   | 后端选择：auto / desktop / cli                                                             |
| `baseUrl`          | `http://127.0.0.1:31009` | **桌面端**本地 API 地址                                                                    |
| `apiKey`           | `''`                     | **桌面端** Bearer 密钥；执行时实时读取，改动即时生效                                       |
| `cliUrl`           | `http://127.0.0.1:31012` | **CLI 后端**本地 API 地址                                                                  |
| `cliKey`           | `''`                     | **CLI 后端** bot 密钥（空 = CLI 后端未配置）                                               |
| `cliPath`          | `anytype`                | anytype-cli 可执行文件名或绝对路径                                                         |
| `cliAutoStart`     | `false`                  | CLI 不可达时拉起：`service start` 优先，服务管理器不支持/失败回退 detached `anytype serve` |
| `cliAccountKey`    | `''`                     | bot 账户 key（`anytype_cli_login` 用；经 stdin 传入，不进命令行/轨迹）                     |
| `cliAccountName`   | `''`                     | `anytype_cli_create` 的账户名（空 = create 报可操作错误）                                  |
| `cliNetworkConfig` | `''`                     | 自建网络配置 YAML 路径（login/create 的 `--network-config`）                               |
| `cliRootPath`      | `''`                     | 账户数据根路径；仅 CLI 交互模式支持，机读模式暂不生效（保留字段）                          |
| `cliListenAddress` | `127.0.0.1:31012`        | login/create/serve 共用的 JSON API 监听地址                                                |
| `apiVersion`       | `2025-11-08`             | `Anytype-Version` 请求头                                                                   |
| `disabledGroups`   | `[]`                     | 按组停用工具（改动后需重载插件）                                                           |
| `requestTimeoutMs` | `30000`                  | 单请求超时                                                                                 |
| `maxResponseChars` | `20000`                  | 工具结果截断上限（超限返回 `data_preview`）                                                |

## 工具清单（27 个，10 组）

| 组         | 工具                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| connection | `anytype_whoami`、`anytype_status`（双后端可达性/鉴权/CLI 服务状态/生效后端——连接问题诊断第一站）                                            |
| search     | `anytype_search`（全局/空间二合一）、`anytype_list_objects`                                                                                  |
| space      | `anytype_list_spaces` / `anytype_get_space` / `anytype_create_space` / `anytype_update_space`                                                |
| object     | `anytype_get_object` / `anytype_create_object`（shortcut body）/ `anytype_update_object`（ops）/ `anytype_delete_object`                     |
| collection | `anytype_create_collection` / `anytype_list_collection_objects`                                                                              |
| type       | `anytype_list_types` / `anytype_get_type` / `anytype_create_type` / `anytype_update_type` / `anytype_delete_type` / `anytype_list_templates` |
| property   | `anytype_list_properties` / `anytype_list_property_options`                                                                                  |
| member     | `anytype_list_members` / `anytype_get_member_me`                                                                                             |
| schema     | `anytype_get_schema` / `anytype_get_op_schema`（15 种编辑 op 的运行时 schema）                                                               |
| generic    | `anytype_request`（逃生舱：chats / files / widgets / queries / discussion / validate 等；仅放行 `/v2/`，拒绝 `/v2/auth/*`）                  |

设计要点：

- **v2 自描述编辑**：`anytype_update_object` 的 ops 与 AnyBlock 文档成员不硬编码，agent 用 `anytype_get_op_schema` / `anytype_get_schema` 运行时取真值；
- **乐观锁**：读工具回传 `etag`，写工具接受 `expected_etag`（映射 `If-Match`）——e2e 实测三次连续写入（4d33c8ca → 883c2064 → 09691893）无冲突；
- **只读并行**：读类工具声明 `isConcurrencySafe`，可与同批读调用并行调度；
- **错误可操作**：连接失败提示「Anytype 应用未运行？」；API 错误透传 `status + code + issues + hints`——实测模型能凭错误 hint 自行纠错重试。

实测踩坑点（已固化进工具描述/参数约束）：

- `anytype_get_object` 的 `format` 只接受 `md` / `anyblock`（已做成 enum），传 `markdown` 会 400；
- `insert_blocks` 的 `markdown` 字符串里换行必须是真实换行符——写成 `\n` 字面量会被并进同一段落；精确控制层级时改传 `blocks` 块数组。

## 测试

```sh
pnpm --filter @lzhida/dsh-anytype typecheck
pnpm exec vitest run packages/dsh-anytype
```

e2e（真实 dsh 实例 + 真实 Anytype）见 `.agents/skills/dsh-plugin-dev/SKILL.md` §5 四步流程；apiKey 经 test profile 的 `cordis.patch.yml` 注入（密钥不入库）。
