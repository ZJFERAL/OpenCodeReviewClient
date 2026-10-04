import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// 全局 Toast：唯一的「操作结果」反馈通道（spec §6.2「→ Toast 提示」）。
// 各 Tab 不再各自渲染本地 status 行，而是通过 App 下发的 ToastApi 上报，
// 由 App 顶层的 ToastContainer 统一展示，避免多套并存的反馈渠道。

export type ToastKind = "ok" | "error";

export type ToastItem = {
  id: number;
  kind: ToastKind;
  text: string;
};

// 各 Tab 消费的接口。success/error 为 notify 的便捷封装。
export type ToastApi = {
  notify: (kind: ToastKind, text: string) => void;
  success: (text: string) => void;
  error: (text: string) => void;
};

// 自动消失时长：成功提示短、失败提示长（错误信息更值得用户看清）。
const AUTO_DISMISS_MS: Record<ToastKind, number> = { ok: 3500, error: 8000 };

// App 级 Toast 状态。返回：
// - toasts：当前待展示的提示（供 ToastContainer 渲染）；
// - toast：下发给各 Tab 的上报接口；
// - dismiss：手动关闭单条（供关闭按钮调用）。
export function useToast(): {
  toasts: ToastItem[];
  toast: ToastApi;
  dismiss: (id: number) => void;
} {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  // id → 定时器，便于提前关闭时取消；卸载时统一清理，避免测试/切换 Tab 后残留。
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback(
    (kind: ToastKind, text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      const id = nextId.current++;
      setToasts((list) => [...list, { id, kind, text: trimmed }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), AUTO_DISMISS_MS[kind])
      );
    },
    [dismiss]
  );

  const toast = useMemo<ToastApi>(
    () => ({
      notify,
      success: (text: string) => notify("ok", text),
      error: (text: string) => notify("error", text),
    }),
    [notify]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  return { toasts, toast, dismiss };
}

export type ToastContainerProps = {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
};

// 右上角浮层容器。固定定位，不挤占页面布局，三 Tab 共用同一实例。
export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-container">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={"toast toast-" + t.kind}
          role={t.kind === "error" ? "alert" : "status"}
        >
          <span className="toast-text">{t.text}</span>
          <button
            type="button"
            className="toast-close"
            aria-label="关闭提示"
            onClick={() => onDismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
