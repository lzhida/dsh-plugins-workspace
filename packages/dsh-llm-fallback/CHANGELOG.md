# @zhidal/dsh-llm-fallback

## 0.6.0

### Minor Changes

- c114d2a: 配置卡客户端半区重构为 TSX 组件化源码（`client/src/`：组件/hooks/纯函数分层，草稿状态收敛为单一对象），经 `scripts/build-client.ts`（esbuild）打包为惰性 CJS 注册壳 `client/index.js` 随包提交；react 改为 devDependency（运行时仍经宿主模块表注入，产物保持 external），功能、文案、样式与宿主加载契约零变化。测试从 vm 沙箱 + 源码文本 grep 迁移为纯函数直接 import + 契约断言 + jsdom 真实渲染冒烟（`FallbackCard.test.tsx`），并新增产物加载级 sanity 与 `PKG_NAME`/`ENTRY_NS` 同步防回归断言。
- 5ae959c: 识别网关 408 请求超时：`isFailureRetryable` 新增结构化 `status` 判定——`failure.status === 408` 直接视为可重试/可切换（只读结构化字段，绝不解析 message），兜住 deepseek 路由下网关透传 `invalid_request_error` type 导致 `code=INVALID_REQUEST`（白名单外）的 408 形态；`DEFAULT_RETRYABLE_CODES` 增补 `HTTP_408`（deepseek 路由 408 且响应体无已知 type 的兜底码）。

  - 判定先于白名单：存量自定义白名单（未列 `HTTP_408`）零迁移即获得 408 切换行为；无 `status` 的失败（含 pi-ai 路由退化为纯 code 的 408）行为完全不变，默认零回归
  - 数据面差异如实写入 README：`LlmFailure.status` 仅由 deepseek 路由填充，pi-ai 路由纯文本分类不透传 status——该路由的网关 408 仍为白名单外 `INVALID_REQUEST`，插件侧无解（宿主上游缺口），README 故障排查给出「重试 5/5 后失败」分叉解释与 `INVALID_REQUEST` 白名单逃生的风险说明

- 7e0b3cb: 适配 dsh 宿主 0.2.2-rc.1：切换机制从 waterfall 改写迁移到官方 `agent.model.select()` 持久化

  **背景**：宿主 0.2.2-rc.1 封死了 `agent/request` waterfall 改写通道（`prepareRequest` 校验输出必须等于 step 选定 selection，改写即抛 `use agent.model.select() before step preparation`），旧版插件在新宿主上加载即炸（改写抛错）或行为未定义。同时宿主启动日志报 `patch: entry "dsh-llm-fallback" not found`（profile 补丁层平级条目在 bundles 清单缺包时被丢弃）。

  **运行时层改造**：

  - `agent/request` 监听器改为**只读**：原样返回 seed（绝不改写 provider/model）；保留会话模型捕获（`payload.agent.model.current()`）与时间窗预填
  - 预算耗尽切换改为 `payload.agent.model.select({provider, model, reasoningEffort?})` 持久化：写入 durable model/selection 事件 + 自动插 `[model changed]` user message；`reasoningEffort` 从切换前 selection 继承；select 失败不阻断回退本体（仅降级为不持久化）
  - **切换时序变化**：selection 在 step 准备时快照，`select` 在下一 step 生效——切换当 step 会用旧模型重发一次请求（白名单内失败），该次失败后本 step 透传、turn 报错结束，重发消息即从新候选继续（旧版「同 step 无感续发」依赖已封死的改写通道）
  - 冷却起点跳过（0.5.x 在请求起点直接改写模型）移除；冷却仅影响失败推进的候选选择顺序
  - 新增 `engines: { dsh: ">=0.2.2-rc.1" }`，旧宿主由兼容性校验自动拦截
  - devDeps 类型源升级至 0.2.2-rc.1（`@deepseek-ai/dsh-agent` / `dsh-llm` / `dsh-system-prompt`）；`cordis.d.ts` 类型增强删除（官方 dsh-agent 自带 Context.Events 增强，重复声明冲突）

  **升级注意**：要求 dsh 宿主 0.2.2-rc.1+。若 profile bundles 清单缺包（启动日志报 `patch: entry "dsh-llm-fallback" not found`），需重新 `dsh plugin add @zhidal/dsh-llm-fallback@0.6.0` 让宿主把包写回 bundles 清单。

