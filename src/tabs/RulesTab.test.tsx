import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import RulesTab from "./RulesTab";
import { invokeCheckRules, invokeGetRules, invokeSetRules } from "../ipc";
import { WithToasts } from "../test-utils";

// RulesTab 消费 ipc 命令与 dialog 插件；这里整体 mock 掉，断言触发参数与状态流转。
// 用部分 mock（保留真实 translateError），使错误中文化路径也走真实实现。
vi.mock("../ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ipc")>()),
  invokeGetRules: vi.fn(),
  invokeSetRules: vi.fn(),
  invokeCheckRules: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

const mGet = vi.mocked(invokeGetRules);
const mSet = vi.mocked(invokeSetRules);
const mCheck = vi.mocked(invokeCheckRules);

const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };

// 挂载后等待初次 invokeGetRules 的 Promise 落地，避免异步 setRules 覆盖后续交互产生的新状态。
async function flushLoad() {
  await waitFor(() => expect(mGet).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  mGet.mockReset().mockResolvedValue({ ...ok, rulesFile: { rules: [] } });
  mSet.mockReset().mockResolvedValue(ok);
  mCheck.mockReset();
});

// 加载：全局作用范围下读取规则并渲染到表格。
describe("RulesTab 加载", () => {
  it("挂载时按 global 读取规则并渲染行", async () => {
    mGet.mockResolvedValue({
      ...ok,
      rulesFile: {
        rules: [{ path: "**/*.java", rule: "检查空指针", mergeSystemRule: true }],
      },
    });
    render(<RulesTab />);

    await waitFor(() =>
      expect((screen.getByLabelText("path-0") as HTMLInputElement).value).toBe("**/*.java")
    );
    expect(mGet).toHaveBeenCalledWith("global", undefined);
    expect((screen.getByLabelText("merge-0") as HTMLInputElement).checked).toBe(true);
  });

  // 审查焦点 #3：损坏 JSON → 显示「重置为空」入口而非崩溃。
  it("损坏 JSON（ok=false）时展示重置入口", async () => {
    mGet.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "invalid json in ...",
    });
    render(<WithToasts>{(toast) => <RulesTab toast={toast} />}</WithToasts>);

    await waitFor(() => expect(screen.getByText(/重置为空/)).toBeInTheDocument());
    // 损坏原因经 translateError 中文化后就地展示。
    expect(screen.getByText(/JSON 文件损坏/)).toBeInTheDocument();
  });
});

// 保存：客户端空值拦截 + 合法时调用 set_rules。
describe("RulesTab 保存", () => {
  it("path 为空时客户端拦截，不下发 set_rules", async () => {
    render(<WithToasts>{(toast) => <RulesTab toast={toast} />}</WithToasts>);
    await flushLoad();
    fireEvent.click(screen.getByRole("button", { name: "+ 新增规则" }));
    await waitFor(() => expect(screen.getByLabelText("path-0")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "保存规则文件" }));

    await waitFor(() => expect(screen.getByText(/第 1 条规则的 path 不能为空/)).toBeInTheDocument());
    expect(mSet).not.toHaveBeenCalled();
  });

  it("合法规则保存时调用 set_rules(global, undefined, {rules})", async () => {
    render(<WithToasts>{(toast) => <RulesTab toast={toast} />}</WithToasts>);
    await flushLoad();
    fireEvent.click(screen.getByRole("button", { name: "+ 新增规则" }));
    fireEvent.change(screen.getByLabelText("path-0"), { target: { value: "**/*.java" } });
    fireEvent.change(screen.getByLabelText("rule-0"), { target: { value: "检查" } });
    fireEvent.click(screen.getByRole("button", { name: "保存规则文件" }));

    await waitFor(() => expect(mSet).toHaveBeenCalled());
    expect(mSet).toHaveBeenCalledWith("global", undefined, {
      rules: [{ path: "**/*.java", rule: "检查", mergeSystemRule: true }],
    });
    // 保存成功经全局 Toast 展示。
    await waitFor(() => expect(screen.getByText("已保存规则文件")).toBeInTheDocument());
  });
});

// 验证命中：选文件后调 check_rules 并展示结果。
describe("RulesTab 验证命中", () => {
  it("选择文件并验证，展示命中规则文本", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("F:/repo/src/Foo.java");
    mCheck.mockResolvedValue({ ...ok, matched: "Rule:\n  MATCHED" });

    render(<RulesTab />);
    await flushLoad();
    fireEvent.click(screen.getByRole("button", { name: "选择文件…" }));
    await waitFor(() => expect(screen.getByText("F:/repo/src/Foo.java")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "用 ocr rules check 验证" }));

    await waitFor(() => expect(screen.getByText(/MATCHED/)).toBeInTheDocument());
    expect(mCheck).toHaveBeenCalledWith("F:/repo/src/Foo.java", undefined);
  });

  // I2：global 作用范围下不传 repo（undefined）——由后端 Rust 自动回溯所选文件的 git root
  // 作为 `--repo`，避免 CLI 用 GUI 进程 cwd 定位而报 `... is not a git repository`。
  it("global 作用范围验证时 repo 传 undefined（交后端回溯 git root）", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("F:/some/git/repo/src/Foo.java");
    mCheck.mockResolvedValue({ ...ok, matched: "Rule:\n  MATCHED" });

    render(<RulesTab />);
    await flushLoad();
    fireEvent.click(screen.getByRole("button", { name: "选择文件…" }));
    await waitFor(() =>
      expect(screen.getByText("F:/some/git/repo/src/Foo.java")).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: "用 ocr rules check 验证" }));

    await waitFor(() => expect(mCheck).toHaveBeenCalled());
    expect(mCheck).toHaveBeenCalledWith("F:/some/git/repo/src/Foo.java", undefined);
  });

  // I2：repo 作用范围下应把选定的仓库目录作为 repo 参数传入。
  it("repo 作用范围验证时传入选定仓库目录", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    // 第一次 open 用于选目录（切 repo 作用范围），第二次用于选文件。
    vi.mocked(open)
      .mockResolvedValueOnce("F:/myrepo")
      .mockResolvedValueOnce("F:/myrepo/src/Bar.java");
    mCheck.mockResolvedValue({ ...ok, matched: "Rule:\n  MATCHED" });

    render(<RulesTab />);
    await flushLoad();
    fireEvent.click(screen.getByLabelText(/仓库级/));
    await waitFor(() => expect(mGet).toHaveBeenCalledWith("repo", "F:/myrepo"));

    fireEvent.click(screen.getByRole("button", { name: "选择文件…" }));
    await waitFor(() => expect(screen.getByText("F:/myrepo/src/Bar.java")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "用 ocr rules check 验证" }));

    await waitFor(() => expect(mCheck).toHaveBeenCalled());
    expect(mCheck).toHaveBeenCalledWith("F:/myrepo/src/Bar.java", "F:/myrepo");
  });

  // Task 8：验证失败时经 Toast 展示中文化错误。
  it("验证失败时经 Toast 展示中文错误", async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("F:/not/a/repo/Foo.java");
    mCheck.mockResolvedValue({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    render(<WithToasts>{(toast) => <RulesTab toast={toast} />}</WithToasts>);
    await flushLoad();
    fireEvent.click(screen.getByRole("button", { name: "选择文件…" }));
    await waitFor(() => expect(screen.getByText("F:/not/a/repo/Foo.java")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "用 ocr rules check 验证" }));

    await waitFor(() =>
      expect(screen.getByText("验证失败：该目录不是 git 仓库")).toBeInTheDocument()
    );
  });
});
