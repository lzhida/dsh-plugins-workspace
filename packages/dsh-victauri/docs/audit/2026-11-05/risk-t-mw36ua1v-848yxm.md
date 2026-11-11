# 批次风险自评：批十三 1/2（t-mw36ua1v-848yxm）CLI timeout_ms 上限 + 图像落盘字节上限

日期：2026-11-05 ｜ 卡片：t-mw36ua1v-848yxm（backlog-B 小改组卡 1，用户裁决「全做，拆 2 卡」授权）｜ 关联差距：M-10a、L-10

## 一、本卡做了什么

| 条目                  | 改动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 依据                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| M-10a timeout_ms 夹取 | `src/tools/cli.ts`：TOOL_TIMEOUT_MS 更名导出为 `CLI_MAX_TIMEOUT_MS`（300_000 值不变），execute 内 `Math.min(Math.max(requestedTimeoutMs, 1), CLI_MAX_TIMEOUT_MS)`（上限夹取 + 非正数兜底）；timeout_ms 描述改模板串引用 `CLI_DEFAULT_TIMEOUT_MS`/`CLI_MAX_TIMEOUT_MS`（同源渲染「默认 120000;上限 300000=宿主工具预算…」）；工具声明 `timeoutMs` 字段复用同一常量                                                                                                                                       | 宿主在 300s 放弃工具调用，子进程超时不得大于它——消除孤儿窗口；gap-list M-10a |
| L-10 图像字节上限     | `src/tools/standalone/image.ts`：新增导出 `IMAGE_SAVE_MAX_BYTES = 20MiB`，saveImage 在 writeFileSync 前检查 `buf.byteLength`（base64 解码后字节数），超限 throw（消息含实际字节与上限）→ bridge.ts applyImageChannel 既有 catch 回退 `{...toRecord(result), image_save_error}`                                                                                                                                                                                                                          | 卡面明示取舍「抛错走既有回退」；gap-list L-10                                |
| 测试                  | `src/tools/cli.test.ts`：夹取矩阵（默认 120000 / 超限 3600000→300000 / 小值 1500 直传 / **0 与 -1 → 1**，capturingRun 桩捕获真实 timeoutMs，**version:'0.8.8' 显式注入跳过探测**）+ 描述同源护栏（defineTool 包装后取 `parameters.properties.timeout_ms.description`）+ **不变量护栏 `victauriCliTool.timeoutMs === CLI_MAX_TIMEOUT_MS`**；`src/tools/standalone/image.test.ts`：超限抛错正则（不落盘）+ 恰好等于上限落盘（> 不含等于边界）+ 经桥回退 image_save_error（真实 saveImage 路径，非注入桩） | 反向可证伪实测                                                               |

## 二、已闭合的验收点

- C1 实现前事实核对评论（c-mw383b3r-xh7o4s）：cli.ts:99-102 无 max、:288 直透；image.ts:82-97 无字节上限、回退链路 saveImage→normalizeImageResult→applyImageChannel catch 逐环确认。
- C2 M-10a 夹取 + 描述同源 + 非正数兜底。
- C3 L-10 常量 + 抛错 + 既有回退兜底。
- C4 护栏反向可证伪：撤销夹取 → cli.test.ts **1 failed**（RED）；撤销上限（`if (false)`）→ image.test.ts **2 failed**（RED）；还原后两文件 **36 passed**。
- C5 V1 四件套全绿；C6 V2 独立审（子代理完成）；C7 V2 问题修复并重跑 V1 全绿；C8 提交 + risk 落盘；C9 看板交接。

## 三、验证方式与结果

