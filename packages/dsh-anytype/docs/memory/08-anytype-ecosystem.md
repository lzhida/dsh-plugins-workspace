# 08 · Anytype 生态与社区方案对照

> **本文回答什么问题**：Anytype 官方与社区已经做了一些「AI 记忆」相关的东西，
> 我们做的这个插件跟它们是什么关系？哪些设计值得抄、哪些坑不必再踩？
> 本插件的差异化定位在哪？
>
> **阅读前置**：[07-memory-systems-review.md](./07-memory-systems-review.md)
> （通用记忆系统怎么做）、[05-anytype-as-source.md](./05-anytype-as-source.md)
> （我们为什么把索引也交给 Anytype）。
>
> **事实标注**：star / 下载量为 2026-10-23 快照；`[UNVERIFIED]` = 未能独立核实。

---

## 1. 一页结论

1. **官方已经把「agent 记忆」做掉了，但做在另一个平台里**。Anytwo / anyrt /
   Bao 的架构里，agent 记忆**就是 space 内一个普通 dataset**
   （`agent_memory_items`），语义模型极完整（category / confidence /
   importance / salience / accessCount / edges / validFrom / entities /
   keywords / provenance），配套 dedup-on-save、auto-recall、chunk 金字塔、
   受控边词表、衰减作业。**但它锁在 Rust anyrt + 受限 CPython 平台内，
   第三方插件无法复用** → 这就是空白。
2. **社区现有 Anytype 工具全是「CRUD 代理」，不是记忆层**。官方 MCP 把
   OpenAPI 转成 52 个工具；`anytype-mind` 最接近但仍无 confidence/去重/衰减/
   自动召回；唯一带向量的是 `wethegreenpeople/anytype-mcp`（ChromaDB + Ollama），
   但**模型在 Anytype 之外**，且向量库成为第二份真源。
3. **语义映射的行业共识已收敛**（ATS adapter contract / obsidian-mind /
   mcp-zettel / axiomind）：note→记忆单元、link/backlink→关联、tag→类别、
   folder/space→作用域、daily note→情节日志、highlight→原子事实、MOC→主题摘要、
   frontmatter/property→字段契约、`urlFor`→溯源指针。
4. **Anytype 数据模型几乎 1:1 覆盖这套映射**（type=类别、property=字段、
   object=单元、space=作用域、relation+backlink=关联边、blocks=内容、
   search scope=命名空间）。**Anytype 是这套映射的天然宿主。**
5. **本插件的定位**：把官方 Anytwo 记忆模型的**语义设计**搬到一个
   **可嵌入 dsh、纯本地、Anytype 为真源**的实现上，向量/LLM 全部外包给
   外部 agent。

---

## 2. 官方 Anytwo / anyrt / Bao 的记忆架构 ★ 最该抄

来源：<https://docs.any.org/agents/memory.html>、<https://docs.any.org/agents/index.html>、
<https://docs.any.org/database/data-model.html>、<https://docs.any.org/search/index.html>

### 2.1 三层存储 + 一层上下文

| 层               | 装什么                                             | 生命周期                  | 位置           |
| ---------------- | -------------------------------------------------- | ------------------------- | -------------- |
| Application data | tasks/documents/contacts                           | 存在 space                | space          |
| **History**      | 原始轮次 + 旧轮次摘要                              | chat 的 log object        | `bao/log/v1`   |
| **Memory items** | 精选事实/偏好/决策/教训                            | agent 的 **brain object** | `bao/brain/v1` |
| Model context    | 指令 + 选中的 history/memory + 当前消息 + 工具结果 | 每次 run 重建             | —              |

> 「A stored record becomes model context only when the harness selects it; a
> fresh run has no Python state and rebuilds its context from these records.」
> ——**记忆即数据，不是运行时状态**。

### 2.2 memory item 字段契约（`agent_memory_items`）

- 必需：`category`（开放 slug：preference/decision/lesson/fact…）、`context`
  （一行事实）
- 可选：`body`、`confidence`（1–10，**用户陈述高于推断**）、`importance`、
  `tags`、`entities`、`keywords`、**`edges`（到其他对象的类型化链接）**、
  `validFrom`
- 派生：`salience`、`accessCount`、`source`、`provenance`、`chatId`、`fromAgent`
- 写策略：`category`/`context`/`entities`/`keywords`/`validFrom` 等 **write-once**，
  其余 author-mutable
- 检索索引：`search { title: context, text: body, scope: "agent" }`

