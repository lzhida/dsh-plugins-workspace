# 残余风险自评 · 批六 2/4（t-mw1vb617-0knszj）

- 卡片：t-mw1vb617-0knszj「批六 2/4：compound schema 补齐(logs/window/route/recording/storage)+ 描述修正」
- 提交：`f9f3c34` feat(compound): 对齐 0.10.3 的 logs/window/route/recording/storage schema（dev，未 push）
- 自评日期：2026-11-05
- 范围：仅 `src/tools/compound/catalog.ts` + `src/tools/contract.test.ts`

## 一、本卡已闭合的风险

| 编号 | 风险                                                                                                                | 处置                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| C1   | logs 缺 backend/backend_digest/stdout 三动作与 level/target/since_seq/fields/bodies 五参数 → 后端日志链路整体不可达 | 已补；描述含游标方向、stdout next_seq 不透明/gap、捕获来源门槛                                     |
| C2   | route 沿用「fulfill 仅 fetch、XHR 回退 delay」旧口径，且 Tauri IPC 规则缺失                                         | 已改 0.10.3 口径并写全五条 IPC 规则                                                                |
| C3   | recording 的 replay 描述「与基线比对」与上游 0.10.x 不符                                                            | 已改为上游口径（只重放无参成功调用、skipped/blocked、不与原响应 diff、按录制窗口重放、副作用真实） |
| C4   | storage 的 get_cookies 旧文案「取全部 Cookie」错误                                                                  | 已改为仅非 httpOnly（源码级证据）                                                                  |
| C5   | explain/fault 的 webview_label 标 [INFERENCE] 未定稿                                                                | 已按 0.10.2 crate 源码定稿并附行号证据                                                             |
| C6   | 版本标注事实错误（称 0.10.2 无 level/target/since_seq/fields）                                                      | 已改为 0.8.8 全无、0.10.2 起含四项（仅 bodies 缺失），并逐参标注来源                               |

## 二、本卡遗留的残余风险（未闭合项）

### R1（中）· logs.bodies 是 0.10.3 文档单源，旧服务端静默忽略

- 证据：插件 `src/tools/compound/catalog.ts` 的 `logs.bodies` 参数；上游 `[文档 0.10.3]` tools-reference.md 有 bodies，
  `[源码 0.10.2]` `victauri-plugin-0.10.2/src/mcp/compound_params.rs:840-872` 的 `LogsParams` 无该字段，
  CHANGELOG 全文无 bodies 作为参数；两版服务端均未开 `deny_unknown_fields` → 传给 0.10.2 会被静默忽略。
- 后果：在 0.10.2 服务端上，`bodies:false` 不生效，ipc/network 仍返回完整请求响应体，日志体积可能远超预期。
- 现有缓解：参数描述已写「[文档] 0.10.3 起（0.10.2 及以前的 LogsParams 无此字段，传入被静默忽略、不报错）」；
  logs 描述亦给出「旧服务端兼容性：新增动作报错 / 新增参数静默忽略」的通用口径。
- 剩余缺口：缺少「按服务端版本自动降级 bodies」的能力（需服务端 /info 暴露版本，或引入能力探测）。属**需上游/架构决策**，
  归入仅评估类 backlog。

### R2（中）· 文档与实现漂移（卡片范围外）

- 证据：`docs/TOOLS.md:50` 仍列 8 个 logs action、`:56` 仍列 6 个 window action；
  `src/tools/compound/catalog.ts` 已是 11 / 7。另有 `docs/TOOLS.md:36` 的 wait_for 条件清单未含 `log`。
- 后果：读者按 TOOLS.md 取枚举会拿到过期口径。
- 剩余缺口：可执行（改文档），归入「文档同步」todo 卡。

### R3（低-中）· 0.10.3 route 的两处可观测行为未覆盖

- 证据：上游 `[文档 0.10.3]` tools-reference.md 的 route 段：正则含歧义重复组时 `add` 直接被拒；
  `add` 拒绝 Tauri 读不动的 mock（`mock_unreadable`）、宽泛 pattern 返回 `ipc_warning`。
  插件 `src/tools/compound/catalog.ts` 的 route 描述只写到 `ipc_note`。
- 后果：模型在 0.10.3 上遇到 `add` 报错时无法从描述判断是「正则被拒」还是「mock 不可读」。
- 剩余缺口：可执行（补描述 + 用例），归入 todo 卡。

### R4（中）· compound 运行时透传层无独立测试

- 证据：`src/tools/compound/` 下只有 `catalog.ts` 与 `bridge.ts`（27 行，复用 standalone 的 `createStandaloneTools`），
  无 `src/tools/compound/bridge.test.ts`；`src/tools/standalone/standalone.test.ts` 只覆盖 standalone 工具。
- 后果：compound 侧参数经 `toJsonArgs` → `callTool` 的实际透传、类型收窄（如 `since_seq:'7'` 抛 ToolArgsError）
  无回归锁定；上游枚举越界时的报错文案漂移无法被测出。
- 剩余缺口：可执行（新建运行时透传测试），归入 todo 卡。

### R5（低）· since_seq 缺少下界约束

- 证据：客户端 schema 用 `integer`，dsh-tools 只校验 `Number.isInteger`，故 `since_seq:-1` 可通过校验；
  上游 `[源码 0.10.2]` `LogsParams.since_seq` 为 `u64`。
- 后果：负数游标会被服务端按 u64 反序列化拒绝，返回的服务端错误信息不如客户端前置校验友好。
- 剩余缺口：需确认 dsh-tools 是否支持 minimum 约束；不确定 → 归入仅评估类 backlog。

## 三、结论

- 本卡范围内的问题已全部闭合，V1（typecheck / test 15 files 161 tests / lint / format:check）全绿。
- 遗留 5 项残余风险中：R2、R3、R4 为**可直接实现的缺口**（归入六面差距清单，在父卡「按差距建卡」阶段建 todo 卡并当场执行）；
  R1、R5 为**需上游能力或架构决策的评估类**（归入 backlog，未授权执行）。
- 无「伪造通过」：所有结论均以本机 cargo registry 的 0.8.8 / 0.10.2 crate 源码行号或 0.10.3 官方文档行号为准；
  本机无活体 Tauri app（`mcp__victauri__get_plugin_info` 报 backend not reachable），故 [实测] 结论均沿用仓库内既有 0.8.8 记录。
