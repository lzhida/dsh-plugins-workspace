# @lzhida/dsh-llm-fallback

dsh-llm-fallback 插件:拦截 dsh 全局 LLM 调用,按 `fallbackChains` 在主模型失败时自动切换到下一个候选 `provider/model`,**对话不中断**。默认在官方 `@deepseek-ai/dsh-llm-retry` 重试预算耗尽(原本会直接把错误抛给 loop、结束轮次的位置)后才切换,作为同 provider 重试之后的第二道防线;也可配置为一次失败立即切换。

> 历史说明:本插件曾短期提取为独立仓库 `lzhida/dsh-llm-fallback`,现已回归 monorepo 并带上该仓库期间的 `fallbackWhen` 增强;独立仓库不再维护。

## 适配版本

| 组件     | 版本           | 说明                                                                                                                       |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 宿主 dsh | **0.2.0-rc.2** | `agent/request` 与 `agent/request-error` waterfall 在 rc.2 提供;`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已放行 |
| 插件包   | 0.3.0          | 0.3.0 起 `fallbackChains` schema 升级为对象数组(带 `displayName` / `description`),旧 `string[]` 形态自动归一               |

## 安装

`dsh plugin add` 底层是 `pnpm add`,支持本地目录、`github:` / `git+https` / `git+ssh` / tarball 等多种源。

### 仓库内开发(本地 link)

```sh
pnpm install                     # 仓库根
dsh plugin add link:packages/dsh-llm-fallback
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层,无需 overlay 注入。

### Git 安装(外部用户)

四种形式等价,都只装 `packages/dsh-llm-fallback` 子目录。`<ref>` 替换为想锁定的分支 / tag / 提交:

```sh
# 1. github: 简写(pnpm 8+ 解析为 https://github.com/<user>/<repo>/tarball/<ref>)
dsh plugin add github:lzhida/dsh-plugins-workspace#main\&path:packages/dsh-llm-fallback

# 2. git+https(显式完整 URL,需 git 客户端)
dsh plugin add git+https://github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-llm-fallback

# 3. git+ssh(需本机配过 SSH key)
dsh plugin add git+ssh://git@github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-llm-fallback

# 4. tarball 快照
curl -L https://github.com/lzhida/dsh-plugins-workspace/archive/refs/heads/main.tar.gz | tar -xz -C /tmp
dsh plugin add /tmp/dsh-plugins-workspace-main/packages/dsh-llm-fallback
```

> `&path:<subdir>` 是 pnpm 安装 git monorepo 子目录的标准语法(`#<ref>&path:<dir>`,把 ref 与 subdir 用 `&` 分隔)。

## 配置

启用插件后,在 dsh 设置面板中找到 "llm-fallback" section(由插件通过 schemastery schema 投影),可配置以下字段:

| 字段             | 类型                                                   | 默认                                                                                                               | 说明                                                        |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `enabled`        | `boolean`                                              | `true`                                                                                                             | 总开关                                                      |
| `fallbackChains` | `Array<{provider, model, displayName?, description?}>` | `[]`                                                                                                               | 候选列表;首项 = 主模型,逐个回退。旧 `string[]` 形态自动归一 |
| `fallbackWhen`   | `'afterRetry' \| 'immediately'`                        | `'afterRetry'`                                                                                                     | 回退时机,见下节                                             |
| `maxRetries`     | `number`                                               | `0`(= 链长,即全跑完才报错)                                                                                         | 单次请求最多**切换**次数                                    |
| `baseDelayMs`    | `number`                                               | `500`                                                                                                              | 指数退避初值                                                |
| `maxDelayMs`     | `number`                                               | `30000`                                                                                                            | 指数退避上限                                                |
| `retryableCodes` | `string[]`                                             | `RATE_LIMIT / QUOTA / ACCOUNT_QUOTA / CONTEXT_WINDOW_EXCEEDED / EMPTY_RESPONSE / SERVER_ERROR / TIMEOUT / NETWORK` | 视为可重试的稳定失败码白名单                                |
| `perTurn`        | `boolean`                                              | `true`                                                                                                             | 是否在同 step 内允许回退                                    |

### 设置界面(内嵌配置卡)

dsh 0.2.0-rc.2 没有 schema→表单的通用自动渲染;配置 UI 由本插件**自带的 client bundle**(`client/index.js`,零构建)注册进插件管理页的 `plugins.bundle.config` 插槽,直接**内嵌在本插件的详情页里**(设置 → 插件 → 点开 `@lzhida/dsh-llm-fallback`):

