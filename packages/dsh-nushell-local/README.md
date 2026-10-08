# @lzhida/dsh-nushell-local

本地 Nushell shell executor:向 DeepSeek Harness 注入 `ctx.shell` 能力接缝,使 nushell 以一等 shell 身份进入官方 shell 家族(角色对齐官方 `@deepseek-ai/dsh-pwsh-local` 之于 PowerShell)。

> **双模架构定位(0.2.0 起)**:实现内核已上移至 `@lzhida/dsh-tool-nushell`(执行器类由 tool 直跑模式与接缝挂载共用一份),本包是组合行薄壳。仅当需要**完全替换**模式(nu 独占 `ctx.shell`,停用官方 bash/pwsh 工具)时安装本包;只想给官方组合加 nushell 工具的话,单装 `@lzhida/dsh-tool-nushell` 即可。前置:须与 `@lzhida/dsh-tool-nushell` 同时安装(peer 依赖)。安装本包会自动停用官方 shell 家族(见 `cordis.patch.yml`),并要求 permission 预设停用或适配——详见 tool 包 README 的组合矩阵。

## 架构

- **委托执行**:不直接 spawn 进程——构造完整 `SubprocessSpawnSpec`(argv/cwd/stdio 预算/env 合并/graceMs/signal)后交给 `ctx.subprocess`,有界输出、spill 文件与受管终止都是 subprocess 服务的机制;
- **nu 方言**:`nu --no-config-file -c <command>`,禁用用户配置保证可复现的干净求值环境;`nuPath` 可配置,未声明时按候选链解析(PATH 逐项 → scoop shims / Program Files / cargo bin,POSIX 直接交给 PATH);
- **settings 热更新**(0.1.7 SettingsForms 时代):配置经 `static Config` 静态声明并全字段 `volatile`——loader 自动投影设置表单并以活值访问器注入,设置层改 `nuPath` 后下次读取即生效,无需重启;
- **单一入口 `execute`**(0.1.7 接缝契约):经 `dsh-timeout` 的 `deadline` 融合调用方取消与超时(`BASH_TIMEOUT` 能力码,与 bash/pwsh 家族共享);`onExpiry: 'none'` 不设截止。前台/后台是调用方等待方式的属性——`await` 句柄的 `result()` 即前台(非零退出/超时杀/中止都正常 resolve,仅基础设施失败 reject),保留句柄即后台(`done` 永不 reject,provider 拒绝降级为 killed + 失败注记;`readOutput` 消费式增量,stderr 以 `[stderr]` 段并入;`observed` 提供非消费的旁路观察读);
- **沙箱**:nu 无语言级沙箱等价物,保持 `sandboxMode` 缺省(无沙箱),不做 confining 子类;
- **包装层检测**:stderr 命中已知注入特征(如 `pi-natives`)时自动附诊断注记,提示 `nu` 可能被包装、建议 `nuPath` 指向官方构建。

## 配置

| 字段             | 类型   | 默认     | 说明                                   |
| ---------------- | ------ | -------- | -------------------------------------- |
| `cwd`            | string | 进程 cwd | 后台兜底工作目录                       |
| `timeoutMs`      | number | 30000    | 默认超时毫秒                           |
| `maxTimeoutMs`   | number | 600000   | 超时上限                               |
| `maxOutputBytes` | number | 64000    | 单流内存收集预算                       |
| `maxSpillBytes`  | number | 64MiB    | 单流 spill 文件上限                    |
| `graceMs`        | number | 3000     | SIGTERM → SIGKILL 宽限                 |
| `nuPath`         | string | `nu`     | nu 可执行文件路径;未声明时按候选链解析 |

## 安装

```sh
pnpm dsh plugin --profile <name> add link:packages/dsh-nushell-local
```

与 `@lzhida/dsh-tool-nushell` 配套使用(tool 消费本包注入的 `ctx.shell`);与 `@lzhida/dsh-nushell-sandbox` 互斥——`ctx.shell` 为单实现接缝,二选一。安装即经 bundle patch 停用官方 shell 家族(pwsh-sandbox / bash-sandbox)与 tool-bash / tool-pwsh。

## 开发

```sh
pnpm install    # 仓库根执行
pnpm test       # vitest(含本包 src/index.test.ts)
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- packages/dsh-nushell-local/src/index.ts packages/dsh-tool-nushell/src/index.ts   # 真实 dsh Web UI 加载验证(executor + tool)
```

插件契约(`src/index.ts`):`default export` `NushellLocalExecutor`(`static inject = ['subprocess']`),另导出 `DEFAULT_NUSHELL_CONFIG`、`assertServiceableNushellConfig`、`annotateWrappedNu`、`resolveNuPath`/`candidateNuPaths`(nuPath 候选链纯函数);模块装载时输出 `[dsh-nushell-local] ` 前缀日志行(e2e 契约)。

## License

MIT
