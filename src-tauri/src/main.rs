fn main() {
    // 仅在启用 `tauri` feature 时启动 Tauri 应用（默认 features 为空，便于 `cargo test`
    // 链接的二进制不引入 tauri）。构建/运行真实 app 需 `--features tauri`。
    #[cfg(feature = "tauri")]
    app_lib::run();
}
