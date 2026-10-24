# 05 · Anytype 就是索引

> **本文回答什么问题**
>
> 1. 为什么**删掉**原计划中的本地 SQLite 索引——Anytype v2 到底已经替我们做了哪些活；
> 2. 删除后，召回（recall）如何在「Anytype 全文检索 + agent 自带向量 + 原生关系」三条臂上完成，融合公式是什么；
> 3. 幂等、去重、冲突、取代、状态机这几套语义各自怎么定义、边界在哪。
>
> **阅读前置**
>
> - `04-tool-api.md`：16 个工具的参数与返回契约（本文的算法都落在这些工具里）；
> - `06-llm-vector-delegation.md`：为什么向量必须由 agent 提供、插件不跑模型；
> - `packages/dsh-anytype/README.md`：Anytype v2 的 `filter` / `fields` / `dry_run` / `Idempotency-Key` 语义与活体实测结论；
> - 本文所有「实测」结论均来自 **2026-10-23** 的活体探测（Anytype 桌面端运行中，`http://127.0.0.1:31009`，pre-release v2 API）。

---

## 1. 结论先行

> **Anytype 空间同时是「真源（source of truth）」和「索引（index）」。**
> 插件因此不需要 SQLite、不需要本地文件、不需要本地向量库——**零本地状态**。

原来规划的本地索引里有 6 个组件，现在只剩 1 个（向量）还留在插件进程内存里，而且**不落盘**。

| 原计划组件                                      | 处置                 | 由谁承担                              | 依据           |
| ----------------------------------------------- | -------------------- | ------------------------------------- | -------------- |
| SQLite `memories` 表                            | **删除**             | Anytype `memory` 对象                 | 对象类型即记录 |
| SQLite FTS5 全文索引                            | **删除**             | Anytype `POST /v2/spaces/{id}/search` | 实测 ①         |
| 本地过滤层（kind / status / confidence / 时间） | **删除**             | Anytype `filter` 紧凑语法             | 实测 ②         |
| 本地排序层                                      | **删除**             | Anytype `sorts`                       | 实测 ③         |
| 本地 links 镜像表 + 图遍历                      | **删除**             | 原生 `links` / `backlinks`            | 实测 ④⑤        |
| 本地向量索引（sqlite-vec 之类）                 | **降级为进程内计算** | 插件内存中的余弦计算                  | 实测缺口 ②     |

---

## 2. 活体实测证据（2026-10-23）

### 2.1 探测环境与方法

| 项       | 值                                                                                             |
| -------- | ---------------------------------------------------------------------------------------------- |
| 被测端   | Anytype 桌面端内置本地 API（anytype-heart），pre-release **v2**                                |
| 地址     | `http://127.0.0.1:31009`                                                                       |
| 鉴权     | `GET /v2/auth/whoami` → 200，`grant.permission = read_write`                                   |
| 目标空间 | `GET /v2/spaces` → 可见空间（短引用 id，形如 `64xiwe`）                                        |
| 方法     | 直接以 `curl` 调 v2 端点；写操作一律 `?dry_run=true`；探测前后复核空间内对象/类型/属性总数未变 |

### 2.2 能力对照表

| 能力                                                                         | 实测结果                                                                                                                         | 替代了本地索引的哪一部分                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **全文检索**<br>`POST /v2/spaces/{id}/search` body `{"query":"Get Started"}` | **200**，`total=6`，`has_more=true`，rows **有序**返回                                                                           | **SQLite FTS5 正文索引**——连「相关度排序」都由服务端给出有序 rows                                                                                                                                    |
| **结构化过滤**<br>`filter` 紧凑串                                            | `status IN ("Done")` → **200, total=0**；`type = "page"` → **200, total=13**；`backlinks IS NOT EMPTY` → **200, total=17**       | **按 kind / status / confidence / 时间收窄的本地过滤层**——比较、`IN`、`CONTAINS`、`HAS ALL`、`IS [NOT] EMPTY`、`EXISTS`、`type` 伪键、日期预设（`today()` / `currentWeek()` / `daysAgo(7)`）一应俱全 |
| **排序**<br>`sorts:[{property:"last_modified_date",direction:"desc"}]`       | **200, total=20**，按 `last_modified_date` 降序                                                                                  | **本地排序层**——任意属性键都能排，不必预先建索引                                                                                                                                                     |
| **关系投影**<br>`fields=links,backlinks`                                     | 200，**行内**投影出对象 id 数组（`links` / `backlinks` 均以 id 数组形式出现）                                                    | **本地 links 镜像表 + 图遍历**——Anytype 链接**原生双向**，出边入边一次投影取回                                                                                                                       |
| **属性清单**<br>`GET /v2/spaces/{id}/properties`                             | **200，41 个属性**，其中含 `links(objects)` 与 `backlinks(objects)`                                                              | **本地 schema 元数据表**——关系是原生 objects 类属性，不是插件自造的边表                                                                                                                              |
| **单属性读取**<br>`GET /v2/spaces/{id}/properties/{key}`                     | **404**（该构建上单属性 GET 不可用，只能 list）                                                                                  | **工具实现约束**——所有属性信息必须走一次列表请求，`memory_doctor` / `memory_setup` 都按此实现                                                                                                        |
| **身份与授权**<br>`GET /v2/auth/whoami` + `GET /v2/spaces`                   | **200**，`grant.permission = read_write`；空间列表返回**短引用 id**（如 `64xiwe`）                                               | **本地空间 id 映射表**——id 直接来自服务端，短引用形式可安全放进工具参数                                                                                                                              |
| **分页**                                                                     | `?offset=&limit=`，默认 25、上限 1000                                                                                            | **本地分页实现**——服务端原生分页                                                                                                                                                                     |
| **并发控制**                                                                 | 读对象返 `ETag` 头 + body `etag` 字段；`If-Match` 不符 → **409**                                                                 | **本地乐观锁表**——etag 由服务端发放                                                                                                                                                                  |
| **写幂等**                                                                   | `Idempotency-Key` 头：同 key 同 body 重放；同 key 换 body → **409 `idempotency_conflict`**；`?dry_run=true` 预演 200 vs 真实 201 | **本地去重表**——幂等由服务端承担，插件只负责透传 key                                                                                                                                                 |

