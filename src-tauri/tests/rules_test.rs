// 集成测试：Rules 读写（global/repo 作用范围，直接读写 rule.json）。
//
// 安全纪律：全部针对临时目录里的 mock 文件，绝不读写用户真实的 `~/.opencodereview/`。
// 直接调用无 tauri 依赖的 `app_lib::ocr::*_at` / `*_result` 入口
//（带 tauri 的 command 包装在 --no-default-features 下不编译）。
//
// 真实 rule.json 结构由隔离 HOME 实测确认（ocr v1.12.11）：
//   {"rules":[{"path":"**/*.java","rule":"...","merge_system_rule":true}]}
//   键名 snake_case；`merge_system_rule` 为 bool，可省略（CLI 接受）。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

// 串行化对全局 PATH 的改写（check_rules 的 mock 用例）。
static ENV_LOCK: Mutex<()> = Mutex::new(());

// 建唯一临时 mock 目录，返回 (dir, rule.json 路径)。
fn mock_rules_path(name: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("ocr_rules_mock_{}_{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".opencodereview")).expect("create mock dir");
    let path = dir.join(".opencodereview").join("rule.json");
    (dir, path)
}

fn cleanup(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

// ---- Step 1 要求的三类边界 ----

#[test]
fn get_rules_valid_reads_rules() {
    let (dir, path) = mock_rules_path("valid");
    let content = r#"{"rules":[
        {"path":"**/*.java","rule":"校验必填参数非空","merge_system_rule":true},
        {"path":"**/mapper*.xml","rule":"检查 SQL 注入","merge_system_rule":false}
    ]}"#;
    std::fs::write(&path, content).expect("write mock rule.json");

    let result = app_lib::ocr::read_rules_result_at(&path);
    cleanup(&dir);

    assert!(result.ok, "合法 rule.json 时 ok 应为 true；stderr={}", result.stderr);
    assert_eq!(result.exit_code, 0);
    let data = result.data.expect("成功态应有 data");
    let rules = data.get("rules").and_then(|v| v.as_array()).expect("data.rules 应为数组");
    assert_eq!(rules.len(), 2, "应解析出 2 条规则，实际 {:?}", rules);
    assert_eq!(rules[0].get("path").and_then(|v| v.as_str()), Some("**/*.java"));
    assert_eq!(rules[0].get("rule").and_then(|v| v.as_str()), Some("校验必填参数非空"));
    // 前端契约键名为 camelCase `mergeSystemRule`（与 src/types.ts 一致）。
    assert_eq!(
        rules[0].get("mergeSystemRule").and_then(|v| v.as_bool()),
        Some(true)
    );
    assert_eq!(
        rules[1].get("mergeSystemRule").and_then(|v| v.as_bool()),
        Some(false)
    );
}

// 审查焦点 #3：损坏 JSON → ok=false 且 stderr 含 `invalid json`（不 panic）。
#[test]
fn get_rules_corrupt_json_is_error() {
    let (dir, path) = mock_rules_path("corrupt");
    std::fs::write(&path, "{ \"rules\": [ { \"path\": ").expect("write corrupt rule.json");

    let result = app_lib::ocr::read_rules_result_at(&path);
    cleanup(&dir);

    assert!(!result.ok, "损坏 JSON 时 ok 应为 false");
    assert_ne!(result.exit_code, 0);
    assert!(
        result.stderr.contains("invalid json"),
        "stderr 应含 `invalid json`，实际：{}",
        result.stderr
    );
    assert!(result.data.is_none(), "损坏时不应有 data");
}

// 文件缺失 → {rules:[]}，不报错（spec §4.3）。
#[test]
fn get_rules_missing_file_is_empty() {
    let (dir, path) = mock_rules_path("missing");
    let _ = std::fs::remove_file(&path);

    let result = app_lib::ocr::read_rules_result_at(&path);
    cleanup(&dir);

    assert!(result.ok, "文件缺失应返回空规则集（ok=true）；stderr={}", result.stderr);
    let data = result.data.expect("缺失态应有 data");
    let rules = data.get("rules").and_then(|v| v.as_array()).expect("data.rules 应为数组");
    assert!(rules.is_empty(), "缺失态 rules 应为空，实际 {:?}", rules);
}

