# @lzhida/dsh-nushell-local

本地 Nushell shell executor:向 DeepSeek Harness 注入 `ctx.shell` 能力接缝,使 nushell 以一等 shell 身份进入官方 shell 家族(角色对齐官方 `@deepseek-ai/dsh-pwsh-local` 之于 PowerShell)。

## 架构

- **委托执行**:不直接 spawn 进程——构造完整 `SubprocessSpawnSpec`(argv/cwd/stdio 预算/env 合并/graceMs/signal)后交给 `ctx.subprocess`,有界输出、spill 文件与受管终止都是 subprocess 服务的机制;
- **nu 方言**:`nu --no-config-file -c <command>`,禁用用户配置保证可复现的干净求值环境;`nuPath` 可配置,缺省走 PATH;
- **前台 `run`**:经 `dsh-timeout` 的 `deadline` 融合调用方取消与超时(`BASH_TIMEOUT` 能力码,与 bash/pwsh 家族共享);非零退出/超时杀/中止都正常 resolve,仅基础设施失败 reject;
- **后台 `start`**:无 executor 超时(接缝契约),返回 `ShellProcess` 句柄(`done` 永不 reject,provider 拒绝降级为 killed + 失败注记;`readOutput` 消费式增量,stderr 以 `[stderr]` 段并入);
- **沙箱**:nu 无语言级沙箱等价物,保持 `sandboxMode` 缺省(无沙箱),不做 confining 子类;
- **包装层检测**:stderr 命中已知注入特征(如 `pi-natives`)时自动附诊断注记,提示 `nu` 可能被包装、建议 `nuPath` 指向官方构建。

## 配置

| 字段             | 类型   | 默认     | 说明                   |
| ---------------- | ------ | -------- | ---------------------- |
| `cwd`            | string | 进程 cwd | 后台兜底工作目录       |
| `timeoutMs`      | number | 30000    | 默认超时毫秒           |
| `maxTimeoutMs`   | number | 600000   | 超时上限               |
| `maxOutputBytes` | number | 64000    | 单流内存收集预算       |
| `maxSpillBytes`  | number | 64MiB    | 单流 spill 文件上限    |
| `graceMs`        | number | 3000     | SIGTERM → SIGKILL 宽限 |
| `nuPath`         | string | `nu`     | nu 可执行文件路径      |

## 安装

```sh
pnpm dsh plugin --profile <name> add link:packages/dsh-nushell-local
```

与 `@lzhida/dsh-tool-nushell` 配套使用(tool 消费本包注入的 `ctx.shell`)。

## License

MIT
