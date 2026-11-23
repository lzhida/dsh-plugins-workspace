# 官方 worktree 服务接入 spike（看板卡 t-mwps9716-mzyl0q）

目的：在改实现前，用真实隔离实例裁决三个接入问题——(a) 执行序与 cwd 冲突、(b) 传参映射、(c) 回收衔接。全部结论以实测输出 + 宿主/官方包源码双重佐证。

## 0. 环境与方法

- 全局官方 `dsh` CLI（Electron-as-node），版本 0.2.2-rc.5；未用 `pnpm dsh`（仓库 devDeps 为 0.2.1-rc.2，会被本包 engines 守卫拒绝）。
- 全新隔离 profile：`dsh --profile kanban-wt-smoke --from-default-profile web`（目录 `C:\Users\AI\.dsh\profiles\kanban-wt-smoke`）。
- 插件安装（`--profile` 在 `plugin` 之后、`link:` 用绝对路径）：
  ```sh
  node plugins/dsh-taskboard/scripts/build.ts
  dsh plugin --profile kanban-wt-smoke add link:E:/workspace/plugins/dsh-plugins-workspace/plugins/dsh-taskboard
  dsh plugin --profile kanban-wt-smoke add "@deepseek-ai/dsh-experimental-forge-bundle@0.2.2-rc.5"
  ```
  教训：首次 `add @deepseek-ai/dsh-experimental-forge-bundle`（不带版本）落到 registry 的 `0.2.2-alpha.2`（与宿主 asar 的 rc.5 不同源），已钉回 `0.2.2-rc.5`（实测 bundle 与 worktree 包均为 0.2.2-rc.5）。bundle patch 自动 insert 六行：worktree / tool-worktree / forge / forge-github / forge-session / forge-panel。
- web 实例（保持运行，见文末残留清单）：`dsh --profile kanban-wt-smoke --no-open --port 3080`，pid 13820。
- 驱动方式：CLI 无服务直调子命令（desktop-host 只接受 profile 启动与 `dsh plugin --profile <name> <pnpm-args>`），故经 HTTP 驱动：先 `POST /api/workspace/create` 注册工作区（typert RPC：`{type:'client-request',rpcId:'a1',method:'workspace/create',payload:{args:{request:{path}}}}`），再走 taskboard REST：
  ```sh
  # 鉴权：GET /?token=<token> 建 WebRequestSession cookie，请求带 Origin/Referer
  POST /dsh-taskboard/tasks   {"title":"spike: official create_worktree smoke","description":"...","prompt":"Call the create_worktree tool with name \"task/spike-t1\" and from \"HEAD\". Then reply with the exact JSON object the tool returned, and nothing else.","workspaceId":"1e647318-…","urgency":"relaxed","isolation":"none","permission":"workspace-write","execution":{"mode":"claim"}}
  POST /dsh-taskboard/tasks/t-mwpt6gf4-sdxffv/run  {}
  ```
  工作区指向系统临时目录里的 scratch repo（`%TEMP%\dsh-wt-spike\scratch-repo`，`git init -b main`，首提交 `0be76dc`）。