### 2.3 三条**缺失**能力与补偿方案

| 缺口                       | 事实                                                                                                              | 补偿方案                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ① **无相关度分数**         | search 响应里**没有** `_score` 之类的字段，只有**有序的 rows**                                                    | 用 **rank 代替 score**：RRF 只吃名次不吃分数（§5.4）。「有没有分数」根本不重要，「有没有顺序」才重要——实测 rows 是有序的                                                                 |
| ② **无向量检索与存储**     | 桌面端 v2 API **完全没有**向量端点：既不能存向量，也不能查最近邻                                                  | 向量由 **agent 生成**，以 base64(Float32) 存进记忆对象的 `memory_embedding` text 属性；插件在**进程内**算余弦（§5.2）。见 `06-llm-vector-delegation.md` §3                               |
| ③ ~~**中文分词质量未知**~~ | **已实测证伪（2026-10-23）**：中文短语能命中对象，**标题与正文都参与索引**（但**生僻词不可靠**，见 §2.4 第 7 条） | **中文全文检索可用** ✅。此前担心的「中文分词失效」不成立——SQLite FTS5 的 `unicode61` 对中文失效是事实，但 Anytype 桌面端自己的检索不走那条路。留下的真问题是**索引最终一致**（见 §2.4） |

> 缺口 ② 是本设计**最重要**的一条：它决定了「插件不跑 embedding 模型、向量由 agent 提供」这条根本约束（`06-llm-vector-delegation.md` §1）。

### 2.4 2026-10-23 追加实测结论（本次对齐的核心）

> 以下结论来自 **真实 Anytype 桌面端 v2 API**（`Anytype-Version: 2025-11-08`，
> `http://127.0.0.1:31009`），是单元测试抓不到、只有真机才暴露的问题。
> 第 7 / 8 条（中文检索与索引一致性）在 **2026-10-24** 又做了一轮细化——
> 探针改用**常用词**并加入 **ASCII 双探针**（见下）。

| #   | 结论                                                                                                                        | 机制解释                                                                                                                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **插件属性显示名必须带 `Memory ` 前缀**                                                                                     | 空间自带 41 个内置属性（`origin(number)`、`source(url)`、`status(select)`、`tag(multi_select)`、`links`/`backlinks(objects)`、`assignee`、`creator`、`due_date`、`done`…）。朴素显示名 → **同名不同格式** → 服务端 400 `property format conflict`（issues 指到 `/type_properties/N/format`）。**唯一例外是 `tag`**：直接复用内置 `tag(multi_select)` |
| 2   | **记忆类型的布局必须是 `basic`，不能用 `note`**                                                                             | `note` 布局下快捷创建体（`{type, name, markdown}`）的 `name` 被当成**正文块**：对象 `properties.name` 为空、正文多出一段，**标题能力直接丢失**。`basic` / `todo` / `bookmark` 均保留标题                                                                                                                                                             |
| 3   | **类型的字段表 = 类型文档 `blocks[0]`（dataview）的 `properties[]`**                                                        | 属性不在字段表里 → **会被存储并随对象返回，但按类型过滤/查询时该键被拒绝**（服务端原话："the value is stored and served on the object, but type-scoped search and queries over X refuse the key"）。故 bootstrap 必须 `add_property` 进类型                                                                                                          |
| 4   | **`add_property` op 只认 `property`（key）+ `format`**，不认 `name`                                                         | 传 `name` 报 `json: unknown field "name"`；空间里已存在同名属性时应**省略 `format`** 沿用既有定义并告警                                                                                                                                                                                                                                              |
| 5   | **紧凑类型列表接口读不到字段表**                                                                                            | `GET /v2/spaces/{id}/types` 只给类型自身属性（name / creator / …），字段表必须逐个读类型文档                                                                                                                                                                                                                                                         |
| 6   | **建类型会顺带铸造属性**                                                                                                    | `POST /types` 带 `property_definitions` 会把字段铸成空间属性。故 bootstrap 建完类型**必须重新盘点属性**再决定要不要补建，否则撞 `property key already exists`                                                                                                                                                                                        |
| 7   | **中文全文检索可用** ✅（**对常用词**）                                                                                     | 中文短语（如「持久记忆」「索引全部交给」「拒绝」）能命中对象；**标题与正文都参与索引**。但**生僻词/未登录词不可靠**：用生僻词做探针时，对象**已进索引**（同对象的 ASCII 标记可命中）而中文短语搜不到 → 探针必须用**常用词**                                                                                                                          |
| 8   | **全文索引是最终一致的**                                                                                                    | 刚创建的对象**搜不到**，实测约 **3～6s** 后才可被检索命中，且偶发更久。故中文自检必须**轮询重试**（最多 8 次、每次间隔 1500ms，返回 `attempts` 与 `latency_ms`），并用**双探针**（中文短语 + ASCII 标记）把「索引滞后」与「中文分词对该词不可靠」分开（`verdict` 三态）                                                                              |
| 9   | **relation 过滤被服务端接受但匹配不到行**                                                                                   | 用真实对象 id 做 `memory_relates_to IN ("<id>")` 过滤 → 请求 200 但 `total=0`。故关系臂的**兜底**是投影原生 `links` / `backlinks`，把邻居 id 作为 `related_ids` 返回                                                                                                                                                                                 |
| 10  | **对象标题在 `properties.name`**                                                                                            | 对象文档（`GET /objects/{id}`）**没有顶层 `name` 字段**，标题在 `properties.name`                                                                                                                                                                                                                                                                    |
| 11  | **同一 etag 只能写一次**                                                                                                    | 连续两次 PATCH（即便都带同一个 `If-Match` etag）第二次必 409 `etag_mismatch`。故 `memory_supersede` 把 `memory_valid_to` 与 `memory_status=superseded` **合并进同一个 `set_properties` op**                                                                                                                                                          |
| 12  | **删除受限**                                                                                                                | `DELETE /objects/{id}` 只对本 API key 创建的对象有效（否则 403 `not_created_by_this_key`）→ 记忆条目一律 `status=archived`；**空间没有 DELETE 端点**（HTTP v2 无 space 删除）→ 测试空间只能人工在 Anytype 里删                                                                                                                                       |
| 13  | **属性值形状**                                                                                                              | 列表型键（select / multi_select / objects / files）取**数组**（选项名或对象 id），标量型键（text / number / date / checkbox）取标量；`set_properties` 的 `set` 同此语义，`add` / `remove` 仅对列表型键有效                                                                                                                                           |
| 14  | **未知属性键 → 400**（并列出已知键 + "did you mean"）；**未知 select 选项名 → 400**（除非带 `create_missing_options=true`） | 故**受控词表不开** `create_missing_options`（拼错即报错），**开放词表（`tag`）才开**                                                                                                                                                                                                                                                                 |

