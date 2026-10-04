import { useEffect, useState } from "react";
import StatusBar from "./components/StatusBar";
import { ToastContainer, useToast, type ToastApi } from "./components/Toast";
import ProviderTab from "./tabs/ProviderTab";
import RulesTab from "./tabs/RulesTab";
import ParamsTab from "./tabs/ParamsTab";
import { invokeProbe } from "./ipc";

const TABS: ReadonlyArray<{
  key: "provider" | "rules" | "params";
  label: string;
  Component: (props: { toast?: ToastApi }) => JSX.Element;
}> = [
  { key: "provider", label: "Provider", Component: ProviderTab },
  { key: "rules", label: "Rules", Component: RulesTab },
  { key: "params", label: "Params", Component: ParamsTab },
];

// 从 invokeProbe 返回的 data 字段安全取出版本号（data 形如 { version: string }）。
function dataVersion(data: unknown): string | undefined {
  if (data && typeof data === "object" && "version" in data) {
    const v = (data as { version: unknown }).version;
    return typeof v === "string" && v.length > 0 ? v : undefined;
  }
  return undefined;
}

export default function App() {
  const [active, setActive] = useState<(typeof TABS)[number]["key"]>("provider");
  const [ocrInstalled, setOcrInstalled] = useState<boolean>(false);
  const [version, setVersion] = useState<string | undefined>(undefined);
  // 全局 Toast：各 Tab 的保存/测试结果统一经此展示。
  const { toasts, toast, dismiss } = useToast();

  useEffect(() => {
    let cancelled = false;
    invokeProbe()
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setOcrInstalled(true);
          // 优先用后端解析出的 data.version；缺失时回退到 stdout 首行。
          const v = dataVersion(res.data) ?? (res.stdout.trim().split("\n")[0] || undefined);
          setVersion(v);
        } else {
          setOcrInstalled(false);
        }
      })
      .catch(() => {
        if (!cancelled) setOcrInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const ActiveComponent = TABS.find((t) => t.key === active)!.Component;

  return (
    <div className="app">
      <StatusBar ocrInstalled={ocrInstalled} version={version} />
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={"tab" + (t.key === active ? " tab-active" : "")}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="content">
        <ActiveComponent toast={toast} />
      </main>
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
