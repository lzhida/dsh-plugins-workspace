# @lzhida/dsh-open-in-zed

用 [Zed](https://zed.dev) 编辑器打开 DSH 工作区目录的插件（Windows 优先）。

## 背景

dsh 桌面端 Web GUI 的「打开工作区目录」由官方插件对 `dsh-host-open-in-app`（HTTP 路由 +
**编译期应用目录表**）+ `dsh-client-ui-open-in-app`（Session 头部 "Open In..." 分裂按钮）实现。
目录表的 `zed` 条目只有 darwin/linux 定位器、缺 win32，所以 Windows 上只出现
文件管理器与 VS Code；且官方 README 明言 **目录表编译期固定，无插件扩展点**——
插件无法把 Zed 塞进官方按钮的菜单。

本插件因此采用「并排集成」：自建路由后端 + 官方 slot 体系注入自己的入口。

## 功能

- **Session 头部按钮**（`conversation.session.header.utilities`，order -9）：官方
  "Open In..." 控件旁的 Zed 图标按钮。
- **Session "..." 菜单项**（`sidebar.workspaces.session.menu.item`，order 500）：
  在 pin/rename/fork/archive 之后。
- **agent 工具 `open_in_zed`**：会话内让 agent 直接打开工作区（参数
  `workspaceId` / `path` / `newWindow`，失败时附带可用工作区清单）。
- **HTTP 路由**（同源）：
  - `POST /dsh-open-in-zed/open` — `{ workspaceId? | path?, newWindow? }`
  - `GET /dsh-open-in-zed/status` — zed 可用性探测（`--version`）
  - `GET /dsh-open-in-zed/workspaces` — 可打开的已注册工作区列表

## 安全边界

只允许打开 **workspace registry 已注册** 的工作区目录：任意路径一律 `403 forbidden`，
未知 id 一律 `404 not_found`；spawn 走 `execFile`（无 shell、无引号/注入面）。

## 配置

- 环境变量 `DSH_OPEN_IN_ZED_BIN`：指定 zed 可执行文件（绝对路径或 PATH 名）；
  默认 `zed`（PATH 解析）。
- Zed 未安装时所有入口返回可读指引（含环境变量名）。

## 双半区结构（对照 dsh-taskboard）

- host：`main: src/index.ts`，TS 源码直载，注册工具 + 路由。
- client：`exports["./client"] → client/index.js`，tsdown 产出
  `window.__ModuleLoader__.load` 惰性壳，**产物与源码一起提交**；
  重建：`pnpm build:client`。
- client `inject: ["slots", "sessions"]`——DSH client ctx 按 inject 声明守卫
  属性访问，缺声明的属性读取会抛错。

## 开发

```sh
pnpm --filter @lzhida/dsh-open-in-zed typecheck
pnpm --filter @lzhida/dsh-open-in-zed build:client
pnpm vitest run packages/dsh-open-in-zed
```

e2e（加载级 + 浏览器级）按 `.agents/skills/dsh-plugin-dev/SKILL.md` §5 编排。
