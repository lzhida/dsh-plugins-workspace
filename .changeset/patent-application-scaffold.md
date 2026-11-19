---
'@zhidal/dsh-patent': minor
---

新增申请文件「五书」生成面：`application_scaffold` 工具（扉页含摘要与摘要附图 / 权利要求书 / 说明书 / 附图），权利要求书沿用 `patent_claims_check` 的同一套校验，说明书施加 `[0001]` 跨小节连续段号，摘要附 230-320 字区间检查，页码按「页眉部分内页码 + 页脚全文连续页码」双轨排布；配套新增第三份方法论 skill `patent-application` 与第四段 prompt section `dsh-patent:application`，并在 README 与 `docs/patent-reference-notes.md` 落定「交底书七部分 → 申请文件五书」的形态差异。工具不臆造权利要求与说明书正文，缺来源处留〔待补〕占位并记诊断。