- V1（修复后终态）：typecheck exit 0；**vitest 18 files / 212 tests passed**；lint exit 0；format:check 全绿（修复轮 prettier --write 一次：cli.ts 长行超宽，1 次/3 上限内）。
- V1 修复记录（首跑 2 failed，2 次/3 上限内）：①测试从 `../cli.ts`（根 cli.ts，仅导出 CLI_DEFAULT_TIMEOUT_MS）导入 `CLI_MAX_TIMEOUT_MS`（实际定义在 `src/tools/cli.ts`）→ 拆成两条正确来源导入；②parameters 访问未考虑 defineTool 的 JSON Schema 包装（顶层是 `{type,properties,required}`）→ 改取 `.properties.timeout_ms.description`；node 直连探针确认描述渲染值正确。
- 突变（定向替换 A→B 测试后 B→A 还原）：M1 撤夹取 → RED 1；M2 撤上限 → RED 2；还原 36 passed。
- V2 独立审（subagent c6d2cf8d-54f3-4e89-85d6-9211079b5888，只读合规，探针落系统临时目录）：**PASS_WITH_NITS**，2 中 + 6 低 + 1 提示；实跑佐证：CLAMP 矩阵（正数超限 → 300000；0/负数透传）、FLOAT_REJECTED（小数被 schema integer 拒绝）、OVERSIZE_THROW（超限不落盘，LEAKED_FILES []）、MULTI_FALLBACK（首图落盘成孤儿 + image_save_error）、PROBE（真实 spawn node --version 159ms 且把 26.3.1 当 CLI 版本）。
- **V2 问题处置**（修完重跑 V1 全绿后才提交）：
  - 中-2 缺不变量断言 → 已补 `expect(victauriCliTool.timeoutMs).toBe(CLI_MAX_TIMEOUT_MS)`（宿主预算下调而常量未同步时护栏失效的防线）。
  - 低-3 夹取用例真实 spawn node --version 且污染 cli-status 60s 模块缓存 → 已注入 `version: '0.8.8'`（resolveCliVersion :69 对显式 version 直接短路）。
  - 低-4 `Math.min` 不挡 0/负数（schema DSL 无 minimum）→ 已加 `Math.max(requestedTimeoutMs, 1)` + 0/-1 → 1 两条断言。
  - 低-7 冗余断言（`not.toBe('子进程超时毫秒(默认 120000)'` 被 toContain 蕴含）已删；cli.ts:16 遗留旧注释「工具层执行预算…给满 5 分钟」已删。
  - 中-1 exec.signal 未转发（孤儿窗口从无界缩到 ≤探测耗时 ~10s，未彻底闭合）→ **不修，归 M-10b**（见下节 R5）。
  - 低-5 多图整次回退/孤儿文件、低-6 测试内存峰值 → 卡面取舍，已在风险表登记。
  - 低-8 两超时常量分居两模块 → 可维护性 nit，不修（避免越界扩面）。

## 四、剩余风险

| 风险                              | 级别           | 说明与处置                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多图数组单张超限 → 整次回退       | 低（卡面取舍） | 已落盘的前几张路径随整次回退丢失，错误信息可辨（image_save_error）；卡面明示「抛错走既有回退」，未实现逐张跳过。如需逐张跳过再建卡。                                                                                                                                                                                                                                                                       |
| 上限值 300_000 / 20MiB 为硬编码   | 记录           | 与宿主 300s 预算绑定（注释已写明因果）；上游/宿主预算变化时需同步两处常量。                                                                                                                                                                                                                                                                                                                                |
| 测试内存峰值                      | 记录           | 字节上限用例分配 20MiB 级 Buffer（base64 约 28MB 字符串 ×2 用例），实测通过；如 CI 内存受限可改注入式小上限测试。                                                                                                                                                                                                                                                                                          |
| CLI 实际行为 0.8.8 活体未复测夹取 | 记录           | 夹取逻辑在插件侧（run 收到的 timeoutMs 由桩验证），与 CLI 版本无关；真实 spawn 路径由既有 timeout_ms:1 用例覆盖。                                                                                                                                                                                                                                                                                          |
| exec.signal 未转发（M-10b）       | 中（既有差距） | `runVictauriCli`（src/cli.ts:50-115）不接 exec.signal、无 SIGKILL 升级、不杀子孙：宿主 abort 不会杀子进程，夹取只把孤儿窗口从「无界」缩到「≤cli-status 探测耗时 ~10s」。dsh-tools 契约（index.d.ts:152-158）声明 timeoutMs 即断言转发 exec.signal 的「合作式预算」前提未真正满足。属 gap-list M-10b（backlog-B 评估归类「架构级：跨平台真实测试不建议自动执行」），不在本卡范围，保持 backlog 待用户裁决。 |

## 五、可执行残余缺口

无新增。逐张跳过策略（R1）属可选增强；exec.signal 转发（R5）属既有 M-10b 架构级差距，已在 backlog-B 评估提案归类并等待用户裁决，不重复建卡。

## 六、纪律声明

提交落 dev 分支、Conventional Commits 中文；仅动卡面 4 个允许文件；未 push、未 force-push、未在 main/master 提交；失败步骤（V1 首跑 2 failed、修复轮 format 1 次）均 ≤3 次并已记录；V2 问题修完重跑 V1 全绿后才提交；本卡未移入 done。