// 审查焦点 #4：repo 目录不存在 → 空规则集而非报错。
#[test]
fn get_rules_repo_missing_dir_is_empty() {
    let dir = std::env::temp_dir().join(format!("ocr_rules_nodir_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let nonexistent = dir.join("does-not-exist").to_string_lossy().to_string();

    let result = app_lib::ocr::get_rules_result("repo", Some(&nonexistent));
    cleanup(&dir);

    assert!(result.ok, "repo 目录不存在应返回空规则集（ok=true）；stderr={}", result.stderr);
    let data = result.data.expect("应有 data");
    let rules = data.get("rules").and_then(|v| v.as_array()).expect("data.rules 应为数组");
    assert!(rules.is_empty(), "目录不存在时 rules 应为空，实际 {:?}", rules);
}

// ---- set_rules 校验（审查焦点：ok=false + stderr 含行号定位）----

#[test]
fn set_rules_empty_path_fails_with_line_number() {
    let (dir, _path) = mock_rules_path("empty_path");
    let repo = dir.to_string_lossy().to_string();
    let rules = serde_json::json!({
        "rules": [{ "path": "", "rule": "有规则但 path 为空", "mergeSystemRule": true }]
    });

    let result = app_lib::ocr::set_rules_result("repo", Some(&repo), &rules);
    cleanup(&dir);

    assert!(!result.ok, "空 path 时 ok 应为 false");
    assert_ne!(result.exit_code, 0);
    assert!(
        result.stderr.contains("第 1 条") && result.stderr.contains('行'),
        "stderr 应含规则序号与行号定位，实际：{}",
        result.stderr
    );
    assert!(result.stderr.contains("path"), "stderr 应点名 path，实际：{}", result.stderr);
}

#[test]
fn set_rules_empty_rule_fails_with_line_number() {
    let (dir, _path) = mock_rules_path("empty_rule");
    let repo = dir.to_string_lossy().to_string();
    let rules = serde_json::json!({
        "rules": [
            { "path": "**/*.java", "rule": "ok", "mergeSystemRule": false },
            { "path": "**/*.py", "rule": "   ", "mergeSystemRule": false }
        ]
    });

    let result = app_lib::ocr::set_rules_result("repo", Some(&repo), &rules);
    cleanup(&dir);

    assert!(!result.ok);
    assert!(
        result.stderr.contains("第 2 条"),
        "应定位到第 2 条规则，实际：{}",
        result.stderr
    );
    assert!(result.stderr.contains("rule"), "stderr 应点名 rule，实际：{}", result.stderr);
}

// mergeSystemRule 必须是 bool（spec §4.3）。
#[test]
fn set_rules_non_bool_merge_fails_with_line_number() {
    let (dir, _path) = mock_rules_path("bad_merge");
    let repo = dir.to_string_lossy().to_string();
    let rules = serde_json::json!({
        "rules": [{ "path": "**/*.java", "rule": "x", "mergeSystemRule": "true" }]
    });

    let result = app_lib::ocr::set_rules_result("repo", Some(&repo), &rules);
    cleanup(&dir);

    assert!(!result.ok, "mergeSystemRule 非 bool 时 ok 应为 false");
    assert!(
        result.stderr.contains("第 1 条") && result.stderr.contains("mergeSystemRule"),
        "stderr 应含行号与字段名，实际：{}",
        result.stderr
    );
}

// 合法保存：写入 repo 级 rule.json，内容为 CLI 真实 snake_case 键名，且能回读。
#[test]
fn set_rules_valid_writes_and_roundtrips() {
    let (dir, path) = mock_rules_path("valid_write");
    let repo = dir.to_string_lossy().to_string();
    let rules = serde_json::json!({
        "rules": [{ "path": "**/*.java", "rule": "检查空指针", "mergeSystemRule": true }]
    });

    let result = app_lib::ocr::set_rules_result("repo", Some(&repo), &rules);
    assert!(result.ok, "合法规则应保存成功；stderr={}", result.stderr);

    // 文件应落在 <repo>/.opencodereview/rule.json。
    assert!(path.exists(), "应写入 {}", path.display());
    let text = std::fs::read_to_string(&path).expect("read written rule.json");
    assert!(text.contains("\"merge_system_rule\""), "文件应使用 snake_case 键名，实际：{text}");
    assert!(!text.contains("mergeSystemRule"), "文件不应写入 camelCase 键名，实际：{text}");

    // 无残留临时文件（原子写 rename 后应清理）。
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .expect("read dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "不应残留临时文件，实际 {:?}", leftovers);

    // 回读断言 round-trip。
    let read = app_lib::ocr::read_rules_result_at(&path);
    cleanup(&dir);
    assert!(read.ok);
    let data = read.data.expect("应有 data");
    let arr = data.get("rules").and_then(|v| v.as_array()).expect("rules 数组");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0].get("path").and_then(|v| v.as_str()), Some("**/*.java"));
    assert_eq!(arr[0].get("mergeSystemRule").and_then(|v| v.as_bool()), Some(true));
}

// I1：覆盖已存在的 rule.json 必须成功（rename 原子覆盖，而非「删除→rename」两步）。
// 修复前实现会先 remove_file 旧文件再 rename，若 rename 失败则原文件已丢；本测试锁定
// 「直接 rename 覆盖已存在目标」这一行为，并验证新旧内容替换正确、无临时文件残留。
#[test]
fn set_rules_overwrites_existing_file() {
    let (dir, path) = mock_rules_path("overwrite");
    let repo = dir.to_string_lossy().to_string();

    // 先写旧内容（含两条规则）。
    let old = serde_json::json!({
        "rules": [
            { "path": "**/*.java", "rule": "旧规则一", "mergeSystemRule": true },
            { "path": "**/*.py", "rule": "旧规则二", "mergeSystemRule": false }
        ]
    });
    let first = app_lib::ocr::set_rules_result("repo", Some(&repo), &old);
    assert!(first.ok, "首次写入应成功；stderr={}", first.stderr);
    assert!(path.exists(), "旧文件应已存在");

    // 覆盖为新内容（一条规则）。
    let new = serde_json::json!({
        "rules": [{ "path": "**/*.ts", "rule": "新规则", "mergeSystemRule": false }]
    });
    let second = app_lib::ocr::set_rules_result("repo", Some(&repo), &new);
    assert!(
        second.ok,
        "覆盖已存在文件应成功（rename 原子覆盖）；stderr={}",
        second.stderr
    );

    // 内容应为新规则，旧内容不再出现。
    let text = std::fs::read_to_string(&path).expect("read overwritten rule.json");
    assert!(text.contains("新规则"), "应写入新内容，实际：{text}");
    assert!(!text.contains("旧规则一"), "旧内容应被完全替换，实际：{text}");

    // 无残留临时文件。
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .expect("read dir")
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "覆盖后不应残留临时文件，实际 {:?}", leftovers);

    // 回读应得到新内容单条规则。
    let read = app_lib::ocr::read_rules_result_at(&path);
    cleanup(&dir);
    assert!(read.ok);
    let data = read.data.expect("应有 data");
    let arr = data.get("rules").and_then(|v| v.as_array()).expect("rules 数组");
    assert_eq!(arr.len(), 1, "覆盖后应只剩 1 条规则，实际 {:?}", arr);
    assert_eq!(arr[0].get("path").and_then(|v| v.as_str()), Some("**/*.ts"));
    assert_eq!(arr[0].get("mergeSystemRule").and_then(|v| v.as_bool()), Some(false));
}