> 缺口 ② 是本设计**最重要**的一条：它决定了「插件不跑 embedding 模型、向量由 agent 提供」这条根本约束（`06-llm-vector-delegation.md` §1）。

---

## 3. 目标架构

### 3.1 拓扑

```
        agent（自带 LLM / embedding）                Anytype 桌面端（127.0.0.1:31009）
   ┌────────────────────────────────┐            ┌─────────────────────────────────────┐
   │  抽取 / 裁决 / 生成向量          │            │  空间 "Agent Memory"                │
   │  （LLM 在 agent 侧，不在插件里） │            │  ├ type: memory      ← 记忆本体      │
   ├────────────────────────────────┤            │  ├ type: memory_scope ← scope 维度   │
   │  插件 dsh-anytype-memory         │  HTTP/JSON │  ├ 全文索引（内置）                  │
   │  ├ HTTP 客户端（仅 127.0.0.1）    │ ─────────► │  ├ filter / sorts（内置）            │
   │  ├ 融合与打分（进程内，不落盘）   │ ◄───────── │  └ links / backlinks（原生双向）      │
   │  └ 16 个 memory_* 工具           │            └─────────────────────────────────────┘
   └────────────────────────────────┘
              ✗ 无 SQLite   ✗ 无本地文件   ✗ 无本地向量库   ✗ 无后台任务
```

### 3.2 「零本地状态」的含义

| 不做           | 具体表现                                                                               |
| -------------- | -------------------------------------------------------------------------------------- |
| 不建 SQLite 库 | 磁盘上没有 `.db` / `.sqlite` 文件；卸载插件即彻底移除                                  |
| 不写本地文件   | 没有 cache 目录、没有 JSON 快照、没有日志落盘（`importance` 等运行态只存在于返回值里） |
| 不建本地索引   | 没有倒排索引、没有 HNSW、没有向量文件                                                  |
| 不做后台轮询   | 没有定时任务、没有 watch 循环——**任何写入都必须由一次工具调用显式触发**                |

代价是明确的：**每次召回都要走 HTTP**，而 Anytype 持续限速 **1 req/s**（突发 60）。这直接决定了 §5.8 的「≤3 次往返」预算。

### 3.3 与「本地 SQLite 方案」的逐项对照

| 关注点     | 本地 SQLite 方案（已废弃）         | Anytype 真源方案（现行）                               |
| ---------- | ---------------------------------- | ------------------------------------------------------ |
| 数据一致性 | 双写（SQLite + Anytype），必然漂移 | **单写**，不存在漂移                                   |
| 全量检索   | 自建 FTS5 + 分词器（中文还得另配） | 服务端检索（本项目 `[待活体验证]` 中文分词质量）       |
| 关系图     | 自建边表 + 自己遍历                | 原生双向链接                                           |
| 权限       | 自己实现                           | 服务端 `grant`（`read_write`）                         |
| 并发       | 自己实现 etag                      | 服务端 etag + `If-Match`                               |
| 幂等       | 自己实现去重表                     | 服务端 `Idempotency-Key`                               |
| 删除       | 自己实现软删                       | 归档（不删）                                           |
| 运维       | 迁移、备份、损坏                   | **无**（数据在用户自己的 Anytype 里）                  |
| 召回延迟   | 本地微秒级                         | **HTTP 往返 × 限速**——故有 §5.8 预算与 §5.7 token 预算 |

---

## 4. 记忆对象模型（Anytype 侧）

