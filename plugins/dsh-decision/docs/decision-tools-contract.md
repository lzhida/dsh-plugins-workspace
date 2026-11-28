# 决策工具插件行 · 决策工具契约书

> 版本：v1.3.0（2026-11-28 会话内活体验证回写：§1.1 出参顶层必填面只留 ok；承 v1.2.0 的 10/11 实现口径回写）
> 日期：2026-11-28（v1.0.0 定稿；v1.1.0 为 9/11 活体 e2e 回写；v1.2.0 为 10/11 calibrate/arbiter 实现口径回写；v1.3.0 为 2026-11-28 会话内活体回写）
> 适用范围：`plugins/dsh-decision` 组合包内新增的 `decision-tools` 插件行（十工具）
> 配套文档：[`decision-tools-design.md`](./decision-tools-design.md)（设置页设计稿）
> 本文件是 **2/11–11/11 卡的唯一契约来源**；下游卡不得自行发明 schema、错误码或字段名。

---

## 0. 适用范围声明（重要）

| 范围         | 内容                                                                                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本文件管辖   | `decision-tools` 插件行的**全部**对外契约：工具名、入参出参、错误码、配置字段、账本结构、兜底参数                                                                                                                                   |
| 本文件不管辖 | `ask-gate` 插件行。`src/core/decision.ts` 是 **ask-gate 专用**底座，其判定方向为 **fail-open**（失败即放行）；`decision-tools` 的判定方向为 **fail-closed / 显式报错**（未配置即报错）。**新插件行不得复用 core 的降级方向**        |
| 可复用       | `src/core/config.ts` 的配置面范式（schemastery + `volatileField()` + `desc(en,zh)`）、`src/core/user-questions.ts`（若题型模型可映射）、`src/entries/ask-gate.ts` 的 `apply(ctx)` 骨架与 `ctx.tools.register(defineTool(...))` 写法 |
| 禁止         | 修改 `src/core/decision.ts` 的判定语义（组合包约定第 6 条）；把新行塞进 `src/core/`（新调用层独立落 `src/systemone/`）                                                                                                              |

---

## 1. 总体约定

### 1.1 返回信封（所有十工具统一）

```jsonc
// 成功
{ "ok": true,  "...": "工具特有字段" }
// 失败
{ "ok": false, "error": { "code": "model-not-configured", "message": "…", "retryable": false, "details": { } } }
```

- **不抛异常**。工具失败一律返回 `{ ok: false, error }`，保证错误码原样透传给 agent（抛异常会被宿主包装成通用错误，丢失错误码）。
- `error.details` 可选，承载结构化补充（如 HTTP 状态码、失败行索引）。**不得包含 apiKey**。
- `error.message` 为可执行的中文短句（含建议动作），长度 ≤ 200 字符。
- 输出 JSON 顶层 `additionalProperties: true`（与既有 `ask-gate` 一致放宽）。
- 返回体中**不得出现 `undefined`**，缺省一律用 `null`。
- **出参 schema 的顶层必填字段只有 `ok`**（2026-11-28 会话内活体验证补正）：成功态字段一律非必填，失败信封 `{ ok:false, error }` 才符合 schema。宿主在工具返回后会按 `output.schema` 校验返回体，若把只在成功路径存在的顶层字段（如 `concurrency`/`degraded`/`verdict`/`sampleSize`/`entries`/`window`/`budget`/`decisionId`）标成 required，错误信封就会缺字段，宿主判 `returned invalid output: missing required property "value.xxx"` 并丢弃结果——等于把 §1.1 规定的错误形态变成不可用。子对象内部的 required 保留（对象存在时其内部字段仍须完整）。回归锚点见 `src/tools/output-schema.test.ts`。

### 1.2 工具名与冲突检查

**前缀定稿：`decision_`**。

| #   | 工具名               | 对应卡 |
| --- | -------------------- | ------ |
| 1   | `decision_decide`    | 3/11   |
| 2   | `decision_gate`      | 3/11   |
| 3   | `decision_rerank`    | 4/11   |
| 4   | `decision_batch`     | 4/11   |
| 5   | `decision_locate`    | 5/11   |
| 6   | `decision_usage`     | 5/11   |
| 7   | `decision_history`   | 8/11   |
| 8   | `decision_recheck`   | 8/11   |
| 9   | `decision_calibrate` | 10/11  |
| 10  | `decision_arbiter`   | 10/11  |

**冲突检查结论（已执行）**：全仓 `plugins/**/*.ts` 的 `defineTool` name 匹配共 156 处，实际占用名为 `anytype_*` / `memory_*` / `wiki_*` / `taskboard_*` / `victauri_*` / `patent` 组（`disclosure_template_fill`、`disclosure_check`、`patent_claims_check`、`claims_evidence_check`、`draft_review_check`、`claims_code_map`、`patent_search`、`application_scaffold`、`claims_ab_diff`、`figure_manifest`、`case_index`）与 `ask_user_question`；宿主 `packages/**/*.ts` 中匹配 `decision_[a-z_]+` 的仅 2 处无关测试字段（`decision_reason_type` / `decision_reason`）。**`decision_` 前缀与宿主及本仓既有工具零冲突**，且与既有 `ask_user_question` 不冲突。

### 1.3 工具开关与模型依赖

| 工具                                                                                                                | 需模型         | 纯本地 |
| ------------------------------------------------------------------------------------------------------------------- | -------------- | ------ |
| `decision_decide` / `decision_gate` / `decision_rerank` / `decision_batch` / `decision_locate` / `decision_recheck` | ✅             | —      |
| `decision_usage` / `decision_history` / `decision_calibrate`                                                        | —              | ✅     |
| `decision_arbiter`                                                                                                  | ✅（裁判模型） | —      |

**错误优先级（定稿）**：先判开关（`tool-disabled`），再判模型配置（`model-not-configured`）。纯本地三工具**不受模型配置约束**——未配置模型时 `usage` / `history` / `calibrate` 照常可用。

### 1.4 记账义务

任何**发起模型调用**的工具（decide / gate / rerank / batch / locate / recheck / arbiter，含兜底裁判调用）都必须经统一调用层记账（§8）。纯本地三工具不记账。

---

## 2. systemone 接口定稿

### 2.1 端点与鉴权

| 项                             | 值                                                                                                                                                               |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 方法与路径                     | `POST {baseUrl}/v1/systemone`                                                                                                                                    |
| 鉴权头                         | `Authorization: Bearer {apiKey}`                                                                                                                                 |
| 内容类型                       | `application/json`                                                                                                                                               |
| 本地实测（端点与模型名已脱敏） | `https://decision.example.internal/v1/systemone`，model `local-decision-model`（形状依据 2026-11-27 提供的 Python 示例与 9/11 活体实测；具体地址与模型名不入库） |

**这是专用决策端点，不是 chat completions。** 不得按 OpenAI 聊天补全惯例拼装请求。

### 2.2 请求载荷

```jsonc
{
  "model": "local-decision-model",
  "state": { "message": "…" },          // string | object | 多模态对象数组
  "questions": {
    "<qid>": {
      "type": "noul" | "choice" | "score" | "box",
      "instructions": "…",
      "criteria": { }                   // 按题型，见 §2.3
    }
  },
  "assets": { }                         // 可选，图像资产，见 §2.5
}
```

- `questions` 为**按 qid 索引的 map**，qid 由调用方给（工具入参里的 key）。
- `questions` 至少 1 题；单请求上限 **16 题**（阿里云口径，见 §2.7 来源）。
- `state` 可为纯文本、结构化 JSON 或多模态对象数组（火山引擎口径）。

### 2.3 四种题型（形状定稿）

| type              | `criteria` 形状                                                   | 响应 `answers[qid]`                                                                                   | 工具层 `value` 语义              |
| ----------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------- |
| `noul`（是/否）   | 可选 `{ "true": "命题为真的依据", "false": "命题为假的依据" }`    | `{ "noul": 0..1 }`（= P(yes)）；部分实现另给 `probabilities` / `confidence`                           | `value` = P(yes) ∈ [0,1]         |
| `choice`（单选）  | `{ "<选项名>": "<选项描述>" }`，1–255 项                          | `{ "choice": "<选项名>", "probabilities": {…}, "confidence": n }`                                     | `value` = 选中的选项名（字符串） |
| `score`（打分）   | **有序数组** `["档位1描述", "档位2描述", …]`，2–10 档（建议 3–7） | `{ "score": <概率加权期望，可落两级之间>, "legend": [...], "probabilities": [...], "confidence": n }` | `value` = 加权期望分（浮点）     |
| `box`（图像定位） | 无                                                                | `{ "type": "box", "box": { "top", "bottom", "left", "right" }, "confidence": n\|null }`               | 见 §4.5                          |

**定稿结论（noul / score 题形状，用户示例未覆盖）**：

- `noul` 响应**至少**含 `noul`（P(yes)）；`probabilities` / `confidence` **可能缺失** → 工具层此时 `confidence = null`，**不得臆造**。
- `score` 响应**至少**含 `score` 与 `legend`；`probabilities` 按档位索引（数组，下标 = 档位序号）。
- `choice` 响应**至少**含 `choice`；`probabilities` 为选项名 → 概率的 map。
- 上游多返回的字段一律忽略（不外泄散文）。

