---
'@zhidal/dsh-anytype': minor
---

新增 dsh-anytype-wiki 插件行：AI 笔记知识库（AI 写、人看，非记忆系统）。六个 `wiki_*` 工具（5 项能力）：`wiki_setup` 幂等初始化笔记 space/类型/schema；`wiki_write` 按标题查重创建/更新笔记（默认 draft 态 + source 溯源，更新正文重置回 draft 待重审）；`wiki_review` 待审列表 + approve/reject/archive 裁决写回（If-Match 并发保护）；`wiki_get`/`wiki_list` 只读查看；`wiki_lint` 失效链接/孤立页巡检。不做召回/向量/Index/自动注入，agent 持久记忆仍由 hindsight/mnemon 承担； cordis.patch.yml 追加第二行（id `dsh-anytype-wiki`）。
