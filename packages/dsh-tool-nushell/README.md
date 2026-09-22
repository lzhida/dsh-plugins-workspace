# @lzhida/dsh-tool-nushell

为 DeepSeek Harness 注册独立的 `nushell` 工具:模型显式调用,命令经 `nu --no-config-file -c <command>` 子进程执行。能力对齐官方 `tool-pwsh`(0.1.5-rc.2):前台/后台执行、canonical 结构化输出、marker 渲染、截断落盘、`DSH_*` 环境注入、系统提示 section、终端卡片 UI 呈现。

## 核心特性

- **干净求值环境**:`--no-config-file` 禁用用户 nushell 配置,每次全新进程,状态不跨调用保留;
- **前台/后台执行**:`run_in_background` 立即返回 job id,经通用 `ctx.jobs` 收集(`job_output`/`job_kill`);`Config.enableRunInBackground`(默认开启)可整体关闭;
- **结构化输出**:canonical oneOf(后台句柄 | 前台 `{exitCode, signal, timedOut, aborted, timeoutMs, stdout, stderr}`),单流超 20 000 字符截断,完整输出落盘并在结果中报告 `spillPath`;
- **marker 渲染**:非零退出 `[exit code: N]`、信号终止 `[killed by signal: X]`、超时 `[timed out after Nms]`,干净退出无 marker,空输出 `(no output)`——非零退出是报告而非失败,由模型决定后续动作;
- **取消语义**:调用方取消以 `HarnessError(TOOL_ABORTED)` 中止,AbortSignal 透传给子进程;
- **环境注入**:经 `ctx.shellEnv` 注入托管的 `DSH_*` 变量到子进程;
- **系统提示**:注册 `tool:nushell` section(紧邻官方 pwsh section),说明退出码 marker 语义;
- **UI 呈现**:前台调用渲染终端卡片(命令 + 说明 + 工作目录 + 退出状态),后台调用降级 generic 卡片;
- **超时控制**:`timeoutMs` 参数(默认 30s,上限 600s),到期终止进程;后台任务不设超时;
- **沙箱感知**:confining 组合下,被策略拒绝的文件操作以 `[sandbox: file access denied under <mode> mode]` marker 呈现——是策略拒绝而非命令 bug;
- **并行安全**:进程级隔离、无共享可变状态,声明 `isConcurrencySafe` 可与其他工具调用并行调度;
- **生命周期清理**:插件卸载时经 `ctx.effect` 统一注销工具(后台进程由 `ctx.subprocess` 组合销毁统一终止);
- **零打包**:`nu` 经 PATH 查找,缺失时返回安装指引报错,不打包 nushell。

执行链:命令经 `ctx.shell` 能力接缝交由当前挂载的 nushell executor 执行——`@lzhida/dsh-nushell-local`(无沙箱)或 `@lzhida/dsh-nushell-sandbox`(受沙箱约束),二者互斥,nu 进程管理/预算/spill 下沉于 executor,本插件只负责模型契约。沙箱升权:仅 confining executor(`dsh-nushell-sandbox`)组合公布 `sandbox_permissions`/`justification`——被沙箱拒绝的命令可对同一命令以更宽模式一次性重试,须附一句理由并经用户批准;系统提示同时明令禁止投机性升权。

## 工具参数

| 参数                  | 类型    | 必填 | 说明                                                                                                                   |
| --------------------- | ------- | ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `command`             | string  | 是   | Nushell 源码,作为单条 `nu --no-config-file -c` 程序执行                                                                |
| `description`         | string  | 是   | 命令用途的简短说明(5-10 词,展示在 UI 卡片)                                                                             |
| `workdir`             | string  | 否   | 工作目录,缺省为会话工作目录;相对路径基于会话工作目录解析                                                               |
| `timeoutMs`           | number  | 否   | 超时毫秒数,默认 30000,上限 600000;`run_in_background` 时不生效                                                         |
| `run_in_background`   | boolean | 否   | 后台运行并立即返回 job id(`job_output` 收集、`job_kill` 停止)                                                          |
| `outputFormat`        | string  | 否   | 最终值序列化:`text`(默认,原样 stdout)/`json`(`to json --raw`)/`nuon`(`to nuon`);结构化数据建议 `json`,返回机器可读结果 |
| `stdin`               | string  | 否   | 可选文本,作为命令 stdin 喂入                                                                                           |
| `sandbox_permissions` | string  | 否   | 升权目标模式;仅挂载 confining executor 时公布,仅用于对刚被沙箱拒绝的同一命令一次性重试                                 |
| `justification`       | string  | 否   | 与 `sandbox_permissions` 配对必填:向用户解释该命令为何需要更宽访问的一句话                                             |

`outputFormat` 非 `text` 时命令被包进 `do { … }` 块并对最终值序列化(多语句整体求值,副作用行为不变),因此 `ls \| get name` 配 `json` 直接得到 JSON 数组而非表格渲染文本。

## 插件配置

| 配置                    | 类型    | 默认 | 说明                     |
| ----------------------- | ------- | ---- | ------------------------ |
| `enableRunInBackground` | boolean | true | 关闭后不提供后台执行能力 |

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh、本机装有 Nushell(`nu` 在 PATH 中)。

```sh
pnpm dsh plugin --profile default add link:packages/dsh-tool-nushell
```

安装后在 dsh Web UI 的设置 → 插件中确认「dsh-tool-nushell」已启用,即可由模型在会话中按需调用 `nushell` 工具。

## 开发

```sh
pnpm install    # 仓库根执行
pnpm test       # vitest(含本包 src/index.test.ts)
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- packages/dsh-nushell-local/src/index.ts packages/dsh-tool-nushell/src/index.ts   # 真实 dsh Web UI 加载验证(executor + tool)
```

插件契约(`src/index.ts`):`export const name = 'dsh-tool-nushell'`、`inject = ['tools', 'systemPrompt', 'shellEnv', 'shell']`(jobs 经 `ctx.get` 动态解析以支持降级报错),`apply(ctx, config)` 内注册系统提示 section 与工具,`ctx.effect` 收口注册 disposer 与子进程清理。

## License

MIT
