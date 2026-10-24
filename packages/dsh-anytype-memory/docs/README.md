# dsh-anytype-memory 文档集

> **插件定位（一句话）**：记忆真源、索引、关系、向量全部在 Anytype 内；插件零本地状态、不跑模型、不出网。

`dsh-anytype-memory` 给 AI agent 提供一套**以 Anytype 空间为唯一存储后端**的持久记忆：每一条记忆对象、每一个属性、每一条关系、每一个 embedding 数值都活在 Anytype 里，插件自身**不建 SQLite、不建本地索引、不落本地文件**。插件也**不跑任何 LLM 或 embedding 模型**——抽取、去重判断、摘要、向量化、重排全部通过工具调用委派给外部 agent；插件与外界的唯一一条网络通路是 `127.0.0.1` 上的 Anytype 本地 API。

---

## 本文回答什么问题

- 这套文档一共十篇、每篇解决什么问题、你该按什么顺序读；
- 核心概念的统一口径（space / object / property / relation / backlink / content_hash / RRF / draft 态 / scope / 记忆 kind）；
- 每个文档对应哪一段源码——想动手改代码时知道去哪找。

## 阅读前置

- 无。本文件是索引，可直接阅读。
- 其余文档默认读者已知 dsh 插件装载模型（`apply(ctx)` / `ctx.effect` / `defineTool`）与 cordis 依赖注入；不熟时先读 04。

---

## 文档清单

| 编号 | 文档                                                  | 回答什么问题                                                                                         | 什么时候读                               |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 01   | [架构设计](./01-architecture.md)                      | 插件长什么样、边界在哪、模块怎么切、「零本地状态」为什么是主线                                       | 第一次读这套文档、评审整体方案时         |
| 02   | [记忆模型](./02-memory-model.md)                      | 一条记忆在 Anytype 里长什么样、属性字典、受控边语义、状态机、scope 到底管什么                        | 要理解「什么该记、怎么组织、怎么忘」时   |
| 03   | [关键流程](./03-flows.md)                             | 初始化 / 写入 / 召回 / 巩固 / 自检 / 取代各自的时序与幂等保证                                        | 要跟一遍端到端数据流时                   |
| 04   | [工具 API 契约](./04-tool-api.md)                     | 16 个工具逐个的入参、返回值、错误语义，以及并发/幂等/token 预算等跨切面契约                          | agent 要调用某工具、排查行为契约时       |
| 05   | [Anytype 就是索引](./05-anytype-as-source.md)         | Anytype v2 的活体实测能力、它替代了本地索引的哪些部分、三臂召回与 RRF 融合设计                       | 想理解「为什么是 Anytype、召回怎么算」时 |
| 06   | [LLM / 向量委托契约](./06-llm-vector-delegation.md)   | 插件硬边界（不跑 LLM / 不跑 embedding / 零本地状态）、向量协议与 agent 侧六步 SOP                    | 想理解分工边界、给 agent 写调用规程时    |
| 07   | [主流持久记忆方案审查](./07-memory-systems-review.md) | Mem0 / Graphiti / Letta / LangMem / Cognee / Hindsight 等系统的横向审查，与本插件逐条「采纳/不采纳」 | 想借鉴他人经验、评估设计取舍时           |
| 08   | [Anytype 生态与社区对照](./08-anytype-ecosystem.md)   | 官方 Anytwo 记忆模型、官方 MCP/skill/runtime、社区项目，以及本插件的差异化定位                       | 想确认「别人做过什么、我们补什么」时     |
| 09   | [限制与安全](./09-limits-and-security.md)             | Anytype API 的能力边界与漂移策略、限速预算、破坏性操作、并发一致性、密钥隐私、记忆投毒               | 做安全评估、写防护规则、评估上线风险时   |
| 10   | [路线图与验收](./10-roadmap-and-acceptance.md)        | P0–P9 阶段划分与门禁、DoD 12 条、自建评测方法、风险登记                                              | 排期、验收、决定本版做与不做时           |

