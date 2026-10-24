# @lzhida/dsh-anytype

把 **Anytype v2 本地 API**（Anytype 桌面应用内置，官方 [`@anyproto/anytype-mcp`](https://github.com/anyproto/anytype-mcp) 的后端）封装为一组 dsh 原生工具（`defineTool`），让 dsh 会话里的 agent 直接读写你的 Anytype 知识库。

与「配置 dsh-mcp-client 桥接官方 MCP 子进程」相比：无 `npx -y` 子进程与网络下载、工具名/参数为 agent 手工设计、API key 走 dsh 设置面板（volatile 保存即生效）。

## 一个包，多个插件行

本包是一个 **bundle**（与 dsh 官方 bundle 同构）：装一次，得到**两个插件行**，
它们通过**具名 service** 组合，共用同一把钥匙。

| 插件行               | 能力                                                 | 工具数 |
| -------------------- | ---------------------------------------------------- | ------ |
| `dsh-anytype`        | 通用 Anytype 封装（空间/对象/类型/属性/搜索…）       | 30     |
| `dsh-anytype-memory` | 纯本地持久记忆（零本地状态，记忆即 Anytype 对象）    | 16     |
| `dsh-anytype-wiki`   | **留位**：将来的 LLM Wiki 知识编译管道（本次不注册） | —      |

- **连接配置只填一次**：插件行①注册具名服务 `anytype`（持配置现读的客户端），
  插件行②以 `inject: ['anytype']` 复用它——设置面板里 apiKey 只出现一次；
- **装一次即全部激活**：包的 `cordis.patch.yml` 声明两个插件行，随包进入
  profile 的 bundle 层，**profile 侧不需要写任何 `insert:`**；
- 机制与写法详见 **[docs/bundle-architecture.md](./docs/bundle-architecture.md)**。

## 前置条件

1. **Anytype 桌面应用正在运行**（本地 API 默认 `http://127.0.0.1:31009`）——插件只做检测，不负责拉起桌面应用；
2. 在 Anytype 中创建 API key：App Settings → API Keys → `Create new`；
3. dsh 组合中存在 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt` 提供方（web/base bundle 自带），否则插件停在 PENDING。

## 安装（开发态）

```sh
pnpm dsh plugin --profile <profile> add link:<仓库绝对路径>/packages/dsh-anytype
```

装完包名会进入 profile 的 `dsh.profile.bundles`，两个插件行随之激活。
profile 侧**只需按 id 覆盖配置**（不要 `insert:` 同 id 的行，否则插件会被
实例化两次、工具注册两次）：

```yaml
# profile 的 cordis.patch.yml
- id: dsh-anytype
  config:
    baseUrl: http://127.0.0.1:31009
    apiKey: anytype_xxx
- id: dsh-anytype-memory
  config:
    spaceName: Agent Memory
```

纯 TS 源码入口，仅支持 `link:` 安装（Node 拒绝剥离 `node_modules` 下 realpath
的 `.ts`）；实体安装（npm/git）需先按 `dsh-llm-fallback` 模式加 esbuild dist。

## 配置

### 插件行① `dsh-anytype`（连接类 + 通用工具）

| 字段               | 默认                     | 说明                                              |
| ------------------ | ------------------------ | ------------------------------------------------- |
| `enabled`          | `true`                   | 总开关；关闭后不注册任何工具（指引 section 保留） |
| `baseUrl`          | `http://127.0.0.1:31009` | Anytype 本地 API 地址                             |
| `apiKey`           | `''`                     | Bearer 密钥；执行时实时读取，改动即时生效         |
| `apiVersion`       | `2025-11-08`             | `Anytype-Version` 请求头                          |
| `disabledGroups`   | `[]`                     | 按组停用工具（改动后需重载插件）                  |
| `requestTimeoutMs` | `30000`                  | 单请求超时                                        |
| `maxResponseChars` | `20000`                  | 工具结果截断上限（超限返回 `data_preview`）       |

### 插件行② `dsh-anytype-memory`（语义类，无连接字段）

| 字段                 | 默认           | 说明                                                |
| -------------------- | -------------- | --------------------------------------------------- |
| `enabled`            | `true`         | 总开关；关闭后不注册任何工具（指引 section 保留）   |
| `spaceName`          | `Agent Memory` | **记忆工作环境**的空间名（`memory_setup` 按需创建） |
| `spaceId`            | `''`           | 钉住指定空间（短引用如 `64xiwe` 或完整 id）         |
| `disabledGroups`     | `[]`           | 停用工具组：setup / write / read / agent / diag     |
| `recallLimit`        | `20`           | 召回默认条数                                        |
| `recallMaxTokens`    | `4096`         | 召回正文 token 预算（元数据免费）                   |
| `embeddingBatchSize` | `20`           | 向量投影单批条数（限速 1rps 的往返预算）            |
| `defaultStatus`      | `draft`        | AI 写入记忆的默认审核态                             |

> 连接类字段（baseUrl / apiKey / apiVersion / 超时 / 截断）**只在插件行①**，
> 记忆插件行经 `inject: ['anytype']` 复用同一个客户端。
>
> **编辑方式（bundle 形态）**：设置面板能显示每个插件行与启用开关，但宿主
> 对 bundle 组件**不渲染 schemastery 配置表单**（宿主行为，实测 2026-10-24）——
> 改配置请编辑 profile 的 `cordis.patch.yml`（按 id 覆盖，见上文安装一节）。
> 详见 [docs/bundle-architecture.md](./docs/bundle-architecture.md) §6。

## 工具清单（30 个，10 组）

| 组         | 工具                                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| connection | `anytype_whoami`、`anytype_status`（桌面端可达性/鉴权探测——连接问题诊断第一站）                                                                              |
| search     | `anytype_search`（全局/空间二合一，支持 `fields` 属性投影与 `filter` 过滤语法）、`anytype_list_objects`                                                      |
| space      | `anytype_list_spaces` / `anytype_get_space` / `anytype_create_space`✎ / `anytype_update_space`✎                                                              |
| object     | `anytype_get_object` / `anytype_create_object`（shortcut body）✎ / `anytype_update_object`（ops）✎ / `anytype_delete_object`✎                                |
| collection | `anytype_create_collection`✎ / `anytype_list_collection_objects`                                                                                             |
| type       | `anytype_list_types` / `anytype_get_type` / `anytype_create_type`✎ / `anytype_update_type`✎ / `anytype_delete_type`✎ / `anytype_list_templates`              |
| property   | `anytype_list_properties` / `anytype_list_property_options` / `anytype_create_property`✎ / `anytype_update_property`（仅改名）✎ / `anytype_delete_property`✎ |
| member     | `anytype_list_members` / `anytype_get_member_me`                                                                                                             |
| schema     | `anytype_get_schema` / `anytype_get_op_schema`（15 种编辑 op 的运行时 schema）                                                                               |
| generic    | `anytype_request`（逃生舱：chats / files / widgets / queries / discussion / validate 等；仅放行 `/v2/`，拒绝 `/v2/auth/*`）✎                                 |

✎ = 写工具，统一带 `dry_run`（预演）与 `idempotency_key`（防重）两个可选参数——详见下文「写路径安全」。

设计要点：

- **v2 自描述编辑**：`anytype_update_object` 的 ops 与 AnyBlock 文档成员不硬编码，agent 用 `anytype_get_op_schema` / `anytype_get_schema` 运行时取真值；
- **乐观锁（object/type）**：读工具回传响应 `etag`，`anytype_update_object` / `anytype_update_type` / `anytype_request` 接受 `expected_etag`（映射 `If-Match`）——e2e 实测三次连续写入（4d33c8ca → 883c2064 → 09691893）无冲突；chats 域例外：聊天并发词汇是 order-id/last_state_id，不走 etag/If-Match（已写入 `anytype_request` 参数描述）；
- **space 无乐观锁（实测）**：Anytype v2 spec 的 spaces PATCH 参数区没有 `If-Match`，space 读也不返回 etag；实测带过期 `If-Match` 的 `PATCH /v2/spaces/{id}?dry_run=true` 仍 200（服务端静默忽略）——`anytype_update_space` 因此不提供 `expected_etag`，并发改名无服务端保护。各端点能力以本地 `/v2/docs/openapi.json` 自省为准（v2 为 pre-release，未来版本可能给 spaces 补 etag）；
- **属性写边界（v2）**：`anytype_create_property` 建属性（name+format 必填，format 枚举 text|number|select|multi_select|date|files|checkbox|url|email|phone|objects，key 缺省从 name 派生，select/multi_select 可内联 options[]）；`anytype_update_property` 仅改名——PATCH 只收 name，key 是属性身份不变、format 创建后不可变；`anytype_delete_property` 归档进 Bin 可恢复（`dry_run=true` 预检）。选项词汇创建后只读：v2 没有 v1 tags 的选项改名/删色端点，也无独立 options CRUD——新选项靠 create_type/create_object 内联属性名 + `create_missing_options=true` 铸造，经 `anytype_list_property_options` 读回；
- **只读并行**：读类工具声明 `isConcurrencySafe`，可与同批读调用并行调度；
- **错误可操作**：连接失败提示「Anytype 应用未运行？」；API 错误透传 `status + code + issues + hints`——实测模型能凭错误 hint 自行纠错重试。

### 搜索收窄（fields 属性投影 + filter 过滤语法）

`anytype_search` 透传 SearchRequest 的两个新通道，让 agent 能用**一次窄查询**替代「全量拉取→截断→重查」循环：

| 参数      | 映射             | 语义                                                                                                                                                                                                           |
| --------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fields`  | body `fields[]`  | **属性投影**：点名要回哪些属性（如 `["name","due_date"]`）。**不加** `fields` 时响应行只有 `id`/`name`/`type` 骨架（全局搜索另加 `space_id`），**不带任何属性**；加了才把列出的属性投影进 `row.properties`     |
| `filter`  | body `filter`    | **紧凑过滤语法**字符串，**上限 4096 字节**（服务端按 UTF-8 字节计）。语法 EBNF 见 `anytype_get_schema(kind='filters')`——如 `done = false AND due_date < currentWeek()`、`status IN ("In progress", "Blocked")` |
| `filters` | body `filters[]` | 结构化过滤数组（既有参数）——**与 `filter` 互斥，二选一**（服务端同传返 400 `ambiguous_input`，插件工具层提前拦下并给出可操作错误）                                                                             |

**关键语义澄清（2026-10-21 活体实测，纠正「fields = 响应裁剪」的直觉）**：`fields` 是**「投影哪些属性回来」**（加内容），**不是**「裁掉多余属性」（减内容）——与 `anytype_list_objects` 的 `fields`（GET query，逗号分隔字符串）语义一致：显式点名要哪些属性。因此传 `fields` 反而让响应**变大**（20 行空间搜索实测：无 `fields` 2298 字节 → `fields=["name"]` 3156 字节）。真正压体积靠 `filter`（收窄结果集）+ `limit`（分页）；`fields` 的价值是**省掉「搜到 id 再逐个 get_object」的往返**。

其他活体实测结论：

- `fields` 的键必须在**该 type 的已知属性集**内——传了 `type` 时按该 type 的键集校验（`type=task` 时 `description` 不合法），不传 `type` 时按空间全集校验（活体 140 个键）。未知键服务端返 400 `unknown property keys` 并附「did you mean」提示；键名可用 `anytype_list_properties` 查；
- `filter` 超 4096 字节返 400 `validation_failed`，提示「split the query」；语法错误返 400 并指回 `GET /v2/schemas/filters`；
- `filter` 与 `filters` 互斥由**服务端**强制（400 `ambiguous_input`，issues 同时指向 `/filter` 与 `/filters`），插件工具层复刻该校验以省一次往返；
- 空值处理：`filter:""` 服务端按「未提供」忽略；`filters:[]`/`filters:null` 服务端会 400——插件把空过滤值一律视作「未提供」，不发无效负载；
- 紧凑语法与结构化数组**过滤能力不等价**：紧凑语法用 `preset`（`currentWeek()` / `daysAgo(7)`）与集合字面量（`IN (...)` / `HAS ALL (...)`），结构化数组用 `date_preset` 枚举 + `condition` 字段——见 `anytype_get_schema(kind='filters')` 的对照。

### 写路径安全（dry_run 预演 + Idempotency-Key 防重）

所有写类工具（`create_space` / `update_space` / `create_object` / `update_object` / `delete_object` / `create_collection` / `create_type` / `update_type` / `delete_type` / `create_property` / `update_property` / `delete_property`，以及逃生舱 `anytype_request`）统一暴露两个可选参数：

| 参数              | 映射                 | 语义                                                                                                                                             |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dry_run`         | `?dry_run=true`      | **预演**：只校验并回报结果，不落库。创建类预演返 **200**（提交返 **201**）；更新/删除类预演与提交同为 200，靠响应体 `dry_run: true` 布尔字段区分 |
| `idempotency_key` | `Idempotency-Key` 头 | **防重**：服务端按「key + 请求体」绑定——同 key 同 body 重复提交**重放已存响应**（不重复创建），同 key 换 body 返 **409 `idempotency_conflict`**  |

**重试用法**：重试**同一请求**必须复用**同一个 key**（否则失去防重意义）；换了请求内容才换新 key（建议 uuid）。这是插件「不做自动重试」这一决策能成立的前提——重试由 agent/上层决策，插件只提供防重原语。

**覆盖面与诚实边界**（活体实测 2026-10-21 + 上游 spec 双源核对）：

- `dry_run` 覆盖面广——v2 spec 对几乎全部资源 mutation 都声明了该参数（26/55 operation），插件暴露的工具端点全部在列；
- `Idempotency-Key` 的 **spec 声明面窄于服务端实际覆盖面**：spec 只在 spaces / chats / widgets / discussion / `POST /v2/validate` 上声明，但**活体实测服务端对 objects / types / properties / collections 的 mutation 同样强制执行该头**（同 key 换 body 返 409）。因此插件统一透传该头——这正是「防重复创建」的真实保障来源；
- `Idempotency-Key` **不出现在任何 GET/HEAD**，`POST /v2/search` 与空间内 search 也不接受（规范明示「Search requests do not」）；
- **409 是共享错误码**：既可能是幂等冲突（同 key 换 body），也可能是并发冲突（stale `If-Match` etag，object/type 组）。错误链已透传 `status + code + message`，不做特判——按 message 语义区分即可；
- **`idempotency_conflict` 不是 spec 里枚举的 code**（spec 的 `Error.code` 是自由字符串），只能依赖 409 + message，不要对 code 做精确匹配。

### 不做自动重试 / 退避（明确留白）

插件**刻意不实现**自动重试与退避：

- 服务端自 2025-05-20 起默认限速 **sustained 1 rps / burst 60**（`ANYTYPE_API_DISABLE_RATE_LIMIT=1` 可关），429 是预期内会发生的现实场景；
- 但**重试策略应由调用方决定**——不同写操作的幂等性、可重试性与代价差异很大，插件内建退避会掩盖真实语义并可能放大写操作；
- 插件的职责边界是**提供安全原语**（`dry_run` 预演 + `idempotency_key` 防重 + `expected_etag` 乐观锁），把「要不要重试、重试几次、隔多久」交给 agent 层判断。

> 这是**有意为之的留白**，不是遗漏——后续若要立卡做重试层，必须先定义「哪些错误可重试」与「幂等键的生成/复用责任」两个语义问题，否则会与本卡的防重语义冲突。

实测踩坑点（已固化进工具描述/参数约束）：

- `anytype_get_object` 的 `format` 只接受 `md` / `anyblock`（已做成 enum），传 `markdown` 会 400；
- `insert_blocks` 的 `markdown` 字符串里换行必须是真实换行符——写成 `\n` 字面量会被并进同一段落；精确控制层级时改传 `blocks` 块数组；
- 文件面/流式限制（已写入 `anytype_request` 描述）：multipart 上传不可发（`POST /v2/files` 仅 JSON url 形态理论可达）、`GET /v2/files/{id}/content` 二进制按文本损坏、`/messages/stream` 为 SSE 会挂至请求超时；
- `set_properties` op 的成员是 `set` / `unset` / `add` / `remove`（不是 `properties`）——传 `properties` 会 400 `json: unknown field`，成员结构以 `anytype_get_op_schema('set_properties')` 为准；
- **`DELETE /v2/spaces/{id}/objects/{oid}` 只删本 key 创建的对象**（`not_created_by_this_key` 403）——应用内/导入/他人建的对象一律拒绝，dry_run 预演也不豁免；
- **活体 spec 与上游 spec 可能漂移**：本机活体 `/v2/docs/openapi.json` 有 55 operation（比上游 main 多一个 `POST /v2/spaces/{id}/chats/{chat_id}/status`）——v2 为 pre-release，能力面以本地 spec 自省为准，不要凭记忆或凭旧快照铺开。

### 幂等与预演的活体实测（2026-10-21，Anytype 桌面端在线）

实测方法：全部用 `dry_run=true`（零副作用）+ `POST /v2/validate`（本身无副作用），跑完复核 space 内对象/类型/属性总数无变化。

| 观测                                         | 结论                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| `POST /v2/spaces/{id}/objects?dry_run=true`  | 200，body `{"type":"page","dry_run":true}`；对象总数不变——预演零副作用 ✅ |
| `POST /v2/spaces?dry_run=true`               | 200，body `{"name":"probe-space","dry_run":true}`；空间总数不变 ✅        |
| 同 key + 同 body 重复请求                    | 200 且响应**逐字节一致**——「同 key 同 body 重放已存响应」语义成立 ✅      |
| 同 key + **不同** body                       | **409 `idempotency_conflict`**（message: 同一 key 已用于不同请求体）✅    |
| 不带 key + 不同 body                         | 200 正常——不带 key 不触发幂等层 ✅                                        |
| spec **未声明** Idempotency-Key 的端点带该头 | 仍返 409 幂等冲突——**服务端实际强制面比 spec 声明面更广** ✅              |
| `POST /v2/spaces/{id}/search` 带该头         | 200 不报错，但 search 不绑定 key（规范明示 search 不接受该头）            |

## 插件行② `dsh-anytype-memory`：纯本地持久记忆

把**指定的 Anytype space** 当作 agent 的**持久记忆工作环境**：记忆正文、
属性、关系与向量全部落为 Anytype 对象；检索能力全部来自 Anytype 自身
（`search` + `filter` + `sorts` + `fields`，含原生 `links`/`backlinks` 双向
关系）；**插件零本地状态**——不写任何本地文件、不建本地索引、不跑模型、
不出网。

与插件行①的关系：①是**通用 Anytype 封装**，本行是**记忆语义层**——记忆该
长什么样、写入前该读什么、召回该怎么融合与降级，都在这里；连接由①的
`anytype` 服务提供。

### 工具清单（16 个，5 组）

| 组    | 工具                                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------------- |
| setup | `memory_setup`（幂等：建空间/类型/属性并把属性挂进类型字段表）                                        |
| write | `memory_write`、`memory_update`、`memory_link`、`memory_supersede`、`memory_archive`、`memory_review` |
| read  | `memory_recall`、`memory_get`、`memory_list`、`memory_search`、`memory_stats`                         |
| agent | `memory_candidates`、`memory_set_embedding`、`memory_suggest_links`                                   |
| diag  | `memory_doctor`（连通性 / schema / 能力探测 / **中文召回自检**）                                      |

写工具统一带 `dry_run`（预演）；`memory_write` 与 `memory_link` 另带
`idempotency_key`（防重）。

### 记忆模型（Anytype 侧）

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

### 四条不可让步的纪律

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

### 召回

三臂并行 → RRF(k=60) 融合 → 乘性旁证权重 → token 预算截断：

- **词法臂**：Anytype 全文搜索（`query` + `filter` + `sorts` + `fields`）；
- **向量臂**：外部 agent 的查询向量 × 对象上的 `memory_embedding` 属性
  （本地余弦，分批投影，**向量原文绝不返回给模型**）；
- **关系臂**：先按受控边属性反查；**服务端接受该过滤但匹配不到行**（实测
  `total=0`），故兜底为投影原生 `links` / `backlinks`，邻居 id 以
  `related_ids` 返回。

乘性权重：`final = rrf × recency^0.2 × confidence^0.2 × proof^0.1`，
`recency = clamp(1 - days/365, 0.1, 1)`。

### 活机实测要点（2026-10-23/24，Anytype 桌面端 v2 API）

这些是单元测试抓不到、只有真机才暴露的问题，细节见
[docs/memory/05-anytype-as-source.md](./docs/memory/05-anytype-as-source.md) §2.4：

| 结论                                                         | 影响                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| 插件属性显示名必须带 `Memory ` 前缀（`tag` 复用内置）        | 否则 400 `property format conflict`                                   |
| 记忆类型布局必须是 `basic`（不是 `note`）                    | `note` 会把对象标题吞成正文块，标题能力直接丢失                       |
| 类型字段表 = 类型文档 dataview 块的 `properties[]`           | 不挂进字段表 → 按类型过滤时该键被拒绝                                 |
| 紧凑类型列表接口读不到字段表                                 | 必须逐个读类型文档                                                    |
| 建类型会顺带铸造属性                                         | 建完类型必须**重新盘点**属性，否则撞 `property key already exists`    |
| 同一 etag 只能写一次                                         | `memory_supersede` 把 `valid_to` 与 `status` 合并成**同一个 op** 写   |
| 全文索引是最终一致的（实测 3~6s）                            | 写完立刻召回可能为空，应隔几秒重试或用 `memory_list` 确认             |
| 中文全文检索对**常用词**可靠、对**生僻词**不可靠             | 关键词召回用常用词/标签；必要时走向量臂（`memory_doctor` 会自检）     |
| relation 按对象 id 过滤被服务端接受但匹配不到行（`total=0`） | 关系臂兜底投影原生 `links`/`backlinks`，邻居 id 以 `related_ids` 返回 |
| 对象标题在 `properties.name`（对象文档没有顶层 name）        | 读标题别读 `object.name`                                              |

## 插件行③ `dsh-anytype-wiki`（留位）

将来的 **LLM Wiki** 知识编译管道（Raw → Wiki → Index 单向派生 + 人类控制
回路，参考官方 Anytwo 平台的实现）。本次只把**位置与契约**定下来
（`src/entries/wiki.ts` + `src/wiki/` 的落位、与 `anytype` 服务的复用关系），
等专门看板上的一张卡开工时填实现——细节见
[docs/bundle-architecture.md](./docs/bundle-architecture.md) §4。

## 文档

| 文档                                                         | 内容                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| [docs/bundle-architecture.md](./docs/bundle-architecture.md) | bundle 机制、一包多入口、service 组合、迁移指引、扩展插件行                                                   |
| [docs/memory/](./docs/memory/)                               | 记忆子系统 11 篇（架构 / 模型 / 流程 / 工具 API / 索引实证 / 向量委派 / 方案审查 / 生态对照 / 限制 / 路线图） |

## 关于 anytype-cli（暂不支持的说明）

[anytype-cli](https://github.com/anyproto/anytype-cli) 是内嵌同款 anytype-heart 节点的无头实例（API 31012），理论上可作为第二后端。但实测在本机（Windows）上 `auth create` 会触发节点堆损坏静默退出（[上游 issue #63](https://github.com/anyproto/anytype-cli/issues/63)，0xC0000374，自 v0.3.7 起），bot 账户无法创建，CLI 后端暂不可用。相关支持代码已暂时移除，待上游修复后可从 git 历史（`feat/dsh-anytype-cli-backend` 分支 `00bbb57`）恢复。

## 测试

```sh
pnpm --filter @lzhida/dsh-anytype typecheck
pnpm exec vitest run packages/dsh-anytype
```

e2e（真实 dsh 实例 + 真实 Anytype）见 `.agents/skills/dsh-plugin-dev/SKILL.md` §5 四步流程；apiKey 经 test profile 的 `cordis.patch.yml` 注入（密钥不入库）。

装成 bundle 后的 e2e 断言（2026-10-24 实测）：

- profile 的 `dsh.profile.bundles` 命中 `@lzhida/dsh-anytype`；
- profile 的 `cordis.patch.yml` **零 anytype `insert:` 行**（只按 id 覆盖 config）；
- 实例日志出现 `[dsh-anytype] plugin loaded` + `registered 30 Anytype tools`
  与 `[dsh-anytype-memory] plugin loaded` + `registered 16 memory tools`；
- 工具总数 **46 且名字唯一**（重复即说明旧 `insert:` 行没清干净）；
- 真机链路：setup → write → 同内容去重（同一 object_id）→ 中文召回 →
  向量臂 → link → get → supersede（recall 不再返回）→ review → stats → doctor。
