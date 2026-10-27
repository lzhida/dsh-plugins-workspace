---
'@zhidal/dsh-anytype': minor
---

新增 **bundle 级配置页**：本包自带 client 半区，在 **Plugins → @zhidal/dsh-anytype**
详情页自渲染一张配置卡（注册 `plugins.bundle.config` 插槽，与 `dsh-llm-fallback`
同款），两个插件行的字段分成「Anytype 连接」与「持久记忆」两个分区——启用开关、
API 地址、密钥、Anytype-Version、请求超时、结果截断上限、10 个通用工具组开关；
记忆空间名 / 空间 id / 默认审核态 / 召回条数 / 召回 token 预算 / 向量批大小 /
5 个记忆工具组开关。保存写回 profile 的 `cordis.patch.yml`（按 id 覆盖），
手改 patch 依然有效——卡片只是更方便的入口。

**密钥改为只写**：`apiKey` 标 `role('secret')`，宿主 `settings.describe()` 把它从
下发值里剔除，只在 `secrets[]` 报「是否已设置」——卡片里的密钥框永远为空
（留空 = 不改动，**绝不**写空串清掉密钥），清除需显式写 `unset`；明文永不过线到
浏览器（此前明文随设置值下发到前端）。

**实现要点**：client 半区（`client/src/` + `scripts/build-client.ts` → esbuild 产出的
CJS factory 壳 `client/index.js`；Tailwind v4 内联 CSS，配色全走宿主
`--dsw-alias-*` token）；`configForms.whileServed(['dsh-anytype',
'dsh-anytype-memory'], …)` 做注册守卫（两行都没被宿主服务时卡片自动注销）；两行
各持一个 scope（独立 revision 栅栏 + 客户端冲突闸）；文案 zh/en 经 locale 服务
注册、语言切换即时生效。

**行为变化**：`apiKey` 不再出现在任何客户端可见的设置值中；某个插件行被禁用时
其配置分区自动隐藏；`link:` 安装前需先构建 client 产物
（`pnpm --filter @zhidal/dsh-anytype build:client`，仓库根 `pnpm install` 亦自动构建）。
