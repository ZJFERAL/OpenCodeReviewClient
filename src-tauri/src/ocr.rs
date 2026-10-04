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
