import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import ParamsTab, { buildReviewPreview, previewValueProblem } from "./ParamsTab";
import { invokeGetConfig, invokeSetParam } from "../ipc";
import { WithToasts } from "../test-utils";

// ParamsTab 消费 ipc 命令；整体 mock 掉，断言触发参数与状态流转。
// 用部分 mock（保留真实 translateError），使错误中文化路径也走真实实现。
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
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

// I2：「复制即用」契约——含 shell 特殊字符的值应被识别，UI 提示并禁用复制。
describe("previewValueProblem 危险字符识别", () => {
  const safe = { timeout: "15", concurrency: "8", format: "text", exclude: "**/gen/*" };

  it("安全值返回 undefined", () => {
    expect(previewValueProblem(safe)).toBeUndefined();
  });

  it("exclude 含双引号 → 提示", () => {
    const p = previewValueProblem({ ...safe, exclude: '**/gen/"; echo X' });
    expect(p).toBeDefined();
    expect(p).toContain("Exclude");
  });

  it("含 `& echo` 注入片段 → 提示", () => {
    expect(previewValueProblem({ ...safe, exclude: "a & echo X" })).toBeDefined();
  });

  it("含 %VAR% 展开（cmd 引号内仍展开）→ 提示", () => {
    expect(previewValueProblem({ ...safe, exclude: "%PATH%" })).toBeDefined();
  });

  it("timeout 含换行 → 提示", () => {
    expect(previewValueProblem({ ...safe, timeout: "15\nrm -rf" })).toBeDefined();
  });

  it("空字段不参与判定", () => {
    expect(
      previewValueProblem({ timeout: "", concurrency: "", format: "", exclude: 'a"b' })
    ).toBeDefined();
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

  // I2：含危险字符时提示并禁用「复制命令」。
  it("exclude 含危险字符时提示且禁用复制按钮", () => {
    render(<ParamsTab />);
    fireEvent.change(screen.getByLabelText("Exclude"), { target: { value: 'a"; echo X' } });

    expect(screen.getByText(/无法保证复制即用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制命令" })).toBeDisabled();
  });

  it("值安全时复制按钮可用", () => {
    render(<ParamsTab />);
    fireEvent.change(screen.getByLabelText("Exclude"), { target: { value: "**/gen/*" } });
    expect(screen.queryByText(/无法保证复制即用/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制命令" })).toBeEnabled();
  });
});

// 保存：max_tokens/effort 逐条走 set_param 持久化。
describe("ParamsTab 保存可持久化参数", () => {
  it("保存时调用 set_param('max_tokens') 与 set_param('effort')", async () => {
    render(<WithToasts>{(toast) => <ParamsTab toast={toast} />}</WithToasts>);

    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "200000" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() => expect(mSetParam).toHaveBeenCalledTimes(2));
    expect(mSetParam).toHaveBeenCalledWith("max_tokens", "200000");
    expect(mSetParam).toHaveBeenCalledWith("effort", "high");
    // 保存结果经全局 Toast 展示（不再有本地 status 行）。
    await waitFor(() => expect(screen.getByText("已保存参数")).toBeInTheDocument());
  });

  it("空值跳过对应 set_param（不覆盖已有值）", async () => {
    render(<ParamsTab />);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() => expect(mSetParam).toHaveBeenCalledTimes(1));
    expect(mSetParam).toHaveBeenCalledWith("max_tokens", "8192");
  });

  // 后端白名单拒绝时（ok=false + `unsupported key`），Toast 展示中文错误而非静默。
  it("set_param 失败时经 Toast 展示中文错误", async () => {
    mSetParam.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "unsupported key: timeout",
    });
    render(<WithToasts>{(toast) => <ParamsTab toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "200000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    // `unsupported key` 被翻译为「该参数不可持久化」，且带字段名。
    await waitFor(() =>
      expect(screen.getByText(/保存失败：Max Tokens（该参数不可持久化）/)).toBeInTheDocument()
    );
  });

  // I1：非法 max_tokens（`--help` 这类会被 CLI 静默吞掉的值）前端拦截，不触发保存。
  it("非法 max_tokens（--help）被前端拦截，不调用 set_param", async () => {
    render(<WithToasts>{(toast) => <ParamsTab toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "--help" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() =>
      expect(screen.getByText(/Max Tokens 必须是正整数/)).toBeInTheDocument()
    );
    expect(mSetParam).not.toHaveBeenCalled();
  });

  // Minor-1：max_tokens 成功、effort 失败时，错误文案应告知已写入项。
  it("部分成功时错误文案标注已写入项", async () => {
    mSetParam
      .mockResolvedValueOnce(ok) // max_tokens 成功
      .mockResolvedValueOnce({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr: "unsupported value: ultra",
      }); // effort 失败
    render(<WithToasts>{(toast) => <ParamsTab toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "8192" } });
    fireEvent.change(screen.getByLabelText("Effort"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    // `unsupported value` → 「参数值不合法」。
    await waitFor(() =>
      expect(
        screen.getByText(/保存失败：Effort（参数值不合法）（已写入：Max Tokens）/)
      ).toBeInTheDocument()
    );
  });

  // Minor-2：await 期间保存按钮禁用，避免连点并发。
  it("保存进行中按钮被禁用", async () => {
    let resolveSave: (v: typeof ok) => void = () => {};
    mSetParam.mockImplementation(
      () => new Promise<typeof ok>((resolve) => { resolveSave = resolve; })
    );
    render(<WithToasts>{(toast) => <ParamsTab toast={toast} />}</WithToasts>);
    fireEvent.change(screen.getByLabelText("Max Tokens"), { target: { value: "8192" } });
    fireEvent.click(screen.getByRole("button", { name: "保存参数" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "保存中…" })).toBeDisabled());
    resolveSave(ok);
    await waitFor(() => expect(screen.getByRole("button", { name: "保存参数" })).toBeEnabled());
    // 连点期间只下发一次。
    expect(mSetParam).toHaveBeenCalledTimes(1);
  });
});