// 缺 rules 字段 → 校验失败（不 panic），并给出中文提示。
#[test]
fn set_rules_missing_rules_field_fails() {
    let (dir, _path) = mock_rules_path("no_rules");
    let repo = dir.to_string_lossy().to_string();
    let rules = serde_json::json!({ "notRules": [] });

    let result = app_lib::ocr::set_rules_result("repo", Some(&repo), &rules);
    cleanup(&dir);

    assert!(!result.ok);
    assert!(!result.stderr.is_empty(), "应给出中文错误提示");
}

// repo 作用范围缺 repo_path → 报错（无法定位文件），而非静默写错位置。
#[test]
fn set_rules_repo_without_path_fails() {
    let rules = serde_json::json!({ "rules": [] });
    let result = app_lib::ocr::set_rules_result("repo", None, &rules);
    assert!(!result.ok, "repo 作用范围缺 repo_path 应失败");
    assert!(!result.stderr.is_empty());
}

// global 路径解析：以 ~/.opencodereview/rule.json 结尾（只解析路径，不读写真实文件）。
#[test]
fn rules_path_for_global_is_under_opencodereview() {
    let path = app_lib::ocr::rules_path_for("global", None).expect("global 路径应可解析");
    assert!(
        path.ends_with(Path::new(".opencodereview").join("rule.json")),
        "global 路径应以 .opencodereview/rule.json 结尾，实际 {}",
        path.display()
    );
    // 未知 scope 应报错。
    assert!(app_lib::ocr::rules_path_for("nope", None).is_err());
}

// ---- check_rules：经 mock ocr 验证参数拼装与 data 语义 ----

