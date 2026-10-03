import { invoke } from "@tauri-apps/api/core";

// 贯穿所有后续任务的核心结果类型。
export type OcrResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  data?: unknown;
};

// 统一封装 Tauri `invoke`，所有前端调用复用这一个入口。
// cmd 为预留参数（Rust 桩固定调用 `ocr`，见 src-tauri/src/ocr.rs），
// args 为传给 ocr 的命令行参数列表。
export async function invokeOcr(cmd: string, args: string[] = []): Promise<OcrResult> {
  void cmd;
  return invoke<OcrResult>("run_ocr", { args });
}
