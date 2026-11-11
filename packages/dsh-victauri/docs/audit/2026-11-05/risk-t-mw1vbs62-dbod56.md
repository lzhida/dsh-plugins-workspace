# 残余风险自评：批六 1/4（t-mw1vbs62-dbod56）

- 卡片：`victauri 0.10.3 对齐 批六 1/4：standalone schema 补齐（invoke_command/wait_for/find_elements）+ 后端日志工作流教学`
- 提交：`e7f02ab feat(standalone): 对齐 0.10.3 的 invoke_command/wait_for/find_elements schema`
- 日期：2026-11-05
- 结论：**可交付，但存在 3 项已记录的残余缺口（其中 1 项可实现、2 项需外部环境/仅评估）**

## 一、已在本卡内闭合的问题

| 问题                                                          | 处置                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `invoke_command` 缺 `timeout_ms` / `with_logs`                | 已补参数 + 语义描述 + 三段式用法                                             |
| `wait_for.condition` 缺 `log`                                 | 改机器可读枚举（10 值闭集）                                                  |
| `wait_for` 缺 `level` / `fields` / `since_seq`                | 已补，含游标来源与脱敏说明                                                   |
| `find_elements` 缺 `title_attr` 及 0.10.3 四新参              | 已补，标注 `[文档]` / `[CHANGELOG]`                                          |
| 头注释基线仍是旧口径                                          | 已改为「0.10.3 双源对齐」三源标注体系                                        |
| `wait_for.condition` 由自由字符串改闭集枚举带来的前向兼容风险 | 描述中显式声明「值域按 0.10.3 闭集校验，上游后续新增条件需随插件升级才能用」 |

## 二、残余缺口

### R1（可实现，**尚未建卡**）：`verify_state` 缺 `backend_args`

- 证据：上游 0.10.3 文档 `verify_state` 参数表含 `backend_args`（"Arguments for backend_command"）；本插件 `src/tools/standalone/catalog.ts` 的 `verify_state` 参数集无此键。
- 影响：`backend_command` 模式无法传参，只能比对无参命令的结果。
- 严重度：中。
- 处置：**待建 todo 卡**（批八系列），可在本卡之后立即实现。

### R2（可实现，已由同批次他卡覆盖）：三段式第③步 `logs(action=backend_digest)` 在本卡提交瞬间尚不可用

- 证据：本卡提交 `e7f02ab` 只改 `src/tools/standalone/*`；`logs` 工具的 `action` 枚举在 `src/tools/compound/catalog.ts`，当时仍只有 8 个 action，无 `backend_digest`。
- 影响：按本卡描述照抄三段式的第③步会命中未知 action。
- 处置：描述已改为「上游 0.10.2 起提供；若当前组合尚未开放该子动作，前两步仍可用」，并在**批六 2/4（t-mw1vb617-0knszj）**中真正开放 `backend/backend_digest/stdout`。因 `src/tools/contract.test.ts` 被 1/4 与 2/4 共用、且父卡规定「以后卡在前卡改动之上叠加」，1/4 必须先提交，故该前向引用在 `e7f02ab` 这个提交瞬间客观存在。**两笔提交构成一次原子交付，落地后的插件树内一致。**

### R3（仅评估 / 需外部环境）：`invoke_command.timeout_ms` 与本插件 REST 请求预算未联动

- 证据：`src/tools/standalone/timeout.ts` 只对 `wait_for` 施加动态预算（`timeout_ms + 5s` 余量，夹 `TOOL_BUDGET_MAX_MS = 120_000`）；`invoke_command` 无 `requestBudgetMs`，走客户端默认 `DEFAULT_TIMEOUT_MS = 30_000`（`src/client.ts:195`）与 `requestTimeoutMs` 默认 30_000（`src/config.ts:116`）。
- 影响：模型把 `timeout_ms` 设成 300000 也不会让本通道等更久；服务端仍在 30s 被本通道主动掐断，与上游「整次调用 30s 默认 / max 300000」语义不一致。
- 严重度：中。
- 处置：描述已如实写明「本通道自身的 REST 请求预算是独立的一层（默认 30s，`invoke_command` 未单独放宽）」。**需产品决策**：是否给 `invoke_command` 单独放宽通道预算。属「仅评估」类 → 按父卡规则应建 backlog。

### R4（仅评估）：本机无活体 Tauri app，所有新参数为「文档/CHANGELOG」级证实

- 证据：`mcp__victauri__get_plugin_info` 返回 `Victauri backend not reachable: no running Tauri app with the Victauri plugin (debug build) was found.`；本机 victauri CLI 为 0.8.8（低于本卡对齐目标 0.10.3）。
- 影响：新参数在 0.8.8 服务端不存在时会原样透传并由服务端忽略（schema 为透传型，对旧版安全）；但 `wait_for.condition=log`、`with_logs=true` 在 0.8.8 上**不会报错**，而是静默不触发 —— 模型可能误以为「没等到日志」是业务问题。
- 严重度：低—中。
- 处置：描述已用「需服务端具备 `logs.backend` 能力，且应用侧已装 `log_layer`/`log_logger`/`wrap_logger` 之一（否则捕获为空）」显式声明前置条件。**活体验证需 macOS/Android 真机或 0.10.3 构建的 app** → 属需外部环境类。

## 三、验证与复核记录

- V1（自验）：`pnpm typecheck` 0；`pnpm test` = Test Files 15 passed / Tests 160 passed；`pnpm lint` 0；`pnpm format:check` 0（All matched files use Prettier code style!）。
- V2（独立子代理 `2c2340f6`，PASS_WITH_NITS）：提出 1 高 / 2 中 / 4 低共 7 条，全部处置（高=第③步可执行性→R2，中=timeout_ms 预算未联动→R3，中=新参语义断言→已加「以服务端实现为准」限定，低 4 条=注释版本号、CHANGELOG 区间、with_logs 门槛、enum 前向兼容、fields 脱敏）。**V2 问题全部修复后重跑 V1 全绿，才提交 `e7f02ab`。**
- 已知失败尝试（≤3 次重试纪律）：
  - `https://api.github.com/repos/4DA-Systems/Victauri/git/trees/main?recursive=1` → `API rate limit exceeded for 16.106.47.188.`（**教训**：不查上游源码树，改用 raw docs / CHANGELOG）。
  - `mcp__victauri__get_plugin_info` → 后端不可达（无活体 app）。
  - `pnpm format:check` 首次 FAIL → `npx prettier --write` 修正后全绿。

## 四、未提交任何卡到 done

本卡仅从 `todo` → `in_progress` → `in_review`；`done` 由用户在界面确认。
