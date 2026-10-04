// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
pub mod ocr;

// 仅在启用 `tauri` feature 时编译 app 运行时入口（注册 Tauri command handlers）。
// 集成测试默认不带该 feature，从而 lib/集成测试/二进制都不链接 tauri，避免本机
// MinGW 旧 binutils 在 dev/test profile 下报 STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)。
#[cfg(feature = "tauri")]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Rules Tab 的原生对话框插件（选仓库目录/选文件）。与 tauri 同属 default feature，
    // 用独立 cfg 门控，以便只开 `tauri`（不带 dialog）时仍可构建。
    #[cfg(feature = "tauri-plugin-dialog")]
    let builder = builder.plugin(tauri_plugin_dialog::init());
    builder
        .invoke_handler(tauri::generate_handler![
            commands::run_ocr,
            commands::probe_ocr,
            commands::get_config,
            commands::set_provider,
            commands::set_provider_key,
            commands::set_custom_provider,
            commands::set_model,
            commands::test_connection,
            commands::list_providers,
            commands::get_rules,
            commands::set_rules,
            commands::check_rules
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
