# Open Design 接入详情（dsh-open-design）

本文是 `dsh-open-design` 插件的详情文档：说明它如何在 dsh 里把 Open Design 的 MCP 能力接进来、配置从哪来、出了错怎么查。

## 一句话定位

在 dsh 里装好 Open Design 桌面端后，本插件**启动时自动探测一次安装环境**，把 Open Design 的 MCP 服务拉起来，并把上游工具桥接成 dsh 工具（命名空间 `mcp__open-design__*`）；同时在界面上提供配置卡（改 `source` / `command` / `args` / `env`）与 2 个诊断工具。

## 工作流程

```
插件装载
  └─ 读取 ~/.dsh/plugins/dsh-open-design/config.json（存在则复用探测结果与用户覆盖意图）
  └─ autoDetect ≠ false（按生效值判定）时执行一次探测（系列 3/6 的 detectOnce）
  └─ 三层优先级合并出最终连接参数（见下）
  └─ 把生效配置写回 config.json（schemaVersion 1，旧文件先备份为 .bak）
  └─ 以 stdio 方式拉起 Open Design MCP 子进程并握手
  └─ listTools → 桥接成 dsh 工具并注册（个别 schema 不受支持的工具被跳过并记录）
  └─ 注册 2 个诊断工具（open_design_status / open_design_redetect）
```

连接是异步的：探测要跑 PowerShell、子进程要握手，都不阻塞插件装载。**任何一步失败都不会让 dsh 实例启动失败**——最坏情况是「插件加载了但没有 MCP 工具」，此时用诊断工具排查。

配置卡是 volatile 的，宿主改动不重启插件：运行时在每次工具调用前做**懒刷新**——重读卡面、按「基线差分」把改动合并进 `overrides`（改回默认值即删除覆盖意图），配置变了才重建连接/换装工具。基线快照随 `config.json` 持久化（`baseline` 段），新会话启动时先用持久化基线做一轮差分，所以**跨会话**的显式清空同样成立。

## 配置优先级（三层）

| 层级 | 来源           | 说明                                                                                     |
| ---- | -------------- | ---------------------------------------------------------------------------------------- |
| 1    | `overrides` 段 | 用户显式覆盖过的字段（把卡面改回默认值 = 删除该覆盖，回落下层）                          |
| 2    | 配置卡显式值   | 与 schema 默认值**不同**才算显式——宿主会按 schema 补齐默认值，「非空」不等于「用户改过」 |
| 3    | 探测填充       | 本轮探测出的安装目录 / daemon 路径 / 管道端点拼出的默认连接参数                          |

`config.json` 的 `connection` 段是**上次生效配置的快照**（仅展示与核对），不参与合并；`baseline` 段是上次会话看到的配置卡基线（跨会话差分用）；用户意图只看 `overrides` 段。

## 探测算法

两级探测，都失败时降级为 `method='none'`（不抛错，界面提示用户手填）：

1. **管道枚举**：枚举 `\\.\pipe\` 下的 `open-design-sidecar-*`，用候选 stamp 集反推摘要比对。管道名算法（Open Design 侧 `sidecar` 包 `resolvePrivateIpcPath`）：

   ```
   digest  = sha256(`${用户名}\n${stampKey}`).hex.slice(0, 32)
   endpoint = \\.\pipe\open-design-sidecar-${digest}
   stampKey = channel=…\nnamespace=…\nsource=…\nmode=…\napp=…
   ```

   MCP 客户端目标是 `app=daemon` × `mode=runtime` 组合（桌面端自己跑 daemon 时复用它，不再另起 headless 进程）。

2. **进程命令行兜底**：`Get-CimInstance Win32_Process` 读 `Open Design.exe` 的 `--od-stamp-*` 参数，取 `app=daemon` 那条。

## 工具清单

- **上游 MCP 工具**：数量随 Open Design 版本浮动，Open Design 0.27.2 基线为 **22 个**（代码常量 `UPSTREAM_TOOL_COUNT_BASELINE`）。
- **插件自带诊断工具**：固定 **2 个**——`open_design_status`（连接状态 / 生效配置 / 探测方式 / 工具数）与 `open_design_redetect`（重跑探测并回填 `config.json`）。

工具数口径在代码头注释、README.md、本文件与包级契约测试四处保持一致。

## 配置卡字段

| 字段                | 默认值        | 说明                                                                                                                                                    |
| ------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoDetect`        | `true`        | 启动时是否自动探测安装环境                                                                                                                              |
| `source`            | `custom`      | 连接来源标识（与上游注册语义一致）                                                                                                                      |
| `serverName`        | `open-design` | 工具命名空间前缀，最终工具名为 `mcp__<serverName>__<tool>`                                                                                              |
| `command`           | 空            | MCP 子进程可执行文件路径（探测填充为 `<安装目录>\Open Design.exe`）                                                                                     |
| `args`              | `[]`          | 子进程参数（探测填充为 `[<daemon-cli.mjs>, "mcp"]`）                                                                                                    |
| `env`               | `{}`          | 子进程环境变量（探测填充 `OD_DATA_DIR` / `OD_SIDECAR_CLIENT_ENDPOINT` / `OD_MCP_BOOTSTRAP_COMMAND` / `OD_MCP_BOOTSTRAP_ARGS` / `ELECTRON_RUN_AS_NODE`） |
| `cwd`               | 空            | 子进程工作目录                                                                                                                                          |
| `startupTimeoutMs`  | `120000`      | 子进程启动与握手超时                                                                                                                                    |
| `toolCallTimeoutMs` | `60000`       | 单次工具调用超时                                                                                                                                        |

