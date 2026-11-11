# Round 4（批八 4/4 t-mw2euhui-e3bo22）— 文档同步（D 组 + E-2）

- 日期：2026-11-05
- 执行方式：Lead 亲自执行（既定两级降级，已备案父卡）
- 承接差距：gap-list.md 面 2.5（D-1/D-2/D-3/D-4）+ 面 6（E-2）

## 完成

| 差距                      | 实现                                                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-1 logs 动作表 8→11 值   | docs/TOOLS.md compound 表 logs 行补 `backend` `backend_digest` `stdout`（注明 0.10.2 起后端日志动作），与 compound/catalog.ts 枚举一致                                                                                                                                                              |
| D-2 window 动作表 6→7 值  | 补 `introspectability` + 一句话语义（`introspectable:false` + `visible:true` 几乎总是缺 `victauri:default` capability）                                                                                                                                                                             |
| D-3 wait_for 条件清单     | 表行改「10 值闭集」并新增「后端日志与 0.10.x 新参数」小节，全量列出 10 值（text/text_gone/selector/selector_gone/url/ipc_idle/network_idle/expression/event/log）                                                                                                                                   |
| D-4 新参数关键词          | docs 新小节写全三段式（with_logs→backend_log_cursor→wait_for condition=log+since_seq→logs backend_digest，含脱敏后文本匹配与 since_seq 向前分页）+ find_elements 0.10.3 五新参（含 include_hidden）；README 特性列表补「后端日志三段式」与「元素查找 0.10.3 新参」两段                              |
| E-2 工具数口径            | demo-app/README.md 改「/api/tools（服务端 35 个工具清单——dsh 桥接后为 38 个 dsh 工具 = 35 上游 1:1 + 3 插件自有）」——**保留服务端 35 的正确口径**（该端点返回上游清单），同时补 38=35+3 桥接口径，避免把正确数字改错                                                                                |
| 护栏扩展（清单第 5 项）   | cli-hints.test.ts 新增用例「文档动作表与 catalog 枚举同源(logs/window/animation)+0.10.x 关键词锚点」：docs 动作表逐名锁定三工具全部枚举值、wait_for 10 值全量、README+docs 五关键词（timeout_ms/with_logs/since_seq/backend_log_cursor/include_hidden）、38/35 口径——catalog 改枚举而文档没跟时必红 |
| 连带修正（批八 3/4 漂移） | README CLI 桥段尾句「0.8.8 不提示 doctor --json」（旧口径）→「doctor 恒定提示不提供 --json：0.8.8 实测报 unexpected argument，0.10.3 源码亦无该选项」（与 61bd44b 的 D-5 口径一致）                                                                                                                 |
| 连带修正（批八 2/4 漂移） | docs/TOOLS.md animation 表 `list scrub sample clear`（4 值）→「list scrub sample（0.10.3 基线三动作；clear 已废弃，清空录制改经 sample 的 clear:true 参数）」（与 d03646a 枚举一致）                                                                                                                |

## V1

- pnpm typecheck 0；pnpm test：17 files / 191 passed（+1 护栏用例）；pnpm lint 0；pnpm format:check 全绿（首跑 FAIL 2 文件 → prettier --write 后绿，失败 1 次/3 上限）。

## V2

- Lead 亲自核对（子代理通道备案降级）：改动 4 文件全部在卡面允许清单内；护栏用例真实有效（删 docs 动作表任一枚举名或关键词即红）；E-2 保留服务端 35 口径的裁决已记录（防止把 /api/tools 的正确数字改成 dsh 口径）。

## 剩余

- round-5：收敛检查轮（无新增可执行缺口且无未处理 todo → 提前收敛）。
- 《插件功能审查总结.md》+ 父卡 18 项清单勾选 + 移 in_review。
