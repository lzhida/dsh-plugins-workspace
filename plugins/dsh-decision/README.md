# @zhidal/dsh-decision

dsh 的**决策域组合包**：把「需要人拍板的决策点」做成可插拔的门控插件，每个决策点一个插件行，命名规则 `<决策点>-gate`。当前成员：`ask-gate`——接管模型侧的提问工具 `ask_user_question`，**总开关关闭时不介入决策、原样直通宿主提问通道**（参数与答案结构、宿主错误语义与出厂一致；工具描述文案有少量改写，见[已知限制](#已知限制)）；**开启时先由决策模型评估把握度**：置信度达标就自动作答并落账 `presentationMeta`（置信度 / 判定 / 理由），不达标或任何降级（模型缺失 / 配置缺 / 调用失败 / 超时 / 被中止 / 解析失败 / 建议答案未覆盖全部问题）一律 **fail-open 放行真实提问**——决策链路永远不阻断用户被问到的机会。

> 这是私有包（`private: true`），当前仅支持仓库内 `link:` 安装（插件行以 TS 源码为入口；client 半区产物需构建，见[设置页与构建](#设置页与构建client-半区)）。

## 目录

- [特性](#特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [决策工具行 decision-tools](#决策工具行decision-tools)
- [设置页与构建（client 半区）](#设置页与构建client-半区)
- [组合包扩展约定](#组合包扩展约定)
- [轨迹可见性](#轨迹可见性)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [开发](#开发)
- [许可证](#许可证)

## 特性

- 🚦 **按决策点切插件行**——组合包内每个决策点一个入口文件（`ask-gate` / 未来的 `tool-gate` / `route-gate`），共用同一套决策 core 与配置面，新增成员不复制粘贴实现
- 🔁 **默认零介入**——总开关 `enabled` 默认 `false`：提问直通宿主 `userQuestions` 通道，**参数与答案结构**、**宿主错误语义**（`ASK_ABORTED` / `EMPTY_QUESTIONS` / `CALLER_NOT_LIVE` / `DELEGATED_CALLER` / `BAD_INTENT` / `NO_PROVIDER`）原样透传（工具与字段的 `description` 文案见[已知限制](#已知限制)）
- 🧠 **决策模型代答**——决策模型按固定 system prompt 输出单个 JSON（`confidence` + 按 id 的 `answers` + `reason`）；置信度 **≥ 阈值**才自动作答，答案的 `custom` 恒带 `[decision auto-answer]` 前缀标注来源
- 🛟 **一律 fail-open**——低置信、模型不可用、超时、解析失败、建议答案没覆盖全部问题，任何一种情况都放行真实提问，绝不因为门控把用户挡在门外
- 🧾 **落账可核查**——每次门控判定都写 `presentationMeta{confidence, decision, rationale}`，`decision` 取 `auto-answered` / `passed-through`；**降级**时 `rationale` 记录真实降级信号（`route-not-configured` / `model-error` / `timeout` / `aborted` / `llm-unavailable` / `route-invalid` / `no-json-object` 等），**低置信放行**时 `rationale` 记录模型的 `reason`（评估本身成功，只是把握度不够）
- 🔌 **纯旁路决策调用**——决策评估不写会话、不注册 MessageSourceMap、不经宿主 agent 状态机，失败不抛穿、只降级放行
- 🧩 **让位式接管**——通过包内 `cordis.patch.yml` 让位出厂 `@deepseek-ai/dsh-tool-ask-user` 行，避免同名工具重复注册；门控关闭时用户侧行为与出厂无差别

## 工作原理

1. 插件行 `ask-gate` 装载后注册**同名工具** `ask_user_question`（与出厂 legacy 模式的**结构约束**兼容：入参 `questions[]`、出参 `answers[]`，字段必填性与 `additionalProperties` 一致；出参顶层放宽 `additionalProperties: true` 以承载 `presentationMeta`）；
2. 模型发起提问 → 插件读到**现读**的配置（`enabled` / `decisionProvider` / `decisionModel` / `confidenceThreshold` / `decisionTimeoutMs`）；
3. `enabled` 关闭（默认）或问题清单为空 → **直通**宿主 `ctx.userQuestions.ask()`，与出厂完全一致，不落账 meta；
4. `enabled` 开启且 `decisionProvider` / `decisionModel` 任一为空 → 打降级日志，**放行**真实提问，meta 记 `route-not-configured`；
5. `enabled` 开启且路由齐备 → 用决策模型评估：`buildDecisionPrompt` 确定性拼出问题清单（id / question / header / 选项 label / 选项 description / multi-select 标记）交给决策模型，模型回单个 JSON；`parseDecisionResponse` 解析出 `confidence`（越界钳到 0~1）、`answers`（按 id）、`reason`；解析失败恒为 `{ok:false, confidence:0, parseError}`；
6. 置信度 **≥ 阈值** 且模型建议答案**按 id 覆盖全部问题** → 自动作答（`selected` 按选项 label 白名单过滤，选项题 label 全是幻觉且无自定义文字视为没被回答），返回 `{answers, presentationMeta{confidence, decision:'auto-answered', rationale}}`，**不产生用户提问卡片**；
7. 其余一切情况（低置信 / 覆盖不全 / 调用失败 / 超时 / 被中止 / 解析失败 / llm 服务缺失）→ **放行真实提问**，返回 `{answers, presentationMeta{confidence, decision:'passed-through', rationale}}`，并打降级日志；
8. 决策评估是**纯旁路**：不写会话、不注册 MessageSourceMap、不经宿主 agent 状态机——决策链路的任何异常都被归类进放行路径，绝不抛穿成工具失败。

## 安装

### 环境要求

- dsh 宿主 **0.2.2-rc.2**（本包 e2e 实测基线：装载三断言、三路径门控行为均在该版本上实测通过；仓库根 devDependencies 仍钉 `@deepseek-ai/dsh@0.2.1-rc.2`，本包未在 0.2.1-rc.2 上做完整 e2e）。宿主需提供 `tools` 与 `userQuestions` 两个服务，以及 `llm` 服务用于决策调用——缺 `llm` 时按 `llm-unavailable` 降级放行，插件仍可装载

### 仓库内开发（link）

```sh
pnpm install                                                    # 仓库根，安装工作区依赖
dsh plugin add link:<仓库绝对路径>/plugins/dsh-decision       # link: 必须是绝对路径
```

包内 `dsh.bundle.patch`（`./cordis.patch.yml`）声明使其自动进入 profile 层，并**同时完成让位**（见下节），无需 overlay 注入。本包是 TS 源码入口（`main: src/index.ts`，依赖 Node 原生 type-stripping），**只支持 `link:` 安装**；实体安装（git / npm / tarball）会被 Node 以 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 拒绝。

### 安装验证

1. 启动日志出现 `[ask-gate] plugin loaded`；
2. 紧接着出现 `[ask-gate] registered 1 tool (ask_user_question)`；
3. 设置 → 插件 → `@zhidal/dsh-decision` 详情页能看到本插件的配置卡（`enabled` / `decisionProvider` / `decisionModel` / `confidenceThreshold` / `decisionTimeoutMs`）。

### 让位出厂提问工具行

宿主工具注册面（`ToolRuntime.register`）语义：**同一层内重复注册同名工具会直接失败**。本行要接管模型侧的 `ask_user_question`，必须让出厂行 `@deepseek-ai/dsh-tool-ask-user`（出厂预设里的 `- id: tool-ask-user`）停用，否则两行争抢同一个工具名。

让位声明**已内置在包内** `cordis.patch.yml`：

```yaml
- insert:
    - id: ask-gate
      name: './src/entries/ask-gate.ts'
    - id: decision-tools
      name: './src/entries/decision-tools.ts'

# 让位：出厂提问工具行停用，由 ask-gate 行接管同名工具面。
- id: tool-ask-user
  disabled: true
```

让位随包安装生效，**每个装了本包的 profile 都自动让位**；但「启用门控」是 per-profile 的配置，需要在每个想启用的 profile 里各配一次（见[配置](#配置)）。

> profile 侧**不要**再写这些行的 `insert:`——重复声明会让同一插件被实例化两次、同名工具注册两次。profile 只用 `- id: ask-gate` + `config` 覆盖配置。

## 配置

启用插件后，在 设置 → 插件 → `@zhidal/dsh-decision` 详情页配置（也可直接手改 profile 补丁层，见下）：

| 字段                  | 类型      | 默认    | 说明                                                                                                                                                       |
| --------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `boolean` | `false` | 门控总开关。关闭＝完全直通出厂提问行为（不拦截、不落账 meta）；开启＝先问决策模型，达标自动作答，否则放行真实提问                                          |
| `decisionProvider`    | `string`  | `''`    | 决策模型的 provider（留空＝未配置）。未配置时按 `route-not-configured` 降级放行                                                                            |
| `decisionModel`       | `string`  | `''`    | 决策模型的模型名（留空＝未配置）。同上                                                                                                                     |
| `confidenceThreshold` | `number`  | `0.8`   | 自动作答的置信度阈值（配置面板可填区间 0.05~1，步进 0.05）：**≥ 阈值**自动作答，**< 阈值**放行真实提问；边界值相等归自动作答；非法值（NaN / 越界）回落默认 |
| `decisionTimeoutMs`   | `number`  | `30000` | 单次决策评估超时（毫秒，1000~120000，步进 1000）。超时按降级放行处理                                                                                       |

### 配置存储与持久化

配置落在**宿主 profile 补丁层**（`~/.dsh/profiles/<profile>/cordis.patch.yml`）的条目 `config` 里，本插件**不引入任何自有配置文件或数据目录**：

```yaml
- id: ask-gate
  config:
    enabled: true
    decisionProvider: my-provider
    decisionModel: my-decision-model
    confidenceThreshold: 0.8
    decisionTimeoutMs: 30000
```

- **per-profile 隔离**：每个 profile 各配各的，想在哪个 profile 启用就在哪个 profile 写这份配置；重启宿主后保留。
- **保存即生效**：配置面字段全部是 volatile 字段，插件每次执行现读配置引用——改完保存无需重载。开启 HMR 的 profile 实时监听补丁层文件、改动即时生效；关掉 HMR 的 profile（headless / sdk / acp）才需重启宿主实例。

## 决策工具行 decision-tools

组合包的第二个插件行（决策工具系列 2/11 起落地、3/11 起注册工具）：面向 **agent 主动调用** 的决策工具族。与 `ask-gate` 方向相反——**fail-closed**（不猜、不放行）：

| 项       | ask-gate                           | decision-tools                                           |
| -------- | ---------------------------------- | -------------------------------------------------------- |
| 触发方   | 模型侧提问工具 `ask_user_question` | agent 显式调用 `decision_*` 工具                         |
| 失败方向 | fail-open 放行真实提问             | fail-closed 返回 `{ok:false,error}`                      |
| 判定对象 | 提问建议答案是否可信               | typed 判定 / 闸门 / 排序 / 批量 / 视觉定位 / 账本        |
| 配置面   | `src/core/config.ts`（5 字段）     | `src/config/decision-tools.ts`（33 字段、10 个工具开关） |

### 工具清单（十工具，契约闭集）

| 工具名               | 作用                                                      | 落地卡 |
| -------------------- | --------------------------------------------------------- | ------ |
| `decision_decide`    | typed 判定（noul / choice / score），返回概率分布而非散文 | 3/11   |
| `decision_gate`      | 危险动作前的闸门：allow / revise / block / escalate       | 3/11   |
| `decision_rerank`    | 2–10 候选按 fit 0–3 + risk 综合打分选型                   | 4/11   |
| `decision_batch`     | 1–5 组问题 × 1–20 条文本，并发有界，失败行原样上报        | 4/11   |
| `decision_locate`    | 图像内找目标 → 归一化坐标框                               | 5/11   |
| `decision_usage`     | calls / tokens / 成本 / 延迟 p95 / 燃尽率账本查询         | 5/11   |
| `decision_history`   | 决策历史查询（纯本地）                                    | 8/11   |
| `decision_recheck`   | 复检漂移（old / new / drift）                             | 8/11   |
| `decision_calibrate` | Brier 分数与置信度分桶校准审计（纯本地）                  | 10/11  |
| `decision_arbiter`   | 显式大模型裁判（与自动兜底共用通道、互不递归）            | 10/11  |

> **当前进度**：2/11 已落「行骨架 + systemone client + 统一调用层 + 配置面」；3/11 注册 `decision_decide` 与 `decision_gate`；4/11 注册 `decision_rerank` 与 `decision_batch`；5/11 注册 `decision_locate` 与 `decision_usage` 并把账本落盘与预算日窗口闸接通；6/11 落 react+shadcn 设置页与同源验证路由；7/11 落大模型兜底级联（裁判通道）；8/11 注册 `decision_history` 与 `decision_recheck`；10/11 注册 `decision_calibrate` 与 `decision_arbiter`（当前日志 `[decision-tools] registered 10 tools (decision_decide, decision_gate, decision_rerank, decision_batch, decision_locate, decision_usage, decision_history, decision_recheck, decision_calibrate, decision_arbiter)` + `registered verify route (POST /dsh-decision/verify)`）。其余工具按上表逐卡注册，注册后日志里的工具计数同步递增。

### 设置页与构建（client 半区）

决策工具行的设置页是 **react + shadcn 自渲染配置卡**（6/11 落地），注册进宿主插件详情页的 `plugins.bundle.config` 插槽：

- **构建前置（关键）**：`link:` 安装不会触发包的 `prepare` 脚本——e2e / 手动验证设置页前必须显式执行 `pnpm --filter @zhidal/dsh-decision build`（esbuild 打包 client 入口 + Tailwind 编译，产物落 `client/dist/`，**不入库**）。`pnpm install`（workspace 内）会自动执行 prepare 产出。
- **同源验证路由**：host 半区在插件装载后注册 `POST /dsh-decision/verify`（仅本机回环）；设置页「验证接口」按钮走**同源 fetch**（不跨域），请求体 `{baseUrl?, apiKey?, model?, timeoutMs?}`（省略字段回退已保存配置），响应 `{ok, model, latencyMs, reason}`，**不回显 apiKey**；验证成功且草稿与已保存配置一致时自动置 verified 状态（进程内）。
- **验证路由安全栅栏**（防跨站诱导宿主外发凭据）：①`content-type` 非 `application/json` → `415`（跨站简单请求不触发预检，直接挡掉）；②`Origin` 与 `Host` 不同源 → `403`；③请求体 >64KB → `413`、非 JSON 对象 → `400`；④草稿 `baseUrl` 与已保存**不同主机**时**不继承已保存的 apiKey**（必须显式给 key，避免把真实 key 发给攻击者端点）；⑤草稿 `baseUrl` 非法 → `invalid-arguments`。
- **web 端 boot 依赖运行时 inject 短服务名**：`client/src/plugin.tsx` 的 `export const inject = ['slots', 'locale', 'configForms']` 是 **web 平台** 的 boot graph 依据（宿主 web seed 只提供短服务名）；`package.json` 的 `dsh.client.inject` 写全模块 id，供桌面端使用——两者不同不是笔误。
- **凭据纪律**：`systemoneApiKey` 存放于宿主 profile 补丁层 config（`cordis.patch.yml` / 设置面板保存通道），不写日志、不写账本、不进错误信息；设置页输入框按密码语义渲染（`type=password`、关闭自动填充）。
- **自渲染页 vs 宿主出厂配置卡**：两者编辑**同一份 volatile 配置**——自渲染设置页是主编辑入口（分区、双语、验证按钮）；宿主按 Config schema 渲染的出厂卡是同一份数据的另一种编辑面，两处保存互相可见、无同步延迟。
- **主题纪律**：色值/圆角/间距只走宿主 `--dsw-alias-*` token（`@theme inline` 映射，见 `client/src/theme.css`），无硬编码颜色、无 `.dark` 类，深浅两态由宿主主题属性驱动。`theme.css` 的语义角色按设计稿 §3.1 的 25 行映射表逐条登记，新增角色先在设计稿登记再落地。
- **组件清单 vs 设计稿 §5**（A 模型接口 / B 开关 / C 预算 / D 兜底 / E 账本）：本卡落地 A1–A7、B1–B4、C1–C5、D1–D5、E1–E4 全部组件；设计稿 §5 标注的缺口项（A2 端点格式提示、A6 探测问卷预览、A7 轮询/最近验证时间、B2 分组说明、B3 依赖提示、B4 批量选择、C4 燃尽率图表、E1 账本表格、E3 成本明细、E4 导出）**在 6/11 未实现**，其中 A7「最近验证时间/错误」以只读文案形式补在模型区（不含探测问卷预览与轮询），其余随 7/11–11/11 的功能卡按需补齐。
- **客户端测试**：`client/src/**/*.test.ts(x)` 与源码同目录；渲染类测试按文件切 `// @vitest-environment jsdom`（依赖 jsdom + @testing-library/react，装于包 devDependencies）。

### 决策模型接口（systemone）

- 端点：`POST {baseUrl}/v1/systemone`，鉴权 `Authorization: Bearer <API key>`；
- 载荷：`{ model, state, questions }`（`questions` 为按 qid 索引的 map，≤16 题；图像走 `assets` + `TypeSafe-Danger-Zone-Images: true` 头）；
- 响应：`{ answers: { <qid>: … }, usage: { input_tokens, output_tokens } }`；`noul` 至少含 `noul`（P(yes)）、`choice` 至少含 `choice`、`score` 至少含 `score` 与 `legend`；缺失的 `confidence` / `probabilities` 记 `null`，**不臆造**；
- 账本落位（契约 §5.4）：`<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`（`DSH_HOME` 环境变量，缺省回退 `~/.dsh`；5/11 起文件写盘接通）。超过 `ledgerMaxEntries` 滚动淘汰最旧条目——被淘汰条目的 `decisionId` 之后查询返回 `decision-not-found`（**不猜**）；
- 完整契约见 [`docs/decision-tools-contract.md`](docs/decision-tools-contract.md)（十工具 JSON Schema、16 条错误码闭集、账本结构、兜底级联口径），设置页视觉方案见 [`docs/decision-tools-design.md`](docs/decision-tools-design.md)。

### 兜底级联（7/11）

当轻量决策模型**没配置、调用失败或拿不准**时，可由**大模型裁判**出场做一次慢思考复核：

- **三条触发路径**：T1 未配置模型（`model-not-configured`）、T2 调用失败（`model-call-failed` / `model-timeout` / `model-invalid-response`）、T3 置信度低于 `fallbackMinConfidence`（decide 另看 `agreement`）。T1/T2 由统一调用层内部兜底，T3 由工具层挂点。
- **只对 decide / gate 生效**：自动兜底仅作用于 `decision_decide` 与 `decision_gate`；显式仲裁由 `decision_arbiter` 单独调用（10/11 落地），二者共用同一裁判通道、互不递归。
- **裁判路由优先级**：设置页显式填写的 `fallbackProvider` + `fallbackModel`（`origin=explicit-config`）→ 否则用**会话当前模型**（`origin=session-model`，插件侧从宿主会话投影 best-effort 读取）→ 都取不到则返回 `arbiter-unavailable`（**不猜模型**）。
- **meta 出参**：触发兜底时出参带 `fallback` 块（`triggered` / `trigger` / `route` / `originalSource` / `originalConfidence` / `error`），同时 `source` 变为 `llm-fallback-judge`；兜底失败**保留首判原错误码**（裁判原因并入 `error.details.judgeError`），首判成功时**维持首判结论**只标注 `fallback.triggered=false`（不产无来源结论）；未触发时该块整体省略。
- **预算与记账**：裁判调用走独立配额 `fallbackMaxCallsPerDay`（只统计裁判条目），不与主三维闸混算；账本用 `source='llm-fallback-judge'` + `mode='auto-fallback' | 'explicit-arbiter'` 区分，裁判失败另落一条 `status='error'` 条目。
- **契约**：完整口径见 [`docs/decision-tools-contract.md`](docs/decision-tools-contract.md) §10.1–§10.3。

### 配置要点

| 字段                                           | 默认            | 说明                                                                 |
| ---------------------------------------------- | --------------- | -------------------------------------------------------------------- |
| `systemoneBaseUrl`                             | `''`            | 决策端点 baseUrl（请求打到 `{baseUrl}/v1/systemone`）                |
| `systemoneApiKey`                              | `''`            | Bearer key；**不写日志 / 账本 / 错误信息**                           |
| `systemoneModel`                               | `''`            | 决策模型名（不是宿主会话模型）                                       |
| `systemoneTimeoutMs`                           | `30000`         | 单次调用超时（毫秒，1000~300000）                                    |
| `systemoneVerifiedAt` / `systemoneVerifyError` | `''`            | 最近一次验证结果（展示态，6/11 设置页回写）                          |
| `tools*Enabled`（10 个）                       | `false`         | 十个工具开关，**默认全关**；关闭即调用报 `tool-disabled`             |
| `budget*` / `cost*`（6 项）                    | 见契约 §6.4     | 本地硬预算与成本费率（费率默认 0 → 成本记 0 且不标估算）             |
| `fallback*`（7 项）                            | 见契约 §6.5     | 大模型兜底级联（置信度门控）；默认关闭                               |
| `ledgerEnabled` / `ledgerMaxEntries`           | `true` / `1000` | 账本开关与滚动上限（淘汰条目的 `decisionId` → `decision-not-found`） |
| `gateAllowThreshold`                           | `0.8`           | gate 允许阈值（低于即 escalate，**不 fail-open**）                   |

### 加载与验证

1. 启动日志出现 `[decision-tools] plugin loaded`；
2. 工具注册日志形如 `[decision-tools] registered N tools (...)`（10/11 起 N=10：`decision_decide`, `decision_gate`, `decision_rerank`, `decision_batch`, `decision_locate`, `decision_usage`, `decision_history`, `decision_recheck`, `decision_calibrate`, `decision_arbiter`；工具卡落地后递增）；
3. 未配置或未验证决策模型时调用工具 → 返回错误信封 `model-not-configured` / `model-verify-failed`（**不静默降级、不猜答案**）。

### 本行已知限制

- **工具按卡增量注册**——截至 10/11 已注册 `decision_decide` / `decision_gate` / `decision_rerank` / `decision_batch` / `decision_locate` / `decision_usage` / `decision_history` / `decision_recheck` / `decision_calibrate` / `decision_arbiter`（共 10 个），注册后启动日志的工具计数同步递增；
- **校准结论是估算性质**——`decision_calibrate` 只统计**已回填 outcome 的 noul 判定**（真值 confirmed → 1、rejected → 0），`choice` / `score` 因真值语义不支持（契约 §7.2）计入 `excluded.nonBinary` 不参与计算；样本量 < 20 时 `brier` 与 `overconfidence.meanGap` 置 `null` 不硬算，桶级样本 < 5 时该桶 `hitRate = null` 且标 `insufficient`；
- **显式裁判与自动兜底是两件事**——`decision_arbiter` 由 agent 主动调用（`fallbackMode` 需含 `explicit-arbiter`），自动兜底由置信度门控/调用失败触发（`fallbackMode` 需含 `auto-fallback`）；二者共用 7/11 的裁判通道入口，**互不递归**（裁判自身不再触发兜底），账本里靠 `mode`（`explicit-arbiter` / `auto-fallback`）区分；`disagreement` 只表示两次判定不一致，**不代表谁对**；
- **仲裁题目按账本重建**——账本不保存 state 原文与题目全文（契约 §5.1），所以按 `decisionId` 仲裁时只能用条目里的题型 + 摘要 + 判定分布重建题目（noul 二元 criteria、choice 候选集取 `distribution` 的键）；题型不在仲裁口径内（score / box）返回 `invalid-arguments`，原条目不是成功判定或已滚动淘汰返回 `decision-not-found`，绝不猜；
- **账本已落盘**——5/11 起 `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`（DSH_HOME 缺省回退 ~/.dsh），重启不丢；`ledgerEnabled=false` 时账本不落盘且预算闸退化为直通（硬预算需要账本统计用量）；该开关在插件加载时固化，true↔false 切换需重启插件生效；账本文件读取失败时预算统计归零并以 warn 显式提示（与损坏行跳过的 warn 文案不同）。
- **验证状态是进程内的**——重启宿主或改动 baseUrl / API key / model 后需重新验证（配置指纹失配即 `model-verify-failed`）；
- **预算闸已真实化、兜底级联已接入**——5/11 起日窗口（UTC，`budgetResetHourUtc`）按 calls / tokens / cost 三维统计，超限返回 `budget-exceeded` 并只落一条 `blocked` 账本记录；7/11 起兜底级联可用（`fallbackEnabled=true` 且 `fallbackMode` 含 `auto-fallback`），裁判走独立配额 `fallbackMaxCallsPerDay`；
- **纯本地三工具不走模型调用层**——`decision_usage` / `decision_history` / `decision_calibrate` 只读本地账本，误入统一调用层会被 `invalid-arguments` 拒绝（契约 §1.3）；
- **复检题目按账本重建**——账本不保存 state 原文与题目全文（契约 §5.1），所以 `decision_recheck` 只能用条目里的题型 + 摘要 + 判定分布重建题目（choice 候选集取 `distribution` 的键、score 档位取 `legend`）；原条目不是成功判定、已滚动淘汰或题型不在漂移口径内（box）时分别返回 `decision-not-found` / `invalid-arguments`，绝不猜；
- **与 ask-gate 的判定方向相反是刻意设计**——`ask-gate` 服务「别拦着人」，`decision-tools` 服务「别猜」；两行的配置与开关彼此独立。
- **定位能力取决于决策模型**——9/11 实测：当前可用的决策模型（`local-decision-model`）**不支持 box 题型**，发图像定位请求会被上游以 HTTP 400 拒绝（`questions.target: "type" must be one of: choice, score, noul`）→ `decision_locate` 返回 `model-unsupported-capability` 且不返回任何坐标。这是上游能力缺失、不是插件缺陷；换成支持 box 的模型即可直接使用（插件侧已按契约把该 400 归到能力缺失而非载荷错误）。
- **本行调用是纯旁路 HTTP，不受 `dsh-llm-fallback` 保护**——`decision_*` 工具直连 `{baseUrl}/v1/systemone`（不走宿主 `agent/request` waterfall），`dsh-llm-fallback` 的失败回退、冷却、熔断对它**不生效**；本行自带自己的降级口径（`model-call-failed` / `model-timeout` / `model-invalid-response` 与大模型兜底级联），不静默重试也不猜测结果。
- **成本是估算口径**——账本里的 `costUsd` 按配置费率（`costInputPer1kTokens` / `costOutputPer1kTokens`）换算；费率默认为 0 → 成本记 0 且**不标估算**，此时 `costEstimated=false` 只代表「没配费率」，不代表真实花费为零；配了费率时 `costEstimated=true`，数值是本地线性估算，与上游账单口径可能不一致。
- **账本是插件本地数据，与宿主会话轨迹不混用**——账本落在 `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`（插件自管文件），**不是**宿主会话轨迹；会话轨迹里能看到的是工具调用本身（入参与出参），两者不可互相替代：`decision_usage` / `decision_history` / `decision_calibrate` 读的是账本，轨迹里查不到账本统计。
- **apiKey 明文存放于 profile 补丁层**——`systemoneApiKey` 与其它配置字段一样以明文写在宿主 profile 补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）或设置页保存通道里；插件侧保证**不写日志、不写账本、不进错误信息、验证接口不回显**，但配置文件本身的明文存储由宿主 profile 机制决定，请按所在机器的凭据管理要求处置。

## 组合包扩展约定

本包是**决策域通用组合包**（架构仿 `dsh-anytype` 单包多插件）。新增一个决策点成员时：

1. **建入口文件** `src/entries/<决策点>-gate.ts`，导出 cordis 契约三符号 `name` / `apply` / `inject`，并 re-export `Config`（不 re-export 宿主设置面板会整块丢弃该插件的字段）；
2. **登记插件行**：在包内 `cordis.patch.yml` 的 `insert:` 列表续一行，`id` 必须等于入口导出的 `name`：

   ```yaml
   - insert:
       - id: ask-gate
         name: './src/entries/ask-gate.ts'
       - id: tool-gate
         name: './src/entries/tool-gate.ts'
   ```

3. **复用共用件**：`src/core/config.ts`（配置面与 volatile 支持）、`src/core/decision.ts`（决策调用 / 响应解析 / 阈值判定，**与决策点无关**）、`src/core/user-questions.ts`（宿主 `userQuestions` 的本地最小类型面）；决策点特有的映射与 meta 构建放 `src/services/<决策点>-gate.ts`；
4. **接管别的工具名时要一并让位**：像 `ask-gate` 让位 `tool-ask-user` 一样，在包内 `cordis.patch.yml` 追加 `- id: <出厂行 id> / disabled: true`；
5. **新增配置字段**：加进 `src/core/config.ts` 的 `Config`——**每个可编辑字段都必须包 `volatileField()`**（否则设置面板会把该插件整块丢弃），并用 `desc(en, zh)` 给双语描述；
6. **成员命名**：一律 `<决策点>-gate`；决策 core 不感知决策点，新增成员不应改动 `src/core/decision.ts` 的判定语义。

## 轨迹可见性

门控判定结果随工具返回体顶层 `presentationMeta` 落账（会话轨迹的 tool / result 记录里可见）：

```json
{
  "answers": [
    {
      "id": "fruit-preference",
      "selected": ["苹果"],
      "custom": "[decision auto-answer] choose 苹果"
    }
  ],
  "presentationMeta": {
    "confidence": 0.95,
    "decision": "auto-answered",
    "rationale": "低风险偏好题，存在明确默认值"
  }
}
```

| 字段                          | 含义                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `presentationMeta.confidence` | 决策模型给出的置信度（0~1）；未成功评估的降级路径为 `0`                                                                                                                                                                                                                                                         |
| `presentationMeta.decision`   | `auto-answered`＝已由决策模型自动作答；`passed-through`＝放行真实提问                                                                                                                                                                                                                                           |
| `presentationMeta.rationale`  | 自动作答时是模型的 `reason`；**低置信放行**（评估成功但低于阈值）时同样是模型的 `reason`；**降级放行**（评估没跑通）时才是真实降级信号（`route-not-configured` / `model-error` / `timeout` / `aborted` / `llm-unavailable` / `route-invalid` / `no-json-object` 等）；答案覆盖不全时前缀 `answers-incomplete: ` |
| `answers[].custom` 的前缀     | 自动作答恒带 `[decision auto-answer]` 前缀，便于 agent 与用户识别「这不是用户亲口说的」                                                                                                                                                                                                                         |

另外，宿主实例日志里可见同源信息，三条日志对应三条不同出口：

- `[ask-gate] decision auto-answered (confidence=0.95, threshold=0.8)`——高置信自动作答；
- `[ask-gate] decision below threshold (confidence=0.10, threshold=0.8); passing through`——评估与解析都成功、只是把握度不够，放行真实提问（**不是故障**）；
- `[ask-gate] decision degraded (<信号>, confidence=0.00); passing through`——评估/解析没跑通，括号里是真实降级信号。

## 已知限制

- **只覆盖 legacy 模式**——出厂提问工具的 timed 模式（带时限的自动放行）**未接入**：本行按 legacy 语义实现，被接管后 timed 模式不可用。
- **工具描述文案与出厂不一致**——本行的工具 `description` 与 `header` / `options` 字段描述相对出厂 legacy 行做了改写（结构约束一致：必填性、`additionalProperties` 相同）。这些文案是模型每次调用都会看到的提示，会带来轻微的模型侧行为漂移；如需逐字一致应以出厂行为准，不要用本行做文案基准。
- **决策模型有误答风险**——自动作答等于替用户做主。控制手段只有两个：`confidenceThreshold`（抬高阈值＝更少自动作答）与总开关 `enabled`（关闭＝完全回到出厂行为）。高风险决策建议直接关闭门控。
- **决策调用不受 `dsh-llm-fallback` 保护**——决策评估是**纯旁路**调用（直接走 `llm` 服务的 `prepareCall` + `stream`），不经过 `agent/request` / `agent/request-error` waterfall，因此 `dsh-llm-fallback` 的失败回退、冷却、熔断对**它不生效**；决策链路的失败一律按本地降级放行处理。
- **决策调用不进会话上下文**——不写会话、不注册 MessageSourceMap、不经宿主 agent 状态机；决策模型的往返在轨迹里只体现为本次工具调用。
- **出参 schema 顶层放宽**——为承载 `presentationMeta`，工具出参顶层 `additionalProperties` 放宽为 `true`（出厂为 `false` 且严格校验，不放宽会抛 `ToolOutputError`）；`answers` 数组项仍是严格 `false`。
- **仅 `link:` 安装**——TS 源码入口 + 私有包，无构建发行；实体安装（git / npm / tarball）不可用。
- **Web GUI 不渲染置信度**——当前只有轨迹与日志里的 `presentationMeta` 可查，设置面板没有置信度可视化。

## 故障排查

- **提问照常弹卡片、从不自动作答**：按顺序查——`enabled` 是否为 `true`；`decisionProvider` / `decisionModel` 是否都非空；`confidenceThreshold` 是否高过决策模型实际给出的置信度；实例日志里搜 `[ask-gate] decision ` 看走的哪条出口：`decision below threshold` 表示评估成功但把握度不够（调低阈值或换更明确的模型）；`decision degraded (` 括号里是真实降级信号——`route-not-configured` 说明路由没配、`model-error` 说明模型名/网关不对、`timeout` 说明超时太短、`no-json-object` 等解析信号说明模型没吐出可解析的 JSON。
- **启动即报 `host userQuestions service is unavailable`**：让位已生效但宿主 `userQuestions` 服务缺失——宿主版本不支持或该服务被停用，本行无法自行提供提问通道。
- **启动报同名工具重复注册**：让位没生效（包内 `cordis.patch.yml` 未被加载，或 profile 侧又写了一份 `insert:`）。查 profile 补丁层里有没有多余的 `- id: ask-gate / insert:`。
- **决策模型返回了 JSON 却仍放行**：解析要求**单个** JSON 对象（允许 ```json 围栏）；答案还必须**按 id 覆盖全部问题**，覆盖不全会被判 `answers-incomplete` 放行；选项题的 `selected` 必须是选项 `label` 的原值，白名单外的 label 会被过滤，过滤后为空且无 `custom` 视为没被回答。
- **改了配置不生效**：确认改的是**该 profile** 的补丁层条目 `- id: ask-gate` 的 `config`；开启 HMR 的 profile 即时生效，headless / sdk / acp 这类关掉 HMR 的 profile 需要重启宿主实例。

## 开发

```sh
pnpm install
pnpm lint && pnpm typecheck && pnpm test
```

- 源码布局：`src/entries/`（插件行，一个决策点一个入口）/ `src/core/`（配置面、决策 core、宿主类型面）/ `src/services/`（决策点特有逻辑）；包入口 `src/index.ts` 负责 re-export 插件契约与 `Config`。
- 契约测试：`src/manifest.test.ts`（包元数据 ↔ `cordis.patch.yml` ↔ 入口 `name` 互锚）与 `src/readme.test.ts`（本文档的默认值 / 安装命令 / 装载日志行 / meta 字段名 ↔ 代码常量互锚）——改实现忘改文档会在此变红。
- 决策 core 的判定语义（阈值边界、解析失败语义、fail-open 方向）改动前先看 `src/core/decision.ts` 头注释：它是**与决策点无关**的纯函数层，判定方向一律朝「放行」倾斜。

## 许可证

MIT
