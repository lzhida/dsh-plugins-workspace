# @lzhida/dsh-anytype-memory

把 **指定的 Anytype space** 当作 agent 的**持久记忆工作环境**：记忆正文、
属性、关系与向量全部落为 Anytype 对象；检索能力全部来自 Anytype 自身
（`search` + `filter` + `sorts` + `fields`，含原生 `links`/`backlinks` 双向
关系）；**插件零本地状态**——不写任何本地文件、不建本地索引、不跑模型、
不出网。

> 与 `dsh-anytype`（30 个 Anytype 原生工具）的关系：后者是**通用 Anytype
> 封装**，本插件是**记忆语义层**——记忆该长什么样、写入前该读什么、
> 召回该怎么融合与降级，都在这里。

## 它解决什么

主流 agent 记忆系统（Mem0 / Graphiti / Letta / Hindsight …）把记忆存在
**向量库或图库里**：不可审计、不可手改、导出即迁移难题，且往往**必须附带
一个模型**才能工作。

本插件换一条路：**记忆就是你自己空间里的普通对象**——在 Anytype 里能看、
能改、能审、能导出；而「智能」的部分（抽取、去重裁决、合并、嵌入）通过
**工具接口交给外部 agent 自行调用与优化**。

- 真源 = Anytype 对象（人类可读可改可导出）；
- 索引 = Anytype 自己的检索（不建第二份）；
- 向量 = 记忆对象上的一个属性（`memory_embedding`，base64 Float32），由外部
  agent 计算、插件只搬运；
- 记忆语义 = 一套受控词表（kind / status / 受控边）+ 双时序 + provenance
  - 内容哈希幂等 + 置信/佐证/显著度。

## 前置条件

1. **Anytype 桌面应用正在运行**（本地 API 默认 `http://127.0.0.1:31009`）；
2. 在 Anytype 中创建 API key：Vault Settings → Data Management → API Keys →
   `Create new`；
3. dsh 组合中存在 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt`
   提供方（web/base bundle 自带），否则插件停在 PENDING。

## 安装（开发态）

```sh
pnpm dsh plugin --profile <profile> add link:<仓库绝对路径>/packages/dsh-anytype-memory
```

纯 TS 源码入口（`main: src/index.ts`），仅支持 `link:` 安装；实体安装
（npm/git）需先按 `dsh-llm-fallback` 模式加 esbuild dist。

> 依赖 `@lzhida/dsh-anytype-core`（与 `dsh-anytype` 共用的 Anytype 客户端
> 底座）。`link:` 安装时按 realpath 从仓库内的 workspace 软链解析，无需
> 额外安装。

## 配置（Settings → Plugins → dsh-anytype-memory）

| 字段                 | 默认                     | 说明                                                |
| -------------------- | ------------------------ | --------------------------------------------------- |
| `enabled`            | `true`                   | 总开关；关闭后不注册任何工具（指引 section 保留）   |
| `baseUrl`            | `http://127.0.0.1:31009` | Anytype 本地 API 地址                               |
| `apiKey`             | `''`                     | Bearer 密钥；执行时实时读取，改动即时生效           |
| `apiVersion`         | `2025-11-08`             | `Anytype-Version` 请求头                            |
| `spaceName`          | `Agent Memory`           | **记忆工作环境**的空间名（`memory_setup` 按需创建） |
| `spaceId`            | `''`                     | 钉住指定空间（短引用如 `64xiwe` 或完整 id）         |
| `disabledGroups`     | `[]`                     | 停用工具组：setup / write / read / agent / diag     |
| `requestTimeoutMs`   | `30000`                  | 单请求超时                                          |
| `maxResponseChars`   | `20000`                  | 工具结果截断上限                                    |
| `recallLimit`        | `20`                     | 召回默认条数                                        |
| `recallMaxTokens`    | `4096`                   | 召回正文 token 预算（元数据免费）                   |
| `embeddingBatchSize` | `20`                     | 向量投影单批条数（限速 1rps 的往返预算）            |
| `defaultStatus`      | `draft`                  | AI 写入记忆的默认审核态                             |

## 工具清单（16 个，5 组）

