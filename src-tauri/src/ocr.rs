use serde::Serialize;

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
// 复用 `run_ocr(&["--version"])`，成功（exit 0）时把解析出的版本写入 `data: { version }`，
// 否则 `data` 留空。返回 `Result<OcrResult, String>`，与 `run_ocr` 一致，便于 command 层透传。
pub fn probe_ocr() -> Result<OcrResult, String> {
    let mut r = run_ocr(&["--version"])?;
    if r.ok {
        r.data = Some(serde_json::json!({ "version": parse_version(&r.stdout) }));
    }
    Ok(r)
}
