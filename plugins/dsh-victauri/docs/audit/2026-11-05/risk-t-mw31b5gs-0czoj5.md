# 残余风险自评 —— 批十一 3/3（t-mw31b5gs-0czoj5）

- 卡号：t-mw31b5gs-0czoj5
- 轮次：round-8
- 日期：2026-11-05
- 范围：仅 `src/tools/standalone/catalog.ts`、`src/tools/compound/catalog.ts`、`src/tools/contract.test.ts`（仅护栏断言）+ 本风险文档
- 纪律：只提交 dev、不 push、未移任何卡到 done

## 一、本卡做了什么

给**确实返回顶层数组**的工具/子动作补一句**统一措辞**的数组结果说明，使「插件把裸数组包成 `{"items":[...]}`」这一事实不再只写在 `docs/TOOLS.md` 的散文里，而是逐工具落到工具描述上。

实现方式：新增导出常量 `ARRAY_RESULT_NOTE`（`src/tools/standalone/catalog.ts:44-54`），由两个 catalog 共用，避免措辞漂移：

```
数组结果会被本插件统一包装为 {"items":[...]}（dsh execute 契约要求顶层为 object）；
上游同名工具/动作返回的是裸数组。
裸数组直透提案见看板卡 t-mw1ri0ep-8vw7ql（未授权执行，需用户批准后才能认领）。
```

### 数组型工具清单（11 个，含作用范围）

| 工具                            | 数组范围                                                                                                         | 依据                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `find_elements`（standalone）   | 整体返回顶层数组                                                                                                 | 上游 `mcp/mod.rs:700-780` 直接返回页面 findElements JSON；活体 0.10.3 实测 ARRAY                                                             |
| `get_registry`（standalone）    | 整体返回顶层数组                                                                                                 | 上游 `mcp/mod.rs:1417` `json_result(&commands)`（Vec）；活体实测 ARRAY                                                                       |
| `resolve_command`（standalone） | 整体返回顶层数组                                                                                                 | 上游 `mcp/mod.rs:1400` `json_result(&results)`（Vec）；活体实测 ARRAY                                                                        |
| `logs`（compound）              | `console`/`network`/`ipc`/`navigation`/`dialogs`/`events` 六个动作                                               | 上游 `trimmed_log_js`（`mcp/mod.rs:7129-7149`）末尾 `return arr.map(trimEntry);`；上游文档 `tools-reference.md:730-732` 明写 bare array      |
| `recording`（compound）         | `list_checkpoints`/`get_events`/`get_replay` 三个动作（`events_between` 无丢弃事件时也是数组，有丢弃时返回对象） | 上游 `mcp/mod.rs:2706`/`2713`/`2723`/`2735`；活体实测 ARRAY / null                                                                           |
| `route`（compound）             | `list`/`matches` 两个动作                                                                                        | 上游 `getRouteRules` / `getRouteMatches`（`js_bridge.rs:2646`/`2648-2653`）；活体实测 ARRAY                                                  |
| `window`（compound）            | `list`/`get_state` 两个动作                                                                                      | 上游 `mcp/mod.rs:2316`/`2319` `json_result(&states)`/`(&labels)`；活体实测 ARRAY                                                             |
| `navigate`（compound）          | `get_history`/`get_dialog_log` 两个动作                                                                          | 上游 `getNavigationLog`/`getDialogLog`；活体实测 ARRAY                                                                                       |
| `inspect`（compound）           | `get_bounding_boxes` 动作                                                                                        | 上游 `getBoundingBoxes`；活体实测 ARRAY                                                                                                      |
| `animation`（compound）         | `list` 动作                                                                                                      | 上游 `listAnimations`（`js_bridge.rs:3357`）；活体实测 ARRAY                                                                                 |
| `storage`（compound）           | `get_cookies` 动作                                                                                               | 上游 `js_bridge.rs:2720-2726` `if (!document.cookie) return []; return document.cookie.split(';').map(...)` → **恒返回数组**；活体实测 ARRAY |

### 明确**未**加说明的工具（避免误伤）

`fault`（`list` 返回 `json!({count, faults:[...]})` 对象）、`introspect`（各 action 均为 `json!({...})` 对象）、`explain`、`css`、`interact`、`trace`（`frames` 多内容块走**图像通道** `normalizeImageResult` → `{...merged, paths[], mime_type, count}`，**不是** `{items}`）、`eval_js` / `invoke_command`（形状由用户表达式 / 被调命令决定，非固定）、`query_db`、`read_app_file`、`list_app_dir`、`dom_snapshot`、`wait_for`、`check_ipc_integrity`、`detect_ghost_commands`、`get_diagnostics`、`get_memory_stats`、`get_plugin_info`、`app_info`、`app_state`、`assert_semantic`、`verify_state`、`screenshot`。

