// 集成测试：Provider 保存命令的参数拼装 + test_connection 的成败解析 + list_providers 表格解析。
//
// mock 方式与 probe_ocr_test 一致：把 fake `ocr.cmd` 前置到 PATH，让 `cmd /c ocr ...`
// 命中它，并把收到的 args 回显到 stdout（`ARGS:%*`），从而断言「拼装到 spawn 的键路径正确」。
// 安全纪律：全程只碰临时 mock 目录，绝不执行/写入用户真实的 `~/.opencodereview/`。

use std::sync::Mutex;

// 串行化所有对全局 PATH / 环境变量的改写，避免并发测试互相污染。
static ENV_LOCK: Mutex<()> = Mutex::new(());

// 写 fake `ocr.cmd` 到 mock 目录：默认把收到的 args 回显为 `ARGS:<...>` 并退出 0；
// 当参数为 `llm test` 时，按 FAKE_OCR_TEST_OK 决定走成功/失败分支。
fn write_fake_ocr(mock_dir: &std::path::Path) {
    let script = concat!(
        "@echo off\r\n",
        "if \"%~1\"==\"llm\" if \"%~2\"==\"test\" goto llmtest\r\n",
        "echo ARGS:%*\r\n",
        "if \"%FAKE_OCR_EXIT%\"==\"\" (exit 0) else (exit %FAKE_OCR_EXIT%)\r\n",
        ":llmtest\r\n",
        "if \"%FAKE_OCR_TEST_OK%\"==\"1\" (\r\n",
        "  echo Source: provider:mock\r\n",
        "  echo URL:    http://127.0.0.1:1/v1\r\n",
        "  echo Model:  gpt-5\r\n",
        "  echo pong\r\n",
        "  echo Connection test successful\r\n",
        "  exit 0\r\n",
        ")\r\n",
        "echo Error: llm request failed: 401 Unauthorized 1>&2\r\n",
        "exit 1\r\n",
    );
    std::fs::write(mock_dir.join("ocr.cmd"), script).expect("write fake ocr.cmd");
}

// 前置 mock 目录到 PATH（保留 System32 等以便 cmd 自身可解析），返回原 PATH。
fn push_mock(mock_dir: &std::path::Path) -> String {
    let original = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{};{}", mock_dir.display(), original));
    original
}

fn restore_path(original: &str) {
    std::env::set_var("PATH", original);
}

// 建带进程 id 的唯一 mock 目录，加载 fake 脚本并前置到 PATH。返回 (dir, original_path)。
fn setup_mock(name: &str) -> (std::path::PathBuf, String) {
    let dir = std::env::temp_dir().join(format!("ocr_provider_save_{}_{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create mock dir");
    write_fake_ocr(&dir);
    let original = push_mock(&dir);
    (dir, original)
}

fn teardown(dir: &std::path::Path, original: &str) {
    restore_path(original);
    let _ = std::fs::remove_dir_all(dir);
}

// 审查焦点 #2：set_provider_key 必须拼成 `providers.<provider>.api_key`（不是顶层 `api_key`，
// 也不是 `providers.<provider>.key`）——真实 ocr 只认 `providers.<name>.<field>` 这套键路径。
#[test]
fn set_provider_key_builds_dotted_key_path() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("key");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_provider_key("anthropic", "sk-xxx");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(r.ok, "mock 退出 0 时 ok 应为 true；stderr={}", r.stderr);
    assert!(
        r.stdout.contains("providers.anthropic.api_key"),
        "拼装应含 providers.anthropic.api_key，实际 stdout=\n{}",
        r.stdout
    );
    assert!(
        r.stdout.contains("sk-xxx"),
        "拼装应带上 key 值，实际 stdout=\n{}",
        r.stdout
    );
}

#[test]
fn set_provider_builds_provider_arg() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("provider");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_provider("openai");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(
        r.stdout.contains("config set provider openai"),
        "应拼出 `config set provider openai`，实际 stdout=\n{}",
        r.stdout
    );
}

#[test]
fn set_custom_provider_builds_url_and_protocol() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("custom");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_custom_provider("mygw", "https://x.test/v1", "openai");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(
        r.stdout.contains("custom_providers.mygw.url")
            && r.stdout.contains("https://x.test/v1"),
        "应拼出 custom_providers.mygw.url 与其值，实际 stdout=\n{}",
        r.stdout
    );
    assert!(
        r.stdout.contains("custom_providers.mygw.protocol") && r.stdout.contains("openai"),
        "应拼出 custom_providers.mygw.protocol 与其值，实际 stdout=\n{}",
        r.stdout
    );
    // I1：写入顺序应为 protocol 先行，再写 url。
    let proto_pos = r
        .stdout
        .find("custom_providers.mygw.protocol")
        .expect("应有 protocol 拼装");
    let url_pos = r
        .stdout
        .find("custom_providers.mygw.url")
        .expect("应有 url 拼装");
    assert!(
        proto_pos < url_pos,
        "应先写 protocol 再写 url，实际 stdout=\n{}",
        r.stdout
    );
}

