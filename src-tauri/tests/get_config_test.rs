// 集成测试：get_config 的「合法 JSON」「合法但缺字段」「非法 JSON」三态。
// 全部针对临时目录里的 mock 文件，绝不触碰用户真实的 ~/.opencodereview/config.json
// （安全纪律：本任务只读，且测试完全隔离）。
//
// 直接调用 app_lib::ocr::get_config_result_at(path)，构造带 tauri 的 command 包装
// 在 --no-default-features 下不编译，故测试经由此无 feature 依赖的入口覆盖同一逻辑。

use std::path::PathBuf;

// 建唯一的临时 mock 目录（用测试名 + 进程 id 避免并发冲突）。
fn mock_path(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ocr_get_config_mock_{}_{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).expect("create mock dir");
    dir.join("config.json")
}

fn cleanup(path: &std::path::Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[test]
fn get_config_valid_json() {
    let path = mock_path("valid");
    let content = r#"{
        "provider": "anthropic",
        "model": "claude-sonnet-4",
        "max_tokens": 8192,
        "effort": "high",
        "providers": { "anthropic": { "api_key": "sk-secret" } },
        "custom_providers": { "mygw": { "url": "https://example.test/v1", "protocol": "openai" } }
    }"#;
    std::fs::write(&path, content).expect("write mock config");

    let result = app_lib::ocr::get_config_result_at(&path);
    cleanup(&path);

    assert!(result.ok, "合法 JSON 时 ok 应为 true；stderr={}", result.stderr);
    assert_eq!(result.exit_code, 0, "成功态 exit_code 应为 0");
    let data = result.data.expect("成功态应有 data 字段");
    assert_eq!(
        data.get("provider").and_then(|v| v.as_str()),
        Some("anthropic"),
        "data.provider 应为 anthropic"
    );
    assert_eq!(
        data.get("model").and_then(|v| v.as_str()),
        Some("claude-sonnet-4")
    );
    assert_eq!(data.get("max_tokens").and_then(|v| v.as_u64()), Some(8192));
    assert_eq!(data.get("effort").and_then(|v| v.as_str()), Some("high"));
    // 嵌套结构原样保留（providers / custom_providers 走 snake_case，与真实键名一致）。
    assert_eq!(
        data.pointer("/providers/anthropic/api_key").and_then(|v| v.as_str()),
        Some("sk-secret")
    );
    assert_eq!(
        data.pointer("/custom_providers/mygw/protocol").and_then(|v| v.as_str()),
        Some("openai")
    );
}

#[test]
fn get_config_missing_file_is_empty_object() {
    // 指向一个不存在的文件路径（目录存在、文件不存在）。
    let path = mock_path("missing");
    let _ = std::fs::remove_file(&path);

    let result = app_lib::ocr::get_config_result_at(&path);
    cleanup(&path);

    assert!(result.ok, "文件缺失应视为空配置（ok=true）；stderr={}", result.stderr);
    let data = result.data.expect("缺失态仍应返回 data（空对象）");
    assert_eq!(data, serde_json::json!({}), "缺失态 data 应为空对象 {{}}");
}

#[test]
fn get_config_invalid_json() {
    let path = mock_path("invalid");
    // 非法 JSON：截断的括号。
    std::fs::write(&path, "{ \"provider\": \"anthropic\", ").expect("write mock config");

    let result = app_lib::ocr::get_config_result_at(&path);
    cleanup(&path);

    assert!(!result.ok, "非法 JSON 时 ok 应为 false");
    assert_ne!(result.exit_code, 0, "非法 JSON 时 exit_code 不应为 0");
    assert!(
        result.stderr.contains("invalid json"),
        "stderr 应含 `invalid json`，实际：{}",
        result.stderr
    );
    assert!(result.data.is_none(), "非法 JSON 时 data 应为空");
}
