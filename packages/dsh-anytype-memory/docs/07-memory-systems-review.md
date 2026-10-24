# 07 · 主流持久记忆方案审查

> **本文回答什么问题**：我们要把「Anytype 当 agent 记忆库」这件事做对，
> 就得知道别人怎么做的、哪些已被证明有效、哪些是已知陷阱。
> 本文给出主流持久记忆系统的横向审查与**逐条采纳/不采纳结论**，每条结论
> 都能追溯到本插件的具体设计。
>
> **阅读前置**：[05-anytype-as-source.md](./05-anytype-as-source.md)（我们
> 为什么把索引也交给 Anytype）。本文只讲「记忆系统本身怎么做」。
>
> **事实标注**：带 `[UNVERIFIED]` 的是第三方博客/榜单转述，未见一手来源，
> 仅作参考；其余均附一手链接。基准数字尤其要当心——见 §5。

---

## 1. 为什么必须先做审查

三条反模式在主流系统里被反复验证，代价都很高：

1. **单次 LLM 抽取无校验**——字段级准确率会复合放大（20 个字段各 97%
   ⇒ 整条记录约 54% 正确）。
2. **append-only 不消解矛盾**——新事实以 `ADD` 追加，旧事实继续被检索命中；
   第三方审计称某系统在真实场景下准确率腰斩、陈旧率约 38%
   `[UNVERIFIED 转述]`。
3. **把向量库当权威**——向量不可审计、不可手改、不可导出；源系统一旦权威
   丢失，用户既不能纠错也不能迁移。

> **结论（写在本插件的设计里）**：写路径的正确性 > 读路径的花哨；
> 真源必须是**用户可读可改可导出**的笔记库，向量只能是派生索引。

---

## 2. 系统族谱

| 族                | 代表                              | 核心假设                          | 存储                             |
| ----------------- | --------------------------------- | --------------------------------- | -------------------------------- |
| A. 事实向量库     | Mem0、Supermemory                 | 记忆 = 原子事实 + embedding       | 向量库 + SQLite                  |
| B. 时序知识图     | Zep/Graphiti、Hindsight、Elephant | 记忆 = 实体 + 带有效期的边        | 图库/PG + 向量 + 全文            |
| C. Agent 自主管理 | Letta、LangMem、Memary            | 记忆 = LLM 用工具编辑的块         | Postgres+pgvector / Store / JSON |
| D. 管道 + 图富化  | Cognee、memU、OpenViking          | 记忆 = 从原始资源逐层编译出的结构 | 多库（关系+向量+图）             |

---

## 3. 逐系统

### 3.1 Mem0 — <https://github.com/mem0ai/mem0> · <https://docs.mem0.ai/core-concepts/memory-types>

- **数据模型**：记忆 = 原子事实（自然语言 + metadata + hash）。`MemoryType`
  里的 `semantic_memory` / `episodic_memory` **未实现**（传了会报错），
  唯一可用的是 `procedural_memory`（仅 Python OSS，需 `agent_id`）。
- **写管线**（`infer=True` 默认）：收集同 scope 上下文 → embedding 后向量
  检索候选 → **一次 LLM 调用**逐条判定 `ADD / UPDATE / DELETE / NONE` →
  去重 + embedding → 实体抽取。判定协议要求 `UPDATE`/`DELETE` 必须带已有
  id、禁止编造 id。
- **检索**：向量 + 实体共现 boost；OSS 文档未描述 BM25/hybrid。
- **作用域**：`user_id` / `agent_id` / `run_id` 至少一个必填，作为 metadata filter 下推。
- **工具面**：SDK `add/search/update/delete/get/history`；**OpenMemory MCP**
  暴露 `add_memories` / `search_memory` / `list_memories` / `delete_memories`。
- **本地优先**：可自托管；完全离线需 `LLM_PROVIDER=ollama` + `EMBEDDER_PROVIDER=ollama`。
- **弱点**：本地模型下 UPDATE prompt 常解析不出 `event` 字段（官方 issue
  <https://github.com/mem0ai/mem0/issues/2758>）；append-only 导致陈旧；
  无淘汰策略。

