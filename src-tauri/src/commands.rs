// 前端 invoke("run_ocr", { args }) 的入口 command。
// 后续所有业务 command 都复用 ocr::run_ocr，本任务先留作桩。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn run_ocr(args: Vec<String>) -> Result<crate::ocr::OcrResult, String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    crate::ocr::run_ocr(&refs)
}

// 前端 invoke("probe_ocr") 的入口 command：探测 ocr 是否安装并解析其版本号。
// 复用 ocr::probe_ocr（内部调 `cmd /c ocr --version`），成功时 data = { version }。
#[cfg(feature = "tauri")]
#[tauri::command]
pub fn probe_ocr() -> Result<crate::ocr::OcrResult, String> {
    crate::ocr::probe_ocr()
}
