# 批次风险自评：backlog-A（t-mw2eut5k-6k1elc）错误信封细分 + 401/网络失败自动重发现

日期：2026-11-05 ｜ 卡片：t-mw2eut5k-6k1elc（backlog-A，用户已批准实施）｜ 设计提案：docs/audit/2026-11-05/backlog-A-design-proposal.md

## 一、本卡做了什么

| 条目               | 改动                                                                                                                                                                                                                                                                                                                                              | 依据                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| M-1 kind 细分      | `src/errors.ts`：VictauriErrorKind 7→11 值（+invalid-params/auth/not-found/rate-limited）；新增模块私有 `kindForStatus`（400→invalid-params、401/403→auth、404→not-found、429→rate-limited、其余 http-error）；VictauriHttpError 构造器改用该映射                                                                                                 | 设计提案 §2；上游 REST 错误只带 status 无 kind 语义 |
| S-1 工具级失败归一 | `src/client.ts` callTool 200 分支：顶层 object、非数组、含 error 键且无 result 键 → `VictauriError('tool-error', 'callTool(<tool>): upstream tool-level failure: <摘要≤500>')`                                                                                                                                                                    | 提案 §2-S-1；rest.rs to_rest_json 错误信封口径      |
| S-2 自动重发现     | `src/index.ts`：新增导出 `shouldResetClient`（VictauriHttpError 401/403→true；VictauriTimeoutError→false；其余 isVictauriError && kind==='http-error'→true）与 `ReconnectingVictauriClient`（四方法经 withReset 转发，命中复位回调后原样重抛）；clientPromise 类型改 `Promise<VictauriClientLike>`，接线 makeClient().then(wrap).catch(复位+重抛) | 提案 §3 方案 A（包装类）；bridge 38 工具零改动      |
| 类型最小公开面     | `src/client.ts` 末尾新增 `VictauriClientLike` 接口（callTool/info/listTools/health）；`src/tools/standalone/bridge.ts`、`src/tools/tools-list.ts` 的 getClient 类型改 `Promise<VictauriClientLike>`                                                                                                                                               | 包装类与本体同形可互换                              |
| 信封可选 status    | `src/tools/standalone/bridge.ts` toErrorValue：VictauriHttpError 时 spread `{status}`，其余错误不带该键（向后兼容）；:112 注释订正（上游对未知键是静默忽略，三版 crate 均无 deny_unknown_fields）                                                                                                                                                 | 提案 §2-M-1；本机 cargo registry 实测               |
| 文档同步           | README.md 故障排查行（auth 复位口径）；docs/TOOLS.md 词汇表 11 值 + 新小节「HTTP 分流与信封可选键」（机械映射/可选 status/S-1 行为变更声明/S-2 复现触发）                                                                                                                                                                                         | 对外口径与实现一致                                  |

## 二、已闭合的验收点

- C1 授权与提案：用户批准（评论 c-mw36ak2s-2jxqbf）、提案落盘并经用户圈定「照提案实施，4 决策点全认可」。
- C2 S-1 提案：kind 映射表 + S-1 归一口径（提案 §2）。
- C3 S-2 提案：重发现触发矩阵 + 方案 A（提案 §3）。
- C4 提案交用户裁决：ask_user_question 实答后按授权实施。
- C5（本轮 vvztfi）实施 + V2 审 + V1 全绿 + 提交 + in_review。

## 三、验证方式与结果

- V1 四件套：typecheck exit 0；**vitest 18 files / 208 tests passed**（含新增 client.test.ts 2 用例、reconnect.test.ts 矩阵+包装行为、standalone.test.ts 信封 status 用例、contract.test.ts 四文件锚点护栏）；lint exit 0；format:check 全绿（prettier --write 修复 docs/TOOLS.md 1 次）。
- 突变测试（定向替换 A→B 测试后 B→A 还原，无备份依赖）：
  - M1 errors.ts 401/403 改归 http-error → client.test.ts + contract.test.ts **3 failed**（RED）；
  - M2 index.ts 复位矩阵删 403 → reconnect.test.ts + contract.test.ts **3 failed**（RED）；
  - M3 docs/TOOLS.md 词汇表行删 auth 值 → contract.test.ts **1 failed**（RED）；
  - 还原后三文件 **31 passed**，全量 V1 复跑 208 passed。
- 上游事实现场复核：victauri-plugin-{0.8.8,0.10.2,0.10.3} 全仓 grep `deny_unknown_fields` 命中 0（注释订正依据）；rest.rs to_rest_json 信封形状（S-1 依据）。
- V2 交叉复核：子代理 1 次启动即因会话路由拒绝（glm-coding-plan-pro/glm-5.3-flash not allowed，与本会话此前 10+ 次同类失败同因，重试无意义）→ 按既定降级预案由 Lead 亲自执行五项核对（A 提案一致性/B 行为正确性/C 类型接线/D 测试质量/E 越界/F 文档一致）。核对发现并修复 1 处：S-1 条件补显式 `!('result' in parsed)` 排除（提案原文要求，虽然 result 解包在前不会误吞，显式化防将来重排）。修复后重跑 V1 全绿。

## 四、剩余风险

| 风险                   | 级别 | 说明与处置                                                                                                                                                                                                                                                                  |
| ---------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S-1 是行为变更         | 低   | 此前 HTTP 200 顶层 {"error"} 会作为数据透出给模型，现归一为结构化 tool-error——这正是修复目的；已在 docs/TOOLS.md 小节显式声明「行为变更」。                                                                                                                                 |
| 复位无防抖             | 低   | 服务端持续 401 时形成「调用→复位→重发现→再 401」循环，但每次调用独立、无放大故障，401 本身就是失败返回；403 同理。观察期后如需防抖再评估（需设计，本卡不加）。                                                                                                              |
| kindForStatus 覆盖面   | 低   | 仅机械映射四组状态码，上游将来引入新语义状态码需同步（封闭词汇表已注释声明）。                                                                                                                                                                                              |
| 包装类 inner 为具体类  | 低   | `ReconnectingVictauriClient.inner: VictauriClient`（非接口）；单测注入桩经 cast。仅测试便利性受限，生产行为无影响。                                                                                                                                                         |
| health/info 也经复位   | 记录 | 探活自身 401 亦触发复位——语义合理（token 失配就该重发现），无副作用。                                                                                                                                                                                                       |
| 突变过程事故（已恢复） | 记录 | 还原操作曾两次出错（`git checkout --` 误吞未提交实现；备份函数 -replace 未生效致备份缺失），均通过重放编辑/定向反向替换完整恢复，终态以 31+208 全绿与 git diff 统计（10 files +364/-42）复核确认。教训：突变还原一律用定向反向替换，不用 git checkout、不依赖路径替换备份。 |

## 五、可执行残余缺口

无。防抖（R2）与状态码扩展（R3）均属「需设计/随上游演进」类，不在本卡范围，已如实记录。

## 六、纪律声明

提交均落 dev 分支、Conventional Commits 中文格式；未 push、未 force-push、未在 main/master 提交；失败步骤（子代理路由 1 次、prettier 1 次、突变还原事故 2 次）均 ≤3 次并记录在案；本卡未移入 done。
