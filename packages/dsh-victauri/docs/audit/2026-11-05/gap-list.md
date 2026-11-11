# dsh-victauri 插件能力审查：六面差距清单

> 基线：victauri 0.10.3（官方 tools-reference + CHANGELOG）为口径基线，与本机 0.8.8 实测、
> cargo registry 0.10.2 源码三源核对。证据标注：`文件:行号`（本仓库）、`上游 出处`
> （ Victauri 仓库）、`复现`（ 可执行命令）。审计日期 2026-11-05；素材来源
> `.agents/tmp/audit-tools-surface.md`（A/B 面）、`.agents/tmp/audit-contract-robustness.md`
> （ C/D 面）与本会话 E/F 面采集。严重度：🔴 高 / 🟡 中 / 🟢 低。

## 面 1：工具面覆盖度

上游 0.10.3 共 35 个 MCP 工具（standalone 20 + compound 15），插件 1:1 全暴露，另有 3 个插件自有
（victauri_cli / victauri_cli_status / victauri_tools_list）合计 38。已过期枚举 1 处：

- ✅ **P1-1 verify_state 缺 `backend_args` 参数**——src/tools/standalone/catalog.ts:358-369 未声明；
  上游 tools-reference.md:234 与 victauri-plugin-0.10.2/src/mcp/verification_params.rs:16
  `pub backend_args: Option<serde_json::Value>`；桥把 catalog schema 原样下发
  （src/tools/standalone/bridge.ts:99,137），未声明即模型传不出该参数。
  **【2026-11-05 已修，批八 2/4，提交 d03646a】** standalone catalog 已补 `backend_args`
  （object / additionalProperties true，描述标注 [文档 0.10.3]），contract.test.ts 有
  「批八 2/4 schema 收尾」用例锁定其定义与来源标注。
- ✅ **P1-2 animation.action 残留已废弃值 `clear`**——src/tools/compound/catalog.ts:94 仍列 4 值
  （list/scrub/sample/clear）；上游 0.10.3 tools-reference.md:1014 只列 list/scrub/sample（clear 是
  sample 的参数 clear:true）、0.10.2 compound_params.rs:737-746 无 Clear 枚举；0.8.8 仍有。
  基线已声明 0.10.3 → 应移除并对 0.8.8 标注兼容说明。
  **【2026-11-05 已修，批八 2/4，提交 d03646a】** action 枚举改为 3 值
  `['list','scrub','sample']`，描述写明 0.8.8 另有 clear、0.10.x 起废弃（清空改经 sample 的
  `clear:true` 参数）；contract.test.ts 的 EXPECTED_ACTIONS 同步为 3 值并有断言锁定。
- 🟢 **P3-3 assert_semantic.condition 9 值是上游文档落后于源码**（doc:344-355 只列 7；
  victauri-core-0.10.2/src/verification.rs:515-534 为 9 含 exists/type_is）——插件已正确覆盖 9 值，
  **勿回灌**，仅记录。
- ✅ **P3-5 工具数口径已显式解耦**——README.md:44「Victauri 全量 **35 个工具** + 1 个 CLI 桥工具 +
  1 个 CLI 探测工具 + 1 个工具发现工具 = **38 个 dsh 工具**」；docs/TOOLS.md:1 标题即「口径：35
  victauri 工具 + 1 CLI 桥 + 1 CLI 探测 + 1 工具发现 = 38 dsh 工具」，docs/TOOLS.md:5-8 列出四段构成，
  docs/TOOLS.md:462 的 `exposed_count` 标注「当前 35」，docs/TOOLS.md:512 「口径一致性」小节写明
  「38 = standalone 20 + compound 15」+ CLI 桥 / CLI 探测 / 工具发现各 1；工具数由
  src/tools/contract.test.ts:30-37,58-60 断言锁定（20+15=35、35+3=38），文档与测试双侧同源。
  **【2026-11-05 已修，批十一 2/3】** 落地提交为 **be544f6**（README.md:44 与 docs/TOOLS.md:1,518-521）
  与 **eb549f3**（docs/TOOLS.md:512 「口径一致性」小节），**不是**本卡卡面所述的 fb3cb97——该提交
  只改 0.10.x 动作表与新增参数口径，未触及工具数行；卡面证据有误，按 `git blame` 实测更正。
  （本卡只回填状态与证据，未改动这两个提交引入的文档内容。）
- ✅ 批六 4/4 已产出上游文档缺口反馈材料 docs/upstream-feedback-0.10.3.md（find_elements 参数表缺
  四新参、assert_semantic 文档 7 值 vs 源码 9 值、RouteBehavior 注释 fetch-only 过时、fault fallback
  schema 声明 webview_label 但 FaultParams 无此字段）；上游 issue 提交与否由用户裁决。

## 面 2：schema 三源对齐

- ✅ **P2-4 eval_js.expression 别名误标 [文档]**——src/tools/standalone/catalog.ts:154-155,161-163
  标注 [文档]，但 0.10.3 doc:106-138 与 0.10.2 webview_params.rs:7-9 均只有 code，无 expression。
  应改标 [桥]/[实测]（本地归一实现 src/tools/standalone/bridge.ts:47-52）。
  **【2026-11-05 已修，批十 1/2，提交 82d1afe】** expression 描述已改标「插件自有的兼容别名 [桥]」，
  并说明自动归一为 code；contract.test.ts 断言其含 `[桥]` 且不含 `[源码]`（保持上游无别名的口径）。
