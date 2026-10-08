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

### @lzhida/dsh-obsidian

把 [Obsidian 内置 CLI](https://obsidian.md/zh/help/cli)(`obsidian <command> [key=value ...]`)封装为 dsh agent 可调用的 `obsidian_*` 工具集,统一供 agent / 人工在 dsh 会话内操作 Obsidian vault。命令分类(35+ 条子命令,覆盖 `file:move` / `delete` / `property:set` / `plugin:enable` / `command` / `reload` 等)由 [`src/commands.ts`](./packages/dsh-obsidian/src/commands.ts) 单一真源维护,system-prompt section 同步渲染命令表与安全约束,README 不复述以防漂移。

**核心特性**

- **9 个 `obsidian_*` 工具**:`obsidian_read` / `create` / `append` / `search` / `daily` / `daily_append` / `properties` / `vault` + 通用入口 `obsidian_run`(覆盖 35+ 条子命令,model 知道命令名才能调;description 强制写明「command 取自 commands.ts 清单」防虚构);
- **危险等级四档**:read / write / destructive / execute — 由 commands.ts 标注,protocol section 写明每档的二次确认/权限闸要求;
- **错误归一**:所有失败归一为 `[CODE] message` 文本(`OBSIDIAN_CLI_NOT_FOUND` / `OBSIDIAN_INVALID_INPUT` / `OBSIDIAN_SPAWN_FAILED` / `OBSIDIAN_TIMEOUT` / `OBSIDIAN_NONZERO_EXIT` / `OBSIDIAN_PROTOCOL_ERROR`),model 直接字符串匹配;Obsidian 特有的 `Error:` stdout 前缀被 runner 转成 `OBSIDIAN_PROTOCOL_ERROR`;
- **stdio 截断**:stdout 20k / stderr 4k,超出加 `[truncated to N chars]` 标记;
- **不打包二进制**:`obsidian` 由 Obsidian 应用暴露到 `PATH`;缺失时第一次调用即报 `OBSIDIAN_CLI_NOT_FOUND`,给出明确恢复提示;
- **system-prompt section**:`tool:obsidian` order=2960(与 `tool:taskboard` 2950 同档,排在它之后),加载即向 model 注入 35+ 条命令清单与安全约束;
- **零配置**:安装即用,默认用激活 vault;多 vault 场景在每次调用时显式传 `vault=<name>`。

**前置**:本机安装 Obsidian(≥1.4,提供 `obsidian` CLI);若 `obsidian --version` 失败,先修复 PATH。

### @lzhida/dsh-taskboard

任务看板插件(教学复刻自 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard#readme)):**人建卡 → agent 认领执行 → 人验收** 的核心契约层。10 个 `taskboard_*` agent 工具 + 代码级协议闸(agent 永远移不到 done、被持有时不可抢、跨项目不可认领、checklist 勾选必带 evidence note),ifVersion 乐观并发,DoD 验收清单(≤30 项),结构化执行报告,system-prompt section 写明认领纪律与 done-gate。台账落 `~/.dsh/dsh-taskboard.json` 原子写持久化。

**核心特性**

- **10 个 `taskboard_*` 工具**:`taskboard_list` / `get` / `comments` / `create` / `update` / `move` / `comment_add` / `delete` / `checklist` / `execution_report`——任何会话可用,按项目边界(workspaceId)校验;
- **代码级协议闸**:四类失败路径由代码强制拒绝(`DONE_FORBIDDEN` / `TASK_HELD` / `CROSS_PROJECT_FORBIDDEN` / `CHECKLIST_NOTE_REQUIRED`),不靠提示词约定;
- **ifVersion 乐观并发**:update / move / checklist / trash 全部要求 ifVersion 匹配,过期版本抛 `VERSION_CONFLICT`;
- **DoD 验收清单**:建卡时定验收条件(≤30 项,每项 ≤200 字符),agent 勾选必须附 evidence note(命令/文件/测试),用户在详情页可独立勾选,清单全勾也不自动 done;
- **结构化执行报告**:`taskboard_execution_report` 提交(摘要 / 改动文件 / 自验 / 产物 / 风险),待验收详情页分栏渲染;
- **五列流转 + 软删除**:backlog / todo / in_progress / in_review / done + canceled / archived / trashed;状态机白名单限制非法转移;
- **system-prompt section**:`tool:taskboard` order=2950 声明认领纪律、done-gate、retry 规则,模型在第一次调用前就知道协议;
- **零配置**:安装即用,无需 Token / API Key,数据本地。

**主动排除的能力**(教学复刻范围,非完整 1:1 移植):Web UI 看板、cron 调度器、worktree 隔离执行、外部会话自动同步、多仓库镜像、任务模板、图片附件。详见[包 README](./packages/dsh-taskboard/README.md)。

### @lzhida/dsh-test-runner

把 `.agents/skills/dsh-plugin-dev/scripts/test-e2e.ts` 的 e2e 编排能力拆为 5 个 `test_runner_*` agent 工具,供任意 dsh agent 在会话内调用(而非开发者手跑 shell 脚本)。基于真实 dsh `~/.dsh/profiles/<name>` 隔离 profile 启动 Web,跑三项断言(插件加载日志 / 端口可达 / tokened URL 页面),不污染当前 default profile 与已运行实例。

**5 步法**:

| 步骤 | 工具                          | 用途                                                                                        |
| ---- | ----------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | `test_runner_review_profiles` | 审查 `~/.dsh/profiles/`,标记 test 用途 profile;`createIfMissing=true` 时按官方 web 模板新建 |
| 2    | `test_runner_install`         | 把被测插件装入 test profile(自动维护 cordis.patch.yml 兼容 local executor)                  |
| 3    | `test_runner_boot`            | 后台启动 `dsh web`,返回 `sessionId` + tokened URL;`ctx.effect` 卸载时强 kill                |
| 4    | `test_runner_run_assertions`  | 轮询收集三项断言,**可重复调用直到就绪**                                                     |
| 5    | `test_runner_cleanup`         | 显式 kill 进程 + 卸载被测插件,恢复 profile 干净态                                           |

**核心特性**

- **三种调用路径**:开发者 shell 直跑(`npx tsx .../test-e2e.ts`)/ 后台 job + 浏览器接管 / dsh agent 会话内 5 步法 — 选最贴合上下文的;
- **可分步 / 可并发**:每个工具独立可调,agent 决定串行或并发的节奏,失败时按上下文灵活重试;
- **profile 隔离 + 自动清理**:`test_runner_cleanup` 显式杀进程与卸载插件;不调用 cleanup 时,`ctx.effect` 卸载兜底;
- **local executor 兼容**:自动按需给 profile 的 cordis.patch.yml 追加"禁用 permission presets"段(与 test-e2e.ts 行为一致);
- **system-prompt section**:`tool:test-runner` order=2850,模型在调用工具前能看到 5 步法协议;
- **审计清单(DoD 风格)**:加载日志契约 `[<name>]`、默认 port=3865、profile 隔离、cleanup 显式 — 全部 hard-coded 进工具 description。

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh。

```sh
# 引导式 goal 命令(独立,不依赖执行器)
pnpm dsh plugin --profile default add link:packages/dsh-guided-goal

# Obsidian 操作(独立,9 个 obsidian_* 工具 + 通用入口,封装 Obsidian 内置 CLI)
pnpm dsh plugin --profile default add link:packages/dsh-obsidian

# 任务看板(独立,10 个 taskboard_* 工具 + 代码级协议闸)
pnpm dsh plugin --profile default add link:packages/dsh-taskboard

# 插件 e2e 测试 agent 工具(独立,把 test-e2e 编排拆为 5 个 test_runner_* 工具)
pnpm dsh plugin --profile default add link:packages/dsh-test-runner
```

安装后在 dsh Web UI 的设置 → 插件中确认目标插件已启用:guided-goal 在会话输入框使用 `/guided-goal`;taskboard 在任意会话中由模型用 `taskboard_*` 工具集协作;test-runner 在任意会话中由模型用 `test_runner_*` 工具集驱动插件 e2e 测试,默认 profile 名 `e2e`、默认端口 3865。

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
