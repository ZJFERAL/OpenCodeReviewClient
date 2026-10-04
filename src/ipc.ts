import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig } from "./types";

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

// 探测 ocr 是否安装并取版本号，对应 Rust 的 `probe_ocr` command。
// 成功时 data = { version: string }，缺失时 ok=false 且 data 为 undefined。
export async function invokeProbe(): Promise<OcrResult> {
  return invoke<OcrResult>("probe_ocr");
}

// 从后端 `data`（原始 config.json 对象，snake_case 键）中安全提取规范化配置。
// 绝不回读明文 key 到 UI：api_key 只记录「是否存在」，不保留其值。
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function normalizeConfig(data: unknown): ProviderConfig {
  const out: ProviderConfig = {};
  if (!data || typeof data !== "object") return out;
  const raw = data as Record<string, unknown>;

  out.provider = str(raw.provider);
  out.model = str(raw.model);
  out.maxTokens = num(raw.max_tokens);
  const effort = str(raw.effort);
  if (effort === "low" || effort === "medium" || effort === "high") {
    out.effort = effort;
  }

  const providers = raw.providers;
  if (providers && typeof providers === "object") {
    const entries: Record<string, { apiKey?: string }> = {};
    for (const [name, cfg] of Object.entries(providers as Record<string, unknown>)) {
      const apiKey =
        cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>).api_key : undefined;
      // 只记录 api_key 是否存在；明文值一律不进入 UI 状态（掩码纪律，spec §7）。
      entries[name] = { apiKey: typeof apiKey === "string" && apiKey.length > 0 ? "" : undefined };
    }
    out.providers = entries;
  }

  const custom = raw.custom_providers;
  if (custom && typeof custom === "object") {
    const entries: Record<string, { url?: string; protocol?: string }> = {};
    for (const [name, cfg] of Object.entries(custom as Record<string, unknown>)) {
      const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
      entries[name] = { url: str(c.url), protocol: str(c.protocol) };
    }
    out.customProviders = entries;
  }

  return out;
}

// 读取后端配置，对应 Rust 的 `get_config` command。
// 成功时 data 为规范化的 ProviderConfig；失败（invalid json 等）时 ok=false。
export async function invokeGetConfig(): Promise<OcrResult & { config?: ProviderConfig }> {
  const res = await invoke<OcrResult>("get_config");
  if (res.ok) {
    return { ...res, config: normalizeConfig(res.data) };
  }
  return res;
}
