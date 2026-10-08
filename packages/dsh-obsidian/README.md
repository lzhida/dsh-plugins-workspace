# @lzhida/dsh-obsidian

dsh-obsidian 插件:把 Obsidian 内置 CLI(`obsidian <command> [key=value ...]`)封装为 dsh agent 可调用的 `obsidian_*` 工具集,附 system-prompt 协议 section 描述命令清单与安全约束,供 agent / 人工在 dsh 会话中统一操作 Obsidian vault。

- 命令来源:[Obsidian CLI 官方文档](https://obsidian.md/zh/help/cli)(官方维护)+ [社区命令参考](https://github.com/kennyg/obsidian-skill/blob/main/references/obsidian-cli.md)(交叉验证)。本仓库也封装了跑 `obsidian` 自带的命令清单,所有命令子集由 [`src/commands.ts`](src/commands.ts) 单一真源维护。
- 运行时依赖:本插件不打包 `obsidian` 二进制 — 它由 Obsidian 应用安装并暴露在 `PATH` 上(参见 [Obsidian 官方安装说明](https://obsidian.md/))。插件只负责**调用 + 错误归一 + 命令分类**。
- 鉴权面:无。`obsidian` CLI 默认操作当前激活 vault;多 vault 场景通过 `vault=<name>` 参数显式选择。

## 适配版本

| 组件     | 版本           | 说明                                                                                               |
| -------- | -------------- | -------------------------------------------------------------------------------------------------- |
| 宿主 dsh | **0.2.0-rc.2** | `system-prompt` 与 `tools` 运行时对齐;`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 已放行。 |
| 插件包   | 0.1.0          | 插件版本号与 dsh 版本号解耦,只跟随契约调整升版本;此处不升。                                        |
| Obsidian | **≥ 1.4**      | Obsidian CLI 在 1.4 起作为官方特性发布;请确认 `obsidian --help` 可用。                             |

## 安装

`dsh plugin add` 底层是 `pnpm add`,支持本地目录、`github:` / `git+https` / `git+ssh` / tarball 等多种源。

### 仓库内开发(本地 link)

```sh
pnpm install                     # 仓库根
dsh plugin add link:packages/dsh-obsidian
```

包内 `dsh.bundle.patch` 声明使其自动进入 profile 层,无需 overlay 注入。

### Git 安装(外部用户)

四种形式等价,都只装 `packages/dsh-obsidian` 子目录。`<ref>` 替换为想锁定的分支 / tag / 提交:

```sh
# 1. github: 简写(pnpm 8+ 解析为 https://github.com/<user>/<repo>/tarball/<ref>)
dsh plugin add github:lzhida/dsh-plugins-workspace#main\&path:packages/dsh-obsidian

# 2. git+https(显式完整 URL,需 git 客户端)
dsh plugin add git+https://github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-obsidian

# 3. git+ssh(需本机配过 SSH key)
dsh plugin add git+ssh://git@github.com/lzhida/dsh-plugins-workspace.git#main\&path:packages/dsh-obsidian

# 4. tarball 快照
curl -L https://github.com/lzhida/dsh-plugins-workspace/archive/refs/heads/main.tar.gz | tar -xz -C /tmp
dsh plugin add /tmp/dsh-plugins-workspace-main/packages/dsh-obsidian
```

> `&path:<subdir>` 是 pnpm 安装 git monorepo 子目录的标准语法。`<subdir>` 必须指向 monorepo 内一个真实存在的子目录。**注意**:历史上本 README 写的是 `#<ref>:<subdir>`(冒号),是错误的,pnpm 11/12 会报 `Could not resolve <ref>:<subdir> to a commit` —— 必须用 `&path:`。

### 装好后的手工验证

```sh
# 1. 验证 obsidian CLI 在 PATH 上(必备前置)
obsidian --version

# 2. 子包应已装入 profile node_modules
ls "$(dsh config profile-dir 2>/dev/null || echo $HOME/.dsh/profiles/<name>)/node_modules/@lzhida/dsh-obsidian"

# 3. 重启 dsh,确认设置 → 插件 → 「已启用」
```

## 9 个 obsidian_* 工具(高频 + 通用入口)

| 工具                    | 命令映射                | 危险等级     | 作用                                                     |
| ----------------------- | ----------------------- | ------------ | -------------------------------------------------------- |
| `obsidian_read`         | `obsidian read`         | 只读         | 读单条笔记正文(支持 `vault` 多 vault 选择)。             |
| `obsidian_create`       | `obsidian create`       | 写入         | 创建新笔记(`overwrite=true` 时覆盖)。                    |
| `obsidian_append`       | `obsidian append`       | 写入         | 向笔记末尾追加内容。                                     |
| `obsidian_search`       | `obsidian search`       | 只读         | 全文搜索(`path=` 限定子文件夹)。                         |
| `obsidian_daily`        | `obsidian daily:read`   | 只读         | 读今日 daily note。                                      |
| `obsidian_daily_append` | `obsidian daily:append` | 写入         | 写今日 daily note。                                      |
| `obsidian_properties`   | `obsidian properties`   | 只读         | 列笔记的 front-matter 属性(或 vault 全局统计)。          |
| `obsidian_vault`        | `obsidian vault`        | 只读         | 查当前 vault 元信息。                                    |
| `obsidian_run`          | 任意 `obsidian <sub>`   | 取决于子命令 | 通用入口,执行 `commands.ts` 清单里的任意子命令(35+ 个)。 |

> 全部 35+ 条 CLI 子命令(覆盖 `file:move` / `delete` / `property:set` / `plugin:enable` / `command` / `reload` 等)的清单与危险等级都活在 [`src/commands.ts`](src/commands.ts) 与 system-prompt section 文本里(由 `src/protocol.ts` 渲染)。README 不复述 — 那是漂移源。

## 错误码

工具层把所有错误归一为 `[CODE] message` 文本,model 按码字面匹配:

| 码                        | 含义                                                              | 用户动作                                            |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- |
| `OBSIDIAN_CLI_NOT_FOUND`  | `PATH` 上找不到 `obsidian` 可执行。                               | 安装 Obsidian / 暴露 CLI 到 PATH。                  |
| `OBSIDIAN_INVALID_INPUT`  | 必填参数缺失 / 子命令名不在 `commands.ts` 清单。                  | 补参数 / 改用 `obsidian_run` 时只取清单里的子命令。 |
| `OBSIDIAN_SPAWN_FAILED`   | 子进程 spawn 失败(权限等)。                                       | 检查文件权限 / 工作目录。                           |
| `OBSIDIAN_TIMEOUT`        | 超过 `timeoutMs`(默认 30s,上限 600s)。                            | 加 timeout / 收窄请求。                             |
| `OBSIDIAN_NONZERO_EXIT`   | obsidian 退出码非 0(罕见)。                                       | 看 stderr。                                         |
| `OBSIDIAN_PROTOCOL_ERROR` | obsidian 在 stdout 以 `Error:` 开头表示的语义错误(退出码仍为 0)。 | 读 stdout,不要盲重试。                              |

## 危险等级(在 system-prompt 文本里同步落地)

| 等级          | 触发条件                                                                                                                                                                                                                   | 协议行为                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `read`        | `read` / `search` / `properties` / `vault` / `tags` / `plugins` / `snippets` / `commands` / `folders` / `vaults` / `file` / `files` / `daily:read` / `daily:path` / `property:read` / `search:context`                     | 无副作用,直接调。                                                        |
| `write`       | `create` / `append` / `prepend` / `file:move` / `property:set` / `property:remove` / `plugin:enable` / `plugin:reload` / `snippet:enable` / `daily:append` / `daily:prepend` / `open` / `search:open` / `daily` / `reload` | 修改 vault;description 注明会改 vault,model 应口头告知用户。             |
| `destructive` | `delete` / `plugin:disable` / `snippet:disable`                                                                                                                                                                            | 删除/禁用;在 protocol section 强制要求 model 二次确认(除非用户已经明确). |
| `execute`     | `command`                                                                                                                                                                                                                  | 执行任意 Obsidian 命令面板命令,行为不可预测;必须经宿主权限闸。           |

## 设计选择

1. **单进程 spawn 抽象**(`RunnerSpawner`):把 `child_process.spawn` 抽成接口,便于单测用假体注入 — 见 `src/runner.ts` 与 `src/index.test.ts` 的 `mockSpawner` 模式。
2. **错误归一**:`ObsidianError` + `OBSIDIAN_ERROR_MESSAGES` + `[CODE] message` 文本约定,model 可以直接字符串匹配错误码;不引入 dsh-tools 的 `ToolArgsError` 等内部错误类型,避免协议文本分裂。
3. **布尔标志约定**:Obsidian CLI 的布尔标志(如 `overwrite` / `permanent`)在插件 schema 里是 `boolean`,runner 拼 argv 时把 `true` 拼为 `name=true`、`false` 视为未传(等价于 `obsidian create ... overwrite`)。
4. **`Error:` 前缀归一**:Obsidian 进程退出码 0 但 stdout 以 `Error:` 开头是协议层的语义错误,runner 把它转成 `OBSIDIAN_PROTOCOL_ERROR`,把 stdout 当作错误消息塞回 model;不重试。
5. **stdout/stderr 截断**:stdout 20k,stderr 4k;超出加 `[truncated to N chars]` 标记。
6. **`obsidian_run` 通用入口**:35+ 条子命令全列在 `commands.ts`,但只对 8 条高频子命令单独 `defineTool` 暴露;其余走 `obsidian_run`,在 description 强制写明 "command 必须取自 commands.ts 清单"(防模型虚构 CLI flag)。
7. **不打包 obsidian 二进制**:本仓库不下载 Obsidian 应用;依赖宿主 `PATH` 上的 `obsidian` 命令(Obsidian 应用安装时暴露)。`OBSIDIAN_CLI_NOT_FOUND` 在第一次调用时由 runner 暴露。

## 不做的事(显式排除)

- 不实现 `obsidian print` 这种 GUI 驱动调用 — CLI 不暴露此能力。
- 不实现 vault 多进程 / 并发锁 — Obsidian CLI 单进程语义,本插件完全信任。
- 不接 `ctx.settings` 持久化 `defaultVault` — 教学版只接受每次调用显式传 `vault`;后续若要全局默认,挂 `ctx.settings` 即可,改动落在 `src/tools.ts` 的 `createObsidianTools` 入参。
- 不打包 `obsidian` 二进制 / 不接管 Obsidian 进程生命周期 — 卸载时 `ctx.effect` 收割子进程(子进程生命周期绑定 `exec.signal`)。
- 不实现 schema 校验外的强制二次确认闸 — 写入/破坏类工具的 description 写明"会改 vault",把二次确认交给 model;宿主权限闸已经在 dsh-tools 层覆盖,本插件不重复加锁。
