# round-6：批九系列（自我纠偏后的可执行小改批次）（2026-11-05）

## 本轮缘起：一次自我纠偏

round-5 收敛后复核产物，发现**一处内部不一致**：

- `docs/audit/2026-11-05/gap-list.md:169` 把 M/L 全组划为 backlog；
- 但 backlog-B 卡（t-mw2evd2u-0dukch）自己的清单第 3 项写着「小改可当场做（M-1 kind 扩展、L-5 css/selector 归一、L-7 points 默认值、D 组残余）」。

按父卡授权「**可实现差距建 todo 当场执行；仅评估类建 backlog 并写明未授权执行**」，L-5 / L-7 / L-1 属**可实现的小改**，不应整组留在 backlog。故本轮重建「批九」批次执行真正可实现的部分，把需要设计或架构级改造的项（M-8 超时不取消服务端执行、M-9 大响应全量进内存、M-10 CLI kill 无升级、M-6 上游别名扩展、M-7 discovery PID 校验、M-5 eval 超时旋钮）继续留在 backlog。

本轮同时核实了 gap-list 中两条差距的**事实前提本身有误**（L-5 方向、L-7 定性），一并勘误。

## 本轮三张卡

| 卡                                          | 承载差距                                              | 改动文件                                                                                                                       | 提交                          |
| ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| 批九 1/3 t-mw2vu3ia-1nycp9（in_review v12） | L-5 css/selector 主别名方向 + L-7 points 默认值口径   | src/tools/standalone/catalog.ts、src/tools/compound/catalog.ts、docs/upstream-feedback-0.10.3.md、src/tools/contract.test.ts   | 71112e7、413536c              |
| 批九 2/3 t-mw2vurjc-ohuyvq（in_review v10） | E-1 smoke 无后端日志链路                              | scripts/smoke.mjs                                                                                                              | 4a60d7c、38446ec              |
| 批九 3/3 t-mw2vv36c-h0qtpy（in_progress）   | L-5/L-7 结论勘误 + M-1 归属澄清 + kind 三套词汇表边界 | src/errors.ts、src/tools/cli-status.ts、src/tools/tools-list.ts（**仅注释**）、docs/TOOLS.md、gap-list.md、插件功能审查总结.md | 10c5522、1d80097（risk 文档） |

## 关键结论（本轮新增事实）

### 1. L-5 勘误：不是版本翻转，是「文档层 vs 源码/schema 层」长期并存

| 层                 | 口径                                          | 证据                                                                               |
| ------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------- |
| 上游文档层         | **selector 主名、css 为别名**（0.8.8 起未变） | v0.8.8 tools-reference.md:136、v0.10.2 同文件:157、v0.10.3 同文件:157              |
| 上游源码/schema 层 | **css 主名、selector 为别名**（0.8.8 起未变） | 0.8.8 other_params.rs:147-150、0.10.2 :173-176、0.10.3 :181-184、0.10.3 mod.rs:726 |

- 结论：gap-list 原写的「0.10.3 翻转」是**误判**——文档层从未翻转，分歧自 0.8.8 起长期并存。
- 插件口径：跟 0.10.3 文档基线 → `selector` 为主名、`css` 为别名；两键上游均接受、语义等价；同传时 0.10.3 源码取 `css`（`params.css.as_ref().or(params.selector.as_ref())`），故 `selector` 描述补「此时 selector 被忽略」。
- 依据：`docs/upstream-feedback-0.10.3.md` 第 5 条（按「长期错位（≥0.8.8）」框架写，附文档行号与源码行号，并给出上游建议口径）。

### 2. L-7 改判：不是插件缺陷，是上游自身矛盾

- 上游 markdown `tools-reference.md:1012` 写 `points` 默认 **6**（示例 :1025 用 points:6）；
- 上游 schema doc-comment 写 **Default 20, clamped to 2..120**（v0.10.3 compound_params.rs:771-772，字段 :773；v0.10.2 对应 :767-768 / :769）；
- 上游实现 `mod.rs:3551`：`let points = params.points.unwrap_or(20).clamp(2, 120);` —— 0.8.8 / 0.10.2 同为 20。
- 结论：文档的 6 是上游 v0.8.8 时代遗留，**插件跟 schema 口径 20 是正确的**，改成 6 反而错。L-7 从「插件待修」改判为「上游口径矛盾，已写入上游反馈材料第 6 条」。

### 3. M-1 归属澄清：并入 backlog-A

M-1（错误 kind 词汇表扩展 + HTTP status 透出）与 S-1（上游工具级失败裸错误无 kind/hint）、S-2（客户端永不失效 / 401 不重发现）三者**都要改 src/client.ts 与 src/tools/standalone/bridge.ts**，并行实施会同文件双写。故 M-1 并入 backlog-A（t-mw2eut5k-6k1elc）的设计范围——错误 kind 映射表本来就要在 backlog-A 里出。本轮**不实施** M-1，只做归属澄清与 kind 三套词汇表的**语义域边界说明**（注释 + 文档，不改任何运行时取值）。

