// 与后端 `get_config` 返回的 config.json 结构对应的类型。
// 注意：JSON 里的键名以真实文件为准（snake_case：api_key / custom_providers），
// 但前端惯用 camelCase，故 ProviderConfig 用 camelCase 字段，由 ipc 层的解析函数
// 从真实键名映射过来（见 src/ipc.ts 的 normalizeConfig）。
export type ProviderEntry = { apiKey?: string; model?: string };
export type CustomProviderEntry = { url?: string; protocol?: string; model?: string };

export type ProviderConfig = {
  provider?: string;
  model?: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  providers?: Record<string, ProviderEntry>;
  customProviders?: Record<string, CustomProviderEntry>;
};

// 内置 provider 参考集（spec §4.1 的 `ocr llm providers` 实测列表为 30+；
// 本任务的静态下拉先内置常用项 + Custom，完整列表留待 list_providers 任务）。
export const BUILTIN_PROVIDERS = [
  "anthropic",
  "openai",
  "bedrock",
  "deepseek",
  "kimi",
  "qwen",
] as const;

// 自定义网关的协议选项（映射 `custom_providers.<name>.protocol`）。
export const CUSTOM_PROTOCOLS = ["openai", "anthropic", "openai-responses"] as const;

export type CustomProtocol = (typeof CUSTOM_PROTOCOLS)[number];
