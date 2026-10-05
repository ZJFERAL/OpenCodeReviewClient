fn main() {
    // 仅在启用 `tauri` feature 时运行 tauri 的 build 脚本（生成上下文、dev 指令等）。
    // `cargo test` 默认不带该 feature，跳过可避免 tauri-build 在缺少 tauri 版本信息时
    // panic（"missing `cargo:dev` instruction"）。构建/运行真实 app 需 `--features tauri`。
    if std::env::var_os("CARGO_FEATURE_TAURI").is_some() {
        tauri_build::build()
    }
}
