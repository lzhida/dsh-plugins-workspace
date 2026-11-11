# 上游文档反馈材料（对照 victauri 0.10.3）

> 用途：整理 dsh-victauri 插件在「schema 三源对齐」审查中发现的**上游文档/实现不一致**，
> 形成可直接提交上游 issue 的反馈清单。措辞与格式沿用批四 4/6 上游反馈先例
> （客观陈述差异 + 双侧证据行号 + 建议修法，不夹带本插件实现偏好）。
> 证据来源：上游 tools-reference 文档（docs/src/tools-reference.md @ main 与
> @ v0.10.3，2026-11-05 抓取，落盘 `.agents/tmp/upstream-tools-reference-0.10.3.md`
> ——该落盘副本与 upstream v0.10.3 tag 原文逐行一致，仅结尾多一个空行）、
> 另比对 @ v0.10.2 与 @ v0.8.8 tag 的同名文档（用于确认历史口径是否发生过翻转）、
> 上游 CHANGELOG（CHANGELOG.md @ main）、cargo registry `victauri-plugin-0.8.8`
> / `0.10.2` / `0.10.3` 源码、本机活体 0.10.3 实例实测（demo-app，见 `pnpm smoke` 记录）。
> 本文件只整理反馈材料，**不代表已提交上游 issue**（上游提交需用户另行裁决）。
>
> **【2026-11-05 用户裁决】不向上游提 issue。** 文档缺口由本插件在描述层内部消化
> （已消化项见各条的「插件侧现状」标注与 gap-list 对应条目）；本文件转为**存档记录**，
> 保留双侧证据与差异分析供后续版本升级时复核，不再作为待提交清单维护。

## 一、文档参数表缺口（tools-reference.md）

### 1. find_elements 参数表缺 4 个 0.10.3 新增参数

- **现象**：0.10.3 文档的 `find_elements` 参数表（tools-reference.md:154-181）只列
  `selector(alias css)` `text` `role` `webview_label` `test_id` `name` `tag`
  `placeholder` `alt` `title_attr` `label` `exact` `enabled` `max_results(默认10)`，
  **不含** `attribute` `attribute_value` `text_exact` `include_hidden`；
- **对照**：CHANGELOG 0.10.3 段明确「`find_elements` … 新增 `attribute`、
  `attribute_value`、`text_exact` and `include_hidden`」（CHANGELOG [0.10.3] 段），
  且 0.10.2 源码 `other_params.rs:166-198` 的 `FindElementsParams` 亦无四参
  （证明它们确为 0.10.3 新增）；
- **影响**：只读文档的工具集成方（MCP 客户端、agent）拿不到这四个参数的语义与
  默认值口径，无法安全使用；
- **建议**：在 0.10.3 文档参数表补齐四参及其语义（按 CHANGELOG 与实现行为：
  `attribute`/`attribute_value` 为属性过滤子串、`text_exact` 为文本精确匹配、
  `include_hidden` 为包含隐藏元素），或在参数表旁标注「另见 CHANGELOG 0.10.3」。

### 2. assert_semantic 的 condition 枚举文档落后于源码

- **现象**：0.10.3 文档（tools-reference.md:344-355）`assert_semantic` 的
  `condition` 枚举只列 7 值：`equals | not_equals | contains | greater_than |
less_than | truthy | falsy`；
- **对照**：`victauri-core-0.10.2/src/verification.rs:515-534` 的枚举为
  **9 值**（另有 `exists` 与 `type_is`），且本机活体 0.10.3 实例的工具描述
  （`GET /api/tools` 返回的 `assert_semantic.description`）同样列出
  `exists` / `type_is`；
- **影响**：按文档实现客户端校验会**误拒**两个合法条件值；
- **建议**：文档补齐 9 值枚举。

## 二、源码注释与文档/行为不一致

### 3. RouteBehavior::Fulfill 注释仍写 "XHR falls back to delay"

- **现象**：`victauri-plugin-0.10.2/src/mcp/compound_params.rs:626-633` 的
  `RouteBehavior::Fulfill` doc-comment 写「(fetch only; XHR falls back to
  delay)」；同版 `src/mcp/mod.rs:2724-2744` 的 route 工具描述写「fetch supports
  all behaviors; XHR supports block/delay (fulfill is fetch-only)」；
- **对照**：CHANGELOG 0.10.3 段写明「`route` fulfill 现在支持 XMLHttpRequest
  （逐事件与真实服务器对比，21 个场景）」；0.10.3 文档 route 段同样写
  「fetch and XHR support all behaviors: a fulfilled XHR never reaches the
  network」；
- **影响**：读 0.10.2 源码注释的集成方会低估 fulfill 能力（文档已正确，属
  源码注释滞后）；
- **建议**：0.10.3+ 源码同步更新该注释与工具描述句。

### 4. 0.8.8 工具描述中 Tauri IPC 口径过时（仅历史对照）