> **本插件的对应**：字段几乎一一落地——`category`→`memory_kind`、`context`→对象
> `name`、`confidence`/`importance`/`salience`/`proof_count`/`access_count`、
> `edges`→5 条受控 relation、`validFrom`→`memory_valid_from`、
> provenance→`source`/`source_channel`/`extractor`/`run_id`/`content_hash`。
> 差别是：官方用「dataset + 隐藏类型」，本插件用「普通对象类型 + 属性字典」，
> 因为 API v2 只能操作普通对象（datasets 属于新平台）。

### 2.3 Dedup on save（保存即去重）★

1. 先对 scope=agent 跑 recall；
2. **便宜的 classify-tier judge** 判定「同一条事实？」；
3. 三选一：**merge**（演进已有）/ **supersede**（新建 + `supersedes` 边）/
   **create**；
4. 合并「谦逊」：机器候选**永不覆盖已存文本、永不降低 confidence，只并集
   tags/edges**；
5. **无相似度阈值**，judge 说了算。

> **本插件的对应**：`memory_write` 的 conflicts[] 上报 + agent 裁决 +
> 「不覆盖正文/不降置信」的硬约束（`docs/02` 不变量清单）。差别：官方由**后端
> judge** 自动做三态判定；本插件**只上报候选**，把裁决留给 agent（因为插件
> 不跑模型）——语义同构，执行位置不同。

### 2.4 Auto-recall（自动召回）★

> 「Prompt guidance alone does not produce memory behaviour… So recall is
> structural.」

- 每轮开头自动 `recall.search(user_message)`（**索引支撑、零模型调用**），
  注入 top hits；
- 注入被**伪装成一次合成的 `run_cell` 调用**——「**evidence the model weighs
  and can discount as stale, not prompt truth**」；
- 渲染：记忆命中 = 蒸馏事实 + 来源日期 + 置信度；
- 三道 guard：boot window 内命中跳过 / 相关性阈值 / 每次注入记入
  `agent_roi_injections`。

> **本插件的对应**：召回结果带 `confidence` / `origin` / `updated_at`，
> guidance 明确要求 agent 把记忆当**证据**而非真理。差别：本插件不做
> 「自动注入」（注入时机属于 agent 会话层，不属于插件职责），只保证召回
> 结果的**可折价元数据**齐全。

### 2.5 History：turns + chunk 金字塔

- `agent_turns`：append-only，客户端分配 `seq`；`searchText`(=userText+replies,
  scope=history)
- `agent_chunks`：`seq`、`level`(1 over turns, 2+ over chunks)、`fromSeq/toSeq`、
  `summary`、`periodStart/End`、`unitsCovered`
- `rollup@v1`（每小时 cron）：10 turn 批 → L1；10 L1 → L2；**L2 只由子摘要
  构建**；同级 chunk **连续不重叠**，每摘要保留指向所覆盖内容的显式指针
- boot window 是 token-budgeted 金字塔，**约 11% 记录开销**

> **本插件的对应**：`memory_candidates` 的确定性切块（`src/memory/chunk.ts`）是
> 「零 LLM 抽取档」的同源设计；但**不做后台 rollup 定时作业**（本版不做，
> 见 `docs/10` 的「本版不做」）。

### 2.6 后台维护作业

| Program         | 调度    | 行为                                                                                            | 官方默认 |
| --------------- | ------- | ----------------------------------------------------------------------------------------------- | -------- |
| `extraction@v1` | 15 分钟 | 对新 turn 只**提议**稳定事实，经 dedup judge 落库，provenance 带 fromSeq，**confidence 上限 6** | on       |
| `rollup@v1`     | 小时    | chunk 金字塔                                                                                    | on       |
| `linkgen@v1`    | 小时    | seed-search 找邻居，classify-tier 从**受控词表**提议类型化边；**never invents edge types**      | on       |
| `evolution@v1`  | 6 小时  | 依邻居刷新 context/tags                                                                         | **off**  |
| `reflection@v1` | 天      | 把从未被召回的 cluster 综合成 insight，标记矛盾                                                 | **off**  |
| `decay@v1`      | 天      | **salience 按空闲半衰期减半，永不删除**                                                         | **off**  |

> **本插件的对应**：受控边词表 ✅、salience 衰减语义 ✅（属性存在，作业待做）、
> 「从未被召回的 cluster → 矛盾标记」→ 本插件的 `memory_stats` 提供
> `unresolved_conflicts` 与 `access_top` 作为**观测面**，由 agent 决定是否
> 触发巩固。**官方自己都把后三个作业默认关闭**——本插件同样不做自动作业，
> 是一致的保守选择。

