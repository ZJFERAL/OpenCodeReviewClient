import { describe, it, expect } from "vitest";
import { addRule, removeRule, updateRule } from "./RulesTable";
import type { Rule } from "../types";

// RulesTable 的增删改纯函数单测（不依赖 React 渲染）。

const base: Rule[] = [
  { path: "**/*.java", rule: "校验必填参数非空", mergeSystemRule: true },
  { path: "**/*.py", rule: "检查 SQL 注入", mergeSystemRule: false },
];

describe("addRule", () => {
  it("在末尾追加一条空规则，且不修改原数组", () => {
    const next = addRule(base);
    expect(next).toHaveLength(3);
    expect(next[2]).toEqual({ path: "", rule: "", mergeSystemRule: true });
    expect(base).toHaveLength(2);
  });

  it("对空数组也能追加", () => {
    const next = addRule([]);
    expect(next).toEqual([{ path: "", rule: "", mergeSystemRule: true }]);
  });
});

describe("removeRule", () => {
  it("按下标删除，返回新数组且原数组不变", () => {
    const next = removeRule(base, 0);
    expect(next).toHaveLength(1);
    expect(next[0].path).toBe("**/*.py");
    expect(base).toHaveLength(2);
  });

  it("越界下标原样返回、不抛错", () => {
    expect(removeRule(base, 5)).toBe(base);
    expect(removeRule(base, -1)).toBe(base);
  });
});

describe("updateRule", () => {
  it("局部更新指定下标，其余规则保持", () => {
    const next = updateRule(base, 1, { rule: "改后的规则文本" });
    expect(next[1].rule).toBe("改后的规则文本");
    expect(next[1].path).toBe("**/*.py");
    expect(next[0]).toEqual(base[0]);
    // 原数组不被修改。
    expect(base[1].rule).toBe("检查 SQL 注入");
  });

  it("可同时更新多个字段（含 merge 开关）", () => {
    const next = updateRule(base, 0, { path: "**/*.ts", mergeSystemRule: false });
    expect(next[0]).toEqual({ path: "**/*.ts", rule: "校验必填参数非空", mergeSystemRule: false });
  });

  it("越界下标原样返回", () => {
    expect(updateRule(base, 9, { rule: "x" })).toBe(base);
  });
});
