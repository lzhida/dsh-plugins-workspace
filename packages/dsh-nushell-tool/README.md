# @lzhida/dsh-nushell-tool

为 DeepSeek Harness 注册独立的 `nushell` 工具:模型显式调用,命令经 `nu --no-config-file -c <command>` 子进程执行,回传 exit code、stdout、stderr。与内置 bash 工具并存,互不影响。

## 核心特性

- **干净求值环境**:`--no-config-file` 禁用用户 nushell 配置,行为可复现;
- **超时控制**:`timeoutMs` 参数(默认 30s,上限 600s),到期以 SIGTERM 终止进程;
- **取消透传**:调用方取消(AbortSignal)转发给子进程;
- **并行安全**:进程级隔离、无共享可变状态,声明 `isConcurrencySafe` 可与其他工具调用并行调度;
- **输出治理**:stdout/stderr 单流超 20 000 字符截断并标注原始长度;
- **生命周期清理**:插件卸载时经 `ctx.effect` 统一终止存活子进程;
- **零打包**:`nu` 经 PATH 查找,缺失时返回安装指引报错,不打包 nushell。

## 工具参数

| 参数        | 类型    | 必填 | 说明                                                    |
| ----------- | ------- | ---- | ------------------------------------------------------- |
| `command`   | string  | 是   | Nushell 源码,作为单条 `nu --no-config-file -c` 程序执行 |
| `cwd`       | string  | 否   | 工作目录,缺省沿用 harness 进程 cwd                      |
| `timeoutMs` | integer | 否   | 超时毫秒数,默认 30000,上限 600000                       |

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh、本机装有 Nushell(`nu` 在 PATH 中)。

```sh
pnpm dsh plugin --profile default add link:packages/dsh-nushell-tool
```

安装后在 dsh Web UI 的设置 → 插件中确认「dsh-nushell-tool」已启用,即可由模型在会话中按需调用 `nushell` 工具。

## 开发

```sh
pnpm install    # 仓库根执行
pnpm test       # vitest(含本包 src/index.test.ts)
pnpm test:e2e -- packages/dsh-nushell-tool/src/index.ts   # 真实 dsh Web UI 加载验证
```

插件契约(`src/index.ts`):`export const name = 'dsh-nushell-tool'`、`inject = ['tools']`、`apply(ctx)` 内经 `ctx.tools.register(defineTool(...))` 注册工具,`ctx.effect` 收口注册 disposer 与子进程清理。

## License

MIT
