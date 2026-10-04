import { describe, it, expect } from "vitest";
import { normalizeConfig } from "./ipc";

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
