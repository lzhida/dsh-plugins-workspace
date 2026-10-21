# @zhidal/dsh-llm-fallback

[![npm version](https://img.shields.io/npm/v/@zhidal/dsh-llm-fallback)](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback)
[![license](https://img.shields.io/npm/l/@zhidal/dsh-llm-fallback)](./LICENSE)

dsh 的模型回退插件：拦截全局 LLM 调用，**会话页面指定的模型**（事实主模型）失败时，按回退队列自动切换到下一个 `provider/model`，**对话不中断**。配置里没有"主模型"——`fallbackChains` 就是纯回退候选队列。每个候选切换前允许的同 provider 重试次数由 `retriesBeforeSwitch` 控制（默认 0 = 自动跟随官方 `@deepseek-ai/dsh-llm-retry` 的重试预算，预算耗尽后才切换——第二道防线；自定义 N = 以插件为准，重试 N 次后切换，超出官方预算的部分由插件代执行）。

## 目录

- [特性](#特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [每候选重试次数（retriesBeforeSwitch）](#每候选重试次数retriesbeforeswitch)
- [时间窗切换与错峰优先](#时间窗切换与错峰优先)
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

- 🔄 **自动回退**——失败码命中白名单且队列还有候选时，指数退避后切换并让 loop 重发请求，对 agent 完全透明
- 🧊 **冷却跳过（优先级 × 效率平衡）**——失败候选耗尽预算切换后进入短冷却窗（`cooldownMs`，默认 5 分钟）：后续请求不再从它开始，直接改用链上下一个可用候选；窗口期满自动恢复优先级并重新验证，避免每次都从头试错拉长对话
- ⏰ **时间窗切换/错峰优先（时段计划，默认关闭）**——配置的窗口内把候选预填进冷却表（到期 = 窗口结束）请求透明切走；错峰窗口（官方半价 00:30–08:30）可反向优先 DeepSeek；窗口结束由既有惰性过期自动恢复优先级，无定时器，见[时间窗切换与错峰优先](#时间窗切换与错峰优先)
- 🤝 **与官方重试正交可调**——同 provider 重试次数按候选计（`retriesBeforeSwitch`）：默认跟随官方 `dsh-llm-retry` 预算，官方插件缺席时由本插件代执行同候选重试，预算用满再跨 provider 回退
- 🎛️ **可视化配置卡**——内嵌设置面板：勾选候选模型、排序队列、设置每候选重试次数与最大切换候选数，保存即生效，无需重载插件
- 🌐 **中英双语设置表单**——配置卡文案与 schema 字段描述跟随 dsh 语言设置（设置 → 通用 → 语言）即时切换，无需重载插件
- 🧩 **失败码路由**——只按宿主稳定失败码（`RATE_LIMIT` / `QUOTA` / `SERVER` / `TIMEOUT` / `TRANSPORT` …）决策，从不解析错误消息；鉴权类错误直接上抛、不做无谓切换
- 🔙 **零成本升级**——旧 0.2.x `string[]` 链配置自动归一为对象数组，存量自定义白名单里的旧失败码自动别名兼容；旧 `fallbackWhen` 字段被忽略、无需迁移

## 工作原理

1. 插件监听 dsh agent-loop 的两个 loop 级 waterfall：`agent/request`（发请求前）与 `agent/request-error`（请求失败后）；
2. 失败时，若失败码在白名单，按"每候选重试预算"（`retriesBeforeSwitch` × provider 重试策略合成）决策：预算内官方 retry 有决策则透传（它执行同候选重试）；预算内官方无决策则本插件代执行同候选重试（指数退避 + 轨迹事件）；预算用满且队列还有候选 → 指数退避后推进到下一候选（会话指定模型失败后切到队列第 1 项，再失败切第 2 项，依此推进；队列中与会话指定模型相同的项会被自动跳过），返回 `{kind: 'retry'}`；
3. loop 收到 retry 后重走 `agent/request`，插件把 `provider/model` 改写为新候选（代执行重试时不推进、候选不变），请求无感续发——对话不中断；
4. 失败码不在白名单或队列耗尽 → 透传上游（官方 retry / loop 默认行为），错误正常上抛；
5. 冷却跳过（默认启用）：上述切换（或链耗尽）发生时，刚失败的模型记入冷却表——冷却窗内后续 step 的首个请求若起点仍在冷却中，直接改写为链上第一个可用候选开始；窗口期满自动恢复其优先级，下次请求按正常顺序重新验证是否恢复（恢复则继续优先使用，未恢复则再次冷却）；
6. 时间窗（默认关闭）：`timeWindowEnabled` 开启后，每次请求起点先按规则把窗口内候选预填进冷却表（`block` 冷却命中 provider / `prefer` 冷却未命中 provider，到期 = 窗口结束），此后与失败冷却共用同一条跳过/改写与全冷降级路径；窗口结束由惰性过期自动恢复优先级。

## 安装

### 环境要求

- dsh 宿主 **0.2.0-rc.2+**（`agent/request` / `agent/request-error` waterfall 自 rc.2 起提供）

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

| 字段                  | 类型                                                   | 默认                            | 说明                                                                                                                      |
| --------------------- | ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `enabled`             | `boolean`                                              | `true`                          | 总开关，关闭后不再拦截模型失败                                                                                            |
| `fallbackChains`      | `Array<{provider, model, displayName?, description?}>` | `[]`                            | 纯回退候选队列（不含会话指定的主模型），失败后按序切换；旧 `string[]` 形态自动归一                                        |
| `retriesBeforeSwitch` | `number`                                               | `0`                             | 每候选切换前允许的同 provider 重试次数，见[每候选重试次数](#每候选重试次数retriesbeforeswitch)                            |
| `maxRetries`          | `number`                                               | `0`（= 链长）                   | 单次请求最多**切换候选**次数，不含同候选重试                                                                              |
| `baseDelayMs`         | `number`                                               | `500`                           | 指数退避初值；`0` = 禁用退避（失败后立即重试/切换）                                                                       |
| `maxDelayMs`          | `number`                                               | `30000`                         | 指数退避上限                                                                                                              |
| `cooldownEnabled`     | `boolean`                                              | `true`                          | 失败候选冷却跳过总开关，关闭后行为与旧版一致（每 step 都从会话模型重新开始）                                              |
| `cooldownMs`          | `number`                                               | `300000`（5 分钟）              | 失败模型的冷却窗口时长（毫秒），窗口过后自动重新验证并恢复其优先级；`0` = 立即过期（等效禁用）                            |
| `retryableCodes`      | `string[]`                                             | 见[失败码白名单](#失败码白名单) | 可触发重试/切换的失败码白名单                                                                                             |
| `perTurn`             | `boolean`                                              | `true`                          | 同一 `turn:step` 内至多切换一次候选（单次切换档）；默认 `true` = step 内允许多次切换，见[行为](#行为)                     |
| `timeWindowEnabled`   | `boolean`                                              | `false`                         | 时间窗切换/错峰优先总开关，默认关闭（开启前零行为变化），见[时间窗切换与错峰优先](#时间窗切换与错峰优先)                  |
| `timeWindowRules`     | `Array<{match, action, windows}>`                      | 官方错峰预置（见下文）          | 规则 = provider 匹配模式（`deepseek-account` / `deepseek-*` / `*`）+ 动作（`block` / `prefer`）+ `HH:mm` 半开区间窗口列表 |

配置卡功能：启用开关；从宿主模型目录（按 provider 分组）勾选回退候选，列表限高滚动并支持按 provider 分组名 / 模型 id / 显示名搜索过滤（大小写不敏感，无命中给空态）；上移 / 下移 / 移除调整回退优先级（顺序即回退顺序，会话指定的模型不在此队列中）；设置每候选重试次数与最大切换候选数；失败候选冷却跳过开关与冷却窗口时长（毫秒）；时间窗开关与规则编辑（provider 匹配 + 时段窗口，非法规则阻止保存，开启时自动填入官方错峰预置）；保存 / 放弃，带 revision 冲突检测。所有改动保存后即时生效，无需重载插件。配色接入 dsh web 主题变量（`--dsw-alias-*`），明暗模式均保持文字可读。

### 国际化（i18n）

设置表单全程跟随 dsh 的语言配置（设置 → 通用 → 语言，偏好持久化在设置命名空间 `locale` 的 `preference` 字段，缺省依次回退浏览器语言、English）：

- **配置卡文案**：中英字典经 `ctx.locale` 注册为 `llm-fallback` 命名空间，卡片订阅 locale 快照——切换语言后已打开的配置页**立即重渲染**，无需刷新或重载插件；
- **schema 字段描述**：全部字段（含 `fallbackChains` 链项的 `provider` / `model` / `displayName` / `description`）的描述均为 schemastery i18n 映射 `{ '': 英文默认, zh, en }`，随宿主 `settings.describe()` 原样下发、由前端按当前语言解析；`''` 键保证不识别映射的旧渲染端原样显示英文，行为零回归；
- **降级**：宿主组合未含 locale 服务时配置卡回退英文文案，功能不受影响。

## 每候选重试次数（retriesBeforeSwitch）

`retriesBeforeSwitch` 控制当前候选（含会话指定的主模型）在切换到下一候选前允许的同 provider 重试次数（首次失败不计入重试）：

- **`0`（默认，自动跟随官方预算）**：跟随该 provider 重试策略（`retryPolicy.maxRetries`，宿主默认 5）——官方 `dsh-llm-retry` 决定同 provider 重试时透传不动，预算耗尽后才切下一候选。provider 未注册策略（无预算信息）时视为 0，首失败即切。推荐与官方插件叠加使用。
- **`N > 0`（自定义，以插件为准）**：当前候选重试 N 次后才切下一候选，**不再被 provider 预算封顶**——N 大于官方预算时，预算内由官方 `dsh-llm-retry` 执行重试（本插件透传其决策），超出的部分由本插件代执行（自带退避与轨迹事件），直到 N 用满；N 小于预算时，会在官方仍在预算内时提前覆盖切换。自动档（0）则始终跟随 provider 侧配置——provider 的 `retryPolicy` 本身可编辑（`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`，保存即热生效），想抬天花板改那边即可。

执行者与降级：

- **官方插件在位且预算未超**：预算内由官方 `dsh-llm-retry` 执行同 provider 重试（它的退避与轨迹事件）；预算用满由本插件切换（或按 N 继续代执行）。
- **官方插件缺席 / provider 无策略 / 自定义 N 超出官方预算**：由本插件**代执行**同候选重试（自带指数退避，并写入官方 `llm/retry` / `llm/retry-started` 轨迹事件，见[轨迹可见性](#轨迹可见性)），次数同受预算约束。
- **`always` 模式策略**（无限重试、无次数可比）：自动档整体透传官方决策（永不提前切）；自定义档按 N 切，超出 N 后覆盖官方 retry。

同一 step 内计数按候选独立：切换到新候选后预算重新计满，每个候选都获得完整预算。

## 时间窗切换与错峰优先

时段计划 v2（0.6.0 起，默认关闭零迁移）：**时间窗 = 预填冷却表**。配置的窗口内，按规则把候选经既有 `markCooldown` 通道预填进失败冷却表（到期 = 窗口结束），此后走与失败冷却完全相同的跳过/改写路径——会话指定模型在冷却中时，step 起点直接改写为链上第一个可用候选（对话不中断）；窗口结束后由既有惰性过期自动恢复优先级，全程不引入定时器、不新增扫描路径。

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

- **高峰避让（改写切换，对话不中断）**：高峰窗口（08:30–00:30）内 `deepseek-*` 候选被预填冷却，会话指定模型若命中则在请求起点被改写为链上第一个可用候选；
- **错峰反向优先**：半价窗口（00:30–08:30）内把**非** `deepseek-*` 候选预填冷却——会话模型是非 DeepSeek 时改写为链内 DeepSeek 候选；会话模型已是 DeepSeek 时起点原样（起点即优先目标），若失败，失败推进的冷却感知扫描会自动跳过被冷却的非 DeepSeek 候选；
- **与冷却跳过的关系**：时间窗只借冷却表做承载，不改变失败冷却语义——同一候选可同时存在失败冷却（`now + cooldownMs`）与窗口冷却（到期 = 窗口结束），预填取**更晚到期**者、绝不缩短既有冷却；两者共用同一条「剩余候选全部在冷却中时降级回原顺序」兜底，时间窗绝不吞掉全部候选；
- `cooldownEnabled: false` 时时间窗整体不生效（预填依赖冷却通道）；
- 非法规则（空 match / 无合法 `HH:mm` 窗口）被配置卡阻止保存；手写进宿主配置的非法规则会让配置解析失败并保留上一次成功配置（与链项错误同风格）；
- 默认关闭：开启前零行为变化，存量配置零迁移。

## 失败码白名单

插件只按 `LlmFailure.code` 路由（宿主约定：route on code, never parse message）。默认白名单是宿主官方重试码（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）的超集——多出配额与上下文类，切模型正是这些失败的本职出路；另含两类**确定性失败**，同模型重试必复现，切下一候选是唯一有意义的恢复路径：`UNSUPPORTED_REASONING_EFFORT`（模型不支持所请求的 reasoning effort）与 `UNKNOWN_MODEL`（候选模型已从 provider 配置中删除或 id 变更——回退队列的[失效候选兜底](#模型目录与失效候选)）。

| 失败场景                                         | 宿主 `code`                                       | 默认可切换                            |
| ------------------------------------------------ | ------------------------------------------------- | ------------------------------------- |
| 连接类传输失败（"Connection error." / 网络中断） | `TRANSPORT`                                       | ✅                                    |
| 5xx 服务器错误                                   | `SERVER`                                          | ✅                                    |
| 429 限流                                         | `RATE_LIMIT`                                      | ✅                                    |
| 配额 / 余额耗尽                                  | `QUOTA`、`ACCOUNT_QUOTA`                          | ✅                                    |
| 上下文超限                                       | `CONTEXT_WINDOW_EXCEEDED`                         | ✅                                    |
| 空响应（正常结束但零内容块）                     | `EMPTY_RESPONSE`                                  | ✅                                    |
| 流空闲 / 请求超时                                | `TIMEOUT`                                         | ✅                                    |
| 模型不支持所请求的 reasoning effort              | `UNSUPPORTED_REASONING_EFFORT`                    | ✅ 同模型重试必复现，切可能支持的候选 |
| 候选模型已从 provider 配置删除 / id 变更         | `UNKNOWN_MODEL`                                   | ✅ 同模型重试必复现，切下一候选       |
| 鉴权 / 请求构造 / 凭据错误                       | `AUTH` / `INVALID_REQUEST` / `INVALID_CREDENTIAL` | ❌ 换模型无解，立即上抛               |
| 其他 HTTP 状态                                   | `HTTP_<status>`（如 `HTTP_502`）                  | ❌ 可自行加入白名单                   |

存量配置兼容：0.3.1 及之前版本的默认白名单误含宿主不产出的 `NETWORK` / `SERVER_ERROR`，导致连接类与 5xx 失败不触发切换；升级到 0.3.2+ 后，运行时会对你已保存的自定义白名单按并集自动补入 `TRANSPORT` / `SERVER`（旧码保留无害），无需手动改配置。

## 模型目录与失效候选

dsh 侧的模型身份是**字面 `provider/model` 路由键**：deepseek 与 pi-ai 适配器的模型条目都以 `id` 为请求路由键、`name` 仅为选择器显示名。对队列条目这意味着两种变化、两种处理：

- **显示名重命名（改 `name`，id 不变）→ 自动跟随**：队列显示名实时从宿主模型目录（`session.modelCatalog()`）解析，目录命中时显示 `name`、未命中或目录不可用时回退 `provider/model` 路由键——在 dsh 侧重命名模型后，配置卡无需重新保存即跟随新名。
- **删除模型 / 改 `id`（无稳定键，与"删除+新增"不可区分）→ 失效标记 + 显式剔除**：目录加载成功时，不在当前目录中的队列条目渲染「已失效」徽标，区块提供「清除失效项」一键清理（写入草稿，仍需保存生效）；**任何保存动作的写入载荷都会自动剔除失效条目**。目录加载失败或某 provider 的目录查询失败时保守处理——绝不误标、绝不剔除。

服务端兜底：失效候选请求会在 pi-ai 适配器构建期抛 `UNKNOWN_MODEL`（默认白名单内，见[失败码白名单](#失败码白名单)），链推进首失败即跳下一候选并留 `llm/retry` 轨迹——即使配置未在 UI 清理，运行时也不会卡死在失效候选上。插件绝不做服务端静默剔除：配置的删除只发生在你显式保存时。

## 行为

- 失败码在白名单 → 计入当前候选的失败数，按每候选重试预算决策（透传官方重试 / 代执行同候选重试 / 切下一候选，见[每候选重试次数](#每候选重试次数retriesbeforeswitch)）
- `perTurn: false`（单次切换档）：同一 `turn:step` 内至多切换一次候选——切换生效后，同 step 再次预算耗尽不再切换、透传上游决策；官方 retry 透传与预算内代执行重试不消耗名额；新 step / 新 turn 天然恢复切换名额，冷却起点改写不算切换
- 回退状态按会话隔离：step 状态键含会话标识（`agent.session.id`），多会话并发时同号 turn 的键位互不共享、新 turn 的状态清理只作用于本会话；会话标识不可得（旧宿主）时优雅降级为共享键位（见[已知限制](#已知限制)）
- 切换路径：退避 + 切下一候选 + 返回 `{kind: 'retry'}`，loop 重发请求（`agent/request` 监听器改写 `provider/model`）
- 回退推进永不切向会话指定的模型（它刚失败过）——把会话模型也勾进队列时该项被自动跳过
- 失败候选冷却：切换或链耗尽时，刚失败的模型（会话指定模型或链候选）记入冷却表（`cooldownMs`，默认 5 分钟）——冷却窗内后续 step 的首个请求若起点在冷却中，直接改写为链上第一个可用候选；窗口期满自动恢复优先级。剩余候选全部在冷却中时退回正常顺序（冷却绝不吞掉全部候选）；非白名单失败与预算内的同候选重试（透传官方 / 代执行）不记冷却；`cooldownEnabled: false` 整体关闭
- 时间窗（默认关闭）：窗口内按规则把候选预填进冷却表（`block` = 命中 provider / `prefer` = 未命中 provider，到期 = 窗口结束，宿主本地时区），与失败冷却共用跳过/降级路径，窗口结束惰性过期自动恢复优先级；`cooldownEnabled: false` 时整体不生效，见[时间窗切换与错峰优先](#时间窗切换与错峰优先)
- 失败码不在白名单或队列耗尽 → 透传上游决策（官方 retry 的 retry 也到此为止），错误正常上抛
- 切换与代执行重试均向会话轨迹写入官方 `llm/retry` / `llm/retry-started` 事件（见[轨迹可见性](#轨迹可见性)）；写轨迹失败不影响回退本体
- 退避等待期间 turn 被取消 → 立即中止等待并透传上游，不写 `llm/retry-started`
- 同时注册 system-prompt section，告知 agent 回退协议存在、无需自行"手加重试"
- 配置非法时不阻塞宿主：报错并跳过装载；设置面板存入非法值时保留上一次成功配置

## 轨迹可见性

跨 provider 回退**不再是黑盒**。切换候选与代执行同候选重试时，插件通过官方轨迹接口（`agent/request-error` payload 携带的 `agent.session.append`，与官方 `dsh-llm-retry` 同一通道）向会话日志写入两条 durable 事件：

| 事件                | 时机                            | 内容                                                                                                                                                  |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm/retry`         | 切换/代重试调度时（退避等待前） | 失败 provider、失败详情（code/message）、`retry` 序号、`maxRetries`、退避 `delayMs`、**目标模型**（`targetProvider` / `targetModel`，本插件追加字段） |
| `llm/retry-started` | 退避完成、生效前                | 同 `retryId`，标记重试真正开始                                                                                                                        |

`retry` 序号语义：切换事件记「本 step 第几次切换」（`maxRetries` = 链长上限）；代执行重试事件记「当前候选内第几次重试」（`maxRetries` = 有效预算，`target` = 被重试的候选自身）。

宿主轨迹 UI 对 `llm/retry` 有内置渲染：请求节点显示失败消息与错误码、重试进度（retry N/maxRetries）与退避时长。**切换到哪个模型**走双通道记录：① 本插件把 `targetProvider` / `targetModel` 直接写进 `llm/retry` payload（追加字段——format v4 读侧只校验已知字段的关系约束、data 整体透传，安全；当前宿主 UI 不渲染这两个字段，但在会话轨迹文件与导出数据里一眼可查）；② 宿主 loop 在切换生效后的下一次请求自动写入 `request/header` 与 `request/context`（provider/model），数据层同样留痕。

编号遵循宿主 format v4 读侧校验（同一 `(turn, step, provider, policyKey)` 内 `retry` 必须从 1 起严格连续、`retryId` 链内恒定，`(retryId, retry)` 全局唯一）：本插件按**失败 provider** 建链——同一 provider 上的代执行重试与切换事件共用一条链，`retry` 接续递增（如自动档无代执行时切换即 1；N=3 时为 1、2、3），跨 provider 各自独立从 1 起；同 provider 的连续候选（如链里同时勾了 `a/x`、`a/y`）延续同一条链。事件的 `policyKey` 固定为 `llm-fallback`，便于与官方同 provider 重试区分。

两类事件都是 log-only（不进模型上下文、不消耗 token），且复用官方已知事件类型——`Session.append` 无法标注 `ignorable`，自创事件类型会导致会话日志在恢复时被格式校验拒绝，官方词汇表是插件写入轨迹的唯一安全通道。

## 已知限制

- 自动跟随官方预算依赖 waterfall 链位：需能在 `agent/request-error` 中通过 `next()` 观察到官方 retry 的决策（以及 payload 携带的 `retryPolicy`）；自定义装载顺序导致观察不到时，自动档退化为「首失败即切」语义
- 自定义 `retriesBeforeSwitch` 超出官方预算的部分由本插件代执行——退避用本插件配置（`baseDelayMs` / `maxDelayMs`），与官方重试的退避配置（provider `retryPolicy.backoff`）不同源，两段退避曲线在切换点可能不一致
- 官方 `dsh-llm-retry` 本体无可配置项；provider 重试策略（`retryPolicy.maxRetries`，宿主默认 5）挂在 provider 适配器配置上（`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`），可在 provider 侧直接调整，自动档实时跟随
- 冷却表存于插件进程内存（按 `provider/model` 记、跨对话共享）：宿主重启 / 插件重载后清零，重启后首轮请求会重新验证全部模型；冷却仅在插件进程内生效，多实例各自独立计时
- 时间窗按**宿主机本地时区**判定：预置官方窗口以北京时间为锚（高峰 08:30–00:30 / 半价 00:30–08:30），宿主机时区非 UTC+8 时需自行换算窗口值；窗口结束的恢复依赖下次请求的惰性过期判定，无请求间隙不会主动切换
- 每 step 的回退状态以 `<会话id>:<turn>:<step>` 为 key 存内存（会话标识取自 `agent/request(-error)` payload 的 `agent.session.id`，缺失时降级为无会话段的 `turn:step` 共享键位）：新 turn 首次请求时清理**同会话**其他 turn 的旧状态，跨会话互不清理、同号 turn 互不串扰；每会话在其最末 turn 后遗留少量状态（上界 ≈ 会话数 × 单 turn step 数，每项小对象，宿主重启即清零，量级可忽略）
- 不实现 provider/* 通配条目、role/specificity 多链分派、同一 step 链耗尽后切回会话指定模型（新 step 天然从会话指定模型重新开始）

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