- 885c94f: perTurn 字段正式实装（单次切换档）并收口 step 回退状态表的无界增长：`perTurn: false` 时同一 `turn:step` 至多切换一次候选——切换生效处消耗 one-shot 名额，同 step 后续预算耗尽不再切换、透传上游决策（官方 retry 透传与预算内代执行重试不消耗名额），新 step / 新 turn 天然重置，agent/request 的冷却起点改写不算切换；每 step 回退状态（`turn:step` 键）在新 turn 首次请求时清理其他 turn 的旧状态，内存上界从严格无界收敛为单 turn 的 step 数，冷却表独立于清理、跨 step 语义不变。
- cb8f4c7: 配置卡样式层改造为 shadcn/ui 体系（Tailwind CSS v4 + Radix 原语 + CVA）：新增 `components/ui/` 组件层（Button/Switch/Badge/Input/Checkbox/ScrollArea，交互态 hover/focus/disabled/过渡齐备），删除 `styles.ts` 内联样式对象。主题经 `@theme inline` 全量映射宿主 `--dsw-alias-*` token（明暗双模式跟随，无 `.dark` class 策略）。构建管线新增 Tailwind 编译（`@tailwindcss/cli`，granular import 禁用 preflight 防宿主 DOM 污染，`source(none)` 锁定扫描范围），产物以内联 CSS 字符串 + 运行时幂等注入 `<style data-plugin>` 交付（宿主 claimStyles/removeOwnedStyles 托管清理）；`react-dom` 加入 external 由宿主 seed 解析，构建断言防第二份 React 回归。功能、配置 schema、slots/locale 契约零变化，bundle 体积 35KB → 94KB（Radix 原语，设置卡场景可接受）。
- 24347d6: 回退队列跟随模型重命名并剔除失效候选：队列显示名实时从宿主模型目录解析（dsh 侧重命名模型后配置卡无需重新保存即跟随，displayName 快照依赖去除，目录缺失回退 provider/model 路由键）；不在当前目录中的队列条目渲染「已失效」徽标并提供一键清理，任何保存动作的写入载荷自动剔除失效条目（目录加载失败或 provider 目录查询失败时不误标、不剔除，绝不做服务端静默剔除）；默认失败码白名单新增 UNKNOWN_MODEL（pi-ai 对配置中不存在模型的构建期确定性失败码），失效候选首失败即按预算切换下一候选并复用 llm/retry 轨迹，整链不再在失效候选上中断。
- 6e70dcc: 新增「时间窗切换 / 错峰优先」策略（时段计划 v2，默认关闭零迁移）：配置的窗口内按规则把候选经既有 `markCooldown` 通道预填进失败冷却表（到期 = 窗口结束），此后与失败冷却共用同一条跳过/改写路径——高峰期把命中候选自动切走（改写切换，对话不中断），错峰窗口（官方半价 00:30–08:30）反向优先 DeepSeek；窗口结束由既有惰性过期自动恢复优先级，不引入定时器。

  - 规则形态（全局窗口 + provider 匹配规则）：`match`（精确 id / 前缀通配 `deepseek-*` / `*`）+ `action`（`block` = 窗口内冷却命中 provider；`prefer` = 冷却未命中 provider）+ `windows`（`HH:mm` 半开区间，起点>终点 = 跨夜，相等 = 全天，宿主机本地时区判定）
  - 官方错峰预置模板（D3）：高峰 08:30–00:30 避让 `deepseek-*` + 错峰 00:30–08:30 优先 `deepseek-*`，配置卡开启开关时自动填入
  - 配置卡新增时间窗区块（复用冷却区块结构）：开关 + 规则编辑（provider 匹配 + 窗口，中英双语），保存载荷扩至 8 个 set op，revision 冲突检测同链路；非法规则阻止保存
  - 全候选被预填冷却时降级回原顺序放行（时间窗绝不吞掉全部候选）；`cooldownEnabled: false` 时时间窗整体不生效

- 9fab897: 配额感知自适应冷却（新配置 `quotaCooldownEnabled` / `quotaCooldownMs` / `cooldownCapMs`）：订阅制提供商（GLM Coding Plan / MiniMax Token Plan 等）的用量窗口耗尽失败（GLM 1308/1310、MiniMax 2056 等业务码或 usage limit / 用量上限措辞）记冷却时自动延长时长——报错携带重置时间（GLM「将在 … 重置」、MiniMax「resets at …Z」）直接采用，无重置时间用配额档（默认 5 小时，对齐用量窗口周期），全部结果受 7 天硬上限封顶；普通失败（瞬时限流 / 服务器错误）维持 `cooldownMs` 固定档（默认 5 分钟），行为与旧版完全一致。路由判定不读 message 的约定不变，解析只影响冷却时长、失败时优雅降级。切换轨迹事件追加 `cooldownUntilMs` / `cooldownSource` 字段（读侧透传安全），延长发生时打 `[dsh-llm-fallback] quota-aware cooldown` 日志。

