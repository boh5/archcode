import { describe, expect, mock, test } from "bun:test";
import { ErrorBoundary } from "./ErrorBoundary";

describe("ErrorBoundary", () => {
  test("exports a class component", () => {
    expect(typeof ErrorBoundary).toBe("function");
    expect(ErrorBoundary.prototype).toHaveProperty("render");
  });

  test("getDerivedStateFromError returns hasError true with the error", () => {
    const error = new Error("test crash");
    const state = ErrorBoundary.getDerivedStateFromError(error);
    expect(state).toEqual({ hasError: true, error });
  });

  test("getDerivedStateFromError preserves error reference", () => {
    const error = new Error("render failure");
    const state = ErrorBoundary.getDerivedStateFromError(error);
    expect(state.error).toBe(error);
    expect(state.error?.message).toBe("render failure");
  });

  test("initial state has no error", () => {
    const instance = new ErrorBoundary({ children: null });
    expect(instance.state).toEqual({ hasError: false, error: null });
  });

  test("componentDidCatch logs to console.error", () => {
    const consoleSpy = mock(() => {});
    const originalError = console.error;
    console.error = consoleSpy;

    const instance = new ErrorBoundary({ children: null });
    const error = new Error("boom");
    const info = { componentStack: "\n    in TestComponent" };
    instance.componentDidCatch(error, info);

    expect(consoleSpy).toHaveBeenCalled();
    console.error = originalError;
  });
});