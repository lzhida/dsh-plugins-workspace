# 工具清单（口径：35 victauri 工具 + 1 CLI 桥 + 1 CLI 探测 + 1 工具发现 + 1 桥接体检 = 39 dsh 工具）

> 本文件与 README「工具清单」小节、`src/tools/standalone/catalog.ts` 头注释、
> `src/tools/contract.test.ts` 契约测试共用同一口径：
> **Victauri 全量 35 个工具**（standalone 20 + compound 15）+ **1 个 CLI 桥工具**
>
> - **1 个 CLI 探测工具**。
> - **1 个工具发现工具**（`victauri_tools_list`，只读查询服务端工具面）。
> - **1 个桥接体检工具**（`victauri_doctor`，只读体检，不调上游工具）。
>
> 参数 schema 以 Victauri 0.10.3 官方 tools-reference 文档 + CHANGELOG 为基线，
> 与本机 0.8.8 实测及 0.10.2（cargo registry 源码）三源核对对齐，
> 每个工具 description 内以 `[实测]` / `[文档]` / `[源码]` / `[桥]` 标注字段来源。

## standalone 批（20 个，victauri 名 1:1 映射 dsh `victauri_<name>`）

| #   | 工具                             | 用途                                                          | 必填参数                                    |
| --- | -------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| 1   | `victauri_app_info`              | 应用信息（config/databases/env/paths/process）                | —                                           |
| 2   | `victauri_app_state`             | 注册 probe 的后端状态快照                                     | —                                           |
| 3   | `victauri_assert_semantic`       | 语义断言（evaluate + condition 校验）                         | `expression`、`condition`                   |
| 4   | `victauri_check_ipc_integrity`   | IPC 完整性（stale/errored call）                              | —                                           |
| 5   | `victauri_detect_ghost_commands` | 幽灵命令检测（无 handler 的调用）                             | —                                           |
| 6   | `victauri_dom_snapshot`          | DOM 快照（compact/json + stale refs）                         | —                                           |
| 7   | `victauri_eval_js`               | webview 内求值 JS                                             | `code`（别名 `expression` 兼容）            |
| 8   | `victauri_find_elements`         | 按 text/role/selector 搜元素                                  | —                                           |
| 9   | `victauri_get_diagnostics`       | 环境诊断（service worker/iframe/CSP）                         | —                                           |
| 10  | `victauri_get_memory_stats`      | OS 级进程内存统计                                             | —                                           |
| 11  | `victauri_get_plugin_info`       | Victauri 插件配置/端口/命令清单                               | —                                           |
| 12  | `victauri_get_registry`          | 注册命令目录（可按名过滤）                                    | —                                           |
| 13  | `victauri_invoke_command`        | 经 IPC 调用 Tauri 命令                                        | `command`                                   |
| 14  | `victauri_list_app_dir`          | 列应用数据/配置/日志目录                                      | —                                           |
| 15  | `victauri_query_db`              | 只读 SQL 查询 SQLite                                          | `query`（别名 `sql`，上游正式 serde alias） |
| 16  | `victauri_read_app_file`         | 读应用目录文件（text/base64）                                 | `path`                                      |
| 17  | `victauri_resolve_command`       | 自然语言匹配命令                                              | `query`                                     |
| 18  | `victauri_screenshot`            | 窗口截图（通用图像通道落盘返回路径）                          | —                                           |
| 19  | `victauri_verify_state`          | 前后端状态比对                                                | `frontend_expr`                             |
| 20  | `victauri_wait_for`              | 轮询等待条件（10 值闭集，见下文「后端日志与 0.10.x 新参数」） | `condition`                                 |

## compound 批（15 个，`action` 参数选择子动作）

| 工具                  | action 枚举（必填）                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `victauri_animation`  | `list` `scrub` `sample`（0.10.3 基线三动作；`clear` 已废弃，清空录制改经 `sample` 的 `clear:true` 参数）                                                                                                                               |
| `victauri_css`        | `inject` `remove`                                                                                                                                                                                                                      |
| `victauri_explain`    | `summary` `last_action` `diff`                                                                                                                                                                                                         |
| `victauri_fault`      | `inject` `list` `clear` `clear_all`                                                                                                                                                                                                    |
| `victauri_input`      | `fill` `type_text` `press_key`                                                                                                                                                                                                         |
| `victauri_inspect`    | `get_styles` `get_bounding_boxes` `highlight` `clear_highlights` `audit_accessibility` `get_performance`                                                                                                                               |
| `victauri_interact`   | `click` `double_click` `hover` `focus` `scroll_into_view` `select_option`                                                                                                                                                              |
| `victauri_introspect` | `command_timings` `coverage` `command_catalog` `contract_record` `contract_check` `contract_list` `contract_clear` `startup_timing` `capabilities` `db_health` `plugin_state` `processes` `plugin_tasks` `event_bus` `event_bus_clear` |
| `victauri_logs`       | `console` `network` `ipc` `navigation` `dialogs` `events` `slow_ipc` `clear` `backend` `backend_digest` `stdout`（后三个为 0.10.2 起的后端日志动作）                                                                                   |
| `victauri_navigate`   | `go_to` `go_back` `get_history` `set_dialog_response` `get_dialog_log`                                                                                                                                                                 |
| `victauri_recording`  | `start` `stop` `checkpoint` `list_checkpoints` `get_events` `events_between` `get_replay` `export` `import` `replay` `flush`                                                                                                           |
| `victauri_route`      | `add` `list` `clear` `clear_all` `matches`                                                                                                                                                                                             |
| `victauri_storage`    | `get` `set` `delete` `get_cookies`                                                                                                                                                                                                     |
| `victauri_trace`      | `start` `stop` `status` `frames`                                                                                                                                                                                                       |
| `victauri_window`     | `get_state` `list` `manage` `resize` `move_to` `set_title` `introspectability`（探测每个窗口 JS bridge 可达性，`introspectable:false` + `visible:true` 几乎总是缺 `victauri:default` capability）                                      |

