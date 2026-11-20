# 残余风险自评：批十一 1/3（对外文档口径同步）

- 卡片：t-mw319n85-0anjn0
- 日期：2026-11-05
- 轮次：round-8
- 改动文件（仅 3 个，与卡面允许清单一致）：
  - `docs/TOOLS.md`
  - `README.md`
  - `src/cli-hints.test.ts`（只加护栏用例，未改任何运行时代码）

## 一、本卡闭合项

- **C1** 新增「### route 的 0.10.3 行为边界」小节（`docs/TOOLS.md:85-107`）：
  四条口径（add 拒绝两类 fulfill 规则 / 更宽 pattern 被接受但回 `ipc_warning`
  且真实命令不执行 / 正则重复捕获组在 `add` 时被拒 / `ipc_warning` 与
  `mock_unreadable` 是 0.10.x 引入），逐条与
  `src/tools/compound/catalog.ts:425-454` 的 `route` description 语义一致。
- **C2** 新增「## 数组结果的形状」小节（`docs/TOOLS.md:155-180`）：
  三行归一表（顶层数组 → `{"items": [...]}`；顶层对象 → 原样透出；标量 →
  `{"value": ...}`）+ 影响面 + 与上游 bare array 的差异 + 为何多这一层 +
  指向 backlog 卡 `t-mw1ri0ep-8vw7ql` 并写明「未授权执行，需用户批准后才能
  认领」。
- **C3** README 冒烟口径修正（`README.md:95-96`）：「冒烟 9 项检查」→「10 项
  检查」；「覆盖 5 个核心工具」→「覆盖 6 个核心工具（`get_plugin_info` /
  `app_info` / `eval_js` / `dom_snapshot` / `invoke_command` / `logs`）」；
  `README.md:66` 数组包装条目补 bare array 提示与 docs 锚点。
- **C4** 护栏用例（`src/cli-hints.test.ts` 末尾 describe「对外文档口径护栏
  （route 行为边界 / 数组结果形状 / 冒烟口径）」，3 个 `it`）：
  - route 小节切片内断言 `ipc_warning` / `mock_unreadable` / 真实命令不执行 /
    重复捕获组 / `match_type='regex'` / 「0.10.2 及以前没有此校验」，且
    catalog 的 route description 必须含同一组事实锚点；
  - 数组小节切片内断言 `{"items":` / `{"value":` / 顶层数组 / 顶层对象 / 标量 /
    bare array，并直接读 `src/tools/standalone/bridge.ts` 断言
    `return { items: value }` 与 `return { value }` 两处归一语句真实存在，另
    断言含 `t-mw1ri0ep-8vw7ql` 与「未授权执行」；
  - README 冒烟口径**从 `scripts/smoke.mjs` 派生**（正则取 `const required = [...]`
    的 6 个工具名拼出整串；检查项数取头注释 `/冒烟清单（(\d+) 项检查/`），并
    否定「9 项检查」/「5 个核心工具」。
- **C5** 先红后绿：护栏写完后、旧文档下 `src/cli-hints.test.ts` = **3 failed |
  38 passed**；改文档后 = **41 passed**。
- **C6** 反向可证伪（旧文档基线）：`git stash push -- docs/TOOLS.md README.md`
  → 3 failed | 38 passed → `git stash pop` 恢复。
- **C7** 定向突变测试（三项，均红后还原）：
  - A：`docs/TOOLS.md` 中「重复捕获组」→「重复组」→ route 用例红（1 failed |
    40 passed）；
  - B：删掉数组表「顶层对象」行 → 数组用例红（1 failed | 40 passed）；
  - C：README 去掉 ` / \`logs\``→ 3 个用例红（含既有 CLI 清单同源用例，
1 failed→3 failed | 38 passed）。
每次均从`%TEMP%\dsh-docs-mut` 备份还原，`git status`恢复为 3 个`M`。
- **C8** V1 四件套全绿：`pnpm typecheck` exit 0；`pnpm test` → **17 files /
  199 tests passed**（exit 0）；`pnpm lint` exit 0；`pnpm format:check` 首跑
  FAIL（`src/cli-hints.test.ts`）→ `npx prettier --write` → 全绿「All matched
  files use Prettier code style!」（exit 0）。
- **C9** V2 独立审 diff：**子代理通道连续 3 次失败**（`4a2406c6…`、
  `a08d51f4…`、`b008999d…`，均「启动后无输出即失败」，与本会话历史 10+ 次
  同型），按卡面第 5 步「子代理不可用时如实记录失败次数并由 Lead 亲自做同项
  核对」降级为 Lead 亲自执行，结论 **PASS_WITH_NITS**，3 条 nit 全部修复后
  重跑 V1 全绿。
