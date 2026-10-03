import { useEffect, useState } from "react";
import StatusBar from "./components/StatusBar";
import { invokeOcr } from "./ipc";

type ProviderTabProps = Record<string, never>;
type RulesTabProps = Record<string, never>;
type ParamsTabProps = Record<string, never>;

function ProviderTab(_props: ProviderTabProps) {
  return (
    <section className="tab-panel">
      <h2>Provider</h2>
      <p className="placeholder">Provider 配置（待实现）。</p>
    </section>
  );
}

function RulesTab(_props: RulesTabProps) {
  return (
    <section className="tab-panel">
      <h2>Rules</h2>
      <p className="placeholder">Rules 配置（待实现）。</p>
    </section>
  );
}

function ParamsTab(_props: ParamsTabProps) {
  return (
    <section className="tab-panel">
      <h2>Params</h2>
      <p className="placeholder">Params 配置（待实现）。</p>
    </section>
  );
}

const TABS = [
  { key: "provider", label: "Provider", Component: ProviderTab },
  { key: "rules", label: "Rules", Component: RulesTab },
  { key: "params", label: "Params", Component: ParamsTab },
] as const;

export default function App() {
  const [active, setActive] = useState<(typeof TABS)[number]["key"]>("provider");
  const [ocrInstalled, setOcrInstalled] = useState<boolean>(false);
  const [version, setVersion] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    invokeOcr("ocr", ["--version"])
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setOcrInstalled(true);
          setVersion(res.stdout.trim().split("\n")[0] || undefined);
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
