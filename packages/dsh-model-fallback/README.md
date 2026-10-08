# @lzhida/dsh-model-fallback

dsh-model-fallback 插件:拦截 dsh 全局 LLM 调用,按 `fallbackChains` 在主模型失败时自动切换到下一个候选 `provider/model`,提供最大重试次数与可识别失败码配置。语义对齐 oh-my-pi 的 `retry.modelFallback` / `retry.fallbackChains`。

## 适配版本

| 组件     | 版本           | 说明                                                                                                                       |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 宿主 dsh | **0.2.0-rc.2** | `agent/request` 与 `agent/request-error` waterfall 在 rc.2 提供;`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已放行 |
| 插件包   | 0.1.0          | 插件版本号与 dsh 版本号解耦                                                                                                |

## 安装

`dsh plugin add` 底层是 `pnpm add`,支持本地目录、`github:` / `git+https` / `git+ssh` / tarball 等多种源。

### 仓库内开发(本地 link)

```sh
pnpm install                     # 仓库根
dsh plugin add link:packages/dsh-model-fallback
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层,无需 overlay 注入。

### Git 安装(外部用户)

四种形式等价,都只装 `packages/dsh-model-fallback` 子目录。`<ref>` 替换为想锁定的分支 / tag / 提交:

```sh
# 1. github: 简写(pnpm 8+ 解析为 https://github.com/<user>/<repo>/tarball/<ref>)
dsh plugin add github:lzhida/dsh-plugins-workspace#main\&path:packages/dsh-model-fallback

# 2. git+https(显式完整 URL,需 git 客户端)
dsh plugin add git+https://github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-model-fallback

# 3. git+ssh(需本机配过 SSH key)
dsh plugin add git+ssh://git@github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-model-fallback

# 4. tarball 快照
curl -L https://github.com/lzhida/dsh-plugins-workspace/archive/refs/heads/main.tar.gz | tar -xz -C /tmp
dsh plugin add /tmp/dsh-plugins-workspace-main/packages/dsh-model-fallback
```

> `&path:<subdir>` 是 pnpm 安装 git monorepo 子目录的标准语法(`#<ref>&path:<dir>`,把 ref 与 subdir 用 `&` 分隔)。

## 配置

启用插件后,在 dsh 设置面板中找到 "model-fallback" section(由插件通过 schemastery schema 投影),可配置以下字段:

| 字段             | 类型                         | 默认                                                                                                               | 说明                            |
| ---------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `enabled`        | `boolean`                    | `true`                                                                                                             | 总开关                          |
| `fallbackChains` | `string[]`(`provider/model`) | `[]`                                                                                                               | 候选列表;首项 = 主模型,逐个回退 |
| `maxRetries`     | `number`                     | `0`(= 链长,即全跑完才报错)                                                                                         | 单次请求最多尝试次数            |
| `baseDelayMs`    | `number`                     | `500`                                                                                                              | 指数退避初值                    |
| `maxDelayMs`     | `number`                     | `30000`                                                                                                            | 指数退避上限                    |
| `retryableCodes` | `string[]`                   | `RATE_LIMIT / QUOTA / ACCOUNT_QUOTA / CONTEXT_WINDOW_EXCEEDED / EMPTY_RESPONSE / SERVER_ERROR / TIMEOUT / NETWORK` | 视为可重试的稳定失败码白名单    |
| `perTurn`        | `boolean`                    | `true`                                                                                                             | 是否在同 step 内允许回退        |

## 行为

- 监听 `agent/request` 与 `agent/request-error`(dsh-agent-loop 提供的 loop-level waterfall),与 `dsh-llm-retry` 正交可叠加
- 失败码在白名单 + 还有下一候选 → backoff + 切下一候选 + 返回 `{kind: 'retry'}`,loop 重新发起请求
- 失败码不在白名单 → 透传给宿主(dsh-llm-retry / loop 走默认行为)
- 链耗尽 → 透传上游决策(dsh-llm-retry 的 retry 也到此为止)

## 装好后的手工验证

```sh
# 1. 确认子包已装入 profile node_modules
ls "$(dsh config profile-dir 2>/dev/null || echo $HOME/.dsh/profiles/<name>)/node_modules/@lzhida/dsh-model-fallback"

# 2. 重启 dsh,在设置 → 插件中确认 "已启用"

# 3. 启动日志应有 [dsh-model-fallback] plugin loaded 一行(e2e 契约)
```

## 已知限制

- 本插件**一次失败即切下一候选**(不等 provider 内 dsh-llm-retry 重试耗尽);用户想要"先 provider 内 retry N 次再换 model"需后续扩展
- 不实现 provider/* 通配条目、role/specificity 分派链
- 不实现"跨回合切回主 model"(本期仅在请求内回退)
