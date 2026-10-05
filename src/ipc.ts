import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig, RulesFile, RulesScope } from "./types";

// 贯穿所有后续任务的核心结果类型。
export type OcrResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  data?: unknown;
};

// 后端 stderr / 输出关键词 → 中文提示（spec §7「命令失败解析」）。
// 命中已知关键词时返回单句中文提示（不含原始 stderr，避免把 CLI 内部细节暴露给用户）；
// 未知关键词回退为原始文本（压缩空白 + 截断），保证信息不丢失。
// 顺序即优先级：首个命中的模式生效。
const ERROR_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  // Windows cmd 缺失命令报 `is not recognized`，POSIX shell 报 `command not found`，
  // 中文 Windows cmd 报 `'ocr' 不是内部或外部命令，也不是可运行的程序`，三者同义。
  [
    /command not found|is not recognized as an internal or external command|不是内部或外部命令/i,
    "未检测到 ocr",
  ],
  // 兜底：中文 Windows 的 cmd 报错是 GBK 字节，后端 `from_utf8_lossy` 解码后变成
  // `'ocr' ` + 一连串 U+FFFD 替换字符（既无英文关键词也无正确中文，上面的模式会漏命中）。
  // 以「被引号括起的命令名 'ocr' 后紧跟替换字符」为信号，不受本机代码页影响；
  // 用 U+FFFD（而非任意非 ASCII）作判据，避免误伤真正能运行的中文错误输出。
  [/'ocr'[^\r\n]*\uFFFD/, "未检测到 ocr"],
  [/connection error/i, "LLM 连接失败"],
  [/unknown flag/i, "不支持的参数"],
  // 真实 CLI 对白名单外的 config 键报 `Error: unknown config key: <key>`（隔离 HOME 实测），
  // 与本项目后端自造的 `unsupported key` 同义，二者都要映射。
  [/unknown config key|unsupported key/i, "该参数不可持久化"],
  [/unsupported value/i, "参数值不合法"],
  [/invalid json/i, "JSON 文件损坏（内容不是合法 JSON）"],
  [/not a git repository/i, "该目录不是 git 仓库"],
  [/半完成/, "保存可能只完成了一半，请重试"],
];

// 回退文案的最大长度（超出以 … 收尾），避免超长 stderr 撑爆 Toast。
const ERROR_FALLBACK_MAX = 200;

// 把后端 stderr 映射为面向用户的中文提示。
// - 命中已知关键词 → 单句中文提示；
// - 空输入 → 「未知错误」；
// - 其它 → 压缩空白的原始文本（截断到 ERROR_FALLBACK_MAX）。
export function translateError(stderr: string): string {
  const text = (stderr ?? "").trim();
  if (text.length === 0) return "未知错误";
  for (const [re, hint] of ERROR_HINTS) {
    if (re.test(text)) return hint;
  }
  const compact = text.replace(/\s+/g, " ");
  return compact.length > ERROR_FALLBACK_MAX
    ? compact.slice(0, ERROR_FALLBACK_MAX) + "…"
    : compact;
}

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

// Params Tab：持久化审查参数（仅 max_tokens / effort，spec §4.2 / §8.2）。
// 后端白名单外的键返回 ok=false 且 stderr 含 `unsupported key`。
// value 为空串时后端跳过（不覆盖已有值）。
export async function invokeSetParam(key: string, value: string): Promise<OcrResult> {
  return invoke<OcrResult>("set_param", { key, value });
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

// ---- Rules Tab（spec §4.3：直接读写 rule.json）----

// 把后端 `get_rules` 的 data 归一为 RulesFile。
// 后端已把真实落盘键名（snake_case `merge_system_rule`）映射为 camelCase
// `mergeSystemRule`；这里再防御一次：接受两种键名，缺失归一为 bool false、
// path/rule 非字符串归一为空串，保证类型安全（数据来自用户手改的文件）。
export function normalizeRules(data: unknown): RulesFile {
  const out: RulesFile = { rules: [] };
  if (!data || typeof data !== "object") return out;
  const raw = (data as Record<string, unknown>).rules;
  if (!Array.isArray(raw)) return out;
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const it = item as Record<string, unknown>;
    const mergeRaw = it.mergeSystemRule ?? it.merge_system_rule;
    out.rules.push({
      path: typeof it.path === "string" ? it.path : "",
      rule: typeof it.rule === "string" ? it.rule : "",
      mergeSystemRule: typeof mergeRaw === "boolean" ? mergeRaw : false,
    });
  }
  return out;
}

// 读取规则文件，对应 Rust 的 `get_rules` command。
// repo 作用范围需传 repoPath；文件缺失返回空规则集（ok=true），损坏 JSON 时 ok=false。
export async function invokeGetRules(
  scope: RulesScope,
  repoPath?: string
): Promise<OcrResult & { rulesFile?: RulesFile }> {
  const res = await invoke<OcrResult>("get_rules", { scope, repoPath: repoPath ?? null });
  if (res.ok) {
    return { ...res, rulesFile: normalizeRules(res.data) };
  }
  return res;
}

// 写入规则文件，对应 Rust 的 `set_rules` command。
// 写前由后端逐条校验（path/rule 非空、mergeSystemRule 为 bool），失败 stderr 含行号。
export async function invokeSetRules(
  scope: RulesScope,
  repoPath: string | undefined,
  rulesFile: RulesFile
): Promise<OcrResult> {
  return invoke<OcrResult>("set_rules", { scope, repoPath: repoPath ?? null, rules: rulesFile });
}

// 验证某文件命中的规则，对应 Rust 的 `check_rules` command（`ocr rules check <file>`）。
// 成功时 data 为命中规则文本。
// repoPath 语义（I2）：省略 = 由后端从 file 向上回溯 git root 作为 `--repo`
//（global 作用范围）；传入则直接用（仓库级作用范围选定的目录）。CLI 无 `--repo` 时
// 以 cwd 定位仓库，而 GUI 进程 cwd 常非 git 仓库，故不在前端省略为「让 CLI 自己找」。
export async function invokeCheckRules(
  file: string,
  repoPath?: string
): Promise<OcrResult & { matched?: string }> {
  const res = await invoke<OcrResult>("check_rules", { file, repo: repoPath ?? null });
  return { ...res, matched: typeof res.data === "string" ? res.data : undefined };
}