| 维度           | 内容                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 主类型         | `memory`（layout **`basic`**）——**一条记忆 = 一个 Anytype 对象**。`note` 布局会把标题吞成正文块，故不用                               |
| 辅助类型       | `memory_scope`（layout `basic`）：`scope_kind` select(`project`/`agent`/`user`)、`scope_key` text                                     |
| 分类           | `memory_kind` select：`fact` / `decision` / `preference` / `lesson` / `procedure` / `episode` / `summary` / `entity`                  |
| 状态           | `memory_status` select：`draft` / `approved` / `disputed` / `superseded` / `archived`                                                 |
| 来源           | `memory_origin` select：`agent` / `user`；`memory_source_channel` select：`user` / `tool` / `web` / `agent`                           |
| 归属           | `memory_scope` → objects(`memory_scope`)                                                                                              |
| 溯源           | `memory_source` → objects（这条记忆的来源素材）                                                                                       |
| 受控关系       | objects(`memory`)：`memory_relates_to` / `memory_derived_from` / `memory_contradicts` / `memory_supersedes` / `memory_mentions`       |
| 时间           | `memory_valid_from` / `memory_valid_to` / `memory_observed_at` / `memory_created_at`                                                  |
| 数值           | `memory_confidence` / `memory_importance` / `memory_salience` / `memory_proof_count` / `memory_access_count` / `memory_embedding_dim` |
| 标签           | `tag` multi_select（**复用内置属性**，不另造 `memory_tag`）                                                                           |
| 指纹与来源标记 | `memory_content_hash` / `memory_idempotency_key` / `memory_extractor` / `memory_run_id`（text）                                       |
| 审核审计       | `memory_reviewed_by`（text）/ `memory_reviewed_at`（date）                                                                            |
| 向量           | `memory_embedding`（text，base64(Float32)）/ `memory_embedding_model`（text）/ `memory_embedding_dim`（number）                       |

> **命名纪律**：插件自有属性一律用 `Memory ` 前缀的显示名（key 派生为 `memory_*`），
> 否则会与空间内置属性（`origin(number)` / `source(url)` / `status(select)` …）撞
> 「同名不同格式」→ 400 `property format conflict`。**唯一例外是 `tag`**——直接复用
> 内置的 `tag(multi_select)`。

> 关系属性是 **objects 类**，Anytype 原生双向：设了 `memory_relates_to` 之后，对方的
> `backlinks` 里就会出现你——**不需要插件维护反向边**。也正因为它是原生双向，
> 关系臂在「按 id 过滤失效」时可以直接投影 `links` / `backlinks` 取邻居。
>
> 但**关系属性必须挂进类型的字段表**（`add_property`）——不在字段表里的属性
> 「会被存储并随对象返回，但按类型过滤/查询时该键被拒绝」。

---

## 5. 三臂召回设计

一次 `memory_recall` 同时跑三条臂，产出候选并集后融合。

### 5.1 lexical 臂（Anytype 全文检索）

```
POST /v2/spaces/{id}/search
```

```json
{
  "query": "<query>",
  "filter": "memory_kind IN (\"fact\") AND memory_status IN (\"approved\")",
  "sorts": [{ "property": "memory_created_at", "direction": "desc" }],
  "fields": [
    "name",
    "memory_kind",
    "memory_status",
    "memory_origin",
    "memory_confidence",
    "memory_importance",
    "memory_proof_count",
    "memory_salience",
    "memory_access_count",
    "memory_created_at",
    "memory_valid_from",
    "memory_scope",
    "memory_source",
    "memory_content_hash",
    "links",
    "backlinks"
  ]
}
```

- 服务端返回**有序 rows**——名次即信号；
- `fields` 是**投影（加内容）不是裁剪**，所以这里只点名需要的属性，避免响应膨胀；真正的体积控制靠 `filter` + `limit`；
- 没有 `query` 时退化为「纯结构化召回」：`filter` 里用 `memory_kind` / `memory_status` 收窄；
- **属性 key 写错了就会被服务端拒绝**——因为属性必须挂在类型的字段表里（见 §2.4 第 3 条）。

### 5.2 vector 臂（agent 向量 + 进程内余弦）

| 步骤 | 做法                                                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 存   | agent 生成向量 → `memory_set_embedding` 写入对象的 `memory_embedding`（base64 of Float32Array）、`memory_embedding_model`、`memory_embedding_dim` |
| 取   | `POST /v2/spaces/{id}/search`，`fields` 投影 `memory_embedding,memory_embedding_model,memory_embedding_dim`，**每次请求最多 20 行**（批次上限）   |
| 筛   | 候选的 `memory_embedding_model` / `memory_embedding_dim` 与本次 `query_vector` 不一致 → **直接排除**（不同向量空间混用会静默污染结果，绝不容错）  |
| 算   | 插件在进程内解码 base64 → `Float32Array` → 余弦相似度                                                                                             |
| 排   | 余弦值作为该臂的 relevance（线性可比，直接进 boost 公式）                                                                                         |

- **为什么一次只取 20 行**：任何 type 的文本属性都有长度上限风险，且响应体积可控；20 行 × 4.1 KB ≈ 82 KB，单请求可接受；
- **为什么插件不存向量**：Anytype 没有向量端点（实测缺口 ②），落盘就等于重新引入本地状态，违背零本地状态原则。

### 5.3 links 臂（原生关系）

两种取法，按场景选：

