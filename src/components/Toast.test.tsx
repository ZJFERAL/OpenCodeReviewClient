import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ToastContainer, useToast, type ToastApi } from "./Toast";

// 把 hook 与容器组合成一个测试用宿主：暴露 toast 供断言直接调用。
let api: ToastApi;
function Host() {
  const { toasts, toast, dismiss } = useToast();
  api = toast;
  return <ToastContainer toasts={toasts} onDismiss={dismiss} />;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useToast / ToastContainer 全局提示", () => {
  it("success/error 分别渲染成功与错误样式", () => {
    render(<Host />);
    act(() => {
      api.success("已保存");
      api.error("保存失败：API Key");
    });

    expect(screen.getByText("已保存")).toBeInTheDocument();
    const err = screen.getByText("保存失败：API Key");
    expect(err.closest(".toast")).toHaveClass("toast-error");
    expect(err.closest(".toast")).toHaveAttribute("role", "alert");
  });

  it("成功提示自动消失（3.5s），错误提示保留更久（8s）", () => {
    render(<Host />);
    act(() => {
      api.success("ok");
      api.error("bad");
    });

    act(() => {
      vi.advanceTimersByTime(3600);
    });
    expect(screen.queryByText("ok")).not.toBeInTheDocument();
    expect(screen.getByText("bad")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4500);
    });
    expect(screen.queryByText("bad")).not.toBeInTheDocument();
  });

  it("关闭按钮立即移除提示", () => {
    render(<Host />);
    act(() => {
      api.error("bad");
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭提示" }));
    expect(screen.queryByText("bad")).not.toBeInTheDocument();
  });

  it("空白文本不上报（不渲染空 Toast）", () => {
    const { container } = render(<Host />);
    act(() => {
      api.notify("ok", "   ");
    });
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("卸载后定时器被清理（不抛错）", () => {
    const { unmount } = render(<Host />);
    act(() => {
      api.error("bad");
    });
    unmount();
    expect(() => act(() => vi.advanceTimersByTime(9000))).not.toThrow();
  });
});