复合工具只有 `action` 是必填 enum；其余参数按子动作可选、原样透传，子动作级校验由
victauri-plugin 端负责（本层不重复校验）。完整参数清单见各工具 description
（`src/tools/compound/catalog.ts`）。

参数集合与 Rust 侧严格 1:1：`victauri_animation` 的参数为 `action` `selector`
`points` `capture` `restore` `cols` `record` `clear` `webview_label`——**不含**
`limit`（`limit` 属 `victauri_trace` 的 `frames` 子动作语义，批四 2/6 已移除；
Rust `AnimationParams` 在 0.8.8 / 0.10.2 均无该字段）。

### `webview_label` 参数（explain / fault）

| 工具               | 参数            | 服务端支持口径                                                                                                    |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| `victauri_explain` | `webview_label` | 0.10.2 起支持（`ExplainParams.webview_label`，别名 `window`，缺省 main 窗口）；0.8.8 无此字段，传入被忽略且不报错 |
| `victauri_fault`   | `webview_label` | 0.10.x fallback schema 口径含该字段，但服务端 0.10.2 的 `FaultParams` 未定义 → 传入被忽略，**当前不生效**         |

- 标注口径与实现见 `src/tools/compound/catalog.ts` 的 `WEBVIEW_LABEL_EXPLAIN` /
  `WEBVIEW_LABEL_FAULT`，回归锁定见 `src/tools/contract.test.ts`
  （断言两 spec 均含该参数且描述含版本口径）。
- **活体复核（2026-11-05，victauri 0.10.3 demo-app）**：`explain` 带
  `webview_label:'main'` 正常返回 summary（字段生效）；`fault` 带
  `webview_label:'main'` 注入成功且 `fault list` 可见——与源码口径一致
  （传入被接受但作用域不按窗口限定）；两条 [源码] 口径经活体证实，无回滚项。
- 未知字段在服务端被静默忽略（serde 未开启 `deny_unknown_fields`，全 crate 无该
  属性），故 0.8.8 下误传 `webview_label` 不会报错，但也不会生效。

### route 的 0.10.3 行为边界

`victauri_route` 的 `add` 子动作在 0.10.x 服务端有四条行为边界（插件侧原样
透传、不重复校验；上游 0.10.3 源码 `js_bridge.rs:3586-3613` / `:3545-3558`、
`mcp/mod.rs:3107`）：

1. **两类 fulfill 规则在 `add` 时被拒**：pattern 命中 IPC host 且 mock 不可读
   （无 body 如 204、非 JSON body）——「不可读」只在 Content-Type 头为
   `application/json` 时才成立，`text/plain` 等类型不算（上游
   `js_bridge.rs:1229`）；或 mock 不被 `Response` 构造器接受（header 名或值
   非法、非 ByteString `status_text`）。
2. **更宽的 pattern 会被接受**，但当该 mock 同样不可读时 `add` 返回
   `ipc_warning`：命中 Tauri IPC 调用时 Tauri 读不出 mock，服务端回 Tauri
   错误并记录 `mock_unreadable`，**真实命令不执行**。
3. **正则的重复捕获组在 `add` 时被拒**（`match_type='regex'` 时才检查，如
   `(a+)+` 会挂起页面，JavaScript 无正则超时；上游 `:3545` 的条件判断、
   `:3552` 的错误文案）；0.10.2 及以前没有此校验。
4. **`ipc_warning` / `mock_unreadable` 是 0.10.x 引入的细化**，0.8.8 服务端
   没有这两项。

- 版本可核性：第 3 条本机可核 0.8.8 / 0.10.2 均无；第 4 条本机可核 0.8.8 无、
  0.10.2 有。
- 与 `src/tools/compound/catalog.ts` 的 `route` 工具 description 同源，回归
  锁定见 `src/tools/contract.test.ts`。

## 后端日志与 0.10.x 新参数

- **`victauri_wait_for` 条件为 10 值闭集**：`text` `text_gone` `selector`
  `selector_gone` `url` `ipc_idle` `network_idle` `expression` `event` `log`
  （`log` 为 0.10.2 起的后端日志条件；上游新增条件需随插件升级才能用）。
- **后端日志三段式**（0.10.2 起）：① `victauri_invoke_command` 传
  `with_logs=true`，返回体带 `backend_log_cursor`（调用起点游标）；
  ② `victauri_wait_for` 传 `condition:'log'` + `since_seq:<cursor>` 阻塞到
  匹配的后端行被记录（`level` / `fields` 过滤，匹配脱敏后文本，超时返回
  `missed_entries`）；③ `victauri_logs` `action='backend_digest'` 一次拿到
  分级计数 / 最吵 target / 折叠模板 / 每个 panic 的摘要盘点。
  `since_seq` 为向前分页游标：返回游标之后**最旧的**条目，`next_seq` 紧随其后。
- **`victauri_find_elements` 0.10.3 新参**：`title_attr`（title 属性子串）、
  `attribute` / `attribute_value`（按属性名/值过滤）、`text_exact`（精确
  文本匹配）、`include_hidden`（true 才返回隐藏元素，默认跳过）；同版本起
  可访问名与 visible/enabled 为诚实计算值。

## 图像结果通道（通用落盘）

