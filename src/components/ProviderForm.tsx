import { useEffect, useState } from "react";
import { BUILTIN_PROVIDERS, CUSTOM_PROTOCOLS, type ProviderConfig } from "../types";

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
  // 内部字段变化回调（本任务仅展示，Task 5 用于保存）。
  onChange?: (values: ProviderFormValues) => void;
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

export default function ProviderForm({ provider, config, onChange }: ProviderFormProps) {
  const [values, setValues] = useState<ProviderFormValues>(() => buildValues(provider, config));

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

  return (
    <form className="provider-form" onSubmit={(e) => e.preventDefault()}>
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
        {BUILTIN_PROVIDERS.map((p) => (
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
    </form>
  );
}
