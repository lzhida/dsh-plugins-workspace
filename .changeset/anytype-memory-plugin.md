---
'@lzhida/dsh-anytype-core': minor
'@lzhida/dsh-anytype-memory': minor
'@lzhida/dsh-anytype': minor
---

新增 `dsh-anytype-memory` 插件（基于 Anytype 的纯本地持久记忆），并抽出共享底座 `dsh-anytype-core`。

**`@lzhida/dsh-anytype-core`（新）**：从 `dsh-anytype` 抽出的共享底座——Anytype v2 本地 API 客户端（HTTP 语义、错误归一、超时/取消、`ETag`/`Idempotency-Key`/`If-Match` 三件安全原语、结果截断）与工具层公共设施（`runRequest`/`outputSpec`/`enc`/参数常量），外加 volatile 配置支持（`volatileField`/`unwrapVolatile`/`desc`）。刻意**不依赖** `@deepseek-ai/dsh-tools`：工具层只用取消信号，用结构化的最小上下文视图绕开品牌类型身份冲突（pnpm 下多副本会直接报类型不可赋值）。

**`@lzhida/dsh-anytype-memory`（新）**：把指定的 Anytype space 当作 agent 的持久记忆工作环境。**零本地状态**——记忆正文、属性、关系与向量全部落为 Anytype 对象，检索全部走 Anytype 自身的 `search`+`filter`+`sorts`+`fields`（含原生 `links`/`backlinks` 双向关系），不写任何本地文件、不建本地索引、不跑模型、不出网。16 个工具分 5 组：`memory_setup`（幂等建空间/类型/属性，并把属性挂进类型字段表——否则按类型过滤会拒绝该键）、write 组 6 个（`memory_write`/`update`/`link`/`supersede`/`archive`/`review`）、read 组 5 个（`memory_recall`/`get`/`list`/`search`/`stats`）、agent 组 3 个（`memory_candidates`/`set_embedding`/`suggest_links`）、diag 组 1 个（`memory_doctor`，含中文召回自检：写一次性中文探针 → 全文搜索验证 → 归档探针）。记忆模型：单类型 `memory` + `kind` 属性（fact/decision/preference/lesson/procedure/episode/summary/entity）、`status` 审核态（AI 写入默认 draft）、5 条受控边 relation、双时序 `valid_from`/`valid_to`、provenance 五件套、`content_hash` 原生幂等（`filter` 等值查）、`confidence`/`importance`/`salience`/`proof_count`/`access_count`。召回三臂（Anytype 全文 / agent 提供向量的本地余弦 / 受控边反查）→ RRF(k=60) → 乘性旁证权重（recency^0.2 × confidence^0.2 × proof^0.1）→ token 预算截断。写入纪律：写前必读、`conflicts[]` 交 agent 裁决、永不覆盖已存正文与下调置信、失效不删（`origin=user` 的人类记忆拒绝被机器自动作废）。向量由外部 agent 计算、以 `embedding` 属性（base64 Float32）承载，不同模型的向量禁止混算，返回体不含向量原文。

**`@lzhida/dsh-anytype`（行为不变）**：改为依赖 `@lzhida/dsh-anytype-core`，`client.ts` 与 `tools/shared.ts` 迁入 core 并保持导出面不变，30 个工具行为零回归（lint/typecheck/test 全绿）。
