# dsh-plugins-workspace

[English](./README.en.md) | 简体中文

[dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)(DeepSeek Harness)插件集合——TypeScript + cordis 插件 monorepo。插件默认以 TS 源码形态被 dsh loader 直接加载,无构建步骤(例外:`@zhidal/dsh-llm-fallback` 构建式发行,入口为 esbuild 打包的 dist,已发布 [npm](https://www.npmjs.com/package/@zhidal/dsh-llm-fallback))。

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

任务看板插件(源码同步自 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard#readme) **0.8.7**,Apache-2.0):**人建卡 → agent 认领执行 → 人验收** 的全功能任务看板。10 个 `taskboard_*` agent 工具 + 代码级协议闸,ifVersion 乐观并发,DoD 验收清单(≤30 项),结构化执行报告,SSE 实时看板 UI,宿主侧 cron / 一次性定时执行,按任务指定模型与 preset,可选 git worktree 隔离(任务分支 + 一键合并 + 多仓库整区镜像),外部会话自动同步,任务模板与图片附件。台账落 `~/.dsh/dsh-taskboard.json` 原子写持久化。

**核心特性**

- **10 个 `taskboard_*` 工具**:`taskboard_list` / `get` / `comments` / `create` / `update` / `move` / `comment_add` / `delete` / `checklist` / `execution_report`——任何会话可用,按项目边界(workspaceId)校验;
- **代码级协议闸**:四类失败路径由代码强制拒绝(`DONE_FORBIDDEN` / `TASK_HELD` / `CROSS_PROJECT_FORBIDDEN` / `CHECKLIST_NOTE_REQUIRED`),不靠提示词约定;
- **ifVersion 乐观并发**:update / move / checklist / trash 全部要求 ifVersion 匹配,过期版本抛 `VERSION_CONFLICT`;
- **DoD 验收清单**:建卡时定验收条件(≤30 项,每项 ≤200 字符),agent 勾选必须附 evidence note(命令/文件/测试),用户在详情页可独立勾选,清单全勾也不自动 done;
- **结构化执行报告**:`taskboard_execution_report` 提交(摘要 / 改动文件 / 自验 / 产物 / 风险),待验收详情页分栏渲染;
- **五列流转 + 软删除**:backlog / todo / in_progress / in_review / done + canceled / archived / trashed;状态机白名单限制非法转移;
- **system-prompt section**:`tool:taskboard` order=2950 声明认领纪律、done-gate、retry 规则,模型在第一次调用前就知道协议;
- **实时看板 UI**:SSE 刷新 + 官方 slot 双轨挂载(dsh ≥ 0.1.7 一等侧边栏面板,旧 shell 自动回落 DOM 注入),diff 查看器、筛选排序持久化、JSON 导入导出;
- **执行编排**:手动 / 一次性定时 / cron 定期(host 侧调度,浏览器关了照跑);定时任务可复用既有会话,定期任务支持完成后「回到待办」或「新建下一轮待办」;
- **Git worktree 隔离**:每次执行独立 worktree + 任务分支,验收一键合并;多仓库工作区整区镜像;非 git 项目自动降级原目录执行;
- **任务模板与图片附件**:内置任务模板,内容寻址附件存储;
- **零配置**:安装即用,无需 Token / API Key,数据本地。

**与上游的差异**(monorepo 一致性重构,功能不变):包名 `@lzhida/dsh-taskboard`、TS 源码入口(`main: src/index.ts`,仅 link: 安装)、客户端预构建产物提交于 `client/index.js`、宿主半区构造器参数属性转显式字段(Node type-stripping 兼容)、`@deepseek-ai/*` 全部 devDependencies 且仅 type-only 引入。详见[包 README](./packages/dsh-taskboard/README.md)。

## 安装

前置:Node ≥ 22、pnpm 11、已安装 dsh。

> **⚠️ 安装限制**:以下插件均为 TS 源码入口,**仅支持本地 `link:` 安装且必须为绝对路径**——`link:` 相对路径按 pnpm 语义解析到 profile 目录(`~/.dsh/profiles/<name>/packages/...`),安装必败;git/npm/tarball 实体安装会被 Node 以 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 拒绝加载。实体安装仅支持 dist 入口的 [dsh-llm-fallback](./packages/dsh-llm-fallback/README.md)。

```powershell
# 仓库根目录执行(PowerShell)。Git Bash 把路径表达式换成 "$(pwd -W)",POSIX 用 "$(pwd)"
pnpm dsh plugin --profile default add "link:$($PWD.Path -replace '\\','/')/packages/dsh-guided-goal"   # 引导式 goal 命令(独立,不依赖执行器)
pnpm dsh plugin --profile default add "link:$($PWD.Path -replace '\\','/')/packages/dsh-obsidian"      # Obsidian 操作(独立,9 个 obsidian_* 工具 + 通用入口,封装 Obsidian 内置 CLI)
pnpm dsh plugin --profile default add "link:$($PWD.Path -replace '\\','/')/packages/dsh-taskboard"     # 任务看板(独立,10 个 taskboard_* 工具 + 代码级协议闸)
```

安装后在 dsh Web UI 的设置 → 插件中确认目标插件已启用:guided-goal 在会话输入框使用 `/guided-goal`;taskboard 在任意会话中由模型用 `taskboard_*` 工具集协作。

## 开发

```sh
pnpm install        # 安装依赖并自动执行 lefthook install
pnpm lint           # ESLint(flat config,TS)
pnpm format         # Prettier 写入(format:check 仅校验)
pnpm typecheck      # 递归各包 tsc --noEmit
pnpm test           # Vitest,全仓 src/**/*.test.ts
```

- **纯 TypeScript**:插件无构建步骤,`package.json` 的 `main` 直接指向 `src/index.ts`,由宿主 dsh loader 加载;
- **E2E**:无专用脚本——按 [.agents/skills/dsh-plugin-dev/SKILL.md](./.agents/skills/dsh-plugin-dev/SKILL.md) §5 的手工 CLI 流程,以独立 profile(默认 `e2e`,缺失时从官方 web 模板引导)启动真实 dsh 实例;插件列表按 profile 隔离,`DSH_HOME` 共享全局 `~/.dsh`(模型凭证不隔离);断言 `[<name>]` 加载日志、端口可达与 tokened URL 页面健康,测完 `plugin remove` 清理;
- **新增插件**:仿照 `packages/dsh-guided-goal/package.json` 建 `packages/<name>/` 即可,`pnpm-workspace.yaml` 自动收录;
- **提交规范**:中文 Conventional Commits;开发走 `feat/*`、`fix/*` 分支合入 `dev`,验证后合入 `main`。
- **CI**:GitHub Actions 流水线([.github/workflows/ci.yml](.github/workflows/ci.yml))在 push / PR 面向 `main`、`dev` 时运行,Ubuntu 上 Node 22 / 24 双版本执行与本地一致的 `format:check → lint → typecheck → test` 门禁链;[tests/ci-workflow.test.ts](tests/ci-workflow.test.ts) 作为配置回归测试,守护工作流引用的脚本、门禁顺序与 action 固定版本。e2e 与 npm 发布不在 CI 范围内(前者需真实 dsh 实例与凭证,后者需发布授权)。

## License

MIT
