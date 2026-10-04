import { useEffect, useState } from "react";
import { BUILTIN_PROVIDERS, CUSTOM_PROTOCOLS, type ProviderConfig } from "../types";
import {
  invokeSetCustomProvider,
  invokeSetModel,
  invokeSetParam,
  invokeSetProvider,
  invokeSetProviderKey,
  invokeTestConnection,
  translateError,
} from "../ipc";

// 与 Params Tab 一致的校验：max_tokens 必须正整数；effort 限三档。
const MAX_TOKENS_RE = /^\d+$/;
const EFFORT_LEVELS = ["low", "medium", "high"] as const;
import type { ToastApi } from "./Toast";

// 表单本地值。provider 为当前选中的 provider 名（"custom" 表示自定义网关分支）。
export type ProviderFormValues = {
  provider: string;
  apiKey: string;
  model: string;
  gateway: string;
  url: string;
  protocol: string;
  maxTokens: string;
  effort: string;
};

export type ProviderFormProps = {
  // 初始 / 受控选中的 provider（"anthropic" 等内置名，或 "custom"）。
  provider?: string;
  // 从 get_config 读到的配置，用作表单初值。**异步到达**时表单应随之重新填充。
  config?: ProviderConfig;
  // 内置 provider 名列表（来自 list_providers）。缺省时回退静态 BUILTIN_PROVIDERS。
  providers?: string[];
  // 内部字段变化回调。
  onChange?: (values: ProviderFormValues) => void;
  // 全局 Toast 上报接口（保存/测试结果）。缺省时静默，便于单测直接渲染本组件。
  toast?: ToastApi;
};

// 判定某 provider 是否为自定义网关分支（"custom" 或出现在 customProviders 中的名称）。
function isCustom(provider: string, config?: ProviderConfig): boolean {
  if (provider === "custom") return true;
  return !!config?.customProviders && provider in config.customProviders;
}

// 由 props/config 计算一组表单初值。config 未就绪（undefined）时给出可用的空占位，
// config 到达后调用方会再次调用本函数重填（解决异步填充，Critical-1）。
function buildValues(providerProp: string | undefined, config?: ProviderConfig): ProviderFormValues {
  const provider = providerProp ?? config?.provider ?? "anthropic";
  const custom = isCustom(provider, config);
  const customEntry = config?.customProviders?.[provider];
  const providerEntry = config?.providers?.[provider];
  // model 兜底顺序与 config.json 真实 schema 一致：
  // providers[name].model → custom_providers[name].model → 顶层 config.model。
  const model = providerEntry?.model ?? customEntry?.model ?? config?.model ?? "";

  return {
    provider,
    // api_key 明文永不回读（spec §7），初值恒为空串占位。
    apiKey: "",
    model,
    // custom 分支：gateway = 网关名，url/protocol 取该网关条目。
    gateway: custom && provider !== "custom" ? provider : "",
    url: customEntry?.url ?? "",
    protocol: customEntry?.protocol ?? CUSTOM_PROTOCOLS[0],
    maxTokens: config?.maxTokens !== undefined ? String(config.maxTokens) : "",
    effort: config?.effort ?? "",
  };
}

// 由当前值计算「实际要写入的 provider 名」：内置直接用名字；自定义分支用 gateway 名。
function effectiveProvider(values: ProviderFormValues, custom: boolean): string {
  if (!custom) return values.provider;
  return values.provider === "custom" ? values.gateway.trim() : values.provider;
}

// 自定义网关名校验（I4）：实测含 `.` 等字符会让 `ocr config set` 失败（键路径被拆坏），
// 故前置限制为 `^[a-z0-9][a-z0-9-]*$`（小写字母/数字开头，后接小写字母/数字/连字符）。
export const GATEWAY_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// 校验自定义网关名；返回中文错误提示，合法则返回 undefined。
export function validateGatewayName(name: string): string | undefined {
  if (name.length === 0) return "请填写自定义网关名称";
  if (!GATEWAY_NAME_RE.test(name)) {
    return "网关名称只能包含小写字母、数字和连字符（-），且需以字母或数字开头";
  }
  return undefined;
}

// 下拉候选：list_providers 结果（或静态兜底）+ 配置里已有的自定义网关 + 当前值去重。
function optionsFor(providers: string[] | undefined, config: ProviderConfig | undefined, current: string): string[] {
  const base = providers && providers.length > 0 ? providers : [...BUILTIN_PROVIDERS];
  const set = new Set<string>(base);
  for (const name of Object.keys(config?.customProviders ?? {})) set.add(name);
  if (current && current !== "custom") set.add(current);
  return [...set];
}

