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
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::run_ocr,
            commands::probe_ocr,
            commands::get_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