- **现象**：0.8.8 `src/mcp/mod.rs:2331-2346` 的 route 描述写「Tauri IPC
  (ipc.localhost) is OBSERVE-ONLY … no IPC-control tool」；
- **对照**：0.10.2/0.10.3 已支持对 IPC URL 的规则控制（fulfill 需
  `Tauri-Response: ok` 头、block 转 postMessage 驻留等）；
- **影响**：仅影响仍驻留 0.8.8 的用户；无行动建议，仅备忘。

### 4b. fault 工具 fallback schema 与实际参数结构不一致

- **现象**：0.10.x 的 MCP `tools/list`（fallback schema）给 `fault` 工具声明了
  `webview_label` 参数（本插件早期按该清单对齐）；但 0.10.2 源码
  `introspection_params.rs:119-142` 的 `FaultParams` **没有**该字段，传入被
  serde 静默忽略；
- **影响**：客户端按 fallback schema 传 `webview_label` 会「看起来成功但不生效」，
  无任何报错提示；
- **建议**：二选一——`FaultParams` 真正实现 `webview_label`（故障注入按窗口
  限定），或从 fallback schema 移除该参数声明，避免静默无效参数。

### 5. find_elements 的 css/selector 主别名在文档与源码/schema 之间长期不一致（≥0.8.8）

- **现象**：0.10.3 markdown 文档的 `find_elements` 参数表
  （tools-reference.md:157）只列 `selector`，并把 `css` 写成它的别名
  （「CSS selector (alias: `css`)」），即**文档口径是 selector 主名、css 别名**；
- **对照（文档层从未翻转）**：v0.10.2 的 tools-reference.md:157 与 v0.8.8 的
  `:136` 与 0.10.3 **是同一句话**（同为 selector 主名、css 别名）——所以这不是
  「0.10.3 文档改了、源码没跟」，而是**文档层与源码层自 0.8.8 起长期并存的分歧**；
- **对照（源码层一直是 css 主名）**：0.8.8 `other_params.rs:147-150`、
  0.10.2 `:173-176`、0.10.3 `:181-184` 的源码注释均为「`css` — CSS selector to
  match (also accepts `selector` as an alias)」与「`selector` — Alias for
  `css`」，即**源码/schema 口径是 css 主名、selector 别名**；且 0.10.3
  `src/mcp/mod.rs:726` 的取值是
  `params.css.as_ref().or(params.selector.as_ref())`——两键同时传入时 **css 优先**；
- **影响**：
  1. 按 markdown 文档实现「selector 主名」的集成方，在同时传两键时与上游实际
     取值顺序相反（传入的 selector 会被忽略）；文档读者也无法得知该优先级；
  2. MCP `tools/list` 的 fallback schema 由源码注释生成，因此**工具签名本身
     呈现的是 css 主名**，与 markdown 文档呈现的 selector 主名互相矛盾，
     仅看其中一侧的调用方会做出相反假设；
- **建议**：二选一——统一到 selector 主名（与 ≥0.8.8 的文档一致，同时更新源码
  注释、fallback schema 与取值顺序），或在文档参数表中补注「源码仍以 css 为主
  字段，同传两键时 css 优先、selector 被忽略」。

### 6. animation.scrub 的 points 默认值文档与 schema/实现不一致

- **现象**：0.10.3 markdown 文档（tools-reference.md:1012）的 `points` 参数写
  「Number of evenly-spaced seek points for `scrub` (default: 6)」，示例
  （:1025）也用 6；
- **对照**：`victauri-plugin-0.10.2` 的 `src/mcp/compound_params.rs:767-768` 与
  `victauri-plugin-0.10.3` 的 `:771-772` 的 `AnimationParams.points` doc-comment
  均为「(`scrub`) Number of evenly-spaced progress points to sample. **Default
  20, clamped to 2..=120**」——**schema 口径是默认 20**，与文档的 6 矛盾；
- **实现级佐证**：0.10.3 `src/mcp/mod.rs:3551` 为
  `let points = params.points.unwrap_or(20).clamp(2, 120);`——20 是**实现值**；
  0.8.8 与 0.10.2 的实现同样是 20，文档的 6 属早期版本遗留口径；
- **影响**：按文档估算出点数/耗时的调用方会低估采样密度（6 vs 20），
  生成的 scrub 采样点数量与预期不符；
- **建议**：统一两处口径（schema 与实现的 20 是实现值，建议把文档改为 20）。

### 7. 正式别名（serde alias）在文档中的标注粒度不一致

