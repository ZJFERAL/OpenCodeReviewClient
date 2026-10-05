// 无 tauri feature 时 commands 全部被 cfg 掉，此 import 会 unused，故同样门控。
#[cfg(feature = "tauri")]
use crate::ocr::OcrResult;

// 前端 invoke("run_ocr", { args }) 的入口 command。
// 后续所有业务 command 都复用 ocr::run_ocr（直接 spawn `ocr.cmd`，不经 cmd /c）。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn run_ocr(args: Vec<String>) -> Result<OcrResult, String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    crate::ocr::run_ocr(&refs)
}

// 前端 invoke("probe_ocr") 的入口 command：探测 ocr 是否安装并解析其版本号。
// 复用 ocr::probe_ocr（内部调 `ocr.cmd --version`），成功时 data = { version }。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn probe_ocr() -> Result<OcrResult, String> {
    crate::ocr::probe_ocr()
}

// 前端 invoke("get_config") 的入口 command：直接读取 ~/.opencodereview/config.json。
// 不发任何 ocr 命令（ocr 无 `config get`）；文件缺失返回空对象，JSON 非法时 ok=false
// 且 stderr 含 `invalid json`。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn get_config() -> OcrResult {
    crate::ocr::get_config_result()
}

// Provider 保存命令（逐条 `ocr config set`）。空串语义见 ocr::set_model / set_provider_key：
// 空串 = 「不写入」，跳过、不覆盖已有值。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn set_provider(provider: String) -> Result<OcrResult, String> {
    crate::ocr::set_provider(&provider)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn set_provider_key(provider: String, key: String) -> Result<OcrResult, String> {
    crate::ocr::set_provider_key(&provider, &key)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn set_custom_provider(name: String, url: String, protocol: String) -> Result<OcrResult, String> {
    crate::ocr::set_custom_provider(&name, &url, &protocol)
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub fn set_model(model: String) -> Result<OcrResult, String> {
    crate::ocr::set_model(&model)
}

// Params Tab（spec §4.2）：仅 `max_tokens` / `effort` 可持久化。
// 白名单外的键返回 ok=false 且 stderr 含 `unsupported key`（由 ocr::set_param 保证），
// 绝不把不可持久化的键下发给真实 CLI。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn set_param(key: String, value: String) -> Result<OcrResult, String> {
    crate::ocr::set_param(&key, &value)
}

// `test_connection`：跑 `ocr llm test`，data = { success, message }。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn test_connection() -> Result<OcrResult, String> {
    crate::ocr::test_connection()
}

// `list_providers`：跑 `ocr llm providers`，data 为 provider 数组（name/protocol/baseUrl）。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn list_providers() -> Result<OcrResult, String> {
    crate::ocr::list_providers()
}

// ---- Rules Tab（spec §4.3）----

// 读取 rule.json：scope ∈ {global, repo}；repo 需 repo_path。
// 文件缺失 → {rules:[]}（不报错）；损坏 JSON → ok=false 且 stderr 含 `invalid json`。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn get_rules(scope: String, repo_path: Option<String>) -> OcrResult {
    crate::ocr::get_rules_result(&scope, repo_path.as_deref())
}

// 写入 rule.json：写前逐条校验 path/rule 非空、mergeSystemRule 为 bool；
// 失败 ok=false 且 stderr 带行号定位。原子写（临时文件 + rename）。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn set_rules(scope: String, repo_path: Option<String>, rules: serde_json::Value) -> OcrResult {
    crate::ocr::set_rules_result(&scope, repo_path.as_deref(), &rules)
}

// 验证某文件命中的规则：`ocr rules check <file> --repo <root>`，data 为命中规则文本。
// repo 省略时由 ocr::check_rules_result 从 file 向上回溯 git root（global 场景），
// 避免 CLI 用 GUI 进程 cwd 定位仓库而失败；文件不在 git 仓库内则给出清晰中文提示。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn check_rules(file: String, repo: Option<String>) -> Result<OcrResult, String> {
    crate::ocr::check_rules_result(&file, repo.as_deref())
}
