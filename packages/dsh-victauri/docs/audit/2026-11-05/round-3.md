# Round 3（批八 3/4 t-mw2eu6r5-uew7ds）— 测试增强与 doctor 口径修正

- 日期：2026-11-05
- 执行方式：Lead 亲自执行（ralph 通道 3 连败 + subagent 通道累计 10 败后的既定两级降级，已备案父卡）
- 承接差距：gap-list.md 面 5（T-1/T-2/T-3/T-4/T-5）+ 面 2.5（D-5）

## 完成

| 差距                               | 实现                                                                                                                                                                                                                                                                                                                        | 提交 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| T-1 闭集枚举客户端前置拒绝无断言   | standalone.test.ts 新增负向用例：condition:'bogus'→/must be one of/、缺 condition→/missing required property "condition"/、since_seq:'42'→/must be an integer/，三案后 calls.length===0（请求根本不发出）                                                                                                                   | A    |
| T-2 来源标注断言过弱               | contract.test.ts NEW_PARAMS 二元组扩三元组 [tool,key,expectedTag]：timeout_ms/with_logs/level/fields/since_seq/title_attr 期望 '[文档 0.10.3]'，find_elements 四新参期望 '[CHANGELOG 0.10.3]'，逐参精确断言                                                                                                                 | A    |
| T-3 timeout_ms↔REST 预算脱钩无锁定 | timeout.test.ts 锁 resolveRequestBudgetMs('invoke_command',{timeout_ms:120000})===undefined、wait_for 同参=120000；standalone.test.ts mockClient 记录第三参 budget 并断言两工具预算差异                                                                                                                                     | A    |
| T-4 闭集 tripwire 注释             | contract.test.ts wait_for.condition enum 断言前加「闭集契约 tripwire」注释（锁插件与 0.10.3 口径一致性，非上游快照）                                                                                                                                                                                                        | A    |
| T-5 compound 桥 0 运行时覆盖       | 新建 src/tools/compound/bridge.test.ts：since_seq:'7' 前置拒绝且 calls=0；未知 action 枚举报错且合法 backend_digest 透传成功；route 未知顶层参数放行（透传语义）                                                                                                                                                            | A    |
| D-5 doctor --json 口径证据不足     | cli-hints.ts doctor notes 改单条无门控 note「不提供 --json：0.8.8 实测报 unexpected argument，0.10.3 CLI 源码亦无该选项」；cli-hints.test.ts 改 2 用例（四版本恒定提示 + 版本未知不外推）；docs/TOOLS.md doctor 段同步；src/tools/cli.test.ts 旧「0.8.8 无 --json/0.10.0 有」用例连带改写（必要连带，卡面范围外已显式记录） | B    |

## 过程与失败记录（≤3 次/步）

1. compound/bridge.test.ts 首版 mockClient 用基础类型解构返回计数 → 值快照恒 0（2 用例假失败）。诊断：node 直连探针（裸链路 calls=1/2 正常）+ vitest 最小复现（同逻辑 2 passed）→ 定位为快照问题非链路问题。修正：计数改对象承载（state.calls）。失败 1 次，重试成功。
2. cli.test.ts:361 旧口径用例（0.8.8 全局不含 --json）与新 doctor 无门控 note 冲突 → 按 D-5 口径改写。失败 1 次，重试成功。
3. format:check 首跑 3 文件 FAIL → prettier --write 后 contract.test.ts 仍 FAIL → 再 --write 后绿。失败 2 次，上限内。

## V1

- pnpm typecheck 0；pnpm test：17 files / 190 passed；pnpm lint 0；pnpm format:check 全绿。

## V2

- 子代理通道不可用（历史 10 连败），按备案降级为 Lead 亲自核对：改动点全部被真实断言锁定；负向用例会真实红（删 enum 校验→T-1 红；删 expectedTag→T-2 红；删 budget 记录→T-3 红）。

## 剩余

- round-4：批八 4/4 文档同步（D-1/D-2/D-3/D-4 + E-2）。
- 收敛检查轮 + 《插件功能审查总结.md》 + 父卡 18 项勾选。
