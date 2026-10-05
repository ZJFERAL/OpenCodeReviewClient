// 发布版不附带控制台黑窗：把子系统设为 windows(GUI)。
// 必须放在**二进制 crate 根**（main.rs）——crate 级属性不跨 crate 传播，
// 放在 lib.rs（staticlib/rlib，从不产出 exe）对最终 PE 无效（实测 subsystem 仍为 CUI）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 仅在启用 `tauri` feature 时启动 Tauri 应用（默认 features 为空，便于 `cargo test`
    // 链接的二进制不引入 tauri）。构建/运行真实 app 需 `--features tauri`。
    #[cfg(feature = "tauri")]
    app_lib::run();
}