- **现象**：上游多处参数在源码里带 `#[serde(alias = …)]` 正式别名，但 0.10.3
  文档标注别名的**粒度不统一**，只读参数表的集成方仍会漏掉别名键：
  - `query_db`：**纯文档缺口**——`victauri-plugin-0.10.3/src/mcp/backend_params.rs:142`、
    `0.10.2` 同文件 `:130`、`0.8.8` 同文件 `:117` 均为
    `#[serde(alias = "sql")] pub query: String`，doc-comment 写「Accepts `sql`
    as an alias — the intuitive name an agent reaches for first」；而文档参数表
    （tools-reference.md:66-72）**只列 `query`**，全文再无 `sql` 一词；
  - `webview_label`：**粒度差异**——0.10.2 `webview_params.rs:11,:38`、
    `other_params.rs:105,:149,:196,:204`、`compound_params.rs:137,:184,:343,
:391,:468,:522,:561,:682,:728,:784,:870`、`introspection_params.rs:75`、
    `verification_params.rs:18,:26,:43`、`backend_params.rs:59` 均带
    `#[serde(alias = "window", alias = "window_label")]`；0.10.3 同结构
    `webview_params.rs:11,:38`；0.8.8 `webview_params.rs:11,:38` 与
    `backend_params.rs:57` 同。此外 `screenshot` 的 `window_label`
    （0.10.3 `window_params.rs:8`、0.10.2 同结构）带
    `#[serde(alias = "window", alias = "webview_label")]`，`window` 工具的
    `label`（0.10.3 `compound_params.rs:291`）带三个别名
    `webview_label`/`window`/`window_label`。文档**开头的公共参数说明已列出别名**
    （tools-reference.md:9：「Every tool that touches a webview accepts
    `webview_label` (aliases `window`, `window_label`)」），
    但**各工具参数表行内未逐条标注**；
  - `recording.checkpoint_label`：0.10.2 `compound_params.rs:454`、0.10.3
    同文件 `:458` 带 `#[serde(alias = "label")]`；文档参数表
    （tools-reference.md:603）**已标注**「`checkpoint_label` (alias: `label`)」
    ——属参数行内标注的正面例子；
- **影响**：按参数表逐行生成 schema 的集成方只能猜别名键；`sql` 这类上游特意
  保留的「直觉名」兼容入口（doc-comment 记录了 4DA dogfood 的由来：传 `sql`
  会得到无提示的 HTTP 400）完全不出现在文档里，容易被当成不支持；
- **建议**：
  1. **必须**：给 `query_db` 的 `query` 参数补注「别名 `sql`」（与
     `checkpoint_label` 的现有写法一致）——这是唯一的纯缺口；
  2. **可选**：把 `webview_label` 的别名在每个用到它的参数表行内也标注一次
     （公共说明已列，属粒度统一而非补缺）。

## 三、行为复核确认无误的项（供上游确认，非缺口）

- `window.resize` / `window.move_to` 的「读回值 + `requested` + `settled:false`
  （约 500ms）」语义与本插件文档一致（tools-reference.md:542-543）；
- `storage.get_cookies` 仅返回非 httpOnly cookie（经 `document.cookie` 读取，
  0.10.2 `js_bridge.rs:1969-1970` 与文档 tools-reference.md:568 一致）；
- `explain.webview_label` 自 0.10.2 起 `ExplainParams` 支持（别名 `window`）；
  `fault.webview_label` 在 0.10.2 `FaultParams` 未定义、传入被静默忽略
  （全 crate 无 `deny_unknown_fields`）——与 0.10.x fallback schema 工具清单
  口径存在轻微出入，见上节第 4b 条。

## 四、本插件已按以上口径自纠的项（无需上游动作，备忘）

- `verify_state` 补 `backend_args` 参数（上游 doc:234 有、本插件此前缺）；
- `animation.action` 移除上游已废弃的 `clear` 值（0.10.2
  `compound_params.rs:737-746` 无 Clear，文档 doc:1014 只列 list/scrub/sample）；
- `wait_for.condition` 扩为 10 值闭集（含 0.10.2 新增 `log`）；
- `invoke_command` 补 `timeout_ms` / `with_logs`；`find_elements` 补
  `title_attr` + 四个 CHANGELOG 新参；`logs`/`window` 动作枚举对齐 0.10.3；
- `find_elements` 的 `css` / `selector` 参数描述按上游双层口径改写：文档层
  （≥0.8.8 起 selector 主名、css 别名）与源码/schema 层（css 主名、selector
  别名）分开陈述，注明两键等价、以及同传两键时 0.10.3 源码取 css（对 selector
  键即被忽略）——对应上文第 5 条；
- `animation.points` 描述标注上游文档 default 6 与 schema/实现 default 20 的
  矛盾，保持 schema 口径 20 并说明取舍依据（对应上文第 6 条）；
- 别名口径按上游 serde alias 更正并登记：`query_db.sql` 改标 [源码]（上游正式
  alias，此前写成「插件自有兼容别名」与源码事实相反），`webview_label` 描述
  登记上游正式别名 `window` / `window_label`，`recording.checkpoint_label`
  描述登记上游正式别名 `label`——对应上文第 7 条。

---

_生成：dsh-victauri 批六 4/4（t-mw1vb6fs-mr2mul），2026-11-05；第 5、6 条与本插件
描述纠偏由批九 1/3（t-mw2vu3ia-1nycp9）补充，第 7 条与别名口径更正由批十 1/2
（t-mw2xz5ew-ujkz5f）补充。上游 issue 提交与否由用户裁决。_
