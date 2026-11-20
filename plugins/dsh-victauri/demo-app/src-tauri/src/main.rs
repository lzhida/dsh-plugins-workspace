// dsh-victauri e2e demo：最小 vanilla Tauri 2 应用。
//
// victauri 按 optional feature 接入（官方 `victauri init --optional` 同款模式）：
// - `cargo run --features victauri`：debug 构建，victauri MCP/REST 服务随 app 启动；
// - 不带 feature 的构建：零 victauri 代码（release 亦然）。
//
// capability（victauri:default）走【运行时授权】而非 capabilities/*.json 文件——
// capability 文件会在不带 feature 的构建里因权限指向未编译插件而被 Tauri 拒绝。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    with_victauri(tauri::Builder::default())
        .invoke_handler(tauri::generate_handler![greet])
        .setup(|_app| {
            // 注册 #[inspectable] 命令的 schema（仅 victauri feature 构建存在）。
            #[cfg(feature = "victauri")]
            victauri_plugin::register_commands!(_app, greet__schema());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 示例 #[inspectable] 命令：供 victauri get_registry / detect_ghost_commands
/// 与 dsh 的 victauri_invoke_command 工具做 e2e 验证。
/// cfg_attr 写法保证不带 feature 的构建不需要 victauri-plugin 存在。
#[cfg_attr(
    feature = "victauri",
    victauri_plugin::inspectable(description = "Greet a user by name", intent = "greeting")
)]
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {name}! (from dsh-victauri demo)")
}

#[cfg(feature = "victauri")]
fn with_victauri<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(victauri_plugin::init())
        .plugin(
            // 运行时授权 victauri:default（Tauri 默认 dynamic-acl）：
            // 不落 capabilities 文件，feature-off 构建不受影响。
            tauri::plugin::Builder::<R>::new("victauri-capability").setup(|app, _api| {
                tauri::Manager::add_capability(
                    app,
                    tauri::ipc::CapabilityBuilder::new("victauri")
                        .window("*")
                        .permission("victauri:default"),
                )?;
                Ok(())
            })
            .build(),
        )
}

#[cfg(not(feature = "victauri"))]
fn with_victauri<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
}