- 🟢 **P2-5 query_db.sql 别名同样误标 [文档]**——src/tools/standalone/catalog.ts:306；两源均只有 query。
  **【2026-11-05 勘误，批十 1/2】** 上游 `sql` 是**正式 serde alias**，
  不是「两源均只有 query」：0.10.2 `backend_params.rs:130`、0.8.8 `backend_params.rs:117`
  均为 `#[serde(alias = "sql")] pub query: String`（doc-comment 原文
  「Accepts `sql` as an alias — the intuitive name an agent reaches for first」）。
  插件 catalog 已改标 [源码]；0.10.3 文档参数表未列 sql 属**文档省略**
  （已写入 docs/upstream-feedback-0.10.3.md 作为上游文档反馈）。
  另：eval_js.expression 无上游别名（上游 webview_params.rs 只有 code），
  保持插件自有 [桥] 标注不变。
- 🟢 **P2-3 find_elements 四新参（attribute/attribute_value/text_exact/include_hidden）为 CHANGELOG 单源**
  ——CHANGELOG 0.10.3:59-60 有、0.10.3 文档参数表与 0.10.2 源码均无；标注已是 [CHANGELOG]，
  属正确单源标注，仅记录证据强度。

## 面 3：契约与错误语义

- 🔴 **S-1 上游工具级失败被当成功透出，插件错误信封失效**——上游 rest.rs 口径：工具级失败即
  HTTP 200 + `{"error": msg}`；插件 src/client.ts:122-127（响应无 result 键→原样返回）+
  src/tools/standalone/bridge.ts:137,141（错误信封只在 catch 路径生效）。复现：假上游返回
  `{"error":"eval timed out after 30s"}` → 工具返回裸字符串，无 kind/hint，与 docs/TOOLS.md:318/344/346
  承诺的 `{kind,message,hint}` 不符。**修复方向**：client/bridge 层识别 `error` 键响应并归一为
  VictauriError 信封。**【2026-11-05 已修，backlog-A】** 见下方 S-2 条目的联合注记（649b392）。
- 🟡 **M-1 kind 词汇表缺 auth/not-found/rate-limited/invalid-params**——src/errors.ts:33-47 仅 7 值；
  src/client.ts:106-112 把 400/401/403/404/429 同归 http-error 且丢弃 VictauriHttpError.status
  （errors.ts:55-68 实际持有 status）。
  **【2026-11-05 归属澄清，批九 3/3】** M-1 与 backlog-A（t-mw2eut5k-6k1elc）的 S-1（上游工具级
  失败裸错误、错误信封失效）/ S-2（客户端永不失效、401 不重发现）**同属错误信封与客户端语义
  改造**：三者都要动 `src/client.ts` 与 `src/tools/standalone/bridge.ts`，并行实施会同文件双写。
  故 **M-1 并入 backlog-A 的设计范围**（错误 kind 映射表本来就要在 backlog-A 出），
  本轮**不实施**。另注：三套 kind 词汇表（REST 桥接 / CLI 探测 / 工具发现）的**语义域边界**
  已在批九 3/3 补注释与文档（`docs/TOOLS.md` 新增「错误 kind 的三套词汇表」一节），
  那是**说明性澄清**，不改变任何运行时取值，也不解决 M-1 本身。
- 🟡 **M-2 {items} 数组包装的描述层与实现层需分开记账**——实现 src/tools/standalone/bridge.ts:80-85
  对所有数组生效（实测 get_registry/logs/recording/trace/route/window/fault/animation 全产出
  {"items":[...]}）；上游 tools-reference.md:735（本地副本 .agents/tmp/upstream-tools-reference-0.10.3.md:730-732）
  明写 logs 的 console/network/ipc/navigation/dialogs/events 返回 bare array。
  **【2026-11-05 拆分，批十一 2/3】**
  - **描述层说明（已完成）**：docs/TOOLS.md:155-180「数组结果的形状」小节已写明归一表（顶层数组 →
    `{"items": [...]}`、顶层对象 → 原样透出、标量 → `{"value": ...}`）、影响面是全部数组型结果、
    与上游 bare array 的差异及其行号来源（tools-reference.md:730-732）、为何多这一层；README.md:66
    同步补了裸数组提示与文档锚点。落地提交 e5f11d7（批十一 1/3）。
  - **实现层透传（未授权执行，需用户批准后才能认领）**：让插件原样透出上游裸数组，改的是
    src/tools/standalone/bridge.ts 的 `toRecord` 行为，属 backlog 卡 t-mw1ri0ep-8vw7ql
    （用户 2026-11-04 裁定不自动执行）——**未授权执行，需用户批准后才能认领**。
