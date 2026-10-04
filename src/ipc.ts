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

// 解析真实 config.json 里「当前生效的 model」。
// 实测 schema（隔离 HOME 跑真实 ocr 得到）：
//   - 设了 provider 后：{provider:"openai", providers:{openai:{api_key,model:"gpt-5"}}}
//     → model 嵌在 providers.<name>.model，顶层没有 model。
//   - custom 网关：custom_providers.<name>.{url,protocol,model}。
//   - 顶层 model 仅在「从未设过 provider」时出现。
// 故兜底顺序：providers[provider].model → custom_providers[provider].model → 顶层 raw.model。
function resolveModel(raw: Record<string, unknown>, provider?: string): string | undefined {
  if (provider) {
    const p = raw.providers;
    if (p && typeof p === "object") {
      const entry = (p as Record<string, unknown>)[provider];
      const m = entry && typeof entry === "object" ? (entry as Record<string, unknown>).model : undefined;
      if (typeof m === "string" && m.length > 0) return m;
    }
    const c = raw.custom_providers;
    if (c && typeof c === "object") {
      const entry = (c as Record<string, unknown>)[provider];
      const m = entry && typeof entry === "object" ? (entry as Record<string, unknown>).model : undefined;
      if (typeof m === "string" && m.length > 0) return m;
    }
  }
  return str(raw.model);
}

export function normalizeConfig(data: unknown): ProviderConfig {
  const out: ProviderConfig = {};
  if (!data || typeof data !== "object") return out;
  const raw = data as Record<string, unknown>;

  out.provider = str(raw.provider);
  out.model = resolveModel(raw, out.provider);
  out.maxTokens = num(raw.max_tokens);
  const effort = str(raw.effort);
  if (effort === "low" || effort === "medium" || effort === "high") {
    out.effort = effort;
  }

  const providers = raw.providers;
  if (providers && typeof providers === "object") {
    const entries: Record<string, { apiKey?: string; model?: string }> = {};
    for (const [name, cfg] of Object.entries(providers as Record<string, unknown>)) {
      const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
      const apiKey = c.api_key;
      // apiKey 语义（Minor-2，供 Task 5 依据）：非空串 = 「当前已有 key，但明文不回读」；
      // 空串 "" = 「未输入/不写入」，**不代表用户主动清空**。Task 5 保存时须跳过空串，
      // 避免把「用户没填」误当作「清空已有 key」而下发 unset。
      entries[name] = {
        apiKey: typeof apiKey === "string" && apiKey.length > 0 ? "" : undefined,
        model: str(c.model),
      };
    }
    out.providers = entries;
  }

  const custom = raw.custom_providers;
  if (custom && typeof custom === "object") {
    const entries: Record<string, { url?: string; protocol?: string; model?: string }> = {};
    for (const [name, cfg] of Object.entries(custom as Record<string, unknown>)) {
      const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
      entries[name] = { url: str(c.url), protocol: str(c.protocol), model: str(c.model) };
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

// ---- Provider 保存（逐条 `ocr config set`，对应 Task 5 的 6 个 command）----

// 切换当前生效的 provider：`ocr config set provider <name>`。
export async function invokeSetProvider(provider: string): Promise<OcrResult> {
  return invoke<OcrResult>("set_provider", { provider });
}

// 写某内置 provider 的 api_key：落盘到 providers.<name>.api_key。
// key 为空串 = 「未输入」，后端会跳过、不覆盖已有 key。
export async function invokeSetProviderKey(provider: string, key: string): Promise<OcrResult> {
  return invoke<OcrResult>("set_provider_key", { provider, key });
}

// 写自定义网关：custom_providers.<name>.{url,protocol}。
export async function invokeSetCustomProvider(
  name: string,
  url: string,
  protocol: string
): Promise<OcrResult> {
  return invoke<OcrResult>("set_custom_provider", { name, url, protocol });
}

// 设置当前 model：`ocr config set model <model>`（实测写进 providers/custom_providers 的 model）。
// model 为空串时后端跳过。
export async function invokeSetModel(model: string): Promise<OcrResult> {
  return invoke<OcrResult>("set_model", { model });
}

// 连接测试：`ocr llm test`，data = { success, message }。
export async function invokeTestConnection(): Promise<
  OcrResult & { success?: boolean; message?: string }
> {
  const res = await invoke<OcrResult>("test_connection");
  const d = (res.data && typeof res.data === "object" ? res.data : {}) as Record<string, unknown>;
  return {
    ...res,
    success: typeof d.success === "boolean" ? d.success : undefined,
    message: typeof d.message === "string" ? d.message : undefined,
  };
}

// 内置 provider 列表：`ocr llm providers`，data 为 { name, protocol, baseUrl }[]。
export type ProviderInfo = { name: string; protocol: string; baseUrl: string };

export async function invokeListProviders(): Promise<OcrResult & { providers?: ProviderInfo[] }> {
  const res = await invoke<OcrResult>("list_providers");
  if (!res.ok) return res;
  const raw = Array.isArray(res.data) ? res.data : [];
  const providers: ProviderInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    if (typeof it.name !== "string" || it.name.length === 0) continue;
    providers.push({
      name: it.name,
      protocol: typeof it.protocol === "string" ? it.protocol : "",
      baseUrl: typeof it.baseUrl === "string" ? it.baseUrl : "",
    });
  }
  return { ...res, providers };
}
