# @lzhida/dsh-taskboard

Agent-first 任务看板插件：宿主权威任务台账 + **人建卡 → agent 认领执行 → 人验收** 全流程协作，附 SSE 实时看板 UI。

> **来源与署名**：本包源码同步自 [cloader/dsh-taskboard](https://github.com/cloader/dsh-taskboard) **v0.8.7**（commit `31e135a`，Apache-2.0），在本 monorepo 内做了「不改功能」的结构一致性重构（见[与上游的差异](#与上游的差异)）。功能面与上游一致，完整使用文档（安装形态、功能特性、安全模型、FAQ、升级日志）以上游 [README](https://github.com/cloader/dsh-taskboard#readme) 为准。后续在本包上叠加的自有功能以 changeset 记录版本。

## 功能概览

- **10 个 `taskboard_*` agent 工具**：`list` / `get` / `comments` / `create` / `update` / `move` / `comment_add` / `delete` / `checklist` / `execution_report`——任何会话可用，按项目（workspaceId）边界校验；
- **代码级协议闸**：agent 永远移不到 `done`、被持有时不可抢、跨项目不可认领、checklist 勾选必带 evidence note——失败路径由代码强制拒绝，不靠提示词约定；
- **实时看板**：SSE 刷新、五列流转、筛选排序持久化、JSON 导入导出、任务模板、图片附件、看板内 diff 查看器；
- **执行编排**：手动 / 一次性定时 / cron 定期（host 侧调度，浏览器关了照跑）；定时任务可复用既有会话；定期任务支持「回到待办」或「新建下一轮待办」；
- **Git worktree 隔离**：每次执行独立 worktree + 任务分支，验收一键合并；多仓库工作区整区镜像；非 git 项目自动降级原目录执行；
- **零配置**：安装即用，无需 Token / API Key，数据本地。

## 与上游的差异

monorepo 一致性重构，**功能行为不变**：

| 维度                  | 上游 0.8.7                             | 本包                                                                                             |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 包名 / cordis 行      | `dsh-taskboard`                        | 包名 `@lzhida/dsh-taskboard`，cordis 行 id 仍为 `dsh-taskboard`                                  |
| 版本                  | 0.8.7                                  | 0.8.7 起步，经 Changesets 递增                                                                   |
| 宿主入口              | `lib/index.js`（tsdown 构建式）        | `src/index.ts`（TS 源码直载，仅 link: 安装）                                                     |
| 客户端产物            | `lib/client.js`（构建，不提交）        | `client/index.js`（预构建，与源码一起提交；`pnpm build:client` 重建）                            |
| type-stripping 兼容   | 不要求（走构建）                       | 宿主半区构造器参数属性改显式字段（Node strip-only 模式不支持参数属性）                           |
| 装载日志              | 无                                     | `apply` 打印 `[dsh-taskboard] plugin loaded`（本仓 e2e 装载契约）                                |
| `@deepseek-ai/*` 依赖 | devDependencies（类型对齐 0.1.7-rc.2） | devDependencies、仅 type-only（类型对齐 0.2.0-rc.2，避免 SDK 双实例）                            |
| 测试                  | `tests/*.spec.ts`（vitest 3）          | `src/*.test.ts`（本仓 vitest 5 零配置发现，jsdom per-file docblock）；手动 `.mjs` e2e 脚本不入库 |

## 安装（仓库内开发）

本包是 TS 源码入口，**仅支持本地 `link:` 绝对路径安装**（实体安装会被 Node `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` 拒绝）：

```sh
pnpm install   # 仓库根执行一次，收录 workspace 依赖
pnpm dsh plugin --profile <name> add link:<仓库绝对路径>/packages/dsh-taskboard
```

安装后重启 `dsh web` 并刷新页面：侧边栏出现「任务看板」入口即成功。运行时依赖由宿主提供（`@deepseek-ai/*` 仅参与类型检查，不进运行时）。

## 数据与配置

- 台账：`<数据目录>/dsh-taskboard.json`（原子写，损坏文件自动 quarantine）；模板：`dsh-taskboard-templates.json`；附件：`dsh-taskboard-assets/`（内容寻址）；
- 数据目录默认 `DSH_HOME`（`~/.dsh`），可用 `~/.dsh/dsh-taskboard-storage.json` 重定向；
- 全局并发上限：环境变量 `DSH_TASKBOARD_MAX_CONCURRENT`（默认值见 `src/shared/protocol.ts` 的 `DEFAULT_MAX_CONCURRENT`）。

## 开发

```sh
pnpm --filter @lzhida/dsh-taskboard typecheck      # tsc --noEmit
pnpm --filter @lzhida/dsh-taskboard build:client   # 重建 client/index.js（改动 src/client 后执行并提交产物）
pnpm exec vitest run packages/dsh-taskboard        # 本包测试（28 个文件，含 jsdom 客户端用例与真实 git 镜像用例）
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test   # 仓库门禁链
```

e2e（真实 dsh 实例三断言 + 浏览器验证）按 `.agents/skills/dsh-plugin-dev/SKILL.md` §5 手工编排，统一 `test` profile。

## License

Apache-2.0（继承上游）。版权（c）cloader 及本仓贡献者；本包的 monorepo 重构改动同样以 Apache-2.0 发布。