任何工具返回 `{data, mimeType}` 形态的图像值（顶层对象或含此类值的多块数组）
都在 JSON 文本渲染（6000 字符截断，`renderJson`）**之前**分流落盘
`%TEMP%\dsh-victauri\`，避免 base64 撑爆上下文或被截成残串：

- 覆盖范围：`victauri_screenshot`（单图）、`victauri_trace` `action=frames`
  （多帧多文件）、`victauri_animation` `action=scrub` + `capture=true`
  （帧落盘，filmstrip/manifest 元数据合并回结果）；standalone 与 compound
  两个批共用同一通道（识别逻辑在 `src/tools/standalone/image.ts`）。
- `backend_logs` 大载荷同理：`victauri_invoke_command` `with_logs=true` 或
  `victauri_logs` `action=backend` 返回超过 5 条日志时，渲染层先把
  `backend_logs` 摘要化（保留前 5 条 + 一行摘要说明），游标类标量键
  （`backend_log_cursor` / `next_seq` / `backend_logs_hint`）重排在前**原样保留**，
  不受 6000 截断影响（摘要逻辑在 `src/tools/standalone/render.ts`）。
- 返回形状：单图 `{path, mime_type, bytes}`；多帧返回 `paths[]` +
  `mime_type`（首图）+ `count`；`scrub` 的 meta JSON 字段原地合并
  （`filmstrip.manifest[]`、`curve[]` 等照常可读）。
- 命名：`<前缀>-<时间戳>[-<序号>].<扩展名>`——`screenshot-<ts>.png`
  保持历史命名不变；多帧序号 `-001` 起，顺序 = 响应内顺序，扩展名由
  mimeType 推导（png/jpg/svg/…，未知兜底 `bin`）。
- 数量上限：单次调用最多落盘 `IMAGE_SAVE_MAX = 120` 个文件
  （与 filmstrip 硬上限同值）；超出部分计入 `dropped` 并在 `note` 注明，
  不静默丢弃。
- 非 `image/*` mimeType（如音频）同通道落盘，但会在 `note` 注明未经
  活体验证；落盘失败时回退原文返回（数组包成 `{items}`）并附
  `image_save_error`，不吞错。

## 数组结果的形状

插件把服务端的返回值统一归一为**顶层 object**（dsh 工具契约要求顶层是
`Record`），归一逻辑在 `src/tools/standalone/bridge.ts` 的 `toRecord`：

| 服务端返回            | 插件返回           |
| --------------------- | ------------------ |
| 顶层数组              | `{"items": [...]}` |
| 顶层对象              | 原样透出（不包装） |
| 标量（字符串/数字等） | `{"value": ...}`   |

- **影响面是全部数组型结果**，不只 `victauri_find_elements`——实测下列工具/子动作
  返回顶层数组时一律拿到 `{"items": [...]}`：`find_elements` / `get_registry` /
  `resolve_command` / `logs` / `recording` / `route` / `window` / `navigate` /
  `inspect` / `animation` / `storage`（本列表非穷举，判定依据是结果顶层类型而非工具名）。
- **两条易混例外**：上表清单里的工具**不要**把 `trace` 与 `fault` 算进来——
  `trace` 的 `frames` 走插件图像通道（`src/tools/standalone/image.ts` 的
  `normalizeImageResult`），返回 `{...merged, paths[], mime_type, count}` 而不是
  `{"items": [...]}`；`fault` 的 `list` 上游返回对象 `{count, faults: [...]}`。
  两者都不会拿到 `{"items": [...]}`。
- **与上游的差异**：上游 victauri 的 `logs` 的 `console` / `network` / `ipc` /
  `navigation` / `dialogs` / `events` 返回的是**裸数组**（bare array，见上游
  0.10.3 文档 `tools-reference.md` 的 logs 章节「返回最新 100 条…as a bare
  array」口径，`tools-reference.md:730-732`），插件多包了一层
  `{"items": ...}`——读这些结果时先取 `items`。
- **为什么多这一层**：dsh 工具的返回值顶层必须是 object，裸数组无法直接作为
  工具结果返回。
- **透传提案（未授权执行）**：让插件原样透传上游裸数组的提案见看板卡
  `t-mw1ri0ep-8vw7ql`——该卡为 backlog 提案卡，**未授权执行，需用户批准后才能
  认领**；在获批并落地前，一律按本节的 `{"items": [...]}` 形状解读。

## 请求超时语义（REST 通道）

REST 工具调用（standalone 20 + compound 15）的超时按**四级优先级**解析
（实现与常量在 `src/tools/standalone/timeout.ts`，单测
`src/tools/standalone/timeout.test.ts` 锁定）：

1. **`victauri_wait_for` 动态预算**：`timeout_ms` 参数 + 5s 余量
   （`WAIT_FOR_BUDGET_MARGIN_MS`，覆盖网络与轮询间隔开销）——长轮询不被
   全局默认 30s 掐断；
2. **工具声明预算 `requestBudgetMs`**（spec 静态声明）：目前仅
   `victauri_trace` 与 `victauri_introspect`（各 90s）——`frames` 可取
   全部环形缓冲（上限 600 帧 base64 PNG），`event_bus` / `command_catalog`
   是大缓冲导出与活体 IPC 日志挖掘的长操作；
3. **配置 `requestTimeoutMs`**（默认 30000，见 README 配置表）；
4. 内置默认 `DEFAULT_TIMEOUT_MS = 30s`。

- 工具来源的预算（1/2 档）一律夹到 **`TOOL_BUDGET_MAX_MS = 120s`** 硬上限，
  防预算过大被感知为长卡顿；未声明的工具行为与此前完全一致（回归测试锁定）。
- 超时错误仍为 `kind='timeout'`（`VictauriTimeoutError`），错误携带**实际
  生效的预算毫秒**；请求层保持单一计时器（无叠加计时）。
- CLI 桥 `victauri_cli` 不受本机制影响（子进程超时走自己的 `timeout_ms`
  参数，默认 120000，超时返回 `timed_out=true` + 部分输出）。

## 任意 JSON 值参数（`type:'json'`）

三个参数接受**任意 JSON 值**（字符串 / 数值 / 布尔 / `null` / 数组 / 对象），
schema 节点为 `type:'json'`（无类型约束，见 `src/tools/standalone/json-value.ts`
的 `JSON_VALUE()` 助手）：

| 工具                       | 参数       | 说明                                                  |
| -------------------------- | ---------- | ----------------------------------------------------- |
| `victauri_assert_semantic` | `expected` | 语义断言的期望值（与 `condition` 配合使用）           |
| `victauri_wait_for`        | `expected` | 轮询条件的期望值（与 `condition` 配合使用）           |
| `victauri_storage`         | `value`    | `action=set` 要写入的值（服务端按 JSON 序列化后落库） |

- **透传不字符串化**：桥层入参经 `isJsonValue` 守卫收敛为纯 JSON 值后
  **原样**发送（`src/tools/standalone/bridge.ts`），数值仍是数值、对象仍是
  对象、数组仍是数组，显式 `null` 原样送达（不会被丢弃、不会变成 `"null"`）。
  字符串值按字面量送达——服务端 `storage` 用 `serde_json::to_string` 序列化
  存储，故字符串会带引号落库（服务端既有行为，本层不改写）。
- **参数校验**：本层只做「是不是 JSON 值」的浅校验，不做深校验（结构/类型
  语义由服务端 `serde_json::Value` 决定）；必填参数缺失仍由 `defineTool`
  抛 `ToolArgsError`。
- **null 口径**：`victauri_assert_semantic` 服务端把未提供的 `expected`
  视为 `null`，故 `equals null` / `type_is "null"` 可通过（0.10.2 实测口径）。
- 回归锁定：`src/tools/standalone/json-value.test.ts`（schema 放开矩阵、
  透传形状、`null` 原样、守卫丢弃 `undefined` 与非 JSON 值）。

## CLI 桥（1 个）

| 工具           | 子命令（action 枚举）                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `victauri_cli` | `init` / `check` / `test` / `record` / `doctor` / `watch` / `invoke` / `tools` / `call` / `bridge` / `coverage` / `run` / `logs` |

其中 `tools` / `call` 需 CLI **≥ 0.10.1**，`run` / `logs` 需 CLI **≥ 0.10.2**
（本机 0.8.8 实测 `victauri --help` 只有 `init` / `check` / `test` / `record` /
`doctor` / `watch` / `invoke` / `bridge` / `coverage` 这 9 个子命令，无 `tools` /
`call` / `run` / `logs`；`invoke` 在 0.10.3 仍保留，与 `call` 并存）。
上游 0.10.3 另有 `setup`（只写 agent 客户端接入指令，`init` 已覆盖首次接入）
与 clap 内置 `help`（不是可路由 action）——本插件**有意不接**这两个。

子命令口径的**唯一事实源**是 `src/cli-hints.ts` 的 `CLI_ACTION_SPECS`
（键 = 子命令名，值 = 语义 + 行为标记 + 版本门控提示）；`CLI_ACTIONS`、
工具参数 `action` 的 enum、提示文案全部由它派生——**新增子命令只改这一处**
（一致性由 `src/cli-hints.test.ts` 断言：规格表键序 = `CLI_ACTIONS` = 工具 enum）。

参数：

| 参数         | 必填 | 说明                                   |
| ------------ | ---- | -------------------------------------- |
| `action`     | 是   | 子命令名（enum，见上表）               |
| `args`       | 否   | 透传给子命令的参数列表（不含子命令名） |
| `timeout_ms` | 否   | 子进程超时毫秒（默认 120000）          |
| `cwd`        | 否   | 子进程工作目录（默认继承宿主）         |

返回字段：

| 字段          | 说明                                                                         |
| ------------- | ---------------------------------------------------------------------------- |
| `action`      | 实际执行的子命令                                                             |
| `exit_code`   | 退出码；`null` = 超时强杀或被信号终止                                        |
| `stdout`      | 标准输出全文                                                                 |
| `stderr`      | 标准错误全文                                                                 |
| `timed_out`   | 是否因超时被终止                                                             |
| `partial`     | 是否只捕获到部分输出（超时强杀或输出被截断）                                 |
| `cli_version` | 探测到的 CLI 版本；`null` = 未探测到（此时不给版本门控提示）                 |
| `hints`       | 该子命令的版本感知提示 `{summary, notes[], long_running, interactive}`       |
| `doctor`      | `doctor` 子命令的结构化报告；非 doctor 子命令或两路都识别不到报告时为 `null` |

### 渲染预览（模型侧可见文本）

- 返回字段里的 `stdout` / `stderr` 是**未经预览截断的捕获输出**（单路另有
  512KB 捕获上限，超出会带 `[truncated]` 标记，见下文「长驻子命令」）；模型
  实际看到的**预览文本**按**头尾双保留**截断：**头 3000 + 尾 3000**（另含一行
  省略标记 `…(截断,省略中间 N 字符,共 M 字符)`，故渲染总长略大于 6000）；
- 只留头部会把尾部丢掉（真实报错常在最后几行），故必须保留尾部；
- 按**码点**切片（`Array.from`），多字节字符不会被切碎；
- 预览取 `stderr || stdout`（stderr 非空时优先 stderr）；`doctor` 的结构化
  明细块照旧**全量展示**，不受预览截断影响；
- 与另一层机制相互独立：`src/cli.ts` 的单路捕获上限 512KB（超出追加
  `[truncated]` 标记并置 `partial=true`）；
- 回归锁定：`src/tools/cli.test.ts`（长输出头尾共存 + 省略标记 + 短输出原样
  - 多字节不切碎）。

### 结构化输出（doctor）

- `doctor` 的文本报告会**额外**解析成结构化对象放进 `doctor` 字段：
  - `summary`：`Summary:` 行原文；`passed` / `total` / `failed` / `warnings`：计数；
  - `checks[]`：逐条明细 `{status: PASS|FAIL|WARN, message, detail}`，
    `detail` 取明细行的缩进续行（无则 `null`）；
- 原始文本**始终保留**（`stdout` / `stderr` 原样带回），解析不吞内容；
- 解析顺序为**先 `stdout`、再 `stderr`**：0.8.8 实测报告全文写在 `stderr`
  （`stdout` 为空串），0.10 起的文档口径是写在 `stdout`，两路都试；
- 两路都识别不到报告时（如 CLI 报 `error: unexpected argument '--json' found`）
  `doctor` 为 `null`，由调用方回退看 `stdout` / `stderr` 原文。

### 长驻子命令（watch / bridge / run / logs 的 `--follow`）

- `watch` / `bridge` / `run` **不会自行退出**，必须显式传 `timeout_ms`；
  `logs` 只有 `--follow` 模式是长驻（不带 `--follow` 时打印最近若干行即退出），
  同样需要 `timeout_ms`；
- 超时会 kill 子进程，返回 `timed_out=true`、`partial=true`，`stdout` /
  `stderr` 是**超时前已捕获的部分输出**（不是完整结果，也不会续传）；
- `partial=true` 有两个来源：① 超时强杀（`timed_out=true`）；② 单路输出超过
  512KB 捕获上限（`src/cli.ts` 的 `MAX_STREAM_BYTES`，**软上限**：先判后加，
  实际可略超一个 chunk），被截断的那一路末尾追加 `[truncated]` 标记。
  注意 partial 是按**输出里是否出现 `[truncated]` 字面量**判定的，若子命令自身
  打印了同名文本会假阳性；
- 模型侧可见文本再叠一层**预览截断**：取 `stderr || stdout`，头 3000 + 尾
  3000（另含一行省略标记，故渲染总长略大于 6000，详见上文「渲染预览」）；
- 两者都标记 `interactive=false`：本通道是 **spawn-等退出模型**（不写 stdin、
  等进程退出才返回），拿不到任何交互会话。

### bridge 子命令（上游定位与本通道边界）

- **上游定位**：`victauri bridge` 是给只会说 stdio 的**第三方 MCP 宿主**用的
  stdio→HTTP 代理（本机 0.8.8 `bridge --help` 首行原话 "Run as a stdio-to-HTTP
  MCP bridge for Claude Code and other MCP hosts"）；
- **HTTP 端点不在 CLI 进程里**：上游 CLI 无 `--http` / `--port` /
  `--transport` 等服务端选项；`/mcp`、`/api/tools`、`/info`、`/health`
  端点实际运行在 **victauri app 进程内**（插件随 app 启动的内嵌 HTTP 服务）；
- **勿经 CLI 桥接工具调用**：本插件已有 REST 主通道（`/health`、`/info`、
  `GET /api/tools`、`POST /api/tools/{tool_name}`）直连同一 app 的同一套
  工具（即全部 `victauri_*` 工具）——工具调用走主通道即可，`bridge` 对本
  插件零增量；
- **仅诊断性短时使用**：本通道（spawn-等退出模型）拿不到 stdio 交互会话；
  跨 app 重启自动重发现并**重建**后端会话的能力只存在于上游 CLI 侧的**长驻
  bridge 进程**，本通道没有——`bridge` 在本工具里只适合短时诊断（如确认握手
  输出）；上游 app 侧会话 id 随 app 重启即失效，不存在"会话跨重启存活"；
- **证据强度**：上游行为依据 victauri-cli / victauri-plugin **0.10.2 registry
  源码**与官方文档（[INFERENCE]，本机未安装 0.10.2/0.10.3，仅 cargo registry
  有 0.10.2 源码可查；本机 0.8.8 实测 `bridge --help` 与已废弃的 `--wait`
  no-op）。

### 0.10.x 新增子命令（tools / call / run / logs）

- `tools`（需 CLI ≥ 0.10.1）：列出 victauri 工具与其参数（每工具一行；
  `victauri tools <tool>` 看单个工具；`--json` 输出 MCP 工具对象与 input
  schema）。无 app 可达时只列内置工具名与描述（参数 schema 来自运行中的 app，
  拿不到）——本插件已有 `victauri_tools_list` 工具做同类事，且走 REST 主通道、
  不受 CLI 版本限制。
- `call`（需 CLI ≥ 0.10.1）：直接触发一次工具调用，比 `invoke` 更通用
  （`invoke` 只触发 app 的 Tauri IPC 命令）。传参四种形式：`key=value`（字符串）
  / `key:=json`（任意 JSON）/ 首个参数为 JSON 对象 / `--args-file <path|->`
  （`-` 读 stdin；Windows PowerShell 下推荐 `--args-file`）。图像结果用 `--out`
  保存，绝不打印 base64（多张图编号 `<stem>-1.<ext>`）。退出码：`0` 成功 /
  `1` 工具报错或 app 拒绝（stdout 上 `{"error": …}`）/ `2` 本地问题（参数错、
  无 app 可达——什么都没发出、或 `--out`/stdout 写不了——但工具确实跑了）/
  `3` 请求已发出但未完成（超时、连接丢失；工具可能已跑，勿盲目重试）。
- `invoke`（0.8.8 就有，0.10.3 仍保留）：与 `call` **并存**，共用同一 discovery、
  信任检查、`--app` pin 与 token；不接受 port/URL/token 参数，永不打印 token。
- `run`（需 CLI ≥ 0.10.2）：带捕获启动 Tauri app（`victauri run -- <cmd>`）。
  捕获逐字节透传到终端并同时写 JSONL（记录时间/流/行），末条记录 app 如何退出
  （退出码/信号/NTSTATUS 解码）；`--capture` 不指定时落私有 per-user 目录
  `console/<pid>-<ms>.jsonl`。app 内嵌插件经 `logs{action:"stdout"}` 读同一份
  捕获文件，app 死后也能读。**停止语义**：停止 launcher 会带走 app（Windows job
  object / Unix 停止信号转发 + DeathWatch 辅助进程）；被强杀的 launcher 不写退出记录，
  `victauri logs` 会报 `launcher_gone`。
- `logs`（需 CLI ≥ 0.10.2）：CLI 侧查看或跟随后端日志。选项 `--app` / `--level` /
  `--target` / `--grep` / `--limit`（默认 100）/ `--follow` / `--digest` /
  `--stdout` / `--capture` / `--json` / `--interval-ms`（默认 500）；app 未运行时回落最近
  一次 `victauri run` 的捕获文件。选项互斥：`--target` 与
  `--stdout`/`--capture`/`--digest` 互斥；`--digest` 与
  `--follow`/`--stdout`/`--capture`/`--grep`/`--level` 互斥；`--app` 与
  `--stdout`/`--capture` 互斥。**仅 `--follow` 是长驻用法**（逐行跟随新行，
  须传 `timeout_ms`）。CLI 侧也提供 `--json`（输出原始 JSON records，不是格式化
  行），与插件 `logs{action:"backend"}` 同源但面向 CLI 侧。
- **证据强度**：上游 v0.10.3 `crates/victauri-cli/src/main.rs` 的 clap 变体与
  各变体 `after_help` 原文（[INFERENCE]，本机 0.8.8 未安装 0.10.x，无法实测）。

### 如何近似 watch 的多轮效果

- 本通道拿不到逐轮增量（超时后只有一次部分输出，见上文），想要「多轮跑测」
  的效果，二选一：
  1. **反复调用一次性子命令**：`victauri_cli(action='test')` 或
     `victauri_cli(action='coverage')`——两者都是一次性退出型（`coverage`
     需活体 app；其报告走 stderr 系由上游 0.10.2 源码 `eprintln!` 推断，
     **本机待实测**）；
  2. **直接走 REST 主通道**：用 `victauri_*` 工具（同一 app、同一套工具、
     结构化返回；**工具调用面**与 bridge 所代理的同一套工具等价）；
- **"近似"仅指多轮调用节奏，不是测试能力的等价**：上游 `watch` 重跑的是
  **应用工程的 `cargo test`**（需在含 `Cargo.toml` 的 Rust 工程里执行），而
  `victauri test` 跑的是 victauri-test **内置冒烟套件**，两者不是同一套测试；
  REST 主通道同样无法执行应用工程的 `cargo test`；
- 上游 `watch` 本身没有 JSON / `--once` / `--follow` 模式（见下文 watch
  小节），本通道也**不存在**逐轮推送或订阅能力——勿按增量流语义调用。

### watch 子命令（上游语义与本通道边界）

- **上游语义**：递归监视**测试目录**的 `.rs` 文件变化并重跑 `cargo test`
  （仅 `.rs` 变化触发，启动即先跑一轮；本机 0.8.8 实测 `victauri watch --help`
  = "Watch test files and re-run on changes"）；
  选项 `-d/--dir` 指定被监视目录（默认 `tests`）、`-f/--filter` 只跑匹配的测试；
  目录须落在含 `Cargo.toml` 的 Rust 测试工程内（用 `cwd` 指定工程根）；
  目录不存在时上游自身报 `watch directory does not exist`；
- **输出形态**：人类向 **ANSI 终端文本**（banner 与摘要走 `stderr`）；上游**不提供
  JSON 结构化输出**，也**没有** `--once`（跑一次即退）/ `--follow`（跟随逐轮）模式；
- **本通道边界**：插件走 spawn-等退出模型（`src/cli.ts` 的 `runCliProcess`），
  只能在超时后拿到**一次部分输出**，拿不到**逐轮增量**；想要多轮效果，
  应重复执行**项目自身**的 `cargo test`（用 `cwd` 指定工程根）——
  `test` / `coverage` 是跑在**活体 app** 上的另一套（victauri 内置冒烟套件 /
  IPC 覆盖报告），**不能替代** watch 的重跑；
- **证据强度**：0.8.8 为本机实测；0.10.x 的参数与输出形态以上游源码/文档为准
  （[INFERENCE]，本机未安装 0.10.3）。

### 版本感知提示（hints）

- `hints.notes` 按**探测到的 CLI 版本**过滤；版本未知（`cli_version=null`）时
  一律不给版本门控文本（保守不外推）；
- `doctor` 是例外口径：上游 CLI **不提供** `--json` 结构化输出（0.8.8 实测报
  `error: unexpected argument '--json' found`；v0.10.3 CLI 源码 `main.rs` 的
  doctor 子命令亦无该选项），该提示无版本门控、任何版本下恒定出现——
  doctor 的结构化明细以本工具输出的 `doctor` 字段为准。

### cwd 用法

- `doctor` 需在 **Tauri 项目根（含 `Cargo.toml`）**执行，否则报告全 `FAIL`
  （仓根执行实测：`[FAIL] No Cargo.toml found in current directory`），
  用 `cwd` 指定项目根。

## CLI 探测（1 个）

| 工具                  | 用途                                                                   | 参数                    |
| --------------------- | ---------------------------------------------------------------------- | ----------------------- |
| `victauri_cli_status` | 探测本机 `victauri` CLI 可用性：版本号 + 实际命中路径 + CLI 子命令口径 | `refresh`（选填，布尔） |

返回字段：

| 字段             | 说明                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `status`         | `available`（可用）/ `not_found`（未安装或不在 PATH）/ `error`      |
| `version`        | 版本号（解析自 `--version` 输出；解析不出为 `null`）                |
| `version_output` | `--version` 原始输出                                                |
| `cli_path`       | 实际命中的可执行文件绝对路径；未命中为 `null`                       |
| `requested_path` | 本次请求解析到的路径（配置注入值或平台默认名）                      |
| `source`         | `config`（配置注入）/ `platform_default`（平台默认）                |
| `actions`        | CLI 子命令口径（同 `CLI_ACTIONS`：13 个）                           |
| `error`          | 失败时的结构化错误 `{kind, message, hint}`；`available` 时为 `null` |

- CLI 缺失时返回 `status=not_found`，`error.message` 与 `error.hint` 均含安装指引：
  `scoop install victauri` / `mise install victauri` / `cargo install victauri`；
- 配置项 `cliPath` 可注入自定义可执行文件路径（仅注入，不暴露给模型）；
- `cli_path` 为 **PATH 顺序下第一个实际命中**的可执行文件：同一台机器上可能与 `where.exe victauri` 的首条不同
  （例如 cargo 安装目录 `~/.cargo/bin` 优先于 mise shims），两条都是有效安装位置，不影响可用性判断；
- 探测只做「定位 + `--version`」两步，不执行任何 CLI 子命令；
- 结果默认缓存 60s，传 `refresh=true` 强制重新探测。

## 工具发现（1 个，`victauri_tools_list`）

只读查询服务端当前实际工具面，并把服务端清单与插件静态暴露面的**双向差异**以告警形式呈现。

| 参数                   | 类型    | 默认    | 说明                                      |
| ---------------------- | ------- | ------- | ----------------------------------------- |
| `include_descriptions` | boolean | `false` | 是否附带服务端工具描述（截断至 200 字符） |

返回字段：

| 字段            | 说明                                                                        |
| --------------- | --------------------------------------------------------------------------- |
| `tools`         | 服务端返回的工具名清单（已去重、保持服务端顺序）                            |
| `server_count`  | 服务端工具名数量（去重后）                                                  |
| `exposed_count` | 插件静态暴露的服务端工具名数量（当前 35）                                   |
| `in_sync`       | 两侧完全一致时为 `true`；存在任一差异为 `false`                             |
| `warnings`      | 差异告警数组，元素为 `{kind, name, message}`                                |
| `descriptions`  | 工具名 → 描述（仅 `include_descriptions=true` 时返回，描述截断至 200 字符） |
| `error`         | 查询失败时的结构化错误 `{kind, message, hint}`；成功时为 `null`             |

告警类型：

- `not_exposed`——服务端存在、插件未暴露的工具。插件版本落后于服务端时出现，
  需升级插件后才能调用对应服务端工具；
- `missing_on_server`——插件暴露、但服务端当前没有的工具（服务端版本落后或该工具被裁剪）。

行为约定：

- **工具面保持静态注册**：服务端新增工具**不会**自动注册为 dsh 工具（避免 schema 契约漂移），
  本工具只做「差异可见」，不做「动态暴露」；
- 只读：仅调用 `GET /api/tools`，不触发任何服务端工具执行；
- 查询失败返回结构化 `error`（`kind`/`hint` 指向 `victauri check` 自检），不抛栈、不吞错。

## 桥接体检（1 个，`victauri_doctor`）

只读体检：一条命令回答「这个工作区现在能不能用本插件开发调试 Tauri 应用」。**不调用任何上游工具、不写任何文件、永不抛错**（异常折进报告的检查项）。

| 参数               | 类型   | 默认           | 说明                                                     |
| ------------------ | ------ | -------------- | -------------------------------------------------------- |
| `workspace`        | string | 宿主进程 `cwd` | Tauri 项目根的绝对路径（模型应显式传入当前工作区根目录） |
| `identifier`       | string | 空             | 按 bundle id 过滤 discovery 实例（选填）                 |
| `probe_timeout_ms` | number | `2000`         | 单实例探活预算（毫秒）                                   |

返回字段：

| 字段               | 说明                                                                |
| ------------------ | ------------------------------------------------------------------- |
| `workspace`        | 实际探测的工作区绝对路径                                            |
| `is_tauri_project` | 是否探测到 `tauri.conf.json`                                        |
| `verdict`          | `ready`（全过）/ `partial`（有 warn 无 fail）/ `blocked`（有 fail） |
| `checks`           | 逐项检查数组，元素为 `{id, status, message}`                        |
| `summary`          | 一句话汇总（「体检 6 项：x 通过 / y 阻断 / z 提示 / w 跳过……」）    |

六项检查：

| 检查项          | 判定口径                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`     | `tauri.conf.json` 存在（查 `src-tauri/` 与根目录两处布局）→ Tauri 项目；否则 `fail`                                                         |
| `dependency`    | `Cargo.toml` 声明 `victauri-plugin`（缺 → `fail`）、`[features]` 定义 `victauri` 特征（缺 → `warn`）、`default` 是否启用（未启用 → `warn`） |
| `live-instance` | 逐个探活 discovery 实例：≥1 活体 → `pass`；无任何目录 → `warn`（应用还没启动过）；有目录全死 → `warn`（退出残留，列出 pid）                 |
| `tool-face`     | 服务端 `GET /api/tools` 与插件暴露面比对（复用 `victauri_tools_list` 的差异算法）：一致 → `pass`，有差异 → `warn`                           |
| `debug-build`   | `src-tauri/target/debug` 有构建产物 → `pass`，否则 `warn`（首次调试请先构建）                                                               |
| `cli`           | `victauri` CLI 可用 → `pass`；不可用 → `warn`（附安装指引，不影响 REST 工具面）                                                             |

行为约定：

- **沿用插件配置**：宿主侧注册时注入 `cliPath`（CLI 探测目标）与 `appIdentifier`（实例过滤范围），工具入参优先；
- **短路规则**：不是 Tauri 项目时 `dependency` / `live-instance` / `tool-face` / `debug-build` 记 `skip`，`cli` 始终执行；
- **不外泄敏感物**：实例只报 `pid` / `version` / 产品名，**不报 port 与 token**；上游错误的 message 含 `http://127.0.0.1:<port>`，输出里一律替换为固定文案；
- **依赖口径**：Cargo.toml 判定是**正则特征匹配**，不是完整 TOML 解析——精确配置以 cargo 自身解析为准（可用 `victauri_cli(action='doctor')` / `cargo metadata` 深查）。依赖声明支持 `victauri-plugin = { … }` 与 `[dependencies.victauri-plugin]` 两种写法；**改名形态识别不到**（如 `vp = { package = "victauri-plugin" }`）。

## 错误 `kind` 的三套词汇表（语义域不同，不可互相比较）

插件里有三处会返回带 `kind` 的结构化错误。它们的 `kind` **各自是一套封闭词汇表，
语义域不同、名字不可互相等价理解**——看到名字相近就当成同一含义会误判。

| 词汇表            | 位置                                                | 取值                                                                                                                                                                          | 语义域                                                                                                                                                                 | 消费者                                                                       |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| REST 桥接错误信封 | `src/errors.ts` 的 `VictauriErrorKind`              | `no-instance` / `instance-incomplete` / `no-live-instance` / `invalid-params` / `auth` / `not-found` / `rate-limited` / `http-error` / `timeout` / `tool-error` / `cli-error` | **调用失败的原因**：找不到实例 / 实例残缺 / 实例不活 / HTTP 400 / HTTP 401、403 / HTTP 404 / HTTP 429 / 其余 HTTP 非 2xx 与网络层失败 / 超时 / 工具被拒 / CLI 拉起失败 | standalone 与 compound 全部工具的 `{error:{kind,message,hint,status?}}` 信封 |
| CLI 探测域        | `src/tools/cli-status.ts` 的 `CliStatusError.kind`  | `not_found` / `cli-error` / `timeout`                                                                                                                                         | **本机 `victauri` CLI 是否可用**：没找到可执行文件 / 拉起失败 / 探测超时                                                                                               | `victauri_cli_status` 工具的 `error` 字段                                    |
| 工具发现域        | `src/tools/tools-list.ts` 的 `ToolsListWarningKind` | `not_exposed` / `missing_on_server`                                                                                                                                           | **暴露面与服务端清单的差异**：服务端有而插件没暴露 / 插件暴露而服务端没有                                                                                              | `victauri_tools_list` 工具的 `warnings` 数组                                 |

兜底值与自由字符串（不属上面任何封闭表）：

- REST 桥接信封里还会出现 `unknown`——非 `VictauriError` 的异常在
  `src/tools/standalone/bridge.ts` 的 `toErrorValue` 里被归一为 `unknown`。
  它是**兜底值**，不对应任何一种已定义的失败原因。
- `victauri_tools_list` 工具的 `error` 字段形状是 `{kind,message,hint,status?}`，但其中
  `kind` 是**自由字符串**（类型上写作 `string`），并非受限词汇表——它沿用
  REST 桥接信封的取值，也可能取兜底值 `unknown`。

HTTP 分流与信封可选键（backlog-A，M-1/S-1/S-2）：

- **HTTP 状态码 → kind 的机械映射**：`VictauriHttpError` 构造时推导——400→`invalid-params`、
  401/403→`auth`、404→`not-found`、429→`rate-limited`，其余（5xx/405 等）与网络层
  fetch 失败保持 `http-error`。
- **可选 `status` 键**：HTTP 分流错误的信封额外携带 `status`（数字）；非 HTTP 错误
  （`timeout`/`tool-error`/`no-instance` 等）不带该键。
- **工具级失败归一（S-1）**：上游工具级失败信封是 HTTP 200 + 顶层 `{"error": <值>}`，
  现在归一为结构化 `tool-error` 抛出（消息带上游摘要，截 500 字符），不再当作工具
  数据透出给模型——这是**行为变更**（修复目的本身）。
- **自动重发现（S-2）**：连接成功后收到 `auth`(401/403) 或网络层 `http-error` 时，
  插件自动重置共享连接，下次调用重新 discovery（读到新 token/port）；其余错误不复位
  （400/404/429/5xx/超时/工具级失败意味着服务在线，复位只会放大故障）。

易混对照（**仅作提醒，不是等价关系**）：

- CLI 探测域的 `not_found` =「本机没装/没命中 `victauri` CLI」；
  REST 桥接域的 `no-instance` =「discovery 里没有活着的 victauri 实例」——
  后者与 CLI 装没装无关（CLI 没装时同样可能是 discovery 目录为空）。
- CLI 探测域的 `cli-error` 与 REST 桥接域的 `cli-error` 同名，但前者是
  「CLI 探测这一步失败」，后者是「插件尝试拉起 CLI 子进程失败」，
  产生位置与排查方向都不同。
- 工具发现域的两个取值描述的是**清单差异**，不是调用失败——
  它们出现在 `warnings` 数组里而不是 `error` 字段里。

## 口径一致性

四处同源：README「工具清单」= 本文件 = `catalog.ts` 头注释（standalone 20，
全量 35 关系说明）= `standalone.test.ts`（从 `STANDALONE_TOOL_COUNT` 常量推导
断言，不硬编码字面量；CLI 子命令数 13 是**刻意硬编码**的防漏项断言）。

工具数口径同样由 `src/tools/contract.test.ts` 锁定：39 = standalone 20 + compound 15

- CLI 桥 1 + CLI 探测 1 + 工具发现 1 + 桥接体检 1；该测试同时断言工具面为静态注册
  （REST/compound 目录均不含 `tools_list`）。

CLI 子命令口径另有一处同源：`src/cli-hints.ts` 的 `CLI_ACTION_SPECS` =
`CLI_ACTIONS` = 工具参数 enum = 本文件「CLI 桥」表（由
`src/cli-hints.test.ts` 断言）。
