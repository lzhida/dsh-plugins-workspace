# @lzhida/dsh-nushell-sandbox

受沙箱约束的本地 Nushell shell executor:向 DeepSeek Harness 注入 `ctx.shell`(confining provider),由 `ctx.sandbox` + `ctx.subprocess` 支撑——与 `@lzhida/dsh-nushell-local` 互斥,角色对齐官方 bash/pwsh 家族的 local ↔ sandbox 执行器对(`dsh-bash-local` / `dsh-bash-sandbox`)。

## 架构

- **进程级 argv 包装**:nu 语言自身无沙箱等价物,但 confinement 是进程级 argv 包装、对被包装的 shell 方言透明——每条命令的 argv 经 `ctx.sandbox.confine` 包装后由 `ctx.subprocess` 受限 spawn,runner 链按平台选择(win32 为 ACL 受限令牌 runner);
- **策略解析**:`sandboxMode` 透传共享策略服务的部署缺省(fail-safe 为 read-only);请求未带 policy 时经 `ctx.sandboxPolicy.resolve()` 解析(会话 cwd 即边界);
- **fail-closed**:无可用 runner 时 `confine` 抛 `SANDBOX_UNAVAILABLE`,决不静默回退到未受限 argv;`danger-full-access` 模式下不包装,事实字段如实报告该模式;
- **事实分类**:命令失败按 `RunnerFailureRule`(runner 自身失败,命令从未运行)与 `denialSignatures`(策略拒绝,命令运行且被内核拦下)互斥分类,进 `ShellSandboxInfo` 的 `denied`/`runnerFailed` 字段,与官方 fail-closed 分类次序一致;
- **nu 方言**:`nu --no-config-file -c <command>`,禁用用户配置保证可复现的干净求值环境;`nuPath` 可配置,缺省走 PATH;环境注入 `NO_COLOR=1` / `PAGER=cat` / `GIT_PAGER=cat`(模型友好,与 pwsh-local 一致地不设置 `TERM=dumb`);
- **前台 `run`**:经 `dsh-timeout` 的 `deadline` 融合调用方取消与超时(`BASH_TIMEOUT` 能力码,与官方 shell 家族共享);非零退出/超时杀/中止都正常 resolve,仅基础设施失败 reject;结果附 `sandbox` 事实字段;
- **后台 `start`**:无 executor 超时(接缝契约),返回 `ShellProcess` 句柄(`done` 永不 reject,provider 拒绝降级为 killed + 失败注记;`readOutput` 消费式增量,stderr 以 `[stderr]` 段并入);后台不做 stderr 反推分类(`denied` 恒 false,nu 自身的拒绝文本仍经增量呈现),runner 在 spawn 前失败由结算分支如实标 `runnerFailed`;
- **包装层检测**:stderr 命中已知注入特征(如 `pi-natives`)时自动附诊断注记,提示 `nu` 可能被包装、建议 `nuPath` 指向官方构建。

与 `dsh-nushell-local` 是同构的独立实现而非子类:官方 shell 家族的 local/sandbox 执行器互不 import,共享面下沉在 `dsh-shell` 接缝类型。

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

插件契约(`src/index.ts`):`default export` `NushellSandboxExecutor`(`static inject = ['subprocess', 'sandbox', 'sandboxPolicy']`),另导出 `DEFAULT_NUSHELL_CONFIG`、`assertServiceableNushellConfig`、`classifySandboxFacts`、`annotateWrappedNu`;模块装载时输出 `[dsh-nushell-sandbox] ` 前缀日志行(e2e 契约)。

## License

MIT