// I1：任一字段失败时，stderr 应带字段名与「可能半完成」提示。
#[test]
fn set_custom_provider_failure_mentions_field_and_half_state() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("custom_fail");
    // fake 脚本：非 llm test 时按 FAKE_OCR_EXIT 退出，用 1 制造首条 set 失败。
    std::env::set_var("FAKE_OCR_EXIT", "1");

    let result = app_lib::ocr::set_custom_provider("mygw", "https://x.test/v1", "openai");
    std::env::remove_var("FAKE_OCR_EXIT");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(!r.ok, "首条 set 失败时整体 ok 应为 false");
    assert!(
        r.stderr.contains("custom_providers.mygw.protocol"),
        "stderr 应含失败字段名，实际:\n{}",
        r.stderr
    );
    assert!(
        r.stderr.contains("半完成"),
        "stderr 应含「可能半完成」提示，实际:\n{}",
        r.stderr
    );
}

#[test]
fn set_model_builds_model_arg() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("model");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_model("gpt-5");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(
        r.stdout.contains("config set model gpt-5"),
        "应拼出 `config set model gpt-5`，实际 stdout=\n{}",
        r.stdout
    );
}

// 空串语义（Task 4 reviewer）：model 为空 = 「不写」，必须跳过、不 spawn ocr。
#[test]
fn set_model_empty_skips_without_spawning_ocr() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("model_empty");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_model("");
    teardown(&dir, &original);

    let r = result.expect("跳过也应返回 Ok，不报错");
    assert!(r.ok, "跳过应视为成功");
    assert!(
        !r.stdout.contains("ARGS:"),
        "model 为空时不应 spawn ocr，实际 stdout=\n{}",
        r.stdout
    );
    assert_eq!(
        r.data.as_ref().and_then(|d| d.get("skipped")).and_then(|v| v.as_bool()),
        Some(true),
        "跳过时 data.skipped 应为 true，实际 {:?}",
        r.data
    );
}

// 空串语义（Task 4 reviewer / 铁律 #6）：api_key 空串 = 「未输入」，不得覆盖已有 key，须跳过。
#[test]
fn set_provider_key_empty_skips_without_spawning_ocr() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("key_empty");
    std::env::remove_var("FAKE_OCR_EXIT");

    let result = app_lib::ocr::set_provider_key("openai", "");
    teardown(&dir, &original);

    let r = result.expect("跳过也应返回 Ok");
    assert!(r.ok, "跳过应视为成功");
    assert!(
        !r.stdout.contains("ARGS:"),
        "key 为空时不应 spawn ocr，实际 stdout=\n{}",
        r.stdout
    );
    assert_eq!(
        r.data.as_ref().and_then(|d| d.get("skipped")).and_then(|v| v.as_bool()),
        Some(true),
        "跳过时 data.skipped 应为 true，实际 {:?}",
        r.data
    );
}

#[test]
fn test_connection_parses_success() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("conn_ok");
    std::env::set_var("FAKE_OCR_TEST_OK", "1");

    let result = app_lib::ocr::test_connection();
    std::env::remove_var("FAKE_OCR_TEST_OK");
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(r.ok, "成功分支 ok 应为 true；stderr={}", r.stderr);
    let data = r.data.expect("应有 data");
    assert_eq!(
        data.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "data.success 应为 true，实际 {:?}",
        data
    );
    assert!(
        data.get("message").and_then(|v| v.as_str()).is_some(),
        "data.message 应为字符串，实际 {:?}",
        data
    );
    // I3：message 应取「成功标志行」，而非 `Source:` 之类前导行。
    assert_eq!(
        data.get("message").and_then(|v| v.as_str()),
        Some("Connection test successful"),
        "message 应为成功标志行，实际 {:?}",
        data
    );
}

// I2：正向标记优先于「不含 error」的负向判定——exit 0、stdout 含 "error" 字样但带成功标记时，
// 仍应判为成功（旧逻辑 `!contains(\"error\")` 会误判为失败）。
#[test]
fn test_connection_success_with_error_word_in_stdout() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("conn_errword");
    let script = concat!(
        "@echo off\r\n",
        "echo Source: provider:mock\r\n",
        "echo note: no error encountered\r\n",
        "echo Connection test successful\r\n",
        "exit 0\r\n",
    );
    std::fs::write(dir.join("ocr.cmd"), script).expect("rewrite fake ocr.cmd");

    let result = app_lib::ocr::test_connection();
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    let data = r.data.expect("应有 data");
    assert_eq!(
        data.get("success").and_then(|v| v.as_bool()),
        Some(true),
        "含成功标记即应判成功（不被 stdout 里的 error 词误伤），实际 {:?}",
        data
    );
    assert_eq!(
        data.get("message").and_then(|v| v.as_str()),
        Some("Connection test successful"),
        "message 应为成功标志行，实际 {:?}",
        data
    );
}

