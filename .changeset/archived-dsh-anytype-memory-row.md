---
'@zhidal/dsh-anytype': patch
---

**下架 dsh-anytype-memory 插件行（代码保留归档）**：anytype 退出记忆方向（2026-10-30，用户决策），agent 持久记忆由既有系统（hindsight/mnemon）承担。包内 `cordis.patch.yml` 的 `insert` 列表移除 memory 行，随包注册的工具从 46 降为 30（仅主行 `dsh-anytype`）；system prompt 不再注入 memory 指引 section（原 order 2970）。`src/memory/**`、`src/entries/memory.ts`、相关测试、`docs/memory/` 与 exports `./memory` 全量保留；恢复方式：在包内 `cordis.patch.yml` 的 `insert` 列表追加回 memory 行（`- id: dsh-anytype-memory` + `name: './src/entries/memory.ts'`）即可，profile 侧残留的 `- id: dsh-anytype-memory` config 覆盖条目在恢复前是 no-op。README 与 docs/bundle-architecture.md 已标注归档状态。