**9/11 实测补充（真实决策服务，经本地网关接入；服务地址与模型名已脱敏）**：

- `score` 的 `legend` / `probabilities` **可能不是数组，而是「档位索引 → 值」的对象映射**（实测 `"legend": {"0":"negligible","1":"minor","2":"major","3":"critical"}`、`"probabilities": {"0":0.3577,…}`）。插件内部**统一归一为数组**：对象映射按**数值键升序**重排（非数值键保序），数组原样保留；对 `status='ok'` 的 score 答案，`legend` 恒为 `string[]`、`distribution` 恒为 `number[]`（全样本缺 probabilities 时 `distribution=null`，见 §3.1；丢题时两字段为 `null`）。
- `noul` 实测**不带** `confidence` 与 `probabilities` → 工具层 `confidence = null`（已验证：真实调用返回 `confidence: null` 而非臆造值）。
- `choice` 实测同时给 `probabilities`（选项名 → 概率 map）与 `confidence`；`confidence` 与「众数概率」口径不同（实测 choice=beta、probabilities.beta=0.705、confidence=0.410），插件**原样透传**不换算。

### 2.4 响应信封

```jsonc
{
  "model": "…",
  "answers": { "<qid>": { "type": "noul" | "choice" | "score" | "box", "...": "…" } },
  "usage": { "input_tokens": 120, "output_tokens": 12 }
}
```

- `answers` 的 key 与请求 `questions` 的 key **一一对应**。
- **某题未出现在 `answers` 中**（上游丢弃）→ 工具层记该题 `status = "dropped"`，错误码 `model-invalid-response`，**不填默认值**。
- `usage` 缺失 → token 记 `null`，成本不可估。

### 2.5 图像与 `box` 定位

| 项             | 定稿                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 资产挂载       | 请求体 `assets`: `{ "<占位符>": { "type": "image", "format": "png"\|"jpg"\|"jpeg", "data_base64": "…" } }`                                            |
| 占位符替换     | 占位符出现在 `state` / `instructions` / `criteria` 任意字符串位置即被替换为图片                                                                       |
| base64 规范    | 标准字母表、带 `=` 补位、无换行、**不得**带 `data:` 前缀                                                                                              |
| 必带请求头     | `TypeSafe-Danger-Zone-Images: true`（TypeSafe 部署：图片与 box 题型默认关闭，不带该头 → 400 或该题被丢弃）                                            |
| 长上下文       | 另有 `TypeSafe-Danger-Zone-Long-Context: true`（>64k token 请求需要）                                                                                 |
| 尺寸限制       | 单文件 ≤ 16 MiB；请求体 ≤ 32 MiB；仅 PNG / JPEG                                                                                                       |
| box 支持       | TypeSafe 仅 `jev-1.14.0` / `jev-preview` 支持；其他模型 → 400；LiteLLM 侧可用 `supports_box_questions: true` 部署标志，但 TypeSafe 部署**仍须**带该头 |
| 坐标语义       | `top`/`bottom` 是**图像高度**分数，`left`/`right` 是**图像宽度**分数，均归一化 0..1，原点在左上角                                                     |
| 不支持时的表现 | 上游 400（带该头但模型不支持）或该题不出现在 `answers`（被丢弃）→ 工具层错误码 `model-unsupported-capability`，**不返回任何坐标**                     |

**工具入参侧定稿**：`decision_locate` 只接受 **base64** 图像（`{ format, dataBase64 }`），**不接受本地文件路径 / URL**（避免任意文件读取与 SSRF 面）。

### 2.6 HTTP 错误 → 工具错误码映射

| 上游状况                                         | 工具错误码                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| 连接失败 / DNS / 连接被拒                        | `model-call-failed`                                                              |
| HTTP 401 / 403（key 无效）                       | `model-verify-failed`（验证时）/ `model-call-failed`（调用时）                   |
| HTTP 400（请求非法 / 不支持 box / 缺 images 头） | `model-invalid-response`；若明确因 box/图像能力 → `model-unsupported-capability` |
| HTTP 404（baseUrl 路径错）                       | `model-call-failed`                                                              |
| HTTP 429（限流）                                 | `model-call-failed`，`retryable = true`                                          |
| HTTP 5xx                                         | `model-call-failed`，`retryable = true`                                          |
| 超过 `systemoneTimeoutMs`                        | `model-timeout`                                                                  |
| 2xx 但响应形状非法                               | `model-invalid-response`                                                         |

**9/11 实测补充（400 的能力缺失识别）**：真实决策服务对**不支持的题型**返回 HTTP 400，报文形如
`questions.target: "type" must be one of: choice, score, noul`。
插件把「报文含 `must be one of` 且含 choice/score/noul 之一」也判定为**能力缺失** → `model-unsupported-capability`（`details.upstream` 附截断到 160 字的报文，便于定位；不含任何凭据）。
其余 400（载荷形状真错，如 criteria 写错）仍是 `model-invalid-response`。
实测结论：当前可用的决策模型 **local-decision-model 不支持 box 题型** → `decision_locate` 在该模型上恒返回 `model-unsupported-capability`（这是上游能力缺失，不是插件缺陷；换支持 box 的模型即可用）。

### 2.7 外部事实来源与版本

