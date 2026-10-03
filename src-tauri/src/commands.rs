// 前端 invoke("run_ocr", { args }) 的入口 command。
// 后续所有业务 command 都复用 ocr::run_ocr，本任务先留作桩。
#[tauri::command]
pub fn run_ocr(args: Vec<String>) -> Result<crate::ocr::OcrResult, String> {
    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    crate::ocr::run_ocr(&refs)
}
