import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "./App";
import {
  invokeGetConfig,
  invokeListProviders,
  invokeGetRules,
  invokeSetRules,
  invokeCheckRules,
  invokeSetProvider,
  invokeProbe,
  invokeSetModel,
  invokeSetProviderKey,
  invokeSetCustomProvider,
  invokeTestConnection,
} from "./ipc";

// App 集成：确认全局 Toast 容器挂在应用外壳上，且各 Tab 的上报能真正渲染出来。
// 部分 mock 保留真实 translateError。
vi.mock("./ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ipc")>()),
  invokeProbe: vi.fn(),
  invokeGetConfig: vi.fn(),
  invokeListProviders: vi.fn(),
  invokeGetRules: vi.fn(),
  invokeSetRules: vi.fn(),
  invokeCheckRules: vi.fn(),
  invokeSetProvider: vi.fn(),
  invokeSetProviderKey: vi.fn(),
  invokeSetCustomProvider: vi.fn(),
  invokeSetModel: vi.fn(),
  invokeTestConnection: vi.fn(),
}));

const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };

beforeEach(() => {
  vi.mocked(invokeProbe).mockReset().mockResolvedValue({ ...ok, data: { version: "1.0.0" } });
  vi.mocked(invokeGetConfig).mockReset().mockResolvedValue({ ...ok, config: {} });
  vi.mocked(invokeListProviders).mockReset().mockResolvedValue({ ...ok, providers: [] });
  vi.mocked(invokeGetRules).mockReset().mockResolvedValue({ ...ok, rulesFile: { rules: [] } });
  vi.mocked(invokeSetRules).mockReset().mockResolvedValue(ok);
  vi.mocked(invokeCheckRules).mockReset().mockResolvedValue(ok);
  vi.mocked(invokeSetProvider).mockReset().mockResolvedValue(ok);
  vi.mocked(invokeSetProviderKey).mockReset().mockResolvedValue(ok);
  vi.mocked(invokeSetCustomProvider).mockReset().mockResolvedValue(ok);
  vi.mocked(invokeSetModel).mockReset().mockResolvedValue(ok);
  vi.mocked(invokeTestConnection).mockReset();
});

describe("App 全局 Toast 集成", () => {
  it("Provider Tab 保存成功后，Toast 在应用外壳内渲染", async () => {
    render(<App />);
    // 等 get_config 落地，ProviderForm 出现。
    fireEvent.change(await screen.findByLabelText("Model"), { target: { value: "gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(screen.getByText("已保存")).toBeInTheDocument());
  });

  it("切换到 Rules Tab 后，其保存结果同样进入同一个全局 Toast 容器", async () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Rules" }));
    // 未选仓库目录时保存应提示（global 作用范围下空规则集可直接保存）。
    await waitFor(() => expect(invokeGetRules).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "保存规则文件" }));

    await waitFor(() => expect(screen.getByText("已保存规则文件")).toBeInTheDocument());
    expect(document.querySelector(".toast-container")).not.toBeNull();
  });
});
