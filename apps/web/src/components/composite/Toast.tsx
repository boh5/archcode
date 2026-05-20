import type { Toast as ToastData, ToastVariant } from "../../hooks/use-toast";

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  error: "bg-error-muted border-error text-error",
  success: "bg-success-muted border-success text-success",
  warning: "bg-warning-muted border-warning text-warning",
  info: "bg-info-muted border-info text-info",
};

const VARIANT_ICON: Record<ToastVariant, string> = {
  error: "✕",
  success: "✓",
  warning: "⚠",
  info: "ℹ",
};

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  return (
    <div
      role="alert"
      className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-medium shadow-md animate-[slideIn_0.2s_ease-out] ${VARIANT_CLASSES[toast.variant]}`}
    >
      <span className="shrink-0 text-base leading-none">{VARIANT_ICON[toast.variant]}</span>
      <span className="flex-1 min-w-0 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 ml-1 opacity-60 hover:opacity-100 transition-opacity cursor-pointer"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastData[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}