- **模型勾选**:候选池来自 `remote.session.modelCatalog()`(宿主已配置 provider 的模型目录,按 provider 分组),勾选即加入队列;
- **排序**:已选队列支持上移/下移/移除,顺序即回退优先级(首项 = 主模型);
- **最大回退次数**(`maxRetries`,0 = 链长)与**回退时机**(`fallbackWhen`);
- 保存 / 放弃,带 revision 冲突检测(`SETTINGS_CONFLICT` 时提示重试)。

读写走 `ctx.configForms.get('<条目id>')` → `mutate(...)`,持久化到 profile 的 cordis patch 层。所有可编辑字段在服务端 schema 上标记 `.volatile()`——宿主 `dsh-settings.describe()` 只投影 volatile 字段,没有 volatile 字段的插件不会出现在设置面板。

`fallbackChains` schema 同时挂 `role('modelList', { source: 'dsh-llm-runtime' })`,保留给未来可能出现的通用渲染器;当前 UI 不依赖它。

### Schema 迁移(0.2.x → 0.3.0)

旧版本 `fallbackChains` 形态是 `string[]`,每项为 `"provider/model"`。0.3.0 起改为 `Object[]`,但 `resolveConfig` **自动归一**:

- 旧 `['deepseek/deepseek-chat', 'openai/gpt-4o']` → 自动转为 `[{provider:'deepseek', model:'deepseek-chat', displayName:'deepseek/deepseek-chat', description:''}, ...]`
- 新 `[{provider:'openai', model:'gpt-4o', displayName:'GPT-4o'}]` → 原样保留
- 混形态(`['a/x', {provider:'b', model:'y'}]`)→ 逐项归一
- 持久化形态(写到 `cordis.yml` / settings)是 `Object[]`;旧 `string[]` 配置被运行时归一为对象后,首次写回也是对象

**无 breaking change**:旧 `string[]` 配置继续可用,无需手动改。

## 回退时机(`fallbackWhen`)

- **`afterRetry`(默认)**:失败发生时先观察官方 `dsh-llm-retry` 的决策——它仍在预算内(或配置为 always mode)决定同 provider 重试 → 透传其决策,本插件不动;只有它放弃(预算耗尽 / 委派下游 / 未装载该插件)且失败码在白名单内 → backoff + 切下一候选。推荐与官方插件叠加使用,语义为"先同 provider 重试,再跨 provider 回退"。
- **`immediately`**:白名单命中即切,不等官方重试跑完。恢复最快,但请求数可能更多(适合没装官方 retry 插件、或希望立刻换家的场景)。

注意:`maxRetries` 约束的是**链上切换次数**,不含官方插件的同 provider 重试次数。

## 行为

- 监听 `agent/request` 与 `agent/request-error`(dsh-agent-loop 提供的 loop-level waterfall),与 `@deepseek-ai/dsh-llm-retry` 正交可叠加
- 失败码在白名单 + 按时机判定可切 + 还有下一候选 → backoff + 切下一候选 + 返回 `{kind: 'retry'}`,loop 重新发起请求(`agent/request` 监听器改写 `provider/model`)
- 失败码不在白名单 → 透传给宿主(官方 retry / loop 走默认行为)
- 链耗尽 → 透传上游决策(官方 retry 的 retry 也到此为止,错误正常上抛)
- 同时注册 system-prompt section,告知 agent 回退协议存在、不要自行"手加重试"

## 装好后的手工验证

```sh
# 1. 确认子包已装入 profile node_modules
ls "$(dsh config profile-dir 2>/dev/null || echo $HOME/.dsh/profiles/<name>)/node_modules/@lzhida/dsh-llm-fallback"

# 2. 重启 dsh,在 设置 → 插件 → @lzhida/dsh-llm-fallback 详情页确认
#    内嵌「模型回退」配置卡(勾选模型 / 排序 / 最大次数 / 保存)

# 3. 启动日志应有 [dsh-llm-fallback] plugin loaded 一行(e2e 契约)
```

## 已知限制

- `afterRetry` 时机依赖 waterfall 链位:本插件需能在 `agent/request-error` 中通过 `next()` 观察到官方 retry 的决策(正常装载顺序下两者天然正交;若自定义装载顺序导致观察不到,回退行为退化为 `immediately` 语义)
- 不实现 provider/* 通配条目、role/specificity 分派链
- 不实现"跨回合切回主 model"(本期仅在请求内回退)