- 源码佐证来源：宿主 asar 提取（`%TEMP%\dsh-wt-spike\host\`，asar-extract.mjs）与官方包解包（`%TEMP%\dsh-wt-api\package\`）。

## (a) 执行序与 cwd 冲突

**结论：可行。「先 agents.create → setPermission → ctx.worktrees.create(agent, …)」成立；官方切换的是会话「有效工作目录」（投影层），不改 immutable session header.cwd，attachSession / 沙箱边界 / 侧栏分组三者都不受影响。无需把会话 cwd 固定在 workspace。**

源码证据：

1. 官方 `createCheckout`（dsh-experimental-worktree src/index.ts）末步 `ctx.workingDirectory.set(agent, path)`；而宿主 dsh-working-directory 的 `set` → `commit` = `agent.session.append('working-directory/change',{cwd})` + 用户可见通知。`SessionEventMap` 注释原文：_"Effective working directory; **the immutable Session header retains the original project**"_——投影层与 header 分离。
2. dsh-workspace `attachSession`（src/entity.ts:110-150）校验的是 **`session.header.cwd`**（realpath 后必须 === workspace record.path）。
3. dsh-sandbox-policy `sessionWorkspaceRoot`（src/index.ts:222-230）取 **`session?.header.cwd`** 为 workspace-write 边界。

实测证据：

- spike 任务执行 outcome=succeeded；agent 在官方 create 之后回报：服务自动切换会话工作目录到新 worktree，且 worktree 内 `rev-parse --abbrev-ref HEAD` = `task/spike-t1`、HEAD = baseCommit、`status --porcelain` 干净。
- 任务归档后读会话轨迹（`%USERPROFILE%\.dsh\sessions\--C-Users-AI-AppData-Local-Temp-dsh-wt-spike-scratch-repo--\session-taskboard-…\session.v4.jsonl.zstd`，zstd 解压）：
  ```json
  {
    "type": "session",
    "version": 4,
    "id": "session-taskboard-76dd4550-…",
    "createdAt": 1795229318759,
    "cwd": "C:\\Users\\AI\\AppData\\Local\\Temp\\dsh-wt-spike\\scratch-repo",
    "isSeeded": false,
    "delegationDepth": 0,
    "agentPreset": "standard"
  }
  ```
  header.cwd 仍是 scratch-repo（未被官方切换改写）。

实现序约束（两条，均已在宿主源码核实）：

1. 官方 create 需要活 Agent（第一步 `workingDirectory.ensure(agent)`）→ 必须**先建 agent**；本插件执行流现顺序（先备 worktree 后建 agent）需反转。
2. 官方 create 的 git 写需要沙箱非 read-only。宿主 sandbox `Config.mode` 默认 `'read-only'`（dsh-sandbox-policy src/index.ts:138 `.default('read-only')`，:90 "fail-safe default"）；任务的 permission preset（workspace-write）经 `permission/preset` 事件透传写 `sandbox/mode`（dsh-permission-presets src/index.ts:59/135/416），**仅对活会话生效** → 顺序必须是 agents.create → setPermission → worktrees.create。若任务 permission=read-only，官方 create 的 git 写会被沙箱拒绝 → 实现按官方错误降级 isolation:none 并提示（不得报错阻塞）。

## (b) 传参映射

**结论：`request.name` 直接用现行 `buildBranchName` 结果（`task/<标题>+<任务ID>`，含 '/'），官方接受且路径按 '/' 嵌套目录，实测可用；`request.from` 缺省 `'HEAD'`，可传固定基准提交。**

- 官方 name 校验（relativePath）：非空、无 `\` 无 `:`、'/' 分段非空且非 `.`/`..`、不以 `-` 开头；另过 `git check-ref-format refs/heads/<name>`。`task/foo+t-123` 形态合法。
- 实测：prompt 要求 agent 调 `create_worktree`，参数 `name="task/spike-t1"`、`from="HEAD"`。agent 评论原样回传官方返回 JSON：
  ```json
  {
    "path": "C:\\Users\\AI\\AppData\\Local\\Temp\\dsh-wt-spike\\scratch-repo\\.agents\\worktrees\\task\\spike-t1",
    "branch": "task/spike-t1",
    "baseCommit": "0be76dc56ce42bcff86bd6d63043478a6c38ca12",
    "repositoryRoot": "C:\\Users\\AI\\AppData\\Local\\Temp\\dsh-wt-spike\\scratch-repo"
  }
  ```
- 佐证 git 侧状态（scratch repo）：
  ```text
  $ git worktree list
  C:/Users/AI/AppData/Local/Temp/dsh-wt-spike/scratch-repo                                 0be76dc [main]
  C:/Users/AI/AppData/Local/Temp/dsh-wt-spike/scratch-repo/.agents/worktrees/task/spike-t1 0be76dc [task/spike-t1]
  ```
  官方 create 自动建池目录 `.agents/worktrees/`（池内自放 `.gitignore` 内容 `*`，池自忽略）。
- 错误语义（实现须捕获）：分支已存在 → `worktree branch already exists: <branch>`；路径已存在 → `worktree path already exists: <path>`；其余失败包装为 `Could not finish worktree <branch> at <path>. Any created checkout and branch are retained. <原因>`（失败保留已建 checkout 与分支，不自动清理）。
- 官方 API 缺口（实现按此处置）：**没有「存在即复用」**——create 遇已存在分支必失败，restore 要求路径不存在（仅回收后重建用）。续跑/复用既有 checkout 的官方组合方式是：宿主 `workingDirectory.set(agent, 既有worktree路径)` 把有效 cwd 指回去（服务组合，非自建 worktree 能力）。

## (c) 回收衔接

**结论：官方回收只挂在 Session 归档事件上；taskboard 结算（完成/取消）时不回收；归档任务即触发官方回收调度；但本环境实测归档后 checkout 与分支均被保留（retained），根因是归档冷会话的 sandbox 投影回落 read-only 默认。因此 taskboard 不能把结算清理寄托于官方自动回收——保留纯 git 收尾（merge --no-ff / `git worktree remove` / 分支删除）并在文案中给出遗留提示。**

事件链（宿主源码）：taskboard move→archived（archiveSessions:true）→ dsh-workspace `archiveSession`（src/index.ts:381，:403 `await this.ctx.parallel('workspace/session-archived',{sessionId})`）→ 官方 WorktreeReclamation schedule → 终态 `removed|retained|failed`。`cleanupOf(session, revision)` 只是**只读等待**已挂起的回收尝试（不触发；revision=null 匹配任意 attempt），服务未装回收器时恒 null。

实测（命令 + 输出）：

```sh
POST /dsh-taskboard/tasks/t-mwpt6gf4-sdxffv/move {"ifVersion":4,"status":"archived","archiveSessions":true}
# → 200 {"ok":true,"value":{…,"version":5,"sessionArchive":{"archived":["session-taskboard-76dd4550-…"],"failed":[],"unsupported":[]}}}
# 等待 ~60s 后：
$ git -C %TEMP%\dsh-wt-spike\scratch-repo worktree list
C:/…/scratch-repo                                 0be76dc [main]
C:/…/scratch-repo/.agents/worktrees/task/spike-t1 0be76dc [task/spike-t1]
$ git -C %TEMP%\dsh-wt-spike\scratch-repo branch -a
* main
+ task/spike-t1      # '+' = 仍挂载在 worktree 上
```

retained 根因（源码对齐，非猜测）：

1. 官方 `run()`（src/archive.ts）：`sandboxPolicy.resolve({session}).mode==='read-only'` → `retained`；`unused()`（任何**未归档**会话的有效 cwd 落在该 worktree 内，或其 worktree 记录引用同路径）不满足 → 非 unused 主因（归档的是唯一引用会话）。
2. 归档后的冷会话由 `sessionQuery.inspectSession` 冷加载，`sandboxPolicy.overrideOf` 走 `sandboxModeProjectionHandle.stateOf(session)`——投影折叠依赖活会话事件流，冷加载下返回 undefined → 回落 `Config.mode` 默认 `'read-only'`（dsh-sandbox-policy src/index.ts:138 `.default('read-only')`；本 profile cordis.yml 为空、未配置 sandbox 覆盖）。
3. 失败/保留只 `logger.warn`（"…cleanup of its worktree %s failed and its branch was retained: %s"），不向调用方报错——所以 UI 必须靠 taskboard 自己的文案兜底。

部署侧备注：若宿主把 sandbox `mode` 配置为 `workspace-write`，冷会话回落值不再是 read-only，官方回收即可生效。这是部署配置项，不是插件能改的——插件侧按「官方回收可能 retained」设计。

## 官方能力边界 → 实现约束清单

- 单仓单 worktree：池在源仓库内（`<repo>/.agents/worktrees/<branch>`），一次 create 只覆盖一个仓库 → **多仓镜像（prepareMirror）禁用**，任务/UI 文案与 README 声明。
- 作用域是 Agent/Session（create 必须传 Agent 实例）并**接管有效 cwd** → 执行序反转为 agents.create → setPermission → worktrees.create。
- 无 --no-ff 合并、无分支删除、无孤儿目录清理、无「立即移除」公开 API（cleanupOf 只读）→ 这些保留为 taskboard 的 **git 收尾**（结算 merge、purge/worktree-cleanup 动作用 `git worktree remove`（非 force，脏则拒）+ `branch -d`），属 git 收尾而非自建 worktree 能力。
- 续跑/复用：官方无存在即复用 → 分支已存在且本地记录有 checkout 路径时，用宿主 `workingDirectory.set(agent, path)` 指回既有 checkout；无记录则降级 isolation:none 并提示分支被占用。

## 实现落点（0.10.1，与本 spike 结论一一对应）

| spike 结论                                | 实现位置                                                   | 做法                                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) 执行序：先建 agent，再 create         | `src/host/execution.ts`                                    | 隔离准备移到 `agents.create` 成功之后（`prepareIsolation(handle.agent)`），**先备 worktree 后建 agent** 的旧序删除；`setPermission` 仍早于隔离准备（沙箱需非 read-only）                                                                      |
| (a) cwd 恒等 workspace 不变               | `src/host/isolation.ts` / `src/host/execution.ts`          | 官方 `create` 切的是有效 cwd（投影层），`header.cwd` 不变 → attachSession / 侧栏分组 / 沙箱边界不受影响；会话创建时仍传 `cwd: workspace.path`                                                                                                 |
| (b) `name` = 现行分支名，`from` 缺省 HEAD | `src/local/official-worktree.ts` + `src/host/isolation.ts` | `create(agent, { name: branch, ...(from ? { from } : {}) })`；`branch` 来自 `sanitizeBranchName(title, taskId)`（`task/<标题>+<任务ID>`，含 '/'，官方接受）                                                                                   |
| (b) 官方不覆盖既有分支                    | `src/host/isolation.ts`                                    | 上一轮隔离的 checkout 仍存活（`git.headOf` 可读）且分支一致 → **续用**（`workingDirectory.set(agent, path)`，`reused: true`，证据基线取该 checkout 当前 HEAD）；否则走官方 `create`；官方抛错 → 按 `classifyOfficialFailure` 分类给出降级文案 |
| (c) 回收挂会话归档                        | `src/host/routes.ts` + `src/host/git.ts`                   | 官方回收不受插件控制（冷会话回落 read-only → retained）；插件保留**纯 git 收尾**：任务详情「删除检出」、孤儿检出清理、物理清除任务时 `git worktree remove -- <path>`（非 force，脏则拒）+ `worktree prune`                                    |
| 单仓服务                                  | `src/host/isolation.ts` / `src/shared/protocol.ts`         | 多仓镜像（prepareMirror / removeMirror）删除；`MAX_MIRROR_REPOS` / `ExecutionRepoEvidence` 标注为遗留形状；表单与诊断面板文案声明「官方单仓」                                                                                                 |
| 服务可能缺席                              | `src/local/official-worktree.ts`                           | 软读取 `ctx.get('worktrees')`（形状校验 fail-soft），**不声明 inject 硬依赖**；缺席 → `isolation:none` + 「请启用官方 @deepseek-ai/dsh-experimental-forge-bundle」提示，任务照常执行                                                          |

## e2e 真机复验：重建后插件自身的隔离链路（决定性证据）

前三节验证的是「官方服务/官方工具语义」；本节验证 **0.10.1 重建后的 taskboard 插件自己驱动 `ctx.worktrees.create` 的完整链路**（不借手 create_worktree 工具）。

环境：全新隔离 profile `kanban-wt-smoke2`（`dsh --profile kanban-wt-smoke2 --from-default-profile web --no-open --port 3081`），安装重建后的 `link:E:/workspace/plugins/dsh-plugins-workspace/plugins/dsh-taskboard` 与 `@deepseek-ai/dsh-experimental-forge-bundle@0.2.2-rc.5`；工作区为 `%TEMP%\dsh-wt-spike\scratch-repo`。

命令与结果（taskboard HTTP API 驱动）：

```
POST /dsh-taskboard/tasks  {isolation:'worktree', permission:'workspace-write', execution:{mode:'claim'}, …}
  → 201 {ok,value:{id:'t-mwpvyl1f-72am56'}}
