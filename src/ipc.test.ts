import { describe, it, expect } from "vitest";
import { normalizeConfig, normalizeRules } from "./ipc";

// 覆盖真实 config.json schema 的键名映射（Important-1）：
// model 在设过 provider 后嵌在 providers.<name>.model，而非顶层。
describe("normalizeConfig model 兜底", () => {
  it("provider 设过时从 providers.<name>.model 取 model", () => {
    const cfg = normalizeConfig({
      provider: "openai",
      providers: { openai: { api_key: "sk-x", model: "gpt-5" } },
    });
    expect(cfg.provider).toBe("openai");
    expect(cfg.model).toBe("gpt-5");
  });

  it("custom 网关从 custom_providers.<name>.model 取 model", () => {
    const cfg = normalizeConfig({
      provider: "mygw",
      custom_providers: {
        mygw: { url: "https://x/v1", protocol: "anthropic", model: "claude-x" },
      },
    });
    expect(cfg.model).toBe("claude-x");
    expect(cfg.customProviders?.mygw).toEqual({
      url: "https://x/v1",
      protocol: "anthropic",
      model: "claude-x",
    });
  });

  it("未设 provider 时回退顶层 model", () => {
    expect(normalizeConfig({ model: "top-level-model" }).model).toBe("top-level-model");
  });

  it("真实键名 snake_case：max_tokens / api_key / custom_providers 均被映射", () => {
    const cfg = normalizeConfig({
      provider: "anthropic",
      max_tokens: 8192,
      effort: "high",
      providers: { anthropic: { api_key: "sk-secret" } },
    });
    expect(cfg.maxTokens).toBe(8192);
    expect(cfg.effort).toBe("high");
    // 已有 api_key → 标记存在（空串占位），不回读明文。
    expect(cfg.providers?.anthropic?.apiKey).toBe("");
  });
});

// Rules Tab：后端 data → RulesFile 的键名映射（真实落盘 snake_case → 前端 camelCase）。
describe("normalizeRules", () => {
  it("snake_case merge_system_rule 映射为 camelCase mergeSystemRule", () => {
    const rf = normalizeRules({
      rules: [{ path: "**/*.java", rule: "检查空指针", merge_system_rule: true }],
    });
    expect(rf.rules).toEqual([
      { path: "**/*.java", rule: "检查空指针", mergeSystemRule: true },
    ]);
  });

  it("缺 merge 字段时归一为 false；非对象 data 返回空规则集", () => {
    expect(normalizeRules({ rules: [{ path: "a", rule: "b" }] }).rules[0].mergeSystemRule).toBe(
      false
    );
    expect(normalizeRules(null)).toEqual({ rules: [] });
    expect(normalizeRules({ rules: "not-array" })).toEqual({ rules: [] });
  });
});
