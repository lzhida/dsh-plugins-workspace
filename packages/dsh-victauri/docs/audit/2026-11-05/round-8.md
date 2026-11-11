# round-8 结论 —— 对外文档口径同步 + 数组结果形状说明 + 影响面订正

- 轮次：round-8
- 日期：2026-11-05
- 范围：批十一 1/3 ~ 3/3、批十二 1/1（共 4 张卡，全部执行完毕并移交 in_review）
- 纪律：只提交 dev、未 push、未把任何卡移到 done、失败 ≤3 次并记录

## 一、本轮缘起

round-7（批十两卡）收尾时重新扫了一遍对外文档与实现的口径，发现四处**对外文档与实现不一致**：

| #   | 发现                                                                                 | 性质                                                                                         |
| --- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| ①   | `docs/TOOLS.md` 缺 `route` 的 0.10.3 行为边界（`victauri_route` 行只列 5 个 action） | 文档缺失（实现与描述已由批十 2/2 落地）                                                      |
| ②   | `README.md:95-96` 仍写「冒烟 9 项检查 / 覆盖 5 个核心工具」                          | 与 `scripts/smoke.mjs` 现口径（10 项 / 6 个核心工具，含 `logs`）不符                         |
| ③   | M-2 的 `{items}` 形状只在 `find_elements` 一处提到                                   | 描述层不完整（实现 `src/tools/standalone/bridge.ts:80-85` 的 `toRecord` 对**所有**数组生效） |
| ④   | `gap-list.md` 的 P3-5 状态滞后                                                       | 台账未回填（`README.md:44` 与 `docs/TOOLS.md:1/5/411/464-467` 其实早已解耦 35/38）           |

另有一条**明确不属于本轮**的缺口：`src/tools/standalone/bridge.ts:112` 的注释写「别名键总是移除(服务端拒未知字段)」，但上游 victauri 0.8.8 / 0.10.2 / 0.10.3 三版 crate 全仓 grep `deny_unknown_fields` **命中均为 0**——该注释不实。它与 M-1 同域（都改 `client.ts` 与 `bridge.ts`），已归入 **backlog-A**（`t-mw2eut5k-6k1elc`，waitingForHuman），本轮不重复做、不重复建卡。

## 二、本轮四张卡

| 卡片       | 卡号                | 主题                                                                | 提交（dev，未 push）  | 状态                   |
| ---------- | ------------------- | ------------------------------------------------------------------- | --------------------- | ---------------------- |
| 批十一 1/3 | `t-mw319n85-0anjn0` | 对外文档口径同步（route 边界小节 / 数组形状小节 / README 冒烟口径） | `e5f11d7` + `35d2d61` | in_review v14（10/10） |
| 批十一 2/3 | `t-mw31a0yi-gp1khz` | `gap-list` 状态回填（P3-5/M-2/M-3/M-4/L-11）+ 映射表登记            | `de85d4b` + `e7f4cc4` | in_review v15（10/10） |
| 批十一 3/3 | `t-mw31b5gs-0czoj5` | 数组型工具描述补 `{items}` 统一说明（11 个工具）                    | `e98546f` + `b95dd57` | in_review v14（10/10） |
| 批十二 1/1 | `t-mw351p2r-b6rxos` | 订正文档数组影响面清单（移除 trace/fault）+ 同源护栏                | `855f6c2` + `8fad20c` | in_review v14（10/10） |

## 三、四项关键结论

### 1. `route` 的 0.10.3 行为边界（批十一 1/3）

新增小节「### route 的 0.10.3 行为边界」，四条口径全部对上游源码核过：