> 文档集统一采用 `NN-<kebab-case>.md` 命名；**算法口径以实现为准**
> （`src/dedup.ts` / `src/recall.ts`），05/02/03 三篇已于 2026-10-23 对齐，
> 差异记录见 [05 §9](./05-anytype-as-source.md)。

---

## 三条阅读路径

### ① 想快速用起来（只关心「怎么跑起来」）

**读 02 → 04。** 02 先告诉你**什么值得记**（记忆模型、属性字典、写入白名单、什么不该记）；04 再告诉你**怎么调**（16 个工具的入参出参、调用序列、错误语义）。

读完你应该能：独立完成一次 `memory_setup` → `memory_write` → `memory_recall` 的闭环，并知道每条该记的内容该落到哪个 `kind` 与 `scope`。

### ② 想理解设计取舍（关心「为什么这么做」）

**读 01 → 05 → 06 → 07 → 08。** 01 给架构与硬约束；05 给「Anytype 作为真源」的能力边界与三臂召回 + RRF 融合；06 给「LLM 与向量全部外包给 agent」的边界与 agent 侧 SOP；07 / 08 续篇展开剩余取舍与工程化落点。

读完你应该能：解释「为什么不做本地索引」「为什么归档而不是删除」「为什么向量臂要在候选集上线性算」，并指出改动某处会波及哪些模块。

### ③ 想接入 / 扩展（关心「怎么在你自己的流程里用起来」）

**读 03 → 09 → 10。** 03 给端到端流程与幂等保证（初始化 / 写入 / 召回 / 自检 / 取代）；09 给能力边界、限速预算、并发与投毒防护；10 给阶段门禁、DoD 与评测口径。

读完你应该能：把 `memory_*` 工具接进自己的 agent 编排，写出符合预算的召回调用序列，并按 DoD 验收自己的实现。

---

## 术语表

| 术语              | 释义                                                                                                                                                                          | 首次出现 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Anytype space** | 用户的顶层知识空间，本插件的**唯一存储后端**。记忆对象全部住在用户指定的那一个空间里；插件不建新空间、不跨空间读——**空间是硬边界**                                            | 01       |
| **object**        | Anytype 的最小内容单元。本插件的每条记忆就是一个 type 为 `memory` 的 object                                                                                                   | 01 / 02  |
| **property**      | 对象的属性槽位，分 select / multi_select / text / number / date / objects 等格式。`memory_kind`、`memory_status`、`memory_confidence` 等都是 property                         | 02       |
| **relation**      | 指向另一 object 的属性（`format: objects`）。本插件的受控边都是 relation                                                                                                      | 02       |
| **backlink**      | 「谁指向了我」的反向边。HTTP v1/v2 **没有 backlink 端点**，只能读空间原生 `backlinks(objects)` 关系属性（或用 `filter='backlinks IS NOT EMPTY'` 收窄）再在客户端侧处理        | 02 / 09  |
| **content_hash**  | 归一化正文的 SHA-256 十六进制串，存为 text 属性。**查重主键**：同内容重复写入直接返回既有 id，不新建                                                                          | 02 / 09  |
| **RRF**           | Reciprocal Rank Fusion，倒数排名融合（默认 `k = 60`）。把三臂候选按**名次**而非分数融合成一路排序结果，天然规避不同检索路的分数尺度不可比问题                                 | 02 / 05  |
| **draft 态**      | `status = draft` 的记忆：agent 写入的默认状态。它**保留在召回中**（不会被自动排除），但带状态标记，要求 agent 审慎引用——「可见但不被当真」                                    | 02 / 09  |
| **scope**         | 记忆的隔离维度，实现为 `memory_scope` 对象（`kind` 取 `project` / `agent` / `user`，`key` 为稳定标识），通过 `scope` 关系挂到记忆上。**不用 collection 表达作用域**           | 02       |
| **记忆 kind**     | `memory_kind` 属性（select）的八个取值：`fact` / `decision` / `preference` / `lesson` / `procedure` / `episode` / `summary` / `entity`，是记忆的**语义分类**而非状态          | 02       |
| **受控边**        | `memory_link` 只写 5 种固定关系：`relates_to` / `derived_from` / `contradicts` / `supersedes` / `mentions`；另有 `source`（本条派生自哪条）由**写路径自动落**。插件不造任意边 | 02 / 04  |

