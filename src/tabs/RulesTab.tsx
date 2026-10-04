import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import RulesTable from "../components/RulesTable";
import { invokeCheckRules, invokeGetRules, invokeSetRules } from "../ipc";
import type { Rule, RulesFile, RulesScope } from "../types";

// Rules Tab（spec §5.3）：
// - 顶部作用范围切换：全局 ~/.opencodereview 或仓库级（Tauri dialog 选目录）
// - 规则表格：行内编辑 path / rule / merge 开关，增删
// - 「保存规则文件」→ set_rules（写前校验，失败定位到行）
// - 「验证命中」→ 选文件 → check_rules → 展示命中规则

type Status = { kind: "idle" | "ok" | "error"; text: string };

// 调 Tauri dialog 选目录；被取消或不可用（如浏览器预览）时返回 undefined。
async function pickDirectory(): Promise<string | undefined> {
  try {
    const sel = await open({ directory: true, multiple: false, title: "选择仓库目录" });
    return typeof sel === "string" ? sel : undefined;
  } catch {
    return undefined;
  }
}

async function pickFile(): Promise<string | undefined> {
  try {
    const sel = await open({ multiple: false, title: "选择要验证的源码文件" });
    return typeof sel === "string" ? sel : undefined;
  } catch {
    return undefined;
  }
}