- 两类 fulfill 规则在 `add` 时被拒：pattern 命中 IPC host 且 mock 不可读（无 body、非 JSON body、204 + `application/json`），或 mock 不被 `Response` 构造器接受（header 名或值非法、非 ByteString `status_text`）——`js_bridge.rs:3586-3600`、`ipcMockUnparsable`（`:1225-1234`）。**注意**：不可读判定只在 Content-Type 为 `application/json` 时成立（`:1229`）。
- 更宽的 pattern 会被接受，但当该 mock 同样不可读时 `add` 返回 `ipc_warning`（`mock_unreadable`），**真实命令不执行**——`js_bridge.rs:3604-3612`。
- 正则的重复捕获组在 `add` 时被拒（仅 `match_type='regex'` 时才检查）——`js_bridge.rs:3545-3558`（条件 `:3545`，文案 `:3552`）。
- `ipc_warning` / `mock_unreadable` 是 0.10.x 引入的细化：0.8.8 服务端两者**全零命中**；0.10.2 有 `ipc_warning`/`mock_unreadable` 但**无**正则校验——本机可核。

### 2. 数组结果的形状（批十一 1/3 + 批十一 3/3 + 批十二 1/1）

本轮把「插件把上游裸数组包成 `{"items":[...]}`」这件事从**散文**推进到**逐工具描述 + 文档清单 + 护栏**三层：

- **文档层**（`docs/TOOLS.md`「## 数组结果的形状」）：归一表（顶层数组 → `{"items":[...]}`、顶层对象 → 原样、标量 → `{"value":...}`）+ 影响面清单 + 两条易混例外。
- **描述层**（批十一 3/3）：新增导出常量 `ARRAY_RESULT_NOTE`（`src/tools/standalone/catalog.ts:44-54`），standalone 3 个工具 + compound 8 个工具的描述统一挂上，并写明各自的数组范围。
- **护栏层**（批十一 3/3 + 批十二 1/1）：`src/tools/contract.test.ts` 把 11 项 `ARRAY_TOOLS` 提升到 `describe` 作用域，**同时**锁住「哪些工具带该说明」（载体集合相等断言）与「文档影响面清单与该集合相等」——文档少列/多列/拼错、工具侧误加/漏加，都会变红。

**经 0.10.3 活体实测 + 上游源码取证的 11 个数组型工具**：`find_elements`、`get_registry`、`resolve_command`、`logs`、`recording`、`route`、`window`、`navigate`、`inspect`、`animation`、`storage`。

**两条易混例外**（批十二 1/1 补齐）：`trace.frames` 走插件图像通道 `normalizeImageResult`（`src/tools/standalone/image.ts:163-168` → `{...merged, paths, mime_type, count}`），`fault.list` 上游返回对象（`mcp/mod.rs:4526-4537` → `json!({count, faults:[...]})`）——两者都拿不到 `{"items":[...]}`。批十一 3/3 曾把 `trace`/`fault` 误写进文档影响面清单，批十二 1/1 订正并加了同源护栏防回退。

### 3. 裸数组透传仍是提案，不在本轮范围

上游 `logs` 的 `console`/`network`/`ipc`/`navigation`/`dialogs`/`events` 返回**裸数组**（上游 0.10.3 文档 `tools-reference.md:730-732`）。让插件原样透传裸数组的提案见看板卡 `t-mw1ri0ep-8vw7ql`——**backlog 提案卡，未授权执行，需用户批准后才能认领**。本轮所有文档与描述都按「一律 `{"items":[...]}`」写，并在文档里点明了该提案卡。

### 4. 台账口径回填（批十一 2/3）

`gap-list.md` 的 P3-5 状态由「开放」改为「✅ 已修」——但**落地提交不是批十一 1/3**，而是更早的 `be544f6` + `eb549f3`（`git blame` 实测：`README.md:44` 与 `docs/TOOLS.md:1` 由 `be544f6` 引入，「口径一致性」小节由 `eb549f3` 引入）。批十一 2/3 同时把 M-2 拆成「描述层已完成 / 实现层未授权」两段，并把 M-3/M-4/L-11 的归属与「未授权执行，需用户批准后才能认领」写清；映射表新增批十一三行，且**未执行的批次不预填「已执行」**。

