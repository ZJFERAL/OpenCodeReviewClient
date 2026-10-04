// 集成测试：probe_ocr 的「成功态」与「缺失态」。
// 通过改写当前进程 PATH 指向 fake ocr 目录来 mock，避免触发任何真实 ocr 命令
// （遵守安全纪律：绝不碰用户真实的 OCR 配置）。
//
// 注意：本机 Windows 上 `cmd /c ocr` 依赖 PATH 中的 System32 才能解析 `cmd` 自身，
// 因此 mock 仅把 fake 目录「前置」到 PATH，并保留原 PATH（含 System32）的其余部分，
// 而非整体替换为 mock 目录。

use std::sync::Mutex;

// 串行化所有对全局 PATH 的改写，避免两个测试并发竞争。
static PATH_LOCK: Mutex<()> = Mutex::new(());

// 把 mock_dir 前置到 PATH 最前面（保留原 PATH 其余部分，含 System32）。
fn push_mock_to_path(mock_dir: &std::path::Path) -> std::path::PathBuf {
    let original = std::env::var("PATH").unwrap_or_default();
    let new_path = format!("{};{}", mock_dir.display(), original);
    std::env::set_var("PATH", new_path);
    std::path::PathBuf::from(&original)
}

// 把 PATH 限制为不含 ocr 的目录（仅空 mock 目录），用于缺失态。
fn set_path_to_missing(mock_dir: &std::path::Path) {
    std::env::set_var("PATH", mock_dir.display().to_string());
}

// 还原 PATH（保留 System32 以便命令退出后 shell 仍可解析后续命令）。
fn restore_path(original: &std::path::Path) {
    std::env::set_var("PATH", original.display().to_string());
}

#[test]
fn probe_ok() {
    let _guard = PATH_LOCK.lock().unwrap();

    let mock_dir = std::env::temp_dir().join("ocr_probe_mock_ok");
    std::fs::create_dir_all(&mock_dir).expect("create mock dir");
    // fake ocr：打印含版本号的首行并退出 0。run_ocr 用 `cmd /c ocr`，
    // 因此放到 PATH 的必须是 `ocr.cmd`（批处理）或 `ocr.exe`。
    // 必须 `@echo off`：否则 cmd 会把命令行本身回显为 stdout 首行，
    // 导致 parse_version 取到 `F:\...>echo ...` 而非真正的版本行。
    let script = "@echo off\r\necho open-code-review v9.9.9 (test build)\r\nexit 0\r\n";
    std::fs::write(mock_dir.join("ocr.cmd"), script).expect("write fake ocr.cmd");

    let original = push_mock_to_path(&mock_dir);

    let result = app_lib::ocr::probe_ocr();
    let saved_mock = mock_dir.clone();
    restore_path(&original);
    // 清理 fake 脚本（best-effort）。
    let _ = std::fs::remove_dir_all(&saved_mock);

    let ocr_result = result.expect("probe_ocr 应成功执行 cmd，不返回 Err");
    assert!(ocr_result.ok, "ocr 存在时 ok 应为 true；stdout=\n{}", ocr_result.stdout);
    let data = ocr_result.data.expect("成功态应有 data 字段");
    let version = data
        .get("version")
        .and_then(|v| v.as_str())
        .expect("data.version 应为字符串");
    assert_eq!(
        version, "9.9.9",
        "解析出的版本应为 9.9.9，实际为 {:?}；stdout=\n{}",
        version, ocr_result.stdout
    );
}

#[test]
fn probe_missing() {
    let _guard = PATH_LOCK.lock().unwrap();

    // 空目录：PATH 只指向它，其中不含 ocr，run_ocr 会 9009（命令未找到）。
    let mock_dir = std::env::temp_dir().join("ocr_probe_mock_missing");
    std::fs::create_dir_all(&mock_dir).expect("create mock dir");

    set_path_to_missing(&mock_dir);

    let result = app_lib::ocr::probe_ocr();
    // 还原 PATH 以便后续 shell 命令可用。
    let system32 = r"C:\Windows\System32";
    std::env::set_var("PATH", system32);

    let ocr_result = result.expect("probe_ocr 应执行 cmd 成功返回（哪怕 ocr 未找到）");
    assert!(!ocr_result.ok, "ocr 缺失时 ok 应为 false");
    assert_ne!(
        ocr_result.exit_code, 0,
        "ocr 缺失时 exitCode 不应为 0，实际 {}",
        ocr_result.exit_code
    );
    assert!(
        ocr_result.data.is_none(),
        "缺失态 data 应为 null，实际 {:?}",
        ocr_result.data
    );
}
