import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ProviderTab from "./ProviderTab";
import { invokeGetConfig, invokeListProviders } from "../ipc";
import { WithToasts } from "../test-utils";

// 关键回归（Critical-1 的最小复现）：ProviderTab 首次渲染 config=undefined，
// get_config 异步返回后，表单必须被重新填充（而不是保持空值）。
// Task 5：ProviderTab 同时调用 list_providers 取内置 provider 名。
// Task 8：用部分 mock 保留真实 translateError，错误中文化路径也走真实实现。
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  invokeGetConfig: vi.fn(),
  invokeListProviders: vi.fn(),
}));

const mockedInvokeGetConfig = vi.mocked(invokeGetConfig);
const mockedInvokeListProviders = vi.mocked(invokeListProviders);

beforeEach(() => {
  mockedInvokeGetConfig.mockReset();
  mockedInvokeListProviders.mockReset();
  mockedInvokeListProviders.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "" });
});

describe("ProviderTab 异步配置加载", () => {
  it("get_config 异步返回后，Model 输入框被填充为返回的 model", async () => {
    mockedInvokeGetConfig.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      config: { model: "claude-opus-4-6" },
    });

    render(<ProviderTab />);

    const model = screen.getByLabelText("Model") as HTMLInputElement;
    // 初值应为空（config 尚未到达）。
    expect(model.value).toBe("");

    // 异步返回后应被填充。
    await waitFor(() => expect(model.value).toBe("claude-opus-4-6"));
  });

  it("读取失败时显示错误而不是空表单", async () => {
    mockedInvokeGetConfig.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "invalid json in config.json",
    });

    render(<WithToasts>{(toast) => <ProviderTab toast={toast} />}</WithToasts>);
    // stderr 关键词被中文化后就地展示。
    await waitFor(() =>
      expect(screen.getByText(/JSON 文件损坏/)).toBeInTheDocument()
    );
  });
});

// Task 5：下拉候选来自 list_providers 结果，而非静态 BUILTIN_PROVIDERS。
describe("ProviderTab 内置 provider 列表来自 list_providers", () => {
  it("list_providers 返回的 name 出现在 Provider 下拉中", async () => {
    mockedInvokeGetConfig.mockResolvedValue({ ok: true, exitCode: 0, stdout: "", stderr: "", config: {} });
    mockedInvokeListProviders.mockResolvedValue({
      ok: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      providers: [
        { name: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
        { name: "z-ai", protocol: "openai", baseUrl: "https://open.bigmodel.cn" },
      ],
    });

    render(<ProviderTab />);
    const select = screen.getByLabelText("Provider") as HTMLSelectElement;
    await waitFor(() => {
      const opts = Array.from(select.options).map((o) => o.value);
      expect(opts).toContain("z-ai");
    });
  });
});