| 取法 | 请求                                         | 用途                                                 | 活体实测                                                            |
| ---- | -------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| 过滤 | `filter: memory_relates_to IN ("<id>", ...)` | 精确按受控边反查邻居                                 | **请求 200 但 `total=0`**——服务端**接受**该 filter 却**匹配不到行** |
| 投影 | `fields=links,backlinks`                     | 取回候选对象的一跳邻居 id（**出边 + 入边一次拿全**） | ✅ 可靠——原生双向关系自动生成                                       |

> **实测结论（2026-10-23）**：relation 过滤被服务端**接受**（不报错、不 400），但用
> **真实存在**的对象 id 去过滤依然 `total=0`。所以关系臂的**兜底**必须存在：投影
> Anytype 原生的 `links` / `backlinks`，把邻居 id 作为 `related_ids` 返回给 agent。
> `memory_doctor` 会把这件事报成 `capabilities.relation_filter_rows = 0` 并附告警。

再一跳（二度邻居）由插件在内存里做一次集合运算，**不需要额外 HTTP 请求**。

### 5.4 RRF 融合（k = 60）

各臂只产出**名次**，因此用 Reciprocal Rank Fusion：

```
RRF(d) = Σ_arm  1 / (k + rank_arm(d))        k = 60
```

- 缺席的臂贡献 0；
- 多臂同时命中会**累加**，天然实现「多臂一致 → 更可信」；
- 归一化成 relevance：

```
relevance(d) = RRF(d) / max_d RRF(d)        ∈ (0, 1]
```

> 为什么用 RRF 而不是加权分数：lexical 臂只有名次没有分数（实测缺口 ①），vector 臂有分数但量纲完全不同（余弦 ∈ [-1,1]），RRF 对两边都只要求「有序」，是唯一能把异构信号稳妥合并的经典方法。

### 5.5 乘法 boost

```
final(d) = relevance(d) × recency(d)^0.2 × confidence(d)^0.2 × proof(d)^0.1
```

| 因子            | 定义                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `recency(d)`    | `clamp(1 - days_since(memory_created_at) / 365, 0.1, 1)`                                                                                 |
| `confidence(d)` | `0.1 + (clamp(confidence, 1, 10) / 10) × 0.9`（`memory_confidence` 是 **1–10 整数**，见 `02-memory-model.md` §2.1）；缺失时按 `0.5`      |
| `proof(d)`      | `min(1, 0.5 + proof_count × 0.1667)`——**未被佐证的记忆降到 0.5 基数，但不归零**（归零等于删除，不符合「只归档不删除」）；≥3 次佐证即封顶 |

- **乘法而非加法**：任何一个因子为 0，结果为 0——这正是我们想要的「一票否决」语义（比如已被证明是错的记忆，`confidence=0` 就该沉底）；
- **指数 0.2 / 0.2 / 0.1 表示权重**：时间与置信度同等重要，佐证数只做轻量微调；
- `origin=user` **不参与** boost——人工与机器写入的记忆在排序上不做区别，只在状态与标注上区分（见 `06-llm-vector-delegation.md` §6）。

### 5.6 status 默认过滤

| status       | 默认是否召回  | 说明                                                                                |
| ------------ | ------------- | ----------------------------------------------------------------------------------- |
| `approved`   | ✅            | 正常参与排序                                                                        |
| `draft`      | ✅ **但标注** | 草稿可见（agent 需要知道自己看到的是未审内容），返回项带 `status` 字段供 agent 判断 |
| `disputed`   | ✅            | 有争议的记忆仍可能有用，但 `proof` 因子通常偏低                                     |
| `superseded` | ❌ 默认排除   | 已被取代，不是当前真相                                                              |
| `archived`   | ❌ 默认排除   | 已归档                                                                              |

`status` 参数可显式覆盖；agent 查历史真相时应显式传入 `["superseded","archived"]`。

### 5.7 token 预算截断

- `max_tokens` 默认 **4096**，是一等公民（`04-tool-api.md` §18.5）；
- 按 `final` 降序逐条累加**估算 token**（实现见 `src/memory/recall.ts` 的 `estimateTokens`）：**CJK 约 1 字 1 token**、**ASCII 约 4 字符 1 token**；
- 超预算即停，返回 `truncated: true` 与 `omitted_count`——**「还有东西没召回」必须被看见**；
- 估算而非精确计数：插件不依赖具体 tokenizer（换模型就得换 tokenizer），精确计数的偏差用 `max_tokens` 的保守取值吸收。`[待活体验证]`：若要精确 token 数，需在 agent 侧用与生成模型同族的 tokenizer 预检。

### 5.8 HTTP 往返预算（≤3 次 / 每次召回）

限速是 **1 req/s 持续、突发 60**，所以一次召回的往返次数是**硬约束**。

| #   | 请求                          | 服务    | 载荷要点                                                                                            |
| --- | ----------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| 1   | `POST /v2/spaces/{id}/search` | lexical | `query` + `filter`(`memory_kind` / `memory_status`) + `sorts` + `fields` 投影                       |
| 2   | `POST /v2/spaces/{id}/search` | vector  | `fields=["memory_embedding","memory_embedding_model","memory_embedding_dim",...]`，**单批 ≤ 20 行** |
| 3   | `POST /v2/spaces/{id}/search` | links   | 先按受控边过滤；命中 0 行则**用已投影的 `links` / `backlinks` 兜底**取邻居 id                       |

**候选集复用**：默认路径下 vector 臂的候选集 = lexical 臂返回的 top-`limit`（≤20），因此请求 2 最多取 20 行，**总往返恒为 3**。

