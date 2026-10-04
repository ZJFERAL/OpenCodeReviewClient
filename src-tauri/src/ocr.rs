use serde::Serialize;
use std::path::{Path, PathBuf};

// 贯穿所有后续任务的核心结果类型（与前端 src/ipc.ts 的 OcrResult 对应）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub ok: bool,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

// 拼装 `cmd /c ocr <args>` 并执行，返回退出码 + 标准输出/错误。
// Windows 下 `Command::new("ocr")` 找不到可执行文件，必须经由 `cmd /c`（spec §8.4）。
// 当前为桩：不实际运行 ocr 命令，仅在 ocr 缺失时报告错误。
pub fn run_ocr(args: &[&str]) -> Result<OcrResult, String> {
    let mut cmd = std::process::Command::new("cmd");
    cmd.arg("/c").arg("ocr");
    for a in args {
        cmd.arg(a);
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    match cmd.output() {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let code = output.status.code().unwrap_or(-1);
            let ok = output.status.success();
            Ok(OcrResult {
                ok,
                exit_code: code,
                stdout,
                stderr,
                data: None,
            })
        }
        Err(e) => Err(format!("无法执行 ocr（cmd /c ocr 失败）：{e}")),
    }
}

// 从 `ocr --version` 输出首行提取语义版本号（如 `open-code-review v1.12.11` → `1.12.11`）。
// 零依赖实现：扫描首行，定位 `v` 后接 `数字.数字` 的片段并取整段（含可选第三级与预发布标签）。
pub fn parse_version(stdout: &str) -> Option<String> {
    let line = stdout.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return None;
    }
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // 找到 `v` 紧跟着数字的位置（`v` 可省略，但需确保数字前不是字母，避免误抓普通词）。
        let starts_v = chars[i] == 'v'
            && i + 1 < chars.len()
            && chars[i + 1].is_ascii_digit();
        let starts_digit = chars[i].is_ascii_digit()
            && (i == 0 || !chars[i - 1].is_ascii_alphabetic());
        if !starts_v && !starts_digit {
            i += 1;
            continue;
        }
        let num_start = if starts_v { i + 1 } else { i };
        // 版本号主体：`数字(.\d+)*`，之后可接预发布/构建标签 `[-+][0-9A-Za-z.\-]+`。
        let mut j = num_start;
        let mut dots = 0;
        while j < chars.len() {
            let c = chars[j];
            if c.is_ascii_digit() {
                j += 1;
            } else if c == '.' && j + 1 < chars.len() && chars[j + 1].is_ascii_digit() {
                dots += 1;
                j += 1;
            } else {
                break;
            }
        }
        if dots >= 1 && j > num_start {
            // 续接预发布/构建标签。
            if j < chars.len() && (chars[j] == '-' || chars[j] == '+') {
                let mut k = j + 1;
                while k < chars.len() && (chars[k].is_ascii_alphanumeric() || matches!(chars[k], '.' | '-')) {
                    k += 1;
                }
                return Some(chars[num_start..k].iter().collect());
            }
            return Some(chars[num_start..j].iter().collect());
        }
        i = if starts_v { i + 1 } else { num_start + 1 };
    }
    None
}

// 探测 ocr 是否可用并解析版本号。
// 复用 `run_ocr(&["--version"])`，成功（exit 0）时把版本写入 `data: { version }`；
// 版本解析失败（stdout 无 vX.Y.Z）时以空串 "" 归一，保证契约里 `version` 恒为 String，
// 绝不序列化为 JSON null。否则（exit≠0）`data` 留空。返回 `Result<OcrResult, String>`。
pub fn probe_ocr() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["--version"])?;
    if r.ok {
        r.data = Some(serde_json::json!({ "version": parse_version(&r.stdout).unwrap_or_default() }));
    }
    Ok(r)
}

// 解析 `~/.opencodereview/config.json` 的绝对路径。
// 主用 `dirs::home_dir()`（跨平台）；它不可得时回退 `HOME` / `USERPROFILE` 环境变量。
pub fn config_path() -> PathBuf {
    let home = dirs::home_dir().or_else(|| {
        std::env::var("HOME")
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| std::env::var("USERPROFILE").ok().filter(|s| !s.is_empty()))
            .map(PathBuf::from)
    });
    match home {
        Some(h) => h.join(".opencodereview").join("config.json"),
        None => PathBuf::from(".opencodereview").join("config.json"),
    }
}

// 「无需执行 ocr」的成功结果：用于空串语义下的跳过分支（model / api_key 为空 = 不写入）。
// 绝不 spawn ocr，从而不会覆盖用户已有的 key。data.skipped = true 供前端识别。
fn skipped_result() -> OcrResult {
    OcrResult {
        ok: true,
        exit_code: 0,
        stdout: String::new(),
        stderr: String::new(),
        data: Some(serde_json::json!({ "skipped": true })),
    }
}

// `config set provider <name>`：切换当前生效的 provider。
pub fn set_provider(provider: &str) -> Result<OcrResult, String> {
    run_ocr(&["config", "set", "provider", provider])
}

// `config set providers.<provider>.api_key <key>`：写入某内置 provider 的 key。
// 实测键路径（隔离 HOME）：真实 config.json 里 key 落在 providers.<name>.api_key。
// 空串 key = 「未输入」，跳过、不覆盖已存在的 key（Task 4 reviewer 明确）。
pub fn set_provider_key(provider: &str, key: &str) -> Result<OcrResult, String> {
    if key.is_empty() {
        return Ok(skipped_result());
    }
    let path = format!("providers.{provider}.api_key");
    run_ocr(&["config", "set", &path, key])
}

