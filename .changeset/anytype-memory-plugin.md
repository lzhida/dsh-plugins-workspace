---
'@zhidal/dsh-anytype': minor
---

重构为**单包 bundle、多个插件行**的形态：把原先三个包（`dsh-anytype` / `dsh-anytype-core` / `dsh-anytype-memory`）合并为一个 `@zhidal/dsh-anytype`，装一次即激活两个插件行，连接配置只填一次。

**bundle 装配**：`package.json` 声明 `dsh.bundle.patch` → 包被 `dsh plugin add` 装成 profile 的 **bundle 层**，其 `cordis.patch.yml` 作为一层自动叠加——**profile 侧不再需要手写 `insert:` 行**（此前 plain dependency 装上后静默不加载、必须手写 insert 的痛点消除）。patch 里的 `name` 用**相对路径**（`./src/entries/anytype.ts` / `./src/entries/memory.ts`），loader 会转成 file URL，故一个包内可放多个插件入口，各自导出 `name`/`apply`/`Config`，且与包被装到哪儿无关。

**插件行与组合**：

- 插件行① `dsh-anytype`（30 个 `anytype_*` 工具）注册具名服务 `anytype`（`ctx.provide`），持**配置现读**的 Anytype 客户端；
- 插件行② `dsh-anytype-memory`（16 个 `memory_*` 工具）以 `inject: ['tools','systemPrompt','anytype']` 复用同一个客户端——**apiKey/baseUrl 等连接类配置只在插件行①出现一次**，记忆行只剩语义类配置（空间/预算/默认审核态/工具组开关）；
- 插件行③ `dsh-anytype-wiki` **留位**（LLM Wiki 知识编译管道，本次不注册）。

**包内结构**：`src/core/`（共享底座：客户端 + 工具公共设施 + volatile 支持）、`src/services/anytype.ts`（具名服务）、`src/entries/{anytype,memory,wiki}.ts`（插件行）、`src/anytype/`（通用工具实现）、`src/memory/`（记忆域实现）、`src/cordis.d.ts`（`Context.anytype` 类型增强）、`src/index.ts`（包根 barrel）、`docs/bundle-architecture.md` + `docs/memory/`（11 篇）。

**行为变化**：记忆插件不再持有连接配置（改为复用服务）；`memory_doctor` 报告的 `base_url` 改从共享客户端读取。`@zhidal/dsh-anytype-core` 与 `@zhidal/dsh-anytype-memory` 两个包取消（均为未发布的 private 包；原 `core` 内容内联为 `src/core/`，并经 `exports["./core"]` 对外暴露）。