**纯 vector 扫描**（`arms=["vector"]`，lexical 关闭）确实没有服务端排序可借，只能分批扫：每批 ≤20 行，批数 = `ceil(候选数 / 20)`。此时插件**不会**悄悄发起第 4 次请求——它返回当前批次结果并在 `warnings[]` 里说明「还有 N 条候选未扫描，需要提高 `limit` 或显式分页」。

**明令禁止**：❌「先 search 拿 id 列表 → 再逐个 GET 对象详情」的循环。需要正文就用 `fields` 一次投影拿回来——`fields` 是**加内容**不是减内容，正好用来省往返。

---

## 6. 幂等 / 去重 / 冲突 / 取代

### 6.1 `content_hash`——规范化与指纹

```
content_hash = sha256( scope_id + "|" + kind + "|" + normalize(content) )
```

| 环节                 | 规则                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `normalize(content)` | ①`trim` 去首尾空白 → ②连续空白（含换行、Tab）**折叠为单个空格** → ③Unicode **NFC** 规范化 |
| `scope_id`           | 缺省为空串（仍保留 `                                                                      | ` 分隔符，保证不同 scope 的同内容哈希不同） |
| `kind`               | 原样参与哈希——`fact` 与 `lesson` 即使正文相同也是**不同**记忆                             |
| 编码                 | 小写十六进制；存进对象的 `memory_content_hash` text 属性                                  |

> 规范化只作用于**内容**：同一段话在 `trim`+空白折叠+NFC 之后形态不同 → 视为同一条 → 命中去重。

> **口径已统一**（2026-10-23）：归一化 = **trim → 空白折叠 → NFC**（不做小写化、
> 不做标点剥离——英文大小写与标点常携带信息）；哈希输入 =
> **`scope_id | kind | 归一化正文`**（含 `scope_id`：不同作用域的同内容是两条
> 独立记忆）。`02-memory-model.md` §6 与本文已按此对齐，实现见
> `src/memory/dedup.ts`（`normalizeContent` / `contentHash`）。

### 6.2 去重

```
POST /v2/spaces/{id}/search
```

```json
{
  "query": "",
  "filter": "memory_content_hash = \"<hash>\""
}
```

- 命中 → **不写入**，把既有对象 id 放进 `deduped[]` 返回，agent 可改用 `memory_update`；
- 去重是**精确同内容**级别的——措辞改了（近义重复）**抓不到**，这类会落到 §6.3 的冲突通道；
- `filter` 串长度 ≤4096 字节，64 位十六进制哈希远在限制内。

### 6.3 冲突候选

1. **近邻检索（确定性，零 LLM）**：用待写正文的前 80 字符做一次 `POST /v2/spaces/{id}/search`，`filter` 限同 `memory_kind`，`limit=5`；
2. **筛选**：剔除 `memory_status ∈ {archived, superseded}` 的结果（它们不再需要裁决）；
3. **返回**：装进 `conflicts[]`（`object_id` / `kind` / `status` / `excerpt` / `against` / `action`），**由 agent 裁决**。

> 中文短串（≤4 字）在 `src/memory/chunk.ts` 的 `queryTerms` 里**整体保留**、长串退化为
> 2-gram 滑窗——这是给 Anytype 全文检索的「像查询的查询」，不做语义判断
> （语义由向量臂负责）。

agent 的三条裁决路径：

| 裁决      | 动作                                                                      |
| --------- | ------------------------------------------------------------------------- |
| merge     | `memory_update`（`replace_text` 或 `set_properties`）——插件**不**自动合并 |
| supersede | `memory_supersede(old_id, new_id)`                                        |
| create    | 保留双方，把新条目标为 `disputed`，等下一轮人工/agent 裁决                |

> 中文短串整体保留、长串 2-gram 滑窗，是给中文全文检索的保守选择：宁可召回多一点，也不漏。**中文全文检索本身已实测可用**（§2.4 第 7 条），但**召回质量**（分词粒度导致的排序优劣）尚未量化——`[待活体验证]`：用 `memory_doctor` 的中文探测与本节检索对比召回质量。

### 6.4 取代语义

一次取代 = **两件事同时成立**：

| #   | 动作                                                                                | 端点                                                                    |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | 旧对象 `memory_status = superseded` + `memory_valid_to` 打点（缺省为当前 UTC 时间） | `PATCH /v2/spaces/{id}/objects/{oid}`（**同一个 `set_properties` op**） |
| 2   | 新对象建 `memory_supersedes` 关系边指向旧对象                                       | `PATCH /v2/spaces/{id}/objects/{oid}`（`set_properties` / `add`）       |

- **旧对象 `memory_origin = user` 时插件拒绝自动取代**——用户亲笔写的文本不能被悄悄换掉；agent 应改用 `memory_update` 置 `disputed`，或走用户确认流程；
- 取代**不删除任何东西**：旧对象仍在库里，`memory_status=superseded`，默认召回时被排除（§5.6），需要查历史时可显式请求；
- **第 1 步必须是一次原子写**：同一 etag 只能写一次（§2.4 第 11 条），拆成两次 PATCH 第二次必 409。

### 6.5 幂等键语义（`Idempotency-Key`）

