# @lzhida/dsh-nushell

Nushell 组合包:一次安装即得**完整替换形态**——`nushell` 工具 + confining 沙箱执行器,官方 bash/pwsh 家族自动停用。对齐官方 agent-team-profile 的「单包安装、patch 一次接线」模式。

## 这包里有什么

本包是**纯接线包**(无运行时逻辑),`dependencies` 拉入两个实现件,`cordis.patch.yml` 一次插入两个条目:

| 条目              | 来源                          | 职责                                                                                     |
| ----------------- | ----------------------------- | ---------------------------------------------------------------------------------------- |
| `tool-nushell`    | `@lzhida/dsh-tool-nushell`    | 模型契约:参数校验、canonical 输出、marker 渲染、后台 job、promote 升格、系统提示 section |
| `nushell-sandbox` | `@lzhida/dsh-nushell-sandbox` | `ctx.shell` 提供方:confining 执行器(权限选择器可用)                                      |

并停用官方 `pwsh-sandbox` / `bash-sandbox` / `tool-pwsh` / `tool-bash`(完全替换)。

## 安装

```sh
pnpm dsh plugin --profile <name> add link:packages/dsh-nushell
```

装这一个包即可,**不要**再同时安装 `@lzhida/dsh-nushell-local` / `@lzhida/dsh-nushell-sandbox`(条目 id 冲突)。

## 组合矩阵(总览)

| 安装                               | 官方 bash/pwsh 工具 | nushell 工具 | `ctx.shell`        | permission 选择器 | 适用场景                                |
| ---------------------------------- | ------------------- | ------------ | ------------------ | ----------------- | --------------------------------------- |
| **本包**(`dsh-nushell`)            | 停用                | ✅           | nushell(confining) | ✅ 可用           | **推荐**:完全替换 + 沙箱约束 + 权限档位 |
| `tool-nushell` 单装                | 保留                | ✅           | 官方(不变)         | ✅ 可用           | 直跑模式:只想加 nushell 工具            |
| `tool-nushell` + `nushell-sandbox` | 停用                | ✅           | nushell(confining) | ✅ 可用           | 等价于本包(手动分装)                    |
| `tool-nushell` + `nushell-local`   | 停用                | ✅           | nushell(无沙箱)    | ❌ 须停用 presets | 完全替换且明确不要沙箱                  |

> 非 confining 形态(local)无法与 permission presets 组合——官方语义:presets 要求占缝执行器 confining。

## 配置

- **工具层**(`tool-nushell` 条目):`enableRunInBackground` / `promoteOnTimeout`,见 tool 包 README;
- **执行器层**(`nushell-sandbox` 条目):`cwd` / `timeoutMs` / `maxTimeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs` / `nuPath`(全字段 volatile,设置页热生效),见 sandbox 包 README。

设置 → 插件 → 对应条目即可编辑,无需重启。

## License

MIT