## 二、已闭合的验收点（C 项）

- **C1 只给确实返回数组的工具补说明**：11 个工具，按「整体返回」与「哪些子动作返回」两种粒度分别写明；非数组工具一个未加（见上节清单与「未加」清单）。
- **C2 措辞统一**：11 处全部复用同一常量 `ARRAY_RESULT_NOTE`，逐字一致；措辞同时指向 `{"items":[...]}` 包装与「上游同名工具/动作返回的是裸数组」这一事实差异。
- **C3 指向 backlog 卡且写明未授权**：统一说明末句写明「裸数组直透提案见看板卡 t-mw1ri0ep-8vw7ql（未授权执行，需用户批准后才能认领）」，与该卡在看板上的 backlog + waitingForHuman 状态一致。
- **C4 护栏断言（先红后绿）**：`src/tools/contract.test.ts:804-870` 新增用例「批十一 3/3 数组型工具描述：只给确实返回顶层数组的工具补 {items:[...]} 说明，措辞统一」，含 ①逐工具断言含统一说明 + 含范围声明 + 范围声明排在统一说明之前；②**载体集合相等断言**（带统一说明的工具集合 === 数组型工具清单，同时防误伤与漏改）；③旧措辞清退断言。
- **C5 范围声明精确到子动作**：logs 排除 `slow_ipc`（上游 `slow_ipc_js` 返回 `{threshold_ms,count,calls}` 对象）、recording 标注 `events_between` 的两种形状、storage 只标 `get_cookies`（`get` 读到的值形状随存储内容而定）。
- **C6 V1 四件套全绿**：见第三节。
- **C7 V2 独立审阅或如实记录降级**：子代理通道连续 3 次失败 → Lead 亲自执行同等核对，结论与逐条证据见第三节。
- **C8 只提交三个文件**：见第四节与纪律声明。
- **C9 残余风险落盘**：本文件。

## 三、验证方式与结果

### V1（本卡自验）

| 命令                | 结果                                                     |
| ------------------- | -------------------------------------------------------- |
| `pnpm typecheck`    | exit 0                                                   |
| `pnpm test`         | **17 files / 201 tests passed**，exit 0（新增用例 1 条） |
| `pnpm lint`         | exit 0                                                   |
| `pnpm format:check` | 「All matched files use Prettier code style!」           |

单文件复跑：`npx vitest run src/tools/contract.test.ts` → **16 passed**。

### 先红后绿

护栏落地、描述未改时先跑：`npx vitest run src/tools/contract.test.ts` → **1 failed | 15 passed**（RED 基线，失败断言为「find_elements 缺统一数组说明」）；11 处描述改完 → **16 passed**（GREEN）。

### 突变测试（逐案改代码 → 跑护栏 → 从 `%TEMP%` 备份还原）

备份目录 `%TEMP%\dsh-mut-<guid>`，改写用 `[System.IO.File]::ReadAllText/WriteAllText`（UTF-8 无 BOM；工作区行尾为 LF，首版脚本按 CRLF 拼接未命中 → 改 LF 后重跑）。

| 案  | 突变内容                                               | 结果与断言信息                                                                                     |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| M1  | 删掉 `storage` 的 `ARRAY_RESULT_NOTE`                  | **RED**：`storage 缺统一数组说明`                                                                  |
| M2  | 误给 `css`（纯对象工具）加说明                         | **RED**：`expected [ 'animation', 'css', …(10) ] to deeply equal [ …(9) ]`（载体集合断言抓住误伤） |
| M3  | 改统一措辞（`裸数组。`→`裸的数组。`）                  | **RED**：`expected '…' to be '…' // Object.is equality`（常量与硬编码期望脱钩被抓）                |
| M4  | 改 `logs` 范围声明（漏 ipc/navigation/dialogs/events） | **RED**：`logs 缺数组范围声明`                                                                     |

每案还原后复跑 → 16 passed；`git status --short` 始终只有三个允许文件。

### 上游事实复核（Lead 本机实测，非复述）

- 上游 crate 路径：`C:\Users\AI\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\victauri-plugin-0.10.3\src`。
- 全量 `json_result(&` 调用点扫描（`mcp/mod.rs`）确认顶层数组来源：`1400`（resolve_command results）、`1417`（get_registry commands）、`2316`（window states）、`2319`（window labels）、`2706`（recording checkpoints）、`2713`（recording events）、`2723`（recording events_between，dropped==0）、`2735`（recording calls）；其余调用点均为 `json_result(&serde_json::json!({...}))` 或 `json_result(&result)` 形态的对象。
- 页面侧 `js_bridge.rs:2720-2726` `getCookies` → `if (!document.cookie) return []; return document.cookie.split(';').map(...)`，**恒返回数组**。
- 0.8.8 交叉核对：`js_bridge.rs` 中 `getRouteMatches:720`、`getLocalStorage:726`、`getCookies:774`、`getRouteRules:706`、`getIpcLog:568`、`getConsoleLogs:645`、`getNavigationLog:784`、`getDialogLog:800`、`getEventStream:815`、`getBoundingBoxes:949`、`listAnimations:1377` 均存在，页面侧同族实现一致。

