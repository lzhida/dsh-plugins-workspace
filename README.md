# dsh-plugins-workspace

[English](./README.en.md) | 简体中文

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness)插件集合——TypeScript + cordis 插件 monorepo。插件以 TS 源码形态被 dsh loader 直接加载,无构建步骤。

## 插件

### @lzhida/guided-goal

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

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh。

```sh
# 从本仓库以 link 方式安装到指定 profile
pnpm dsh plugin --profile default add link:packages/guided-goal
```

安装后在 dsh Web UI 的设置 → 插件中确认「guided-goal」已启用,即可在会话输入框使用 `/guided-goal`。

## 开发

```sh
pnpm install        # 安装依赖并自动执行 lefthook install
pnpm lint           # ESLint(flat config,TS)
pnpm format         # Prettier 写入(format:check 仅校验)
pnpm typecheck      # 递归各包 tsc --noEmit
pnpm test           # Vitest,全仓 src/**/*.test.ts
pnpm test:e2e       # 真实 dsh Web UI 加载级验证(默认验证 guided-goal)
```

- **纯 TypeScript**:插件无构建步骤,`package.json` 的 `main` 直接指向 `src/index.ts`,由宿主 dsh loader 加载;
- **E2E**:运行器以隔离 `DSH_HOME` + 独立 profile 启动真实 dsh 实例,断言插件加载日志、Web 端口可达与认证链健康;可用 `E2E_PORT` / `E2E_TIMEOUT_MS` / `E2E_KEEP_MS` 调整行为(见 `scripts/test-e2e.ts`);
- **新增插件**:仿照 `packages/guided-goal/package.json` 建 `packages/<name>/` 即可,`pnpm-workspace.yaml` 自动收录;
- **提交规范**:中文 Conventional Commits;开发走 `feat/*`、`fix/*` 分支合入 `dev`,验证后合入 `main`。

## License

MIT
