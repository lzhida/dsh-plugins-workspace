# 批十三 2/2（t-mw36ua79-1fkccm）残余风险自评

- 卡片：t-mw36ua79-1fkccm「未知参数 ignored_args 提示与 eval_js 超时旋钮（M-4+M-5）」
- 日期：2026-11-05
- 分支：dev（未 push）
- 关联：backlog-B 评估提案（docs/audit/2026-11-05/backlog-B-evaluation.md）圈定的「小改全做」两张卡之一；另一张为批十三 1/2（t-mw36ua1v-848yxm，48d8acb）。

## 一、本卡做了什么

| 条目                           | 处理前                                                                          | 处理后                                                                                                                                                      | 依据                                                                                                |
| ------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| M-4 未知参数静默透传（实现层） | toJsonArgs 收敛后原样发送，未知键被上游静默忽略且模型无感知                     | `collectIgnoredArgs`（src/tools/standalone/bridge.ts）收集「schema 未声明且非上游正式别名」键，结果顶层附加 `ignored_args`（排序确定）；发送内容不变        | 上游三版均无 deny_unknown_fields（backlog-A 订正）；透传语义不改变                                  |
| M-4 上游别名不误报（V2 中-1）  | 初版 known 集合漏上游 serde 别名：eval_js{window}、recording{label} 被误报      | 新增导出 `UPSTREAM_WINDOW_ALIAS_TOOLS`（23 工具，webview_label 字段带 alias window/window_label）与 `UPSTREAM_EXTRA_ALIASES`（screenshot/window/recording） | 0.10.3 源码逐一核对（webview_params.rs:12/:39、window_params.rs:8、compound_params.rs:291/:457 等） |
| M-5 eval_js 无 per-tool 超时   | 未声明 requestBudgetMs → 走客户端默认 30s；上游 app 级 eval_timeout 可配至 300s | eval_js spec 声明 `requestBudgetMs: 45_000`（catalog.ts 注释含上游证据、取值理由与覆盖语义）                                                                | 0.10.3 webview_params.rs:7-13 无 per-call 参数；lib.rs:549 默认 30s / :1007-1013 校验 ≤300s         |

改动文件（5，全部在卡面允许范围）：src/tools/standalone/bridge.ts、src/tools/standalone/catalog.ts、src/tools/standalone/standalone.test.ts、src/tools/standalone/timeout.test.ts、src/tools/compound/bridge.test.ts。

## 二、已闭合的验收点

- C1 M-5 前置查证：上游确无 per-call 超时参数，按清单走「不支持」分支（声明预算 + 注释错位说明）。证据：webview_params.rs:7-13、lib.rs:549/:1007-1013（V2 低-8 行号订正）。
- C2 M-4 透传语义不变：突变 M1（撤 ignored_args 附加）→ compound route + standalone 主用例 2 项 RED；`calls[0].args` 断言未知键仍原样发送。
- C3 M-4 可观测性：ignored_args 按字母排序（突变 M3 撤 `.sort()` → 排序断言 RED）；无未知键时零行为变化（`'ignored_args' in result === false`）。
- C4 误报防护：schema 声明键（eval_js.expression / query_db.sql 归一后已从请求移除）不误报；上游正式别名（eval_js.window/window_label、recording.label、window.webview_label/window/window_label）不误报（V2 中-1 修复 + 配套用例）；图像通道与错误信封不附加（各配专用用例，V2 低-3 补图像通道）。
- C5 M-5 声明：eval_js === 45_000（突变 M2 撤声明 → 2 项 RED：取值断言 + declarers 守卫）；declarers 口径守卫 `['eval_js','introspect','trace']`；桥集成第三参断言 calls[0].budget === 45_000（V2 低-9）。
- C6 先红后绿：实现前 RED 基线 4 failed（timeout 2 + standalone 1 + compound 1），实现后目标三文件全绿。
- C7 V1 全量（V2 修复轮复跑）：typecheck exit 0；test 18 files / 223 tests passed（+7）；lint exit 0；format:check 全绿。
- C8 smoke：SMOKE_SKIP_BUILD=1 → 10/10 PASS（1334ms，victauri 0.10.3 @7373）。
- C9 V2 修复轮闭环（V2 建议「卡内修掉中-1 + 低-2/低-3」，实际 9 条全处置，见下表）；同名键防御已实现（备用键 ignored_args_plugin，V2 低-5）并用例守护。