> **本插件采纳**：**写事件词表**（`ADD / UPDATE / DELETE / NONE`）与「禁止编造
> id」规则 → 写进 `memory_write` 的工具描述与 `docs/06`。
> **不采纳**：单次 LLM 判定（本插件把裁决交给 agent 的显式多步流程）、
> 实体图（本插件用受控 relation 边代替）。

### 3.2 Zep / Graphiti — <https://github.com/getzep/graphiti> · 论文 <https://ar5iv.labs.arxiv.org/html/2501.13956>

- **数据模型**：**时序知识图**。节点 `EntityNode` / `EpisodicNode` /
  `CommunityNode` / `SagaNode`；边 `EntityEdge`（含 fact 文本、embedding、
  有效期）、`EpisodicEdge`、`CommunityEdge` 等。**双时序**：边带 `valid_at`
  （世界事实何时为真）/ `invalid_at`（何时失效）/ `created_at`（何时入库），
  旧事实**不删只失效**。
- **写管线** `add_episode()`：取上下文 → LLM 抽实体 → 实体解析（去重/合并）
  → LLM 抽边 → 边解析（矛盾→时间失效 + 新边）→ 建 episodic 边 → 落库 →
  更新社区。**每步一次 LLM 调用**，写成本最高的一档。
- **检索**：三路并行（语义 + BM25 + 图遍历）；预置配方
  `EDGE_HYBRID_SEARCH_RRF`、`EDGE_HYBRID_SEARCH_NODE_DISTANCE`、
  `COMBINED_HYBRID_SEARCH_CROSS_ENCODER`。
- **工具面**（MCP server 源码为准）：`add_memory` / `add_triplet` /
  `search_nodes` / `search_memory_facts` / `get_episodes` / `build_communities` /
  `summarize_saga` / `delete_episode` / `delete_entity_edge` / `clear_graph`。
- **本地优先**：**Kùzu 是嵌入式图库，官方文档明确写"适合 local-first 应用"**。
- **弱点**：写路径 LLM 重；社区发现昂贵；**「失效不删」意味着读路径必须过滤
  `valid_at`，否则读到已过期事实**——工程上极易漏。

> **本插件采纳**：**双时序**（`memory_valid_from` / `memory_valid_to`）+ **失效不删**
> （`memory_supersede` 写旧条 `memory_status=superseded` + `memory_valid_to`，正文永不改写）。
> **不采纳**：图数据库与社区发现（本插件用受控 relation 边 + sidecar-free 的
> 一跳反查）。

### 3.3 Letta / MemGPT — <https://github.com/letta-ai/letta> · 论文 <https://arxiv.org/abs/2310.08560>

- **数据模型**：三层 OS 隐喻——core memory（`Block`：label/value/limit/描述，
  **始终渲染进 system prompt**）、archival memory（`Passage`：text+embedding+
  tags+created_at）、recall memory（全量消息）。Block 可跨 agent 共享。
- **写管线**：**没有后台抽取器**——写是 agent 自己调工具
  （`core_memory_append` / `core_memory_replace` / `archival_memory_insert`）。
  巩固走 **sleep-time compute**（另起一个后台 agent 异步改写共享 block）。
- **检索**：archival 语义检索 + recall 按时间/内容 + core 恒常在上下文。
- **工具面**：`core_memory_append` / `core_memory_replace` /
  `archival_memory_insert` / `archival_memory_search` / `conversation_search`。
- **本地优先**：可完全本地（Postgres+pgvector，provider 可换 Ollama/vLLM）。
- **弱点**：记忆内容由 LLM 直接写入 → **幻觉记忆直接落库**；官方自承
  "记忆会随时间变得凌乱"（sleep-time agent 的存在理由）；core 常驻占上下文。

> **本插件采纳**：**「工具即记忆管理」**（本插件 16 个工具就是记忆管理面）、
> **「记忆是数据不是运行时状态」**（零本地状态，卸载无残留）。
> **不采纳**：core memory 常驻上下文（本插件只按需召回，不常驻）。

