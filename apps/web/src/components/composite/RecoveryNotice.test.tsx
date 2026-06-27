import { describe, expect, mock, test } from "bun:test";
import type { RecoveryNoticePart } from "@archcode/protocol";

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    return type(resolvedProps);
  }
  return { type, props: resolvedProps, key };
});

const setState = mock(<T,>(_value: T | ((previous: T) => T)) => {});
const useState = mock(<T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
  const initial = typeof initialOrInitializer === "function"
    ? (initialOrInitializer as () => T)()
    : initialOrInitializer;
  return [initial, setState as (value: T | ((previous: T) => T)) => void];
});

const useEffect = mock((callback: () => void | (() => void), _deps?: unknown[]) => {
  const cleanup = callback();
  if (cleanup) cleanup();
});

mock.module("react", () => ({
  default: {},
  createContext: <T,>(defaultValue: T) => {
    const context = { _currentValue: defaultValue, Provider: ({ children }: { children: unknown }) => children, Consumer: ({ children }: { children: (value: T) => unknown }) => children(defaultValue) };
    return context;
  },
  createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    const resolvedProps = props ?? {};
    if (typeof type === "string") {
      return { type, props: { ...resolvedProps, children: children.length ? children : undefined } };
    }
    return { type, props: resolvedProps };
  },
  forwardRef: <T, P>(render: (props: P, ref: T) => unknown) => render as unknown as React.ForwardRefExoticComponent<P>,
  useContext: <T,>(context: { _currentValue?: T }) => context._currentValue ?? null,
  useState,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect,
  useLayoutEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  useMemo: <T,>(factory: () => T) => factory(),
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

const { RecoveryNotice } = await import("./RecoveryNotice");

function makeRecoveryNotice(overrides: Partial<RecoveryNoticePart> = {}): RecoveryNoticePart {
  return {
    type: "recovery-notice",
    id: "recovery-1",
    status: "scheduled",
    message: "Rate limited by provider",
    attempt: 1,
    nextRetryAt: Date.now() + 5000,
    errorKind: "rate_limit",
    createdAt: Date.now(),
    ...overrides,
  };
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (typeof value === "object" && value !== null && "props" in (value as object)) {
    const el = value as { props?: Record<string, unknown> };
    return textContent(el?.props?.children);
  }
  return "";
}

function findAllWithClass(value: unknown, className: string): unknown[] {
  const matches: unknown[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node === "object" && node !== null && "props" in node) {
      const el = node as { props?: Record<string, unknown> };
      const cls = el?.props?.className;
      if (typeof cls === "string" && cls.includes(className)) {
        matches.push(node);
      }
      visit(el?.props?.children);
    }
  };
  visit(value);
  return matches;
}

describe("RecoveryNotice", () => {
  test("scheduled status renders scheduled label with countdown", () => {
    const part = makeRecoveryNotice({ status: "scheduled", nextRetryAt: Date.now() + 10000 });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Scheduled retry");
    expect(text).toContain("attempt 1");
    expect(text).toContain("rate_limit");
  });

  test("scheduled status accepts nextRetryAt without changing recovery metadata", () => {
    const part = makeRecoveryNotice({ status: "scheduled", nextRetryAt: Date.now() + 30000 });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Scheduled retry");
    expect(text).toContain("attempt 1");
  });

  test("retrying status renders retrying label with spin animation", () => {
    const part = makeRecoveryNotice({ status: "retrying", attempt: 2 });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Retrying");
    expect(text).toContain("attempt 2");
    const spinEls = findAllWithClass(el, "animate-spin");
    expect(spinEls.length).toBeGreaterThan(0);
  });

  test("recovered status renders recovered label with success styling", () => {
    const part = makeRecoveryNotice({
      status: "recovered",
      attempt: 2,
      message: "Successfully recovered",
      completedAt: Date.now(),
    });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Recovered");
    expect(text).toContain("Successfully recovered");
    const successEls = findAllWithClass(el, "bg-success-muted");
    expect(successEls.length).toBeGreaterThan(0);
  });

  test("failed status renders failed label with error styling", () => {
    const part = makeRecoveryNotice({
      status: "failed",
      attempt: 3,
      errorKind: "context_overflow",
      message: "All retries exhausted",
      completedAt: Date.now(),
    });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Recovery failed");
    expect(text).toContain("context_overflow");
    expect(text).toContain("All retries exhausted");
    const errorEls = findAllWithClass(el, "bg-error-muted");
    expect(errorEls.length).toBeGreaterThan(0);
  });

  test("renders message when present", () => {
    const part = makeRecoveryNotice({ status: "scheduled", message: "Custom error message" });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Custom error message");
  });

  test("hides message section when message is empty", () => {
    const part = makeRecoveryNotice({ status: "scheduled", message: "" });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Scheduled retry");
  });

  test("hides attempt when zero", () => {
    const part = makeRecoveryNotice({ status: "scheduled", attempt: 0 });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).not.toContain("attempt 0");
  });

  test("failed status with attempt 0 renders terminal message and hides attempt", () => {
    const part = makeRecoveryNotice({
      status: "failed",
      attempt: 0,
      errorKind: "auth",
      message: "Model call failed: provider auth failed",
      completedAt: Date.now(),
    });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("Recovery failed");
    expect(text).toContain("Model call failed: provider auth failed");
    expect(text).not.toContain("attempt 0");
    const errorEls = findAllWithClass(el, "bg-error-muted");
    expect(errorEls.length).toBeGreaterThan(0);
  });

  test("failed status with statusCode renders status code badge", () => {
    const part = makeRecoveryNotice({
      status: "failed",
      statusCode: 422,
      errorKind: "config",
      message: "Model call failed: model not found",
      completedAt: Date.now(),
    });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).toContain("422");
    expect(text).toContain("config");
  });

  test("hides errorKind when undefined", () => {
    const part = makeRecoveryNotice({ status: "scheduled", errorKind: undefined });
    const el = RecoveryNotice({ part });
    const text = textContent(el);
    expect(text).not.toContain("rate_limit");
  });
});
