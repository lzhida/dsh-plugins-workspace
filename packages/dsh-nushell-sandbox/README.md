# @lzhida/dsh-nushell-sandbox

受沙箱约束的本地 Nushell shell executor:向 DeepSeek Harness 注入 `ctx.shell`(confining provider),由 `ctx.sandbox` + `ctx.subprocess` 支撑——与 `@lzhida/dsh-nushell-local` 互斥,角色对齐官方 bash/pwsh 家族的 local ↔ sandbox 执行器对(`dsh-bash-local` / `dsh-bash-sandbox`)。

> **双模架构定位(0.2.0 起)**:实现内核已上移至 `@lzhida/dsh-tool-nushell`(执行器类由 tool 直跑模式与接缝挂载共用一份),本包是组合行薄壳。仅当需要**完全替换 + 沙箱**模式(nu 独占 `ctx.shell`)时安装本包;只想给官方组合加 nushell 工具的话,单装 `@lzhida/dsh-tool-nushell` 即可(直跑模式在宿主沙箱栈在时同样受 confining 约束)。前置:须与 `@lzhida/dsh-tool-nushell` 同时安装(peer 依赖)。安装本包会自动停用官方 shell 家族(见 `cordis.patch.yml`),并要求 permission 预设停用或适配——详见 tool 包 README 的组合矩阵。

## 架构

- **进程级 argv 包装**:nu 语言自身无沙箱等价物,但 confinement 是进程级 argv 包装、对被包装的 shell 方言透明——每条命令的 argv 经 `ctx.sandbox.confine` 包装后由 `ctx.subprocess` 受限 spawn,runner 链按平台选择(win32 为 ACL 受限令牌 runner);
- **策略解析**:`sandboxMode` 透传共享策略服务的部署缺省(fail-safe 为 read-only);请求未带 policy 时经 `ctx.sandboxPolicy.resolve()` 解析(会话 cwd 即边界);
- **fail-closed**:无可用 runner 时 `confine` 抛 `SANDBOX_UNAVAILABLE`,决不静默回退到未受限 argv;`danger-full-access` 模式下不包装,事实字段如实报告该模式;
- **事实分类**:命令失败按 `RunnerFailureRule`(runner 自身失败,命令从未运行)与 `denialSignatures`(策略拒绝,命令运行且被内核拦下)互斥分类,进 `ShellSandboxInfo` 的 `denied`/`runnerFailed` 字段,与官方 fail-closed 分类次序一致;
- **nu 方言**:`nu --no-config-file -c <command>`,禁用用户配置保证可复现的干净求值环境;`nuPath` 可配置,未声明时按候选链解析(PATH 逐项 → scoop shims / Program Files / cargo bin,POSIX 直接交给 PATH);环境注入 `NO_COLOR=1` / `PAGER=cat` / `GIT_PAGER=cat`(模型友好,与 pwsh-local 一致地不设置 `TERM=dumb`);
- **settings 热更新**(0.1.7 SettingsForms 时代):配置经 `static Config` 静态声明并全字段 `volatile`——loader 自动投影设置表单并以活值访问器注入,设置层改 `nuPath` 后下次读取即生效,无需重启;
- **单一入口 `execute`**(0.1.7 接缝契约):confinement 在执行准备期经 `ctx.sandbox.confine`(0.1.7 起异步、可取消)包装 argv;`await` 句柄的 `result()` 即前台——非零退出/超时杀/中止都正常 resolve、结果附 `sandbox` 事实字段,仅基础设施失败 reject(runner 自身失败抛 `SANDBOX_UNAVAILABLE`,命令从未运行);保留句柄即后台——`done` 永不 reject,拒绝分类推迟到**结算点**(`onProcessDone`:进程收场、collect 流封口后按 `denialSignatures`/`RunnerFailureRule` 分类,runner 归因采用官方 `isRunnerSpawnFailure` 诊断,不与 job 的消费流竞态);
- **包装层检测**:stderr 命中已知注入特征(如 `pi-natives`)时自动附诊断注记,提示 `nu` 可能被包装、建议 `nuPath` 指向官方构建。

与 `dsh-nushell-local` 是子类复用关系(0.1.7 起,对齐官方 pwsh 家族):confining 形态只把 argv 准备换成 `ctx.sandbox.confine` 包装,进程机制/截止/输出全部继承本地执行器。

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
pnpm dsh plugin --profile <name> add link:packages/dsh-nushell-sandbox
```

安装即经 bundle patch 停用官方 shell 家族(pwsh-sandbox / bash-sandbox)与 tool-bash / tool-pwsh,并以 id `nushell-sandbox` 独占 `ctx.shell` 接缝(cordis 重复注册 fail loud)。与 `@lzhida/dsh-nushell-local` 二选一。

tool 层搭配 `@lzhida/dsh-tool-nushell`:confining 组合下工具公布 `sandbox_permissions` / `justification` 升权参数(见其包 README)。

## 开发

```sh
pnpm install     # 仓库根执行
pnpm typecheck   # 递归各包 tsc --noEmit
pnpm test        # vitest(含本包 src/index.test.ts)
npx tsx .agents/skills/dsh-plugin-dev/scripts/test-e2e.ts -- packages/dsh-nushell-sandbox/src/index.ts packages/dsh-tool-nushell/src/index.ts   # 真实 dsh Web UI 加载验证(executor + tool)
```

插件契约(`src/index.ts`):`default export` `NushellSandboxExecutor`(`static inject = ['subprocess', 'sandbox', 'sandboxPolicy']`),另导出 `DEFAULT_NUSHELL_CONFIG`、`assertServiceableNushellConfig`、`classifySandboxFacts`、`annotateWrappedNu`、`resolveNuPath`/`candidateNuPaths`(nuPath 候选链纯函数);模块装载时输出 `[dsh-nushell-sandbox] ` 前缀日志行(e2e 契约)。

## License

MIT
