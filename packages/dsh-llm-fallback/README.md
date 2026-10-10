# @lzhida/dsh-llm-fallback

dsh-llm-fallback 插件:拦截 dsh 全局 LLM 调用,按 `fallbackChains` 在主模型失败时自动切换到下一个候选 `provider/model`,**对话不中断**。默认在官方 `@deepseek-ai/dsh-llm-retry` 重试预算耗尽(原本会直接把错误抛给 loop、结束轮次的位置)后才切换,作为同 provider 重试之后的第二道防线;也可配置为一次失败立即切换。

> 历史说明:本插件曾短期提取为独立仓库 `lzhida/dsh-llm-fallback`,现已回归 monorepo 并带上该仓库期间的 `fallbackWhen` 增强;独立仓库不再维护。

## 适配版本

| 组件     | 版本           | 说明                                                                                                                       |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 宿主 dsh | **0.2.0-rc.2** | `agent/request` 与 `agent/request-error` waterfall 在 rc.2 提供;`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已放行 |
| 插件包   | 0.3.0          | 0.3.0 起 `fallbackChains` schema 升级为对象数组(带 `displayName` / `description`),旧 `string[]` 形态自动归一               |
| 发行形态 | 构建式 dist    | 入口为 esbuild 打包的 `dist/index.js`(内联运行时依赖);`prepare`/`prepack` 自动构建,详见下节                                |

## 安装

`dsh plugin add` 底层是 `pnpm add`,支持本地目录、`github:` / `git+https` / `git+ssh` / tarball 等多种源。

### 为什么入口是 dist(构建式发行)

dsh 0.2.0-rc.2 宿主加载 TS 插件走 Node 原生 type-stripping(cordis-plugin-loader → `ctx.loader.internal.import`),而 Node 硬性拒绝转译 **realpath 位于任何 node_modules 目录之下**的 `.ts` 文件(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`)。因此纯 TS 源码入口在 git/npm/tarball 等**实体安装**方式下必然加载失败(宿主 `inactiveEntries()` 只报静默的 `failed to import`,真实错误被吞),只有 `link:` 安装(junction 解析回工作区,realpath 不含 node_modules)可用。

本插件入口因此改为 esbuild 打包的 **`dist/index.js`** 单文件(内联 schemastery 等运行时依赖,安装后无需再解析依赖树)。源码仍是 `src/*.ts`(类型检查/测试用),`main`/`exports` 指 dist,`types` 仍指 `src/cordis.d.ts`。

> **宿主上游问题**(理想修法在宿主侧):宿主改用自带转译器(amaro / esbuild register)加载插件 TS,即可根治所有纯 TS 插件的实体安装。一键复现:
>
> ```sh
> # 实体目录安装 → 必报 ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING
> node --input-type=module -e "import('file:///<profile-dir>/node_modules/@lzhida/dsh-llm-fallback/src/index.ts').then(m => console.log('OK', m.name)).catch(e => console.error(e.code))"
> # link 安装 → OK dsh-llm-fallback
> ```

### 仓库内开发(本地 link)

```sh
pnpm install                     # 仓库根;根 install 会执行包内 prepare 自动产出 dist
dsh plugin add link:packages/dsh-llm-fallback
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层,无需 overlay 注入。

注意:`link:` 安装**不触发任何生命周期脚本**(pnpm 对 link: 不跑 prepare),dist 必须预先存在。根 `pnpm install` 已自动构建;单独重建用 `pnpm --filter @lzhida/dsh-llm-fallback build`。e2e 运行器(`.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts`)检测到 `scripts.build` 也会自动构建。

### Git 安装(外部用户)

> **前置条件**:git 安装时 pnpm 会执行包内 `prepare` 现场构建 dist;pnpm 11 默认拦截依赖生命周期脚本,且对 **git 托管依赖**要求「精确包 id + 锁定 sha」形态的放行键。首次安装会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 并**原样打印需要追加的键**——把该行抄进**消费 profile** 的 `pnpm-workspace.yaml`(桌面版在 `~/.dsh/profiles/desktop/pnpm-workspace.yaml`)后重跑 add:
>
> ```yaml
> allowBuilds:
>   # ← 抄 pnpm 报错打印的那行;注意 pnpm 示例漏了 YAML 引号:
>   #   `@` 开头的键不加引号是非法 YAML,务必形如 '<pkg>@<git-url>#<sha>': true
>   '@lzhida/dsh-llm-fallback@git+https://github.com/lzhida/dsh-plugins-workspace#<sha>': true
>   esbuild: true # esbuild 自身 postinstall(二进制校验),固定加这行
> ```
>
> 插件更新(git ref 解析到新 sha)后,闸门会再次报错并打印新键,同步替换旧键即可。

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

> 形态 4 是目录直装:若安装后 profile 内缺 `dist/`(该形态不保证触发生命周期脚本),先在源码树仓库根跑一次 `pnpm install`(或 `pnpm --filter @lzhida/dsh-llm-fallback build`)再装。
>
> **tarball(`pnpm pack` 产物)是最省事的实体形态**:tgz 自带新鲜 dist(prepack 在打包前执行),消费 profile 只需 `allowBuilds: { esbuild: true }` 一行(esbuild 自身 postinstall),无 sha 键、无更新漂移。

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

- **TS 源码插件的宿主级限制**:见「为什么入口是 dist」——在宿主改用自带转译器加载 TS 之前,任何纯 TS 源码插件(guided-goal / obsidian / taskboard 等)以实体方式安装都会 `failed to import`,与本项目无关的宿主问题
- `afterRetry` 时机依赖 waterfall 链位:本插件需能在 `agent/request-error` 中通过 `next()` 观察到官方 retry 的决策(正常装载顺序下两者天然正交;若自定义装载顺序导致观察不到,回退行为退化为 `immediately` 语义)
- 不实现 provider/* 通配条目、role/specificity 分派链
- 不实现"跨回合切回主 model"(本期仅在请求内回退)