### 3.4 LangMem / LangGraph — <https://langchain-ai.github.io/langmem/>

- **数据模型**：不是存储引擎，是 `BaseStore` 之上的原语（semantic / episodic /
  procedural 三分）。
- **写管线**：热路径 `manage_memory(content, action=create|update|delete, id)`
  是 `store.put/delete` 的薄封装，**零去重、零富化**；后台 `MemoryStoreManager`
  走「生成查询 → 语义检索候选 → extractor 一次 LLM 并行发
  insert/update/delete → diff 后落库」。
- **检索**：完全由 store 提供（仅语义搜索），库内无 hybrid/rerank。
- **弱点**：官方承认尚无 opinionated 的 episodic 工具；**热路径无去重 → 重复条目**。

> **本插件采纳**：后台/热路径分离的思路（`memory_candidates` 供后台批处理用，
> `memory_write` 供热路径用）。
> **不采纳**：零去重写路径——本插件把 content_hash 幂等做成**硬前置**。

### 3.5 Cognee — <https://docs.cognee.ai> · <https://github.com/topoteretes/cognee>

- **数据模型**：`DataPoint` = 稳定 UUID + 类型判别 + 自由 metadata +
  **溯源字段**（`source_pipeline` / `source_task` / `source_node_set` /
  `source_content_hash`）。
- **写管线**：`add()`（ingest→hash→dedup→persist）→ `cognify()`（classify →
  chunk → 抽 SPO 三元组 → 层级摘要 → embedding + 落库）→ `memify()`（子图抽取、
  规则关联）。
- **检索**：`GRAPH_COMPLETION` / `CHUNKS` / `GRAPH_SUMMARY_COMPLETION`。
- **本地优先**：**默认全嵌入式、零服务**（关系=SQLite，向量=LanceDB，图=Kùzu）。
- **弱点**：官方明确「默认 Kùzu 用文件锁，不适合多 agent 并发」；管线每阶段都吃 LLM。

> **本插件采纳**：**provenance 字段族**——`source` / `source_channel` /
> `extractor` / `run_id` / `content_hash` 五件套直接进入本插件的属性字典。
> **不采纳**：多阶段 LLM 管线（本插件把阶段交给 agent 自行编排）。

### 3.6 Hindsight（vectorize.io）— <https://github.com/vectorize-io/hindsight>

- **数据模型**：仿生四型——world facts / experiences / observations（带证据与
  proof count 的信念）/ mental models；存在 **bank** 里（一个 bank = 一个
  「脑」，严格不跨库泄漏）。
- **写管线** `retain()`：富抽取（事实+情绪+理由+上下文）→ 按说话人分类 →
  实体消解 → **双时间戳**（事件发生时间 vs 获知时间）→ 建四类图连接 → 打 tag
  → **后台 observation consolidation**（新证据到来时 observation 被「强化/削弱/
  扩展」而非覆盖，保留原文引用与 proof count）。抽取模式含 **chunks（零 LLM）**。
- **检索**（最值得抄的一套参数化 read 管线）：**四路并行** = 语义 + 关键词
  （5 种可插拔 BM25 后端）+ 图遍历 + 时间窗 → **RRF 融合（k=60，四路等权）**
  → **cross-encoder 重排** → **三个乘性 boost**：
  `final = CE_norm × recency_boost × temporal_boost × proof_boost`
  （recency = `clamp(1 - days_ago/365, 0.1, 1)`，α=0.2）→ **token 预算截断**
  （`max_tokens` 默认 4096，只有记忆正文计预算）。
- **工具面**：`retain` / `recall` / `reflect` + documents / mental models /
  knowledge pages / banks；**每 bank 一个 MCP 端点**。
- **本地优先**：默认内嵌 pg0（嵌入式 Postgres），生产建议外部 Postgres+pgvector。
- **弱点**：强依赖 Postgres + 向量扩展，无 SQLite 路径；抽取非确定性（官方明说
  「这次出事实那次不出」）；自报 LongMemEval 91.4% 用了 Gemini 3 Pro reader
  `[UNVERIFIED: 跨 provider 不可直接比较]`。

