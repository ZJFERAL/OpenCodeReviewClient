// 集成测试：Params Tab 的 `set_param` 只接受可持久化键（spec §8.2）。
//
// mock 方式与 provider_save_test 一致：把 fake `ocr.cmd` 前置到 PATH，让 `run_ocr`（直接 spawn
// `ocr.cmd`）命中它，并把收到的 args 回显到 stdout（`ARGS:%*`），从而断言「拼装到 spawn 的键路径正确」。
// 安全纪律：全程只碰临时 mock 目录，绝不执行/写入用户真实的 `~/.opencodereview/`。
//
// 实测结论（隔离 HOME 跑 ocr v1.12.11，spec §8.2）：
//   `config set max_tokens 200000` → 落盘顶层 `max_tokens: 200000`，exit 0；
//   `config set effort high`       → 落盘顶层 `effort: "high"`，exit 0；
//   `config set timeout 15`        → `Error: unknown config key: timeout`，exit 1。
// 故本命令把白名单硬编码为 `max_tokens` / `effort`，其余一律在 spawn 前拒绝。

use std::sync::Mutex;

// 串行化所有对全局 PATH 的改写，避免并发测试互相污染。
static ENV_LOCK: Mutex<()> = Mutex::new(());

// 写 fake `ocr.cmd`：把收到的 args 回显为 `ARGS:<...>`；FAKE_OCR_EXIT 可指定退出码。
fn write_fake_ocr(mock_dir: &std::path::Path) {
    let script = concat!(
        "@echo off\r\n",
        "echo ARGS:%*\r\n",
        "if \"%FAKE_OCR_EXIT%\"==\"\" (exit 0) else (exit %FAKE_OCR_EXIT%)\r\n",
    );
    std::fs::write(mock_dir.join("ocr.cmd"), script).expect("write fake ocr.cmd");
}

// 建带进程 id 的唯一 mock 目录，加载 fake 脚本并前置到 PATH。返回 (dir, original_path)。
fn setup_mock(name: &str) -> (std::path::PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("ocr_params_{}_{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create mock dir");
    write_fake_ocr(&dir);
    let original = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{};{}", dir.display(), original));
    (dir, original)
}

fn teardown(dir: &std::path::Path, original: &str) {
    std::env::set_var("PATH", original);
    let _ = std::fs::remove_dir_all(dir);
}

// max_tokens 是白名单键：应拼成 `config set max_tokens 200000` 并成功。
#[test]
fn set_param_max_tokens_builds_config_set() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("max_tokens");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_param("max_tokens", "200000");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(r.ok, "mock 退出 0 时 ok 应为 true；stderr={}", r.stderr);
    assert!(
        r.stdout.contains("config set max_tokens 200000"),
        "应拼出 `config set max_tokens 200000`，实际 stdout=\n{}",
        r.stdout
    );
}

// effort 是白名单键：应拼成 `config set effort <level>`。
#[test]
fn set_param_effort_builds_config_set() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("effort");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_param("effort", "high");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(r.ok, "ok 应为 true；stderr={}", r.stderr);
    assert!(
        r.stdout.contains("config set effort high"),
        "应拼出 `config set effort high`，实际 stdout=\n{}",
        r.stdout
    );
}

// 白名单外的键（timeout/concurrency/format/exclude 均为 `ocr review` 运行时 flag，不可持久化）
// 必须被拒绝：ok=false 且 stderr 含 `unsupported key`，且不得 spawn ocr
//（绝不把非法键下发给真实 CLI，spec §4.2 / §8.2）。
#[test]
fn set_param_rejects_non_persistable_key() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("unsupported");
    std::env::remove_var("FAKE_OCR_EXIT");

    for (key, value) in [
        ("timeout", "15"),
        ("concurrency", "8"),
        ("format", "text"),
        ("exclude", "**/generated/*"),
    ] {
        let result = app_lib::ocr::set_param(key, value);
        let r = result.expect("拒绝也应返回 Ok（不报错）");
        assert!(!r.ok, "键 `{key}` 不可持久化，ok 应为 false");
        assert!(
            r.stderr.contains("unsupported key"),
            "键 `{key}` 的 stderr 应含 `unsupported key`，实际:\n{}",
            r.stderr
        );
        assert!(
            !r.stdout.contains("ARGS:"),
            "键 `{key}` 被拒绝时不得 spawn ocr，实际 stdout=\n{}",
            r.stdout
        );
    }
    teardown(&dir, &original);
}

// effort 非法取值（非 low/medium/high）应被拒绝，且不下发 ocr。
#[test]
fn set_param_rejects_invalid_effort_value() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("bad_effort");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_param("effort", "ultra");
    teardown(&dir, &original);

    let r = result.expect("拒绝也应返回 Ok");
    assert!(!r.ok, "非法 effort 取值 ok 应为 false");
    assert!(
        r.stderr.contains("unsupported value"),
        "stderr 应含 `unsupported value`，实际:\n{}",
        r.stderr
    );
    assert!(
        !r.stdout.contains("ARGS:"),
        "非法取值不得 spawn ocr，实际 stdout=\n{}",
        r.stdout
    );
}

// 空值 = 「不写入」，跳过、不 spawn ocr（与 set_model / set_provider_key 的空串语义一致）。
#[test]
fn set_param_empty_value_skips() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("empty");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_param("max_tokens", "");
    teardown(&dir, &original);

    let r = result.expect("跳过也应返回 Ok");
    assert!(r.ok, "跳过应视为成功");
    assert!(
        !r.stdout.contains("ARGS:"),
        "空值不应 spawn ocr，实际 stdout=\n{}",
        r.stdout
    );
    assert_eq!(
        r.data.as_ref().and_then(|d| d.get("skipped")).and_then(|v| v.as_bool()),
        Some(true),
        "跳过时 data.skipped 应为 true，实际 {:?}",
        r.data
    );
}

// I1（静默假成功）：`max_tokens` 值形如 flag（`--help` / `-h`）时，真实 CLI 会打印帮助并
// **exit 0** 但 config.json 一字未写。若只判空就会返回 ok=true（假成功）。
// 修复后必须在 spawn 前拒绝：ok=false 且不 spawn ocr。
#[test]
fn set_param_rejects_flag_like_max_tokens() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("mt_flag");
    std::env::remove_var("FAKE_OCR_EXIT");

    for bad in ["--help", "-h", "abc", "0", "-1", "1.5", "1e6"] {
        let result = app_lib::ocr::set_param("max_tokens", bad);
        let r = result.expect("拒绝也应返回 Ok");
        assert!(!r.ok, "max_tokens=`{bad}` 应被拒绝（非正整数）");
        assert!(
            r.stderr.contains("unsupported value"),
            "max_tokens=`{bad}` 的 stderr 应含 `unsupported value`，实际:\n{}",
            r.stderr
        );
        assert!(
            !r.stdout.contains("ARGS:"),
            "max_tokens=`{bad}` 被拒绝时不得 spawn ocr，实际 stdout=\n{}",
            r.stdout
        );
    }
    teardown(&dir, &original);
}

// I1：合法正整数仍应正常下发。
#[test]
fn set_param_accepts_positive_integer_max_tokens() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("mt_ok");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_param("max_tokens", "8192");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(r.ok, "正整数应放行；stderr={}", r.stderr);
    assert!(
        r.stdout.contains("config set max_tokens 8192"),
        "应拼出 `config set max_tokens 8192`，实际 stdout=\n{}",
        r.stdout
    );
}
