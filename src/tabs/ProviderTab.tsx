import { useEffect, useState } from "react";
import ProviderForm from "../components/ProviderForm";
import { invokeGetConfig, invokeListProviders } from "../ipc";
import type { ProviderConfig } from "../types";

// Provider Tab：并发加载 get_config 与 list_providers。
// - config 作为 ProviderForm 初值（异步到达后表单重填）；
// - providers（内置 provider 名）作为下拉候选数据源（替换静态 BUILTIN_PROVIDERS）。
// list_providers 失败不阻塞表单展示：回退到 ProviderForm 内部的静态兜底列表。
export default function ProviderTab() {
  const [config, setConfig] = useState<ProviderConfig | undefined>(undefined);
  const [providers, setProviders] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;

    invokeGetConfig()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setConfig(res.config);
        } else {
          setError(res.stderr || "读取配置失败");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });

    invokeListProviders()
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.providers && res.providers.length > 0) {
          setProviders(res.providers.map((p) => p.name));
        }
      })
      .catch(() => {
        // 列出失败时静默回退静态列表，不影响配置表单。
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="tab-panel">
      <h2>Provider</h2>
      {error ? (
        <p className="error">读取配置失败：{error}</p>
      ) : (
        <ProviderForm config={config} providers={providers} />
      )}
    </section>
  );
}
