# dsh-plugins-workspace

[English](./README.en.md) | 简体中文

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness)插件集合——TypeScript + cordis 插件 monorepo。插件以 TS 源码形态被 dsh loader 直接加载,无构建步骤。

> **纯 AI 开发**:本仓库的全部代码均由 AI 编码代理生成。

## 插件

### @lzhida/dsh-guided-goal

引导式持久目标(goal)命令。将一句自然语言意图转化为结构化 goal,由 dsh goal 域在会话内自主执行直至完成。

**核心特性**

- **引导式创建**(`/guided-goal`):模型逐项澄清五个字段——成功标准(必须可判定)、验证方式、迭代上限、范围边界、停止条件——全部明确后合成 objective 并调用 `create_goal`;
- **智能跳过访谈**:草稿已足够明确或用户明确不愿被访谈时,模型可跳过澄清直接创建;所有推断字段以「假设:…」显式标注,轮次上限按工作量估算(小 2–3 / 中 5 / 大 8–10 轮)并在回复中说明依据;
- **结构化 objective**:五字段固定章节 `## Objective / ## Success criteria / ## Verification / ## Boundaries / ## Stop conditions`,轮次上限传入 `max_goal_rounds`;
- **完成后强制总结**:goal 的停止条件内置「输出总结」要求——修改文件清单、逐条验证结果对照、遗留问题;
- **设置面板**:dsh 设置 → 插件 → guided-goal,「启用命令」开关(默认开启);
- **官方语言跟随**:命令描述与协议提示词按 dsh 通用设置的语言自动切换(中文 / English / 未设置时双语兜底)。

**用法**

```
/guided-goal              # 进入访谈,逐项澄清后创建
/guided-goal <草稿目标>   # 带草稿进入访谈;草稿足够明确时模型可跳过访谈直接创建
```

### @lzhida/dsh-tool-nushell

独立 `nushell` 工具:模型显式调用,命令经 `nu --no-config-file -c <command>` 执行,回传结构化结果(exit code、stdout、stderr)。命令经 `ctx.shell` 能力接缝交由当前挂载的 nushell executor 执行;搭配执行器安装后取代官方 bash/pwsh shell 家族。

**核心特性**

- **干净求值**:`--no-config-file` 禁用用户配置,行为可复现;
- **前台/后台执行**:`run_in_background` 立即返回 job id,经通用 `ctx.jobs` 收集(`job_output`/`job_kill`);超时(默认 30s、上限 600s,到期 SIGTERM)与取消透传;
- **结构化输出**:canonical oneOf(后台句柄 | 前台结果),单流超限截断、完整输出落盘并报告 `spillPath`;`outputFormat` 支持 `text`/`json`/`nuon`;
- **沙箱感知**:搭配 `@lzhida/dsh-nushell-sandbox` 时公布 `sandbox_permissions` + `justification` 升权参数——被沙箱拒绝的命令可对同一命令以更宽模式一次性重试,须附理由并经用户批准;
- **并行安全**:进程级隔离,可与其他工具调用并行调度;
- **生命周期清理**:插件卸载时统一终止存活子进程;`nu` 经 PATH 查找,缺失时报错,不打包 nushell。

**工具参数**:`command`(必填)、`description`(必填)、`workdir`、`timeoutMs`、`run_in_background`、`outputFormat`、`stdin`;沙箱组合另公布 `sandbox_permissions`/`justification`。完整语义见[包 README](./packages/dsh-tool-nushell/README.md)。

**前置**:本机安装 Nushell(`nu` 在 PATH 中)。

### @lzhida/dsh-nushell-local

本地 Nushell shell executor:注入 `ctx.shell` 能力接缝,使 nushell 以一等 shell 身份进入官方 shell 家族(角色对齐官方 `dsh-pwsh-local` 之于 PowerShell)。委托 `ctx.subprocess` 受管 spawn——有界输出、spill 落盘、超时宽限下沉于执行器;`nu` 方言干净求值,`nuPath` 可配置,stderr 命中已知包装层特征时自动附诊断注记。详见[包 README](./packages/dsh-nushell-local/README.md)。

### @lzhida/dsh-nushell-sandbox

受沙箱约束的 Nushell shell executor:与 `dsh-nushell-local` 互斥的 `ctx.shell` 提供方(角色对齐官方 bash/pwsh 家族的 local ↔ sandbox 执行器对)。每条命令的 argv 经 `ctx.sandbox.confine` 进程级包装后受限 spawn,策略拒绝与 runner 失败按方言分类进 `ShellSandboxInfo` 事实字段;fail-closed——无可用 runner 时报错,决不静默回退到未受限执行。详见[包 README](./packages/dsh-nushell-sandbox/README.md)。

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh、本机安装 Nushell(`nu` 在 PATH 中)。

```sh
# 执行器二选一(ctx.shell 为单实现接缝,二者互斥;安装即停用官方 bash/pwsh shell 家族与 tool-bash/tool-pwsh)
pnpm dsh plugin --profile default add link:packages/dsh-nushell-local
pnpm dsh plugin --profile default add link:packages/dsh-nushell-sandbox

# nushell 工具层(消费上述执行器注入的 ctx.shell)
pnpm dsh plugin --profile default add link:packages/dsh-tool-nushell

# 引导式 goal 命令(独立,不依赖执行器)
pnpm dsh plugin --profile default add link:packages/dsh-guided-goal
```

安装后在 dsh Web UI 的设置 → 插件中确认目标插件已启用:guided-goal 在会话输入框使用 `/guided-goal`;`nushell` 工具由模型按需调用。

## 开发

```sh
pnpm install        # 安装依赖并自动执行 lefthook install
pnpm lint           # ESLint(flat config,TS)
pnpm format         # Prettier 写入(format:check 仅校验)
pnpm typecheck      # 递归各包 tsc --noEmit
pnpm test           # Vitest,全仓 src/**/*.test.ts
```

- **纯 TypeScript**:插件无构建步骤,`package.json` 的 `main` 直接指向 `src/index.ts`,由宿主 dsh loader 加载;
- **E2E**:运行器以独立 profile(默认 `e2e`,缺失时自动从官方 web 模板引导)启动真实 dsh 实例——插件列表按 profile 隔离,`DSH_HOME` 共享全局 `~/.dsh`(模型凭证不隔离);断言插件加载日志、Web 端口可达与认证链健康;可用 `E2E_PORT` / `E2E_TIMEOUT_MS` / `E2E_DSH_PROFILE` / `E2E_KEEP_MS` 调整行为(运行器见 `.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts`,经 `npx tsx` 执行);
- **新增插件**:仿照 `packages/dsh-guided-goal/package.json` 建 `packages/<name>/` 即可,`pnpm-workspace.yaml` 自动收录;
- **提交规范**:中文 Conventional Commits;开发走 `feat/*`、`fix/*` 分支合入 `dev`,验证后合入 `main`。

## License

MIT
