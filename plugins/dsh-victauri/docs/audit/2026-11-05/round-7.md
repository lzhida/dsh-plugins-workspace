# round-7：批十系列（别名口径收口 + route 0.10.3 细化口径）（2026-11-05）

## 本轮缘起

round-6 收口后复核「上游 serde alias」这条线索，发现**插件侧两处对上游别名的口径标注是错的**，
且**上游 alias 键在插件 schema 里完全没登记**——模型看不到这些别名键，也就没有动力去用它们。

本轮据此建两张卡：

| 卡                         | 承载差距                                     | 改动文件                                                                                                                                                                                                                | 提交             |
| -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 批十 1/2 t-mw2xz5ew-ujkz5f | P2-4/P2-5 别名归属勘误 + M-6 别名键登记      | src/tools/standalone/catalog.ts、src/tools/compound/catalog.ts、src/tools/contract.test.ts、src/tools/standalone/standalone.test.ts、docs/TOOLS.md、docs/upstream-feedback-0.10.3.md、docs/audit/2026-11-05/gap-list.md | 82d1afe、45ed154 |
| 批十 2/2 t-mw2y0377-l3dar4 | T-6 route 0.10.3 细化口径 + 差距清单状态回填 | src/tools/compound/catalog.ts、src/tools/contract.test.ts、docs/audit/2026-11-05/gap-list.md                                                                                                                            | 36dea69、2247df2 |

## 关键结论（本轮新增事实）

### 1. query_db 的 `sql` 是上游**正式 serde alias**，不是插件自造

| 层              | 口径                                 | 证据                                                        |
| --------------- | ------------------------------------ | ----------------------------------------------------------- |
| 上游源码/schema | `query` 带 `#[serde(alias = "sql")]` | 0.10.3 `backend_params.rs:142`、0.10.2 `:130`、0.8.8 `:117` |
| 上游文档        | 参数表只列 `query`（未标注别名）     | 0.10.3 tools-reference.md:66-72                             |

上游 doc-comment 原文（0.10.2 `backend_params.rs:127-129`）：「Accepts `sql` as an alias — the
intuitive name an agent reaches for first.」插件此前把 `sql` 标成「插件自有的兼容别名」是**事实错误**，
本轮已改标 `[源码]`；eval_js 的 `expression` 才是插件自造（上游 `webview_params.rs:9` 只有 `code`），
保持 `[桥]` 不变。

**副作用**：上游同时收到 `query` 与 `sql` 会触发 serde duplicate field 报错，故插件在
`bridge.ts` 的 ARG_ALIASES 里保留「本地归一（保留 query、移除 sql）」是对的——但这一行为此前
**零行为级测试**，本轮补了对称用例（`execute({sql})` → 上游收到 `{query}`；`execute({query,sql})`
→ 上游只收到 `{query}`；两者皆缺 → tool-error 且请求不发出）。

### 2. M-6「上游别名键未登记」的真正缺口在**参数描述层**，不是 schema 层

插件 schema 的 properties 仍只暴露主名（`webview_label` / `checkpoint_label` / `query`），
但 `parameterSchemaSpecToJsonSchema` 不设 `additionalProperties:false`（参数对象开放），
`bridge.ts` 原样透传 → **模型可以真的传 `window` / `window_label` / `label` / `sql`，
上游 serde alias 会识别**。因此本轮的做法是：在参数描述里登记这些别名的存在与来源标注
（`[源码]`），而不是改 schema 结构。

已登记的别名：

- `webview_label` ← `window` / `window_label`（0.10.3 `webview_params.rs:11,:38`、
  `window_params.rs:8`、`compound_params.rs:291` 等多处）
- `checkpoint_label` ← `label`（0.10.3 `compound_params.rs:458`、0.10.2 `:454`、0.8.8 `:454`）
- `query` ← `sql`（见上）

**顺带纠正一处上游文档反馈**：此前反馈材料写「文档仅在公共说明里提到 webview_label
（tools-reference.md:9），未说明别名键」——但 `tools-reference.md:9` 原文恰恰就是
「Every tool that touches a webview accepts `webview_label` (aliases `window`, `window_label`)」，
**说明别名键的就是这一行**。已改写为「粒度差异」：文档开头的公共说明已列别名，只是各工具参数表
行内未逐条标注；只有 `query_db` 的 `sql` 是**纯文档缺口**。

### 3. route 的 0.10.3 细化口径：四类，本轮全部补齐

