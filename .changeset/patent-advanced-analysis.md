---
'@zhidal/dsh-patent': minor
---

新增三个进阶分析工具，模型工具总数增至十一个：

- `claims_ab_diff`：A/B 权利要求差异对照，识别并入独权 / 从权重编号 / 引用基准迁移三类改动，并核对非权项部分是否逐字不变；
- `figure_manifest`：附图清单与一致性核对（清单 ↔ 文件命名 ↔ 图号引用 ↔ 就近指引 ↔ 附图标记 ↔ 图面文本 ↔ 说明书规则 ↔ 术语改名），图像编码按文件头字节判定；
- `case_index`：工作区交底书案件索引（七部分填充情况与 ready / draft / empty 状态，支持 sidecar 覆盖）。

新增纯函数模块 `claims-ab-diff.ts` / `figure-manifest.ts` / `case-index.ts` 与 34 例单测；判定口径落档于 `docs/patent-reference-notes.md`。
