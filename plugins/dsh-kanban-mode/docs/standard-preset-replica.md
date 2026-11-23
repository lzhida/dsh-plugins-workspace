# standard 预设行集的来源与跟版策略

## 来源

| 项           | 值                                                                                 |
| ------------ | ---------------------------------------------------------------------------------- |
| 上游版本     | DSH **0.2.2-rc.5**（本机安装包 `E:\Programs\DeepSeek Harness\resources\app.asar`） |
| 上游文件     | `dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`（137 行）   |
| 取用范围     | 只取 `config.plugins` 段（`config.id: standard`、`config.order: 1`）               |
| 本仓复刻位置 | `src/preset-def.ts` 的 `standardPluginRows()`                                      |

官方 standard 预设的结构是「一行 `@deepseek-ai/dsh-agent-preset` 声明」，其 `config.plugins`
就是标准工作台面的行集：人设、工作区指令、时间上下文、shell、文件、检索、后台作业、定时、
skill、目标、计划模式组、压缩组、委派组、交互、任务跟踪、联网、交付、插件管理。

## 复刻口径

1. **逐行复刻**：行 id、行名、行内 `config` 照抄上游，只有两处例外与一处有意扩展
   （见下）。
2. **人设前缀**：`persona.config.prefix` 换成看板定位文案，但**保留 `{{model}}` 占位符**
   （宿主在提示装配时插值模型名）。
3. **`!!js` → `__jsExpr`**：声明式 YAML 里的 `!!js <expr>` 在编程式注册路径上用
   `{ __jsExpr: '<expr>' }` 表达。依据：宿主 loader 的 `Entry._resolveDisabled` 求值
   `disabled` 节点，插件挂载时的 `internal/config` 钩子对 `config` 做递归插值
   （任意深度），语义与声明式一致。上游 standard 里的 4 处：
   - `tool-bash.disabled` → `process.platform === 'win32'`
   - `tool-pwsh.disabled` → `process.platform !== 'win32'`
   - `skill-filesystem.config.customSkillDirs[0]` → `process.getBuiltinModule('node:path').join(...)`
   - `tool-plugin-manager.disabled` → `!ctx.get('profileContext')`
4. **isolate 组原样保留**：`planning` / `compaction` / `delegation` 三个 `cordis:group` 的
   `group`、`isolate`、`config` 结构照抄。它们不是可选装饰——预设子树若把 service 发布到
   root realm，宿主会以 `Preset services require isolate realms: <names>` 让整份预设挂载失败。
5. **不挂 tools provider 行**：官方 standard 不含 tools provider 行，tools service 由宿主继承。

## 与上游的差异清单（两处复刻偏差 + 一处有意扩展）

| 位置                        | 上游 standard    | 本包                                                                                                                                                                                                                                                          |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `persona.config.prefix`     | 通用编码代理人设 | 看板定位文案（保留 `{{model}}`）                                                                                                                                                                                                                              |
| 行集末尾                    | 无               | 追加一行 `{ id: kanban-board-context, name: '@zhidal/dsh-kanban-mode/board-context' }`                                                                                                                                                                        |
| delegation 组内（有意扩展） | 5 行             | 追加两行官方可选工具行 `{ id: tool-subagent-codex / tool-subagent-claude-code, name: '@deepseek-ai/dsh-tool-subagent' }`（provider 行绝不入预设；可选性由官方「提供方存在才注册、离开即释放」语义兜底，见 [docs/official-subagent.md](official-subagent.md)） |

扩展不属于复刻偏差：上游行集本身零改动，扩展行在提供方未安装时不挂载、不影响
行集其余部分的复刻语义。

## 硬红线：行集内不得出现 dsh-taskboard

宿主根层已经注册了 `taskboard_*` 工具。预设内再挂 dsh-taskboard 插件，会在该作用域再注册一套
同名工具（遮蔽根层工具），并额外实例化**第二套 SchedulerService** → 定时卡被重复执行。

因此：

- `src/preset-def.ts` 的行集里没有任何指向 dsh-taskboard 的行；
- `src/preset-def.test.ts` 断言「行 id / 行名不得匹配 taskboard，且序列化结果不得出现
  `@zhidal/dsh-taskboard`」；
- `scripts/build.ts` 断言「两个产物都不得把 `dsh-taskboard` / `@zhidal/dsh-taskboard`
  作为插件名或包名引入」（看板**文案**里出现 `taskboard_list` 这类工具名是允许的：工具由宿主
  根层提供，预设只引用、不挂插件行）。

## 跟版策略（上游 standard 漂移怎么办）

上游 standard 是**快照**，DSH 升级后可能增删改行。检测与同步流程：

1. **取上游原文**：从本机安装包解出
   `app.asar → dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml`
   （asar 是打包归档，需用解包工具读，不能直接当普通目录访问）。
2. **跑探针单测**：`src/preset-def.test.ts` 里的 `STANDARD_ROW_IDS` 锁住了行 id 顺序。
   上游增删行 → 该单测失败 → 说明复刻已漂移，必须同步。
3. **逐行 diff**：把上游 `config.plugins` 与 `src/preset-def.ts` 的 `standardPluginRows()`
   对照，只允许「人设前缀」「末尾看板上下文行」两处复刻偏差与「delegation 组内两行
   官方可选工具行」一处有意扩展。
4. **同步修改**：更新 `standardPluginRows()`，同步更新 `STANDARD_ROW_IDS` 与本文档的版本号。
5. **留痕**：在本文件下方追加一行版本记录（见下）。

### 版本记录

| 复刻日期   | 对应 DSH 版本 | standard 行数 | 备注                                                                                                                         |
| ---------- | ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2026-11-20 | 0.2.2-rc.5    | 23            | 首次复刻：全量 23 行 + 末尾看板上下文行 = 24 行                                                                              |
| 2026-11-21 | 0.2.2-rc.5    | 23（不变）    | delegation 组内追加两行官方可选工具行（codex / claude-code，组内 5→7 行）；顶层仍 23+1 = 24 行，见 docs/official-subagent.md |