- **C10** Lead 亲自 V2 核对结论（逐条属实）：route 四条口径与
  `catalog.ts:442-452` 语义一致；版本可核性 grep 计数成立（0.8.8
  `ipc_warning`/`mock_unreadable`/`regexHangRisk` 全 0；0.10.2 前两者有、后者
  0）；数组归一与 `src/tools/standalone/bridge.ts:80-85` 的 `toRecord` 逐行
  一致；`gap-list.md:75-78` 的 M-2 实测清单与 docs 列出的 8 个工具一致；
  README 冒烟口径与 `scripts/smoke.mjs:13` 头注释「10 项检查，覆盖 6 个核心
  工具」及 `:450-457` 的 required 数组逐字一致；改动文件仅 3 个，无越界。

## 二、本卡修复的 3 条 V2 nit（Lead 亲自核对产出）

1. **【中】docs 第 1 条口径不准确**——原文写「无 body、非 JSON body、204 +
   application/json」，但上游 `js_bridge.rs:1229`
   `if (tauriContentTypeHead(built.resp) !== 'application/json') return null;`
   表明「不可读」只在 Content-Type 头为 `application/json` 时才成立，
   `text/plain` 等类型不算。已改写为「（无 body 如 204、非 JSON body）——
   「不可读」只在 Content-Type 头为 `application/json` 时才成立…（上游
   `js_bridge.rs:1229`）」。
2. **【中】行号漂移**——原写 `:3548-3558`，实际 `:3545` 才是
   `matchType === 'regex'` 的条件判断、`:3552` 才是错误文案。已改为
   `:3545-3558`，第 3 条补「上游 `:3545` 的条件判断、`:3552` 的错误文案」。
3. **【低】上游文档引用缺行号**——数组小节补 `tools-reference.md:730-732`。

## 三、残余风险

- **R1（记录性）子代理通道持续不可用**：本轮 3 次派发全失败，与 round-6/7
  记录的历史 10+ 次同型，说明当前会话的子代理路由不稳定。V2 一律由 Lead
  亲自执行，虽然覆盖了「事实核对」与「测试充分性」两个视角，但**缺少真正的
  独立第三方视角**，抗遗漏能力弱于正常子代理审阅。不构成可执行缺口（属环境
  能力问题，非仓库问题），已如实记录。
- **R2（记录性）文档自然语言护栏的固有边界**：护栏按小节切片 + 关键词匹配，
  逐条突变测试已证明三条改动各有独立断言护住；但若后续把该小节整段删除或
  改写标题，关键句断言会红，而语义等价的改写（如换一种措辞）不会被抓住。
  这是「自然语言 → 字符串断言」这一方案的固有上限，已在护栏注释中写明。
- **R3（记录性）上游行号会漂移**：本卡写入 `docs/TOOLS.md` 的上游源码行号
  （`js_bridge.rs:1229` / `:3545-3558` / `:3586-3613` / `mcp/mod.rs:3107`、
  `tools-reference.md:730-732`）绑定 0.10.3 这一具体版本；上游发新版后行号会
  漂移，需按轮次复核（本会话既有惯例：涉及上游行号的断言在
  `src/tools/contract.test.ts` 里也锁了一份，见 C4 与 catalog 的同源护栏）。
- **R4（记录性）数组归一逻辑本身未改动**：`{items}` 包装是 dsh 工具契约
  （顶层必须是 object）的硬约束下的实现选择，透传提案属 backlog 卡
  `t-mw1ri0ep-8vw7ql`（用户已裁定不执行）。本卡只做文档口径说明，未改实现，
  文档与实现当前一致；若用户日后批准透传，本小节需同步重写。
- **R5（记录性）README 冒烟项数随 smoke 脚本演进**：`scripts/smoke.mjs` 现
  有 11 个 `await check(`，其中第 11 项 selftest 仅在 `SMOKE_SELFTEST=1` 时
  触发，默认清单为 10 项。护栏按头注释「冒烟清单（N 项检查）」派生，默认
  口径下正确；若将来把 selftest 提升为默认项，护栏会红并提示同步 README。

## 四、是否存在可执行残余缺口

**无。** 本卡的三个缺口（route 散文缺失 / 数组形状未说明 / README 冒烟口径
过期）已全部闭合；上述 R1–R5 均为记录性风险或需用户裁决项，不构成本轮应
当场建卡执行的缺口。关联的后续事项：

- 透传裸数组的提案 —— backlog 卡 `t-mw1ri0ep-8vw7ql`（用户已裁定不执行）。
- backlog-A（`t-mw2eut5k-6k1elc`）与 backlog-B（`t-mw2evd2u-0dukch`）——
  仍为 `waitingForHuman`，需用户批准后才能认领。