export default function ProviderForm({ provider, config, providers, onChange, toast }: ProviderFormProps) {
  const [values, setValues] = useState<ProviderFormValues>(() => buildValues(provider, config));
  const [testing, setTesting] = useState(false);

  // 当 provider prop 变化，或 config 异步到达/更新时，用新值重填表单。
  // 这是关键：ProviderTab 首次渲染时 config 为 undefined，useEffect 异步拿到后
  // setConfig 会改变 config 引用，此处据此重置，避免「表单永不填充」。
  useEffect(() => {
    setValues(buildValues(provider, config));
  }, [provider, config]);

  const custom = isCustom(values.provider, config);

  const update = (patch: Partial<ProviderFormValues>) => {
    setValues((v) => {
      const next = { ...v, ...patch };
      onChange?.(next);
      return next;
    });
  };

  // 保存：按表单状态逐条下发 `ocr config set`。顺序 = provider → (key / 自定义网关字段) → model。
  // 任一失败即中止并通过全局 Toast 给出「字段名 + 中文说明」的提示（审查焦点 #2）。
  const handleSave = async () => {
    const name = effectiveProvider(values, custom);

    // I4：自定义网关名前置校验（含 `.`/大写/空格等会让 ocr 命令失败），不合法则直接提示、不调用保存。
    if (custom) {
      const gatewayError = validateGatewayName(name);
      if (gatewayError) {
        toast?.error(`保存失败：Gateway 名称（${gatewayError}）`);
        return;
      }
    }

    // 逐条保存；某条失败时抛出带「字段名」的错误，由下方统一转成中文提示。
    const step = async (
      field: string,
      run: () => Promise<{ ok: boolean; stderr: string; stdout: string }>
    ) => {
      const res = await run();
      if (!res.ok) {
        // 把后端 stderr 关键词翻译成中文（如 `unsupported key` → 「该参数不可持久化」）。
        const detail = translateError(res.stderr || res.stdout);
        throw new Error(`${field}｜${detail}`);
      }
    };

    try {
      await step("Provider 名称", () => invokeSetProvider(name));
      if (custom) {
        await step("路由 URL / Protocol", () =>
          invokeSetCustomProvider(name, values.url, values.protocol)
        );
      }
      // api_key 空串 = 「未输入」，不写入（不覆盖已有 key，Task 4 reviewer 语义）。
      if (values.apiKey.length > 0) {
        await step("API Key", () => invokeSetProviderKey(name, values.apiKey));
      }
      // model 空串 = 不写入。
      if (values.model.length > 0) {
        await step("Model", () => invokeSetModel(values.model));
      }
      // Max Tokens / Effort 与 Params Tab 写同一 config 键；此处有值则一并持久化，
      // 避免「表单里能编辑却不生效却提示已保存」的静默丢失。
      if (values.maxTokens.length > 0) {
        if (!MAX_TOKENS_RE.test(values.maxTokens)) {
          throw new Error("Max Tokens｜必须为正整数");
        }
        await step("Max Tokens", () => invokeSetParam("max_tokens", values.maxTokens));
      }
      if (values.effort.length > 0) {
        if (!EFFORT_LEVELS.includes(values.effort as (typeof EFFORT_LEVELS)[number])) {
          throw new Error("Effort｜必须为 low / medium / high");
        }
        await step("Effort", () => invokeSetParam("effort", values.effort));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const [field, detail] = msg.split("｜");
      toast?.error(detail ? `保存失败：${field} 写入出错（${detail}）` : `保存失败：${field}`);
      return;
    }

    toast?.success("已保存");
  };

  // 测试连接：调 `test_connection`，通过全局 Toast 展示成功/失败。
  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await invokeTestConnection();
      if (res.success) {
        toast?.success(`✓ 连接成功${res.message ? "：" + res.message : ""}`);
      } else {
        const detail = translateError(res.message || res.stderr || res.stdout);
        toast?.error(`✗ 连接失败：${detail}`);
      }
    } catch (e) {
      toast?.error(`✗ 连接失败：${String(e)}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <form
      className="provider-form"
      onSubmit={(e) => {
        e.preventDefault();
        void handleSave();
      }}
    >
      <label htmlFor="provider-select">Provider</label>
      <select
        id="provider-select"
        value={values.provider}
        onChange={(e) => {
          // 切换 provider 时按新 provider 重置预填值（模型/自定义网关字段随之更新）。
          const next = buildValues(e.target.value, config);
          onChange?.(next);
          setValues(next);
        }}
      >
        {optionsFor(providers, config, values.provider).map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
        <option value="custom">Custom</option>
      </select>

      {custom ? (
        <>
          <label htmlFor="custom-gateway">Gateway 名称</label>
          <input
            id="custom-gateway"
            name="custom-gateway"
            value={values.gateway}
            onChange={(e) => update({ gateway: e.target.value })}
          />
          <label htmlFor="custom-url">URL</label>
          <input
            id="custom-url"
            name="custom-url"
            value={values.url}
            onChange={(e) => update({ url: e.target.value })}
          />
          <label htmlFor="custom-protocol">Protocol</label>
          <select
            id="custom-protocol"
            name="custom-protocol"
            value={values.protocol}
            onChange={(e) => update({ protocol: e.target.value })}
          >
            {CUSTOM_PROTOCOLS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label htmlFor="custom-api-key">API Key</label>
          <input
            id="custom-api-key"
            name="custom-api-key"
            type="password"
            value={values.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
          />
        </>
      ) : (
        <>
          <label htmlFor="builtin-api-key">API Key</label>
          <input
            id="builtin-api-key"
            name="builtin-api-key"
            type="password"
            value={values.apiKey}
            onChange={(e) => update({ apiKey: e.target.value })}
          />
        </>
      )}

      <label htmlFor="provider-model">Model</label>
      <input
        id="provider-model"
        name="provider-model"
        value={values.model}
        onChange={(e) => update({ model: e.target.value })}
      />

      <label htmlFor="provider-max-tokens">Max Tokens</label>
      <input
        id="provider-max-tokens"
        name="provider-max-tokens"
        value={values.maxTokens}
        onChange={(e) => update({ maxTokens: e.target.value })}
      />

      <label htmlFor="provider-effort">Effort</label>
      <select
        id="provider-effort"
        name="provider-effort"
        value={values.effort}
        onChange={(e) => update({ effort: e.target.value })}
      >
        <option value="">（默认）</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
      </select>

      <div className="provider-actions">
        <button type="submit">保存</button>
        <button type="button" onClick={() => void handleTest()} disabled={testing}>
          {testing ? "测试中…" : "测试连接"}
        </button>
      </div>
    </form>
  );
}