> 配置卡字段是 volatile 的：**宿主不把它们写进 profile 持久化配置**。本插件在每次解析生效配置后写回 `~/.dsh/plugins/dsh-open-design/config.json`，所以改动跨会话保留。

## 配置文件

路径：`~/.dsh/plugins/dsh-open-design/config.json`（`DSH_HOME` 优先于 `~/.dsh`）。

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-20T12:00:00.000Z",
  "autoDetect": true,
  "connection": {
    "source": "custom",
    "serverName": "open-design",
    "command": "E:\\Programs\\Open Design\\Open Design.exe",
    "args": [
      "E:\\Programs\\Open Design\\resources\\app\\prebundled\\daemon\\daemon-cli.mjs",
      "mcp"
    ],
    "env": {
      "OD_DATA_DIR": "…",
      "OD_SIDECAR_CLIENT_ENDPOINT": "\\\\.\\pipe\\open-design-sidecar-…",
      "OD_MCP_BOOTSTRAP_COMMAND": "…",
      "OD_MCP_BOOTSTRAP_ARGS": "[\"--headless\"]",
      "ELECTRON_RUN_AS_NODE": "1"
    },
    "cwd": "",
    "startupTimeoutMs": 120000,
    "toolCallTimeoutMs": 60000
  },
  "overrides": {},
  "baseline": {},
  "detected": {
    "method": "pipe",
    "stamp": {
      "channel": "stable",
      "namespace": "release-stable-win",
      "source": "packaged",
      "mode": "runtime",
      "app": "daemon"
    },
    "endpoint": "\\\\.\\pipe\\open-design-sidecar-…",
    "installDir": "E:\\Programs\\Open Design",
    "dataDir": "…",
    "daemonCliPath": "…"
  }
}
```

## 故障排查

| 现象                                                                         | 可能原因                                          | 处理                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------- |
| 日志停在「正在检测 Open Design 安装环境…」                                   | 管道枚举或 PowerShell 兜底都失败                  | 看 `open_design_status` 的 `detectionMethod`；`none` 说明没装或没开桌面端    |
| 没有 `mcp__open-design__*` 工具                                              | MCP 子进程没起来或握手超时                        | 看 `open_design_status` 的 `connectionState` / `lastError`；确认桌面端已启动 |
| 上游报「The Open Design MCP registration is missing its runtime connection」 | Open Design 的 MCP 运行时注册缺失/失效            | 打开 Open Design 桌面应用并刷新其 MCP 注册，再 `open_design_redetect`        |
| 管道端点失效（管道消失）                                                     | Open Design 升级换了 stamp 语义或重启换了安装目录 | 跑 `open_design_redetect` 重新探测                                           |
| 个别工具缺失                                                                 | 上游工具 schema 超出宿主支持的 JSON Schema 子集   | 看 `open_design_status` 的 `upstreamSkippedTools` 与插件日志                 |
| 改了配置卡不生效                                                             | 值与默认相同被视作「未显式」，或连接指纹未变      | 改一个与默认值不同的值；日志里应出现「已注册 N 个 Open Design 工具」         |
| 桌面端没开                                                                   | 探测能拿到安装目录，但连不上 daemon               | 先启动 Open Design 桌面端再跑 `open_design_redetect`                         |

## 已知限制

- 上游返回的**图片 / 音频 / resource 块只输出占位文案**，暂不投影成附件（宿主 `dsh-mcp-client` 的图片投影未在本插件复刻）。
- 管道探测的候选集合覆盖 `channel=stable|release-stable` 与本机 `namespaces` 子目录；换通道会落到进程命令行兜底。
- `config.json` 的 `schemaVersion` 高于当前实现时会被整份丢弃（防止旧插件读错新格式）。
- 上游个别工具的参数 schema 若超出宿主支持的 JSON Schema 子集，会在同步时被跳过（不阻断其余工具），名单见 `open_design_status` 的 `upstreamSkippedTools`。
- 超时类配置（`startupTimeoutMs` / `toolCallTimeoutMs`）改动即时生效但不重建子进程；`command` / `args` / `env` / `cwd` 变化会按配置指纹重建子进程；`serverName` 变化会换装工具命名空间。
- 极少数情况下（宿主工具注册面自身故障），桥接换装可能在「注销旧工具 → 注册新工具」之间失败，窗口内上游工具面为空；下次同步成功即自愈，可用 `open_design_redetect` 主动触发。
- 本插件以 TS 源码形态发布，只支持 `link:` 安装（实体安装会因 Node 拒绝 type-stripping 而静默加载失败）。
