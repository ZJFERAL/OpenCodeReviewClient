import { useEffect, useState } from "react";
import ProviderForm from "../components/ProviderForm";
import { invokeGetConfig } from "../ipc";
import type { ProviderConfig } from "../types";

// Provider Tab：加载 get_config，把读到的配置作为 ProviderForm 初值（本任务只读展示，保存留 Task 5）。
export default function ProviderTab() {
  const [config, setConfig] = useState<ProviderConfig | undefined>(undefined);
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
        <ProviderForm config={config} />
      )}
    </section>
  );
}
