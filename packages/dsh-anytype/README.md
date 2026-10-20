# @lzhida/dsh-anytype

把 **Anytype v2 本地 API**（Anytype 桌面应用内置，官方 [`@anyproto/anytype-mcp`](https://github.com/anyproto/anytype-mcp) 的后端）封装为一组 dsh 原生工具（`defineTool`），让 dsh 会话里的 agent 直接读写你的 Anytype 知识库。

与「配置 dsh-mcp-client 桥接官方 MCP 子进程」相比：无 `npx -y` 子进程与网络下载、工具名/参数为 agent 手工设计、API key 走 dsh 设置面板（volatile 保存即生效）。

## 前置条件

1. **Anytype 桌面应用正在运行**（本地 API 默认 `http://127.0.0.1:31009`）——插件只做检测，不负责拉起桌面应用；
2. 在 Anytype 中创建 API key：App Settings → API Keys → `Create new`；
3. dsh 组合中存在 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-system-prompt` 提供方（web/base bundle 自带），否则插件停在 PENDING。

## 安装（开发态）

```sh
pnpm dsh plugin --profile <profile> add link:<仓库绝对路径>/packages/dsh-anytype
```

纯 TS 源码入口（`main: src/index.ts`），仅支持 `link:` 安装；实体安装（npm/git）需先按 `dsh-llm-fallback` 模式加 esbuild dist。

## 配置（Settings → Plugins → dsh-anytype）

| 字段               | 默认                     | 说明                                              |
| ------------------ | ------------------------ | ------------------------------------------------- |
| `enabled`          | `true`                   | 总开关；关闭后不注册任何工具（指引 section 保留） |
| `baseUrl`          | `http://127.0.0.1:31009` | Anytype 本地 API 地址                             |
| `apiKey`           | `''`                     | Bearer 密钥；执行时实时读取，改动即时生效         |
| `apiVersion`       | `2025-11-08`             | `Anytype-Version` 请求头                          |
| `disabledGroups`   | `[]`                     | 按组停用工具（改动后需重载插件）                  |
| `requestTimeoutMs` | `30000`                  | 单请求超时                                        |
| `maxResponseChars` | `20000`                  | 工具结果截断上限（超限返回 `data_preview`）       |

## 工具清单（30 个，10 组）

| 组         | 工具                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connection | `anytype_whoami`、`anytype_status`（桌面端可达性/鉴权探测——连接问题诊断第一站）                                                                          |
| search     | `anytype_search`（全局/空间二合一）、`anytype_list_objects`                                                                                              |
| space      | `anytype_list_spaces` / `anytype_get_space` / `anytype_create_space` / `anytype_update_space`                                                            |
| object     | `anytype_get_object` / `anytype_create_object`（shortcut body）/ `anytype_update_object`（ops）/ `anytype_delete_object`                                 |
| collection | `anytype_create_collection` / `anytype_list_collection_objects`                                                                                          |
| type       | `anytype_list_types` / `anytype_get_type` / `anytype_create_type` / `anytype_update_type` / `anytype_delete_type` / `anytype_list_templates`             |
| property   | `anytype_list_properties` / `anytype_list_property_options` / `anytype_create_property` / `anytype_update_property`（仅改名）/ `anytype_delete_property` |
| member     | `anytype_list_members` / `anytype_get_member_me`                                                                                                         |
| schema     | `anytype_get_schema` / `anytype_get_op_schema`（15 种编辑 op 的运行时 schema）                                                                           |
| generic    | `anytype_request`（逃生舱：chats / files / widgets / queries / discussion / validate 等；仅放行 `/v2/`，拒绝 `/v2/auth/*`）                              |

设计要点：

- **v2 自描述编辑**：`anytype_update_object` 的 ops 与 AnyBlock 文档成员不硬编码，agent 用 `anytype_get_op_schema` / `anytype_get_schema` 运行时取真值；
- **乐观锁（object/type）**：读工具回传响应 `etag`，`anytype_update_object` / `anytype_update_type` / `anytype_request` 接受 `expected_etag`（映射 `If-Match`）——e2e 实测三次连续写入（4d33c8ca → 883c2064 → 09691893）无冲突；chats 域例外：聊天并发词汇是 order-id/last_state_id，不走 etag/If-Match（已写入 `anytype_request` 参数描述）；
- **space 无乐观锁（实测）**：Anytype v2 spec 的 spaces PATCH 参数区没有 `If-Match`，space 读也不返回 etag；实测带过期 `If-Match` 的 `PATCH /v2/spaces/{id}?dry_run=true` 仍 200（服务端静默忽略）——`anytype_update_space` 因此不提供 `expected_etag`，并发改名无服务端保护。各端点能力以本地 `/v2/docs/openapi.json` 自省为准（v2 为 pre-release，未来版本可能给 spaces 补 etag）；
- **属性写边界（v2）**：`anytype_create_property` 建属性（name+format 必填，format 枚举 text|number|select|multi_select|date|files|checkbox|url|email|phone|objects，key 缺省从 name 派生，select/multi_select 可内联 options[]）；`anytype_update_property` 仅改名——PATCH 只收 name，key 是属性身份不变、format 创建后不可变；`anytype_delete_property` 归档进 Bin 可恢复（`dry_run=true` 预检）。选项词汇创建后只读：v2 没有 v1 tags 的选项改名/删色端点，也无独立 options CRUD——新选项靠 create_type/create_object 内联属性名 + `create_missing_options=true` 铸造，经 `anytype_list_property_options` 读回；
- **只读并行**：读类工具声明 `isConcurrencySafe`，可与同批读调用并行调度；
- **错误可操作**：连接失败提示「Anytype 应用未运行？」；API 错误透传 `status + code + issues + hints`——实测模型能凭错误 hint 自行纠错重试。

实测踩坑点（已固化进工具描述/参数约束）：

- `anytype_get_object` 的 `format` 只接受 `md` / `anyblock`（已做成 enum），传 `markdown` 会 400；
- `insert_blocks` 的 `markdown` 字符串里换行必须是真实换行符——写成 `\n` 字面量会被并进同一段落；精确控制层级时改传 `blocks` 块数组；
- 文件面/流式限制（已写入 `anytype_request` 描述）：multipart 上传不可发（`POST /v2/files` 仅 JSON url 形态理论可达）、`GET /v2/files/{id}/content` 二进制按文本损坏、`/messages/stream` 为 SSE 会挂至请求超时。

## 关于 anytype-cli（暂不支持的说明）

[anytype-cli](https://github.com/anyproto/anytype-cli) 是内嵌同款 anytype-heart 节点的无头实例（API 31012），理论上可作为第二后端。但实测在本机（Windows）上 `auth create` 会触发节点堆损坏静默退出（[上游 issue #63](https://github.com/anyproto/anytype-cli/issues/63)，0xC0000374，自 v0.3.7 起），bot 账户无法创建，CLI 后端暂不可用。相关支持代码已暂时移除，待上游修复后可从 git 历史（`feat/dsh-anytype-cli-backend` 分支 `00bbb57`）恢复。

## 测试

```sh
pnpm --filter @lzhida/dsh-anytype typecheck
pnpm exec vitest run packages/dsh-anytype
```

e2e（真实 dsh 实例 + 真实 Anytype）见 `.agents/skills/dsh-plugin-dev/SKILL.md` §5 四步流程；apiKey 经 test profile 的 `cordis.patch.yml` 注入（密钥不入库）。