export default function RulesTab() {
  const [scope, setScope] = useState<RulesScope>("global");
  const [repoPath, setRepoPath] = useState<string>("");
  const [rules, setRules] = useState<Rule[]>([]);
  // 损坏 JSON 时标记，展示「重置为空」入口而非直接崩溃/覆盖。
  const [corrupt, setCorrupt] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", text: "" });
  const [checkFile, setCheckFile] = useState<string>("");
  const [checkResult, setCheckResult] = useState<string>("");

  // 加载规则：scope 变化或仓库目录变化时重新读取。
  // repo 作用范围未选目录时，不请求后端（无从定位文件），先清空并提示。
  useEffect(() => {
    let cancelled = false;
    if (scope === "repo" && repoPath.length === 0) {
      setRules([]);
      setCorrupt(false);
      return;
    }
    invokeGetRules(scope, scope === "repo" ? repoPath : undefined)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setRules(res.rulesFile?.rules ?? []);
          setCorrupt(false);
        } else {
          // 损坏 JSON：保留空表 + 标记，允许用户「重置为空」覆盖。
          setRules([]);
          setCorrupt(true);
          setStatus({ kind: "error", text: `读取规则失败：${res.stderr}` });
        }
      })
      .catch((e) => {
        if (!cancelled) setStatus({ kind: "error", text: `读取规则失败：${String(e)}` });
      });
    return () => {
      cancelled = true;
    };
  }, [scope, repoPath]);

  const handleScopeChange = async (next: RulesScope) => {
    setStatus({ kind: "idle", text: "" });
    setCheckResult("");
    if (next === "repo" && repoPath.length === 0) {
      const dir = await pickDirectory();
      if (dir) setRepoPath(dir);
    }
    setScope(next);
  };

  const handlePickRepo = async () => {
    const dir = await pickDirectory();
    if (dir) setRepoPath(dir);
  };

  const handleSave = async () => {
    setStatus({ kind: "idle", text: "" });
    if (scope === "repo" && repoPath.length === 0) {
      setStatus({ kind: "error", text: "请先选择仓库目录" });
      return;
    }
    // 客户端先做一次空值拦截，给出更即时的中文提示（后端仍会二次校验并给行号）。
    for (let i = 0; i < rules.length; i++) {
      if (rules[i].path.trim().length === 0) {
        setStatus({ kind: "error", text: `第 ${i + 1} 条规则的 path 不能为空` });
        return;
      }
      if (rules[i].rule.trim().length === 0) {
        setStatus({ kind: "error", text: `第 ${i + 1} 条规则的 rule 不能为空` });
        return;
      }
    }
    const file: RulesFile = { rules };
    try {
      const res = await invokeSetRules(scope, scope === "repo" ? repoPath : undefined, file);
      if (res.ok) {
        setCorrupt(false);
        setStatus({ kind: "ok", text: "已保存规则文件" });
      } else {
        setStatus({ kind: "error", text: `保存失败：${res.stderr}` });
      }
    } catch (e) {
      setStatus({ kind: "error", text: `保存失败：${String(e)}` });
    }
  };

  const handleResetCorrupt = async () => {
    setRules([]);
    setStatus({ kind: "idle", text: "" });
    try {
      const res = await invokeSetRules(
        scope,
        scope === "repo" ? repoPath : undefined,
        { rules: [] }
      );
      if (res.ok) {
        setCorrupt(false);
        setStatus({ kind: "ok", text: "已重置为空规则文件" });
      } else {
        setStatus({ kind: "error", text: `重置失败：${res.stderr}` });
      }
    } catch (e) {
      setStatus({ kind: "error", text: `重置失败：${String(e)}` });
    }
  };

  const handlePickCheckFile = async () => {
    const f = await pickFile();
    if (f) {
      setCheckFile(f);
      setCheckResult("");
    }
  };

  const handleCheck = async () => {
    if (checkFile.length === 0) {
      setStatus({ kind: "error", text: "请先选择要验证的源码文件" });
      return;
    }
    setStatus({ kind: "idle", text: "" });
    try {
      const res = await invokeCheckRules(checkFile, scope === "repo" ? repoPath : undefined);
      if (res.ok) {
        setCheckResult(res.matched ?? res.stdout);
      } else {
        setCheckResult("");
        setStatus({ kind: "error", text: `验证失败：${res.stderr || res.stdout}` });
      }
    } catch (e) {
      setStatus({ kind: "error", text: `验证失败：${String(e)}` });
    }
  };

  return (
    <section className="tab-panel">
      <h2>Rules</h2>

      <div className="rules-scope">
        <span>作用范围：</span>
        <label>
          <input
            type="radio"
            name="rules-scope"
            checked={scope === "global"}
            onChange={() => void handleScopeChange("global")}
          />
          全局 ~/.opencodereview
        </label>
        <label>
          <input
            type="radio"
            name="rules-scope"
            checked={scope === "repo"}
            onChange={() => void handleScopeChange("repo")}
          />
          仓库级
        </label>
        {scope === "repo" && (
          <>
            <button type="button" onClick={() => void handlePickRepo()}>
              选择目录…
            </button>
            <span className="rules-repo-path" title={repoPath}>
              {repoPath || "（未选择）"}
            </span>
          </>
        )}
      </div>

      <RulesTable rules={rules} onChange={setRules} />

      {corrupt && (
        <p className="error">
          规则文件损坏（不是合法 JSON）。
          <button type="button" onClick={() => void handleResetCorrupt()}>
            重置为空
          </button>
        </p>
      )}

      {scope === "repo" && repoPath.length === 0 && (
        <p className="placeholder">请先选择仓库目录，再编辑并保存仓库级规则。</p>
      )}

      <div className="rules-verify">
        <span>验证命中：</span>
        <button type="button" onClick={() => void handlePickCheckFile()}>
          选择文件…
        </button>
        <span className="rules-repo-path" title={checkFile}>
          {checkFile || "（未选择）"}
        </span>
        <button type="button" onClick={() => void handleCheck()}>
          用 ocr rules check 验证
        </button>
      </div>
      {checkResult && <pre className="rules-check-result">{checkResult}</pre>}

      <div className="provider-actions">
        <button type="button" onClick={() => void handleSave()}>
          保存规则文件
        </button>
      </div>

      {status.kind !== "idle" && (
        <p className={status.kind === "ok" ? "status-ok" : "error"}>{status.text}</p>
      )}
    </section>
  );
}