### 活体实测（0.10.3）

本机起 `demo-app\src-tauri\target\debug\dsh-victauri-demo.exe`（pid 47148，minimized），`%TEMP%\victauri\47148\metadata.json` 显示 version=0.10.3 / port=7373；按 REST 契约 `POST /api/tools/<tool>` + `Authorization: Bearer <token>` 逐工具探测：

- **ARRAY**：`get_registry`、`resolve_command`、`find_elements`、`logs{console|network|ipc|events|navigation|dialogs}`、`window{list|get_state}`、`recording{list_checkpoints|get_events|get_replay}`、`route{list|matches}`、`navigate{get_history|get_dialog_log}`、`animation{list}`、`inspect{get_bounding_boxes}`、**`storage{get_cookies}`**。
- **object**：`logs{slow_ipc}`（`{threshold_ms,count,calls}`，与前六动作不同）、`app_info`、`get_plugin_info`、`storage{get}`、`app_state`、`fault{list}`、`explain{summary}`、`introspect{*}`、`dom_snapshot`、`check_ipc_integrity`、`detect_ghost_commands`、`get_diagnostics`、`get_memory_stats`、`list_app_dir`、`wait_for`、`trace{status}`、`trace{frames}`（空帧 `{frames:0}`）。
- **null / error**：`query_db`（无库）、`read_app_file`（路径不存在）、`invoke_command{greet}`（demo 无该命令）、`recording{events_between}`（from/to 不存在）、`assert_semantic`（缺 `condition` 参数，工具真实参数名如此）。

> 活体探测**推翻了本卡实现前的两处源码推断**：`storage{get_cookies}` 实为 ARRAY（此前按 `json!({...})` 推断为对象）、`logs{slow_ipc}` 实为对象（此前与前六个日志动作混为一谈）。

### V2（独立审阅）

**实际方式：子代理通道连续失败 → 降级 Lead 亲自执行同等核对。** 三个 V2 子代理（`f3303c48-638b-4c32-955d-ce7d939d566d`、`e684ac09-b68f-4c40-906f-26d38a93ccd2`、`750a07ba-b3f0-49f2-8b52-915f6b7606ad`）均「启动后无输出即失败」（started … failed before it finished / left no closing message），累计 3 次达上限，按既定降级纪律改由 Lead 亲自执行同等核对。

Lead 亲自 V2 结论：**PASS_WITH_NITS（1 条 nit 已转为 follow-up 卡，2 条记录性风险）**。

逐项核对：

- **① 是否给非数组工具误加** —— 按 `git diff` 逐文件核对：standalone 仅 `find_elements`/`get_registry`/`resolve_command` 三处，compound 仅 `animation`/`inspect`/`logs`/`navigate`/`recording`/`route`/`storage`/`window` 八处，合计 11 处，与上游 `json_result(&Vec)` 调用点及活体实测一一对应；`fault`/`introspect`/`explain`/`css`/`interact`/`trace`/`eval_js`/`invoke_command` 等均未出现（grep 复核：全仓 `items`/`顶层数组` 命中点逐条看过，非数组工具无新增说明）。
- **② 与上游事实是否冲突** —— `logs` 未把 `slow_ipc` 列入（上游返回对象）；`recording` 明确标注 `events_between` 的两种形状；`storage` 只标 `get_cookies` 未标 `get`；`eval_js`/`invoke_command` 未列入；`trace` 未列入（走图像通道）；全部属实。
- **③ 断言是否恒真/空洞** —— 先红后绿基线（1 failed）+ 4 项定向突变全部 RED，三层断言（逐工具包含 + 载体集合相等 + 措辞逐字相等）互补；残留弱点见 R2。
- **④ 是否越界** —— `git status --short` 仅三个允许文件；`git diff --stat` = `3 files changed, 130 insertions(+), 12 deletions(-)`；未改 `bridge.ts`/`client.ts`/`index.ts`/`scripts/**`/`docs/**`/`Cargo.toml`/lockfile。
- **⑤ 是否与既有口径冲突** —— 与 `docs/TOOLS.md:155-180`「数组结果的形状」小节口径一致（同一包装语义、同一上游裸数组事实、同一 backlog 卡号与未授权标注）；两个 catalog 的三源标注惯例（`[文档]`/`[源码]`/`[桥]`/`[实测]`）未被破坏——新增文本为事实性说明而非来源标注；常量导出位置（`standalone/catalog.ts:44-54`）与既有 `ENUM`/`STR`/`INT`/`BOOL`/`WEBVIEW` 同层，compound 经 import 复用，无重复定义。