三套词汇表边界（已在源码注释与 docs/TOOLS.md 落盘）：

| 词汇表        | 位置                    | 取值                                                                                                               | 语义域                |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------- |
| REST 桥接错误 | src/errors.ts           | no-instance / instance-incomplete / no-live-instance / http-error / timeout / tool-error / cli-error（7 值，封闭） | REST 工具调用错误信封 |
| CLI 探测域    | src/tools/cli-status.ts | not_found / cli-error / timeout                                                                                    | CLI 探测结果          |
| 工具发现域    | src/tools/tools-list.ts | not_exposed / missing_on_server（出现在 warnings 而非 error）                                                      | 工具发现差异报告      |

三者**语义域不同、不可互相比较**（例如 CLI 探测域的 `not_found` ≠ REST 域的 `no-instance`）。

### 4. E-1 固化：smoke 新增后端日志链路检查

`scripts/smoke.mjs` 由 9 项扩到 10 项：

- 新增第 9 项「logs（后端日志动作可用性）」——`POST /api/tools/logs {action:"backend_digest"}`；服务端 ≥ 0.10.2 断言 `result` 含 `sources` / `buffered`；< 0.10.2 按版本 SKIP 并写明原因。
- 扩展第 8 项 `invoke_command`——≥ 0.10.2 时带 `with_logs:true`，断言 REST 信封两层形状（`body.result` 为对象、`.result` 含 `Hello, smoke!`、`.backend_logs` 是数组、`.backend_log_cursor` 是数字，且该游标是**调用起点游标**）。
- 版本门控加固：容忍 `v` 前缀、按 semver 视预发布版（`0.10.2-rc.1`）低于同号正式版、不可解析按「不满足」处理（宁可跳过，不做乐观假设）。
- `check()` 支持 `{skipped:true, detail}`，摘要单列 SKIP 且分子只算真通过项。

## 本轮验证

- **V1**：`pnpm typecheck` exit 0；`pnpm test` = **17 files / 192 tests passed**；`pnpm lint` exit 0；`pnpm format:check` 全绿。
- **smoke 活体**：`SMOKE_SKIP_BUILD=1 node scripts/smoke.mjs` → **10/10 全 PASS**，exit 0，1620ms，demo-app pid=25808，服务端 `victauri 0.10.3 @7373`。
  - 第 8 项：`greet → "Hello, smoke!"`（backend_logs 0 条，backend_log_cursor=0）
  - 第 9 项：`logs{action:"backend_digest"} → sources/buffered 齐备`（buffered=0；demo-app 未装 log_layer/log_logger，属「无捕获源」正常形态）
- **V2 交叉复核**：批九 1/3 由独立子代理审出 9 条（3 中 6 低，核心是「文档层从未翻转」的事实纠正），全部修复后重跑 V1 全绿才提交；批九 2/3 由独立子代理审出 7 条全低 severity，全部修复后重跑 V1 全绿才提交；批九 3/3 结论与文档一致性由独立子代理复核（结果见该卡评论）。

## 看板状态（本轮结束）

- todo **0**；in_progress 0；in_review 15（含批九三卡）；backlog 3（t-mw1ri0ep-8vw7ql 用户裁定 / backlog-A 含 M-1 / backlog-B，均 waitingForHuman）；done 18（未动）。
- 本轮**未移动任何卡到 done**。

## 剩余缺口（全部属非可执行类，待用户裁决）

1. 🔴 S-1 / S-2 / M-1 → backlog-A（t-mw2eut5k-6k1elc，waitingForHuman）：错误信封失效、客户端永不失效 / 401 不重发现、错误 kind 扩展与 HTTP status 透出——三者同域，需先出设计提案再实施。
2. 🟡 M-3~M-10 / L-1~L-11 → backlog-B（t-mw2evd2u-0dukch，waitingForHuman）：M-8 / M-9 / M-10 属架构级。
3. 上游反馈材料（docs/upstream-feedback-0.10.3.md，含 css/selector 长期错位与 points 默认值矛盾两条新条目）→ 是否向上游提 issue 由用户裁决。
4. {items} 包装透传 → t-mw1ri0ep-8vw7ql，用户 2026-11-04 已裁定不纳入自动执行。

## 执行方式声明（沿用）

ralph 工具 3 次失败 + 子代理累计 10 次启动失败 → 按父卡预置降级路径改为**同会话串行轮次、Lead 亲自执行**，V2 优先用独立子代理、子代理不可用时 Lead 自查并在报告如实记录。实际轮次：round-0（基线）→ round-1（批八 1/4）→ round-2（批八 2/4）→ round-3（批八 3/4）→ round-4（批八 4/4）→ round-5（收敛检查）→ round-6（本轮，批九系列）——共 7 个轮次文档，未达 20 轮上限。