- 🟡 **M-3 多内容块与普通数组同形不可区分**——bridge.ts:82 统一包装；上游多块为
  `{"result":[{type:"text"|"image"}]}`。
  **【2026-11-05 归属澄清，批十一 2/3】** 属实现层行为变更（需区分多内容块与普通数组），
  归 backlog 卡 t-mw2evd2u-0dukch——**未授权执行，需用户批准后才能认领**；本轮只补归属标注，
  不改 src/**。描述层已在 docs/TOOLS.md:155-180 覆盖顶层形状（数组/对象/标量三行归一表），
  但多内容块与普通数组的同形问题属实现层，未在文档侧解决。
- 🟡 **M-4 未知参数静默透传**——src/tools/standalone/json-value.ts:33-41；复现：body 实收
  `{"totally_unknown_key":1}`；bridge.ts:112 注释「服务端拒未知字段」仅对 2 条登记别名生效。
  **【2026-11-05 归属澄清，批十一 2/3】** 拆成两段：
  - **注释订正**（bridge.ts:112「别名键总是移除(服务端拒未知字段)」与上游事实不符——上游 0.8.8 /
    0.10.2 / 0.10.3 三版 crate 全仓 `deny_unknown_fields` 命中均为 0，未知键被静默忽略而非报错）
    → 随 backlog 卡 t-mw2eut5k-6k1elc 一并处理（该卡描述「相关线索」段已记此线索）——
    **未授权执行，需用户批准后才能认领**。
  - **实现层静默透传本身**（是否改为白名单/报错）→ 归 backlog 卡 t-mw2evd2u-0dukch——
    **未授权执行，需用户批准后才能认领**。
    **【2026-11-05 已修（可观测性方案），批十三 2/2】** 用户裁决授权后按「不改透传语义、只补
    可观测性」实施：bridge.ts `collectIgnoredArgs` 收集「schema 未声明且非上游正式别名」的键，
    结果顶层附加 `ignored_args`（排序确定；图像通道与错误信封不附加；上游结果自带同名键时
    改用 `ignored_args_plugin` 备用键）。V2 中-1 修复后 known 集合纳入上游 serde 别名
    （UPSTREAM_WINDOW_ALIAS_TOOLS 23 工具 + UPSTREAM_EXTRA_ALIASES），消除 eval_js{window}、
    recording{label} 误报。落地提交 1010ca9（t-mw36ua79-1fkccm，in_review）。
- 🟡 **M-6 上游正式别名未接**——window/window_label、checkpoint_label（上游 tools-reference 行 13/607）；
  插件别名表仅 eval_js/query_db 两条（src/tools/standalone/bridge.ts:47-52）。
  **【2026-11-05 改判，批十 1/2】** 复核上游 crate 源码后**改判**：这些别名由上游
  serde `#[serde(alias = …)]` 直接识别（webview_label 带 alias window/window_label：
  0.10.2 webview_params.rs:11,:38、other_params.rs:105,:149,:196,:204、
  compound_params.rs:137,:184,:343,:391,:468,:522,:561,:682,:728,:784,:870、
  introspection_params.rs:75、verification_params.rs:18,:26,:43、backend_params.rs:59；
  0.10.3 webview_params.rs:11,:38；0.8.8 webview_params.rs:11,:38 与 backend_params.rs:57 同；
  recording checkpoint_label 带 alias label：0.10.2 compound_params.rs:454、0.10.3 :458），
  **插件无需做本地归一**即可被服务端识别；真实缺口只是**插件参数描述层未登记
  这些别名键**（schema properties 仍只暴露主名 `webview_label`/`checkpoint_label`，
  但参数对象是开放的——`@deepseek-ai/dsh-tools` 的 `parameterSchemaSpecToJsonSchema`
  （node_modules/@deepseek-ai/dsh-tools/lib/types/schema.js:238-247）不设
  `additionalProperties:false`，且 src/tools/standalone/bridge.ts:109-111 原样透传入参，
  因此模型可真的传 `window`/`window_label`/`label` 并被上游 serde alias 识别），
  模型无从得知可以传这些别名键。→ 本卡已在参数描述中登记别名
  （src/tools/standalone/catalog.ts 的 WEBVIEW 常量、src/tools/compound/catalog.ts 的
  checkpoint_label），**M-6 已修**。
- 🟢 **L-1 cli_status 的 kind 词汇表与 errors.ts 不统一**——src/tools/cli-status.ts:65-69。
  **【2026-11-05 澄清，批九 3/3】** 二者**语义域不同、不是同一层**：cli_status 的
  not_found/cli-error/timeout 属「CLI 探测域」（CLI 装没装、跑不跑得起来），
  errors.ts 的 7 值属「REST 桥接错误信封」（调用失败的原因）。二者不互通、不可按名字等价
  比较。已补源码注释 + `docs/TOOLS.md` 新增「错误 kind 的三套词汇表」一节说明边界；
  **不合并两套词汇表**（合并会丢失语义分层，且需改运行时取值）。
- 🟢 **L-11 上游 REST 30s/2MiB deadline 表现为 http-error 而非 timeout**。
  **【2026-11-05 归属澄清，批十一 2/3】** 与 M-5（eval 类无 per-tool 超时旋钮）同属超时语义域，
  归 backlog 卡 t-mw2evd2u-0dukch 一并评估——**未授权执行，需用户批准后才能认领**；另与 S-2
  （客户端永不失效、401 不重发现）相关联：上游 deadline 的错误分类改动会落在同一条错误信封链路上，
  故实施顺序上应与 backlog 卡 t-mw2eut5k-6k1elc 协同，避免两处同时改错误分类。

## 面 4：健壮性

- 🔴 **S-2 连接成功后客户端永不失效，401 不触发重发现**——src/index.ts:96-103（成功后 promise 永久
  缓存）+ src/client.ts:20-29（token/port readonly）+ src/client.ts:106-112（401 无处理）。复现：
  discovery 写入新 token 后 call#2/#3 仍 401。README.md:73 自称「连接失败会重置缓存」与实现不符
  （失败会重置，成功永不失效）。上游 0.10.3 起 /info 报告 pid 供 stale discovery 重判。
  **修复方向**：401/连接错误时复位 clientPromise + discovery 重扫。
  **【2026-11-05 已修，backlog-A】** S-1/S-2/M-1 三条经用户裁决授权后一并实施（649b392，
  t-mw2eut5k-6k1elc，in_review）：S-1 = callTool 200 分支识别「object + 'error' 键 + 无
  'result' 键」→ 抛 VictauriError('tool-error')（信封生效）；S-2 = 新增
  ReconnectingVictauriClient 包装（shouldResetClient：VictauriHttpError 401/403 或
  kind='http-error' → 复位 clientPromise 重跑 discovery，Timeout 不复位）；
  M-1 = kind 7→11 值（+invalid-params/auth/not-found/rate-limited）+ kindForStatus
  机械映射 + 信封可选 status 键。详见该卡与 risk-t-mw2eut5k-6k1elc.md。
- 🟡 **M-5 eval 类无 per-tool 超时旋钮，固定 30s**——standalone 20 + compound 15 中除
  wait_for/introspect/trace 外均未设 requestBudgetMs（字段 src/tools/standalone/catalog.ts:41）；
  上游 configuration.md：eval 默认 30s 可配至 300s（MAX_EVAL_TIMEOUT_SECS=300 + VICTAURI_EVAL_TIMEOUT）
  → app 端调大后插件 30s 即放弃且服务端仍在跑。
  **【2026-11-05 已修（声明预算方案），批十三 2/2】** 查证上游 eval_js 无 per-call timeout
  参数（0.10.3 webview_params.rs:7-13）→ 按清单「不支持」分支声明
  requestBudgetMs:45_000（默认档留余量，不追 300s 上限），注释与描述写明覆盖语义与错位。
  落地提交 1010ca9（t-mw36ua79-1fkccm，in_review）；app 端调大场景仍先放弃（M-8 架构级，
  暂缓）。
- 🟡 **M-7 discovery 不校验 PID 存活、不核对 /info pid**——src/discovery.ts:81-108,143-188（:178-179
  目录名当 pid）、:194-210；src/client.ts:68-74 只校验是对象；复现：pid=999999 仍被接受。
- 🟡 **M-8 客户端超时只中止本地 fetch 不取消服务端执行**——src/client.ts:166-167,181-183；超时后
  副作用已发生，重试即重复副作用（fault inject 类工具尤甚）。
- 🟡 **M-9 大响应先全量进内存再截断**——src/client.ts:105 `response.text()` 全量；截断只在渲染层
  （src/tools/standalone/render.ts:9,12-24）；上游 trace 单次可达 25MB。
- 🟡 **M-10 CLI 子进程只 kill 一次、无 SIGKILL 升级、不杀子孙进程、timeout_ms 无上限**——
  src/cli.ts:102-105；src/tools/cli.ts:99-102（仅 type:'integer'）、:277 宿主 300s；timeout_ms=3600000
  时宿主放弃、子进程继续跑。
  **【2026-11-05 部分已修（M-10a 夹取），批十三 1/2】** timeout_ms 无上限已修：工具层
  `Math.min(Math.max(requestedTimeoutMs,1), CLI_MAX_TIMEOUT_MS=300_000)`（CLI_MAX_TIMEOUT_MS
  与宿主工具声明 timeoutMs 同源），超限夹到宿主预算，孤儿窗口从无界缩到 ≤探测耗时。
  kill 无升级/不杀子孙属 M-10b（架构级，backlog-B 暂缓，见 risk-t-mw36ua1v-848yxm.md R5）。
  落地提交 48d8acb（t-mw36ua1v-848yxm，in_review）。
- 🟢 **L-3 wait_for 预算被 120s 硬夹**——src/tools/standalone/timeout.ts:17,30-52。
- 🟢 **L-4 trace/introspect 固定 90s**——src/tools/compound/catalog.ts:270,494。
- 🟢 **L-7 animation points 默认 20 与上游文档 6 不一致**——src/tools/compound/catalog.ts:105。
  **【2026-11-05 改判，批九 3/3】** 本条**不是插件缺陷**：上游 markdown 文档写 default 6
  （tools-reference.md:1012，示例 :1025 也用 6），而上游 **schema doc-comment 与实现**
  写 20——0.10.2 `compound_params.rs:767-768` / 0.10.3 `:771-772` 为「Default 20,
  clamped to 2..=120」，0.10.3 `mod.rs:3551` 实现为 `unwrap_or(20).clamp(2, 120)`。
  插件跟的是 schema/实现口径（20），**改成 6 反而错**。插件描述已加注该矛盾与取舍依据
  （批九 1/3，提交 71112e7）；上游文档/实现矛盾已写入 `docs/upstream-feedback-0.10.3.md`
  第 6 条。本条从「插件待修项」改判为「上游口径矛盾，已在上游反馈材料登记」。
  **证据强度说明**：schema/实现侧行号与数值**已在本机 cargo registry 逐条复核**；
  文档侧行号（:1012 / :1025）来自上游文档引用，本机无副本，**未本地复核**。
- 🟢 **L-9 CLI stdout 上限按字符计（非字节）可略超 512KB**——src/cli.ts:10,78-91。
- 🟢 **L-10 图像落盘无字节上限**——src/tools/standalone/image.ts:26,82-97。
  **【2026-11-05 已修，批十三 1/2】** `IMAGE_SAVE_MAX_BYTES = 20MiB` 上限：saveImage 超限
  抛错不落盘，经 applyImageChannel 回退 `image_save_error` 信封（原文保留）。落地提交
  48d8acb（t-mw36ua1v-848yxm，in_review）。

## 面 4.5：功能性缺陷（渲染层，横跨契约与教学面）

- ✅ **S-3 renderJson 只截头 6000 字符，with_logs 的 backend_log_cursor 被丢弃**——
  src/tools/standalone/render.ts:9-21（`text.slice(0, RENDER_MAX_CHARS)`）+
  src/tools/standalone/bridge.ts:102（output.render=renderJson）。复现：构造
  `{result, backend_logs(120 条,20865 字符), backend_log_cursor}` 载荷 → 渲染文本不含
  `backend_log_cursor` → 批六 1/4 教学的三段式第②步（wait_for since_seq=cursor）拿不到游标。
  **修复方向**：渲染前对 backend_logs 摘要化（保留前 N 条 + 显式带出 cursor），或 renderJson 支持
  尾部保底键；补回归用例锁「含 cursor」。
  **【2026-11-05 已修，批八 1/4，提交 ae52849】** render.ts 新增 `summarizeBackendLogsPayload`
  - `BACKEND_LOG_PREVIEW_COUNT=5`：backend_logs 超过 5 条时保留前 5 条，其余键（cursor/next_seq 等）
    重排在前原样保留，并附摘要说明指向 victauri_logs 分页；≤5 条时原样返回。
    src/tools/standalone/standalone.test.ts 有回归用例锁「渲染文本含 backend_log_cursor」。

## 面 5：工程质量与测试

- ✅ **T-1 闭集枚举的客户端前置拒绝无负向断言**——wait_for condition 枚举（catalog.ts:390 闭集）：
  `condition:'bogus'` → ToolArgsError `must be one of`，缺 condition → `missing required property`，
  请求不发（callTool 不被调用）——standalone.test.ts 无此负向用例。
  **【2026-11-05 已修，批八 3/4，提交 6e69c90】** standalone.test.ts 已补三条负向用例
  （bogus → `/must be one of/`、缺 condition → `/missing required property "condition"/`、
  `since_seq:'42'` → `/must be an integer/`），并断言 `calls.length === 0`（请求确未发出）。
- ✅ **T-2 来源标注断言过弱**——contract.test.ts:279-281 任一标签即过；建议 [tool,key,expectedTag]
  三元组逐参精确断言。
  **【2026-11-05 已修，批八 3/4，提交 6e69c90】** contract.test.ts 改为 [tool, key, expectedTag]
  三元组逐参精确断言（每个新参分别锁定其来源标注），不再「任一标签即过」。
- ✅ **T-3 invoke_command.timeout_ms 与本通道 REST 预算脱钩无断言**——实测
  `resolveRequestBudgetMs('invoke_command',{timeout_ms:120000})===undefined`
  （src/tools/standalone/timeout.ts:30-52）；timeout.test.ts 无此锁定。
  **【2026-11-05 已修，批八 3/4，提交 6e69c90】** timeout.test.ts 补锁定
  `resolveRequestBudgetMs('invoke_command',{timeout_ms:120_000}) === undefined` 与
  `('wait_for',{timeout_ms:120_000}) === 120_000`；standalone.test.ts 的 mockClient 记录第三参 budget，
  断言 invoke_command.timeout_ms **不改变**本通道的 REST 预算（30s / 工具级上限 120s）。
- ✅ **T-4 闭集 tripwire 注释缺失**——contract.test.ts:234-245 与 catalog.ts:391-402 同一份字面量
  复制，应注释「闭集契约而非上游快照」。
  **【2026-11-05 已修，批八 3/4，提交 6e69c90】** contract.test.ts 该处已加注释说明这是
  「闭集契约（客户端前置校验）而非上游快照」，上游新增条件需随插件升级才能用。
- ✅ **T-5 compound/bridge 运行时透传 0 测试**——建议新建 src/tools/compound/bridge.test.ts
  （dsh-tools 校验边界：since_seq:'7' 抛 ToolArgsError、未知 action 报枚举、未知顶层参数放行）。
  **【2026-11-05 已修，批八 3/4，提交 6e69c90】** 已新建 src/tools/compound/bridge.test.ts，
  覆盖复合工具运行时透传与 dsh-tools 参数校验边界（since_seq 非整数报 ToolArgsError、
  未知 action 报枚举错误、未知顶层参数放行）。
- ✅ **T-6 route 0.10.3 细化口径未覆盖**（已由批十 2/2 修复）——regex 重复组 add 时被拒、mock body 不可读时 add 拒绝
  （mock_unreadable）、宽 pattern 给 ipc_warning（批六 2/4 V2-A 低-10）。
  **【2026-11-05 已修，批十 2/2】** 插件描述已补四类口径（src/tools/compound/catalog.ts route 描述）：
  - `add`（0.10.x 服务端的 fulfill 规则）拒绝两类规则——pattern 命中 IPC host 且 mock 不可读
    （无 body / 非 JSON body / 204+application/json），或 mock 不被 `Response` 构造器接受
    （header 名或值非法、非 ByteString `status_text`）[文档 0.10.3]；
  - 更宽 pattern（如 `greet`、`*/greet`）被接受；**当该 mock 同样不可读时** add 返回 `ipc_warning`，
    命中时服务端回 Tauri 错误并记 `mock_unreadable`、真实命令不执行
    [文档 0.10.3] + [源码 0.10.2 `js_bridge.rs:1886-1889`]；
  - 正则重复捕获组（如 `(a+)+`）在 `add` 时被拒（会挂起页面，JavaScript 无正则超时）
    [源码 0.10.3 `js_bridge.rs:3552`]，0.10.2 及以前没有此校验（本机可核 0.8.8 / 0.10.2 均无）；
  - `ipc_warning`/`mock_unreadable` 是 0.10.x 引入的细化，0.8.8 服务端没有这两项
    （本机可核 0.8.8 无、0.10.2 有）。
    **证据强度说明**：源码侧行号与文案**已在本机 cargo registry 逐条复核**（0.10.3 `js_bridge.rs:791-806`
    判定注释与 `:3548-3558` 拒绝实现、`:1225` ipcMockUnparsable、`:1960`、`:3586-3613`、`:4770`；
    0.10.2 `js_bridge.rs:803-812`、`:1258`、`:1860-1890`；0.8.8 `js_bridge.rs:684-704` 的 addRoute
    只有 pattern 校验、无任何拒绝与 IPC 细化）；文档侧行号
    （`.agents/tmp/upstream-tools-reference-0.10.3.md:780-807`）来自抓取副本，**已由批十 2/2 的
    独立审阅逐句复核属实**。
    口径来源已按「不得把单源证据冒充成另一类」标注：文档与源码分别标注，route 描述内**未**沿用
    「[CHANGELOG 0.10.3] 单源」写法（该写法已作废——0.10.3 有源码实现；catalog 文件头那句
    「以 [文档 0.10.3] + [CHANGELOG 0.10.3] 为基线」是整档基线双源声明，与参数级来源标注不冲突）。
- 🟢 **L-5 find_elements 的 css/selector 双声明不归一**——src/tools/standalone/catalog.ts:179,191。
  **【2026-11-05 勘误，批九 3/3】** 本条原描述「主别名方向写反」不准确，真实分歧是
  **上游文档层 vs 上游源码/schema 层自 0.8.8 起长期并存**：
  - 文档层（v0.8.8 `tools-reference.md:136` / v0.10.2 `:157` / v0.10.3 `:157`）**一致**
    为「selector 主名、css 为别名」——文档层从未翻转；
  - 源码/schema 层（0.8.8 `other_params.rs:147-150` / 0.10.2 `:173-176` / 0.10.3 `:181-184`）
    **一致**为「css 主名、selector 别名」；0.10.3 `mod.rs:726` 取值
    `params.css.as_ref().or(params.selector.as_ref())` → 同传两键时 **css 优先**。
    插件描述已按双层口径改写（批九 1/3，提交 71112e7），两键上游均接受、语义等价，
    插件**不做**本地归一（无权威依据选定其一）。上游长期错位已写入
    `docs/upstream-feedback-0.10.3.md` 第 5 条。
    **证据强度说明**：源码/schema 侧行号与取值**已在本机 cargo registry 逐条复核**；
    文档侧行号（:136 / :157）来自上游文档引用，本机无副本，**未本地复核**。
- ✅ 已达标项：连接惰性（src/index.ts:81-126）、并发 promise 去重 + 失败重置、无候选不快落 7373
  （src/client.ts:244-251）、contract 锁工具数与 action 枚举、cli-hints 全量口径护栏
  （SCAN_ROOTS 全仓文本扫描）。

## 面 6：端到端（demo-app + pnpm smoke）

- ✅ **smoke 活体复核 9/9 PASS**（2026-11-05，victauri 0.10.3，pid=30924；SMOKE_SKIP_BUILD=1，
  2500ms）：health/info pid 一致/tools 35/get_plugin_info 35 启用/eval_js/dom_snapshot/invoke_command/
  无 token→401 全过。scripts/smoke.mjs 退出码 0/1/2，不进 CI。
- ✅ **E-1 smoke 未覆盖后端日志链路**——scripts/smoke.mjs 不含 logs backend_digest / invoke_command
  with_logs 检查（批六 4/4 卡面允许文件不含该脚本，按纪律未夹带）；demo-app 未装 log_layer
  （活体实测 sources.structured_installed:false），补检查需先给 demo-app 装捕获源。
  **【2026-11-05 已修，批九 2/3，提交 4a60d7c】** smoke 冒烟清单由 9 项扩到 10 项：
  新增第 9 项 `POST /api/tools/logs {action:'backend_digest'}`（0.10.2+ 断言 result 含
  sources/buffered），第 8 项 invoke_command 在 0.10.2+ 带上 `with_logs:true` 并断言信封内
  backend_logs 为数组、backend_log_cursor 为数字；版本门控按 GET /info 的版本决定断言或 SKIP
  （0.8.8 无这两个能力）。demo-app 未装 log_layer 的「无捕获源」形态亦被断言覆盖
  （digest 仍返回 sources 与 buffered，缓冲为空，不判失败）。实测 10/10 PASS。
- ✅ **E-2 demo-app/README.md 工具数 35 与活体 36 不一致**——历史 e2e 报告
  .agents/tmp/dsh-victauri-e2e-report.txt（2026-11-02，桥接 0.10.2）注册 36 个（当时无
  victauri_tools_list）；现在 38 个 dsh 工具 / 35 个上游工具，README 应写清口径。
  **【2026-11-05 已修，批八 4/4，提交 fb3cb97】** demo-app/README.md 已改为双口径说明：
  `/api/tools` 返回服务端 35 个上游工具清单，dsh 桥接后暴露 38 个 dsh 工具（= 35 上游 1:1 +
  3 插件自有：CLI 桥 / CLI 探测 / 工具发现）；裁决保留服务端 35 为正确口径。
- 🟢 **E-3 CI 不跑 smoke 与 Rust 构建**——.github/workflows/ci.yml 只有
  format:check/lint/typecheck/test/build；smoke 需 cargo + 活体 app，半自动设计（README 已注明），
  属有意取舍，仅记录。

## 面 2.5：文档漂移（README / docs/TOOLS.md）

- ✅ **D-1 docs/TOOLS.md:50 logs 动作表仍是 8 个**——批六 2/4 已把 catalog 扩到 11 值（+backend/
  backend_digest/stdout），文档表未同步。
  **【2026-11-05 已修，批八 4/4】** docs/TOOLS.md 的 `victauri_logs` 行现列 11 个动作
  （`console` `network` `ipc` `navigation` `dialogs` `events` `slow_ipc` `clear` `backend`
  `backend_digest` `stdout`，后三个标注 0.10.2 起），并由 cli-hints.test.ts 的同源护栏
  逐名断言 catalog 的 action.enum 与文档一致。
- ✅ **D-2 docs/TOOLS.md:56 window 动作表仍是 6 个**——catalog 已 7 值（+introspectability）。
  **【2026-11-05 已修，批八 4/4】** `victauri_window` 行现列 7 个动作，含
  `introspectability`（并注明 `introspectable:false` + `visible:true` 几乎总是缺
  `victauri:default` capability），同源护栏覆盖。
- ✅ **D-3 docs/TOOLS.md:36 wait_for 条件清单未含 log**——catalog 已 10 值闭集。
  **【2026-11-05 已修，批八 4/4】** 工具表 `victauri_wait_for` 行现写「10 值闭集，见下文
  「后端日志与 0.10.x 新参数」」，正文列出 10 值（含 `log`，标注 0.10.2 起，并说明
  上游新增条件需随插件升级才能用）。
- ✅ **D-4 README/docs 无新参数关键词**——timeout_ms/with_logs/since_seq/backend_log_cursor/
  include_hidden 等批六 1/4 新参在文档零提及。
  **【2026-11-05 已修，批八 4/4】** README 特性段与 docs/TOOLS.md「后端日志与 0.10.x 新参数」
  小节已覆盖 timeout_ms / with_logs / since_seq / backend_log_cursor / include_hidden，
  并由 cli-hints.test.ts 断言两处文档均含这五个关键词。
- ✅ **D-5 doctor --json 证据强度**——cli-hints.ts doctor notes「0.10.0 起的文档才提供 --json」：
  上游 0.10.3 main.rs doctor 仅 AppTarget(--app) 无 --json；历史实测 0.8.8 `--json` 报
  unexpected argument。表述与证据不符，应改为「0.8.8 实测无 --json；上游未证实提供」。
  **【2026-11-05 已修，批八 3/4】** 改为无门控的恒定提示「doctor 不提供 --json 结构化输出:
  0.8.8 实测报 unexpected argument，0.10.3 源码亦无」，README 与 docs/TOOLS.md 同步。

## 已裁决 / 不建卡项

- **setup 子命令**：上游 0.10.0 新增（写 agent 客户端接入指令）；本插件 init 已覆盖首次接入，
  批六 3/4 定论「有意不接」（SPEC_TABLE 头注释与 docs 均已注明）→ 不建卡。
- **{items} 包装透传实施**：backlog 卡 t-mw1ri0ep-8vw7ql，用户 2026-11-04 裁定不自动执行 → 保持 backlog。
- **上游 issue 提交**：材料已备（docs/upstream-feedback-0.10.3.md），提交与否由用户裁决。
- **架构级健壮性**（M-8 超时取消、M-9 流式截断、M-10 进程树清理）：涉及核心客户端/CLI 语义重构，
  需设计评估 → backlog（未授权执行）。
- **M-6 别名扩展（window/window_label/checkpoint_label）**：行为增强，涉及 alias 表与测试 →
  可实现但优先级低，与 T 组测试增强同批处理。
  **【2026-11-05 改判，批十 1/2】** 复核上游 crate 源码后：该别名由上游 serde alias 直接识别，
  插件不需本地归一；真实缺口是 schema 未登记别名键 → 已由批十 1/2 修复（描述层登记），
  **M-6 结案**。

## 建卡映射（批八及以后）

| 差距                                                                                                                                                                         | 卡                          | 类型                                                   | 状态 / 提交                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------- |
| S-3 renderJson 丢 cursor                                                                                                                                                     | 批八 1/4                    | todo（当场执行）                                       | 已执行 ae52849                                                    |
| P1-1 backend_args + P1-2 animation clear + P2-4/P2-5 别名标注                                                                                                                | 批八 2/4                    | todo（当场执行）                                       | 已执行 d03646a                                                    |
| T-1/T-2/T-3/T-4/T-5 测试增强 + D-5 doctor 口径                                                                                                                               | 批八 3/4                    | todo（当场执行）                                       | 已执行 6e69c90/61bd44b                                            |
| D-1/D-2/D-3/D-4 文档同步 + E-2 demo-app README                                                                                                                               | 批八 4/4                    | todo（当场执行）                                       | 已执行 fb3cb97                                                    |
| L-5 css/selector 主别名方向（勘误后按双层口径改描述）                                                                                                                        | 批九 1/3                    | todo（当场执行）                                       | 已执行 71112e7                                                    |
| E-1 smoke 后端日志链路检查                                                                                                                                                   | 批九 2/3                    | todo（当场执行）                                       | 已执行 4a60d7c                                                    |
| L-5/L-7 结论勘误 + M-1 归属澄清 + L-1 kind 词汇表边界                                                                                                                        | 批九 3/3                    | todo（当场执行）                                       | 已执行 10c5522                                                    |
| P2-5 勘误 + M-6 别名登记（serde alias 口径收口）                                                                                                                             | 批十 1/2                    | todo（当场执行）                                       | 已执行 82d1afe                                                    |
| T-6 route 0.10.3 细化口径（ipc_warning/mock_unreadable/add 拒绝）                                                                                                            | 批十 2/2                    | todo（当场执行）                                       | 已执行 36dea69                                                    |
| route 0.10.3 行为边界小节 + 数组结果形状小节 + README 冒烟口径同步（P3-5 口径解耦实由 be544f6/eb549f3 落地，本卡只回填其状态）                                               | 批十一 1/3                  | todo（当场执行）                                       | 已执行 e5f11d7（t-mw319n85-0anjn0）                               |
| P3-5/M-2/M-3/M-4/L-11 状态回填 + 归属澄清 + 映射表登记                                                                                                                       | 批十一 2/3                  | todo（当场执行）                                       | 已执行 de85d4b（t-mw31a0yi-gp1khz）                               |
| 数组型工具描述补 {items} 统一说明（standalone + compound 两处 catalog）                                                                                                      | 批十一 3/3                  | todo（当场执行）                                       | 已执行 e98546f（t-mw31b5gs-0czoj5）                               |
| docs/TOOLS.md 数组影响面清单订正（移除误列的 trace/fault、补 5 个漏列工具）+ 文档影响面同源护栏                                                                              | 批十二 1/1                  | todo（当场执行）                                       | 已执行 855f6c2（t-mw351p2r-b6rxos）                               |
| S-1/S-2 错误信封 + 401 重发现（**含 M-1 kind 映射与 status 透出**）                                                                                                          | backlog-A t-mw2eut5k-6k1elc | backlog → todo（用户 2026-11-05 裁决授权）             | 已执行 649b392（in_review v18）                                   |
| M-2/M-3/M-4 实现层 + M-5/M-7/M-8/M-9/M-10 + L-3/L-4/L-9/L-10/L-11（M-2/M-3/M-4 的描述层已由批十一 1/3 结案；M-6 已在批十 1/2 整体结案故不在本卡范围；T-6 已在批十 2/2 结案） | backlog-B t-mw2evd2u-0dukch | backlog → 评估后拆卡（用户圈定：小改全做、需设计暂缓） | 评估提案落盘；小改拆批十三 1/2+2/2（见下两行）；需设计/架构级暂缓 |
| M-10a CLI timeout_ms 夹取宿主预算 + L-10 图像落盘 20MiB 上限（backlog-B 小改 1）                                                                                             | 批十三 1/2                  | todo（当场执行）                                       | 已执行 48d8acb（t-mw36ua1v-848yxm，in_review v13）                |
| M-4 ignored_args 提示 + M-5 eval_js 45s 预算声明（backlog-B 小改 2）                                                                                                         | 批十三 2/2                  | todo（当场执行）                                       | 已执行 1010ca9（t-mw36ua79-1fkccm，in_review v11）                |