fn write_fake_ocr(mock_dir: &Path) {
    // 把收到的参数回显到 stdout，便于断言拼装出的 --repo 值。
    let script = concat!(
        "@echo off\r\n",
        "echo ARGS:%*\r\n",
        "echo Source: Project (.opencodereview/rule.json)\r\n",
        "echo Pattern: **/*.java\r\n",
        "echo Rule:\r\n",
        "echo   MATCHED-CUSTOM-RULE\r\n",
        "exit 0\r\n",
    );
    std::fs::write(mock_dir.join("ocr.cmd"), script).expect("write fake ocr.cmd");
}

#[test]
fn check_rules_builds_args_and_returns_text() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mock = std::env::temp_dir().join(format!("ocr_rules_check_mock_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&mock);
    std::fs::create_dir_all(&mock).expect("create mock dir");
    write_fake_ocr(&mock);

    let original = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{};{}", mock.display(), original));

    let result = app_lib::ocr::check_rules_result("src/Foo.java", Some("F:/repo"));

    std::env::set_var("PATH", original);
    let _ = std::fs::remove_dir_all(&mock);

    let r = result.expect("应执行成功返回");
    assert!(r.ok, "mock 退出 0 时 ok 应为 true；stderr={}", r.stderr);
    // data 为命中规则文本（stdout）。
    assert_eq!(
        r.data.as_ref().and_then(|v| v.as_str()),
        Some(r.stdout.as_str()),
        "data 应为命中规则文本"
    );
    assert!(r.stdout.contains("MATCHED-CUSTOM-RULE"));
    // 显式 repo 应原样拼进 `--repo`。
    assert!(
        r.stdout.contains("--repo F:/repo"),
        "应把显式 repo 拼进 --repo，实际 stdout=\n{}",
        r.stdout
    );
}

// I2：global 作用范围（未显式传 repo）时，应由文件路径向上回溯 git root 作为 --repo，
// 避免 CLI 用 GUI 进程 cwd（非 git 仓库）定位而报 `... is not a git repository`。
#[test]
fn check_rules_backtracks_git_root_when_repo_absent() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mock = std::env::temp_dir().join(format!("ocr_rules_gitroot_mock_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&mock);
    std::fs::create_dir_all(&mock).expect("create mock dir");
    write_fake_ocr(&mock);

    // 造一个「git 仓库」：<root>/.git/ 与深层子目录 <root>/a/b/Foo.java。
    let root = std::env::temp_dir().join(format!("ocr_rules_gitroot_repo_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join(".git")).expect("create .git");
    let deep = root.join("a").join("b");
    std::fs::create_dir_all(&deep).expect("create deep dir");
    let file = deep.join("Foo.java");

    let original = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{};{}", mock.display(), original));

    let result = app_lib::ocr::check_rules_result(file.to_string_lossy().as_ref(), None);

    std::env::set_var("PATH", original);
    let _ = std::fs::remove_dir_all(&mock);
    let _ = std::fs::remove_dir_all(&root);

    let r = result.expect("应执行成功返回");
    assert!(r.ok, "ok 应为 true；stderr={}", r.stderr);
    assert!(
        r.stdout.contains(&format!("--repo {}", root.display())),
        "应回溯到 git root 作为 --repo，期望含 `--repo {}`，实际 stdout=\n{}",
        root.display(),
        r.stdout
    );
}

// I2：文件不在任何 git 仓库内且未指定 repo → 清晰中文提示（不让 CLI 抛 cwd 错误）。
#[test]
fn check_rules_outside_git_repo_gives_clear_message() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 造一个不含 .git 的孤立目录。temp_dir 本身可能位于某仓库内，故显式多套一层且不建 .git；
    // 用系统临时目录下随机名，向上回溯直到盘根都不应有 .git（真实 ~/.opencodereview 与项目仓库均不在此链上）。
    let outside = std::env::temp_dir().join(format!("ocr_rules_nogit_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&outside);
    std::fs::create_dir_all(&outside).expect("create dir");
    let file = outside.join("Loose.java");
    std::fs::write(&file, "class Loose {}").expect("write file");

    // 若临时目录链上真存在 .git（环境差异），本用例跳过断言外的情况。
    let has_git_ancestor = app_lib::ocr::find_git_root(file.to_string_lossy().as_ref()).is_some();
    if has_git_ancestor {
        let _ = std::fs::remove_dir_all(&outside);
        return;
    }

    let result = app_lib::ocr::check_rules_result(file.to_string_lossy().as_ref(), None);
    let _ = std::fs::remove_dir_all(&outside);

    let r = result.expect("不应因找不到仓库而 panic/Err");
    assert!(!r.ok, "不在 git 仓库内时应返回 ok=false");
    assert!(
        r.stderr.contains("git 仓库"),
        "应给出清晰中文提示，实际 stderr={}",
        r.stderr
    );
}