## 四、剩余风险

| 编号 | 风险                                                    | 级别 | 说明与处置                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1   | `docs/TOOLS.md:166-169`「影响面」列表与本卡新清单不一致 | 中   | 该列表把 `trace` 与 `fault` 列入（实测 `fault.list` 返回对象、`trace.frames` 走图像通道不是 `{items}`），且漏列 `find_elements`/`resolve_command`/`navigate`/`inspect`/`storage`。**本卡禁止改 `docs/**`**，故未动手；已建 follow-up 卡 `t-mw351p2r-b6rxos`（todo，本轮 round-9 执行）定点修正该列表并加护栏。 |
| R2   | 护栏的范围声明用 `toContain` 子串匹配                   | 低   | 理论上「在范围声明后追加字符」仍可能绕过 `toContain`。当前由「载体集合相等 + 措辞逐字相等 + 范围声明位置递增」三层互补，且 M1~M4 四案证明有效；残留窗口仅在有人刻意在范围声明尾部续写时出现。后续若要收紧，可改为带右边界的正则。                                                                              |
| R3   | 活体证据只覆盖 0.10.3                                   | 低   | 0.10.3 有活体实例（demo-app 调试版 pid 47148 / port 7373）；**0.8.8 未活体复现**（旧实例已退出且无构建产物），0.8.8 的数组形状依据为源码同族实现核对（`js_bridge.rs` 各页面函数在 0.8.8 均存在）。上游改版时需重跑活体探测。                                                                                   |
| R4   | 数组形状随数据内容变化的工具只能部分声明                | 低   | `storage{get}` 读到 JSON 数组时会返回数组、被包装成 `{items}`；`eval_js`/`invoke_command` 形状由表达式/被调命令决定。这些工具**没有**被标成数组型，属有意取舍——统一说明本身是条件句（「数组结果会被本插件统一包装为…」），不构成错误陈述，但读者仍需按实际顶层类型判断。                                       |
| R5   | 描述增量带来的渲染成本                                  | 低   | 11 个工具各增约 120 字符；`render.ts` 的 `RENDER_MAX_CHARS` 只截渲染输出，不截描述，描述长度无实际上限约束（`grep 'description\.length'` 无相关命中），故无功能影响，仅工具列表页略长。                                                                                                                        |
| R6   | V2 子代理通道连续失败，交叉复核降级为单人               | 低   | 本卡三个 V2 子代理全部启动即失败，交叉复核由 Lead 亲自执行（双人交叉的独立性弱于既往轮次）。缓解：Lead 核对逐条给出可复现证据（上游行号、活体探测结果、突变四案、diff stat），并用 4 项定向突变反向证伪断言有效性。                                                                                            |

## 五、可执行残余缺口

- **已建卡并在本轮 round-9 执行**：`t-mw351p2r-b6rxos`（todo）——订正 `docs/TOOLS.md`「数组结果的形状」小节「影响面」列表（移除 `trace`/`fault`，补列 `find_elements`/`resolve_command`/`navigate`/`inspect`/`storage`），并加护栏断言防回退。

以下 3 张为 **backlog 且 waitingForHuman**，本会话不认领、不实施：

- `t-mw1ri0ep-8vw7ql` —— `{items}` 原样透传（用户 2026-11-04 已裁定不自动执行；本卡的说明文案已写明该提案未授权）
- `t-mw2eut5k-6k1elc` —— backlog-A（S-1/S-2/M-1 核心客户端语义修复 + `bridge.ts:112` 注释订正）
- `t-mw2evd2u-0dukch` —— backlog-B（架构级与需设计类差距）

## 六、纪律声明

- 本卡只提交 dev 分支，未 push、未 force-push、未在 main/master 提交。
- 提交信息遵循 Conventional Commits（`type(scope): 中文主题`）。
- 本卡涉及的全部文件在卡面允许范围内：`src/tools/standalone/catalog.ts`、`src/tools/compound/catalog.ts`、`src/tools/contract.test.ts`（仅护栏断言）+ `risk-<cardId>.md`（卡面允许附带）。
- 失败步骤均 ≤3 次并已记录：突变脚本行尾假设错误（1 次改写，由 CRLF 改 LF）、V2 子代理启动失败（3 次达上限，按纪律降级 Lead 亲自核对并如实登记）。
- 未将任何卡移到 done。
