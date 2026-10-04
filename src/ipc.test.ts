import { describe, it, expect } from "vitest";
import { normalizeConfig, normalizeRules, translateError } from "./ipc";

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

// Task 8：后端 stderr 关键词 → 中文提示（spec §7「命令失败解析」）。
describe("translateError 错误中文化", () => {
  // brief Step 1 要求的四条映射。
  it("command not found → 未检测到 ocr", () => {
    expect(translateError("ocr: command not found")).toBe("未检测到 ocr");
  });

  it("connection error → LLM 连接失败", () => {
    expect(translateError("✗ connection error: ECONNREFUSED")).toBe("LLM 连接失败");
  });

  it("unknown flag → 不支持的参数", () => {
    expect(translateError("Error: unknown flag: --language")).toBe("不支持的参数");
  });

  it("unsupported key → 该参数不可持久化", () => {
    expect(translateError("unsupported key: timeout")).toBe("该参数不可持久化");
  });

  // Windows cmd 下命令缺失的真实措辞，与 POSIX 的 `command not found` 同义。
  it("Windows `is not recognized` 同样映射为未检测到 ocr", () => {
    expect(
      translateError("'ocr' is not recognized as an internal or external command")
    ).toBe("未检测到 ocr");
  });

  // M1：中文 Windows cmd 的措辞（'ocr' 不是内部或外部命令…）也必须命中。
  it("中文 Windows cmd 措辞映射为未检测到 ocr", () => {
    expect(
      translateError("'ocr' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。")
    ).toBe("未检测到 ocr");
  });

  // M1 兜底：中文 cmd 的 stderr 是 GBK 字节，后端 from_utf8_lossy 解码后成了乱码
  // （'ocr' + U+FFFD 替换字符），既无英文关键词也无正确中文。用真实探针得到的形态断言。
  it("GBK 乱码形态的中文 cmd 报错同样映射为未检测到 ocr", () => {
    // 取自真实探针：'ocr' 后接替换字符与残留的 GBK 半字节字符。
    const mojibake =
      "'ocr' \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\u06B2\uFFFD\uFFFD\uFFFD\uFFFD\u2CBF\uFFFD";
    expect(translateError(mojibake)).toBe("未检测到 ocr");
  });

  // M2：真实 CLI 对白名单外的 config 键报 `unknown config key`（隔离 HOME 实测）。
  it("unknown config key → 该参数不可持久化", () => {
    expect(translateError("Error: unknown config key: timeout")).toBe("该参数不可持久化");
  });

  it("补充关键词：unsupported value / invalid json / not a git repository / 半完成", () => {
    expect(translateError("unsupported value: -1")).toBe("参数值不合法");
    expect(translateError("invalid json in C:/x/config.json: expected value")).toBe(
      "JSON 文件损坏（内容不是合法 JSON）"
    );
    expect(translateError("fatal: not a git repository (or any of the parent)")).toBe(
      "该目录不是 git 仓库"
    );
    expect(translateError("custom_providers.x.url: boom（自定义网关配置可能处于半完成状态）")).toBe(
      "保存可能只完成了一半，请重试"
    );
  });

  it("大小写不敏感", () => {
    expect(translateError("CONNECTION ERROR")).toBe("LLM 连接失败");
  });

  it("未知关键词回退为压缩后的原始文本", () => {
    expect(translateError("some   weird\n\terror")).toBe("some weird error");
  });

  it("超长未知文本被截断（≤201 字符，含省略号）", () => {
    const long = "x".repeat(500);
    const out = translateError(long);
    expect(out.length).toBe(201);
    expect(out.endsWith("…")).toBe(true);
  });

  it("空输入 → 未知错误", () => {
    expect(translateError("")).toBe("未知错误");
    expect(translateError("   \n  ")).toBe("未知错误");
  });
});