POST /dsh-taskboard/tasks/t-mwpvyl1f-72am56/run {}
  → 202 {ok,value:{executionId:'e-mwpvyl9p-lq8lo9', sessionId:'session-taskboard-2533b081-…'}}
GET  /dsh-taskboard/tasks/t-mwpvyl1f-72am56   （执行落定后）
  → execution: {
      outcome: 'succeeded',
      isolation: 'worktree',
      branch: 'task/e2e-official-isolati+t-mwpvyl1f-72am56',
      worktreePath: 'C:\\…\\scratch-repo\\.agents\\worktrees\\task\\e2e-official-isolati+t-mwpvyl1f-72am56',
      baseCommit: '0be76dc56ce42bcff86bd6d63043478a6c38ca12',
      headCommit: 'd6636b70e1a34391f16ab1d001ab4fbbb110a3ab',
      commits: [{hash:'d6636b7', subject:'test(e2e): 验证官方隔离路径创建工作目录文件'}],
      commitsTotal: 1, dirtyFilesTotal: 0, changedFiles: 1,
      diffStat: '1 file changed, 1 insertion(+)'
    }
  → 任务 status 自动进入 in_review（执行协议检测生效），task.branch 已钉为任务分支
```

git 侧佐证（scratch repo 内）：

```
git worktree list
  → main（0be76dc [main]）
  → .agents/worktrees/task/e2e-official-isolati+t-mwpvyl1f-72am56 (d6636b7 [task/e2e-official-isolati+t-mwpvyl1f-72am56])
