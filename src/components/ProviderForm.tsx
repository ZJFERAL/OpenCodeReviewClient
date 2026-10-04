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
};

export type ProviderFormProps = {
  // 初始 / 受控选中的 provider（"anthropic" 等内置名，或 "custom"）。
  provider?: string;
  // 从 get_config 读到的配置，用作表单初值。
  config?: ProviderConfig;
  // 内部字段变化回调（本任务仅展示，Task 5 用于保存）。
  onChange?: (values: ProviderFormValues) => void;
};

// 判定某 provider 是否为自定义网关分支（"custom" 或出现在 customProviders 中的名称）。
function isCustom(provider: string, config?: ProviderConfig): boolean {
  if (provider === "custom") return true;
  return !!config?.customProviders && provider in config.customProviders;
}

export default function ProviderForm({ provider, config, onChange }: ProviderFormProps) {
  const [values, setValues] = useState<ProviderFormValues>(() => ({
    provider: provider ?? config?.provider ?? "anthropic",
    // api_key 明文永不回读（spec §7），初值恒为空串占位。
    apiKey: "",
    model: config?.model ?? "",
    gateway: "",
    url: "",
    protocol: CUSTOM_PROTOCOLS[0],
  }));

  // 外部 provider prop 变化时同步选中项（使 <ProviderForm provider="custom"/> 切换生效）。
  useEffect(() => {
    if (provider === undefined) return;
    setValues((v) => (v.provider === provider ? v : { ...v, provider }));
  }, [provider]);

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
        onChange={(e) => update({ provider: e.target.value })}
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
    </form>
  );
}