---

## 插件速览

### 16 个工具

| 组    | 工具                   | 一句话职责                                                                                    |
| ----- | ---------------------- | --------------------------------------------------------------------------------------------- |
| setup | `memory_setup`         | 幂等 bootstrap：确保 `memory` / `memory_scope` 类型与属性字典齐备（只补缺失，不覆盖用户已改） |
| write | `memory_write`         | 写入记忆（批量）；`content_hash` 查重命中即返回既有 id 与 `conflicts[]`，不新建               |
| write | `memory_update`        | 局部更新（`expected_etag` / `if_content_hash` 乐观锁；**绝不覆盖已存文本**）                  |
| write | `memory_link`          | 在两条记忆之间建立一条**受控边**                                                              |
| write | `memory_supersede`     | 建立取代关系（新条 + 旧条 `superseded` + `valid_to`）；**拒绝**取代 `origin=user` 的对象      |
| write | `memory_archive`       | 归档一条记忆（`status=archived`）——**永不删除**                                               |
| write | `memory_review`        | 评审与状态流转（`approved` / `disputed` / 回 `draft`）                                        |
| read  | `memory_recall`        | 三臂召回（`lexical` / `vector` / `links`）→ RRF 融合 → token 预算截断                         |
| read  | `memory_get`           | 取回单条记忆全貌（属性 + 正文 + 出入关系 + 出处）                                             |
| read  | `memory_list`          | 结构化列举（`limit` 上限 100）                                                                |
| read  | `memory_search`        | 低层全文检索逃生舱（`limit` 上限 1000，服务端上限）                                           |
| read  | `memory_stats`         | 统计聚合                                                                                      |
| agent | `memory_candidates`    | 候选切块（零 LLM），供 agent 判断重复 / 冲突 / 待审                                           |
| agent | `memory_set_embedding` | 写入 base64 向量——**插件唯一接触向量的入口**（插件只编解码，不生成）                          |
| agent | `memory_suggest_links` | 关系建议（**只读、不落库**）                                                                  |
| diag  | `memory_doctor`        | 环境自检：身份授权、空间可达、类型属性齐备、中文召回探针、能力矩阵与降级建议                  |

### 记忆模型一句话

**一条记忆 = 一个 Anytype object**。只有两种类型：`memory`（layout **`basic`**，记忆本体；`note` 布局会把标题吞成正文块，故不用）与 `memory_scope`（layout `basic`，软作用域标记）。`memory_kind` 标语义类别、`memory_status` 标生命周期、`memory_origin` 标人写/机写、`memory_source_channel` 标来源通道、`memory_scope` 挂隔离维度、`memory_content_hash` 做查重主键、`memory_embedding`（base64 Float32）承载向量；记忆之间用受控边表达关系（`memory_link` 的 5 种 + 写路径自动落的 `memory_source`）；`memory_confidence` / `memory_importance` / `memory_salience` / `memory_proof_count` / `memory_access_count` 承载可信度、重要性、衰减与热度。

> 插件自有属性一律带 `Memory ` 前缀（唯一例外：复用 Anytype 内置的 `tag`）——空间自带 `origin(number)` / `source(url)` / `status(select)` 等内置属性，朴素命名会撞出 400 `property format conflict`。

完整属性字典见 02；工具的完整入参出参见 04。

---

## 本文档集与代码的对应关系

> **路径口径**：下表所有路径**相对仓库根目录**。表中 `packages/dsh-anytype-memory/src/**` 与 `packages/dsh-anytype-core/**` 是 01 文档 §3.1 冻结的**目标模块布局**，由 P3–P6 落地；`packages/dsh-anytype/` 是仓库中**已存在**的底层 Anytype 客户端插件（P2 的抽取来源）。

