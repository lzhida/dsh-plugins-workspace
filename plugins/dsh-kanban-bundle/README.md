# @zhidal/dsh-kanban-bundle

看板模式聚合封装包：**一次安装同时装载** [看板基座 `@zhidal/dsh-taskboard`](../dsh-taskboard) 与
[看板模式预设 `@zhidal/dsh-kanban-mode`](../dsh-kanban-mode)。

纯 manifest 聚合包——无任何业务实现，只有 `package.json` + `cordis.patch.yml` +
`README.md`（无 `main` / `exports`），结构参照官方 dsh-mnemon 聚合形态与第三方
taskboard-bundle 先例：`dependencies` 引用两个组件包 + `dsh.bundle.patch` 指向补丁文件，
补丁内 insert 行的 `name` 直接指向组件 npm 包名。

## 安装

```sh
# 开发期（workspace 内，组件包为 workspace:* 协议）：先构建两组件产物再装本包
pnpm --filter @zhidal/dsh-taskboard build
pnpm --filter @zhidal/dsh-kanban-mode build
pnpm dsh plugin --profile <profile> add link:<仓库绝对路径>/plugins/dsh-kanban-bundle

# 发布后（组件包已发 npm、本包 dependencies 改为精确版本号时）
dsh plugin --profile <profile> add @zhidal/dsh-kanban-bundle
```

安装后自动装载两个组件插件。**只装本包一个即可（推荐用法）**——此时插件面板只有一张卡片、
一个总开关（`启用 @zhidal/dsh-kanban-bundle`）；进入该包详情页后，两个组件各有独立开关
`启用组件 @zhidal/dsh-taskboard` / `启用组件 @zhidal/dsh-kanban-mode`，可分别启停。

卸载：

```sh
pnpm dsh plugin --profile <profile> remove @zhidal/dsh-kanban-bundle
```

## 组件清单

| 包                        | 角色         | 本包行为                       |
| ------------------------- | ------------ | ------------------------------ |
| `@zhidal/dsh-taskboard`   | 看板基座     | 依赖并经补丁装载，不做任何修改 |
| `@zhidal/dsh-kanban-mode` | 看板模式预设 | 依赖并经补丁装载，不做任何修改 |

装完即得：宿主权威任务台账 + 十个 `taskboard_*` 工具 + Web 看板（SSE）+ `kanban-mode`
agent 预设（系统提示注入看板模式工作法七段）+ 内嵌建卡 skill `kanban-task-create` +
三个看板模式工具（`kanban_ready_cards` / `kanban_plan_check` / `kanban_schedule_run`）。

可选增强（条件式，未启用 / 未安装零影响）：安装官方 forge bundle
（`@deepseek-ai/dsh-experimental-forge-bundle`）并在插件页启用「变更请求与工作树」后，
看板任务的执行会话完成改动会开 PR，并把 **PR URL 回写 execution_report 与任务评论**
（验收人按 PR diff 审查）；未启用时按仓库常规 git 纪律收尾、不阻塞。三件套
（forge / worktree / subagent）启用步骤、官方限制与看板验收链衔接见
[../dsh-kanban-mode/docs/official-integration.md](../dsh-kanban-mode/docs/official-integration.md)。

## 行 id 与防重复挂载守卫

补丁两行的 **id 与两个组件包各自 `cordis.patch.yml` 的 insert 行 id 完全一致**
（`dsh-taskboard` / `dsh-kanban-mode`）：

- **行 id 必须与组件包一致**：loader 按 id 去重——bundle 层与组件包层对同一 id 只挂一份，
  避免「组件包单独安装 + 本包同时安装」时出现两套 SchedulerService（第二套会重复执行定时卡）。
- 每行另挂 `!!js` **disabled 守卫**（参照第三方 taskboard-bundle / dsh-better-sidebar 先例）：
  检测到同一组件包已由**其他 entry id** 挂载且未被禁用时，本行自动 disabled，只保留先挂载的
  那份。守卫只在「同包名、不同 entry id」时触发；在本仓当前组合（id 一致）下守卫恒不触发，
  重复挂载由 loader 按 id 去重兜底。已知限制：守卫在处理本行时求值，只能看到排在它之前的
  entry——要让守卫生效，对方 entry 必须排在前面（`dsh plugin add` 追加到列表尾部，天然满足）。

### 与组件包同装会怎样（已知坑）

同时安装本包与任一组件包时：loader 按 id 去重保证**不会双实例化、不会 boot 失败**，但插件面板
是三张平级卡片，本包详情页的「启用组件 …」开关会被禁用（提示「当前 profile 的 patch 无法唯一定位
这一项」），本包总开关形同虚设。**推荐只装本包**（单一总闸 + 组件可分别启停）。

另注：不要把本文件 insert 行拷进 profile 的 `cordis.patch.yml`（会双重实例化）；要改配置用
「同 id + config」覆盖，而不是再插一行。

> 开发者备注：对本包目录单独跑 `npx eslint plugins/dsh-kanban-bundle` 会报
> "all files matching the glob are ignored"（exit 2）——本包只有 YAML/Markdown，
> 没有可 lint 的 JS/TS 文件，属预期行为；根级 `pnpm lint`（`eslint .`）不受影响。

## 版本口径与首发例外

- **开发期**：`dependencies` 使用 `workspace:*` 协议，由 pnpm workspace 解析为本仓内链接。
- **发布时**：组件包先发 npm，再把本包 `dependencies` 从 `workspace:*` 改写为精确版本号
  （对齐官方 dsh-mnemon 无范围写法），避免组件包发新版后聚合包静默换底。
- **首发例外**：本包与两个组件包均为 `0.1.0` 首发包，按 AGENTS.md「首发例外」条款
  **不经 changeset**（写了会导致 `changeset:version` 把未发布的 0.1.0 顶成 0.1.1）；版本号在
  `package.json` 落定后直接打 tag 发布（对齐 dsh-patent / dsh-victauri 先例）。

## License

MIT