> **本插件采纳**（本插件的召回参数几乎逐条来自这里）：
> **RRF(k=60)**、**乘性 boost**（recency/confidence/proof）、**token 预算截断**、
> **observation 强化不覆盖**（→ 谦逊合并）、**零 LLM 的 chunks 抽取档**
> （→ `memory_candidates`）。
> **不采纳**：Postgres/pgvector（本插件零本地状态）、实体消解与图连接
> （本插件用受控 relation 边）。

### 3.7 memU / Memary / Supermemory（简表）

| 系统                                                           | 数据模型                                                                         | 检索                                          | 本地优先                                | 对本插件的结论                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **memU** <https://memu.pro/blog/memu-1-0-0-release>            | 三层：Resource → Memory Item → **Memory Category（聚合文件，只有这些进上下文）** | 自顶向下取类别文件 → 回落 item → 回落原资源   | ⚠️ 需 Postgres                          | 采纳「分层聚合」思路的**建议版**（`memory_suggest_links` 只提候选，不自动合并）                                        |
| **Memary** <https://github.com/MemaryAI/MemaryAI>              | memory stream + entity store（JSON 文件）                                        | 图 search + 外部搜索兜底                      | ✅ 本地 Ollama                          | 目录级实现，2024 后停更 `[UNVERIFIED]`；仅作对照                                                                       |
| **Supermemory** <https://github.com/supermemoryai/supermemory> | document(chunk) + memory（实体为中心的短事实，`isStatic` 标记永久特质）          | `searchMode: semantic\|hybrid` + 丰富 filters | ❌ 官方后端闭源，自托管 enterprise-only | 采纳 **`customId` 幂等同构**（→ 本插件的 `content_hash` 幂等）与 `isStatic` 式「静态特质 vs 活动事实」的 kind 划分雏形 |

### 3.8 竞品速览（出自 Hermes 官方 memory-provider 文档）