| 情形             | key             | body           | 结果                           |
| ---------------- | --------------- | -------------- | ------------------------------ |
| 首次提交         | 新 key `K`      | `B`            | 201，创建成功                  |
| 网络超时后重试   | **同一个 `K`**  | **同一个 `B`** | **重放已存响应**——不会重复创建 |
| 内容改动后再提交 | **新 key `K2`** | `B2`           | 正常创建                       |
| 同一 key 换 body | `K`             | `B2`           | **409 `idempotency_conflict`** |
| 不带 key         | —               | 任意           | 正常执行（**无防重保护**）     |
| `dry_run` 预演   | 任意            | 任意           | 不落库，**不消耗幂等键**       |

> **铁律**：重试**同一个请求**必须复用**同一个 key**；**换了内容**才换新 key（建议 uuid）。
> 限速 429 后的重试同样适用这条铁律——用同一 key 重试才是安全的。

---

## 7. 状态机

### 7.1 状态与迁移

| 从 → 到                   | 触发                                            | 工具                                                         |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| `draft` → `approved`      | 评审通过                                        | `memory_review(decision=approve)`                            |
| `draft` → `disputed`      | 评审存疑                                        | `memory_review(decision=dispute)`                            |
| `draft` → `archived`      | 评审驳回 / 归档                                 | `memory_review(decision=reject)` / `memory_archive`          |
| `approved` → `disputed`   | 出现矛盾证据                                    | `memory_review(decision=dispute)`                            |
| `approved` → `superseded` | 被新记忆取代                                    | `memory_supersede`                                           |
| `approved` → `archived`   | 归档                                            | `memory_archive`                                             |
| `disputed` → `approved`   | 复核后确认                                      | `memory_review(decision=approve)`                            |
| `disputed` → `draft`      | 退回补充证据                                    | `memory_update`（`set_properties` 设 `memory_status=draft`） |
| `disputed` → `superseded` | 被新记忆取代                                    | `memory_supersede`                                           |
| `disputed` → `archived`   | 归档                                            | `memory_archive`                                             |
| `superseded` → `archived` | 清理                                            | `memory_archive`                                             |
| `archived` → （终态）     | 插件**不自动复活**；用户可在 Anytype 里手工恢复 | —                                                            |

### 7.2 不变式

1. **插件永不删除对象**——最远只能到 `archived`（唯一例外：`memory_doctor` 清理它自己建的探针）；
2. **`memory_origin=user` 的对象**：插件不自动取代、不自动改写正文；`memory_status` 变更只发生在 agent 显式调用评审/归档工具时；
3. **`memory_content_hash` 只在正文内容变更时重算**——归档、评审、状态变更、取代**都不重算**（生命周期元数据 ≠ 内容变更），去重键因此稳定；**状态流转一律不改写正文**（正文不可变，见 `02-memory-model.md` §4.3）；
4. **关系边只增不删**——`memory_relates_to` 等边一旦建立不自动解除（除非对象被归档，边仍在库里）。

---

## 8. 已知边界

| 边界                        | 现状                                                                                   | 出处 / 验证方式                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 无相关度分数                | 用 rank + RRF 融合                                                                     | 实测缺口 ①                                                                                        |
| 无向量端点                  | agent 提供向量，插件进程内算余弦                                                       | 实测缺口 ②；协议见 `06-llm-vector-delegation.md` §3                                               |
| ~~中文分词质量未知~~        | **已实测证伪**：中文短语能命中对象，标题与正文都参与索引（**但生僻词不可靠**）         | 实测 §2.4 第 7 条                                                                                 |
| **全文索引最终一致**        | 刚写的对象搜不到（实测约 3～6s 后才命中）→ 写入后立即召回可能扑空                      | 实测 §2.4 第 8 条；`memory_doctor` 用轮询重试 + 中文/ASCII 双探针区分「索引滞后」与「分词不可靠」 |
| **relation 过滤匹配不到行** | 服务端接受该 filter 但 `total=0` → 关系臂兜底为投影 `links` / `backlinks`              | 实测 §2.4 第 9 条                                                                                 |
| **属性必须挂进字段表**      | 不在字段表里的属性「会被存储并随对象返回，但按类型过滤/查询时该键被拒绝」              | 实测 §2.4 第 3 条；bootstrap 用 `add_property` op 补挂                                            |
| **同名不同格式会 400**      | 插件属性一律 `Memory ` 前缀；`tag` 复用内置                                            | 实测 §2.4 第 1 条                                                                                 |
| **同一 etag 只能写一次**    | 多字段变更必须合并进同一个 `set_properties` op                                         | 实测 §2.4 第 11 条                                                                                |
| **删除受限**                | `DELETE` 只对本 key 创建的对象有效；HTTP v2 无 space 删除端点                          | 实测 §2.4 第 12 条                                                                                |
| 属性只能列表读取            | 所有 schema 信息走一次 `GET /v2/spaces/{id}/properties`                                | 实测 404 约束                                                                                     |
| 持续限速 1 req/s            | 召回 ≤3 次往返；分页扫描需 agent 显式驱动                                              | 突发 60                                                                                           |
| v2 是 pre-release           | 每次启动探测 `GET /v2/docs/openapi.json` + `GET /v2/schemas/*`，能力面以本机 spec 为准 | `memory_doctor` 的 `schema` 段                                                                    |

---

## 9. 与同目录文档的口径（已统一）

本文与 `02-memory-model.md` / `03-flows.md` 曾有三处算法口径不一致，**2026-10-23
已按实现（`src/memory/dedup.ts` / `src/memory/recall.ts`）统一**，此处保留决策记录：

