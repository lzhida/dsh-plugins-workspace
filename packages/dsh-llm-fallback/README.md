# @zhidal/dsh-llm-fallback

[![npm version](https://img.shields.io/npm/v/@zhidal/dsh-llm-fallback)](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback)
[![license](https://img.shields.io/npm/l/@zhidal/dsh-llm-fallback)](./LICENSE)

dsh 的模型回退插件：拦截全局 LLM 调用，**会话页面指定的模型**（事实主模型）失败时，按回退队列自动切换到下一个 `provider/model`（经官方 `agent.model.select()` 持久化，下一轮无缝生效），**对话不中断**。配置里没有"主模型"——`fallbackChains` 就是纯回退候选队列。每候选重试预算固定跟随官方 `@deepseek-ai/dsh-llm-retry`（provider 重试策略的 `maxRetries`，宿主默认 5）：预算内透传官方重试决策，预算耗尽后才切换（0.6.0 起移除插件侧自定义重试次数，旧配置残留值被宽松忽略，无需迁移）。

## 目录

- [特性](#特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [重试预算固定跟随官方](#重试预算固定跟随官方dsh-llm-retry)
- [时间窗切换与错峰优先](#时间窗切换与错峰优先)
- [候选级参数覆盖（reasoningEffort / maxTokens）](#候选级参数覆盖reasoningeffort--maxtokens)
- [角色级回退链（subagent / 角色专属候选池）](#角色级回退链subagent--角色专属候选池)
- [切换可观测性（状态面板 / 统计 / 装配守卫）](#切换可观测性状态面板--统计--装配守卫)
- [流式中途失败的行为边界](#流式中途失败的行为边界)
- [失败码白名单](#失败码白名单)
- [模型目录与失效候选](#模型目录与失效候选)
- [行为](#行为)
- [轨迹可见性](#轨迹可见性)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [开发](#开发)
- [演进路线](#演进路线)
- [许可证](#许可证)

## 特性

- 🔄 **自动回退**——失败码命中白名单且队列还有候选时，指数退避后经官方 `agent.model.select()` 切换并持久化到会话（下一轮无缝生效），对 agent 完全透明
- 🧊 **失败候选冷却（优先级 × 效率平衡）**——失败候选耗尽预算切换后进入短冷却窗（`cooldownMs`，默认 5 分钟）：后续 step 的失败推进扫描不再从它开始，直接选用链上下一个可用候选；窗口期满自动恢复优先级并重新验证，避免每次都从头试错拉长对话
- 📊 **配额感知自适应冷却**——订阅制提供商（GLM Coding Plan / MiniMax Token Plan 等）的用量窗口耗尽失败（GLM 1308/1310、MiniMax 2056 等）自动延长冷却：报错带重置时间直接采用，无重置时间用配额档（默认 5 小时，对齐用量窗口周期），受 7 天硬上限封顶；普通失败维持固定档不变，见[配额感知自适应冷却](#配额感知自适应冷却)
- 🔥 **连续失败熔断升级（默认开启）**——同一候选连续失败时冷却窗指数递增（5 分钟 → 10 分钟 → 20 分钟 …，封顶 `cooldownBreakerCapMs` 默认 30 分钟）：越顽固的故障冷却越久，不再每轮都拿 5 分钟去撞同一堵墙；冷却期满进入稳定观察期（默认 10 分钟），期间再失败则继续翻倍，观察期安静度过才恢复原优先级，见[连续失败熔断升级](#连续失败熔断升级)
- ⏱️ **限流对齐（retry-after）**——上游响应带 `retry-after` 时，冷却到期时间直接对齐服务端要求（不空转本地固定档）；宿主未透传该字段时优雅降级，见[限流对齐](#限流对齐)
- ⏰ **时间窗切换/错峰优先（时段计划，默认关闭）**——配置的窗口内把候选预填进冷却表（到期 = 窗口结束）影响失败推进的候选选择；错峰窗口（官方半价 00:30–08:30）可反向优先 DeepSeek；窗口结束由既有惰性过期自动恢复优先级，无定时器，见[时间窗切换与错峰优先](#时间窗切换与错峰优先)
- 🤝 **重试预算固定跟随官方**——同候选重试一律由官方 `dsh-llm-retry` 执行（provider 重试策略，默认 5）：预算内透传其决策，耗尽才跨 provider 回退；0.6.0 起移除插件侧自定义重试次数（0.5.0 引入的 `retriesBeforeSwitch`），见[重试预算固定跟随官方](#重试预算固定跟随官方dsh-llm-retry)
- 🎚️ **候选级参数覆盖**——链条目可配置 `reasoningEffort` / `maxTokens`：切到该候选时推理力度随官方 `agent.model.select()` 写入 selection（下一轮生效），路由到该候选的请求经 waterfall controls 覆盖单次输出上限；未配置的候选零改写、会话指定模型不勾进队列时其请求永不命中，见[候选级参数覆盖](#候选级参数覆盖reasoningeffort--maxtokens)
- 👥 **角色级回退链（0.8.0）**——按角色（`subagent` / agentPreset id）配置专属候选池：子代理与顶层会话可走不同的回退队列；未配置的角色回落全局链、旧配置零迁移，冷却跨角色共享（同一候选一处被冷却处处跳过，不会一个角色打爆另一个角色的后备），见[角色级回退链](#角色级回退链subagent--角色专属候选池)
- 📊 **切换可观测性（0.9.0）**——配置卡内置状态面板（今日计数 / 最近切换 / 装配事故 / 冷却中候选），统计按天落盘保留 14 天，旧装配守卫在切换未生效时立即告警，见[切换可观测性](#切换可观测性状态面板--统计--装配守卫)
- 🧭 **流式中途失败的行为边界**——宿主把流式中途失败归一化成 terminal finish chunk，与首 token 前失败走同一个失败事件；插件按「决策面 / 产出前 / 产出后 / 呈现侧」四条边界定稿：产出后失败同样照常切换（重试请求由宿主从零重建，失败半截不进模型上下文），插件不臆造「流已开始」判定，见[流式中途失败的行为边界](#流式中途失败的行为边界)
- 🎛️ **可视化配置卡**——内嵌设置面板：勾选候选模型、排序队列、设置最大切换候选数，保存即生效，无需重载插件
- 🌐 **中英双语设置表单**——配置卡文案与 schema 字段描述跟随 dsh 语言设置（设置 → 通用 → 语言）即时切换，无需重载插件
- 🧩 **失败码路由**——只按宿主稳定失败码（`RATE_LIMIT` / `QUOTA` / `SERVER` / `TIMEOUT` / `TRANSPORT` …）与结构化 `status` 字段（网关 408 请求超时）决策，从不解析错误消息；鉴权类错误直接上抛、不做无谓切换
- 🔙 **零成本升级**——旧 0.2.x `string[]` 链配置自动归一为对象数组，存量自定义白名单里的旧失败码自动别名兼容；旧 `fallbackWhen` 字段被忽略、无需迁移

## 工作原理

1. 插件监听 dsh agent-loop 的两个 loop 级 waterfall：`agent/request`（发请求前：selection 一律只读，仅按请求路由为命中链项补写候选级 `maxTokens` controls 覆盖，见[候选级参数覆盖](#候选级参数覆盖reasoningeffort--maxtokens)）与 `agent/request-error`（请求失败后）；两处都会先按 `agent.session.header` 解析请求归属角色，配置了 `roleChains[角色]` 时该请求的建态与推进都走角色专属链（未配置回落全局链，见[角色级回退链](#角色级回退链subagent--角色专属候选池)）；
2. 失败时，若失败码在白名单，按官方重试预算决策（固定跟随 provider 重试策略，0.6.0 起无插件侧配置）：预算内官方 retry 有决策则透传（它执行同候选重试）；预算用满（或预算内官方无决策）且队列还有候选 → 指数退避后推进到下一候选（会话指定模型失败后切到队列第 1 项，再失败切第 2 项，依此推进；队列中与会话指定模型相同的项会被自动跳过），经官方 `agent.model.select()` 持久化切换（写入 durable model/selection 事件 + 自动插 `[model changed]` user message），返回 `{kind: 'retry'}`；
3. 切换在**下一 step 生效**——selection 在 step 准备时快照，`select` 后 loop 会用旧模型重发一次请求（该次失败后本 step 不再推进，turn 以错误结束，重发消息即从新候选继续）；切换若发生在 turn 首个 step 前（如冷却期跨 step 保留的失败冷却），同样由 `select` 在下一 step 无缝生效；
4. 失败码不在白名单或队列耗尽 → 透传上游（官方 retry / loop 默认行为），错误正常上抛；
5. 失败候选冷却（默认启用）：切换（或链耗尽）发生时，刚失败的模型记入冷却表，时长按失败内容自适应（见[配额感知自适应冷却](#配额感知自适应冷却)）——冷却窗内后续 step 的失败推进扫描自动跳过冷却中的候选、直接选用第一个可用候选；窗口期满自动恢复其优先级，下次按正常顺序重新验证是否恢复（恢复则继续优先使用，未恢复则再次冷却）；
6. 时间窗（默认关闭）：`timeWindowEnabled` 开启后，每次请求起点先按规则把窗口内候选预填进冷却表（`block` 冷却命中 provider / `prefer` 冷却未命中 provider，到期 = 窗口结束），此后与失败冷却共用同一条推进扫描与全冷降级路径；窗口结束由惰性过期自动恢复优先级。

## 安装

### 环境要求

- dsh 宿主 **0.2.2-rc.1+**（`engines.dsh` 已声明，宿主兼容性校验自动拦截旧版；`agent/request` / `agent/request-error` waterfall 与 `agent.model.select()` 持久化切换均需该版本）

### npm 安装（推荐）

```sh
dsh plugin add @zhidal/dsh-llm-fallback          # 最新版
dsh plugin add @zhidal/dsh-llm-fallback@0.3.2    # 或锁定版本
```

刚发布的新版本建议用精确版本号：registry 元数据有分钟级边缘缓存，裸包名短期可能仍解析到旧版；回滚同理用 `@<version>` 锁定。已发布版本见 [npm versions](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback?activeTab=versions)。

> 首次安装可能被 pnpm 11 构建脚本闸门拦截，见[故障排查](#故障排查)。

### 仓库内开发（link）

```sh
pnpm install                                                    # 仓库根，包内 prepare 自动产出 dist
dsh plugin add link:<仓库绝对路径>/packages/dsh-llm-fallback    # link: 必须是绝对路径
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层，无需 overlay 注入。注意 pnpm 对 `link:` 安装不触发生命周期脚本，dist 必须预先存在（根 `pnpm install` 已自动构建；单独重建用 `pnpm --filter @zhidal/dsh-llm-fallback build`）。

### Git / tarball 安装

```sh
# github: 简写；<ref> 可替换为分支 / tag / 提交
dsh plugin add github:lzhida/dsh-plugins-workspace#main\&path:packages/dsh-llm-fallback
```

也支持 `git+https` / `git+ssh`（把 URL 换成对应形式即可）；`&path:<subdir>` 是 pnpm 安装 git monorepo 子目录的标准语法。git 安装时 pnpm 会执行包内 `prepare` 现场构建 dist，首次安装会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 并原样打印需要追加的 `allowBuilds` 键（注意 pnpm 示例漏了 YAML 引号，`@` 开头的键务必加引号），抄进消费 profile 的 `pnpm-workspace.yaml` 后重跑，同时固定加 `esbuild: true` 一行。

### 安装验证

1. 启动日志首行出现 `[dsh-llm-fallback] plugin loaded`；
2. 设置 → 插件 → 点开本插件，显示「已启用」+「模型回退」配置卡。

## 配置

启用插件后，在 设置 → 插件 → `@zhidal/dsh-llm-fallback` 详情页的「模型回退」配置卡中配置：

| 字段                      | 类型                                                                                 | 默认                            | 说明                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                 | `boolean`                                                                            | `true`                          | 总开关，关闭后不再拦截模型失败                                                                                                                                                    |
| `fallbackChains`          | `Array<{provider, model, displayName?, description?, reasoningEffort?, maxTokens?}>` | `[]`                            | 纯回退候选队列（不含会话指定的主模型），失败后按序切换；旧 `string[]` 形态自动归一；后两个可选字段为候选级参数覆盖，见[候选级参数覆盖](#候选级参数覆盖reasoningeffort--maxtokens) |
| `roleChains`              | `Record<role, Array<链项>>`                                                          | `{}`                            | 角色级回退链字典（0.8.0）：角色 id → 该角色专属候选链；未配置的角色回落全局 `fallbackChains`，`default` 键被忽略，见[角色级回退链](#角色级回退链subagent--角色专属候选池)         |
| `maxRetries`              | `number`                                                                             | `0`（= 链长）                   | 单次请求最多**切换候选**次数，不含同候选重试（同候选重试预算固定跟随官方，见[重试预算固定跟随官方](#重试预算固定跟随官方dsh-llm-retry)）                                          |
| `baseDelayMs`             | `number`                                                                             | `500`                           | 指数退避初值；`0` = 禁用退避（失败后立即重试/切换）                                                                                                                               |
| `maxDelayMs`              | `number`                                                                             | `30000`                         | 指数退避上限                                                                                                                                                                      |
| `cooldownEnabled`         | `boolean`                                                                            | `true`                          | 失败候选冷却跳过总开关，关闭后行为与旧版一致（每 step 都从会话模型重新开始）                                                                                                      |
| `cooldownMs`              | `number`                                                                             | `300000`（5 分钟）              | 失败模型的冷却窗口时长（毫秒），窗口过后自动重新验证并恢复其优先级；`0` = 立即过期（等效禁用）                                                                                    |
| `quotaCooldownEnabled`    | `boolean`                                                                            | `true`                          | 配额感知自适应冷却总开关，关闭后配额型失败不走配额档；仍可按 `retry-after` 或连续失败熔断递增，见[配额感知自适应冷却](#配额感知自适应冷却)                                        |
| `quotaCooldownMs`         | `number`                                                                             | `18000000`（5 小时）            | 配额型失败在报错无重置时间时的冷却档（毫秒）；`0` = 关闭配额延长（之后仍可命中 retry-after / 熔断档）                                                                             |
| `cooldownCapMs`           | `number`                                                                             | `604800000`（7 天）             | 自适应冷却时长硬上限（毫秒）：重置时间解析到极远未来时截断到这里，上限到期后重新验证、仍未恢复则再次冷却                                                                          |
| `cooldownBreakerEnabled`  | `boolean`                                                                            | `true`                          | 连续失败熔断升级总开关：开启后同候选连续失败时冷却窗指数递增，关闭后退回固定档，见[连续失败熔断升级](#连续失败熔断升级)                                                           |
| `cooldownBreakerCapMs`    | `number`                                                                             | `1800000`（30 分钟）            | 熔断递增冷却的独立上限（毫秒）：与配额档的 `cooldownCapMs`（7 天）分离；若固定档 `cooldownMs` 更长，有效上限不低于固定档                                                          |
| `cooldownStabilizationMs` | `number`                                                                             | `600000`（10 分钟）             | 熔断递增的稳定观察期（毫秒）：冷却期满后该候选进入观察期，其他未冷却候选优先接流量；没有其它可用候选时仍会半开试探；`0` = 无额外观察期，冷却窗内直接重试仍可能递增                |
| `retryableCodes`          | `string[]`                                                                           | 见[失败码白名单](#失败码白名单) | 可触发重试/切换的失败码白名单                                                                                                                                                     |
| `perTurn`                 | `boolean`                                                                            | `true`                          | 同一 `turn:step` 内至多切换一次候选（单次切换档）；默认 `true` = step 内允许多次切换，见[行为](#行为)                                                                             |
| `timeWindowEnabled`       | `boolean`                                                                            | `false`                         | 时间窗切换/错峰优先总开关，默认关闭（开启前零行为变化），见[时间窗切换与错峰优先](#时间窗切换与错峰优先)                                                                          |
| `timeWindowRules`         | `Array<{match, action, windows}>`                                                    | 官方错峰预置（见下文）          | 规则 = provider 匹配模式（`deepseek-account` / `deepseek-*` / `*`）+ 动作（`block` / `prefer`）+ `HH:mm` 半开区间窗口列表                                                         |

配置卡功能：启用开关；从宿主模型目录（按 provider 分组）勾选回退候选，列表限高滚动并支持按 provider 分组名 / 模型 id / 显示名搜索过滤（大小写不敏感，无命中给空态）；上移 / 下移 / 移除调整回退优先级（顺序即回退顺序，会话指定的模型不在此队列中）；候选行内参数覆盖（推理力度与输出上限两个可清空输入，见[候选级参数覆盖](#候选级参数覆盖reasoningeffort--maxtokens)）；设置最大切换候选数；失败候选冷却跳过开关与冷却窗口时长（毫秒）；连续失败熔断升级开关、递增上限与稳定观察期时长（毫秒）；时间窗开关与规则编辑（provider 匹配 + 时段窗口，非法规则阻止保存，开启时自动填入官方错峰预置）；保存 / 放弃，带 revision 冲突检测。所有改动保存后即时生效，无需重载插件。配色接入 dsh web 主题变量（`--dsw-alias-*`），明暗模式均保持文字可读。

### 配置存储与持久化

配置卡（设置面板）保存的字段**不落在本插件的私有文件里**——宿主把它们写进当前 profile 的补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml`，形如：

```yaml
- id: dsh-llm-fallback
  name: '@zhidal/dsh-llm-fallback'
  config:
    enabled: true
    fallbackChains:
      - provider: <provider-id>
        model: <model-id>
    maxRetries: 0
    cooldownEnabled: true
    cooldownMs: 300000
```

- **per-profile 隔离**：补丁层按 profile 分目录存放——`web` / `desktop` / `test` 各存各的，同机多 profile 的回退队列互不影响；
- **重启保留**：补丁层是宿主托管的配置文件，宿主重启、插件重载后配置仍在（设置面板的「保存」= 落盘 + 热生效两步）；
- **实测口径**：以上路径与 YAML 结构按 dsh 宿主 **0.2.2-rc.1** 的实际行为核对（其他宿主版本的补丁层实现若有差异，以实测为准）。

#### 补丁层的两个角色

「为什么第三方插件的配置会写在官方插件的配置文件里」——同一个 `cordis.patch.yml` 同时承担两件事：

1. **条目注册**：插件条目必须出现在组合树里，宿主才会加载它。本插件包内自带 bundle 层补丁（`package.json` 的 `dsh.bundle.patch` → 包内 `cordis.patch.yml`，`- insert:` 块），`dsh plugin add` 时由宿主注入，装完即在位；**未自带 bundle 层补丁的第三方插件**（以及需要额外汇总实例的 MCP 客户端等）则必须在本文件用 `- insert:` 块登记条目——注意必须 `insert`、不能平级 `- id:` 覆盖（bundle 层不存在该条目，覆盖会报 entry not found 被丢弃）；
2. **volatile 配置持久化**：设置面板保存的插件设置一律回写到同一文件同名条目的 `config:` 下（写入的是该插件完整的一份配置——volatile 字段取新值，其余字段按当前值一并固定在该层；本插件的字段全部是 volatile，故 `config:` 就是配置卡的内容）。**官方插件也不例外**——设置 → 通用 → 语言 的偏好落在同文件的 `- id: locale`（`@deepseek-ai/dsh-client-locale`）条目 `config.preference` 下（见[国际化](#国际化i18n)）。

所以这个文件是宿主的**统一用户补丁层**：官方插件与第三方插件共用它，只是条目 id 不同。

组合树按 **bundle 层 → profile 层 → home 层（`~/.dsh/cordis.patch.yml`）→ 命令行 `--patch` overlay** 依次叠加（后者覆盖前者）：bundle 层是插件包自带的补丁（随 `dsh plugin add` 注入），profile 层是本节说的用户补丁层，home 层是机器级、跨 profile 的覆盖层。**设置面板只写 profile 层**——某条目若已被 home 层或命令行 overlay 覆盖，profile 层的写入会被宿主拒绝。

**手改补丁层的适用场景**：仅限**预置配置**——例如为一批新机器预先落一份默认回退队列，或在无 UI 环境下批量部署。日常改配置一律走设置面板（带字段校验、失效候选剔除与 revision 冲突检测）；手改的文件绕过配置卡的合法性校验——写坏的值会在插件装载时被拒绝（保留上一次成功配置），见[行为](#行为)。生效方式随 profile 而异：开启 HMR 的 profile（web / desktop）会实时监听补丁层文件，改动即时重算生效；关掉 HMR 的 profile（headless / sdk / acp）需重启宿主实例。

#### `~/.dsh` 下的两类文件

| 类别         | 例子                                                                                | 谁写、是什么                                                                                |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 宿主托管配置 | `profiles/<profile>/cordis.patch.yml`                                               | 宿主 loader 读写的组合树补丁层：条目注册 + 全部插件的 volatile 配置落点（本插件配置在这里） |
| 插件自有数据 | `dsh-taskboard.json`（任务看板账本）、`storages/`（`dsh-storage` 模式的 JSON 存储） | 插件自己写自己读的业务数据，宿主不解析、不参与组合                                          |

宿主托管配置里也有两层：**profile 层**（`~/.dsh/profiles/<profile>/cordis.patch.yml`）是设置面板的唯一可写落点，本插件的配置在这里；**home 层**（`~/.dsh/cordis.patch.yml`）是机器级、跨 profile 的覆盖层，设置面板**不写**它。

本插件**不引入任何自有配置文件或数据目录**：配置只走宿主统一层（单一真相源——不存在「配置在 A 处、状态在 B 处」的双写漂移，也不在 `~/.dsh` 下撒插件私有文件），运行状态（失败候选冷却表、每 step 回退状态）只存在于插件进程内存、不落盘。取舍很清楚：**配置**要持久、要跨重启、要按 profile 隔离，交给宿主补丁层最省事；**冷却 / 健康度 / 用量**这类高频变动、随时间增长的运行状态则不适合塞进 YAML 补丁层——其持久化属于改变插件形态的远期动作（见[策略演进路线图](../../docs/llm-fallback-roadmap.md)第三档，仓库内相对链接、npm 上不可点；届时插件随之改名，不再是 fallback 语义）。

### 国际化（i18n）

设置表单全程跟随 dsh 的语言配置（设置 → 通用 → 语言，偏好持久化在设置命名空间 `locale` 的 `preference` 字段，缺省依次回退浏览器语言、English）：

- **配置卡文案**：中英字典经 `ctx.locale` 注册为 `llm-fallback` 命名空间，卡片订阅 locale 快照——切换语言后已打开的配置页**立即重渲染**，无需刷新或重载插件；
- **schema 字段描述**：全部字段（含 `fallbackChains` 链项的 `provider` / `model` / `displayName` / `description` / `reasoningEffort` / `maxTokens`）的描述均为 schemastery i18n 映射 `{ '': 英文默认, zh, en }`，随宿主 `settings.describe()` 原样下发、由前端按当前语言解析；`''` 键保证不识别映射的旧渲染端原样显示英文，行为零回归；
- **降级**：宿主组合未含 locale 服务时配置卡回退英文文案，功能不受影响。

## 重试预算固定跟随官方（dsh-llm-retry）

同候选重试一律由官方 `@deepseek-ai/dsh-llm-retry` 执行，本插件**不再提供**同候选重试次数设置（0.5.0 引入的 `retriesBeforeSwitch` 已于 0.6.0 移除，旧配置残留值被宽松解析自然忽略，无需迁移）：

- **预算 = provider 重试策略**（`retryPolicy.maxRetries`，宿主默认 5）——预算内官方 retry 的决策原样透传（由它执行同候选重试），预算耗尽后才切下一候选。provider 未注册策略（无预算信息）时按 0 处理，首失败即切。
- **`always` 模式策略**（无限重试、无次数可比）：整体透传官方决策（永不提前切）。
- provider 的 `retryPolicy` 本身可编辑（`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`，保存即热生效）——想调整同候选重试预算改那边即可。
- 同一 step 内计数按候选独立：切换到新候选后预算重新计满，每个候选都获得完整预算。

## 时间窗切换与错峰优先

时段计划 v2（0.6.0 起，默认关闭零迁移）：**时间窗 = 预填冷却表**。配置的窗口内，按规则把候选经既有 `markCooldown` 通道预填进失败冷却表（到期 = 窗口结束），此后与失败冷却共用同一条推进扫描路径——冷却中的候选被失败推进自动跳过、优先选用第一个可用候选；窗口结束后由既有惰性过期自动恢复优先级，全程不引入定时器、不新增扫描路径。

规则形态（全局窗口 + provider 匹配规则，配置薄）：

| 字段      | 说明                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `match`   | provider 匹配模式：精确 id（`deepseek-account`）、前缀通配（`deepseek-*`，含未来新增的同前缀 provider）或 `*`（全部） |
| `action`  | `block` = 窗口内冷却**命中**的 provider（高峰避让）；`prefer` = 窗口内冷却**未命中**的 provider（错峰反向优先）       |
| `windows` | `HH:mm` 半开区间 [start, end) 列表；起点 > 终点 = 跨夜回绕；相等 = 全天；按宿主机本地时区判定                         |

官方错峰预置模板（开启开关且规则为空时自动填入，也可在配置卡「填入官方模板」重填）：

```json
[
  {
    "match": "deepseek-*",
    "action": "block",
    "windows": [{ "start": "08:30", "end": "00:30" }]
  },
  {
    "match": "deepseek-*",
    "action": "prefer",
    "windows": [{ "start": "00:30", "end": "08:30" }]
  }
]
```

行为要点：

- **高峰避让（失败即切）**：高峰窗口（08:30–00:30）内 `deepseek-*` 候选被预填冷却，会话指定模型若失败，推进扫描自动跳过冷却中的候选、直接切到链上第一个可用候选；同窗口内起点冷却的跳过不再触发主动切换（0.6.0 起 request 只读），仅影响失败后的候选选择顺序；
- **错峰反向优先**：半价窗口（00:30–08:30）内把**非** `deepseek-*` 候选预填冷却——会话模型是非 DeepSeek 且失败时，推进扫描自动跳过被冷却的非 DeepSeek 候选、切向链内 DeepSeek 候选；会话模型已是 DeepSeek 时起点原样（起点即优先目标），失败推进同样不受影响；
- **与冷却跳过的关系**：时间窗只借冷却表做承载，不改变失败冷却语义——同一候选可同时存在失败冷却（`now + cooldownMs`）与窗口冷却（到期 = 窗口结束），预填取**更晚到期**者、绝不缩短既有冷却；两者共用同一条「剩余候选全部在冷却中时降级回原顺序」兜底，时间窗绝不吞掉全部候选；
- `cooldownEnabled: false` 时时间窗整体不生效（预填依赖冷却通道）；
- 非法规则（空 match / 无合法 `HH:mm` 窗口）被配置卡阻止保存；手写进宿主配置的非法规则会让配置解析失败并保留上一次成功配置（与链项错误同风格）；
- 默认关闭：开启前零行为变化，存量配置零迁移。

## 配额感知自适应冷却

订阅制提供商（GLM Coding Plan / MiniMax Token Plan 等）有 5 小时 / 每周 / 每月用量窗口，窗口耗尽后的 429 在默认 5 分钟冷却期内反复重试毫无意义。此类失败记冷却时按失败内容自适应决策时长（决策点在切换记冷却时，见 `src/quota.ts`，纯函数可单测）：

| 失败形态                                                                 | 识别依据                                                                                              | 冷却时长                                                                                                              |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 配额耗尽 + 报错携带重置时间                                              | GLM 1308/1310「您的限额将在 ${next_flush_time} 重置」、MiniMax 2056「resets at 2026-05-15T15:00:00Z」 | **重置时间 − 当前时刻**（`reported-reset`）                                                                           |
| 配额耗尽 + 无重置时间（如网关包装「已达到 Token Plan 用量上限 (2056)」） | 业务码（2056 / 1308 / 1309 / 1310）或措辞（usage limit / 用量上限 / 使用上限 / 5-hour / quota）       | **配额档 `quotaCooldownMs`**（默认 5 小时，对齐用量窗口周期，`quota-window`）                                         |
| 普通失败（瞬时限流 / 服务器错误 / 超时等）                               | 其余一切                                                                                              | **固定档 `cooldownMs`**（默认 5 分钟，`default`），之后的连续失败可能触发熔断递增；非配额型限流还可命中 `retry-after` |

识别边界与防御：

- **路由判定不读 message 的约定不变**：是否重试/切换仍完全由失败码白名单决定；message 解析只发生在「已判定可重试、预算耗尽、正在记冷却」之后，且**只影响冷却时长**——解析失败优雅降级到配额档、retry-after、熔断档或固定档，绝不影响切换主流程（宿主的配额分类只认英文措辞，中文网关文案落到 `RATE_LIMIT`，业务码只存在于 message 里，这是被动解析的唯一信息来源）；
- 仅 `QUOTA` / `ACCOUNT_QUOTA` 码直接命中配额型；`RATE_LIMIT` 码需 message 强信号（上表措辞）兜底；其余失败码均使用固定冷却档作为基线，后续连败仍可能触发熔断递增；
- **配额型失败不参与熔断递增**：配额档在决策链里排在熔断档之前，配额型失败命中 `reported-reset` / `quota-window` 档即止步，不会再按"连续失败次数"翻倍——这是刻意的：配额窗口本身就比熔断档长得多，再翻倍没有意义。熔断递增只作用于普通失败（限流 / 5xx / 超时等）；
- 重置时间解析支持 ISO 带时区（`Z` / `±HH:mm`）与 naive 本地时区（GLM 为中国服务，按宿主本地时区理解）与相对时长（`retry after 25 minutes` / `N 小时后重试`，锚定措辞防把「5-hour usage limit」窗口名误读为时长）；过去时刻视为过期信息忽略；报错不含重置关键词时不提取日期（防套餐到期日等无关日期误读）；
- 配额派生时长（`reported-reset` / `quota-window`）与 `retry-after` 对齐时长 clamp 到 `> 0` 且 ≤ `cooldownCapMs`（默认 7 天）——重置时间被解析到极远未来或上游给出异常长等待时截断到上限；熔断档则使用独立的 `cooldownBreakerCapMs`，且该 cap 不会低于固定档；
- `quotaCooldownEnabled: false` 或 `quotaCooldownMs: 0` 关闭配额延长（配额型失败不再走 `quota-window` / `reported-reset` 档，但**仍可能落熔断档**——熔断只数"连续失败次数"，不区分失败类型；连续失败到第 2 次起窗口开始翻倍）；瞬时 429 被误判的后果可控——冷却到期自动恢复优先级，且「剩余候选全部在冷却中时降级回原顺序」兜底不变，绝不吞掉全部候选；
- GLM `next_flush_time` 实际渲染格式官方文档未公布（只有占位符），按 `YYYY-MM-DD HH:mm` 通用形态覆盖，实测其他形态时补正则即可——提取失败降级配额档，仍远强于默认 5 分钟。

观察点：延长发生时插件打 `[dsh-llm-fallback] cooldown for <provider/model>: <ms> (<source>, until <ISO>)` 日志；切换轨迹事件的 `cooldownUntilMs` / `cooldownSource` 追加字段可直接查冷却到何时（见[轨迹可见性](#轨迹可见性)）。

## 连续失败熔断升级

冷却窗口固定 5 分钟有个明显缺口：某个候选是**真坏了**（模型下线、配额耗尽、网关持续 5xx）时，每隔 5 分钟就会重新撞一次同一堵墙，一次对话里反复付全额失败调用。熔断升级让**同一候选的连续失败**逐步抬高它的冷却档：

- **递增口径**：某候选**已连续失败 N 次**（N = 本次失败之前已发生的连续失败次数，0 表示从未失败或已恢复）→ 这次失败记下的冷却窗取 `cooldownMs × 2^N`（默认 5 分钟 → 10 分钟 → 20 分钟 → 40 分钟 …）。**首次失败不翻倍**（N=0 时就是固定档），因此单次偶发失败的既有行为零变化，只有"同一候选反复失败"才会被放大；
- **独立封顶**：递增结果封顶于 `cooldownBreakerCapMs`（默认 30 分钟）。它与配额档的 `cooldownCapMs`（默认 7 天）**分开**——配额耗尽是真的要用到数小时甚至数周，本地故障放大只需要"别再短时间内重试"；也正因分开，`cooldownCapMs` 不再约束熔断档的时长（熔断档只受 `cooldownBreakerCapMs` 约束）。封顶**不会把递增压回固定档之下**：若你把 `cooldownMs` 配得比 `cooldownBreakerCapMs` 还长（如 1 小时 vs 30 分钟），有效封顶取两者较大值——递增只让冷却变长、绝不缩短；
- **稳定观察期（三段恢复）**：冷却窗到期不等于立刻“完全恢复”。该候选先进入 `cooldownStabilizationMs`（默认 10 分钟）的观察期——观察期内它仍可接流量作为半开试探，但在候选扫描中**低于其它未冷却候选**；没有其它可用候选时仍会尝试它，避免链路无候选。连败计数暂不清零；期间再失败一次则计数 +1、窗口再次翻倍；观察期安静度过（不再失败）才真正清零、恢复普通优先级。这样“刚冷却完就又失败”的候选不会被立即恢复到最高优先级反复试错；
- **`cooldownStabilizationMs: 0`**：冷却窗到期即视为恢复、下一次失败重新从固定档起算；但冷却窗尚未到期时，会话指定模型仍可能被直接调用并继续累计连败（见[已知限制](#已知限制)）；
- **`cooldownBreakerEnabled: false`**：整体关闭熔断升级，全部失败回到固定档 `cooldownMs`（与 0.x 版本行为一致）；
- **判定依旧不读 message**：熔断只依赖"同一候选连续失败了几次"这一计数，不解析错误文案；
- **内存态**：连败计数与观察期跟冷却表一样存在插件进程内存，宿主重启后清零（见[已知限制](#已知限制)）。

观察点：熔断档生效时日志的 `source` 为 `breaker`（如 `[dsh-llm-fallback] cooldown for deepseek/x: 1200000ms (breaker, until ...)`），轨迹事件的 `cooldownSource` 同字段可查。

## 限流对齐（retry-after）

上游限流时通常会告诉客户端"多久之后再试"（`retry-after` 响应头）。本地冷却档再聪明也只是猜测——猜早了继续吃 429，猜晚了白白空转。插件在记冷却时优先读取宿主透传的 `LlmFailure.providerRetryAfterMs`，冷却到期直接对齐服务端要求（`source` = `retry-after`）：

- **优先级**：有 `providerRetryAfterMs` 时它压过熔断档与固定档——服务端说的就是权威；但配额延长开启且 `quotaCooldownMs > 0` 时，配额型失败先走配额档（`reported-reset` / `quota-window`），避免秒级 retry-after 绕过数小时的配额保护。若显式关闭配额延长（`quotaCooldownEnabled: false` 或 `quotaCooldownMs: 0`），配额型失败也会继续按 retry-after / 熔断 / 固定档决策；
- **仍受总上限约束**：对齐值与其它档位一样被 `cooldownCapMs`（默认 7 天）截断，避免上游给出异常长的时间戳把候选长期钉死；
- **优雅降级**：宿主未透传该字段时（当前 pi-ai 路由不产出该字段）自动落回配额档 / 熔断档 / 固定档，行为与旧版一致，绝不因为缺字段而失败；
- **同样不解析 message**：只读结构化字段 `providerRetryAfterMs`，不猜报文里的 `Retry-After:` 文本。

## 候选级参数覆盖（reasoningEffort / maxTokens）

回退队列里的每个候选可以带两个可选覆盖字段，按候选定制调用参数——不同模型对推理力度 / 输出预算的合适数值不同，统一跟随会话原值往往顾此失彼：

```yaml
fallbackChains:
  - provider: deepseek
    model: deepseek-reasoner
    reasoningEffort: high # 切到该候选时随 selection 写入(可选)
  - provider: other
    model: cheap-model
    maxTokens: 4096 # 路由到该候选的请求覆盖输出上限(可选)
```

两个字段的生效通道**由宿主事件契约决定，各走各的官方认可路径**：

- **`reasoningEffort`（模型选择维度）**：effort 是 `agent.model.select()` 的 selection 一部分（宿主禁止在 `agent/request` waterfall 里改写 selection），所以它随[切换持久化](#工作原理)生效——插件推进到该候选时，`persistModelSwitch` 把条目配置的力度（非空字符串，adapter 自有力度 id，如 `medium` / `high`）作为 `reasoningEffort` 一并传给 `agent.model.select()`，写入 durable model/selection 事件，**下一 step 生效**（与模型切换同一时机）。未配置该字段时保持旧行为：沿用切换前 selection 的 effort；
- **`maxTokens`（请求 controls 维度）**：输出上限属于 `LlmCallControls`，宿主明确允许在 `agent/request` waterfall 里调整 controls（只不允许改 provider / model / effort selection）。插件按当前请求的路由（`seed.provider` / `seed.model`）匹配链条目，命中且配置了正整数 `maxTokens` 时浅拷贝覆盖返回；**每个请求独立取候选条目的绝对值**，不基于上次写入做增量，无累积污染。会话指定模型不勾进队列时其请求永不命中——若用户把会话指定模型也勾进队列（行为节允许的配置），该模型自身的请求同样按路由命中该项的 `maxTokens` 覆盖（属显式按路由配参，语义一致）；
- **零回归**：两个字段都未配置时——切到的候选 `select` 原样沿用会话 effort、请求原样返回 `seed` 同一对象（不多产生拷贝）；旧 `string[]` 链配置归一后天然不带这两个字段；
- **合法性**：`reasoningEffort` 是 adapter 自有的不透明字符串 id（dsh-llm 类型层无全局枚举），候选不支持该力度时请求期抛 `UNSUPPORTED_REASONING_EFFORT`——该码已在默认[失败码白名单](#失败码白名单)内，自动切下一候选，无需预校验；`maxTokens` 为正整数（配置非法直接报配置错误），超出 provider 侧限制时以普通失败暴露（可能不在白名单 → 透传不切换）；
- **配置卡**：队列行内两个可清空输入（力度自由文本 / 上限正整数），清空 = 未配置；保存时未配置的候选不带这两个键（详见配置卡功能段）。

## 角色级回退链（subagent / 角色专属候选池）

全局 `fallbackChains` 是所有请求共享的一条回退队列；0.8.0 起 `roleChains` 允许**按角色配置专属候选池**——子代理用便宜快速的模型兜底、主会话保持强模型队列，互不干扰：

```yaml
fallbackChains: # 全局链(所有未配置角色的请求,含主会话)
  - provider: anthropic
    model: claude-sonnet-4
  - provider: openai
    model: gpt-4o
roleChains:
  subagent: # 角色键,该角色的请求走这条链
    - provider: openai
      model: gpt-4o-mini
    - provider: deepseek
      model: deepseek-chat
  researcher: # 任意自定义角色键(来自 agentPreset)同样支持
    - provider: anthropic
      model: claude-opus-4
```

**角色识别**：插件从宿主 `agent.session.header`（会话创建时固化的元数据）解析请求归属角色——

| 会话特征                                                    | 角色键                        |
| ----------------------------------------------------------- | ----------------------------- |
| `origin: 'subagent'` 或 `delegationDepth > 0`（子代理会话） | `subagent`（固定）            |
| 顶层会话带 `agentPreset`（如 `'researcher'`）               | preset id（如 `researcher`）  |
| 其余（普通主会话 / header 缺失 / 旧宿主）                   | `default`（走全局链，零变化） |

**链选择语义**：

- 配置了 `roleChains[角色]` 的请求从该角色链第 1 项开始推进，语义与全局链完全一致（同一套冷却/熔断/预算/参数覆盖机制）；
- 未配置的角色**回落全局 `fallbackChains`**——只配全局链的旧用户零行为变化、零迁移；
- `roleChains` 里的 `default` 键被显式忽略（全局链恒为默认角色，避免两处配置打架）；
- 链条目与全局链同构：可带 `displayName` / `description` / 候选级参数覆盖（`reasoningEffort` / `maxTokens`）；
- **候选级覆盖的查找顺序**：先查该角色自己的链（同 `provider/model` 的条目若带 `reasoningEffort` 或 `maxTokens` 即采用）；角色链条目**不带**覆盖时不遮蔽——回落全局链中同候选的覆盖。因此「角色链优先」指的是角色链**显式写了**覆盖时才压过全局链；
- **激活前提**：全局链与角色链**全空**时插件不挂监听器（无候选可推进）；只配 `roleChains`（全局链留空）同样激活——此时未配置角色的请求没有候选可用，失败即耗尽并透传，不会误切到别的角色链；
- **冷却跨角色共享**：冷却表按 `provider/model` 键，与角色无关——同一候选在角色链 A 中被冷却，角色链 B（或全局链）同样跳过它。这是有意决策：避免一个角色的流量反复打爆另一个角色的后备池；代价是角色间冷却联动（一处失败冷却,处处生效）；
- 时间窗预填同样作用于角色链（规则按 provider 匹配,窗口内角色链候选一并进冷却表）。

**边界**：角色识别依赖宿主 `session.header` 的 `origin` / `delegationDepth` / `agentPreset` 元数据（`origin` 目前是演示性元数据，见[已知限制](#已知限制)）；配置卡暂未提供角色链编辑入口——`roleChains` 经设置面板 schema 字段或 profile YAML 直接编辑，面板保存已镜像字段时不会触碰它。

## 切换可观测性（状态面板 / 统计 / 装配守卫）

0.9.0 起插件内置轻量观测面，回答三个问题：**切换发生了吗、今天谁在作妖、切换真的生效了吗**：

- **状态面板**（配置卡顶部只读区块）：展示今日尝试/失败/切换计数、装配事故数、最近切换事件（`from → to` 与失败原因）与冷却中候选数。数据经插件自有 HTTP 路由 `GET /dsh-llm-fallback/status`（本机回环，无鉴权——与宿主 webServer 其它路由同一信任边界）加载，30 秒轮询、可手动刷新；路由不可达时面板整体不渲染，不影响配置卡其余功能。
- **按天统计落盘**：`DSH_HOME/dsh-llm-fallback-usage.json`（缺省 `~/.dsh/`），按「日期 × 候选路由」聚合 attempts / failures / cooldownMarks / switches 四个计数，事件触发（失败 / 切换）+ 插件卸载兜底、5 秒去抖原子写（临时文件 + fsync + rename），保留 14 天自动修剪，损坏回落空表绝不抛。重启后按天计数恢复；最近切换环形缓冲（20 条）、装配事故计数与守卫期望表仅内存不落盘。
- **旧装配守卫**：切换经 `agent.model.select()` 持久化后，**下一 step 的首个请求**若 selection 仍是旧模型（旧装配/持久化未生效/被外部抢写），插件立即 `console.warn` 告警（`guard: selection after switch is ..., expected ...`）并计入面板「装配事故」——切换失败不再静默漂移。守卫期望是 one-shot：**新 step** 首个请求消费即清；同一 step 内官方 retry 的重入请求不消费期望（旧 step 状态本就用旧模型，不构成告警），正常生效零开销。

**数据边界**：统计仅本机内存聚合 + 本机文件落盘，无遥测、无外发；`/status` 路由只读、无写入面。

## 流式中途失败的行为边界

「流式已经吐了一半字才断」与「首 token 前就失败」是两类失败。本节是插件对它们的**边界定稿**。

**现状（宿主 0.2.2-rc.1 实测）**：宿主把适配器 / 流迭代中途的失败归一化为一个 **terminal finish chunk**（`reason.kind = 'error'`），由 agent-loop 在落盘失败 attempt 后派发 `agent/request-error`——插件**看得到**这类失败，与首 token 前失败走同一条事件。但失败对象 `LlmFailure` 只有 `message / code / status? / providerRetryAfterMs? / requestId? / offloadImages?` 六个字段，**没有任何「流已开始 / 已产出内容」的信号**，插件因此**无法区分**产出前与产出后失败。

据此定稿四条边界：

1. **决策面**：插件只在 `agent/request-error` 上做切换决策。宿主直接上抛的失败（中间件 / 嵌套调用 / 清理 / 消费者异常，以及流管线外的裸 `throw`——未经失败归一化）不经该事件，插件不介入，错误照常由宿主上抛、turn 以错误结束。
2. **产出前失败 → 正常切换**：命中白名单且预算 / 名额 / 链未耗尽时，照常退避后推进到下一候选（见[工作原理](#工作原理)）。
3. **产出后失败（流中途）→ 同路径照常切换**：既然宿主失败对象没有流状态字段，插件不臆造「流已开始」的判定；这里也不会出现竞品担心的「新模型重复已输出内容」——宿主重试请求从零重建，失败半截落在 `assistant/attempt` 轨迹事件里，**不进模型上下文**（`deriveMessages()` 只取 surface 节点），模型侧看到的是一次干净重发。
4. **呈现侧不合并**：失败 attempt 与重试 attempt 是两条并列持久记录，客户端如何呈现属宿主 UI 语义，插件不改写、不合并。

**能力缺口（需宿主侧支持，插件不臆造）**：若要把边界收窄成「产出任何可见内容后不再无感切换」，宿主需要在失败对象或事件里给出流状态信号（如 `streamStarted`）。当前 `LlmFailure` 无此字段，`usage` 在失败路径上也被丢弃，因此该粒度只能在插件之外实现。

### 「继续」唤醒评估（本插件只评估，不纳入）

竞品做法：整轮失败或撞 token 上限时自动补发一条模板化「继续」把会话唤醒续跑。**结论：不采纳**，理由三条：

- **用户每轮输入主权**：自动补发会凭空多出一轮用户消息，失败归因与用户真实意图混淆，用户也无法从会话里分辨哪条是自己说的；
- **与本插件职责错位**：插件的职责是「同一次请求内换候选」，跨轮唤醒属于 turn 编排（宿主 loop 的职责）；宿主在 turn 失败后**不自动重试**（由用户决定是否继续），插件代劳会绕过这条收尾语义；
- **失败形态不可靠**：token 上限、鉴权失败、上下文超限都以相似形态出现，误判成「该继续」会把确定性失败变成静默循环。

宿主已有官方通道可满足同类需求：`agent.followup(message)`（队列一条普通后续 turn 并唤醒 driver）、`agent.send` / `agent.steer` / `agent.inject`（后者不唤醒）——需要续跑时由上层编排显式调用即可，无需插件自动代劳。

**若将来纳入**，建议的配置形态（尚未实现）：一个默认关闭的开关 `autoContinueOnTurnFailure`，配模板化消息（默认「继续」）、仅在**候选链已耗尽且失败码属可续跑类**时触发、每轮最多补发 1 次（防循环）、补发内容进轨迹可审计，并提供总开关与次数上限；不建议在插件内默认开启。

## 失败码白名单

插件按 `LlmFailure.code` 白名单与唯一一个结构化 `status` 判定（`status === 408` 网关请求超时）路由（宿主约定：route on code, never parse message——**重试/切换路由**同样绝不解析 message；唯一例外是记冷却时的[配额感知自适应冷却](#配额感知自适应冷却)，message 解析只影响冷却时长、不影响路由）。默认白名单是宿主官方重试码（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）的超集——多出配额与上下文类，切模型正是这些失败的本职出路；另含两类**确定性失败**，同模型重试必复现，切下一候选是唯一有意义的恢复路径：`UNSUPPORTED_REASONING_EFFORT`（模型不支持所请求的 reasoning effort）与 `UNKNOWN_MODEL`（候选模型已从 provider 配置中删除或 id 变更——回退队列的[失效候选兜底](#模型目录与失效候选)）。

| 失败场景                                         | 宿主 `code`                                                                                               | 默认可切换                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 连接类传输失败（"Connection error." / 网络中断） | `TRANSPORT`                                                                                               | ✅                                                       |
| 5xx 服务器错误                                   | `SERVER`                                                                                                  | ✅                                                       |
| 429 限流                                         | `RATE_LIMIT`                                                                                              | ✅                                                       |
| 配额 / 余额耗尽                                  | `QUOTA`、`ACCOUNT_QUOTA`                                                                                  | ✅                                                       |
| 上下文超限                                       | `CONTEXT_WINDOW_EXCEEDED`                                                                                 | ✅                                                       |
| 空响应（正常结束但零内容块）                     | `EMPTY_RESPONSE`                                                                                          | ✅                                                       |
| 流空闲 / 请求超时                                | `TIMEOUT`                                                                                                 | ✅                                                       |
| 模型不支持所请求的 reasoning effort              | `UNSUPPORTED_REASONING_EFFORT`                                                                            | ✅ 同模型重试必复现，切可能支持的候选                    |
| 候选模型已从 provider 配置删除 / id 变更         | `UNKNOWN_MODEL`                                                                                           | ✅ 同模型重试必复现，切下一候选                          |
| 网关 408 请求超时（deepseek 路由）               | `HTTP_408`；网关响应体透传 `invalid_request_error` type 时为 `INVALID_REQUEST`（两形态均带 `status=408`） | ✅ 默认白名单 + `status=408` 结构化判定双通道            |
| 网关 408 请求超时（pi-ai 路由）                  | `INVALID_REQUEST`（宿主纯文本分类，不透传 `status`）                                                      | ❌ 无 `status` 可判，插件侧无解，[见故障排查](#故障排查) |
| 鉴权 / 请求构造 / 凭据错误                       | `AUTH` / `INVALID_REQUEST` / `INVALID_CREDENTIAL`                                                         | ❌ 换模型无解，立即上抛                                  |
| 其他 HTTP 状态                                   | `HTTP_<status>`（如 `HTTP_502`）                                                                          | ❌ 可自行加入白名单                                      |

**网关 408 请求超时（三态）**：OpenAI 兼容网关（如实测中返回 408 `{"code":"request_timeout","type":"invalid_request_error"}` 的 antirion-gateway）对上游超时的应答，按失败来源分三态：

- **deepseek 路由**：适配器保留 HTTP status（`failure.status = 408`），code 为 `HTTP_408`（响应体无已知 type，已入默认白名单）或 `INVALID_REQUEST`（网关响应体透传 `type: "invalid_request_error"`，白名单外）。两态均可切换——后者由 `status === 408` 的**结构化判定**兜住（只读字段、绝不解析 message，且先于白名单生效：存量自定义白名单零迁移即获得此行为）；
- **pi-ai 路由**：宿主对 pi-ai 错误纯文本分类、不透传 `status`，408 在数据面上退化为无 `status` 的 `INVALID_REQUEST`（白名单外）→ 不切换。插件按 route-on-code 原则无法从纯文本恢复 408 语义，属宿主上游缺口，见[故障排查](#故障排查)；
- **客户端超时**：dsh 客户端自身的流空闲 / 请求超时（`TIMEOUT`，白名单内）与网关形态无关，一直可切换。

存量配置兼容：0.3.1 及之前版本的默认白名单误含宿主不产出的 `NETWORK` / `SERVER_ERROR`，导致连接类与 5xx 失败不触发切换；升级到 0.3.2+ 后，运行时会对你已保存的自定义白名单按并集自动补入 `TRANSPORT` / `SERVER`（旧码保留无害），无需手动改配置。

## 模型目录与失效候选

dsh 侧的模型身份是**字面 `provider/model` 路由键**：deepseek 与 pi-ai 适配器的模型条目都以 `id` 为请求路由键、`name` 仅为选择器显示名。对队列条目这意味着两种变化、两种处理：

- **显示名重命名（改 `name`，id 不变）→ 自动跟随**：队列显示名实时从宿主模型目录（`session.modelCatalog()`）解析，目录命中时显示 `name`、未命中或目录不可用时回退 `provider/model` 路由键——在 dsh 侧重命名模型后，配置卡无需重新保存即跟随新名。
- **删除模型 / 改 `id`（无稳定键，与"删除+新增"不可区分）→ 失效标记 + 显式剔除**：目录加载成功时，不在当前目录中的队列条目渲染「已失效」徽标，区块提供「清除失效项」一键清理（写入草稿，仍需保存生效）；**任何保存动作的写入载荷都会自动剔除失效条目**。目录加载失败或某 provider 的目录查询失败时保守处理——绝不误标、绝不剔除。

服务端兜底：失效候选请求会在 pi-ai 适配器构建期抛 `UNKNOWN_MODEL`（默认白名单内，见[失败码白名单](#失败码白名单)），链推进首失败即跳下一候选并留 `llm/retry` 轨迹——即使配置未在 UI 清理，运行时也不会卡死在失效候选上。插件绝不做服务端静默剔除：配置的删除只发生在你显式保存时。

## 行为

- 失败码在白名单 → 计入当前候选的失败数，按官方重试预算决策（预算内透传官方重试 / 预算耗尽切下一候选，见[重试预算固定跟随官方](#重试预算固定跟随官方dsh-llm-retry)）
- `perTurn: false`（单次切换档）：同一 `turn:step` 内至多切换一次候选——切换生效后，同 step 再次预算耗尽不再切换、透传上游决策；官方 retry 透传不消耗名额；新 step / 新 turn 天然恢复切换名额，冷却感知的推进扫描不算切换
- 回退状态按会话隔离：step 状态键含会话标识（`agent.session.id`），多会话并发时同号 turn 的键位互不共享、新 turn 的状态清理只作用于本会话；会话标识不可得（防御路径，正常宿主不触发）时优雅降级为共享键位（见[已知限制](#已知限制)）
- 切换路径：退避 + 切下一候选 + 经官方 `agent.model.select()` 持久化切换（durable model/selection 事件 + `[model changed]` user message）+ 返回 `{kind: 'retry'}`——切换在下一 step 生效，本 step 最多再付一次旧模型调用（该次失败后本 step 透传，turn 报错结束，重发消息即从新候选继续）
- 回退推进永不切向会话指定的模型（它刚失败过）——把会话模型也勾进队列时该项被自动跳过
- 失败候选冷却：切换或链耗尽时，刚失败的模型（会话指定模型或链候选）记入冷却表，时长按失败内容自适应（普通失败 `cooldownMs` 默认 5 分钟 / 配额型延长 / retry-after 对齐 / 连续失败熔断递增，见[配额感知自适应冷却](#配额感知自适应冷却)、[连续失败熔断升级](#连续失败熔断升级)、[限流对齐](#限流对齐retry-after)）——冷却窗内后续 step 的失败推进扫描自动跳过冷却中的候选、优先选用第一个可用候选；冷却窗到期后进入稳定观察期（若熔断开启），观察期安静度过才恢复普通优先级。剩余候选全部在冷却中时退回正常顺序（冷却绝不吞掉全部候选）；非白名单失败与预算内的同候选重试（透传官方）不记冷却；`cooldownEnabled: false` 整体关闭
- 时间窗（默认关闭）：窗口内按规则把候选预填进冷却表（`block` = 命中 provider / `prefer` = 未命中 provider，到期 = 窗口结束，宿主本地时区），与失败冷却共用推进扫描/降级路径，窗口结束惰性过期自动恢复优先级；`cooldownEnabled: false` 时整体不生效，见[时间窗切换与错峰优先](#时间窗切换与错峰优先)
- 失败码不在白名单或队列耗尽 → 透传上游决策（官方 retry 的 retry 也到此为止），错误正常上抛
- 切换均向会话轨迹写入官方 `llm/retry` / `llm/retry-started` 事件（见[轨迹可见性](#轨迹可见性)）；写轨迹失败不影响回退本体
- 退避等待期间 turn 被取消 → 立即中止等待并透传上游，不写 `llm/retry-started`
- 同时注册 system-prompt section，告知 agent 回退协议存在、无需自行"手加重试"
- 配置非法时不阻塞宿主：报错并跳过装载；设置面板存入非法值时保留上一次成功配置

## 轨迹可见性

跨 provider 回退**不再是黑盒**。切换候选时，插件通过官方轨迹接口（`agent/request-error` payload 携带的 `agent.session.append`，与官方 `dsh-llm-retry` 同一通道）向会话日志写入两条 durable 事件：

| 事件                | 时机                     | 内容                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `llm/retry`         | 切换调度时（退避等待前） | 失败 provider、失败详情（code/message）、`retry` 序号、`maxRetries`、退避 `delayMs`、**目标模型**（`targetProvider` / `targetModel`，本插件追加字段）；另带**冷却决策**（`cooldownUntilMs` / `cooldownSource`，自适应冷却的观察点；`cooldownSource` 取值 `default` / `quota-window` / `reported-reset` / `retry-after` / `breaker`） |
| `llm/retry-started` | 退避完成、生效前         | 同 `retryId`，标记重试真正开始                                                                                                                                                                                                                                                                                                       |

`retry` 序号语义：切换事件记「本 step 第几次切换」（`maxRetries` = 链长上限）；同候选重试不经过本插件（0.6.0 起固定由官方 `dsh-llm-retry` 执行），不会产生本插件的重试事件。

宿主轨迹 UI 对 `llm/retry` 有内置渲染：请求节点显示失败消息与错误码、重试进度（retry N/maxRetries）与退避时长。**切换到哪个模型**走双通道记录：① 本插件把 `targetProvider` / `targetModel` 直接写进 `llm/retry` payload（追加字段——format v4 读侧只校验已知字段的关系约束、data 整体透传，安全；当前宿主 UI 不渲染这两个字段，但在会话轨迹文件与导出数据里一眼可查）；② 宿主 loop 在切换生效后的下一次请求自动写入 `request/header` 与 `request/context`（provider/model），数据层同样留痕。

编号遵循宿主 format v4 读侧校验（同一 `(turn, step, provider, policyKey)` 内 `retry` 必须从 1 起严格连续、`retryId` 链内恒定，`(retryId, retry)` 全局唯一）：本插件按**失败 provider** 建链——切换事件共享该链，`retry` 接续递增（同一 step 内第 1 次切换即 1、第 2 次即 2），跨 provider 各自独立从 1 起；同 provider 的连续候选（如链里同时勾了 `a/x`、`a/y`）延续同一条链。事件的 `policyKey` 固定为 `llm-fallback`，便于与官方同 provider 重试区分。

两类事件都是 log-only（不进模型上下文、不消耗 token），且复用官方已知事件类型——`Session.append` 无法标注 `ignorable`，自创事件类型会导致会话日志在恢复时被格式校验拒绝，官方词汇表是插件写入轨迹的唯一安全通道。

## 已知限制

- **切换时序（0.6.0 新宿主语义）**：selection 在 step 准备时快照，`agent.model.select()` 的切换在**下一 step** 生效——切换当 step 会先用旧模型重发一次请求（白名单内失败），该次失败后本 step 透传上游、turn 以错误结束，用户重发消息即从新候选继续（会话轨迹里的 `[model changed]` 提示与 durable selection 事件均已就位）。旧版 0.5.x 的「同 step 内无感续发」依赖宿主 waterfall 改写通道，该通道已被新宿主封死
- **会话指定模型的冷却起点跳过不再触发主动切换**：0.5.x 在冷却命中时于请求起点直接改写模型；0.6.0 request 只读，冷却仅影响失败推进的候选选择顺序——起点在冷却中时本 step 照常发出请求（若成功则无需切换，代价是一次失败模型的调用；失败则推进扫描直接落点可用候选）
- 自动跟随官方预算依赖 waterfall 链位：需能在 `agent/request-error` 中通过 `next()` 观察到官方 retry 的决策（以及 payload 携带的 `retryPolicy`）；自定义装载顺序导致观察不到时，自动档退化为「首失败即切」语义
- 同候选重试的退避完全由官方 `dsh-llm-retry` 控制（provider `retryPolicy.backoff`），本插件不再代执行——0.6.0 起不存在两段退避曲线拼接问题；预算耗尽后的切换退避仍用本插件配置（`baseDelayMs` / `maxDelayMs`）
- 官方 `dsh-llm-retry` 本体无可配置项；provider 重试策略（`retryPolicy.maxRetries`，宿主默认 5）挂在 provider 适配器配置上（`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`），可在 provider 侧直接调整，自动档实时跟随
- 冷却表存于插件进程内存（按 `provider/model` 记、跨对话共享）：宿主重启 / 插件重载后清零，重启后首轮请求会重新验证全部模型；冷却仅在插件进程内生效，多实例各自独立计时。配额型延长冷却（小时级乃至更长）同样受此限制——宿主重启后配额冷却丢失、按固定档重新试错，直到再次失败重新决策
- **熔断恢复是时间基而非成功事件驱动**：宿主没有向插件暴露"某候选某次请求成功"的事件，插件无法确认候选真的恢复，只能用时间窗口近似——冷却窗到期进入稳定观察期（默认 10 分钟），观察期内该候选可作半开试探，但候选扫描会优先选择其它未冷却且不在观察期的候选；没有其它可用候选时仍会尝试观察期候选。观察期内再失败则继续翻倍，安静度过才清零连败计数、恢复普通优先级。因此"恢复"实际含义是"这段时间它没再失败"；若候选恰好在观察期之外静默地坏掉，恢复后第一次失败仍按固定档计（连败计数从头开始），下一次失败才重新开始翻倍
- **会话指定模型不受冷却跳过约束**：0.6.0 起 request 只读、冷却仅影响失败推进的候选选择顺序，因此"会话正在用的模型"即使在冷却窗内被再次调用、再次失败，也会照常累计连败计数并继续翻倍（它不会像链候选那样被跳过）——这是请求起点改写通道被宿主封死的连带结果，不是熔断逻辑缺陷
- **`retry-after` 对齐依赖宿主透传**：仅 deepseek 路由的 provider 错误路径会填充 `providerRetryAfterMs`（含秒数与 HTTP 日期两种 `retry-after` 格式）；pi-ai 路由的失败对象不带该字段，限流对齐在这些 provider 上自动降级为配额档 / 熔断档 / 固定档。修复点在宿主上游（pi-ai 路由补齐该字段）
- 熔断递增的窗口倍率按**已发生的连续失败次数**计算（首次失败不翻倍），冷却与连败计数都在插件内存、宿主重启后清零（见上一条）
- 时间窗按**宿主机本地时区**判定：预置官方窗口以北京时间为锚（高峰 08:30–00:30 / 半价 00:30–08:30），宿主机时区非 UTC+8 时需自行换算窗口值；窗口结束的恢复依赖下次请求的惰性过期判定，无请求间隙不会主动切换
- 每 step 的回退状态以 `<会话id>:<turn>:<step>` 为 key 存内存（会话标识取自 `agent/request(-error)` payload 的 `agent.session.id`，缺失时降级为无会话段的 `turn:step` 共享键位）：新 turn 首次请求时清理**同会话**其他 turn 的旧状态，跨会话互不清理、同号 turn 互不串扰；每会话在其最末 turn 后遗留少量状态（上界 ≈ 会话数 × 单 turn step 数，每项小对象，宿主重启即清零，量级可忽略）
- `LlmFailure.status` 仅由 deepseek 路由的 provider 错误路径填充；pi-ai 路由对错误纯文本分类、不产出该字段——「网关 408 结构化判定」只在 deepseek 路由生效，pi-ai 路由的网关 408 退化为无 `status` 的 `INVALID_REQUEST`（白名单外、不切换）。修复点在宿主上游（408 归类为超时类失败、或在失败事件中透传 status），见[故障排查](#故障排查)
- **候选级 `reasoningEffort` 是 adapter 自有的不透明 id**：dsh-llm 类型层无全局力度枚举，合法值由各 provider/model 的模型信息决定（用户需查所选模型的文档）；未配置候选级力度时**继承切换前 selection 的 effort**（零回归语义）；仅当切换前 selection 本身不含力度（如适配器未上报）时，宿主才回落适配器默认而不继承——力度不会凭空跨候选延续；`maxTokens` 覆盖无宿主层边界校验——超出 provider 侧上限时以普通失败暴露（可能不在白名单 → 透传不切换），请按候选模型的实际上限填写
- **角色识别依赖宿主 `session.header` 元数据**：角色键取自 `origin` / `delegationDepth` / `agentPreset`，其中 `origin` 在宿主侧是演示性元数据（宿主注释自述"非可持续性证明"）——若上游调整该字段语义，子代理识别需跟随调整；header 缺失（旧宿主 / 非 agent 作用域）一律回落 `default` 全局链，绝不因角色识别失败而误切链。**冷却跨角色共享**是明确决策（见[角色级回退链](#角色级回退链subagent--角色专属候选池)）：角色间没有冷却隔离，一处失败冷却处处生效；配置卡暂无角色链编辑入口（经 schema 字段或 YAML 编辑）
- **状态路由是本机回环无鉴权面**：`GET /dsh-llm-fallback/status` 经宿主 webServer 暴露（与宿主其它路由同一信任边界——本机进程可读统计快照），无 token、无写入面；按天统计的"最近切换 / 装配事故 / 守卫期望"仅内存，宿主重启后这三者清零（按天计数从落盘文件恢复）；统计落盘文件无加密，只含候选路由键与计数（不含会话内容与会话 id，`recent` 不落盘）
- **流式中途失败无法在插件侧细分**：宿主失败对象不带「流已开始」信号（`LlmFailure` 仅六字段，失败路径上 `usage` 也被丢弃），插件对产出前 / 产出后失败一视同仁（都照常切换，理由见[流式中途失败的行为边界](#流式中途失败的行为边界)）；若要按「产出后不无感切换」收窄边界，需宿主在失败对象或事件里补流状态信号，修复点在宿主上游
- 不实现 provider/* 通配条目、同一 step 链耗尽后切回会话指定模型（新 step 天然从会话指定模型重新开始）

## 故障排查

**npm 安装报 `ERR_PNPM_IGNORED_BUILDS: esbuild`**
依赖里的 esbuild 自身 postinstall 被 pnpm 11 构建脚本闸门拦截（硬失败）。宿主会在消费 profile 的 `pnpm-workspace.yaml` 自动写入占位行，把它改成 `true` 后重跑 add：

```yaml
allowBuilds:
  esbuild: true
```

**重跑 add 后插件不激活**
首次 add 中途失败会留下依赖但丢失 bundles 注册（重跑走「已安装」短路，不会补写）。先 `dsh plugin --profile <name> remove @zhidal/dsh-llm-fallback` 再重新 add；或手动把包名加进 profile `package.json` 的 `dsh.profile.bundles` 数组。

**add 解析到旧版本**
registry 元数据分钟级边缘缓存。安装 / 升级 / 回滚都用精确版本号 `@zhidal/dsh-llm-fallback@<version>`。

**升级插件 / 修改冷却配置后行为不变（如冷却未生效）**
宿主进程在**启动时**加载插件代码与配置，运行中不感知 profile 的 `package.json`（插件升级）与 `cordis.patch.yml`（配置修改）变更——**升级插件或修改冷却配置后，必须重启宿主（或重启对应 profile 实例）才生效**，否则运行的仍是旧代码 / 旧配置。判别方法：对比宿主进程启动时刻与插件安装 / 配置修改时刻，前者早于后者即未生效。真实案例（2026-10-27）：宿主 10:32 启动时 profile 里是 0.4.0（无冷却功能），17:30 才升级 0.5.0 并修改冷却配置，当晚所有会话的冷却全程未生效（每 step 重复打已失败模型），直到重启宿主；轨迹特征是 `llm/retry` 切换事件照常出现（`policyKey: "llm-fallback"`）但已失败模型不被跳过——该特征说明运行版本不含冷却逻辑，而非冷却实现缺陷。

**补丁层里残留 `fallbackWhen: afterRetry`（0.2.x 旧字段）**
无害，可以放着不管。该字段是 0.2.x 的两档回退时机开关（`afterRetry` / `immediately`），0.6.0 起连同 `retriesBeforeSwitch` 一并废弃（同候选重试预算固定跟随官方，见[重试预算固定跟随官方](#重试预算固定跟随官方dsh-llm-retry)）；插件读配置时**不认识这个键、也不会迁移它**——它留在 profile 补丁层里，既不影响行为（不报错、不改变切换时机），也不会被自动清除。这正是 README[特性](#特性)里「零成本升级」承诺的兑现形态：旧字段留着不用管，新逻辑照常生效。介意补丁层里有多余一行可手工删掉，但删除纯属美观，与正确性无关。

**网关 408 请求超时，官方重试 5/5 耗尽后失败、插件未切换**
在会话轨迹里找到该失败事件的 `code`（以及有无 `status` 字段），按结果分叉：

- **轨迹无本插件的 `llm/retry` 事件、`code` 为 `INVALID_REQUEST` 且无 `status`**：pi-ai 路由的网关 408——宿主纯文本分类不透传 status，插件按 route-on-code 原则无法把这条失败识别为超时，属宿主上游缺口，插件侧无解。临时逃生：把 `INVALID_REQUEST` 手动加进 `retryableCodes` 白名单——**不推荐**：`INVALID_REQUEST` 同时覆盖真正的请求构造错误（参数 / 消息形态问题），它们对同一模型确定性复现，加白后这类错误会被无意义地重试与切换，拖慢失败反馈并浪费配额；优先推动宿主上游修复（408 归类为超时类失败、或透传 status）。
- **轨迹有 `llm/retry` 事件但最终仍失败**：不是白名单问题——候选链已切完（`maxRetries` 上限）。检查 `fallbackChains` 是否配置了候选；同候选重试预算固定跟随官方（provider 重试策略，默认 5），想调整去 provider 适配器配置改 `retryPolicy`。
- **deepseek 路由的网关 408**：失败带 `status=408`（无论 `code` 是 `HTTP_408` 还是 `INVALID_REQUEST`），由结构化判定放行、与白名单配置无关——本版本起应能正常切换；若未切换，先确认插件已升级，再按上一条检查候选链与预算。

## 开发

```sh
pnpm install                                 # 仓库根，包内 prepare 自动产出 dist 与 client 产物
pnpm test                                    # vitest 全仓测试
pnpm typecheck                               # 递归 tsc --noEmit
pnpm --filter @zhidal/dsh-llm-fallback build # 单独重建 dist 与 client 产物
```

**为什么入口是 dist**：dsh 宿主经 Node 原生 type-stripping 加载 TS 插件，而 Node 硬性拒绝转译 realpath 位于任何 node_modules 之下的 `.ts` 文件（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），纯 TS 源码入口在 git/npm/tarball 实体安装下必然加载失败。本插件因此以 esbuild 打包 `dist/index.js` 单文件发行（内联运行时依赖），源码仍是 `src/*.ts`；git 安装依赖包内 `prepare` 现场构建，消费方需按 pnpm 要求放行构建脚本（见上文）。其他 TS 插件如需支持实体安装，照此模式改造。

**客户端半区（配置卡）**：源码在 `client/src/`（TSX 组件化 + hooks + 纯函数分层，React 仅作 devDependency 供类型与测试），经 `scripts/build-client.ts`（esbuild JS API）打包为惰性 CJS 注册壳 `client/index.js` 并随包提交——产物顶层只有 `globalThis.__ModuleLoader__.load({ id, factory })`，整个模块体（含 react 解析）都在 factory 闭包内，react 保持 external 经宿主模块表注入（绝不可打第二份 React）。`id` 由构建脚本从 package.json 读取，与 keyed 插槽 key（`PKG_NAME` 常量）共同受 `src/client-bundle.test.ts` 契约断言保护；组件行为另有 jsdom 渲染冒烟测试（`client/src/components/FallbackCard.test.tsx`）。改动 client 源码后重跑 `build` 并连同产物一起提交。

## 演进路线

时段限制、成本路由、健康度路由等后续策略维度的盘点（市场调研、可行性判据、推荐排序）与立项决策清单，见仓库根目录的 [`docs/llm-fallback-roadmap.md`](../../docs/llm-fallback-roadmap.md)（仓库内相对链接，npm 上不可点）。

## 许可证

[MIT](./LICENSE)
