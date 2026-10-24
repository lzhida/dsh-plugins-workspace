# dsh-anytype 文档集

> **包定位（一句话）**：一个 bundle 包、两个插件行、共享一份连接配置——
> 通用 Anytype 工具（`dsh-anytype`）+ 纯本地持久记忆（`dsh-anytype-memory`），
> 外加一个留位插件行（`dsh-anytype-wiki`）。

## 本文回答什么问题

- 这个包在 dsh 的插件体系里**怎么装配**（bundle / 多插件行 / service 组合）；
- 两组文档各解决什么问题、按什么顺序读；
- 记忆子系统的统一口径（space / object / property / relation / content_hash /
  RRF / draft 态 / kind）与对应源码位置。

## 文档清单

| 文档                                    | 回答什么问题                                                                                       | 什么时候读                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| [bundle 架构](./bundle-architecture.md) | 一个包如何提供多个插件行、它们如何组合（具名 service）、连接配置如何只填一次、如何新增插件行与迁移 | 改装配、加插件行、排查「插件没加载」时 |
| [记忆文档集](./memory/README.md)        | 记忆子系统的 11 篇文档索引（架构/模型/流程/工具/索引实证/向量委派/方案审查/生态/限制/路线图）      | 想深入记忆能力本身时                   |

## 两条阅读路径

### ① 我只想把插件用起来

**读包 README 的「一个包，多个插件行」+「配置」两节** → 装包 → 在设置面板填
apiKey → 让 agent 调 `memory_setup` → `memory_write` → `memory_recall`。

想改配置字段、想知道每个工具能干什么，看 [记忆文档集 04 工具 API 契约](./memory/04-tool-api.md)。

### ② 我要在这个包里加一个插件行

**读 [bundle 架构](./bundle-architecture.md) §2（机制）与 §4（新增插件行）**：
定入口文件（`src/entries/<name>.ts`，导出 `name` / `inject` / `apply` / `Config`）
→ 在 `cordis.patch.yml` 追加一行相对路径 → 复用 `anytype` 服务拿连接 →
在包根 barrel 补导出、在 `src/index.test.ts` 补工具名唯一断言。

## 与源码的对应

| 源码位置                                           | 对应文档                                         |
| -------------------------------------------------- | ------------------------------------------------ |
| `src/entries/anytype.ts` / `src/entries/memory.ts` | [bundle 架构](./bundle-architecture.md) §2       |
| `src/services/anytype.ts`                          | [bundle 架构](./bundle-architecture.md) §2.3     |
| `cordis.patch.yml` / `package.json`                | [bundle 架构](./bundle-architecture.md) §2.1–2.2 |
| `src/memory/**`                                    | [记忆文档集](./memory/)                          |
| `src/anytype/**`                                   | 包 README 的「工具清单」与「写路径安全」         |

> 记忆文档的算法口径以实现为准（`src/memory/dedup.ts` / `src/memory/recall.ts`）。