| #   | 主题                | **最终口径（实现为准）**                                                                                                                                                         | 决策理由                                                                                                     |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | `content_hash` 输入 | `sha256(scope_id \| kind \| normalize(content))`，normalize = trim + 空白折叠 + NFC                                                                                              | 含 `scope_id`：不同作用域的同内容是两条独立记忆；不做小写/标点剥离：英文大小写与标点常携带信息               |
| 2   | boost 公式          | `final = rrf × recency^0.2 × confidence^0.2 × proof^0.1`，`recency = clamp(1 - days/365, 0.1, 1)`，`confidence = 0.1 + (clamp(c,1,10)/10)×0.9`，`proof = min(1, 0.5 + n×0.1667)` | 指数权重 + 线性衰减（Hindsight 口径）：乘性保证「低相关 + 高置信」不会被抬到高相关之前                       |
| 3   | 召回返回字段名      | `items[]` / `arms_hit[]` / `arms_used[]` / `related_ids[]` / `candidate_count` / `access_count_bumped` / `warnings[]` / `truncated` / `omitted_count`                            | 与 `04-tool-api.md`、实现 `src/memory/tools/read.ts` 一致；**返回体不含向量原文**                            |
| 4   | 属性 key 口径       | 工具层用**语义名**（`kind` / `status` / `content_hash`）→ 期望 key（`memory_*`）→ bootstrap 读回的服务端真实 key                                                                 | 消除「工具层传 `kind`、存储层查 `memory_kind`」这类字符串漂移——活体调试时它表现为「filter 命中不了」而非报错 |

> 三处都以「可解释、可调参、不引入隐藏魔法」为取舍依据：05 的写法保留了「分数归一 + 指数权重」的显式形态，02/03 的写法保留了「半衰期」这一更直观的衰减概念。统一时建议**保留 02 的因子定义、补上 05 的指数权重与归一化步骤**。

---

## 10. 复现探测（2026-10-23）

```sh
export ANYTYPE_BASE=http://127.0.0.1:31009
export ANYTYPE_KEY=<你的 API key>
SPACE=64xiwe

# 身份与授权
curl -s -H "Authorization: Bearer $ANYTYPE_KEY" "$ANYTYPE_BASE/v2/auth/whoami"

# ① 全文检索：total=6, has_more=true, rows 有序
curl -s -X POST -H "Authorization: Bearer $ANYTYPE_KEY" -H "Content-Type: application/json" \
  -d '{"query":"Get Started"}' "$ANYTYPE_BASE/v2/spaces/$SPACE/search"

# ② 结构化过滤
curl -s -X POST -H "Authorization: Bearer $ANYTYPE_KEY" -H "Content-Type: application/json" \
  -d '{"query":"","filter":"type = \"page\""}' "$ANYTYPE_BASE/v2/spaces/$SPACE/search"

# ③ 排序
curl -s -X POST -H "Authorization: Bearer $ANYTYPE_KEY" -H "Content-Type: application/json" \
  -d '{"query":"","sorts":[{"property":"last_modified_date","direction":"desc"}]}' \
  "$ANYTYPE_BASE/v2/spaces/$SPACE/search"

# ④ 关系投影（links / backlinks 出现在行内）
curl -s -X POST -H "Authorization: Bearer $ANYTYPE_KEY" -H "Content-Type: application/json" \
  -d '{"query":"","fields":["links","backlinks"],"limit":5}' "$ANYTYPE_BASE/v2/spaces/$SPACE/search"

# ⑤ 属性清单（41 个，含 links(objects) / backlinks(objects)）；单属性 GET → 404
curl -s -H "Authorization: Bearer $ANYTYPE_KEY" "$ANYTYPE_BASE/v2/spaces/$SPACE/properties"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ANYTYPE_KEY" \
  "$ANYTYPE_BASE/v2/spaces/$SPACE/properties/links"

# ⑥ 缺失能力：无向量端点（404）
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ANYTYPE_KEY" \
  "$ANYTYPE_BASE/v2/spaces/$SPACE/objects?embedding=nearby"

# ⑦ 字段表：类型文档的第一个块（dataview）的 properties[] 才是字段表
curl -s -H "Authorization: Bearer $ANYTYPE_KEY" "$ANYTYPE_BASE/v2/spaces/$SPACE/types/memory" \
  | jq '.blocks[0].properties[].property'

# ⑧ relation 按对象 id 过滤：请求 200，但 total 恒为 0
curl -s -X POST -H "Authorization: Bearer $ANYTYPE_KEY" -H "Content-Type: application/json" \
  -d "{\"query\":\"\",\"filter\":\"memory_relates_to IN (\\\"$OBJ_ID\\\")\"}" \
  "$ANYTYPE_BASE/v2/spaces/$SPACE/search" | jq '{total}'

# ⑨ 中文全文检索：标题与正文都参与索引（刚写入的对象可能搜不到——索引最终一致）
curl -s -X POST -H "Authorization: Bearer $ANYTYPE_KEY" -H "Content-Type: application/json" \
  -d '{"query":"持久记忆"}' "$ANYTYPE_BASE/v2/spaces/$SPACE/search" | jq '{total}'
```

> 探测只读；任何写操作请加 `?dry_run=true`。
>
> ⑨ 的实测结论：中文短语能命中对象，**标题与正文都参与索引**（**生僻词除外**——
> 生僻词即使对象已进索引也搜不到）；但**全文索引是最终一致的**——刚创建的对象
> 搜不到，实测约 **3～6s** 后才可被检索命中。故任何「写完立刻自查能否搜到」的
> 脚本都必须**轮询重试**，并最好配一个 ASCII 标记做**双探针**（区分「索引滞后」
> 与「中文分词对该词不可靠」）。