| 组    | 工具                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- |
| setup | `memory_setup`（幂等：建空间/类型/属性并把属性挂进类型字段表）                                        |
| write | `memory_write`、`memory_update`、`memory_link`、`memory_supersede`、`memory_archive`、`memory_review` |
| read  | `memory_recall`、`memory_get`、`memory_list`、`memory_search`、`memory_stats`                         |
| agent | `memory_candidates`、`memory_set_embedding`、`memory_suggest_links`                                   |
| diag  | `memory_doctor`（连通性 / schema / 能力探测 / **中文召回自检**）                                      |

写工具统一带 `dry_run`（预演）；`memory_write` 与 `memory_link` 另带
`idempotency_key`（防重）。

## 记忆模型（Anytype 侧）

- **类型**：`memory`（layout **`basic`**）+ `memory_scope`（layout `basic`）；
- **属性命名**：插件自有属性一律 `Memory ` 前缀（key 派生为 `memory_*`），
  **唯一例外是复用内置的 `tag(multi_select)`**——空间自带 41 个内置属性
  （`origin(number)`、`source(url)`、`status(select)` …），朴素显示名会撞
  「同名不同格式」→ 服务端 400 `property format conflict`；
- **种类** `memory_kind`：fact / decision / preference / lesson / procedure /
  episode / summary / entity；
- **状态** `memory_status`：draft（AI 写入默认）→ approved / disputed / archived，
  旧条被取代转 superseded；
- **受控边**（5 条 relation 属性，禁止自由链接语义）：`memory_relates_to` /
  `memory_derived_from` / `memory_contradicts` / `memory_supersedes` /
  `memory_mentions`；
- **双时序**：`memory_valid_from` / `memory_valid_to`（世界真值）+
  `memory_created_at` / `memory_observed_at`（何时知道）；
- **provenance**：`memory_source` / `memory_source_channel` / `memory_extractor`
  / `memory_run_id` / `memory_content_hash`；
- **量化**：`memory_confidence` / `memory_importance` / `memory_salience` /
  `memory_proof_count` / `memory_access_count`；
- **向量**：`memory_embedding`（base64 Float32）/ `memory_embedding_model` /
  `memory_embedding_dim`；
- **审核**：`memory_reviewed_by` / `memory_reviewed_at`；
- **作用域类型** `memory_scope` 的属性：`scope_kind` / `scope_key`。

## 四条不可让步的纪律

1. **写前必读**：`memory_write` 先查内容哈希（幂等）再查近邻，把候选作为
   `conflicts[]` 上报——**裁决权归 agent**。插件永不覆盖已存正文、永不隐式
   下调置信度。
2. **失效不删**：矛盾用「新对象 + `memory_supersedes` 边 + 旧条
   `memory_status=superseded` + `memory_valid_to`」表达；
   `memory_origin=user` 的人类记忆**拒绝被机器自动作废**；遗忘靠
   `memory_salience` 衰减与 `archived`，而不是删除（Anytype 的 DELETE 只能删
   本 API key 创建的对象，HTTP v2 更没有删除空间的端点）。
3. **模型在外部**：插件不调用 LLM、不生成嵌入、不持有模型密钥；向量由
   agent 用自己的嵌入工具算好后经 `memory_set_embedding` 写入，召回时用
   `memory_recall(query_vector, embedding_model)` 启用向量臂——不同模型的
   向量**禁止混算**。
4. **属性必须挂进类型字段表**：字段表 = 类型文档 `blocks[0]`（dataview）的
   `properties[]`。不在字段表里的属性「会被存储并随对象返回，但按类型过滤/
   查询时该键被拒绝」——`memory_setup` 因此要 `add_property` 补挂。

## 召回

三臂并行 → RRF(k=60) 融合 → 乘性旁证权重 → token 预算截断：

- **词法臂**：Anytype 全文搜索（`query` + `filter` + `sorts` + `fields`）；
- **向量臂**：外部 agent 的查询向量 × 对象上的 `memory_embedding` 属性
  （本地余弦，分批投影，**向量原文绝不返回给模型**）；
- **关系臂**：先按受控边属性反查；**服务端接受该过滤但匹配不到行**（实测
  `total=0`），故兜底为投影原生 `links` / `backlinks`，邻居 id 以
  `related_ids` 返回。

乘性权重：`final = rrf × recency^0.2 × confidence^0.2 × proof^0.1`，
`recency = clamp(1 - days/365, 0.1, 1)`。