### 2.7 数据可携带性（官方卖点，也是本插件的立身之本）

> 「the memory is a dataset in your encrypted space, not a vendor's RAG store.
> You can query it, subscribe to it, audit what the extractor saved and from
> which turn, and delete an item with a normal record delete.」

→ 本插件把这条推到极致：**连 sidecar 都没有**（零本地状态），记忆就是用户
空间里的普通对象，删改导出全走 Anytype 自己的机制。

---

## 3. 官方 MCP / runtime / skill 系

| 项目                                                                         | 做什么                                                                                                                                                                                                                         | 对本插件的结论                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [`@anyproto/anytype-mcp`](https://github.com/anyproto/anytype-mcp)           | 把 OpenAPI 动态投影成 MCP 工具（v2 快照约 52 个）；启动时加载一份 spec（先 `/v2/docs/openapi.json`，404/410 回退 v1）；**无自动重试**；**全局 Idempotency-Key 头被拒**                                                         | 印证「工具面应从 spec 动态生成」；本插件选择**手写记忆语义工具**而非全量投影，因为记忆需要参数引导与冲突裁决语义                    |
| [`anytype-agent-runtime`](https://github.com/anyproto/anytype-agent-runtime) | Go **Sobek** JS 引擎（**仅同步**、ESM）；从 Anytype 对象解析模块（`"helper@v1"`）；完整副作用 trace + mock 回放；内置 `cosineSimilarity` 原语                                                                                  | 「agent 写程序而不是逐次 tool call」是另一种交互范式；dsh 侧已有更强的 PTC/工作流能力，不必重复造                                   |
| [`anytype-agents-skill`](https://github.com/anyproto/anytype-agents-skill)   | 官方 Agent Skill（`AGENTS.md` + `anytypeHelper.js`，约 30 个 helper 方法）；规则值得抄：**always use helper methods, never call fetch directly**；**check existing types before creating one**；**never hardcode credentials** | ✅ 本插件的三条对应纪律：helper 层统一拼端点（`src/memory/store.ts`）、bootstrap 先盘点再补（`planBootstrap`）、apiKey 只在设置面板 |

---

## 4. 第三方项目

| 项目                                                                                                                                          | 活跃度           | 做什么                                                                                                                                                      | 对本插件的结论                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [anytype-mind](https://github.com/imcvampire/anytype-mind)                                                                                    | 28★              | 「给 AI 助手的有结构大脑」：12 个对象类型 + relation 连接 + 5 个 lifecycle hook + 14 slash command                                                          | **最接近的社区项目**；其类型化对象 + relation 当关系图 + hook 做生命周期注入值得借鉴；**缺 confidence/去重/衰减/自动召回**——这正是本插件补的  |
| [Anytype Toolbox](https://github.com/stevelr/anytype)                                                                                         | 34★              | 统一二进制 `anyr`：spaces/objects/types/properties/files/chats、Markdown 编辑、导出/恢复备份、workflow 导向 MCP；**REST 优先 + gRPC 补齐**；Skills 三件套   | 「folder 分目的、link 分意义」；**权限诚实**——Anytype 只有 space 级 Reader/Writer/Owner，**无对象级权限**（本插件的记忆边界因此只能到 space） |
| [anytype-mcp（RAG 版）](https://github.com/wethegreenpeople/anytype-mcp)                                                                      | 18★              | **唯一自带向量库**：语义搜索 + 自动分块 + 完整元数据；ChromaDB + Ollama `mxbai-embed-large`；challenge 认证；`clear_ingestion` → 索引可重建                 | 证明「向量索引可重建」；但**模型在 Anytype 之外**、向量库成第二份真源——本插件改为**向量存 Anytype 属性**（真源唯一）                          |
| [anytype-mcp-plus](https://community.anytype.io/t/anytype-mcp-plus-v1-1-0-enhanced-mcp-server-with-34-tools-bug-fixes-and-api-research/30466) | npm 仅 3 下载/月 | 34 工具的 CRUD 代理                                                                                                                                         | 事实上已死；纯 CRUD 无记忆语义                                                                                                                |
| [anywrite](https://github.com/Antheurus/anywrite)                                                                                             | —                | 覆盖全部 52 端点的单二进制 CLI；**数据驱动端点注册表**（API 演进改数据不改代码）；agent-first（JSON 默认、逐字错误信封）；打通内部 gRPC 做真 block 内联图片 | 「数据驱动注册表」是 API 漂移的好解法；本插件采用**运行时自省**思路（`memory_doctor` 能力探测）                                               |
| [AnytypeCapture](https://github.com/ebanDev/AnytypeCapture)                                                                                   | 15★              | 「second brain 捕获器」：把想法丢进 Anytype                                                                                                                 | 快速捕获思路；无记忆语义                                                                                                                      |
| obsidian→anytype / anytype→obsidian 转换器                                                                                                    | 48★ / 4★         | 只做**语法**转换（wiki-link→md link、folder→index 文件）                                                                                                    | 社区已在写「进」和「出」两个方向的转换器，但**没有人在中间做语义映射**                                                                        |
| [anytype-mcp-remote-gateway](https://github.com/ivantacca/anytype-mcp-remote-gateway)                                                         | 4★               | 把 stdio-only 官方 MCP 暴露成远程 HTTP（OAuth 2.1 + Tailscale Funnel）                                                                                      | 说明「移动端/网页端连本地 Anytype」是真实需求；dsh 侧不重复造                                                                                 |

---

## 5. 跨系统借鉴（非 Anytype，但同题）

| 项目                                                                                                | 关键洞见                                                                                                                                                                                                                                                                                    | 本插件的采纳                                                                                                                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ATS（Agentic Task System）](https://github.com/renezander030/agentic-task-system) adapter contract | 「**Adapter, not migration**」：源系统永远权威，缓存与向量索引是派生状态；**稳定 ID**（去重与溯源的前提）；**`urlFor` 深链**（每个记忆单元能一键跳回原文）；`modifiedTime` 是缓存失效的唯一依据；`links` 只读                                                                               | 稳定 ID → Anytype 对象 id ✅；深链 → Anytype 对象 URL ✅；「源系统权威」→ 本插件零 sidecar ✅；「embeddings 缺失时不偷偷启动服务」→ 本插件零模型 ✅ |
| [obsidian-mind](https://github.com/breferrari/obsidian-mind)                                        | 「**Folders group by purpose. Links group by meaning.**」「**A note without links is a bug**」「**Procedural code owns the environment. The agent owns content.**」；vault-first memory（耐久知识在主题笔记，`MEMORY.md` 只是索引）；**无索引也不坏**（退化为词法匹配，排序变差但不丢东西） | 受控边词表 ✅（链接有意义）；「无索引不坏」→ 本插件根本没有索引 ✅；程序性判定归插件、语义判定归 agent ✅                                           |
| [axiomind](https://github.com/breferrari/axiomind)                                                  | 最小分类法 Observation / Principle / Axiom / Area / Project / Resource / MOC；**原始笔记不可变**、diff-first ingest、**人审后激活**、渐进披露                                                                                                                                               | 原始笔记不可变 → 本插件「状态流转不改写正文与 content_hash」✅；人审后激活 → `draft` 态 ✅                                                          |
| [mcp-zettel](https://github.com/mrueb/mcp-zettel)                                                   | Zettelkasten as agent memory；`zettel://graph`（Mermaid 全图）；**双向链接是推导的不是存储的**（读取时扫正文找 `[[target_id]]`）                                                                                                                                                            | 关系由内容推导 → 本插件关系由**受控属性**显式存储（Anytype relation 有原生双向 + backlinks，故无需推导）                                            |
| [basic-memory](https://github.com/basicmachines-co/basic-memory)                                    | 本地优先 Markdown+SQLite，专治「AI 每次都要重讲项目背景」                                                                                                                                                                                                                                   | 问题陈述与本插件一致；本插件进一步做到零 SQLite                                                                                                     |
| [second-brain](https://github.com/)                                                                 | 「**Files are truth. Agents are clients. Indexes are replaceable.**」canonical store 是 Markdown Bundle，SQLite 只是可丢弃索引；**写是成对的**（先 flush 权威存储再报成功，锁 + receipt + crash journal）                                                                                   | 「先写真源再报成功」→ 本插件的写路径顺序 ✅（Anytype 先写成功才回执）                                                                               |

---

## 6. 语义映射模式（行业已收敛的 16 条）

1. 记忆单元 = 源系统原生单元（note/page/object），不另造一套；源系统保持权威
2. 稳定 ID（跨会话跨设备稳定）→ 去重、溯源、幂等都依赖它
3. 作用域 = 容器（folder/database/**space**/bundle root → project）
   ⚠️ **Anytype 的 collection ≠ 文件夹**（叠加属性组），真正作用域是 space
4. 关联 = 双向边；Anytype 原生双向且 backlink 自动生成（天然优势）
5. 类别 = 标签/multi_select
6. 情节日志 = 时间键控容器（daily note / journal page）
7. 原子事实 = 最小可独立引用单元（highlight / zettel / Logseq block / 一个 memory object）
8. 主题摘要 = MOC/index/集合视图（导航层与细节层分离）
9. 类型化字段契约（frontmatter/property schema）——记忆条目要有**稳定字段集**
10. 时间锚与有效期（validFrom/validTo/createdAt）；支持按时间窗检索
11. 溯源深链：每个记忆单元能一键跳回原文
12. 混合检索 + RRF（关键词 + 稠密向量）
13. 索引可重建、源为权威
14. 人审闸门：agent **提议**事实，人 ratify
15. 可审计 + 自度量（provenance、access_count、注入日志、可 undo 的写）
16. （Anytype 特有）渐进披露：raw → 摘要 → 精要，按 token 预算降分辨率取用

---

## 7. Gap 清单（社区还没做的）与本插件的落点

| #   | Gap                                                                                                                               | 本插件是否补上       | 补法                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------- |
| 1   | 社区没有任何 Anytype 侧的「记忆条目」模型（无 category/confidence/salience/edges/provenance）                                     | ✅                   | `memory` 类型 + 30 项属性字典（`docs/02`）                                                    |
| 2   | 没人实现 dedup on save（merge/supersede/create 三态 + 谦逊合并）                                                                  | ✅（裁决位置不同）   | content_hash 幂等 + conflicts[] 上报 + agent 裁决                                             |
| 3   | 没人实现 auto-recall（带 provenance/confidence 的自动注入）                                                                       | 部分                 | 插件提供带元数据的召回面；**注入时机属 agent 会话层**                                         |
| 4   | 没人实现 chunk 金字塔 rollup                                                                                                      | ❌（本版不做）       | `memory_candidates` 提供了零 LLM 切块原语；rollup 留后续                                      |
| 5   | 没人实现受控边词表 + 自动连边                                                                                                     | ✅                   | 5 条受控 relation + `memory_suggest_links`（只建议）                                          |
| 6   | 没人实现 salience 衰减 / access_count 自度量                                                                                      | 部分                 | 属性与统计面 ✅；衰减作业 ❌（本版不做）                                                      |
| 7   | 没人把「提取→去重→链接→演化→反思→衰减」做成可开关作业流水线                                                                       | ❌（本版不做）       | 由 agent 侧 SOP 自行编排                                                                      |
| 8   | ATS adapter 家族没有 Anytype adapter                                                                                              | 部分                 | 本插件就是事实上的 Anytype adapter，但未实现 ATS 的 `urlFor` 契约（Anytype 有对象 URL，够用） |
| 9   | 桌面端本地 API **只有全文搜索，没有向量搜索**                                                                                     | ✅（补偿）           | 向量存 Anytype 属性 + agent 提供查询向量 → 本地余弦                                           |
| 10  | Anytype **没有可执行的扩展市场**（只有 types/relations/templates 的 Gallery）                                                     | —                    | 分发靠 dsh 插件生态（与 MCP/Skill/CLI 并列的第四条路）                                        |
| 11  | 只有 space 级权限，**无对象级权限**                                                                                               | —                    | 记忆边界只能到 space；插件不做权限系统                                                        |
| 12  | anytype-cli 在 Windows 上 `auth create` 触发堆损坏静默退出（[上游 issue #63](https://github.com/anyproto/anytype-cli/issues/63)） | —                    | 无头后端在 Windows 当前不可用；本插件只依赖桌面端 31009                                       |
| 13  | `memory item` 的 `searchText` 只索引 context 与 body                                                                              | ✅（我们自建字段表） | 本插件把 `name`/`body` 之外的关键字段显式建成属性，并交给 `fields` 投影参与检索               |

---

## 8. 定位声明

> **本插件不是「又一个 Anytype MCP」，而是 Anytype 之上的记忆语义层。**
>
> 官方 MCP 把 API 暴露成工具；`anytype-mind` 把对象组织成工作结构；
> 社区 RAG 版把向量库搬进 Anytype 旁边。
> **本插件把「记忆该长什么样」这件事做实**：一条记忆有 kind、有状态、有
> 置信、有佐证、有来源、有双时序、有受控边、有内容哈希、有访问计数——
> 并且这一切**只存在于用户自己的 Anytype 空间里**，不依赖任何模型、任何
> 向量库、任何云服务；而抽取、裁决、嵌入这些「智能」的部分，通过 16 个
> 工具接口交给外部 agent 自行调用与优化。
