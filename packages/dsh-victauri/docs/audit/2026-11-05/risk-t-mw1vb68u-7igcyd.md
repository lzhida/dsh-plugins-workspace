# 残余风险自评 · 批六 3/4（t-mw1vb68u-7igcyd）

- 卡片：t-mw1vb68u-7igcyd「victauri 0.10.3 对齐 批六 3/4：CLI 桥补 0.10.x 子命令（tools/call/run/logs）+ invoke 关系裁决」
- 提交：`dbfec89` feat(cli): 补齐 0.10.x 新增子命令并修正上游口径（dev，未 push）
- 自评日期：2026-11-05
- 范围：`src/cli-hints.ts`（主）+ `src/cli-hints.test.ts`（主）+ `README.md` / `docs/TOOLS.md`（CLI 桥子命令清单段落）；
  连带修改 4 个文件：`src/cli.test.ts`、`src/tools/standalone/standalone.test.ts`（子命令数 9→13）、
  `src/cli.ts`（子命令清单注释）、`src/tools/cli-status.ts` 与 `src/tools/cli-status.test.ts`（输出 schema 描述）

## 一、本卡已闭合的风险

| 编号 | 风险                                                                                               | 处置                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| C1   | 0.10.1/0.10.2 新增的 tools/call/run/logs 子命令完全缺失，模型只能看到 0.8.8 的 9 个子命令          | 已补 4 项（键顺序对齐上游 0.10.3 `victauri --help`），版本门控 + 上游口径齐备                              |
| C2   | `invoke` 与新 `call` 的关系未裁决，模型可能以为 invoke 已废弃                                      | 裁决为**并存**（上游 v0.10.3 `crates/victauri-cli/src/main.rs` 仍有 Invoke 变体）；不加 until 门控         |
| C3   | `run` 的停止语义写成「Unix PR_SET_PDEATHSIG」——上游实际未使用该机制                                | 改为「Windows job object / Unix 停止信号转发 + DeathWatch 辅助进程」                                       |
| C4   | `logs --json` 文案把结构化 JSON 推给插件工具，与同 spec 列出的 `--json` 选项自相矛盾               | 改为上游口径「输出原始 JSON records，不是格式化行」                                                        |
| C5   | 版本未知（null）时仍推送 `longRunningNote`，与文件头「版本未知不外推」原则冲突                     | 统一按 `isAtLeast` 判定；补 0.8.8/0.10.1/0.10.2/null 四点推送矩阵用例                                      |
| C6   | `CliActionSpec.until` 是死字段（`buildActionHint` 从不读），「invoke 不被禁用」无实现保证          | 实现门控并导出 `isBeyondUntil` 纯函数，补用例覆盖越过/未越过/版本未知三种                                  |
| C7   | `victauri_cli_status` 的输出 schema 描述硬编码旧 9 项，与实际 13 项 enum 冲突                      | 改为按 `CLI_ACTIONS` 动态生成，并补 schema 同源用例                                                        |
| C8   | 工具描述无条件泄漏 0.10.x 专属语法（`--args-file`/`--out`/`--follow`），与「描述版本无关」注释矛盾 | 描述口径改为「子命令语义 + 显式版本门槛」，补版本门槛文案与断言                                            |
| C9   | 新增语义约一半没有回归锁定，多条断言属「删掉实现也仍绿」的空洞断言                                 | 重写测试块：退出码四语义、四种传参形式、logs 全量选项与默认值、三组互斥、run launcher 语义、文档整串同源等 |
| C10  | 文档/README 的子命令清单与规格表不同源（逐词 `toContain` 被正文同名词绕过）                        | 改为整串连续匹配（`init` / `check` / … / `logs`），docs 与 README 各一条                                   |

## 二、本卡遗留的残余风险（未闭合项）

### R1（中）· 0.10.x 子命令行为全部是源码级推断，本机无法活体实测

- 证据：上游 v0.10.3 `crates/victauri-cli/src/main.rs`（clap 变体与 `after_help` 原文）经 raw.githubusercontent 抓取核对；
  本机 `victauri --version` = 0.8.8，cargo registry 内**无 victauri-cli crate**（只有 victauri-core/plugin/macros/test），
  故 0.10.x 的 CLI 行为无法在本机跑起来验证。
- 后果：若上游 `after_help` 与实际行为有出入（如 `--json` 的输出形态、退出码边界），插件文案会与真实行为有偏差。
- 现有缓解：所有 0.10.x 专属文案均标注 `[INFERENCE]` 口径来源；本机 0.8.8 可用子命令的行为由既有 e2e 报告（`.agents/tmp/dsh-victauri-e2e-report.txt`）佐证。
- 剩余缺口：**需外部环境**（安装 victauri 0.10.x CLI 或上游账号）→ 归入仅评估类 backlog + `waitingForHuman`。

### R2（中-低）· 工具描述仍含版本专属语法，靠版本门槛句与 `hints` 兜底

- 证据：`src/cli-hints.ts` 的 `buildCliToolDescription` 用子命令摘要拼装动作列表，摘要含 `--args-file`/`--out`/`--follow`；
  描述已补「子命令版本门槛：tools/call 需 CLI >= 0.10.1，run/logs 需 >= 0.10.2……是否可用以执行结果的 hints 为准」。
