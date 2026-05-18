import { useCallback, useReducer } from "react";

export type ToastVariant = "error" | "success" | "warning" | "info";

export interface Toast {
  id: string;
  message: string;
  variant: ToastVariant;
}

interface ToastState {
  toasts: Toast[];
}

type ToastAction =
  | { type: "add"; toast: Toast }
  | { type: "dismiss"; id: string };

export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case "add":
      return { toasts: [...state.toasts, action.toast] };
    case "dismiss":
      return { toasts: state.toasts.filter((t) => t.id !== action.id) };
  }
}

const AUTO_DISMISS_MS = 5_000;

let toastCounter = 0;

export function useToast() {
  const [state, dispatch] = useReducer(toastReducer, { toasts: [] });

  const show = useCallback(
    (message: string, variant: ToastVariant = "info") => {
      const id = `toast-${++toastCounter}`;
      dispatch({ type: "add", toast: { id, message, variant } });

      // Auto-dismiss after timeout
      setTimeout(() => {
        dispatch({ type: "dismiss", id });
      }, AUTO_DISMISS_MS);
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    dispatch({ type: "dismiss", id });
  }, []);

  return { toasts: state.toasts, show, dismiss };
}