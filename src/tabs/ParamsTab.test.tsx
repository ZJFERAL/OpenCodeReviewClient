import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ParamsTab, { buildReviewPreview } from "./ParamsTab";
import { invokeGetConfig, invokeSetParam } from "../ipc";

// ParamsTab 消费 ipc 命令；整体 mock 掉，断言触发参数与状态流转。
vi.mock("../ipc", () => ({
  invokeGetConfig: vi.fn(),
  invokeSetParam: vi.fn(),
}));

const mGetConfig = vi.mocked(invokeGetConfig);
const mSetParam = vi.mocked(invokeSetParam);
const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };

beforeEach(() => {
  mGetConfig.mockReset().mockResolvedValue({ ...ok, config: {} });
  mSetParam.mockReset().mockResolvedValue(ok);
});

// 纯函数：把不可持久化的 review 运行时 flag 拼成只读命令预览串。
describe("buildReviewPreview 命令片段生成", () => {
  it("各 flag 与值均出现在预览串中", () => {
    const preview = buildReviewPreview({
      timeout: "15",
      concurrency: "8",
      format: "text",
      exclude: "**/generated/*,**/testdata/*",
    });
    expect(preview).toContain("ocr review");
    expect(preview).toContain("--timeout 15");
    expect(preview).toContain("--concurrency 8");
    expect(preview).toContain("--format text");
    expect(preview).toContain('--exclude "**/generated/*,**/testdata/*"');
  });

  it("空值不生成对应 flag", () => {
    const preview = buildReviewPreview({ timeout: "", concurrency: "", format: "", exclude: "" });
    expect(preview.trim()).toBe("ocr review");
  });

  it("exclude 始终加引号包裹（含逗号/通配符）", () => {
    const preview = buildReviewPreview({
      timeout: "",
      concurrency: "",
      format: "",
      exclude: "**/gen/*",
    });
    expect(preview).toContain('--exclude "**/gen/*"');
  });
});

// 表单：可持久化项（max_tokens/effort）走 set_param；不可持久化项只进预览。
describe("ParamsTab 命令预览", () => {
  it("填写不可持久化项后预览串含各 flag 与值，且不调用 set_param", () => {
    render(<ParamsTab />);

    fireEvent.change(screen.getByLabelText("Timeout (秒)"), { target: { value: "15" } });
    fireEvent.change(screen.getByLabelText("Concurrency"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "text" } });
    fireEvent.change(screen.getByLabelText("Exclude"), {
      target: { value: "**/generated/*,**/testdata/*" },
    });

    const preview = screen.getByTestId("command-preview").textContent ?? "";
    expect(preview).toContain("--timeout 15");
    expect(preview).toContain("--concurrency 8");
    expect(preview).toContain("--format text");
    expect(preview).toContain('--exclude "**/generated/*,**/testdata/*"');
    // 不可持久化项绝不写入。
    expect(mSetParam).not.toHaveBeenCalled();
  });

  it("预览为只读（不写文件、不执行）", () => {
    render(<ParamsTab />);
    expect(screen.getByTestId("command-preview")).toHaveAttribute("readonly");
  });
});

// 保存：max_tokens/effort 逐条走 set_param 持久化。
describe("ParamsTab 保存可持久化参数", () => {
  it("保存时调用 set_param('max_tokens') 与 set_param('effort')", async () => {
    render(<ParamsTab />);

    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "200000" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() => expect(mSetParam).toHaveBeenCalledTimes(2));
    expect(mSetParam).toHaveBeenCalledWith("max_tokens", "200000");
    expect(mSetParam).toHaveBeenCalledWith("effort", "high");
    await waitFor(() => expect(screen.getByText("已保存参数")).toBeInTheDocument());
  });

  it("空值跳过对应 set_param（不覆盖已有值）", async () => {
    render(<ParamsTab />);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() => expect(mSetParam).toHaveBeenCalledTimes(1));
    expect(mSetParam).toHaveBeenCalledWith("max_tokens", "8192");
  });

  // 后端白名单拒绝时（ok=false + `unsupported key`），展示中文错误而非静默。
  it("set_param 失败时显示错误提示", async () => {
    mSetParam.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "unsupported key: timeout",
    });
    render(<ParamsTab />);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() => expect(screen.getByText(/保存失败/)).toBeInTheDocument());
  });
});
