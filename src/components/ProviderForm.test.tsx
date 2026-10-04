import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ProviderForm from "./ProviderForm";
import {
  invokeSetProvider,
  invokeSetProviderKey,
  invokeSetCustomProvider,
  invokeSetModel,
  invokeTestConnection,
} from "../ipc";
import { WithToasts } from "../test-utils";

// Task 5：保存/测试连接会调用 ipc 命令，这里整体 mock 掉，断言触发参数正确。
// Task 8：用部分 mock 保留真实 translateError，错误中文化路径也走真实实现。
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  invokeSetProvider: vi.fn(),
  invokeSetProviderKey: vi.fn(),
  invokeSetCustomProvider: vi.fn(),
  invokeSetModel: vi.fn(),
  invokeTestConnection: vi.fn(),
}));

const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };
const mSetProvider = vi.mocked(invokeSetProvider);
const mSetProviderKey = vi.mocked(invokeSetProviderKey);
const mSetCustom = vi.mocked(invokeSetCustomProvider);
const mSetModel = vi.mocked(invokeSetModel);
const mTestConn = vi.mocked(invokeTestConnection);

beforeEach(() => {
  mSetProvider.mockReset().mockResolvedValue(ok);
  mSetProviderKey.mockReset().mockResolvedValue(ok);
  mSetCustom.mockReset().mockResolvedValue(ok);
  mSetModel.mockReset().mockResolvedValue(ok);
  mTestConn.mockReset();
});

// 点击保存：按 provider → key → model 顺序逐条 invoke，参数与表单值一致。
describe("ProviderForm 保存触发", () => {
  it("内置 provider：保存调用 set_provider / set_provider_key / set_model", async () => {
    render(<WithToasts>{(toast) => <ProviderForm provider="anthropic" toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-x" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "claude-x" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mSetModel).toHaveBeenCalled());
    expect(mSetProvider).toHaveBeenCalledWith("anthropic");
    expect(mSetProviderKey).toHaveBeenCalledWith("anthropic", "sk-x");
    expect(mSetModel).toHaveBeenCalledWith("claude-x");
    // 非 custom 分支不应调用自定义网关命令。
    expect(mSetCustom).not.toHaveBeenCalled();
    // 保存成功经全局 Toast 展示。
    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
  });

  // 空串 api_key = 「未输入」，不得覆盖已有 key（Task 4 reviewer 语义）。
  it("api_key 为空串时跳过 set_provider_key", async () => {
    render(<ProviderForm provider="openai" />);
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mSetModel).toHaveBeenCalled());
    expect(mSetProviderKey).not.toHaveBeenCalled();
  });

  it("custom 分支：保存调用 set_custom_provider(url/protocol)", async () => {
    render(
      <ProviderForm
        provider="mygw"
        config={{ customProviders: { mygw: { url: "https://x/v1", protocol: "anthropic" } } }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mSetCustom).toHaveBeenCalled());
    expect(mSetCustom).toHaveBeenCalledWith("mygw", "https://x/v1", "anthropic");
    expect(mSetProvider).toHaveBeenCalledWith("mygw");
  });

  // 审查焦点 #2：任一 set 失败要定位到具体字段 + 中文提示。
  it("set_provider_key 失败时显示字段级中文错误提示", async () => {
    mSetProviderKey.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "Error: unknown config key: providers.anthropic.api_key",
    } as typeof ok);
    render(<WithToasts>{(toast) => <ProviderForm provider="anthropic" toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "sk-bad" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.getByText(/保存失败：API Key/)).toBeInTheDocument()
    );
    // 失败点之后不再继续调 model。
    expect(mSetModel).not.toHaveBeenCalled();
  });

  // Task 8：已知关键词的错误应被翻译为中文（而非原样透传 stderr）。
  it("保存失败且 stderr 命中已知关键词时展示中文提示", async () => {
    mSetProvider.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "unsupported key: provider",
    } as typeof ok);
    render(<WithToasts>{(toast) => <ProviderForm provider="anthropic" toast={toast} />}</WithToasts>);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(
        screen.getByText(/保存失败：Provider 名称 写入出错（该参数不可持久化）/)
      ).toBeInTheDocument()
    );
  });
});

// 测试连接：成功显示 ✓，失败显示 ✗。
describe("ProviderForm 测试连接", () => {
  it("成功时显示 ✓", async () => {
    mTestConn.mockResolvedValue({ ...ok, success: true, message: "pong" });
    render(<WithToasts>{(toast) => <ProviderForm provider="openai" toast={toast} />}</WithToasts>);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(screen.getByText(/✓ 连接成功/)).toBeInTheDocument());
  });

  it("失败时显示 ✗", async () => {
    mTestConn.mockResolvedValue({
      ...ok,
      ok: false,
      exitCode: 1,
      success: false,
      message: "401 Unauthorized",
    });
    render(<WithToasts>{(toast) => <ProviderForm provider="openai" toast={toast} />}</WithToasts>);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() => expect(screen.getByText(/✗ 连接失败/)).toBeInTheDocument());
  });

  // Task 8：连接失败原因命中已知关键词时翻译为中文。
  it("失败原因含 connection error 时经 Toast 展示「LLM 连接失败」", async () => {
    mTestConn.mockResolvedValue({
      ...ok,
      ok: false,
      exitCode: 1,
      success: false,
      message: "connection error: ECONNREFUSED",
    });
    render(<WithToasts>{(toast) => <ProviderForm provider="openai" toast={toast} />}</WithToasts>);
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(screen.getByText("✗ 连接失败：LLM 连接失败")).toBeInTheDocument()
    );
  });
});

