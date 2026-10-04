import { useEffect, useState } from "react";
import { invokeGetConfig, invokeSetParam } from "../ipc";
import { EFFORT_LEVELS, REVIEW_FORMATS } from "../types";

// Params Tab（spec §4.2 / §5.4）：
// - 可持久化项：max_tokens（数字）、effort（low/medium/high 下拉）→ 经 set_param 写 config.json；
// - 不可持久化项：timeout / concurrency / format / exclude 是 `ocr review` 的运行时 flag，
//   仅拼成只读、可复制的命令预览，**不写入、不执行**（spec §8.2）。

// 命令预览的输入值（均为字符串，空串表示该项不生成 flag）。
export type ReviewPreviewValues = {
  timeout: string;
  concurrency: string;
  format: string;
  exclude: string;
};

// 把不可持久化的 review 运行时 flag 拼成 `ocr review --timeout 15 ...` 预览串。
// 空值跳过对应 flag；exclude 值恒加双引号包裹（含逗号/通配符，复制即用）。
export function buildReviewPreview(values: ReviewPreviewValues): string {
  const parts = ["ocr review"];
  const timeout = values.timeout.trim();
  if (timeout) parts.push(`--timeout ${timeout}`);
  const concurrency = values.concurrency.trim();
  if (concurrency) parts.push(`--concurrency ${concurrency}`);
  const format = values.format.trim();
  if (format) parts.push(`--format ${format}`);
  const exclude = values.exclude.trim();
  if (exclude) parts.push(`--exclude "${exclude}"`);
  return parts.join(" ");
}

type Status = { kind: "idle" | "ok" | "error"; text: string };

export default function ParamsTab() {
  // 可持久化项（max_tokens / effort）。
  const [maxTokens, setMaxTokens] = useState("");
  const [effort, setEffort] = useState("");
  // 不可持久化项（仅命令预览）。
  const [timeout, setTimeoutSec] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [format, setFormat] = useState("text");
  const [exclude, setExclude] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });

  // 从 get_config 预填可持久化项（异步到达后重填，与 ProviderForm 同一模式）。
  useEffect(() => {
    let cancelled = false;
    invokeGetConfig()
      .then((res) => {
        if (cancelled || !res.ok) return;
        const cfg = res.config;
        if (cfg?.maxTokens !== undefined) setMaxTokens(String(cfg.maxTokens));
        if (cfg?.effort) setEffort(cfg.effort);
      })
      .catch(() => {
        // 读取失败时保持空表单，不影响保存。
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = buildReviewPreview({ timeout, concurrency, format, exclude });

  // 保存：仅下发可持久化项；空值跳过（不覆盖已有值）。
  const handleSave = async () => {
    setStatus({ kind: "idle", text: "" });
    const steps: Array<{ field: string; key: string; value: string }> = [];
    if (maxTokens.trim().length > 0) {
      steps.push({ field: "Max Tokens", key: "max_tokens", value: maxTokens.trim() });
    }
    if (effort.trim().length > 0) {
      steps.push({ field: "Effort", key: "effort", value: effort.trim() });
    }
    if (steps.length === 0) {
      setStatus({ kind: "ok", text: "没有需要保存的参数" });
      return;
    }
    for (const step of steps) {
      try {
        const res = await invokeSetParam(step.key, step.value);
        if (!res.ok) {
          const detail = (res.stderr || res.stdout).trim().replace(/\s+/g, " ");
          setStatus({ kind: "error", text: `保存失败：${step.field}（${detail}）` });
          return;
        }
      } catch (e) {
        setStatus({ kind: "error", text: `保存失败：${step.field}（${String(e)}）` });
        return;
      }
    }
    setStatus({ kind: "ok", text: "已保存参数" });
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(preview);
      setStatus({ kind: "ok", text: "命令已复制" });
    } catch {
      setStatus({ kind: "error", text: "复制失败，请手动选中复制" });
    }
  };

  return (
    <section className="tab-panel">
      <h2>Params</h2>

      <div className="params-form">
        <h3>可持久化参数（写入 config.json）</h3>
        <label htmlFor="params-max-tokens">Max Tokens</label>
        <input
          id="params-max-tokens"
          name="params-max-tokens"
          inputMode="numeric"
          value={maxTokens}
          onChange={(e) => setMaxTokens(e.target.value)}
        />
        <label htmlFor="params-effort">Effort</label>
        <select
          id="params-effort"
          name="params-effort"
          value={effort}
          onChange={(e) => setEffort(e.target.value)}
        >
          <option value="">（默认）</option>
          {EFFORT_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>

        <h3>不可持久化项（仅命令预览，不写入）</h3>
        <label htmlFor="params-timeout">Timeout (秒)</label>
        <input
          id="params-timeout"
          name="params-timeout"
          inputMode="numeric"
          value={timeout}
          onChange={(e) => setTimeoutSec(e.target.value)}
        />
        <label htmlFor="params-concurrency">Concurrency</label>
        <input
          id="params-concurrency"
          name="params-concurrency"
          inputMode="numeric"
          value={concurrency}
          onChange={(e) => setConcurrency(e.target.value)}
        />
        <label htmlFor="params-format">Format</label>
        <select
          id="params-format"
          name="params-format"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
        >
          {REVIEW_FORMATS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <label htmlFor="params-exclude">Exclude</label>
        <input
          id="params-exclude"
          name="params-exclude"
          value={exclude}
          onChange={(e) => setExclude(e.target.value)}
          placeholder="**/generated/*,**/testdata/*"
        />

        <div className="provider-actions">
          <button type="button" onClick={() => void handleSave()}>
            保存参数
          </button>
        </div>
      </div>

      <div className="params-preview">
        <h3>命令片段预览（复制即用）</h3>
        <textarea
          className="command-preview"
          data-testid="command-preview"
          readOnly
          rows={3}
          value={preview}
        />
        <div className="provider-actions">
          <button type="button" onClick={() => void handleCopy()}>
            复制命令
          </button>
        </div>
      </div>

      {status.kind !== "idle" && (
        <p className={status.kind === "ok" ? "status-ok" : "error"}>{status.text}</p>
      )}
    </section>
  );
}