## 四、本轮验证

| 验证项                                            | 结果                                                            |
| ------------------------------------------------- | --------------------------------------------------------------- |
| V1 `pnpm typecheck`                               | exit 0                                                          |
| V1 `pnpm test`                                    | **17 files / 202 tests passed**，exit 0                         |
| V1 `pnpm lint`                                    | exit 0                                                          |
| V1 `pnpm format:check`                            | All matched files use Prettier code style!（exit 0）            |
| smoke `SMOKE_SKIP_BUILD=1 node scripts/smoke.mjs` | **10/10 PASS**（0.10.3 @7374，1260ms）                          |
| 突变测试                                          | 批十一 1/3：3 案全 RED；批十二 1/1：3 案全 RED                  |
| 反向可证伪                                        | 批十一 1/3 旧文档下 3 条新护栏 RED；批十二 1/1 旧清单下护栏 RED |

## 五、V2 交叉复核的实际方式（重要事实）

本轮**子代理通道持续失败**：批十一 1/3（3 次）、批十一 3/3（3 次）、批十二 1/1（3 次）均出现「started … failed before it finished / left no closing message」。累计失败次数已达两位数（历史自 round-0 起累计 10+ 次）。

按各卡「V2 派独立子代理，3 次仍失败则由 Lead 亲自执行同等核对并如实记录」的约定，本轮共 4 张卡里有 **3 张**（批十一 1/3、批十一 3/3、批十二 1/1）走了降级路径；批十一 2/3 亦由 Lead 亲自核对。降级核对均按同等的四点要求执行（事实一致 / 断言有效 / 无越界 / 口径一致），并以**突变测试 + 反向可证伪**作为客观证据。

`ralph` 循环驱动同样不可用（连续 3 次失败），本轮仍按父卡约定降级为**同会话串行轮次**，每轮结论落盘为 `docs/audit/2026-11-05/round-N.md` 并回写看板评论——跨轮记忆只靠落盘与看板。

## 六、看板终态（本轮结束时）

- `done` 31（含父卡 `t-mw21ydiw-mv754k` v30，**由用户移入 done**，本会话全程未自行移 done）
- `in_review` 7：批十 1/2、批十 2/2、批十一 1/3、批十一 2/3、批十一 3/3、批十二 1/1
- `todo` 0
- `backlog` 3：`t-mw1ri0ep-8vw7ql`（裸数组透传，用户裁定不执行）、`t-mw2eut5k-6k1elc`（backlog-A，含 M-1 与 `bridge.ts:112` 注释不实，waitingForHuman）、`t-mw2evd2u-0dukch`（backlog-B，评估/增强类，waitingForHuman）

## 七、剩余缺口

1. **需用户授权**：`{items}` 裸数组透传（`t-mw1ri0ep-8vw7ql`）、错误信封与 401 重发现 + M-1 + `bridge.ts:112` 注释不实（backlog-A）、M/L 组增强与架构级评估（backlog-B）。
2. **记录性风险**（不建卡）：护栏依赖文档书写形式；上游两套口径长期并存；本机 CLI 0.8.8 与上游 0.10.3 能力差；手写 `.d.ts` 可能随上游漂移；skill 活体加载未验证。
3. **本轮无新增可执行缺口**——四张卡覆盖后，本项目范围内可当场执行的差距已全部处理。

## 八、纪律声明

- 本轮 8 笔提交全部落在 `dev`，Conventional Commits 中文格式，**未 push**、未 force-push、未在 `main`/`master` 提交。
- 未把任何卡片移到 `done`。
- 单步失败均 ≤3 次并记录（`format:check` 每次改动后 `prettier --write`；突变脚本行尾改为 LF；子代理 3 次上限后降级）。
- 一卡只动该卡列出的文件；跨卡的连带修正（如批八 4/4 的 animation `clear`、批八 3/4 的 doctor `--json`）均在对应卡内显式记录。