| 文档                | 主要对应源码                                                                                                                                                                                                  | 说明                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 01 架构设计         | `packages/dsh-anytype-memory/src/index.ts`、`packages/dsh-anytype-memory/src/config.ts`                                                                                                                       | 插件入口、配置面与分层规则即「能做什么 / 不做什么」的落点                                          |
| 02 记忆模型         | `packages/dsh-anytype-memory/src/schema.ts`、`packages/dsh-anytype-memory/src/store.ts`                                                                                                                       | 类型/属性字典的**唯一定义源**与 Anytype 侧读写原语                                                 |
| 03 关键流程         | `packages/dsh-anytype-memory/src/store.ts`、`packages/dsh-anytype-memory/src/dedup.ts`、`packages/dsh-anytype-memory/src/doctor.ts`、`packages/dsh-anytype-memory/src/tools/{setup,write,read,agent,diag}.ts` | 六个流程的时序与幂等保证的落点                                                                     |
| 04 工具 API 契约    | `packages/dsh-anytype-memory/src/tools/{setup,write,read,agent,diag}.ts`                                                                                                                                      | 16 个工具的注册面与调用契约                                                                        |
| 05 Anytype 作为真源 | `packages/dsh-anytype-core/src/client.ts`、`packages/dsh-anytype-memory/src/recall.ts`、`packages/dsh-anytype-memory/src/embedding.ts`                                                                        | HTTP 语义收敛处与召回/向量算术层                                                                   |
| 06 LLM 与向量委派   | `packages/dsh-anytype-memory/src/embedding.ts`、`packages/dsh-anytype-memory/src/chunk.ts`、`packages/dsh-anytype-memory/src/tools/agent.ts`                                                                  | 编解码与确定性分块（纯函数）+ agent 侧回写入口                                                     |
| 07 设计深读续篇     | `packages/dsh-anytype-memory/src/recall.ts`、`packages/dsh-anytype-memory/src/dedup.ts`                                                                                                                       | 取舍在纯函数层的具体体现                                                                           |
| 08 工程化落点       | `packages/dsh-anytype-memory/src/index.ts`、`packages/dsh-anytype-memory/src/store.ts`、`packages/dsh-anytype-core/src/shared.ts`、`packages/dsh-anytype-core/src/index.ts`                                   | 装配关系与 core 包的公共设施                                                                       |
| 09 限制与安全       | `packages/dsh-anytype-core/src/client.ts`、`packages/dsh-anytype-memory/src/doctor.ts`、`packages/dsh-anytype-memory/src/config.ts`                                                                           | 错误归一与 `If-Match` / `Idempotency-Key` 映射（client）、运行时自省（doctor）、密钥现读（config） |
| 10 路线图与验收     | `packages/dsh-anytype-core/`（整包）、`packages/dsh-anytype-memory/src/**/*.test.ts`、`packages/dsh-anytype-memory/docs/`                                                                                     | 抽取边界、门禁证据、文档集本身                                                                     |

---

## 事实标注口径

本套文档中出现的每一条「事实」都带标注，请按标注强度理解：

| 标注                | 含义                                                                               |
| ------------------- | ---------------------------------------------------------------------------------- |
| （无标注）          | 设计约定或本文档集内部的定义，照此实现即可                                         |
| 实测                | 已在活体 Anytype（`http://127.0.0.1:31009`，pre-release 构建）上验证过，附验证方式 |
| `[待活体验证]`      | 尚未验证的假设，**同时给出验证方式**；未验证前不得当作承诺                         |
| `[UNVERIFIED 转述]` | 来自第三方审计或他人结论的**转述**，本仓库未复现；仅作风险量级参考                 |

---

## 下一步

- 只想用 → 读 [02 记忆模型](./02-memory-model.md) 与 [04 工具 API 契约](./04-tool-api.md)；
- 想评审 → 读 [01 架构设计](./01-architecture.md) 与 [09 限制与安全](./09-limits-and-security.md)；
- 想实现 → 读 [03 关键流程](./03-flows.md) 与 [10 路线图与验收](./10-roadmap-and-acceptance.md)。
