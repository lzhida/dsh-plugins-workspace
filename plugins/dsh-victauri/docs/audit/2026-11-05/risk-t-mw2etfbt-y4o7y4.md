# 残余风险自评：批八 1/4（t-mw2etfbt-y4o7y4）

> 2026-11-05，dev 分支，提交 `ae52849`（gap-list S-3）。按父卡 DoD 第 14 项落盘。

## 已闭合项

- **C1 失败用例先红**：120 条 backend_logs + backend_log_cursor=42 载荷经旧 renderJson 不含 cursor（红）。
- **C2 摘要化实现**：render.ts 新增 `summarizeBackendLogsPayload`（>5 条触发：标量键重排在前原样保留、
  backend_logs 留前 5 条 + 摘要说明），`renderJson` 渲染前自动识别 with_logs 载荷。
- **C3 回归锁定**：standalone.test.ts 新用例断言含 cursor/next_seq/「已摘要化」且非 120 条全文；
  短载荷（≤5 条）不摘要化保持原样。
- **C4 V1 全绿**：typecheck 0 / test 16 files 185 passed / lint 0 / format:check 绿。

## 残余风险

- **R1 摘要化阈值是静态 5 条（低）**：BACKEND_LOG_PREVIEW_COUNT=5 为渲染层固定值；若单条日志极长
  （>1KB），5 条仍可能让总长超 6000 走原截断路径——此时游标键已重排在前，不会丢，仅日志样本变少。
- **R2 触发条件按键名识别（低）**：以顶层 `backend_logs` 数组键名识别载荷；上游若将来改键名
  （如 backendLogs）需同步。属上游契约漂移风险，风险低。
- **R3 非对象载荷不摘要化（低）**：with_logs 失败路径返回 `{error:{...}}`（无 backend_logs 键），
  走原渲染——正确行为，无需摘要。
- **R4 bridge.ts 未改动（信息）**：卡片允许文件含 bridge.ts，但摘要化收敛在 render 层后 bridge
  无需改动——output.render 仍挂 renderJson，改动面更小。
