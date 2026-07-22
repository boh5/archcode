import { Check, Info, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { Toast as ToastData, ToastVariant } from "../../hooks/use-toast";
import { IconAction } from "../primitives/IconAction";

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  error: "border-l-error text-error",
  success: "border-l-success text-success",
  warning: "border-l-warning text-warning",
  info: "border-l-info text-info",
};

const VARIANT_ICON: Record<ToastVariant, LucideIcon> = {
  error: X,
  success: Check,
  warning: TriangleAlert,
  info: Info,
};

interface ToastProps {
  toast: ToastData;
  onDismiss: (id: string) => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const Icon = VARIANT_ICON[toast.variant];
  return (
    <div
      role="alert"
      className={`animate-overlay-enter flex items-center gap-2 rounded-lg border border-l-2 border-border-default bg-bg-overlay px-3 py-2 text-[13px] font-medium shadow-md ${VARIANT_CLASSES[toast.variant]}`}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 min-w-0 break-words">{toast.message}</span>
      <IconAction
        label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="ml-1 opacity-60 hover:opacity-100"
      >
        <X aria-hidden="true" size={14} />
      </IconAction>
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