// 写入自定义网关：`custom_providers.<name>.{url,protocol}`（实测落盘位置）。
// 任一字段失败即返回该失败结果，并把字段名标注进 stderr 便于 UI 定位（审查焦点 #2）。
// 两条命令的 stdout/stderr 合并，便于调用方/测试一次看到全部下发内容。
pub fn set_custom_provider(name: &str, url: &str, protocol: &str) -> Result<OcrResult, String> {
    let fields = [
        (format!("custom_providers.{name}.url"), url),
        (format!("custom_providers.{name}.protocol"), protocol),
    ];
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for (path, value) in fields {
        let r = run_ocr(&["config", "set", &path, value])?;
        stdout.push_str(&r.stdout);
        if !r.ok {
            stderr.push_str(&format!("{path}: {}\n", r.stderr.trim()));
            return Ok(OcrResult {
                ok: false,
                exit_code: r.exit_code,
                stdout,
                stderr,
                data: None,
            });
        }
        exit_code = r.exit_code;
    }
    Ok(OcrResult {
        ok: true,
        exit_code,
        stdout,
        stderr,
        data: None,
    })
}

// `config set model <model>`：设置当前生效的 model。
// 实测：设过 provider 后，该命令会写进 providers.<name>.model 或 custom_providers.<name>.model。
// 空串 = 「不写入」，跳过（不触发 ocr）。
pub fn set_model(model: &str) -> Result<OcrResult, String> {
    if model.is_empty() {
        return Ok(skipped_result());
    }
    run_ocr(&["config", "set", "model", model])
}

// `llm test`：向当前配置的 LLM 发一条测试对话。
// success 判定：退出码 0 且输出不含 error 关键词（成功时 stdout 含
// `✓ Connection test successful`；失败时退出非 0、stderr 含 `Error:`）。
// data = { success: bool, message: String }。
pub fn test_connection() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["llm", "test"])?;
    let mut lower = r.stdout.to_lowercase();
    lower.push_str(&r.stderr.to_lowercase());
    let success = r.ok && !lower.contains("error");
    let message = if success {
        r.stdout
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("")
            .to_string()
    } else {
        let err = r.stderr.trim();
        if err.is_empty() {
            r.stdout.trim().to_string()
        } else {
            err.to_string()
        }
    };
    r.data = Some(serde_json::json!({ "success": success, "message": message }));
    Ok(r)
}

// 解析 `ocr llm providers` 的表格：跳过标题/表头/分隔行与尾部图例行，按列取
// name / protocol / baseUrl。判定「数据行」的规则：首列是合法 provider 名
// （全小写字母/数字/连字符且含至少一个字母数字），于是 `NAME`/`----`/`Use ...`/
// `Built-in providers:` 这些行自然被排除。缺列（如 bedrock 无 Base URL）归一为空串。
pub fn parse_providers_table(stdout: &str) -> Vec<serde_json::Value> {
    let mut rows = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut cols = trimmed.split_whitespace();
        let Some(name) = cols.next() else { continue };
        let is_provider_name = name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && name.chars().any(|c| c.is_ascii_alphanumeric());
        if !is_provider_name {
            continue;
        }
        let protocol = cols.next().unwrap_or("");
        let base_url = cols.next().unwrap_or("");
        rows.push(serde_json::json!({
            "name": name,
            "protocol": protocol,
            "baseUrl": base_url,
        }));
    }
    rows
}

// `list_providers`：跑 `ocr llm providers`，成功时把解析后的表格放进 data（数组）。
pub fn list_providers() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["llm", "providers"])?;
    if r.ok {
        r.data = Some(serde_json::Value::Array(parse_providers_table(&r.stdout)));
    }
    Ok(r)
}

// 从指定路径读配置 JSON。
// - 文件不存在 → 空对象 `{}`（spec §4.3 同类「缺失即空」处理）
// - 内容非法 → `Err`，消息含 `invalid json`（供 UI 提示，不 panic）
pub fn read_config_json_at(path: &Path) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            if text.trim().is_empty() {
                return Ok(serde_json::json!({}));
            }
            serde_json::from_str(&text)
                .map_err(|e| format!("invalid json in {}: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("无法读取 {}: {e}", path.display())),
    }
}

// 读真实 `~/.opencodereview/config.json`（路径由 config_path 解析）。
pub fn read_config_json() -> Result<serde_json::Value, String> {
    read_config_json_at(&config_path())
}

// `get_config` command 的实现体（与 Tauri 解耦，便于无 feature 集成测试直接调用）。
// 成功：ok=true，data = 解析后的配置对象；失败：ok=false，stderr 携带原因（含 `invalid json`）。
pub fn get_config_result_at(path: &Path) -> OcrResult {
    match read_config_json_at(path) {
        Ok(data) => OcrResult {
            ok: true,
            exit_code: 0,
            stdout: String::new(),
            stderr: String::new(),
            data: Some(data),
        },
        Err(msg) => OcrResult {
            ok: false,
            exit_code: 1,
            stdout: String::new(),
            stderr: msg,
            data: None,
        },
    }
}

pub fn get_config_result() -> OcrResult {
    get_config_result_at(&config_path())
}