## 活机实测要点（2026-10-23，Anytype 桌面端 v2 API）

这些是单元测试抓不到、只有真机才暴露的问题，细节见
[05 Anytype 就是索引](./docs/05-anytype-as-source.md) §2.4：

| 结论                                                              | 影响                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| 插件属性显示名必须带 `Memory ` 前缀（`tag` 复用内置）             | 否则 400 `property format conflict`                                   |
| 记忆类型布局必须是 `basic`（不是 `note`）                         | `note` 会把对象标题吞成正文块，标题能力直接丢失                       |
| 类型字段表 = 类型文档 dataview 块的 `properties[]`                | 不挂进字段表 → 按类型过滤时该键被拒绝                                 |
| 紧凑类型列表接口读不到字段表                                      | 必须逐个读类型文档                                                    |
| 建类型会顺带铸造属性                                              | 建完类型必须**重新盘点**属性，否则撞 `property key already exists`    |
| **中文全文检索可用** ✅（标题与正文都参与索引；对**常用词**可靠） | 此前「中文分词失效」的担忧被证伪；**生僻词/未登录词不可靠**           |
| 全文索引是最终一致的（实测约 3～6s 后才可命中）                   | 中文自检必须**轮询重试**（最多 8 次、间隔 1500ms）+ 中文/ASCII 双探针 |
| relation 过滤被接受但匹配不到行                                   | 关系臂兜底为 `links` / `backlinks` 投影                               |
| 对象标题在 `properties.name`                                      | 对象文档没有顶层 `name` 字段                                          |
| 同一 etag 只能写一次                                              | 多字段变更必须合并进同一个 `set_properties` op                        |
| 删除受限：DELETE 只对本 key 创建的对象有效；v2 无 space 删除端点  | 记忆条目一律 `memory_status=archived`                                 |
| 属性值形状：列表型键取数组、标量型键取标量；未知键 → 400          | 受控词表不开 `create_missing_options`；`tag` 才开                     |

## 文档

完整设计文档在 [`docs/`](./docs/README.md)（10 篇，含 6+ 张 Mermaid 流程图）：

| 文档                                                   | 回答什么                                      |
| ------------------------------------------------------ | --------------------------------------------- |
| [01 架构](./docs/01-architecture.md)                   | 插件长什么样、边界在哪                        |
| [02 记忆模型](./docs/02-memory-model.md)               | 一条记忆在 Anytype 里长什么样                 |
| [03 关键流程](./docs/03-flows.md)                      | 初始化/写入/召回/巩固/自检/取代的时序         |
| [04 工具 API](./docs/04-tool-api.md)                   | 16 个工具的入参与返回契约                     |
| [05 Anytype 就是索引](./docs/05-anytype-as-source.md)  | 为什么不用本地索引（活体实测证据）            |
| [06 LLM/向量委托](./docs/06-llm-vector-delegation.md)  | 插件不做什么、agent 侧六步 SOP                |
| [07 主流方案审查](./docs/07-memory-systems-review.md)  | Mem0/Graphiti/Letta/Hindsight… 与本插件的取舍 |
| [08 Anytype 生态](./docs/08-anytype-ecosystem.md)      | 官方与社区已做过什么、我们补什么              |
| [09 限制与安全](./docs/09-limits-and-security.md)      | API 边界、限速、破坏性操作、记忆投毒          |
| [10 路线图与验收](./docs/10-roadmap-and-acceptance.md) | 阶段、DoD 与自建评测方法                      |

## 测试

```sh
pnpm --filter @lzhida/dsh-anytype-memory typecheck
pnpm exec vitest run packages/dsh-anytype-memory
```

单测覆盖纯函数（归一化/哈希、RRF/boost/预算、向量编解码与余弦、切块、
bootstrap 计划、配置解析）与工具契约（幂等路径、draft 态、冲突上报、
状态流转、向量空间隔离、**零本地文件写入**、**请求只打向 127.0.0.1**）。

e2e（真实 dsh 实例 + 真实 Anytype）见 `.agents/skills/dsh-plugin-dev/SKILL.md`
§5 四步流程；apiKey 经 test profile 的 `cordis.patch.yml` 注入（密钥不入库）。
