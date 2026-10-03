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
