# dsh-open-design

用 dsh 插件系统封装 **Open Design** 的 MCP 能力：插件启动时自动探测本机的 Open Design 安装环境并自动配置 MCP 连接，把 Open Design 的 MCP 工具桥接成 dsh 工具（`mcp__open-design__*`），并额外提供 **2 个诊断工具**。

工具数口径（代码注释 / 本文档 / 详情文档 / 契约测试四处一致）：

- **上游 MCP 工具**：数量随 Open Design 版本浮动，0.27.2 基线为 **22 个**（`UPSTREAM_TOOL_COUNT_BASELINE`）；
- **插件自带诊断工具**：固定 **2 个诊断工具**（`open_design_status` / `open_design_redetect`）。

## 它解决什么

Open Design 官方把 MCP 注册写进各编辑器/客户端的配置里（如 Zed 的 `context_servers`、Claude Code 的 `mcpServers`）。这些配置是**静态快照**：Open Design 升级、换安装目录、命名空间（namespace）变更后就会失灵，需要人工重新复制一遍。

本插件把这段「复制粘贴」自动化：

1. **自动探测**——启动时按已确证的部署语义维度（channel / namespace / source / mode / app）推算命名管道端点，并与系统里实际存在的管道比对；推算不出时回落到扫描运行中的 Open Design 进程命令行。
2. **自动配置**——把探测结果落成一份完整可用的 MCP 连接参数（可执行文件、守护脚本、管道端点、数据目录、bootstrap 参数）。
3. **可手动改**——bundle 配置卡直接暴露 `source` / `command` / `args` / `env` 等参数，改完即时生效（下次工具调用前自动重算并按需重建连接）。
4. **自带配置目录**——生效配置持久化在 `~/.dsh/plugins/dsh-open-design/config.json`，不依赖宿主的 volatile 配置落盘。

## 安装

```sh
pnpm dsh plugin --profile test add link:<仓库绝对路径>/plugins/dsh-open-design
```

不带 profile 的通用写法：

```sh
pnpm dsh plugin add link:<仓库绝对路径>/plugins/dsh-open-design
```

> `--profile` 必须放在 `plugin` 之后，`link:` 后面必须是绝对路径。
>
> ⚠️ 本插件以 TypeScript 源码形态发布（`main` 指向 `src/index.ts`），**只支持
> `link:` 源码直载**。git / npm / tarball 实体安装会把包落进 profile 的
> node_modules，Node 拒绝对其下的 `.ts` 入口做 type-stripping
> （`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），宿主只会静默报
> `failed to import`。

## 配置卡字段

| 字段                | 类型     | 默认           | 说明                                                                                                                                                  |
| ------------------- | -------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoDetect`        | boolean  | `true`         | 启动时是否自动探测安装环境                                                                                                                            |
| `source`            | string   | `custom`       | 连接来源标识（仅随配置记录展示，不参与连接行为）                                                                                                      |
| `serverName`        | string   | `open-design`  | MCP 服务名，用作工具命名空间前缀                                                                                                                      |
| `command`           | string   | 空（自动探测） | Open Design 可执行文件绝对路径                                                                                                                        |
| `args`              | string[] | 空（自动探测） | 传给可执行文件的参数，探测填充为 `[daemon-cli.mjs, "mcp"]`                                                                                            |
| `env`               | object   | 空（自动探测） | 子进程环境变量，探测填充 `OD_DATA_DIR` / `OD_SIDECAR_CLIENT_ENDPOINT` / `OD_MCP_BOOTSTRAP_COMMAND` / `OD_MCP_BOOTSTRAP_ARGS` / `ELECTRON_RUN_AS_NODE` |
| `cwd`               | string   | 空             | 子进程工作目录                                                                                                                                        |
| `startupTimeoutMs`  | number   | `120000`       | 等待 MCP 服务启动的毫秒数（改动即时生效，不重建子进程）                                                                                               |
| `toolCallTimeoutMs` | number   | `60000`        | 单次工具调用超时毫秒数（改动即时生效，不重建子进程）                                                                                                  |

配置卡字段是 volatile 的：面板改动即时生效但不写入宿主 profile，跨会话的保留由本插件自己的 `config.json` 负责。宿主在交付配置前会按 schema 补齐默认值，所以「字段非空」不等于「用户改过」——插件只把**与默认值不同**的字段视为显式设置。

## 配置文件

