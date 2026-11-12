---
'@zhidal/dsh-victauri': patch
---

修复 0.1.0 装上即崩：框架三件套（cordis / dsh-tools / schemastery）从 `dependencies` 改 `peerDependencies`（宿主提供），构建加 `--external` 把它们交回宿主解析。0.1.0 把 `dsh-tools` 精确钉死 `0.2.1-rc.2` 放在 `dependencies`，消费端 pnpm（profile 侧 `nodeLinker: hoisted`）会把它平铺进 profile 根 `node_modules`，顶替宿主 dsh `0.2.2-rc.1` 需要的 `dsh-tools@0.2.2-rc.1`；dsh 兼容性守卫判定不兼容 → 禁用 profile 插件行 "tools" → tools 服务不存在 → 11 个插件等不到 tools → 2 个 required 未激活 → 整个实例启动失败。修复后消费端不再安装任何 `@deepseek-ai/*` 运行时包，运行时统一用宿主版本（无双副本）。
