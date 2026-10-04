import type { ReactNode } from "react";
import { ToastContainer, useToast, type ToastApi } from "./components/Toast";

// 测试专用包装：把真实的 useToast + ToastContainer 接进来，
// 让「组件上报 → Toast 渲染」整条链路在 DOM 中可见（断言与生产行为一致）。
// 用法：render(<WithToasts>{(toast) => <SomeTab toast={toast} />}</WithToasts>)
export function WithToasts({ children }: { children: (toast: ToastApi) => ReactNode }) {
  const { toasts, toast, dismiss } = useToast();
  return (
    <>
      {children(toast)}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
