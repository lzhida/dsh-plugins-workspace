---
'@zhidal/dsh-decision': minor
---

新增**决策工具插件行** `decision-tools`（`@zhidal/dsh-decision` 私有包，组合包的第二个成员）：把决策模型以 **agent 可主动调用的 tool 类工具**暴露出来——十工具闭集 `decision_decide` / `decision_gate` / `decision_rerank` / `decision_batch` / `decision_locate` / `decision_usage` / `decision_history` / `decision_recheck` / `decision_calibrate` / `decision_arbiter`，方向与同包的 `ask-gate` 相反：**fail-closed**（不猜、不放行），调用失败一律返回结构化错误信封 `{ok:false,error{code,message,retryable,details}}`（16 条错误码闭集）。

**十工具**：typed 判定（noul / choice / score，返回概率分布而非散文，支持 self-consistency n=3..5 与 agreement 集中度）；危险动作前的闸门（allow / revise / block / escalate，拿不准一律 escalate，不 fail-open）；2–10 候选按 fit 0–3 + risk 综合分排序（非法值进 `invalid` 不夹取）；1–5 组问题 × 1–20 条文本批量判定（并发有界、失败行原样上报不猜）；图像内找目标返回归一化坐标框；账本查询（calls / tokens / 成本 / 延迟 p50·p95 / 燃尽率）；决策历史查询（纯本地、按 ts 倒序、有界）；按 `decisionId` 复检漂移（old / new / drift）；校准审计（Brier 分 + 10 桶分桶命中率 + 过自信指标，样本不足显式标注不硬算）；显式大模型裁判（verdict / disagreement / `source=llm-judge`）。

**统一调用层与账本**：所有发模型调用的工具走同一入口——先查开关、再查模型就绪、再查预算闸（超限 `budget-exceeded` 且不发起调用），然后才出网；每次调用落账（`decisionId` / payload / outcome / usage / 延迟 / 成本），账本落 `<DSH_HOME>/plugins/dsh-decision/ledger.jsonl`（滚动淘汰，被淘汰条目的 `decisionId` 查询返回 `decision-not-found`，不猜）。`decision_usage` / `decision_history` / `decision_calibrate` 三个纯本地工具不调模型，模型未配置时仍可用。

**大模型兜底级联**：轻量决策模型**没配置、调用失败或置信度低于门限**时，由大模型裁判出场做一次慢思考复核——自动兜底只对 `decision_decide` / `decision_gate` 生效，显式仲裁由 `decision_arbiter` 触发，二者共用同一裁判通道、**互不递归**；裁判路由优先用设置页显式指定的 provider/model，否则用会话当前模型，都取不到则返回 `arbiter-unavailable`（不猜模型）；账本用 `mode`（`auto-fallback` / `explicit-arbiter`）区分两类级联。

**设置页**：react + shadcn 自渲染配置卡（注册进宿主插件详情页），含决策接口配置与**同源验证路由**（`POST /dsh-decision/verify`，带 content-type / Origin / 请求体大小等栅栏、不回显 apiKey）、十个工具开关（默认全关，关闭即 `tool-disabled`）、预算与兜底参数区；样式只走宿主 `--dsw-alias-*` token（无硬编码色值、无 `.dark` 类，深浅两态由宿主主题驱动）。client 半区需显式构建（`pnpm --filter @zhidal/dsh-decision build`）——`link:` 安装不触发 `prepare`。

**边界**：决策调用为纯旁路 HTTP，**不受 `dsh-llm-fallback` 保护**；成本是本地估算口径（费率默认 0 时成本记 0 且不标估算）；账本是插件本地数据、与宿主会话轨迹不混用；apiKey 明文存放于 profile 补丁层（不写日志/账本/错误信息）；`decision_locate` 依赖决策模型的图像能力（当前实测模型不支持 box 题型 → `model-unsupported-capability`）；`decision_recheck` 依赖账本条目未被滚动淘汰；`decision_calibrate` 依赖 outcome 已回填且结论为估算性质；`decision_arbiter` 的 `disagreement` 只表示两次判定不一致、**不代表谁对**。完整契约见包内 `docs/decision-tools-contract.md`，视觉方案见 `docs/decision-tools-design.md`。本包为私有包，不发布 npm。
