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
// 返回替换前的原 PATH，供 restore_path 还原（使测试顺序无关）。
fn set_path_to_missing(mock_dir: &std::path::Path) -> std::path::PathBuf {
    let original = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", mock_dir.display().to_string());
    std::path::PathBuf::from(&original)
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
    // 必须 `@echo off`：否则 cmd 在回显命令行之前会先输出一个前导 CRLF，
    // 使 `ocr --version` 的 stdout 首行为空串（不是回显行本身），
    // `parse_version` 取 `lines().next()` 得到空串即返回 None。加 `@echo off` 可消去该前导空行。
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

    let original = set_path_to_missing(&mock_dir);

    let result = app_lib::ocr::probe_ocr();
    // 还原 PATH 为测试前原值（而非硬编码 C:\Windows\System32），使测试顺序无关：
    // 无论本测试先跑还是后跑，都能把 PATH 恢复成进程初始状态。
    restore_path(&original);

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

// B-2：ok=true 但 stdout 无版本号时，data.version 仍应为字符串（空串），绝不序列化为 null。
#[test]
fn probe_ok_without_version() {
    let _guard = PATH_LOCK.lock().unwrap();

    let mock_dir = std::env::temp_dir().join("ocr_probe_mock_noversion");
    std::fs::create_dir_all(&mock_dir).expect("create mock dir");
    // fake ocr：退出 0 但打印不含 vX.Y.Z 的内容。
    let script = "@echo off\r\necho open-code-review (unknown build)\r\nexit 0\r\n";
    std::fs::write(mock_dir.join("ocr.cmd"), script).expect("write fake ocr.cmd");

    let original = push_mock_to_path(&mock_dir);

    let result = app_lib::ocr::probe_ocr();
    let saved_mock = mock_dir.clone();
    restore_path(&original);
    let _ = std::fs::remove_dir_all(&saved_mock);

    let ocr_result = result.expect("probe_ocr 应成功执行 cmd，不返回 Err");
    assert!(ocr_result.ok, "ocr 存在时 ok 应为 true；stdout=\n{}", ocr_result.stdout);
    let data = ocr_result.data.expect("成功态应有 data 字段");
    let version = data
        .get("version")
        .expect("data.version 应存在（不得为 null）");
    assert!(
        version.is_string(),
        "无版本号时 version 仍应为字符串（空串），实际 {:?}",
        version
    );
    assert_eq!(
        version.as_str().unwrap_or("<非字符串>"),
        "",
        "无版本号时应归一为空串，实际 {:?}；stdout=\n{}",
        version, ocr_result.stdout
    );
}

// 审查焦点 #5（Task 9 归属）：`run_ocr` 必须经 `cmd /c ocr <args>` 执行，而非 `Command::new("ocr")`。
// 直接 `Command::new("ocr")` 在本机找不到 `ocr.cmd`（CreateProcess 不解析 .cmd）会 spawn 失败；
// 即便能找到 .exe，也绕过了 shell 对批处理/内建命令的解析。本用例让 fake `ocr.cmd` 回显
// `%CMDCMDLINE%`（由 cmd 展开为完整命令行），从而**显式**断言父进程命令行形如
// `...\cmd.exe /c ocr <args>`——这是「确经 cmd /c 拼装」的直接证据，而非仅靠「能跑通」的间接推断。
#[test]
fn run_ocr_assembles_via_cmd_c() {
    let _guard = PATH_LOCK.lock().unwrap();

    let mock_dir = std::env::temp_dir().join("ocr_probe_mock_cmdc");
    let _ = std::fs::remove_dir_all(&mock_dir);
    std::fs::create_dir_all(&mock_dir).expect("create mock dir");
    // %CMDCMDLINE% = 完整命令行；%* = 参数；%0 = 脚本名（ocr）。
    let script = concat!(
        "@echo off\r\n",
        "echo CMDLINE=%CMDCMDLINE%\r\n",
        "echo ARGS=%*\r\n",
        "exit 0\r\n",
    );
    std::fs::write(mock_dir.join("ocr.cmd"), script).expect("write fake ocr.cmd");

    let original = push_mock_to_path(&mock_dir);

    let result = app_lib::ocr::run_ocr(&["config", "set", "provider", "openai"]);
    let saved_mock = mock_dir.clone();
    restore_path(&original);
    let _ = std::fs::remove_dir_all(&saved_mock);

    let r = result.expect("应经 cmd 成功执行；若实现改成 Command::new(\"ocr\") 会因找不到 .cmd 而返回 Err");
    assert!(r.ok, "mock 退出 0 时 ok 应为 true；stdout=\n{}", r.stdout);
    // 直接证据：父进程命令行含 cmd 解释器与 /c 开关，且 ocr 是其执行的命令。
    let lower = r.stdout.to_lowercase();
    assert!(
        lower.contains("cmd") && lower.contains("/c") && lower.contains("ocr"),
        "run_ocr 必须经 `cmd /c ocr` 执行（CMDCMDLINE 应含 cmd 与 /c），实际 stdout=\n{}",
        r.stdout
    );
    // 参数应原样拼在 ocr 之后，顺序不变。
    assert!(
        r.stdout.contains("ARGS=config set provider openai"),
        "参数应原样传给 ocr，实际 stdout=\n{}",
        r.stdout
    );
}