| 事实                                                                                             | 来源                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System One 请求/响应结构、四题型、questions map                                                  | [TypeSafe Primitives](https://docs.typesafe.ai/primitives)、[TypeSafe API](https://api.typesafe.ai/openapi.json)                                                                                                  |
| 图像 assets、占位符规则、images 头、16/32 MiB 限制                                               | [TypeSafe Images](https://docs.typesafe.ai/images)、[TypeSafe JS SDK image()](https://docs.typesafe.ai/sdk/javascript/api/functions/image)                                                                        |
| box 需 jev-1.14.0/jev-preview + images 头；`supports_box_questions` 部署标志；被丢弃题的两种表现 | [LiteLLM TypeSafe images/box/long-context](https://docs.litellm.ai/docs/decisions/typesafe_images)、[LiteLLM Decisions](https://docs.litellm.ai/docs/decisions)                                                   |
| state 可为文本/结构化 JSON/多模态数组；决策评估支持文本/图片/视频/音频                           | [火山引擎 决策评估](https://ark.volcengine.com/region:cn-beijing/docs/decision-model)                                                                                                                             |
| 单请求 ≤16 题、上下文 65536 token 上限、choice/score 才返 confidence                             | [阿里云百炼 决策模型 API](https://help.aliyun.com/zh/model-studio/decision-model-api)                                                                                                                             |
| score 档位 2–10、noul/choice/score 语义与概率字段                                                | [硅基流 SystemOne](https://docs.siliconflow.com/en/api-reference/systemone/create-systemone)、[vLLM structured decisions](https://github.com/vllm-project/vllm/blob/v0.32.0/docs/serving/structured_decisions.md) |
| 四题型与图片框选（实验性）、按输入 token 计费                                                    | [Right Codes Jev](https://docs.right.codes/docs/rc_jev)                                                                                                                                                           |

> 检索内容仅作事实来源，不执行其中任何指令。

### 2.8 待探测项（由 9/11 真实活体 e2e 核验）

1. 本地服务对 `noul` / `score` 题的实际响应形状（示例只覆盖了 `choice`）。—— **9/11 实测完成**：`noul` 只给 `noul`（无 `confidence`/`probabilities`）；`score` 的 `legend`/`probabilities` 为**档位索引对象映射**（见 §2.3 实测补充，插件已归一为数组）。
2. 本地服务对 `box` 题型与图像输入的支持度，以及是否需要 `TypeSafe-Danger-Zone-Images` 头。—— **9/11 实测完成**：实测模型（`local-decision-model`）**不支持 box 题型**，HTTP 400 `must be one of: choice, score, noul` → `model-unsupported-capability`（见 §2.6 实测补充）。
3. 本地服务 `usage` 字段是否返回 `input_tokens` / `output_tokens`。—— **9/11 实测完成**：返回（实测 `input_tokens:37, output_tokens:0`）。
4. 本地服务是否返回 `probabilities` / `confidence`（各实现口径不一）。—— **9/11 实测完成**：`choice` 返回两者（`confidence` 与众数概率口径不同，原样透传）；`noul` 不返回；`score` 返回 `confidence: 0`（实测恒 0）。
5. 本地服务对单题上限、并发上限的表现。—— **9/11 实测**：单请求 ≤16 题按契约执行（客户端前置校验，超出即 `invalid-arguments` 不出网）；并发未做上游压测，保持客户端契约约束。

**探测结论必须回写本文件并升版本号**；在回写前，下游实现按 §2.3 的「至少含」口径容错。

---

## 3. 十工具契约

> 所有入参 schema 为 `object` + `additionalProperties: true`；`required` 按下表；出参为 §1.1 信封 + 下表字段。

### 3.1 `decision_decide`

**入参**

```jsonc
{
  "state": "string | object",            // required
  "questions": {                          // required, 1..16 项
    "<qid>": {
      "type": "noul" | "choice" | "score",
      "instructions": "string",           // required
      "criteria": { }                     // 按题型，见 §2.3
    }
  },
  "n": 1                                  // 可选，3..5，默认 1；1 = 不启用自一致性
}
```

**出参**

```jsonc
{
  "ok": true,
  "answers": {
    "<qid>": {
      "type": "noul" | "choice" | "score",
      "value": "string | number | null",   // 语义见 §2.3
      "confidence": "number | null",       // 上游未给则为 null，不臆造
      "distribution": { },                 // noul: {"yes":p,"no":1-p}；choice: 选项→概率；score: 按档位索引数组
      "legend": ["…"],                     // 仅 score
      "status": "ok" | "dropped"           // dropped = 上游未返回该题
    }
  },
  "decisionIds": { "<qid>": "dec_…" },
  "selfConsistency": {
    "requested": 3,                        // n
    "samples": 3,                          // 实际成功次数
    "agreement": 0.83,                     // 1 - H(p)/ln(K)，K=选项数；n=1 时为 null
    "modalVoteRatio": 1.0,                 // 众数选项占比
    "degraded": false                      // 有分片失败时为 true
  },
  "source": "decision-model" | "llm-fallback-judge",
  "usage": { "calls": 3, "inputTokens": 120, "outputTokens": 12, "latencyMs": 830 },
  "fallback": {                              // 可选，7/11 兜底 meta（见 §10.3）
    "triggered": true,
    "trigger": "model-not-configured" | "model-verify-failed" | "model-call-failed"
             | "model-timeout" | "model-invalid-response" | "low-confidence",
    "route": { "provider": "…", "model": "…", "origin": "explicit-config" | "session-model" },
    "originalSource": "decision-model",
    "originalConfidence": "number | null",
    "error": { "code": "…", "message": "…" }   // 仅兜底失败时出现
  }
}
```

**self-consistency（`n`）定稿**：

- `n ∈ [3,5]`，缺省 `1`；`n = 1` 时行为与单次判定**完全一致**，`agreement = null`。
- 实现：对同一 `(state, questions)` **独立发起 N 次** systemone 调用（上游无 seed 参数，独立性来自多次采样）。
- 聚合：choice → 各选项计票后归一化为聚合分布；noul → 平均 P(yes)；score → 平均期望分。
- `agreement = 1 - H(p) / ln(K)`（K = 选项数；K = 1 时取 `1.0`），衡量分布集中度；`modalVoteRatio` = 众数选项占比。
- 成本 ×N **全部**经统一调用层记账与预算闸；N 次中部分失败 → `degraded = true`，`samples` 为实际成功数，**失败分片不计入聚合、也不得当作 0 票**，且必须在账本留失败条目。

**3/11 实现口径补充（本卡定稿细节）**：

- **state 组装**：发给 systemone 的 `state` 固定为 `{ "message": <组装文本> }`；文本顺序 `PURPOSE → CONSTRAINTS → ACTIONS → DETAIL`，调用方 `state` 原文只落在 `DETAIL` 一处（不重复回灌，符合 §11 D1/D5）。
- **入参校验边界**：`instructions` 非空且 ≤2000 字符；`n` 仅接受 `1` 或 `3..5`（`2`、`6+` 一律 `invalid-arguments`）；`choice.criteria` 为 2–255 项「选项名→描述」非空映射；`score.criteria` 为 2–10 档非空文字数组。
- **候选集外取值**：模型返回的 `choice` 若不在该题候选集内 → 该题判 `dropped`（**fail-closed 不夹取**），整体 `ok:false` + `model-invalid-response`，`details` 含 `droppedQuestionIds` / `invalidAnswers` / `answers`（保留原始映射供审计）。
- **聚合平票规则**：choice 计票平票时取「单次 `confidence` 最高者」，仍平票按选项名字典序；`modalVoteRatio` = 众数票数 / 有效样本数。
- **`modalVoteRatio` 作用域（3/11 定稿）**：只有 `choice` 有投票语义；`noul` / `score` 用平均概率聚合，`modalVoteRatio` 一律 `null`。
- **`agreement` / `modalVoteRatio` 边界**：输出前 `clamp` 到 `[0,1]`（未归一分布可能让熵公式越界）；多题汇总只对**非 `null`** 的题取最小值，一题缺概率不抹掉全局值。
- **score 分布分母**：只用**真正提供了 `probabilities` 的样本数**求档位均值（缺失概率的样本不参与归一）；全部样本都无 `probabilities` → `distribution = null`。
- **usage 归属（3/11 定稿）**：`usage` 以**真实 HTTP 调用**为单位，与题数无关。多题一次调用只在第一条题级账本条目写真实 `usage`，其余题级条目 `calls=0`、token 为 `null`；`n>1` 时 `usage.calls = samples.length`（N 次调用），**绝不让多题把用量放大 Q 倍**。
- **`n = 1` 的出参**：**省略** `selfConsistency` 字段（与「行为与单次完全一致」一致）；`n > 1` 才返回该对象。
- **每次采样的账本**：N 次采样各自一条 `status=ok` 条目（`payload.selfConsistencySample` = 序号），另加 **一条** `payload.aggregated=true` 的汇总条目承载 `decisionIds[qid]`（统计时按 `aggregated` 标记去重，避免重复计数）。
- **兜底 meta（7/11 定稿）**：本次判定走兜底裁判时出参带 `fallback` 块（结构见 §10.3），`source` 同时变为 `llm-fallback-judge`；未触发兜底时该块**整体省略**（不写 `null` 占位）。

### 3.2 `decision_gate`

**入参**

```jsonc
{
  "action": "string",                     // required，待决动作描述，≤500 字符
  "context": "string | object",           // 可选，决策上下文
  "riskLevel": "low" | "medium" | "high",// 可选，默认 "medium"
  "policyId": "string"                    // 可选，外部策略标识（仅记录进账本）
}
```

**出参**

```jsonc
{
  "ok": true,
  "verdict": "allow" | "revise" | "block" | "escalate",
  "confidence": "number | null",
  "reasons": ["…"],                       // ≤5 条，每条 ≤120 字符
  "rationale": "…",                       // 可选，≤200 字符
  "decisionId": "dec_…",
  "source": "decision-model" | "llm-fallback-judge",
  "fallback": {                              // 可选，7/11 兜底 meta（见 §10.3）
    "triggered": true,
    "trigger": "model-invalid-response" | "low-confidence" | "…",
    "route": { "provider": "…", "model": "…", "origin": "explicit-config" | "session-model" },
    "originalSource": "decision-model",
    "originalConfidence": "number | null",
    "error": { "code": "…", "message": "…" }   // 仅兜底失败时出现
  }
}
```

**verdict 判定口径（定稿）**：内部以 `noul` 题组问「是否允许执行？」与「是否需要人工介入？」，映射规则：

| 条件                                                            | verdict    |
| --------------------------------------------------------------- | ---------- |
| 允许题 P(yes) ≥ 门控阈值（默认 0.8），且人工介入题 P(yes) < 0.5 | `allow`    |
| 允许题 P(yes) ≥ 阈值，但存在可修改项（模型给出 revise 提示）    | `revise`   |
| 允许题 P(yes) < 0.2                                             | `block`    |
| 人工介入题 P(yes) ≥ 0.5，或允许题 P(yes) 落在 `[0.2, 阈值)`     | `escalate` |

> 阈值可配（§6 `gateAllowThreshold`，默认 0.8）。**本工具不 fail-open**：拿不准一律 `escalate`，不返回 `allow`。

**3/11 实现口径补充（本卡定稿细节）**：

- **固定三题**：一次 systemone 调用同时问三道 `noul` 题，题 id 固定为 `gate.allow` / `gate.human` / `gate.revise`，`criteria` 用固定文案（满足放行条件 / 需要人工介入 / 需要先修改再执行），不随调用方变化。
- **判定优先级（自上而下命中即返回）**：`allow < 0.2` → `block`；`human ≥ 0.5` → `escalate`；`allow < 阈值` → `escalate`（灰区）；`revise ≥ 0.5` → `revise`；否则 `allow`。
- **confidence 口径**：取所选 verdict 对应的概率——`allow = P(allow)`、`block = 1 - P(allow)`、`revise = P(revise)`、`escalate = max(P(human), 1 - P(allow))`。
- **任一题缺失或题型非 `noul`** → 直接 `verdict = "escalate"`、`confidence = null`（不 fail-open，也不臆造概率）。
- **reasons / rationale**：由上述固定口径与概率文案派生（≤5 条、每条 ≤120 字符；rationale ≤200 字符），**不搬运模型散文**。
- **兜底 meta（7/11 定稿）**：本次判定走兜底裁判时出参带 `fallback` 块（结构见 §10.3），`source` 同时变为 `llm-fallback-judge`；未触发兜底时该块**整体省略**。缺题（`model-invalid-response`）与低置信（`low-confidence`）是 gate 的两条兜底触发路径。

### 3.3 `decision_rerank`

**入参**

```jsonc
{
  "candidates": [
    // required，2..10 项
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "fit": 0,
      "risk": 0,
    }, // fit/risk 可选（0..3 整数），提供则作为模型先验
  ],
  "goal": "string", // 可选，选型目标
  "weights": { "fit": 2, "risk": 1 }, // 可选，综合分权重
}
```

**出参**

```jsonc
{
  "ok": true,
  "ranked": [
    { "id": "…", "fit": 0, "risk": 0, "score": 0, "rationale": "…" }  // 按 score 降序
  ],
  "recommendation": "<id>",
  "invalid": [ { "id": "…", "reason": "fit 越界" } ],   // 模型返回值域非法者
  "decisionId": "dec_…",
  "source": "decision-model" | "llm-fallback-judge"
}
```

**综合分定稿**：`score = weights.fit × fit − weights.risk × risk`（默认 `2×fit − risk`；fit ∈ [0,3]、risk ∈ [0,3] → score ∈ [−3, 6]）。
**并列打破**：score 相同取 fit 大者；再同取输入顺序靠前者。
**非法值处理**：模型返回的 fit/risk 非 0..3 整数 → 该候选进 `invalid` 并**从排序中剔除**（不猜、不夹逼）；`recommendation` 取剩余最高分者；全部非法时 `recommendation = null` 且 `ok = true` + `invalid` 非空。

### 3.4 `decision_batch`

**入参**

```jsonc
{
  "groups": [                             // required，1..5 组
    {
      "questionId": "string",             // 可选，缺省按序号生成
      "question": { "type": "noul" | "choice" | "score", "instructions": "…", "criteria": { } },
      "texts": ["…"]                      // required，1..20 条
    }
  ]
}
```

**出参**

```jsonc
{
  "ok": true,
  "results": [
    {
      "groupIndex": 0,
      "questionId": "…",
      "rows": [
        { "index": 0, "text": "原文", "status": "ok", "answer": {} },
        {
          "index": 1,
          "text": "原文",
          "status": "error",
          "error": { "code": "model-timeout", "message": "…" },
        },
      ],
    },
  ],
  "concurrency": 5,
  "degraded": true, // 任一行失败即 true
}
```

**定稿口径**：

- **并发有界**：并发上限 **5**（worker pool），不随组数或行数线性放大。
- **失败行原样上报**：失败行保留**原始 text** 与**原始错误码/消息**，不推测、不填默认值、不改写文本；整批不因单行失败而失败（`ok` 仍为 true，行级 `status` 表达成败）。
- 结果数组与输入**等长且同序**（`index` 与输入下标一一对应）。
- 每行都是一次独立判定 → **每行都进账本**（§8）。
- **行级 `answer`/`error` 可空**（`oneOf: [object, null]`，2026-11-28 会话内活体验证补正）：成功行 `answer` 为对象、`error` 为 null；失败行反之。声明成纯 object 会把 null 判成宿主 invalid output（宿主按 schema 校验出参）。回归锚点：`src/tools/batch.test.ts`「出参过宿主 schema 校验」。

### 3.5 `decision_locate`

**入参**

```jsonc
{
  "image": { "format": "png" | "jpg" | "jpeg", "dataBase64": "string" },  // required
  "target": "string",                     // required，要找的目标描述，≤300 字符
  "questionId": "string"                  // 可选
}
```

**出参**

```jsonc
{
  "ok": true,
  "box": { "top": 0.2, "bottom": 0.66, "left": 0.19, "right": 0.68 }, // 归一化 0..1
  "center": { "x": 0.435, "y": 0.43 },
  "width": 0.49,
  "height": 0.46,
  "confidence": "number | null",
  "decisionId": "dec_…",
  "source": "decision-model",
}
```

**定稿口径**：

- 工具层原样透传上游四边（`top`/`bottom` 为高度分数、`left`/`right` 为宽度分数），另**派生** `center` / `width` / `height`（纯算术，不引入新语义）。
- 坐标一律归一化 0..1，不返回像素。
- 上游不支持（400 或该题被丢弃）→ `model-unsupported-capability`，**不返回任何坐标**。

### 3.6 `decision_usage`

**入参**

```jsonc
{
  "window": "1h" | "24h" | "7d" | "30d" | "all",   // 可选，默认 "24h"
  "tool": "decision_decide" | "…",                 // 可选，按工具过滤
  "budgetCheckOnly": false                          // 可选，只回预算状态
}
```

**出参**

```jsonc
{
  "ok": true,
  "window": "24h",
  "calls": 42,
  "inputTokens": 1200,
  "outputTokens": 340,
  "costUsd": 0.0012,
  "costEstimated": true,
  "latencyP50Ms": 720,
  "latencyP95Ms": 1540,
  "samples": 42,
  "burnRate": {
    "used": 0.42,
    "budget": 1,
    "ratio": 0.42,
    "projectedRatio": 0.71,
    "periodStart": "…",
    "periodEnd": "…",
  },
  "budget": { "enabled": true, "hardLimit": true, "exceeded": false },
}
```

**口径定稿**：

- 纯本地统计，**不发起任何模型调用**。
- `latencyP95Ms` 为窗口内成功调用延迟的 95 分位；**样本 < 20 时为 `null`** 并附 `samples` 供判断。
- `costUsd` 由 §8.3 公式估算；费率全为 0（默认，本地模型）时 `costUsd = 0`、`costEstimated = false`。
- **燃尽率**：`ratio` = 周期内已用配额 / 周期配额（>1 表示超支）；`projectedRatio` = 按当前速率线性外推到周期末的消耗比例；`used`/`budget` 以**当前生效的瓶颈维度**（calls/tokens/cost 中最先触顶者）表达，`budget` 维度在 `burnRate.dimension` 字段中标明。

**实现口径（5/11 落地，`decision_locate` 与 `decision_usage`）**：

- **locate 归一化与拒绝规则**：`dataBase64` 允许带 `data:<mime>;base64,` 前缀（平台原样剥除），剥除后校验无空白字符、符合 base64 字母表（`^[A-Za-z0-9+/=]+$`）；四边必须为有限数且落在 `0..1`，`bottom < top` 或 `right < left` 视为倒置 → `model-invalid-response`（`retryable:true`，`details.dropped=false`——`dropped` 仅表示「上游丢题」，倒置/越界属形状非法，与 §2.4 的 `status:'dropped'` 语义自洽），**绝不夹取/交换**；`center`/`width`/`height` 由四边纯算术派生（不引入像素）；
- **locate 上游能力缺失**：请求所选题未出现在 `answers`（上游静默丢弃）或上游以 400 明确拒绝 box/图像能力 → `model-unsupported-capability`（`retryable:false`），**不返回任何坐标**；
- **usage 分位数口径**：`latencyP50Ms` / `latencyP95Ms` 采用**最近邻秩**（nearest-rank，`index = ceil(p/100·n) - 1`，钳到 `[0, n-1]`）；`samples` = 窗口内 `status='ok'` 且 `latencyMs > 0` 的条目数；`samples < 20` 时 p95 为 `null`（p50 只要有样本即给值）；
- **usage 预算探测**：`budgetCheckOnly=true` 时只返回 `burnRate` 与 `budget`，用量指标（calls/tokens/cost/延迟/samples）一律 `null`（供调用方"先探预算再决定是否发起"）；
- **预算闸的真实语义**：日窗口按 UTC 自然日、以 `budgetResetHourUtc`（0–23）为日切；三维配额 `>0` 才生效，`≤0` 表示**不设限**（不是零配额）；超限时拒绝一切走调用层的工具并返回 `budget-exceeded`，同时只落**一条** `status='blocked'` 账本记录（`usage.calls=0`），不重复按题/按行写入；裁判调用（`source='llm-fallback-judge'`）走独立的 `fallbackMaxCallsPerDay` 配额——裁判不受主三维闸拦截（独立上限即其约束，见 §8.3/§10 的取舍），但其用量仍计入主预算统计；
- **账本持久化**：`<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`，启动时逐行载入（损坏行跳过并 warn），`append` 追加写、触达 `ledgerMaxEntries` 时整文件原子重写淘汰最旧，`updateOutcome` 回填后同步落盘；`ledgerEnabled=false` 时不落盘且预算闸退化为直通（该开关在插件 apply 时固化，true↔false 需重启生效）。

### 3.7 `decision_history`

**入参**

```jsonc
{
  "tool": "decision_decide" | "…",   // 可选
  "from": "ISO-8601",                // 可选
  "to": "ISO-8601",                  // 可选
  "minConfidence": 0.0,              // 可选，0..1
  "limit": 50                        // 可选，1..200，默认 50
}
```

**出参**

```jsonc
{
  "ok": true,
  "entries": [
    {
      "decisionId": "dec_…",
      "ts": "…",
      "tool": "decision_decide",
      "questionId": "q1",
      "questionSummary": "…", // ≤120 字符
      "value": "…",
      "confidence": 0.87,
      "source": "decision-model",
      "mode": "primary",
    },
  ],
  "total": 128,
  "truncated": true,
  "nextOffset": 50,
}
```

**定稿口径**：纯本地、**不发起模型调用**；按 `ts` **倒序**；`total` 是过滤后总条数，`entries` 受 `limit` 限制，`truncated` 标明是否被截断；**查无结果返回 `entries: []`，不是错误**。

### 3.8 `decision_recheck`

**入参**

```jsonc
{
  "decisionId": "dec_…", // required
  "state": "string | object", // 可选，复检用的新状态；缺省由原条目的题型 + 摘要重建状态（不回灌原文，见 §5.1）
}
```

**出参**

```jsonc
{
  "ok": true,
  "decisionId": "dec_…",
  "old": {
    "value": "…",
    "confidence": 0.87,
    "ts": "…",
    "questionType": "choice",
    "questionSummary": "…",
  },
  "new": { "value": "…", "confidence": 0.61, "ts": "…" },
  "drift": { "changed": true, "kind": "value", "magnitude": 1 },
}
```

**漂移口径定稿**：

| 题型     | 判定为「值变化」的阈值 | magnitude |
| -------- | ---------------------- | --------- |
| `noul`   | \|ΔP(yes)\| > 0.10     | ΔP        |
| `choice` | 选项名不同即算变化     | 1         |
| `score`  | \|Δscore\| > 0.10      | Δscore    |

- `kind`：`none` / `value` / `confidence` / `both`；优先级 **value > confidence**。
- `confidence` 变化阈值：\|Δconfidence\| > 0.05。
- `decisionId` 不存在或已被账本滚动淘汰 → `decision-not-found`（**不猜、不用近似 id 匹配**）。
- 复检本身是一次新判定 → **进账本**（`tool = decision_recheck`，并与原条目建立 `recheckOf` 关联）。

**实现口径（8/11 落地，decision_history 与 decision_recheck）**：

- **history 只列成功判定**——账本里 `status='error'` / `status='blocked'` 的条目不是判定，不进 `entries`；`total` 是过滤后（工具 / 时间窗 / 最低置信度）总条数，不受 `limit` 影响；`entries` 按 `ts` 倒序（最新在前）；`truncated` 标明是否被 `limit` 截断，`nextOffset` 给出下一页起始偏移（未截断为 `null`）；**查无结果返回 `entries: []` 且 `ok=true`，不是错误**。
- **history 输出不回灌原文**——每条只含 `decisionId` / `ts` / `tool` / `questionId` / `questionSummary` / `value` / `confidence` / `source` / `mode`；`questionSummary` 取账本里已截断（≤120 字符）的摘要，**不含 state 原文、上下文与图像数据**（契约 §5.1）。
- **history 纯本地**——不发起任何模型调用，模型未配置 / 未验证时同样可用（契约 §1.3）。
- **recheck 题目按账本重建**——账本按 §5.1 不保存 state 原文与题目全文，所以复检题目只能由条目已有信息重建：`noul` → 二元 criteria（固定 true/false 文案）；`choice` → 候选集取 `payload.distribution` 的键（缺失时回退 `payload.value` 单候选）；`score` → 档位取 `payload.legend`（缺失时按 `distribution` 长度生成「档位 i」）；题型为 `box` 或不在漂移口径内 → `invalid-arguments`（「漂移口径只覆盖 noul/choice/score」）；`instructions` 由 `questionSummary` 派生。
- **recheck 状态缺省**——未传 `state` 时用原条目摘要重建状态（「复检原判定 <id>：<summary>」），**不是**原文回灌；传入的 `state` 只接受字符串或对象。
- **recheck 找不到就报错**——`decisionId` 不在账本（含已滚动淘汰）→ `decision-not-found`；原条目 `status ≠ 'ok'` → `decision-not-found`（不是「没有可复检的判定值」之外的任何猜测）；`decisionId` 格式不符 → `decision-id-invalid`。
- **recheck 上游丢题不拿旧值充数**——复检调用若该题被上游丢弃或返回形状非法 → `model-invalid-response`（`retryable=true`，`details.dropped` 标明是否上游丢题），**绝不沿用旧判定值**。
- **recheck 出参 decisionId 是新条目 id**——顶层 `decisionId` 为本次复检新生成的 id（原 id 在 `old` 侧与账本 `recheckOf` 里）；`drift.magnitude` 取值变化时的 Δ（choice 固定 1），只有置信度变化时取 |Δconfidence|，无变化为 0。

### 3.9 `decision_calibrate`

**入参**

```jsonc
{
  "window": "7d" | "30d" | "all",   // 可选，默认 "30d"
  "tool": "decision_decide" | "…"  // 可选
}
```

**出参**

```jsonc
{
  "ok": true,
  "sampleSize": 64,
  "insufficientSample": false,
  "brier": 0.081,
  "buckets": [
    { "range": "0.7–0.8", "n": 12, "hitRate": 0.75, "insufficient": false },
    { "range": "0.9–1.0", "n": 3, "hitRate": null, "insufficient": true },
  ],
  "overconfidence": { "meanGap": 0.12, "rate": 0.21, "significant": true },
  "excluded": { "notBackfilled": 41, "nonBinary": 7 },
}
```

**统计口径定稿（见 §9）**：纯本地、**不发起模型调用**。

### 3.10 `decision_arbiter`

**入参**（二者**至少给一个**）

```jsonc
{
  "decisionId": "dec_…",   // 或
  "question": { "type": "noul" | "choice", "instructions": "…", "criteria": { } }
}
```

**出参**

```jsonc
{
  "ok": true,
  "verdict": "allow" | "revise" | "block" | "escalate" | "yes" | "no" | "<选项名>",
  "confidence": 0.71,
  "disagreement": true,              // 与原判定是否不一致
  "detail": "…",                     // ≤200 字符
  "source": "llm-judge",
  "mode": "explicit-arbiter",
  "original": { "value": "…", "confidence": 0.54 }   // 仅当给了 decisionId
}
```

**定稿口径**：

- `verdict` 语义随题型：`noul` → `yes` / `no`；`choice` → 选项名；`gate` 类问题 → `allow`/`revise`/`block`/`escalate`。
- `disagreement` 口径：noul → \|P(yes)_judge − P(yes)_original\| > 0.10；choice → 选项不同即 true；score → \|Δ\| > 0.10；无原判定（只给 question）→ `disagreement = false`。
- 复用 §10 的裁判通道入口 `judgeOnce`，`mode = 'explicit-arbiter'`；**防递归**（裁判自身不再触发兜底）、**受预算闸约束**。

**实现口径（10/11 落地，`decision_calibrate` 与 `decision_arbiter`）**：

- **calibrate 只读账本、零模型调用**——不查模型配置、不验证、不出网，不产生成本；模型未配置也照常可用（只受 `toolsCalibrateEnabled` 开关约束）。
- **calibrate 的样本单位是「一条账本条目 = 一次判定（一个 qid）」**；`status ≠ 'ok'` 的条目（失败 / 被拦截）不是判定，不计入任何桶；`payload.aggregated = true` 的条目是 decide 自一致性的**汇总副本**（与分片条目重复），跳过以免重复计数。
- **calibrate 的真值映射**——`confirmed → o = 1`、`rejected → o = 0`；`revised → excluded.nonBinary`；`unknown → excluded.notBackfilled`；`choice` / `score` → `excluded.nonBinary`（§9 口径）。
- **calibrate 的 P(yes) 取 `payload.value`**——必须是 `[0,1]` 内的有限数；取不到（如上游未回传数值）计入 `excluded.notBackfilled`，不硬算。
- **calibrate 的分桶**——固定 10 桶、桶 i 覆盖 `[i/10, (i+1)/10)`、标签 `"0.7–0.8"`（`p = 1.0` 归入最后一桶）；桶内 `n < 5` → `insufficient = true` 且 `hitRate = null`；桶级统计**始终返回**。
- **calibrate 的样本不足**——`N < 20` → `insufficientSample = true`、`brier = null`、`overconfidence.meanGap = null`；`overconfidence.rate` 仍是样本比例（`N = 0` 时为 `null`），`significant` 在样本不足时恒为 `false`。
- **calibrate 的窗口**——`window` 闭集 `7d | 30d | all`，缺省 `30d`。
- **calibrate 的 tool 过滤**——`tool` 必须落在十工具闭集内（与 `history` 的 `tool` 过滤同一闭集），拼错直接 `invalid-arguments`，**不静默返回空统计**（否则「样本少」会被误读成「没有该工具的判定」）。
- **arbiter 的入参**——`decisionId` 与 `question` 至少给一个；`question.type ∈ noul | choice | gate`（`noul` 需 `instructions`，`choice` 需 `instructions` + `criteria`，`gate` 需 `action`）；`state` 可选（字符串或对象），缺省用题干/原摘要重建。
- **arbiter 的题目重建**——给了 `decisionId` 时按账本条目重建（noul 二元 criteria `true/false`、choice 候选集取 `distribution` 的键、缺失回退原判定值）；**`score` / `box` 不在仲裁口径内 → `invalid-arguments`**——§3.10 的 disagreement 口径里 score 一列属于历史口径保留，本工具**不受理 score 题**（避免「口径写了但永远走不到」的歧义）；原条目不是成功判定或已滚动淘汰 → `decision-not-found`；`decisionId` 格式不符 → `decision-id-invalid`。
- **arbiter 的 verdict 映射**——`noul`：`P(yes) ≥ 0.5` → `yes`，否则 `no`；`choice`：裁判给出的候选标签；`gate`：复用 gate 的三题口径（allow / human / revise）→ `allow` / `revise` / `block` / `escalate`，**放行阈值读同一处配置 `gateAllowThreshold`**（与 `decision_gate` 同源，避免同一动作在两个工具下得到不同 verdict）。
- **arbiter 的 confidence**——取裁判返回的 `confidence`；裁判未给或非法 → `null`（不猜）。
- **arbiter 的 disagreement**——`noul`：`|P(yes)_judge − P(yes)_original| > 0.10`；`choice`：选项不同；**无原判定 → `false`**；**该布尔值只表示两次判定不一致，不代表谁对**。
- **arbiter 的记账**——走 `judgeOnce` 内部记账（自带账本），条目 `tool = decision_arbiter`、`mode = 'explicit-arbiter'`、`source = 'llm-fallback-judge'`，与自动兜底的 `mode = 'auto-fallback'` 可区分（§10.1「兜底不改变账本分类」）。
- **两处 source 的取值对照**——**工具返回体**的 `source = 'llm-judge'`（本工具专用标注，表示「这条结论来自裁判」）；**账本条目**的 `source = 'llm-fallback-judge'`（裁判通道的统一分类，7/11 起所有裁判条目都用它）。两者同名不同值属刻意区分：返回体面向调用方，账本面向通道归类。
- **错误码备注**——`sample-insufficient` 与 `outcome-not-backfilled` 两个码在 10/11 实现中**以字段形式表达**（`insufficientSample` / `excluded.notBackfilled`），不作为错误码抛出（样本不足不是失败，是「算不出来」的显式标注）；两码保留在闭集内供未来其它工具使用。
- **arbiter 的模式闸**——`fallbackEnabled = false` → `fallback-disabled`；`fallbackMode` 不含 `explicit-arbiter`（即 `auto-fallback`）→ `fallback-disabled`；路由解析不到模型 → `arbiter-unavailable`；预算触顶 → `budget-exceeded`。
- **arbiter 的 detail**——≤200 字符的**结构化摘要**（例如「裁判重新判定 P(yes)=0.3，结论 no」），不转述裁判散文。

---

## 4. 错误码表

| code                           | 触发条件                                                                                                                                                                                                  | retryable |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `tool-disabled`                | 对应工具开关关闭（优先于模型检查）                                                                                                                                                                        | false     |
| `model-not-configured`         | `systemoneBaseUrl` / `systemoneApiKey` / `systemoneModel` 任一为空                                                                                                                                        | false     |
| `model-verify-failed`          | 验证请求非 2xx，或响应形状非法                                                                                                                                                                            | true      |
| `model-call-failed`            | 连接失败 / 非 2xx（401/404/429/5xx）/ 流中断                                                                                                                                                              | true      |
| `model-timeout`                | 超过 `systemoneTimeoutMs`                                                                                                                                                                                 | true      |
| `model-invalid-response`       | 2xx 但缺 `answers`、题型不匹配、值域非法、某题被丢弃                                                                                                                                                      | true      |
| `model-unsupported-capability` | 服务不支持 box/图像等能力                                                                                                                                                                                 | false     |
| `budget-exceeded`              | 触发本地硬预算（calls / tokens / cost 任一上限）                                                                                                                                                          | false     |
| `invalid-arguments`            | 参数不满足 schema（缺必填、越界、数量超限、格式非法）                                                                                                                                                     | false     |
| `decision-not-found`           | `decisionId` 不存在或已被账本滚动淘汰                                                                                                                                                                     | false     |
| `decision-id-invalid`          | `decisionId` 格式非法（须匹配 `^dec_[0-9A-HJKMNP-TV-Z]{26}$`）                                                                                                                                            | false     |
| `batch-item-failed`            | batch 中某组/某行失败（错误内联在行内，不使整批失败）。**预留码**：4/11 实现行级透传上游原始错误码（§3.4「失败行原样上报」），本码不在此路径出现，留给未来需要行级归一码的场景（8/11 history 过滤可依赖） | true      |
| `sample-insufficient`          | calibrate 样本量 < 阈值（20）                                                                                                                                                                             | false     |
| `outcome-not-backfilled`       | calibrate 无任何已回填 outcome 的条目                                                                                                                                                                     | false     |
| `arbiter-unavailable`          | 裁判通道不可用（既未配置裁判模型，也无会话当前模型可用）                                                                                                                                                  | true      |
| `fallback-disabled`            | 兜底触发条件命中但兜底未启用/模式不允许                                                                                                                                                                   | false     |

**规则**：错误码是**闭集**，实现不得新增未登记的码；新增码必须先改本文件并升版本。

---

## 5. 账本结构

### 5.1 条目结构

```jsonc
{
  "decisionId": "dec_01JQ8Z...",      // 见 §5.2
  "ts": "2026-11-27T07:20:31.123Z",   // ISO-8601 UTC
  "tool": "decision_decide",
  "mode": "primary" | "auto-fallback" | "explicit-arbiter" | "recheck",
  "source": "decision-model" | "llm-fallback-judge",
  "questionId": "q1",
  "questionType": "noul" | "choice" | "score" | "box",
  "questionSummary": "…",             // ≤120 字符（不含 state 全文）
  "status": "ok" | "error" | "blocked", // 账本级状态（2/11 定稿）：ok=有判定；
                                        // error=调用失败；blocked=预算拒绝。
                                        // 与 §2.4 工具出参的 answer.status（"ok"/"dropped"）不同层：
                                        // 上游丢题在账本里记 status=ok + errorCode=model-invalid-response。
  "payload": {                         // 判定 payload（**不含 state 原文**）
    "value": "…", "confidence": 0.87, "distribution": { }, "legend": [ ]
  },
  "outcome": {                         // 真值字段，见 §7
    "state": "unknown" | "confirmed" | "rejected" | "revised",
    "value": true, "source": "downstream", "updatedAt": "…"
  },
  "usage": { "inputTokens": 120, "outputTokens": 12, "calls": 1 },
  "latencyMs": 830,
  "costUsd": 0.0004,
  "costEstimated": true
}
```

**硬约束**：账本**不得**保存 `state` 原文、不得保存 apiKey、不得保存图像 base64。`payload` 只存判定结果与分布。

**usage 归属（3/11 定稿）**：一次真实 HTTP 调用只产生一份用量。多题调用按题各落一条账本条目，`usage` 只记在**第一条**题级条目上，其余条目 `calls=0`、token `null`；`decision_usage`（5/11）汇总时按条目 `usage` 直接求和即为真实值，不会按题数重复计数。

**裁判条目（7/11 定稿）**：兜底裁判产生的条目 `source='llm-fallback-judge'`、`mode='auto-fallback'`（显式仲裁为 `explicit-arbiter`），`payload` 仍是判定结果与分布（同样不含 state 原文）；裁判失败时另落一条 `status='error'` 的裁判条目（`payload.errorCode` 记裁判侧错误码）使兜底失败可追溯。裁判条目的 `usage` 同样只记在第一条题级条目上（`calls=1`）。

### 5.2 `decisionId` 约定

- 格式：`dec_` + 26 位 Crockford Base32（ULID 同构，时间前缀有序、随机后缀唯一）。
- 正则：`^dec_[0-9A-HJKMNP-TV-Z]{26}$`（不含 I、L、O、U）。
- **每次判定分配一个稳定 id**；`recheck` 新条目是**新 id**，但用 `recheckOf` 字段指向原条目；`selfConsistency` 的 N 次调用**各自独立 id**（并在 `payload.selfConsistencySample` 标记第几次），聚合结果另出一条汇总条目（`mode = "primary"`、`payload.aggregated = true`）。
- `history` / `recheck` 按此 id 解析；解析失败即 `decision-not-found` / `decision-id-invalid`。

### 5.3 成本换算表（**估算口径**）

```
costUsd = (inputTokens  / 1000) × costInputPer1kTokens
        + (outputTokens / 1000) × costOutputPer1kTokens
```

| 费率字段                | 默认 | 口径说明                                                                            |
| ----------------------- | ---- | ----------------------------------------------------------------------------------- |
| `costInputPer1kTokens`  | `0`  | **默认 0**：本地/自建决策模型不计费。填 0 时 `costUsd = 0`、`costEstimated = false` |
| `costOutputPer1kTokens` | `0`  | 同上                                                                                |

- 费率非 0 时，所有成本数字标注 `costEstimated = true`，**属估算，不是账单**。
- 上游 `usage` 缺失 → token 记 `null`，成本记 `null`（不是 0），`costEstimated = false`（无数据可估）。

### 5.4 落位与滚动淘汰

| 项              | 定稿                                                                                   |
| --------------- | -------------------------------------------------------------------------------------- |
| 路径            | `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`（JSONL，一行一条）                      |
| `DSH_HOME` 解析 | 环境变量 `DSH_HOME` → 回退 `~/.dsh`（5/11 实现时确认写权限与目录创建策略）             |
| 滚动淘汰        | 保留最新 `ledgerMaxEntries` 条（默认 1000），最旧的先淘汰                              |
| 淘汰后果        | 被淘汰条目的 `decisionId` → `decision-not-found`（这是**已知限制**，UI/README 需说明） |

---

## 6. 配置字段表

> 全部字段包 `volatileField()` + `setDescription(desc(en, zh))`；入口必须 `re-export Config`（否则宿主设置面板整块丢弃）。持久化位标「是」，运行时派生位标「否（只读/派生）」。

### 6.1 模型接口（4 项）

| 字段                 | 类型   | 默认    | 校验                             | volatile | 说明                                                 |
| -------------------- | ------ | ------- | -------------------------------- | -------- | ---------------------------------------------------- |
| `systemoneBaseUrl`   | string | `''`    | 非空时须为 http(s) URL，去尾斜杠 | 是       | 端点 = `{baseUrl}/v1/systemone`                      |
| `systemoneApiKey`    | string | `''`    | —                                | 是       | 密文由宿主配置层负责；插件不打印、不入日志、不入账本 |
| `systemoneModel`     | string | `''`    | —                                | 是       | 决策模型名（非宿主会话模型）                         |
| `systemoneTimeoutMs` | number | `30000` | 1000–300000，步进 1000           | 是       | 单次调用超时                                         |

### 6.2 验证状态（2 项，派生 + 最近状态）

| 字段                   | 类型   | 默认 | volatile | 说明                                                                   |
| ---------------------- | ------ | ---- | -------- | ---------------------------------------------------------------------- |
| `systemoneVerifiedAt`  | string | `''` | 是       | 最近一次验证成功时间（ISO）；`baseUrl`/`apiKey`/`model` 任一变更即作废 |
| `systemoneVerifyError` | string | `''` | 是       | 最近一次验证失败原因（**不含 key**）                                   |

**验证动作**：发一次**最小决策探测请求**（1 条 `noul` 题，不含用户业务数据）。成功 → 写 `systemoneVerifiedAt`、清空 `systemoneVerifyError`；失败 → 写错误码与建议动作。

### 6.3 工具开关（10 项，全部 boolean，默认 `false`）

`toolsDecideEnabled`、`toolsGateEnabled`、`toolsRerankEnabled`、`toolsBatchEnabled`、`toolsLocateEnabled`、`toolsUsageEnabled`、`toolsHistoryEnabled`、`toolsRecheckEnabled`、`toolsCalibrateEnabled`、`toolsArbiterEnabled`

> 纯本地三工具（usage / history / calibrate）的开关**同样生效**（关闭即 `tool-disabled`），但它们**不受模型未配置影响**。

### 6.4 预算与成本（6 项）

| 字段                                             | 类型    | 默认     | 校验                               | 说明                       |
| ------------------------------------------------ | ------- | -------- | ---------------------------------- | -------------------------- |
| `budgetEnabled`                                  | boolean | `false`  | —                                  | 硬预算总开关               |
| `budgetMaxCallsPerDay`                           | number  | `200`    | 0–100000，步进 10（0 = 不限）      | 日调用上限                 |
| `budgetMaxTokensPerDay`                          | number  | `200000` | 0–100000000，步进 1000（0 = 不限） | 日 token 上限（输入+输出） |
| `budgetMaxCostUsdPerDay`                         | number  | `0`      | 0–10000，步进 0.01（0 = 不限）     | 日成本上限（估算口径）     |
| `budgetResetHourUtc`                             | number  | `0`      | 0–23，步进 1                       | 周期重置时刻（UTC 小时）   |
| `costInputPer1kTokens` / `costOutputPer1kTokens` | number  | `0`      | 0–100，步进 0.001                  | 费率（估算，见 §5.3）      |

**预算闸触发**：任一维度达到上限 → 后续调用返回 `budget-exceeded`（**不静默截断、不降级到兜底**；兜底同样受限，见 §10）。

### 6.5 兜底级联（7 项）

| 字段                     | 类型    | 默认              | 校验                                                 | 说明                               |
| ------------------------ | ------- | ----------------- | ---------------------------------------------------- | ---------------------------------- |
| `fallbackEnabled`        | boolean | `false`           | —                                                    | 兜底总开关                         |
| `fallbackProvider`       | string  | `''`              | —                                                    | 裁判 provider；空 = 用会话当前模型 |
| `fallbackModel`          | string  | `''`              | —                                                    | 裁判模型；空 = 用会话当前模型      |
| `fallbackMinConfidence`  | number  | `0.7`             | 0.05–1，步进 0.05                                    | 置信度门控阈值（低于即「拿不准」） |
| `fallbackMode`           | string  | `'auto-fallback'` | enum `auto-fallback` \| `explicit-arbiter` \| `both` | 生效模式                           |
| `fallbackTimeoutMs`      | number  | `60000`           | 1000–300000，步进 1000                               | 裁判超时                           |
| `fallbackMaxCallsPerDay` | number  | `50`              | 0–10000，步进 10                                     | 裁判日调用上限，防滥用             |

### 6.6 账本（2 项）

| 字段               | 类型    | 默认   | 校验                 | 说明                                               |
| ------------------ | ------- | ------ | -------------------- | -------------------------------------------------- |
| `ledgerEnabled`    | boolean | `true` | —                    | 账本写入开关（关则不记、history/calibrate 无数据） |
| `ledgerMaxEntries` | number  | `1000` | 100–100000，步进 100 | 滚动淘汰上限                                       |

### 6.7 gate 阈值（1 项）

| 字段                 | 类型   | 默认  | 校验              | 说明                                |
| -------------------- | ------ | ----- | ----------------- | ----------------------------------- |
| `gateAllowThreshold` | number | `0.8` | 0.05–1，步进 0.05 | gate 允许判定阈值（见 §3.2 映射表） |

---

## 7. `outcome` 真值字段与回填通道（定稿）

### 7.1 字段

```jsonc
"outcome": {
  "state": "unknown" | "confirmed" | "rejected" | "revised",
  "value": true | false | "…",       // 可选：确认后的真值
  "source": "downstream" | "user",   // 可选
  "updatedAt": "ISO-8601"            // 可选
}
```

- `state = "unknown"` = 未回填（默认）。`confirmed` = 判定正确。`rejected` = 判定错误。`revised` = 有修正值（`value` 生效）。
- **只有 `confirmed` / `rejected` / `revised` 参与 calibrate 统计**。

### 7.2 回填通道（定稿）

**主通道 = 下游回报**：账本模块暴露内部写接口

```ts
declare function writeOutcome(
  decisionId: string,
  outcome: {
    state: 'confirmed' | 'rejected' | 'revised';
    value?: boolean | string | number;
    source: 'downstream' | 'user';
  },
): Promise<{ ok: boolean; error?: { code: string; message: string } }>;
```

- 由 **5/11** 落地该写接口（账本模块内），**10/11** 的 calibrate 消费。
- **设置页不提供人工标注 UI**（6/11 只做配置页）→ 用户标注通道列为**预留**，不在本系列实现。
- 回填接口的对外暴露方式（工具 / 内部模块）由 5/11 决定；契约只固定**字段形状与语义**。
- `decisionId` 不存在 → `decision-not-found`。
- **5/11 落地结论**：以**内部模块接口**形式落在 `services/decision-tools.ts` 的运行时对象上——`runtime.writeOutcome(decisionId, { state, value?, source? }): boolean`，内部调用 `ledger.updateOutcome(...)` 并**同步落盘**；返回 `false` 表示 `decisionId` 不存在（含滚动淘汰），由调用方映射为 `decision-not-found`。不新增对外工具（保持十工具闭集）。

---

## 8. 统一调用层（2/11 实现）

### 8.1 层次

```
tools/*.ts  →  runtime/call.ts (统一调用层)  →  systemone/client.ts (HTTP)
                    │                                  │
                    ├─ 记账（写入账本）                 └─ POST {baseUrl}/v1/systemone
                    ├─ 预算闸（先于出网检查）
                    ├─ 兜底挂点（§10）
                    └─ 错误码映射（§4）
```

### 8.2 记账规则

- 每次**实际发起**的模型调用写一条账本条目（含失败条目，`payload.value = null` + `error.code` 记在 `payload.errorCode`）。
- `selfConsistency` 的 N 次调用 → N 条独立条目 + 1 条汇总条目。
- `batch` 的每行 → 每行一条条目（`questionId` 形如 `{组questionId}#{行号}`）。
- `recheck` → 新条目 + `recheckOf` 关联。
- 兜底裁判调用 → 独立条目，`source = "llm-fallback-judge"`、`mode = "auto-fallback" | "explicit-arbiter"`。

### 8.3 预算闸

- 顺序：**先查预算 → 再出网**。超限 → `budget-exceeded`，**不发起调用**、不落调用条目（只落一条 `status=blocked` 的拒绝记录）。
- 统计维度：calls / tokens / cost 三者取**最先触顶**者；`burnRate.dimension` 标明是哪一个。
- **兜底裁判调用同样计入同一预算**（`fallbackMaxCallsPerDay` 为其独立上限）。

---

## 9. `calibrate` 统计口径（定稿）

| 项           | 定稿                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 参与题型     | **仅 `noul`**。`choice` / `score` 的真值需人工标注单一正确答案 / 目标档位，而 outcome 回填通道（§7.2）不支持该语义 → **定稿：choice / score 暂不参与校准**，计入 `excluded.nonBinary` |
| 样本单位     | 一条账本条目 = 一次判定（一个 qid）                                                                                                                                                   |
| 真值         | `confirmed` → `o = 1`；`rejected` → `o = 0`；`revised` → 不参与（计 `excluded.nonBinary`）；`unknown` → 不参与（计 `excluded.notBackfilled`）                                         |
| Brier 分数   | `BS = (1/N) Σ (p_i − o_i)²`，`p_i` = 该 noul 判定的 P(yes)，`o_i ∈ {0,1}`；范围 [0,1]，越小越好                                                                                       |
| 分桶边界     | 固定 **10 桶**，桶 i 覆盖 `[i/10, (i+1)/10)`，标签 `"0.7–0.8"`；每桶记 `n` 与 `hitRate`（桶内 `o` 的均值）；桶内 `n < 5` → `insufficient = true` 且 `hitRate = null`                  |
| 样本不足阈值 | `N < 20` → `insufficientSample = true`、`brier = null`、`overconfidence.meanGap = null`（**不硬算**）；桶级仍返回并各自带 `insufficient` 标记                                         |
| 过自信指标   | `meanGap = (1/N) Σ (p_i − o_i)`（**正 = 高估**）；`rate` = 样本中 `(p_i − o_i) > 0.1` 的比例；`significant = (N ≥ 20) && (meanGap ≥ 0.1)`                                             |
| 窗口         | 默认 `30d`；`tool` 过滤同 `history`                                                                                                                                                   |
| 纯本地       | 不发起模型调用                                                                                                                                                                        |

---

## 10. 兜底级联（定稿）

### 10.1 三条触发路径

| #   | 触发                      | 条件                                                                                                   | 行为                                                                                                                                                                                                        |
| --- | ------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **未配置/未验证决策模型** | `model-not-configured` / `model-verify-failed`                                                         | 若 `fallbackEnabled` 且 `fallbackMode` 允许 → 走裁判；否则原样返回原错误码（7/11 起实现把 `model-verify-failed` 并入 T1 触发面——验证状态属「决策模型不可用」而非调用失败，卡实施要点「验证未通过→走兜底」） |
| T2  | **决策模型调用失败/报错** | `model-call-failed` / `model-timeout` / `model-invalid-response`                                       | 同上                                                                                                                                                                                                        |
| T3  | **低置信拿不准**          | 判定成功但 `confidence < fallbackMinConfidence`；或 `decide` 的 `selfConsistency.agreement` 低于同阈值 | 同上（`decide` 的 `agreement` 为 `null` 时只看 `confidence`）                                                                                                                                               |

**边界（定稿）**：

- `auto-fallback`：**只**对 `decision_decide` / `decision_gate` 生效（门控触发）。
- `explicit-arbiter`：**只**由 `decision_arbiter` 显式调用（agent 请求）。
- `both` = 两者都开。
- **兜底不可递归**：裁判调用自身**不再触发**兜底；裁判失败 → 直接返回错误码（`arbiter-unavailable` 或原始调用错误），**不无限回退**。
- **兜底受预算闸约束**：裁判调用计入同一预算；超限 → `budget-exceeded`。
- **兜底不改变账本分类**：兜底产生的判定 `source = "llm-fallback-judge"`，`mode` 区分 `auto-fallback` / `explicit-arbiter`；`decision-model` 与 `llm-fallback-judge` 在轨迹中必须可区分。

### 10.2 裁判通道接口（7/11 实现，10/11 复用）

```ts
type JudgeMode = 'auto-fallback' | 'explicit-arbiter';

interface JudgeRequest {
  mode: JudgeMode;
  state: unknown;
  questions: Record<
    string,
    {
      type: 'noul' | 'choice' | 'score';
      instructions: string;
      criteria?: unknown;
    }
  >;
  timeoutMs: number;
}

interface JudgeResult {
  answers: Record<
    string,
    {
      type: string;
      value: string | number | null;
      confidence: number | null;
      distribution?: unknown;
      legend?: string[];
    }
  >;
  source: 'llm-fallback-judge';
  mode: JudgeMode;
  usage: {
    calls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  };
}

declare function judgeOnce(req: JudgeRequest): Promise<JudgeResult>;
```

- **裁判模型来源**：优先 `fallbackProvider` + `fallbackModel`（非空时）；否则用**会话当前模型**（宿主 `ctx.llm` 路由）。两者都不可用 → `arbiter-unavailable`（**不静默失败**）。
- `judgeOnce` 内部：防递归 + 预算闸 + 记账三件事在此封装层生效。

### 10.3 兜底 meta 与工具出参（7/11 实现定稿）

**meta 块结构**（`decision_decide` / `decision_gate` 出参的可选 `fallback` 字段）：

```jsonc
{
  "triggered": true,                       // true = 本次结论来自裁判
  "trigger": "model-not-configured" | "model-verify-failed" | "model-call-failed"
           | "model-timeout" | "model-invalid-response" | "low-confidence",
  "route": {                               // 裁判路由
    "provider": "string",
    "model": "string",
    "origin": "explicit-config" | "session-model"
  },
  "originalSource": "decision-model",      // 首判来源
  "originalConfidence": "number | null",   // 首判置信度（低置信路径才有值）
  "error": { "code": "…", "message": "…" } // 仅「兜底失败但维持首判」时出现
}
```

**7/11 定稿口径**：

- **谁产生 meta**：T1/T2 由统一调用层内部兜底时，meta 挂在这次调用结果上，工具层透传；T3（低置信）与「调用成功但结果不可用」由工具层调用兜底挂点，meta 由工具层直接写进出参。
- **触发即标注**：只要走兜底，`source` 一律变成 `llm-fallback-judge`；meta 的 `triggered` 恒为 `true`，`trigger` 指明触发路径。
- **兜底失败不掩盖原错误码**：兜底自身失败时**保留首判原错误码**（`model-not-configured` / `model-verify-failed` / `model-call-failed` / `model-timeout` / `model-invalid-response`），裁判失败原因并入 `error.details.judgeError`（结构 `{ code, message }`）。
- **兜底失败不产无来源结论**：首判已成功时（低置信路径），兜底失败**维持首判结论与 `source=decision-model`**，只把失败写进 `fallback.triggered=false` + `fallback.error`；绝不换成无来源的结论。
- **未触发兜底时**出参**整体省略** `fallback` 字段（不写 `null` 占位）。
- **账本**：裁判条目 `source='llm-fallback-judge'`、`mode='auto-fallback'`（显式仲裁为 `explicit-arbiter`）；兜底失败额外落一条 `status='error'` 的裁判条目，使「兜底失败」在账本里可追溯（避免双记：成功路径由统一调用层记账，失败路径由兜底挂点记账）。
- **防递归**：裁判只调宿主 `ctx.llm`，**不经过**统一调用层的 `runDecisionCall`，因此裁判自身不再触发兜底。
- **预算**：裁判调用走预算闸的独立配额 `fallbackMaxCallsPerDay`（只统计 `source='llm-fallback-judge'` 的条目），不与主三维闸（calls/tokens/cost）混算；超限 → `budget-exceeded`（原错误码保留）。注意：主三维闸的窗口求和**包含**裁判条目（裁判调用的成本真实存在），独立的 `fallbackMaxCallsPerDay` 是在其之上的裁判专用上限；`budgetEnabled=false` 时整体直通，裁判配额随之不设限。
- **不再二判（7/11 补充）**：首判本身已是裁判产出（T1/T2 接管）时，工具层**跳过** T3 低置信判定——裁判产出不回灌兜底，避免配额双烧与自相矛盾 meta（`triggered` 恒为 `true`）。

---

## 11. Tool 设计纪律（3.7 原文，定稿为实现约束）

| #   | 纪律                                 | 落地要求                                                                                                                 |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| D1  | **最小上下文优先**                   | 工具 description 按 `purpose / actions / constraints` 组织，细节（题型细则、错误码全集、历史口径）后置或外链到本契约     |
| D2  | **关键约束写在动作前**               | description 开头就是「做什么 + 不能做什么」（如「未配置模型直接报错，不静默降级」），不是先讲参数                        |
| D3  | **输出有界**                         | 返回 `id` / 概率 / 分值 / 坐标框；**绝不回灌转储**（不回灌 state 原文、账本全量、模型散文、图像数据）                    |
| D4  | **参数规则写在参数上**               | 数量上下界、枚举、长度上限写进 JSON Schema 的 `description`，不靠文档正文约束                                            |
| D5  | **每条事实只说一次**                 | 同一约束不在 description、参数说明、错误文案里重复三遍；重复处以本契约为准                                               |
| D6  | **改完量一下首回合 prompt token 差** | 每个实现卡改动工具 description 后，量首回合 prompt token 差值并**记进该卡评论**（对比基线：改前的 description token 数） |

---

## 12. 已知边界与待办

| #   | 事项                                                                          | 状态                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | noul / score / box 在**本地服务**上的真实响应形状                             | **9/11 实测完成**：noul 无 confidence/probabilities；score 的 legend/probabilities 为档位索引对象映射（插件已归一为数组）；box 不被模型支持                      |
| B2  | 本地服务是否支持 box 与图像、是否需 `TypeSafe-Danger-Zone-Images` 头          | **9/11 实测完成**：local-decision-model 拒绝 box 题型（HTTP 400 `must be one of: choice, score, noul`）→ `model-unsupported-capability`；换支持 box 的模型即可用 |
| B3  | choice / score 题**不参与**校准                                               | 定稿（§9），outcome 回填通道不支持多值真值                                                                                                                       |
| B4  | 设置页**不提供** outcome 人工标注 UI                                          | 定稿（§7.2），用户标注通道预留                                                                                                                                   |
| B5  | 账本滚动淘汰会使旧 `decisionId` 失效                                          | 已知限制，README 与 UI 需说明                                                                                                                                    |
| B6  | 成本数字是**估算**，非账单                                                    | 已知限制，费率默认 0                                                                                                                                             |
| B7  | `systemone` 决策调用**不走**宿主 `dsh-llm-fallback` waterfall、不进会话上下文 | 沿用 ask-gate 的已知限制，本行同样适用                                                                                                                           |
| B8  | 本行与 `ask-gate` 判定方向相反（fail-closed vs fail-open）                    | 定稿（§0），实现时禁止复用 core 降级逻辑                                                                                                                         |