// I4：自定义网关名前置校验（含 `.`/大写/空格等会让 ocr 命令失败）。
describe("ProviderForm 网关名校验", () => {
  it("网关名含 `.` 时不触发任何保存调用，并显示中文提示", async () => {
    render(<WithToasts>{(toast) => <ProviderForm provider="custom" toast={toast} />}</WithToasts>);
    // provider=custom 分支下，填一个含 `.` 的非法网关名。
    fireEvent.change(screen.getByLabelText("Gateway 名称"), { target: { value: "my.gw" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://x/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(screen.getByText(/保存失败：Gateway 名称/)).toBeInTheDocument()
    );
    // 非法名称不得下发任何保存命令。
    expect(mSetProvider).not.toHaveBeenCalled();
    expect(mSetCustom).not.toHaveBeenCalled();
    expect(mSetProviderKey).not.toHaveBeenCalled();
    expect(mSetModel).not.toHaveBeenCalled();
  });

  it("合法网关名（小写+连字符）正常保存", async () => {
    render(<WithToasts>{(toast) => <ProviderForm provider="custom" toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("Gateway 名称"), { target: { value: "my-gw-2" } });
    fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://x/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mSetCustom).toHaveBeenCalled());
    expect(mSetProvider).toHaveBeenCalledWith("my-gw-2");
    expect(mSetCustom).toHaveBeenCalledWith("my-gw-2", "https://x/v1", "openai");
  });

  it("网关名为空时提示填写且不保存", async () => {
    render(<WithToasts>{(toast) => <ProviderForm provider="custom" toast={toast} />}</WithToasts>);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText(/请填写自定义网关名称/)).toBeInTheDocument());
    expect(mSetProvider).not.toHaveBeenCalled();
  });
});

// 核心联动：内置 provider 分支显示 API Key + Model，隐藏自定义网关字段；
// 自定义分支显示 Gateway/URL/Protocol + API Key，隐藏「内置」专属字段。
describe("ProviderForm 字段联动", () => {
  it("provider=anthropic 时显示 API Key 与 Model，不显示自定义网关字段", () => {
    render(<ProviderForm provider="anthropic" />);

    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    expect(screen.getByLabelText("Model")).toBeInTheDocument();
    // 自定义分支字段不应出现。
    expect(screen.queryByLabelText("Gateway 名称")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Protocol")).not.toBeInTheDocument();
  });

  it("provider=custom 时显示 Gateway/URL/Protocol，内置 API Key 字段隐藏", () => {
    render(<ProviderForm provider="custom" />);

    expect(screen.getByLabelText("Gateway 名称")).toBeInTheDocument();
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
    expect(screen.getByLabelText("Protocol")).toBeInTheDocument();
    // 自定义分支仍有一个 API Key（自定义网关自己的 key），但不再有内置 key 字段。
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();
    // Protocol 下拉含三个协议选项。
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    const opts = Array.from(protocol.options).map((o) => o.value);
    expect(opts).toEqual(["openai", "anthropic", "openai-responses"]);
  });

  it("api_key 输入一律 type=password 掩码（spec §7）", () => {
    render(<ProviderForm provider="anthropic" />);
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
  });

  // Task 8 掩码复核：custom 分支的 API Key 同样必须是 password。
  it("custom 分支的 API Key 也是 type=password", () => {
    render(<ProviderForm provider="custom" />);
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "password");
  });

  // Minor-3：非 "custom" 的名字，只要存在于 custom_providers 中，也应识别为自定义分支。
  it("custom_providers 中的名字（非字面 custom）走自定义分支", () => {
    render(
      <ProviderForm
        provider="mygw"
        config={{ customProviders: { mygw: { url: "https://x", protocol: "openai" } } }}
      />
    );
    expect(screen.getByLabelText("Gateway 名称")).toBeInTheDocument();
    expect(screen.queryByLabelText("Protocol")).toBeInTheDocument();
  });
});

// Important-2：初值预填——从 config 正确初始化 model / gateway / url / protocol / max_tokens / effort。
describe("ProviderForm 初值预填", () => {
  it("内置 provider：从 providers.<name>.model 预填 Model", () => {
    render(
      <ProviderForm
        provider="openai"
        config={{ providers: { openai: { apiKey: "", model: "gpt-5" } } }}
      />
    );
    expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("gpt-5");
  });

  it("custom 网关：预填 gateway 名称 / url / protocol", () => {
    render(
      <ProviderForm
        provider="mygw"
        config={{
          customProviders: { mygw: { url: "https://api.example/v1", protocol: "anthropic" } },
        }}
      />
    );
    expect((screen.getByLabelText("Gateway 名称") as HTMLInputElement).value).toBe("mygw");
    expect((screen.getByLabelText("URL") as HTMLInputElement).value).toBe("https://api.example/v1");
    expect((screen.getByLabelText("Protocol") as HTMLSelectElement).value).toBe("anthropic");
  });

  it("max_tokens 与 effort 被预填", () => {
    render(<ProviderForm provider="openai" config={{ maxTokens: 8192, effort: "high" }} />);
    expect((screen.getByLabelText("Max Tokens") as HTMLInputElement).value).toBe("8192");
    expect((screen.getByLabelText("Effort") as HTMLSelectElement).value).toBe("high");
  });
});