### Patch Changes

- d3b8b99: README 故障排查新增「升级插件 / 修改冷却配置后行为不变（如冷却未生效）」条目：宿主进程启动时加载插件代码与配置，升级或修改冷却配置须重启宿主（或 profile 实例）才生效，并给出运行版本判别方法——`llm/retry` 切换事件（`policyKey: "llm-fallback"`）照常出现而已失败模型不被跳过，说明运行版本不含冷却逻辑而非冷却实现缺陷。源自 2026-10-27 冷却未生效排障：宿主 10:32 启动加载无冷却的 0.4.0，17:30 升级 0.5.0 未被运行中进程感知，当晚冷却全程未生效。
- c33181b: README 补充「配置存储与持久化」说明（纯文档，零行为变更）：

  - **落点**：设置卡 / 设置面板保存的字段由宿主写进当前 profile 的补丁层 `~/.dsh/profiles/<profile>/cordis.patch.yml` 的插件条目 `config`——per-profile 隔离（多 profile 互不影响）、重启保留
  - **补丁层双角色**：同一个 `cordis.patch.yml` 既承载第三方插件条目注册（bundle 之外必经，须用 `- insert:` 块、不能平级 `- id:` 覆盖），也承载全部插件的 volatile 配置持久化（官方插件同落此层，以 `dsh-client-locale` 的语言偏好为例）；手改补丁层文件仅适用预置配置，日常一律走设置面板
  - **`~/.dsh` 两类文件区分**：宿主托管配置（`profiles/<profile>/cordis.patch.yml`）vs 插件自有数据（`dsh-taskboard.json` 等 JSON、`storages/` 存储），并写明本插件不引入自有配置 / 数据文件的取舍（单一真相源、profile 隔离；运行状态持久化指向 roadmap 第三档）
  - **故障排查新增一条**：profile 补丁层残留的 0.2.x 旧字段 `fallbackWhen` 无害——插件不识别、不迁移，也不影响行为，与「零成本升级」既有承诺一致

  措辞按实测宿主 0.2.1-rc.2 的行为核对，不含未验证承诺；文档中不含任何真实密钥。

- 6103f19: step 回退状态键并入会话标识（会话隔离）：键位从 `turn:step` 升级为 `<会话id>:<turn>:<step>`（会话标识取自 `agent/request(-error)` payload 的 `agent.session.id`，缺失时降级为无会话段的 `turn:step` 共享键位，与旧行为兼容）——多会话并发时同号 turn 的回退状态不再互相串扰，新 turn 建态清理只作用于同会话的旧 turn，不再误清其他会话的在途状态（原表现为该 step 回退状态重置、从会话模型重来）；代价是每会话在其最末 turn 后遗留少量状态（上界 ≈ 会话数 × 单 turn step 数，宿主重启即清零）。冷却表不受影响（provider/model 键，跨会话共享属既定语义）。另将 client 冒烟测试的渲染等待预算从 100×10ms（≈1s）放宽至 300×20ms（≈6s）并细化探测条件（断言前先等目录名解析），消除全量并发跑时的预存 flaky。

## 0.5.0

### Minor Changes

- 5740972: 新增失败候选冷却跳过（cooldown），平衡回退优先级与切换效率：

  - 白名单失败耗尽每候选重试预算并切换（或链耗尽）后，刚失败的模型（会话指定主模型或链候选）进入冷却窗口（新配置 `cooldownMs`，默认 `300000` ms = 5 分钟）：窗口内后续 step 不再从它开始，`agent/request` 直接把起点改写为链上第一个可用候选——"从下一个回退模型或此前验证可用的候选开始"，避免每个 step 都重复支付同一故障模型的失败成本、把对话时间拉长；
  - 窗口期满该模型自动恢复优先级，下次请求按正常顺序重新验证是否恢复（恢复则继续优先使用，未恢复则再次冷却）；
  - 冷却只是效率优化，绝不让链失去全部候选：step 起点与切换推进遇到"剩余候选全部在冷却中"时，自动退回正常顺序语义；
  - 非白名单失败、预算内的同候选重试（透传官方 / 代执行）不记冷却；新配置 `cooldownEnabled: false` 可整体关闭（行为与旧版完全一致）；冷却表存于插件进程内存（按 `provider/model` 记、跨对话共享），宿主重启后清零。

