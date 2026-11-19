---
'@zhidal/dsh-patent': minor
---

新增专利库检索结构化工具 `patent_search`：把任一 provider（EPO OPS / USPTO PatentsView / Google Patents / PATENTSCOPE / CNIPA 页面）的原文或 JSON 归一成结构化记录（公布号 / 名称 / 申请人 / 申请日 / 公开日 / 优先权日 / IPC-CPC / 摘要 / 权利要求首项），并计算每条对比文件的日期档位（prior-art 可作有效对比文件 / needs-review 需另判 / later 不可作对比文件 / unknown），档位结果带出判定所需三段输入与判定依据。插件不内置专利库凭据（CNIPA 无公开 API，OPS 与 PatentsView 须用户自带 key），拿不到原文时输出检索指引与期望字段清单；另提供可选的零凭据 Google Patents XHR 兜底（非官方端点，失败只降级为诊断）。对与检索词无字面交集、或缺名称与分类的记录标提示交人工/模型复核——字面命中也可能语义无关，仍须复核。日期档位为纯日期比较的机械判定，不构成法律判断。
