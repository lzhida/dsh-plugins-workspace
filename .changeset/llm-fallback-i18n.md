---
'@zhidal/dsh-llm-fallback': minor
---

设置表单国际化（i18n）：配置卡文案与 Config schema 字段描述跟随 dsh 语言设置（设置 → 通用 → 语言）即时切换，无需重载插件。client 侧中英字典经 `ctx.locale` 注册 `llm-fallback` 命名空间，并订阅 locale 快照（LocaleFace 契约）在语言切换时立即重渲染，locale 服务缺失时回退英文字典、配置卡降级可用；服务端全部字段（含 `fallbackChains` 链项子字段）的 `meta.description` 改为 schemastery i18n 映射 `{ '': 英文默认, zh, en }`，随宿主 `settings.describe()` 原样下发、由前端按当前语言解析，`''` 键保证旧渲染端零回归。新增 `desc()` / `SchemaDescription` 导出与 15 项契约测试（字典键集一致、语言跟随、缺失回退、映射完整性、JSON 序列化）。

轨迹增强：`llm/retry` 事件 payload 新增 `targetProvider` / `targetModel` 追加字段——「切换到哪个模型继续跑」在会话轨迹数据里直接可查（官方 payload 无此字段；format v4 读侧只校验已知字段的关系约束、data 整体透传，追加安全。当前宿主轨迹 UI 尚不渲染这两个字段，与宿主 loop 自动记录的 `request/header` / `request/context` 数据层互补）。
