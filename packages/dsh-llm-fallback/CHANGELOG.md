# @zhidal/dsh-llm-fallback

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
