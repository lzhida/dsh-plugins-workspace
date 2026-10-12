# @zhidal/dsh-llm-fallback

[![npm version](https://img.shields.io/npm/v/@zhidal/dsh-llm-fallback)](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback)
[![license](https://img.shields.io/npm/l/@zhidal/dsh-llm-fallback)](./LICENSE)

dsh 的模型回退插件：拦截全局 LLM 调用，主模型失败时按候选链自动切换到下一个 `provider/model`，**对话不中断**。默认在官方 `@deepseek-ai/dsh-llm-retry` 同 provider 重试预算耗尽后才切换（第二道防线），也可配置为一次失败立即切换。

## 目录

- [特性](#特性)
- [工作原理](#工作原理)
- [安装](#安装)
- [配置](#配置)
- [回退时机（fallbackWhen）](#回退时机fallbackwhen)
- [失败码白名单](#失败码白名单)
- [行为](#行为)
- [已知限制](#已知限制)
- [故障排查](#故障排查)
- [开发](#开发)
- [许可证](#许可证)

## 特性

- 🔄 **自动回退**——失败码命中白名单且还有下一候选时，指数退避后切换并让 loop 重发请求，对 agent 完全透明
- 🤝 **与官方重试正交**——默认先同 provider 重试（官方 `dsh-llm-retry`），预算耗尽再跨 provider 回退（本插件），两者可叠加
- 🎛️ **可视化配置卡**——内嵌设置面板：勾选候选模型、排序队列、设置回退次数与时机，保存即生效，无需重载插件
- 🧩 **失败码路由**——只按宿主稳定失败码（`RATE_LIMIT` / `QUOTA` / `SERVER` / `TIMEOUT` / `TRANSPORT` …）决策，从不解析错误消息；鉴权类错误直接上抛、不做无谓切换
- 🔙 **零成本升级**——旧 0.2.x `string[]` 链配置自动归一为对象数组，存量自定义白名单里的旧失败码自动别名兼容

## 工作原理

1. 插件监听 dsh agent-loop 的两个 loop 级 waterfall：`agent/request`（发请求前）与 `agent/request-error`（请求失败后）；
2. 失败时，若失败码在白名单、按 `fallbackWhen` 判定可切、且链上还有下一候选 → 指数退避后推进到下一候选，返回 `{kind: 'retry'}`；
3. loop 收到 retry 后重走 `agent/request`，插件把 `provider/model` 改写为新候选，请求无感续发——对话不中断；
4. 失败码不在白名单或链耗尽 → 透传上游（官方 retry / loop 默认行为），错误正常上抛。

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

| 字段             | 类型                                                   | 默认                            | 说明                                                          |
| ---------------- | ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------- |
| `enabled`        | `boolean`                                              | `true`                          | 总开关，关闭后不再拦截模型失败                                |
| `fallbackChains` | `Array<{provider, model, displayName?, description?}>` | `[]`                            | 候选列表，首项 = 主模型，逐个回退；旧 `string[]` 形态自动归一 |
| `fallbackWhen`   | `'afterRetry' \| 'immediately'`                        | `'afterRetry'`                  | 回退时机，见[回退时机](#回退时机fallbackwhen)                 |
| `maxRetries`     | `number`                                               | `0`（= 链长）                   | 单次请求最多**切换**次数，不含官方重试的同 provider 重试      |
| `baseDelayMs`    | `number`                                               | `500`                           | 指数退避初值                                                  |
| `maxDelayMs`     | `number`                                               | `30000`                         | 指数退避上限                                                  |
| `retryableCodes` | `string[]`                                             | 见[失败码白名单](#失败码白名单) | 可触发切换的失败码白名单                                      |
| `perTurn`        | `boolean`                                              | `true`                          | 预留字段，尚未参与回退判定，见[已知限制](#已知限制)           |

配置卡功能：启用开关；从宿主模型目录（按 provider 分组）勾选候选模型，列表限高滚动并支持按 provider 分组名 / 模型 id / 显示名搜索过滤（大小写不敏感，无命中给空态）；上移 / 下移 / 移除调整回退优先级（顺序即回退顺序，首项 = 主模型）；设置最大回退次数与回退时机；保存 / 放弃，带 revision 冲突检测。所有改动保存后即时生效，无需重载插件。配色接入 dsh web 主题变量（`--dsw-alias-*`），明暗模式均保持文字可读。

## 回退时机（fallbackWhen）

- **`afterRetry`（默认）**：失败发生时先观察官方 `dsh-llm-retry` 的决策——它决定同 provider 重试则透传不动；只有它放弃（预算耗尽 / 委派下游 / 未装载）且失败码在白名单内，才退避后切下一候选。推荐与官方插件叠加使用，语义为「先同 provider 重试，再跨 provider 回退」。
- **`immediately`**：白名单命中即切，不等官方重试跑完。恢复最快，但请求数可能更多——适合没装官方 retry 插件、或希望立刻换家的场景。

## 失败码白名单

插件只按 `LlmFailure.code` 路由（宿主约定：route on code, never parse message）。默认白名单是宿主官方重试码（`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）的超集——多出配额与上下文类，切模型正是这些失败的本职出路。

| 失败场景                                         | 宿主 `code`                                       | 默认可切换              |
| ------------------------------------------------ | ------------------------------------------------- | ----------------------- |
| 连接类传输失败（"Connection error." / 网络中断） | `TRANSPORT`                                       | ✅                      |
| 5xx 服务器错误                                   | `SERVER`                                          | ✅                      |
| 429 限流                                         | `RATE_LIMIT`                                      | ✅                      |
| 配额 / 余额耗尽                                  | `QUOTA`、`ACCOUNT_QUOTA`                          | ✅                      |
| 上下文超限                                       | `CONTEXT_WINDOW_EXCEEDED`                         | ✅                      |
| 空响应（正常结束但零内容块）                     | `EMPTY_RESPONSE`                                  | ✅                      |
| 流空闲 / 请求超时                                | `TIMEOUT`                                         | ✅                      |
| 鉴权 / 请求构造 / 凭据错误                       | `AUTH` / `INVALID_REQUEST` / `INVALID_CREDENTIAL` | ❌ 换模型无解，立即上抛 |
| 其他 HTTP 状态                                   | `HTTP_<status>`（如 `HTTP_502`）                  | ❌ 可自行加入白名单     |

存量配置兼容：0.3.1 及之前版本的默认白名单误含宿主不产出的 `NETWORK` / `SERVER_ERROR`，导致连接类与 5xx 失败不触发切换；升级到 0.3.2+ 后，运行时会对你已保存的自定义白名单按并集自动补入 `TRANSPORT` / `SERVER`（旧码保留无害），无需手动改配置。

## 行为

- 失败码在白名单 + 按时机判定可切 + 还有下一候选 → 退避 + 切下一候选 + 返回 `{kind: 'retry'}`，loop 重发请求（`agent/request` 监听器改写 `provider/model`）
- 失败码不在白名单或链耗尽 → 透传上游决策（官方 retry 的 retry 也到此为止），错误正常上抛
- 同时注册 system-prompt section，告知 agent 回退协议存在、无需自行"手加重试"
- 配置非法时不阻塞宿主：报错并跳过装载；设置面板存入非法值时保留上一次成功配置

## 已知限制

- `afterRetry` 时机依赖 waterfall 链位：需能在 `agent/request-error` 中通过 `next()` 观察到官方 retry 的决策；自定义装载顺序导致观察不到时，回退退化为 `immediately` 语义
- `perTurn` 尚未实装：schema 有声明、配置会解析，但回退状态机未读取该字段，设 `false` 无效果
- 每 step 的回退状态以 `turn:step` 为 key 存内存且不清理：超长会话下按 step 数缓增（每项是小对象，量级可忽略，严格意义上无上界）
- 不实现 provider/* 通配条目、role/specificity 多链分派、跨回合切回主模型

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
pnpm install                                 # 仓库根，包内 prepare 自动产出 dist
pnpm test                                    # vitest 全仓测试
pnpm typecheck                               # 递归 tsc --noEmit
pnpm --filter @zhidal/dsh-llm-fallback build # 单独重建 dist
```

**为什么入口是 dist**：dsh 宿主经 Node 原生 type-stripping 加载 TS 插件，而 Node 硬性拒绝转译 realpath 位于任何 node_modules 之下的 `.ts` 文件（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），纯 TS 源码入口在 git/npm/tarball 实体安装下必然加载失败。本插件因此以 esbuild 打包 `dist/index.js` 单文件发行（内联运行时依赖），源码仍是 `src/*.ts`；git 安装依赖包内 `prepare` 现场构建，消费方需按 pnpm 要求放行构建脚本（见上文）。其他 TS 插件如需支持实体安装，照此模式改造。

## 许可证

[MIT](./LICENSE)
