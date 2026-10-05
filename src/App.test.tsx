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

// 审查焦点 #1（Task 9 归属）：ocr 未安装时应用必须能开、不崩，并降级为「引导安装」而非白屏。
describe("App 未安装 ocr 降级", () => {
  it("probe 失败时应用外壳仍渲染，状态条显示未安装 + 安装引导，三个 Tab 可切换", async () => {
    vi.mocked(invokeProbe).mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "'ocr' 不是内部或外部命令，也不是可运行的程序",
    });

    render(<App />);

    // 不白屏：标题与三个 Tab 均在场。
    expect(screen.getByText("Open Code Review 配置器")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Provider" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rules" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Params" })).toBeInTheDocument();

    // 降级为未安装状态 + 安装引导按钮（而非抛错/崩溃）。
    await waitFor(() => expect(screen.getByText(/未安装/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "[安装引导]" })).toBeInTheDocument();

    // 未安装状态下仍可切换到其它 Tab（不依赖 ocr 存在）。
    fireEvent.click(screen.getByRole("button", { name: "Params" }));
    expect(screen.getByRole("heading", { name: "Params" })).toBeInTheDocument();
  });

  it("probe 抛错（IPC 异常）时同样降级为未安装，不冒泡为白屏", async () => {
    vi.mocked(invokeProbe).mockRejectedValue(new Error("ipc unavailable"));

    render(<App />);

    await waitFor(() => expect(screen.getByText(/未安装/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "[安装引导]" })).toBeInTheDocument();
  });
});