- 后果：0.8.8 用户若只读描述不读 `hints`，仍可能照抄不存在的参数。
- 剩余缺口：彻底消除需把描述拆成「按版本裁剪的描述」，但工具描述在宿主侧是静态注册的，无法按运行时版本变化——
  **属架构限制**，归入仅评估类 backlog。

### R3（中）· 上游 `setup` 子命令有意不接

- 证据：上游 0.10.0 起 `victauri setup` 只写 agent 客户端接入指令（`clients` 必填 + `--path`/`--user-config`/`--no-instructions`/`--dry-run`）；
  本插件 `SPEC_TABLE` 无 `setup`（`src/cli-hints.ts` 头注释已写明「有意不接」）。
- 后果：需要为第三方 MCP 宿主写接入指令的场景，模型无法通过本通道完成。
- 剩余缺口：可实现（补一项 spec）但**收益低且会与 `init` 重复**；归入仅评估类 backlog，附「若上游把 setup 升级为必需步骤再接」的触发条件。

### R4（低-中）· CLI 子命令数 13 被硬编码在 3 处断言

- 证据：`src/cli-hints.test.ts` 的 `expect(CLI_ACTIONS.length).toBe(13)`、`src/cli.test.ts` 的全集数组、
  `src/tools/standalone/standalone.test.ts` 的 `expect(CLI_ACTIONS.length).toBe(13)`。
- 后果：将来接入 `setup` 或再增子命令时需同改 3 处，漏改即测试红。
- 现有缓解：文档已注明「CLI 子命令数 13 是**刻意硬编码**的防漏项断言」（`docs/TOOLS.md`「口径一致性」节）。
- 剩余缺口：可执行（改为集合断言 + 显式期望清单）但会削弱「防漏项」价值；**归入仅评估类 backlog**。

### R5（中）· CLI 子进程的终止模型仍有缺口（跨卡遗留）

- 证据：`src/cli.ts:102-105` 只 `kill` 一次、无 SIGKILL 升级、不杀子孙进程；
  `src/tools/cli.ts:99-102` 的 `timeout_ms` 仅 `type:'integer'`、无上限；宿主侧 300s 上限（`src/tools/cli.ts:277`）。
  本卡新增的 `run`（长驻）与 `logs --follow`（长驻）会放大该风险。
- 后果：`timeout_ms` 传超大值时宿主先放弃、子进程继续跑；`run` 停止时可能连带留下 app。
- 剩余缺口：可执行（加进程树终止与 timeout_ms 上限）→ 归入六面差距清单的 todo 卡。

### R6（低）· `doctor --json` 口径的证据强度不足（本卡未动 doctor）

- 证据：上游 CHANGELOG 全文 grep 无 `doctor.*--json`；上游 v0.10.3 `main.rs` 的 Doctor 变体只有 `AppTarget(--app)`；
  而插件 `src/cli-hints.ts` 的 doctor notes 写「0.10.0 起的文档才提供 --json」。
- 后果：0.10.x 上 doctor 可能并不支持 `--json`，模型会照着提示尝试并失败。
- 剩余缺口：可执行（改为「文档口径、上游源码未见该选项，以实际 `doctor --help` 为准」）→ 归入 todo 卡。

### R7（中）· 文档仍有过期枚举（批六 2/4 的产物未同步进文档）

- 证据：`docs/TOOLS.md` 的 logs 动作表仍列 8 个（缺 backend/backend_digest/stdout）、window 动作表仍列 6 个（缺 introspectability）、
  `wait_for` 条件清单未含 `log`；而 `src/tools/compound/catalog.ts` 已是 11 / 7，`src/tools/standalone/catalog.ts` 已含 `log`。
- 后果：读者按 TOOLS.md 取枚举会拿到过期口径。
- 剩余缺口：可执行（改文档）→ 归入六面差距清单的 todo 卡。

### R8（低）· `until` 门控当前无子命令使用

- 证据：`SPEC_TABLE` 13 项均未设置 `until`（`invoke` 刻意不设，以保住「0.10.3 仍保留 invoke」的裁决）；
  门控逻辑由 `isBeyondUntil` 的单测直接覆盖。
- 后果：门控代码路径只经单元测试，未经真实子命令驱动。
- 剩余缺口：可接受——上游目前没有移除任何已接子命令；待上游真移除时再为对应 spec 填 `until`。

## 三、结论

- 本卡范围内的问题已全部闭合，V1（`pnpm typecheck` / `pnpm test` 15 files 178 tests / `pnpm lint` / `pnpm format:check`）全绿。
- V2 两轮交叉复核（需求符合度 + 上游口径 + 回归 8170bc3d；测试充分性 0ac855c8）提出的
  **4 中 + 8 低**（含 8 项回归缺口与 20 项补测建议）已全部处理，处理后重跑 V1 全绿才提交。
- 遗留 8 项残余风险中：R5、R6、R7 为**可直接实现的缺口**（归入六面差距清单，在父卡「按差距建卡」阶段建 todo 卡并当场执行）；
  R1 需外部环境（安装 0.10.x CLI / 上游账号），R2、R3、R4、R8 为**架构限制或收益不足的评估类**（归入 backlog，未授权执行）。
- 无「伪造通过」：0.10.x 相关结论均以上游 v0.10.3 源码行号或 CHANGELOG 原文为准；
  本机无活体 Tauri app（`mcp__victauri__get_plugin_info` 报 backend not reachable），且本机 CLI 为 0.8.8，
  故凡涉 0.10.x 行为的结论一律标注为源码级推断。
