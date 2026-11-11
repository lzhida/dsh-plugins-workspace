# @zhidal/dsh-victauri

## 0.1.0

### Minor Changes

- 首发：把 Tauri 应用的全栈调试能力整体接入 dsh——注册 39 个 `victauri_*` 工具（standalone 20 + compound 15 + CLI 桥 1 + CLI 探测 1 + 工具发现 1 + 桥接体检 1），覆盖 DOM 快照与元素检索、webview 内 JS 求值与语义断言、IPC 命令调用与注册表检索、只读 SQLite 查询、应用目录读写与内存统计、窗口管理与截图、动画时序 scrub/采样、事件录制与回放、网络拦截路由、控制台/网络/IPC 日志流、后端探针与性能追踪等。

  - 实例发现与自动连接：自动扫描本机 Victauri 实例（`%TEMP%/victauri/<pid>/metadata.json`），按端口与版本挑选最近实例并复用其 token 建立连接；连接断开后由 `ReconnectingVictauriClient` 自动重连，调用方无需感知实例更替。
  - 内嵌 skill `victauri-fullstack-debug`：给出「前端现象 → 定位手段 → 证据链」的全栈调试流程，配套工具面可直接取用。
  - 参数口径三源核对：工具参数 schema 以 Victauri 0.10.3 官方 tools-reference 为基线，与本机 0.8.8 实测、0.10.2 上游源码交叉核对；每个工具的 description 内标注字段来源（`[实测]`/`[文档]`/`[源码]`/`[桥]`），避免凭记忆写参数。
  - 诊断面随包分发：`docs/TOOLS.md`（工具清单与参数口径）、`docs/release.md`（发行与依赖设计）、`docs/upstream-feedback-0.10.3.md` 与 `docs/audit/2026-11-05/`（上游能力审计与差距清单）。