// I2：exit 0 但无正向成功标记时，不应仅凭退出码判成功。
#[test]
fn test_connection_exit_zero_without_marker_is_not_success() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("conn_nomarker");
    let script = concat!(
        "@echo off\r\n",
        "echo Source: provider:mock\r\n",
        "echo something happened\r\n",
        "exit 0\r\n",
    );
    std::fs::write(dir.join("ocr.cmd"), script).expect("rewrite fake ocr.cmd");

    let result = app_lib::ocr::test_connection();
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    let data = r.data.expect("应有 data");
    assert_eq!(
        data.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "无成功标记时不应判成功，实际 {:?}",
        data
    );
}

#[test]
fn test_connection_parses_failure() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("conn_fail");
    std::env::remove_var("FAKE_OCR_TEST_OK");

    let result = app_lib::ocr::test_connection();
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回（哪怕退出非 0）");
    assert!(!r.ok, "失败分支 ok 应为 false");
    let data = r.data.expect("应有 data");
    assert_eq!(
        data.get("success").and_then(|v| v.as_bool()),
        Some(false),
        "data.success 应为 false，实际 {:?}",
        data
    );
    let msg = data.get("message").and_then(|v| v.as_str()).unwrap_or("");
    assert!(!msg.is_empty(), "失败时应给出非空 message，实际 {:?}", data);
}

// list_providers 表格解析：跳过标题/表头/分隔行与尾部图例行，按列取 name/protocol/baseUrl。
#[test]
fn list_providers_parses_table_rows() {
    let stdout = "\nBuilt-in providers:\n  NAME                 PROTOCOL           BASE URL\n  ----                 --------           --------\n  anthropic            anthropic          https://api.anthropic.com\n  bedrock              anthropic-bedrock  \n  openai               openai             https://api.openai.com/v1\n\nUse 'ocr config provider' to configure a provider interactively.\nUse 'ocr config set provider <name>' to switch providers non-interactively.\n";
    let rows = app_lib::ocr::parse_providers_table(stdout);

    assert_eq!(rows.len(), 3, "应解析出 3 个 provider，实际 {:?}", rows);

    let anthropic = &rows[0];
    assert_eq!(anthropic.get("name").and_then(|v| v.as_str()), Some("anthropic"));
    assert_eq!(anthropic.get("protocol").and_then(|v| v.as_str()), Some("anthropic"));
    assert_eq!(
        anthropic.get("baseUrl").and_then(|v| v.as_str()),
        Some("https://api.anthropic.com")
    );

    // 无 Base URL 的行（bedrock）仍应出现，baseUrl 归一为空串（而非缺字段）。
    let bedrock = &rows[1];
    assert_eq!(bedrock.get("name").and_then(|v| v.as_str()), Some("bedrock"));
    assert_eq!(
        bedrock.get("baseUrl").and_then(|v| v.as_str()),
        Some(""),
        "缺列应归一为空串，实际 {:?}",
        bedrock
    );

    let openai = &rows[2];
    assert_eq!(openai.get("protocol").and_then(|v| v.as_str()), Some("openai"));
}

// list_providers 命令端到端（mock 回显表格），data 应为数组。
#[test]
fn list_providers_returns_array_data() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (dir, original) = setup_mock("list");
    // 覆盖 fake 脚本：llm providers 时输出一小段表格。
    let script = concat!(
        "@echo off\r\n",
        "echo   NAME        PROTOCOL   BASE URL\r\n",
        "echo   ----        --------   --------\r\n",
        "echo   anthropic   anthropic  https://api.anthropic.com\r\n",
        "exit 0\r\n",
    );
    std::fs::write(dir.join("ocr.cmd"), script).expect("rewrite fake ocr.cmd");

    let result = app_lib::ocr::list_providers();
    teardown(&dir, &original);

    let r = result.expect("应执行 cmd 成功返回");
    assert!(r.ok, "ok 应为 true；stderr={}", r.stderr);
    let data = r.data.expect("应有 data");
    let arr = data.as_array().expect("data 应为数组");
    assert_eq!(arr.len(), 1, "应解析 1 行，实际 {:?}", arr);
    assert_eq!(arr[0].get("name").and_then(|v| v.as_str()), Some("anthropic"));
}