- af8cf8f: 回退时机配置 `fallbackWhen`(afterRetry/immediately 两档)移除,改为数值化的每候选重试次数 `retriesBeforeSwitch`:

  - `N > 0` = **以插件配置为准**:当前候选重试 N 次后才切下一候选,不被 provider 重试策略封顶——预算内由官方 `dsh-llm-retry` 执行重试(透传其决策),超出的部分由本插件代执行(指数退避 + 官方 `llm/retry` / `llm/retry-started` 轨迹事件,retry 记候选内序号),直到 N 用满;N 小于预算时会在官方仍在预算内时提前覆盖切换;
  - `0`(默认)= 自动跟随 provider 重试策略的 `maxRetries`(宿主默认 5):预算内透传官方 retry 决策,预算耗尽后切换——与旧 `afterRetry` 等价;provider 未注册策略时视为 0(首失败即切)。provider 的 `retryPolicy` 本身可编辑(`llm-deepseek` 顶层 volatile 字段 / `llm-pi-ai` 的 `providers.<id>.retryPolicy`,保存即热生效),自动档实时跟随;
  - 同一 step 内计数按候选独立,切换后清零,每个候选(含会话指定模型)获得完整预算;
  - `always` 模式策略:自动档整体透传官方无限重试,自定义档按 N 覆盖切换;
  - 设置卡「回退时机」下拉替换为「每候选重试次数」数字输入(中英双语);`maxRetries` 字段保留(只限切换候选次数),描述改为与 `retriesBeforeSwitch` 明确互斥;旧配置中的 `fallbackWhen` 键被忽略,无需迁移。

### Patch Changes

- b823795: npm 包元数据修正:显式声明 `homepage` 指向插件子目录(`…/tree/main/packages/dsh-llm-fallback#readme`)。此前包缺 `homepage` 字段,npm 发布时自动回退生成 monorepo 根目录的 `#readme` 链接,官网「Homepage」跳不到插件目录;`repository.directory` 早已正确,保持不变。新增 `src/manifest.test.ts` 防回归:断言 homepage 指向子目录、repository 带 directory、两者路径同源一致。
- 76eb0e1: 默认白名单新增失败码 `UNSUPPORTED_REASONING_EFFORT`:deepseek/pi-ai 适配器在请求构建期发现模型不支持所请求的 reasoning effort 时抛出该码(消息形如 `provider "X" model "Y" does not support reasoning effort "Z"`),此前不在白名单导致不触发回退、对话以该错误中断。该失败对同一模型是确定性的(同 provider 重试必复现),现命中后按回退时机切下一候选;system-prompt 协议文本与 README 失败码表同步更新。

## 0.4.0

### Minor Changes

- 2f3e36e: 设置表单国际化（i18n）：配置卡文案与 Config schema 字段描述跟随 dsh 语言设置（设置 → 通用 → 语言）即时切换，无需重载插件。client 侧中英字典经 `ctx.locale` 注册 `llm-fallback` 命名空间，并订阅 locale 快照（LocaleFace 契约）在语言切换时立即重渲染，locale 服务缺失时回退英文字典、配置卡降级可用；服务端全部字段（含 `fallbackChains` 链项子字段）的 `meta.description` 改为 schemastery i18n 映射 `{ '': 英文默认, zh, en }`，随宿主 `settings.describe()` 原样下发、由前端按当前语言解析，`''` 键保证旧渲染端零回归。新增 `desc()` / `SchemaDescription` 导出与 15 项契约测试（字典键集一致、语言跟随、缺失回退、映射完整性、JSON 序列化）。

  轨迹增强：`llm/retry` 事件 payload 新增 `targetProvider` / `targetModel` 追加字段——「切换到哪个模型继续跑」在会话轨迹数据里直接可查（官方 payload 无此字段；format v4 读侧只校验已知字段的关系约束、data 整体透传，追加安全。当前宿主轨迹 UI 尚不渲染这两个字段，与宿主 loop 自动记录的 `request/header` / `request/context` 数据层互补）。

- 02c0bf5: 轨迹透明化：跨 provider 回退不再是黑盒。切换候选时通过官方轨迹接口（`agent/request-error` payload 携带的 `agent.session.append`，与宿主 `dsh-llm-retry` 同一通道）向会话日志写入官方 `llm/retry` / `llm/retry-started` 事件（`policyKey` 固定 `llm-fallback`），宿主轨迹 UI 内置渲染为请求节点的重试状态（失败消息、错误码、重试进度与退避时长）；切换目标 provider/model 由宿主 loop 的 `request/header` change 自动记录。附带修复：`baseDelayMs` / `maxDelayMs` 显式 `0` 现按文档语义生效（禁用退避），此前被误判非法回落 500/30000；退避等待现在可被 turn 取消立即中断，不再拖住已取消的 waterfall。