| 系统                       | 工具名                                                   | 亮点                                                                                        |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **OpenViking**（火山引擎） | `viking_search/read/browse/remember/forget/add_resource` | 文件系统式知识库 + **分层加载**（L0 摘要 / L1 概要 / L2 全文），会话提交时自动抽取 6 类记忆 |
| **Elephant**               | 30+                                                      | **单 Neo4j 存向量+全文+图+时间**，夜间 "dream" 周期做去重/合并/**艾宾浩斯衰减剪枝**         |
| **Honcho**                 | `honcho_profile/search/context/reasoning/conclude`       | 用户建模 + dialectic 推理，双层上下文注入                                                   |
| **MemOS**                  | —                                                        | 学术：MemCube（内容+provenance+versioning），可在三类记忆间组合迁移                         |

---

## 4. 学术线（决定设计灵感的 6 篇）

| 论文                                                     | 核心机制                                                                                                                                                                                               | 迁移到本插件                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Generative Agents** <https://arxiv.org/abs/2304.03442> | memory stream；检索分 = recency（`0.995^小时`）+ importance（写时定一次）+ relevance（cosine），三者 min-max 归一后等权相加；**reflection 在 importance 累计 > 150 时触发**                            | 三信号打分与「归一化后等权」是最省事的检索基线；reflection 的**触发阈值**比「每轮都总结」省 token → 本插件的巩固作业**由 agent 按预算自行触发**，插件不自动跑 |
| **MemoryBank** <https://arxiv.org/abs/2305.10250>        | 艾宾浩斯遗忘曲线启发的记忆更新：按时间衰减 + 相对显著性决定遗忘/强化                                                                                                                                   | **遗忘 = 衰减权重，不是删除** → 本插件的 `salience` 属性 + `archived` 终态                                                                                    |
| **A-MEM** <https://arxiv.org/abs/2502.12110>             | Zettelkasten 原子笔记 `m={c,t,K(关键词),G(标签),X(上下文),e(向量),L(链接集)}`；新记忆先 top-k 余弦召回候选，再由 **LLM 判定是否建链**，并**反向更新旧记忆**；检索 = 向量命中 + 同 box 链接记忆一并召回 | **「链接由 LLM 判定、存在用户可编辑的笔记库里」**——本插件方案最直接的理论背书（`memory_suggest_links` 提候选、`memory_link` 由 agent 裁决建边）               |
| **Memory OS** <https://arxiv.org/abs/2506.06326>         | 短/中/长三层；短→中按 dialogue-chain FIFO；中→长按分段分页；检索用语义分段 + **热度淘汰**                                                                                                              | 分层 + 热度淘汰 = 省 token 手段（本插件的 token 预算截断是同源思路）                                                                                          |
| **MemGPT** <https://arxiv.org/abs/2310.08560>            | 虚拟上下文管理：main / recall / archival；agent 用函数调用自己做分页                                                                                                                                   | 「工具即记忆管理」——本插件的工具面直接沿用                                                                                                                    |
| **Reflexion** <https://arxiv.org/abs/2303.11366>         | 言语化强化：失败→自然语言反思存入 **有界** episodic buffer（Ω=1-3）                                                                                                                                    | 反思文本应**小而少**；有界 buffer 是注入预算的先例                                                                                                            |

---

## 5. 基准与其可信度（权重很高，但结论是「别信它」）

- **LongMemEval** <https://arxiv.org/abs/2410.10813> 的可迁移结论：
  ① **round 级粒度优于 session 级**（再压成单事实会掉总体、涨跨会话推理）；
  ② **事实增强的 key 扩展**（把抽出的事实并入索引 key）→ recall@k +9.4%；
  ③ **时间感知的 query 扩展**→ 时间题 recall +6.8%~11.3%。
- **LoCoMo**（Mem0 论文口径）：Letta 74.0 / 全上下文基线 72.9 / Mem0ᵍ 68.4 /
  Mem0 66.9 / Zep 66.0 / LangMem 58.1 `[UNVERIFIED 转述]`。
- **基准本身不可信**：locomo-audit 实测**仅换答案 prompt 就差 10.67pp**；
  LOCOMO 默认评审模型**接受 62.81% 的故意错误答案**；同一题在两家 harness 下
  差约 14pp `[UNVERIFIED 转述]`。

> **本插件采纳**：**自建评测**（`docs/10` 的评测方法章节）：200 轮真实召回集 +
> 陈旧率 + 写延迟 + 投毒用例集，**不用公开榜定位架构**。

---

## 6. 横向对比表

| 系统             | 存储                           | 写管线                                                       | 检索                                                                         | 本地优先                          | 工具面                                                         |
| ---------------- | ------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------- |
| **Mem0**         | 向量库 + SQLite                | 上下文收集→向量召回→单次 LLM 判定→去重→embedding             | 向量 + 实体 boost                                                            | ✅ 需 Ollama 接管 LLM+embedder    | `add/search/update/delete`；MCP `add_memories/search_memory/…` |
| **Zep/Graphiti** | 图库+向量+BM25                 | 8 步 add_episode（每步一次 LLM）                             | 语义+BM25+图遍历；RRF / node-distance / CE                                   | ✅ Kùzu 嵌入式                    | `add_memory/add_triplet/search_nodes/search_memory_facts/…`    |
| **Letta**        | Postgres+pgvector              | agent 自改 + sleep-time 整合                                 | 语义 + 常驻 block                                                            | ✅ 全本地                         | `core_memory_append/replace`、`archival_memory_insert/search`  |
| **LangMem**      | BaseStore                      | manage_memory 薄封装（零去重）                               | 仅语义                                                                       | ✅                                | `manage_memory` + prompt optimizer                             |
| **Cognee**       | SQLite+LanceDB+图库            | add→cognify→memify                                           | graph/chunks 检索                                                            | ✅✅ 零服务                       | Python/CLI/REST/MCP                                            |
| **Hindsight**    | Postgres+pgvector（bank 隔离） | retain 富抽取→observation consolidation                      | **四路→RRF(k=60)→CE→乘性 boost→token 预算**                                  | ✅ pg0 + 本地 BGE/MiniLM          | `retain/recall/reflect` + 每 bank 一个 MCP                     |
| **memU**         | Postgres(+pgvector)            | 资源→记忆项→类别文件                                         | 自顶向下 + 回落                                                              | ⚠️ 需服务                         | 未公开统一 MCP 名                                              |
| **Supermemory**  | 云端闭源                       | 异步管线；`customId` 幂等                                    | hybrid + 丰富 filters                                                        | ❌                                | REST v3/v4                                                     |
| **本插件**       | **Anytype 对象（真源）**       | **agent 裁决，插件确定性写（content_hash 幂等 + 冲突上报）** | **Anytype 全文 + 受控边 + agent 向量 → RRF(k=60) → 乘性 boost → token 预算** | **✅✅ 零本地状态、零服务、零云** | **16 个工具（setup/write6/read5/agent3/diag1）**               |

---

## 7. 采纳清单（逐条可追溯）

| #   | 采纳项                                              | 来源                                 | 落在本插件哪里                                                |
| --- | --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------- |
| 1   | 写事件词表 ADD/UPDATE/DELETE/NONE + 禁止编造 id     | Mem0                                 | `memory_write` 工具描述、`docs/06` §4                         |
| 2   | 双时序 valid_from/valid_to + 失效不删               | Graphiti / Hindsight                 | 属性字典 + `memory_supersede`                                 |
| 3   | 谦逊合并（不覆盖正文、不降置信、只并集 tags/edges） | 官方 anyrt                           | `memory_write` 的冲突契约 + `docs/02`                         |
| 4   | provenance 五件套                                   | Cognee                               | `source`/`source_channel`/`extractor`/`run_id`/`content_hash` |
| 5   | RRF(k=60)                                           | Hindsight / Graphiti                 | `src/recall.ts` `rrfScore`                                    |
| 6   | 乘性 boost（recency/confidence/proof，α=.2/.2/.1）  | Hindsight                            | `src/recall.ts` `finalScore`                                  |
| 7   | token 预算一等公民（只算正文、元数据免费）          | Hindsight                            | `src/recall.ts` `applyTokenBudget`                            |
| 8   | 遗忘 = 衰减 + 归档，不删除                          | MemoryBank / Elephant                | `salience` 属性 + `memory_archive`                            |
| 9   | 零 LLM 的 chunks 抽取档                             | Hindsight                            | `memory_candidates`（`src/chunk.ts`）                         |
| 10  | 工具即记忆管理                                      | Letta / MemGPT                       | 16 个工具的工具面                                             |
| 11  | 记忆是数据不是运行时状态                            | Letta                                | 零本地状态（单测静态断言）                                    |
| 12  | 链接由 LLM 判定、存用户可编辑的库                   | A-MEM                                | `memory_suggest_links`（只建议）+ `memory_link`（裁决后写）   |
| 13  | content_hash 幂等                                   | Supermemory `customId` / Cognee hash | `src/dedup.ts` + `filter` 等值查                              |
| 14  | 来源通道标记 + 佐证计数 + 未佐证降权                | Hindsight Memory Defense / Cognee    | `source_channel` / `proof_count` / boost                      |
| 15  | 自建评测而非公开榜                                  | 基准审计                             | `docs/10` §评测方法                                           |

**明确不采纳**：向量库/图库/常驻服务（与「零本地状态」冲突）、后台自动抽取
管线（语义能力外包给 agent）、自动改写用户 authored 的文本（违反人类控制
边界）、公开 benchmark 作为验收依据（口径不可信）。

---

## 8. 结论

主流系统的共识管线是：

```
write → normalize → extract → resolve(去重/矛盾) → store(+provenance)
     → index(词法/向量/图) → retrieve(多臂) → fuse(RRF) → rerank(可选)
     → inject(token 预算) → decay/forget → audit
```

本插件与它们的差异只有一处，但很关键：**前四步里的一切「判断」都外包给
agent，插件只提供确定性的存储与检索原语**。这不是能力不足，而是刻意的边界
——它让记忆的来源、理由与可撤销性完全可审计，也让它可以在**没有任何模型、
没有任何本地服务**的环境里工作。
