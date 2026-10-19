// 无 tauri feature 时 commands 全部被 cfg 掉，此 import 会 unused，故同样门控。
#[cfg(feature = "tauri")]
use crate::ocr::OcrResult;

// 所有 command 一律声明为 `async fn`，把同步逻辑（spawn ocr / 读写文件）交给 blocking
// 线程池，避免占用 IPC 处理线程。同步 command 会就地跑完才返回，而 `cmd.output()` 要等
// 子进程退出——ocr 是 Node CLI，单次启动实测约 0.5s（首次可达 2.6s），逐条下发时 UI 会
// 冻结到无响应。改为 async + spawn_blocking 后窗口全程可交互。
#[cfg(feature = "tauri")]
async fn run_blocking<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

// 纯文件 IO 类 command 的兜底失败结果：blocking 任务 panic 或被取消（join 失败）时使用。
// 这类 command 的返回类型不是 Result，无法直接上抛，故归一为一个 ok=false 的 OcrResult。
#[cfg(feature = "tauri")]
fn io_error_result(msg: String) -> OcrResult {
    OcrResult {
        ok: false,
        exit_code: -1,
        stdout: String::new(),
        stderr: msg,
        data: None,
    }
}

// 前端 invoke("run_ocr", { args }) 的入口 command。
// 后续所有业务 command 都复用 ocr::run_ocr（直接 spawn `ocr.cmd`，不经 cmd /c）。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn run_ocr(args: Vec<String>) -> Result<OcrResult, String> {
    run_blocking(move || {
        let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
        crate::ocr::run_ocr(&refs)
    })
    .await?
}

// 前端 invoke("probe_ocr") 的入口 command：探测 ocr 是否安装并解析其版本号。
// 复用 ocr::probe_ocr（内部调 `ocr.cmd --version`），成功时 data = { version }。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn probe_ocr() -> Result<OcrResult, String> {
    run_blocking(crate::ocr::probe_ocr).await?
}

// 前端 invoke("get_config") 的入口 command：直接读取 ~/.opencodereview/config.json。
// 不发任何 ocr 命令（ocr 无 `config get`）；文件缺失返回空对象，JSON 非法时 ok=false
// 且 stderr 含 `invalid json`。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn get_config() -> OcrResult {
    match run_blocking(crate::ocr::get_config_result).await {
        Ok(r) => r,
        Err(e) => io_error_result(format!("读取配置失败：{e}")),
    }
}

// Provider 保存命令（逐条 `ocr config set`）。空串语义见 ocr::set_model / set_provider_key：
// 空串 = 「不写入」，跳过、不覆盖已有值。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn set_provider(provider: String) -> Result<OcrResult, String> {
    run_blocking(move || crate::ocr::set_provider(&provider)).await?
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn set_provider_key(provider: String, key: String) -> Result<OcrResult, String> {
    run_blocking(move || crate::ocr::set_provider_key(&provider, &key)).await?
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn set_custom_provider(
    name: String,
    url: String,
    protocol: String,
) -> Result<OcrResult, String> {
    run_blocking(move || crate::ocr::set_custom_provider(&name, &url, &protocol)).await?
}

#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn set_model(model: String) -> Result<OcrResult, String> {
    run_blocking(move || crate::ocr::set_model(&model)).await?
}

// Params Tab（spec §4.2）：仅 `max_tokens` / `effort` 可持久化。
// 白名单外的键返回 ok=false 且 stderr 含 `unsupported key`（由 ocr::set_param 保证），
// 绝不把不可持久化的键下发给真实 CLI。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn set_param(key: String, value: String) -> Result<OcrResult, String> {
    run_blocking(move || crate::ocr::set_param(&key, &value)).await?
}

// `test_connection`：跑 `ocr llm test`，data = { success, message }。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn test_connection() -> Result<OcrResult, String> {
    run_blocking(crate::ocr::test_connection).await?
}

// `list_providers`：跑 `ocr llm providers`，data 为 provider 数组（name/protocol/baseUrl）。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn list_providers() -> Result<OcrResult, String> {
    run_blocking(crate::ocr::list_providers).await?
}

// ---- Rules Tab（spec §4.3）----

// 读取 rule.json：scope ∈ {global, repo}；repo 需 repo_path。
// 文件缺失 → {rules:[]}（不报错）；损坏 JSON → ok=false 且 stderr 含 `invalid json`。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn get_rules(scope: String, repo_path: Option<String>) -> OcrResult {
    match run_blocking(move || crate::ocr::get_rules_result(&scope, repo_path.as_deref())).await {
        Ok(r) => r,
        Err(e) => io_error_result(format!("读取规则失败：{e}")),
    }
}

// 写入 rule.json：写前逐条校验 path/rule 非空、mergeSystemRule 为 bool；
// 失败 ok=false 且 stderr 带行号定位。原子写（临时文件 + rename）。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn set_rules(
    scope: String,
    repo_path: Option<String>,
    rules: serde_json::Value,
) -> OcrResult {
    match run_blocking(move || crate::ocr::set_rules_result(&scope, repo_path.as_deref(), &rules))
        .await
    {
        Ok(r) => r,
        Err(e) => io_error_result(format!("写入规则失败：{e}")),
    }
}

// 验证某文件命中的规则：`ocr rules check <file> --repo <root>`，data 为命中规则文本。
// repo 省略时由 ocr::check_rules_result 从 file 向上回溯 git root（global 场景），
// 避免 CLI 用 GUI 进程 cwd 定位仓库而失败；文件不在 git 仓库内则给出清晰中文提示。
#[cfg(feature = "tauri")]
#[tauri::command]
pub async fn check_rules(file: String, repo: Option<String>) -> Result<OcrResult, String> {
    run_blocking(move || crate::ocr::check_rules_result(&file, repo.as_deref())).await?
}
