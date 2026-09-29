# @lzhida/dsh-session-stats

同步本地 **DSH（DeepSeek Harness）** 的全部会话文件，生成 oh-my-pi（omp-stats）风格的本地用量统计面板。

## 数据来源

| 来源     | 位置                                                  | 说明                                                                                         |
| -------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 会话日志 | `~/.dsh/sessions/<项目>/<会话>/session.v4.jsonl.zstd` | 「一行一帧」的独立 zstd 帧拼接，逐事件记录会话全过程；同时扫描 `~/.dsh/profiles/*/sessions/` |
| 用量账本 | `~/.dsh/dsh-usage/usage-ledger.json`                  | dsh 自维护的按日×provider×model 聚合；已归档清理的会话只剩这份账本                           |

两路数据**逐日对账**（取较大者）：会话文件提供会话/工具/模型级精确统计，账本补齐被归档会话的历史缺口，互不双计。

## 提取的统计维度

- 概览：会话数、项目数、消息/轮次/步骤、Token（输入/输出/缓存读/缓存写/推理）、活跃天数、日均、Top 模型/工具、LLM 重试
- 每日用量堆叠图（缓存读 / 输入 / 输出，账本补齐的日期带 • 标记）
- 模型（provider/model 粒度）、Provider 汇总、小时分布热力
- 工具调用排行（调用次数 / 平均与累计耗时 / 失败数）
- 项目汇总（按 cwd）、最近会话列表、失败码分布

## 使用

### 方式一：dsh 内集成（推荐，无独立端口）

```sh
pnpm dsh plugin --profile <name> add link:packages/dsh-session-stats
pnpm dsh --profile <name>          # profile 需自 web 模板引导
```

安装后打开 dsh Web UI → 右侧边栏 guide 页 →「会话统计」入口点击即入。
宿主插件把 API 挂在 dsh 自身 `/api` 通道（`client-connection` 鉴权），
客户端插件经 `sidebarRightTabs` 注册页类型与 guide 卡片,渲染进右侧栏 tab。

### 方式二：独立运行

```sh
pnpm --filter @lzhida/dsh-session-stats stats:sync    # 同步会话文件到 store
pnpm --filter @lzhida/dsh-session-stats stats:serve   # 面板 http://127.0.0.1:3848
pnpm --filter @lzhida/dsh-session-stats stats:export -- --out stats.html  # 单文件静态导出
```

参数：`--home <dir>`（DSH 主目录，默认 `~/.dsh`，可用 `DSH_HOME` 覆盖）、`--store <file>`、`--force`、`--port <n>`（默认 3848）、`--range 7d|30d|90d|all`。

环境要求：Node ≥ 22.15（内建 `zlib` zstd 解码）。

## HTTP API

- `GET /api/sync` — 增量同步（mtime/size 未变的文件直接复用记录）
- `GET /api/stats?range=7d|30d|90d|all` — 仪表盘全量数据
- `GET /api/health` — 健康检查

## 面板布局与多语言

- **侧栏多视图**（参考 omp-stats）：概览 / 模型 / 工具 / 项目 / 会话 / 错误，hash 路由可深链（如 `#/models`），范围筛选（7d/30d/90d/all）全局生效
- **中英文切换**：侧栏底部 中文/EN 切换器；优先级 `?lang=en|zh` → localStorage → 浏览器语言；切换同步 `<html lang>` 与页面标题

## 实现

- `src/zstd.ts` — 复刻 `@deepseek-ai/dsh-session-persistence-jsonl` 的帧边界扫描 + 截断帧前缀恢复
- `src/extract.ts` — 事件流 → `SessionRecord`（模型路由跟随 `request/context`、`request/header`）
- `src/store.ts` — 增量 store（`~/.dsh/dsh-session-stats/store.json`，原子写）
- `src/aggregate.ts` — 范围过滤 + 逐日对账聚合
- `client/src/app.tsx` — React 19 前端源码（TSX）：侧栏多视图导航、中英双语、概览卡片、原生 SVG 堆叠图、表格、小时热力、tooltip、暗/亮主题
- `web/app.js` — **提交的打包产物**：`pnpm --filter @lzhida/dsh-session-stats build:client`（esbuild IIFE，production React 内联，零运行时依赖），与仓库其他插件的「源码 + 提交产物」模式一致；serve 与 export 共用该产物
- `web/index.html` + `web/styles.css` — 页面骨架与主题样式（export 时 CSS/JS/数据全部内联为单文件）

## License

MIT
