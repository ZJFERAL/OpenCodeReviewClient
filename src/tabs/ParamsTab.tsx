import { useEffect, useState } from "react";
import type { ToastApi } from "../components/Toast";
import { invokeGetConfig, invokeSetParam, translateError } from "../ipc";
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

// I2：「复制即用」契约——预览值里含 shell 特殊字符时无法保证粘贴后行为与显示一致。
// 覆盖范围与理由：
//   - `"` 会破坏 exclude 的引号包裹；
//   - `%` 在 cmd 中**即使位于双引号内**仍会展开 `%VAR%`（引号挡不住）；
//   - `& | < > ^` 在双引号内通常安全，但为稳妥一并提示；
//   - `\r`/`\n` 无法构成单行命令。
const PREVIEW_UNSAFE_RE = /["%&|<>^\r\n]/;

// 返回首个含特殊字符字段的中文说明；全部安全则 undefined。
// 与 buildReviewPreview 配合：调用方在返回非 undefined 时禁用「复制命令」。
export function previewValueProblem(values: ReviewPreviewValues): string | undefined {
  const fields: Array<[string, string]> = [
    ["Timeout", values.timeout],
    ["Concurrency", values.concurrency],
    ["Format", values.format],
    ["Exclude", values.exclude],
  ];
  for (const [label, raw] of fields) {
    if (raw.trim().length === 0) continue;
    if (PREVIEW_UNSAFE_RE.test(raw)) {
      return `「${label}」含特殊字符（" % & | < > ^ 或换行），无法保证复制即用，请修改后再复制`;
    }
  }
  return undefined;
}

// 把不可持久化的 review 运行时 flag 拼成 `ocr review --timeout 15 ...` 预览串。
// 空值跳过对应 flag；exclude 值恒加双引号包裹（含逗号/通配符，复制即用）。
// 值本身是否可安全复制由 previewValueProblem 判定（含特殊字符时调用方应禁用复制）。
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

// I1：max_tokens 前端校验——正整数（纯数字）。后端亦校验，两端防御。
// 拦截 `--help`/`-h` 这类会被 CLI 当 flag 静默吞掉（exit 0 但不落盘）的值。
export const MAX_TOKENS_RE = /^\d+$/;

export default function ParamsTab({ toast }: { toast?: ToastApi }) {
  // 可持久化项（max_tokens / effort）。
  const [maxTokens, setMaxTokens] = useState("");
  const [effort, setEffort] = useState("");
  // 不可持久化项（仅命令预览）。
  const [timeout, setTimeoutSec] = useState("");
  const [concurrency, setConcurrency] = useState("");
  const [format, setFormat] = useState("text");
  const [exclude, setExclude] = useState("");
  const [saving, setSaving] = useState(false);

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
  const previewProblem = previewValueProblem({ timeout, concurrency, format, exclude });

  // 保存：仅下发可持久化项；空值跳过（不覆盖已有值）。
  // I1：max_tokens 先做正整数校验（拒绝 `--help` 等会被 CLI 静默吞掉的值）。
  // Minor-1：部分成功时错误文案补「已写入：…」，避免用户误以为全部失败而重复保存。
  // Minor-2：await 期间置 saving，禁用保存按钮，避免连点并发。
  const handleSave = async () => {
    const steps: Array<{ field: string; key: string; value: string }> = [];
    const mt = maxTokens.trim();
    if (mt.length > 0) {
      if (!MAX_TOKENS_RE.test(mt)) {
        toast?.error("保存失败：Max Tokens 必须是正整数（仅数字，不能含 --help 等字符）");
        return;
      }
      steps.push({ field: "Max Tokens", key: "max_tokens", value: mt });
    }
    if (effort.trim().length > 0) {
      steps.push({ field: "Effort", key: "effort", value: effort.trim() });
    }
    if (steps.length === 0) {
      toast?.success("没有需要保存的参数");
      return;
    }

    const written: string[] = [];
    setSaving(true);
    try {
      for (const step of steps) {
        let res;
        try {
          res = await invokeSetParam(step.key, step.value);
        } catch (e) {
          const suffix = written.length > 0 ? `（已写入：${written.join("、")}）` : "";
          toast?.error(`保存失败：${step.field}（${String(e)}）${suffix}`);
          return;
        }
        if (!res.ok) {
          const detail = translateError(res.stderr || res.stdout);
          const suffix = written.length > 0 ? `（已写入：${written.join("、")}）` : "";
          toast?.error(`保存失败：${step.field}（${detail}）${suffix}`);
          return;
        }
        written.push(step.field);
      }
    } finally {
      setSaving(false);
    }
    toast?.success("已保存参数");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(preview);
      toast?.success("命令已复制");
    } catch {
      toast?.error("复制失败，请手动选中复制");
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
          <button type="button" onClick={() => void handleSave()} disabled={saving}>
            {saving ? "保存中…" : "保存参数"}
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
          <button type="button" onClick={() => void handleCopy()} disabled={previewProblem !== undefined}>
            复制命令
          </button>
        </div>
        {previewProblem && <p className="error">{previewProblem}</p>}
      </div>
    </section>
  );
}