| 口径                                                                                                                             | 版本边界                               | 证据                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add` 拒绝两类规则（pattern 命中 IPC host 且 mock 不可读 / mock 不被 `Response` 构造器接受）                                     | 0.10.x 服务端的 **fulfill 规则**       | 0.10.3 `js_bridge.rs:3586-3613`、0.10.2 `:1860-1890`、文档 `:791-807`                                                                                                             |
| 宽 pattern 被接受；**当该 mock 同样不可读时**返回 `ipc_warning`，命中时服务端回 Tauri 错误并记 `mock_unreadable`、真实命令不执行 | 0.10.x 引入                            | 0.10.3 `js_bridge.rs:3608-3612`、0.10.2 `:1886-1889`（原文逐行复核）                                                                                                              |
| 正则重复捕获组（如 `(a+)+`）在 `add` 时被拒（会挂起页面，JS 无正则超时）                                                         | **0.10.3 引入**，0.10.2 及以前无此校验 | 0.10.3 `js_bridge.rs:3548-3558`（拒绝实现）+ `:791-806`（判定注释）+ `src/mcp/mod.rs:3107`；0.10.2/0.8.8 全仓 grep「repeated group / can hang the page / repetition」**零命中**   |
| `ipc_warning` / `mock_unreadable` 是 0.10.x 的细化                                                                               | 0.8.8 服务端没有                       | 0.8.8 `js_bridge.rs`（2266 行）grep `hitsIpc`/`ipc_warning`/`mock_unreadable`/`ipcMockUnparsable`/`routeIpcNote`/`buildMockResponse` **全部零命中**（该版有 route 但无 IPC 细化） |

**证据升级更正**：本轮开始时，卡片描述称 regex 重复组校验「仅 `[CHANGELOG 0.10.3]` 单源
（0.10.2/0.8.8 未找到）」——该结论只查了 0.10.2/0.8.8，**0.10.3 crate 本机就有源码实现**。
已把该条的来源标注更正为 `[文档 0.10.3] + [源码 0.10.3 js_bridge.rs:3552]`，并作废原
「[CHANGELOG 0.10.3] 单源」写法。

### 4. 差距清单的状态回填（清单内部一致性）

本轮复核发现差距清单存在**内部不一致**：建卡映射表已标「已执行 <hash>」，但正文仍有 11 条
标着开放/未修（其修复其实早在批八/批九已落地，只是当时没回写）。本轮逐条核对代码与文档现状后
补齐：P1-1 / P1-2（批八 2/4）、P2-4（批十 1/2）、S-3（批八 1/4）、T-1/T-2/T-3/T-4/T-5（批八 3/4）、
E-1（批九 2/3）、E-2（批八 4/4），全部改为 ✅ 并附「【已修，卡号，提交 hash】」注记；
D-1..D-5 亦由本轮前序修复订正为已修。历史 round-*.md 按当时口径保留不改写。

## 本轮验证

- **V1（提交前最终一轮）**：pnpm typecheck exit 0 / pnpm test = **17 files 196 tests passed** /
  pnpm lint exit 0 / pnpm format:check 全绿（批十 2/2 期间首跑 FAIL 于 gap-list.md →
  prettier --write → 全绿；V2-B 意见落地后再次 FAIL 于 contract.test.ts → prettier --write → 全绿）。
- **smoke**：`SMOKE_SKIP_BUILD=1 node scripts/smoke.mjs` → **10/10 PASS**，exit 0，1768ms，
  pid=46764，victauri 0.10.3 @7373，tools 35 个含 6 核心，invoke_command with_logs 信封
  backend_logs 0 条 / backend_log_cursor=0（调用起点游标），logs backend_digest sources/buffered
  齐备（buffered=0）。
- **交叉验证**：批十 1/2 由 2 位独立子代理审阅（需求/上游口径 + 测试充分性）；
  批十 2/2 由 2 位独立子代理审阅（事实与来源标注 + 测试充分性）。所有问题修复后重跑 V1 全绿才提交。
  其中批十 2/2 的测试充分性审阅做了**真反向可证伪实测**（临时目录 + `git show HEAD:` 覆写 +
  `git hash-object` 校验字节原样）：旧文案下 16 条断言 15 红 1 绿（唯一绿是故意的不变式锁），
  据此补锁了行号事实锚点、add 拒绝判据串、三条行为要点与两条 0.8.8 事实。

## 剩余缺口

本轮结束时**无新增可执行缺口**：todo 清零，剩余差距全部是 backlog 类（S-1/S-2/M-1 核心客户端语义、
M/L 组增强与架构级评估、{items} 包装透传、上游反馈是否提 issue），均已 waitingForHuman 待用户裁决。

## 执行方式声明

沿用 round-6 的降级结论：ralph 工具 3 次失败 + 执行子代理累计多次启动失败 → **同会话串行轮次、
Lead 亲自执行**，差异部分交由独立子代理只读审阅。所有失败步骤均先诊断再重试、单步不超过 3 次，
失败原因与修正动作均记录在对应 risk 文档与看板评论中。
