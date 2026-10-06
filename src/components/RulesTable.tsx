import type { Rule } from "../types";

// 规则表格的增删改纯函数（不依赖 React），便于单测。
// 全部返回新数组/对象，绝不原地修改入参（React 状态更新语义）。

// 追加一条空规则，返回新数组。
export function addRule(rules: Rule[]): Rule[] {
  return [...rules, { path: "", rule: "", mergeSystemRule: true }];
}

// 删除指定下标的规则；下标越界时原样返回（不抛错）。
export function removeRule(rules: Rule[], index: number): Rule[] {
  if (index < 0 || index >= rules.length) return rules;
  return rules.filter((_, i) => i !== index);
}

// 按下标局部更新一条规则，返回新数组。
export function updateRule(rules: Rule[], index: number, patch: Partial<Rule>): Rule[] {
  if (index < 0 || index >= rules.length) return rules;
  return rules.map((r, i) => (i === index ? { ...r, ...patch } : r));
}

export type RulesTableProps = {
  rules: Rule[];
  onChange: (rules: Rule[]) => void;
};

// 规则表格：行内编辑 path / rule / merge_system_rule 开关，支持增删。
export default function RulesTable({ rules, onChange }: RulesTableProps) {
  return (
    <div className="rules-table">
      <div className="rules-row rules-head">
        <span>path (glob)</span>
        <span>rule (文本)</span>
        <span className="rules-merge-col">merge</span>
        <span className="rules-op-col" />
      </div>
      {rules.map((r, i) => (
        <div className="rules-row" key={i}>
          <input
            aria-label={`path-${i}`}
            value={r.path}
            placeholder="**/*.java"
            onChange={(e) => onChange(updateRule(rules, i, { path: e.target.value }))}
          />
          <textarea
            aria-label={`rule-${i}`}
            value={r.rule}
            rows={2}
            placeholder="校验必填参数非空"
            onChange={(e) => onChange(updateRule(rules, i, { rule: e.target.value }))}
          />
          <span className="rules-merge-col">
            <input
              type="checkbox"
              aria-label={`merge-${i}`}
              checked={r.mergeSystemRule}
              onChange={(e) => onChange(updateRule(rules, i, { mergeSystemRule: e.target.checked }))}
            />
          </span>
          <span className="rules-op-col">
            <button
              type="button"
              aria-label={`delete-${i}`}
              onClick={() => onChange(removeRule(rules, i))}
              title="删除该规则"
            >
              {/* Lucide trash-2，16px，inherit currentColor（mimo：图标 16px，不放大） */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M3 6h18" />
                <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
              </svg>
            </button>
          </span>
        </div>
      ))}
      <div className="rules-actions">
        <button type="button" onClick={() => onChange(addRule(rules))}>
          + 新增规则
        </button>
      </div>
    </div>
  );
}