Test-Path <repo>\e2e-isolation.txt                        → False（主区未被污染）
Test-Path <checkout>\e2e-isolation.txt                   → True （改动只落在官方检出内）
```

agent 评论（执行会话自动回写）：「已完成：在 worktree 工作目录创建 e2e-isolation.txt …并提交到任务分支 task/e2e-official-isolati+t-mwpvyl1f-72am56（commit d6636b7）」。

结论：`agents.create → attach → setPermission → ctx.worktrees.create(agent,{name}) → agent 在官方检出内工作 → 结算 collect 读 {path, baseCommit}` 全链路真机打通；隔离真实生效（主区零改动），结算证据（commits/diffStat）取自官方检出。

## 残留清单（本 spike 产生，未清理）

| 残留         | 位置                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web 实例进程 | pid 13820（DeepSeek Harness.exe，`--profile kanban-wt-smoke --no-open --port 3080`，启动于 2026-11-21 10:45:11），后台 job pwsh-dcd09b5b766b4c21                    |
| web 实例进程 | pid 36020（DeepSeek Harness.exe，`--profile kanban-wt-smoke2 --no-open --port 3081`，启动于 2026-11-21 12:03:02），后台 job pwsh-43619166ed544809                   |
| profile      | `C:\Users\AI\.dsh\profiles\kanban-wt-smoke` 与 `…\kanban-wt-smoke2`（均装 taskboard link + forge-bundle@0.2.2-rc.5）                                                |
| 会话归档残留 | profile 会话目录 + `--C-Users-AI-AppData-Local-Temp-dsh-wt-spike-scratch-repo--` 两个 session（taskboard 会话已归档；伴随会话 session-ebbd0f83 未归档）             |
| scratch repo | `%TEMP%\dsh-wt-spike\scratch-repo`（含官方创建的 `.agents/worktrees/task/spike-t1` 与 `…/task/e2e-official-isolati+t-mwpvyl1f-72am56` checkout 及同名分支，均保留） |
| 临时目录     | `%TEMP%\dsh-wt-spike\`（asar 提取、脚本、日志）、`%TEMP%\dsh-wt-api\`（官方包解包）                                                                                 |

破坏性清理一律未做，交由主控处置。