## 三、验证方式与结果

| 验证                                                 | 结果                                                                                                                                                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RED 基线（实现前）                                   | 4 failed：timeout.test.ts ×2（eval_js 预算 + declarers）、standalone.test.ts ×1（ignored_args 主用例）、compound/bridge.test.ts ×1（route 新契约）                                                                  |
| GREEN（实现后）                                      | 目标三文件 3 files / 39 tests passed；全量 18 files / 216 tests passed                                                                                                                                              |
| V2 修复轮复跑（终态）                                | 目标三文件 3 files / 46 tests passed（+7）；全量 **18 files / 223 tests**；typecheck / lint / format 全绿                                                                                                           |
| 突变·实现轮（定向反向替换，PowerShell UTF-8 无 BOM） | M1 撤 ignored_args 附加 → 2 RED；M2 撤 requestBudgetMs → 2 RED；M3 撤 `.sort()` → 1 RED；还原后全绿                                                                                                                 |
| 突变·修复轮                                          | M1 撤 window 别名组（if false）→ 1 RED（standalone eval_js 别名用例）；M2 备用键改恒 `ignored_args` → 1 RED（ignored_args_plugin 用例）；M3 撤 EXTRA 表 recording 条目 → 1 RED（compound 别名用例）；逐案还原后全绿 |
| 上游事实复核                                         | 本机 cargo registry victauri-plugin-0.10.3 源码直读（C1/C9 行号）                                                                                                                                                   |
| smoke                                                | 10/10 PASS（1334ms）                                                                                                                                                                                                |
| V2                                                   | 子代理 6eeaaa9f-869d-4500-8862-44e5937b8713 只读审阅，PASS_WITH_NITS（1 中 + 8 低）→ 修复轮全处置                                                                                                                   |

## 四、V2 问题处置台账（1 中 + 8 低，全闭环）

| #    | 级别 | V2 指出                                                                               | 处置                                                                                                                                                              |
| ---- | ---- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 中-1 | 中   | known 漏上游 serde 别名：eval_js{window}、recording{label} 被误报，与插件自身描述矛盾 | 修：bridge.ts 新增两张导出表 + collectIgnoredArgs 接入；standalone/compound 各配行为用例 + 漂移守卫（成员 ⊆ 真实 spec、组员必声明 webview_label、组规模 23 锚点） |
| 低-2 | 低   | ARG_ALIASES 登记分支死代码（别名键归一时已删且 alias[1] 本是声明键）                  | 修：删死分支；用例③改名「schema 声明键不误报(expression/sql 经本地归一后已不在请求中)」                                                                           |
| 低-3 | 低   | 图像通道「不附加 ignored_args」无用例守护                                             | 修：新增 screenshot + 未知键 + 图形结果用例（有 path、无 ignored_args，rmSync 清理）                                                                              |
| 低-4 | 低   | 本自评初版夸大「图像通道…专用用例」                                                   | 修：本文档已订正（C4 现为真实用例名，第三节补修复轮突变行）                                                                                                       |
| 低-5 | 低   | ignored_args 同名键语义漂移（上游若返回同名键会被覆盖）                               | 修：`'ignored_args' in record` 时插件提示改用 `ignored_args_plugin` 备用键（两键并存），配套用例守护；R1 由「不改名登记」升级为「已实现备用键防御」               |
| 低-6 | 低   | 声明预算覆盖用户 requestTimeoutMs 未说明                                              | 修：catalog.ts 注释与 eval_js 描述写明「经 client.callTool 第三参覆盖构造配置，固定 45s 不随全局放大」                                                            |
| 低-7 | 低   | 已声明但上游不认的键不在提示面                                                        | 登记（本节 R5）：app_state / fault 上游结构体无 webview_label 字段；logs.bodies 0.10.2 不存在                                                                     |
| 低-8 | 低   | lib.rs 行号 :1007-1010 不完整                                                         | 修：改 :1007-1013（含 InvalidEvalTimeout 校验闭区间语义「1s<t≤300s」）                                                                                            |
| 低-9 | 低   | timeout.test.ts 缺 eval_js 第三参集成断言                                             | 修：桥集成 describe 新增用例 calls[0].budget === 45_000                                                                                                           |