```
~/.dsh/plugins/dsh-open-design/config.json
```

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-20T12:00:00.000Z",
  "autoDetect": true,
  "connection": {
    "source": "custom",
    "serverName": "open-design",
    "command": "...",
    "args": [],
    "env": {},
    "cwd": "",
    "startupTimeoutMs": 120000,
    "toolCallTimeoutMs": 60000
  },
  "overrides": {
    "command": "C:\\Program Files\\Open Design\\Open Design.exe"
  },
  "baseline": {
    "command": "C:\\Program Files\\Open Design\\Open Design.exe"
  },
  "detected": {
    "method": "pipe",
    "stamp": {},
    "endpoint": "...",
    "installDir": "...",
    "dataDir": "...",
    "daemonCliPath": "..."
  }
}
```

`overrides` 记录用户在配置卡上显式改过的字段（含「显式改回默认值」这种清空操作——把卡面改回默认值即删除该字段的覆盖意图，回落探测/默认语义）。`baseline` 是插件看到的配置卡基线快照：配置卡是 volatile 的（不落宿主 profile），基线随本文件持久化后，**跨会话**的「卡面 vs 基线」差分同样成立——新会话把卡面改回默认值，也能清除上一会话的覆盖意图。

生效配置的优先级（自高而低）：

1. `overrides`——用户显式覆盖过的字段（改回默认值即失效回落）；
2. 配置卡的显式值（与 schema 默认值不同才算显式）；
3. 探测填充（自动检测 Open Design 安装环境的结果）。

文档里的 `connection` 段是**上次生效配置的快照**（供人工核对，改配置以配置卡为准）；用户意图只看 `overrides` 段。每次覆盖写入前，旧文件会自动备份为 `config.json.bak`，手改失误时有退路。

## 管道端点是怎么算出来的

Open Design 的 sidecar 用五元组描述部署语义：

```
channel / namespace / source / mode / app
```

Windows 命名管道名 = `\\.\pipe\open-design-sidecar-` + `sha256(用户名 + "\n" + "channel=…\nnamespace=…\nsource=…\nmode=…\napp=…")` 的前 32 位十六进制。

MCP 客户端对应的组合固定为 `source=packaged` / `mode=runtime` / `app=daemon`；`channel` 与 `namespace` 随安装渠道与版本变化，因此插件从 `%APPDATA%\Open Design\namespaces\` 的实际目录名反推。

## 诊断工具

- `open_design_status`——连接状态、当前配置来源、探测方式、已注册/被跳过的上游工具、配置文件路径。
- `open_design_redetect`——重跑探测并按新结果刷新连接与工具。

上游个别工具的参数 schema 若超出宿主支持的 JSON Schema 子集，会在工具同步时被**跳过**（日志打 `[dsh-open-design] 跳过上游工具 "X"：<原因>`，其余工具照常注册），可通过 `open_design_status` 的 `upstreamSkippedTools` 查看。

## 故障排查

| 现象                                                                         | 原因                                            | 处理                                                                  |
| ---------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------- |
| 日志 `探测失败`                                                              | 管道端点推算不出且没有运行中的 Open Design 进程 | 打开 Open Design 应用后用 `open_design_redetect` 重探测               |
| MCP 连接超时                                                                 | Open Design 未运行且 bootstrap 失败             | 确认 `OD_MCP_BOOTSTRAP_COMMAND` 指向真实安装路径                      |
| 上游报「The Open Design MCP registration is missing its runtime connection」 | Open Design 未生成/已失效的 MCP 运行时注册      | 打开 Open Design 桌面应用并刷新其 MCP 注册，再 `open_design_redetect` |
| 工具列表为空                                                                 | 上游 `tools/list` 返回空                        | 用 `open_design_status` 看连接状态与配置来源                          |
| 个别工具缺失                                                                 | 上游工具 schema 超出宿主支持子集被跳过          | 看 `open_design_status` 的 `upstreamSkippedTools` 与插件日志          |
| 管道端点失效                                                                 | Open Design 升级换了 namespace                  | 清空 `command`/`args`/`env` 后重新探测                                |

## 开发

```sh
pnpm --filter @zhidal/dsh-open-design typecheck
pnpm vitest run plugins/dsh-open-design/src
pnpm lint
pnpm format:check
```

插件日志一律带 `[dsh-open-design] ` 前缀，宿主据此识别本插件的日志行（如 `[dsh-open-design] plugin loaded`、`[dsh-open-design] registered 2 diagnostic tools`）。

更多原理、探测算法、配置优先级与故障排查细节见 [`docs/DETAIL.md`](docs/DETAIL.md)。
