import { useEffect, useState } from "react";
import StatusBar from "./components/StatusBar";
import ProviderTab from "./tabs/ProviderTab";
import RulesTab from "./tabs/RulesTab";
import ParamsTab from "./tabs/ParamsTab";
import { invokeProbe } from "./ipc";

const TABS = [
  { key: "provider", label: "Provider", Component: ProviderTab },
  { key: "rules", label: "Rules", Component: RulesTab },
  { key: "params", label: "Params", Component: ParamsTab },
] as const;

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
        <ActiveComponent />
      </main>
    </div>
  );
}