## 五、剩余风险

| 风险                                     | 级别 | 说明与处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 备用键 ignored_args_plugin 的观察成本 | 低   | 上游同名键冲突时插件提示落在备用键上，模型需两键都看。当前 35 个工具无任何上游工具返回 ignored_args 键名（批十一 3/3 数组形状表取证），防御属纯兜底。                                                                                                                                                                                                                                                                                                                                                   |
| R2 漏报面（非 JSON 键）                  | 低   | toJsonArgs 丢弃的 undefined / 非 JSON 值键不会进入 callArgs，也就不会上报。此类键本就不会被发送，上报「未发送」反而误导；行为视为正确语义，登记备忘。                                                                                                                                                                                                                                                                                                                                                   |
| R3 M-5 预算错位仍存在                    | 中   | 45s 只覆盖上游默认档（30s）的余量；app 端若把 eval_timeout 配到 300s，本通道 45s 仍会先放弃（服务端继续执行，gap-list M-8「超时不取消服务端执行」在 backlog-B 架构级清单中，不建议自动执行）。注释与描述均如实声明。                                                                                                                                                                                                                                                                                    |
| R4 ignored_args 仅桥层可见               | 低   | compound 与 standalone 共用同一工厂（createRestBridgeTool），两条链路均已覆盖；CLI 桥（victauri_cli）无此机制，属不同通道不适用。                                                                                                                                                                                                                                                                                                                                                                       |
| R5 已声明但上游不认的键（V2 低-7 备忘）  | 低   | ①app_state / fault：0.10.3 AppStateParams（other_params.rs:157，仅 probe）/ FaultParams（introspection_params.rs:124-142）**没有 webview_label 字段**，插件 schema 多声明的 webview_label 会被上游静默忽略（fault 与上游 issue 材料 4b 同源）；②logs.bodies 在 0.10.2 不存在（0.10.3 LogsParams 有）。这类键在 known 集合内故不被 ignored_args 提示——属「插件声明 ≠ 上游接受」的 schema 层问题，超出本卡范围（M-4 只观测「schema 未声明」的键），不改 schema。后续如做 schema 对齐可在 backlog-B 评估。 |
| R6 别名表随上游版本漂移                  | 低   | UPSTREAM_WINDOW_ALIAS_TOOLS / UPSTREAM_EXTRA_ALIASES 按 0.10.3 源码登记；上游新版本若增删 serde alias，表会过期。漂移守卫只保证「表与插件 catalog 自洽」，不保证「表与上游新版本一致」——上游升级时需复核。                                                                                                                                                                                                                                                                                              |

## 六、可执行残余缺口

无。R1-R6 均为记录性风险，不产生新卡；M-8/M-9 等架构级条目仍在 backlog-B（t-mw2evd2u-0dukch）按用户裁决推进。

## 七、纪律声明

- 提交均在 dev 分支，Conventional Commits 中文格式，未 push、未 force-push、未在 main/master 提交。
- 失败步骤 ≤3 次：实现轮 RED 基线 1 次到位；compound 用例首跑因 recording 无 `list` action 报 ToolArgsError 1 次（改 `list_checkpoints` 后绿，属用例笔误非实现缺陷）；修复轮突变 M1-M3 逐案定向反向替换还原，未用 git checkout / 备份还原。
- 未将任何任务卡移入 done；smoke 为本地冒烟不进 CI。
