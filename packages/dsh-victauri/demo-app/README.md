# demo-app — dsh-victauri e2e demo Tauri 应用

最小 vanilla Tauri 2 应用，用于 dsh-victauri 插件的端到端活体验证。**不进 CI**（仅本地验证）。

## 接入要点（官方 [getting-started](https://4da-systems.github.io/Victauri/getting-started.html) 0.10 optional 模式）

- `victauri-plugin` / `victauri-core` 以 **optional 依赖**挂在 `victauri` Cargo feature 后（`src-tauri/Cargo.toml`）；不带 feature 的构建零 victauri 代码。
- `victauri:default` capability **运行时授权**（`main.rs` 的 `with_victauri` + `add_capability`），不落 `capabilities/*.json`——capability 文件会让 feature-off 构建因权限指向未编译插件而失败。
- 示例命令 `greet` 带 `#[inspectable]`（`cfg_attr` 形式）+ `register_commands!` 注册 schema，供 `victauri_get_registry` / `victauri_detect_ghost_commands` / `victauri_invoke_command` 验证。
- 前端 `dist/index.html`（纯静态，无构建步骤）含可交互元素（输入框 / Greet 按钮 / 计数器），供 `dom_snapshot` / `interact` / `eval_js` 验证。

## 启动 / 停止

```sh
cd demo-app/src-tauri

# 起（debug 构建 + victauri feature；release 构建的 victauri 是 no-op，必须 --features）
cargo run --features victauri

# 停：Ctrl+C 或直接关窗口
```

首次运行会拉取 tauri 2 + victauri-plugin 0.10 依赖并编译（数分钟）。app 启动后 victauri 服务监听 `127.0.0.1:7373`（端口被占时顺延到**下一个空闲端口**，实测占用 7373 后绑定 7374），discovery 写入 `%TEMP%\victauri\<pid>\{metadata.json, port, token}`。

## 一键冒烟（`pnpm smoke`）

在**仓库根目录**执行：

```sh
pnpm smoke
```

脚本会自己完成全流程，**无需手工起 app**：构建（`cargo build --features victauri`）→ 启动 demo-app →
轮询 discovery 就绪 → 经 REST 主通道跑 9 项检查 → 打印 PASS/FAIL 摘要 → 结束进程树。

- 覆盖检查：`/health`、`/info`、`/api/tools`（服务端 35 个工具清单——dsh 桥接后为
  **39 个 dsh 工具** = 35 上游 1:1 + 4 插件自有：CLI 桥 / CLI 探测 / 工具发现 / 桥接体检）、
  `get_plugin_info`、`app_info`、
  `eval_js`（`1+1 = 2`）、`dom_snapshot`（断言含 Greet 按钮）、`invoke_command`（`greet`）、
  无 token 访问 `/api/tools` → 401。
- 端口不硬编码：从 discovery 的 `port` 文件读实际端口（顺延场景自动跟随）。
- 退出码：`0` 全过 / `1` 有检查失败 / `2` 前置或环境不满足（如 discovery 超时）。
- 环境变量：`SMOKE_SKIP_BUILD=1`、`SMOKE_BUILD_TIMEOUT_MS`、`SMOKE_DISCOVERY_TIMEOUT_MS`、
  `SMOKE_REQUEST_TIMEOUT_MS`、`SMOKE_SELFTEST=1`（追加一项故意失败检查）。
- **不进 CI**：需要 Rust 工具链、会真的拉起 Tauri 窗口、依赖本机 `%TEMP%\victauri` discovery 目录。
- Windows 注意：运行中的 `dsh-victauri-demo.exe` 无法被 cargo 覆盖，先关掉旧实例
  （`taskkill /PID <pid> /T /F`）再跑，否则构建阶段会报「拒绝访问 (os error 5)」。

## e2e 用法（dsh 侧）

app 运行中时，dsh 会话里的 `victauri_*` 工具自动发现并连接该实例：

1. `victauri_app_info` / `victauri_get_plugin_info` — 连接与版本确认（identifier `com.lzhida.dsh-victauri-demo`）；
2. `victauri_dom_snapshot` / `victauri_interact` / `victauri_eval_js` — 前端交互元素操作；
3. `victauri_invoke_command(greet)` / `victauri_get_registry` / `victauri_detect_ghost_commands` — inspectable 命令注册与调用；
4. `victauri_screenshot` — 截图落盘。

多 app 并存时用插件配置 `appIdentifier: 'com.lzhida.dsh-victauri-demo'` 收敛目标。

## 编译检查（不启动 app）

```sh
cd demo-app/src-tauri
cargo check --features victauri   # victauri feature 构建检查
cargo check                       # feature-off 构建检查（发布形态）
```

## 构建产物

`src-tauri/target/`（Rust cargo 构建产物）由本目录的 `.gitignore` 排除，不提交；`dist/` 是**源码**（纯静态前端，`tauri.conf.json` 的 `frontendDist` 指向它），以强制入库方式跟踪。仓库根 `.gitignore` 的 `dist/` 通配只作用于未跟踪文件。
