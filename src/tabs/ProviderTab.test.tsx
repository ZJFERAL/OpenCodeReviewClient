import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ProviderTab from "./ProviderTab";
import { invokeGetConfig } from "../ipc";

// 关键回归（Critical-1 的最小复现）：ProviderTab 首次渲染 config=undefined，
// get_config 异步返回后，表单必须被重新填充（而不是保持空值）。
vi.mock("../ipc", () => ({
  invokeGetConfig: vi.fn(),
}));

const mockedInvokeGetConfig = vi.mocked(invokeGetConfig);

beforeEach(() => {
  mockedInvokeGetConfig.mockReset();
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

    render(<ProviderTab />);
    await waitFor(() =>
      expect(screen.getByText(/invalid json/)).toBeInTheDocument()
    );
  });
});
