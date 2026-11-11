# 残余风险自评：批八 2/4（t-mw2etsta-h2bf0n）

> 2026-11-05，dev 分支，提交 `d03646a`（gap-list P1-1/P1-2/P2-4/P2-5）。按父卡 DoD 第 14 项落盘。

## 已闭合项

- **C1 backend_args**：verify_state 新增 backend_args（object，可选，[文档] 标注 +
  backend_command 传参语义）；描述同步。上游 verification_params.rs:16 对齐。
- **C2 animation.action 移除 clear**：枚举 4→3 值（list/scrub/sample）；描述写明
  0.8.8 兼容口径（连旧服务端清空录制改用 sample + clear:true）；EXPECTED_ACTIONS 同步 3 值。
- **C3 别名标注**：eval_js.expression 与 query_db.sql 由 [文档] 改 [桥]
  （上游 0.10.3 文档与 0.10.2 源码均无此别名，属插件本地归一 bridge.ts ARG_ALIASES）。
- **C4 V1 全绿**：typecheck 0 / test 16 files **186** passed / lint 0 / format:check 绿
  （format 首跑 FAIL 2 文件 → prettier --write 后绿，失败 1/3）。

## 残余风险

- **R1 animation clear 移除是行为变化（中）**：0.8.8 用户无法再经本插件直接调
  action=clear——已用 sample + clear:true 等价替代并在描述中写明；若用户依赖旧动作需回退本提交。
- **R2 backend_args 在 0.8.8 服务端被静默忽略（低）**：0.8.8 无该字段但未开 deny_unknown_fields，
  传参不报错也不生效；描述已标 [文档 0.10.3 起提供]。
- **R3 别名标注是文档性修正（低）**：桥行为本身未变（expression/sql 归一逻辑原样），仅更正
  来源标注；无回归风险。
- **R4 contract.test.ts animation 参数集合断言仍含 clear 属性（信息）**：clear 作为 sample 的
  参数保留（与 action=clear 无关），断言 `toHaveProperty('clear')` 已锁定该语义。
