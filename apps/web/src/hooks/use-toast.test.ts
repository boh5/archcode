import { describe, expect, test } from "bun:test";
import { toastReducer, type Toast, type ToastVariant } from "./use-toast";

describe("useToast types and constants", () => {
  test("ToastVariant covers all expected variants", () => {
    const variants: ToastVariant[] = ["error", "success", "warning", "info"];
    expect(variants).toHaveLength(4);
    expect(variants).toContain("error");
    expect(variants).toContain("success");
    expect(variants).toContain("warning");
    expect(variants).toContain("info");
  });

  test("Toast interface shape is correct", () => {
    const toast: Toast = { id: "toast-1", message: "test", variant: "error" };
    expect(toast.id).toBe("toast-1");
    expect(toast.message).toBe("test");
    expect(toast.variant).toBe("error");
  });
});

describe("toastReducer", () => {
  test("add action appends toast to empty state", () => {
    const state = { toasts: [] as Toast[] };
    const toast: Toast = { id: "toast-1", message: "Server error", variant: "error" };
    const next = toastReducer(state, { type: "add", toast });
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0]).toEqual(toast);
  });

  test("add action appends toast to existing state", () => {
    const state: { toasts: Toast[] } = {
      toasts: [{ id: "toast-1", message: "First", variant: "info" }],
    };
    const toast: Toast = { id: "toast-2", message: "Second", variant: "error" };
    const next = toastReducer(state, { type: "add", toast });
    expect(next.toasts).toHaveLength(2);
    expect(next.toasts[1]).toEqual(toast);
  });

  test("dismiss action removes specific toast", () => {
    const state: { toasts: Toast[] } = {
      toasts: [
        { id: "toast-1", message: "First", variant: "info" },
        { id: "toast-2", message: "Second", variant: "error" },
      ],
    };
    const next = toastReducer(state, { type: "dismiss", id: "toast-1" });
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].id).toBe("toast-2");
  });

  test("dismiss action with non-existent id is a no-op", () => {
    const state: { toasts: Toast[] } = {
      toasts: [{ id: "toast-1", message: "First", variant: "info" }],
    };
    const next = toastReducer(state, { type: "dismiss", id: "toast-999" });
    expect(next.toasts).toHaveLength(1);
    expect(next.toasts[0].id).toBe("toast-1");
  });

  test("add then dismiss round-trip", () => {
    let state = { toasts: [] as Toast[] };
    const toast: Toast = { id: "toast-1", message: "Hello", variant: "success" };
    state = toastReducer(state, { type: "add", toast });
    expect(state.toasts).toHaveLength(1);
    state = toastReducer(state, { type: "dismiss", id: "toast-1" });
    expect(state.toasts).toHaveLength(0);
  });

  test("multiple adds preserve order", () => {
    let state = { toasts: [] as Toast[] };
    state = toastReducer(state, { type: "add", toast: { id: "a", message: "A", variant: "info" } });
    state = toastReducer(state, { type: "add", toast: { id: "b", message: "B", variant: "error" } });
    state = toastReducer(state, { type: "add", toast: { id: "c", message: "C", variant: "warning" } });
    expect(state.toasts.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});