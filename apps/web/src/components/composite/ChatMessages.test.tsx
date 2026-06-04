import { describe, expect, mock, test } from "bun:test";
import type { ToolChildSessionLinkStatus, RecoveryNoticePart, TextPart, ReasoningPart, ErrorToolPart } from "@specra/protocol";
import { parseToolInput, parseToolOutput, mapLinkStatusToBadge, PartRenderer } from "./ChatMessages";

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    return type(resolvedProps);
  }
  return { type, props: resolvedProps, key };
});

mock.module("react", () => ({
  default: {},
  useState: <T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
    const initial = typeof initialOrInitializer === "function"
      ? (initialOrInitializer as () => T)()
      : initialOrInitializer;
    return [initial, () => {}];
  },
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
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

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (typeof value === "object" && value !== null && "props" in (value as object)) {
    const el = value as { props?: Record<string, unknown> };
    return textContent(el?.props?.children);
  }
  return "";
}

// ─── parseToolInput ───

describe("parseToolInput", () => {
  test("parses object input directly", () => {
    const result = parseToolInput({ agent_type: "explore", prompt: "test" });
    expect(result).toEqual({ agent_type: "explore", prompt: "test" });
  });

  test("parses string JSON input", () => {
    const result = parseToolInput(JSON.stringify({ agent_type: "explore", description: "Search" }));
    expect(result).toEqual({ agent_type: "explore", description: "Search" });
  });

  test("returns null for null input", () => {
    expect(parseToolInput(null)).toBeNull();
  });

  test("returns null for undefined input", () => {
    expect(parseToolInput(undefined)).toBeNull();
  });

  test("returns null for invalid JSON string", () => {
    expect(parseToolInput("not json")).toBeNull();
  });

  test("returns null for number input", () => {
    expect(parseToolInput(42)).toBeNull();
  });
});

// ─── parseToolOutput ───

describe("parseToolOutput", () => {
  test("parses valid JSON output", () => {
    const result = parseToolOutput(JSON.stringify({ sessionId: "abc-123", text: "Done" }));
    expect(result).toEqual({ sessionId: "abc-123", text: "Done" });
  });

  test("returns null for undefined output", () => {
    expect(parseToolOutput(undefined)).toBeNull();
  });

  test("returns null for invalid JSON", () => {
    expect(parseToolOutput("not json")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseToolOutput("")).toBeNull();
  });
});

// ─── mapLinkStatusToBadge ───

describe("mapLinkStatusToBadge", () => {
  test("completed maps to completed", () => {
    expect(mapLinkStatusToBadge("completed")).toBe("completed");
  });

  test("running maps to running", () => {
    expect(mapLinkStatusToBadge("running")).toBe("running");
  });

  test("linked maps to running", () => {
    expect(mapLinkStatusToBadge("linked")).toBe("running");
  });

  test("cancelling maps to running", () => {
    expect(mapLinkStatusToBadge("cancelling")).toBe("running");
  });

  test("failed maps to error", () => {
    expect(mapLinkStatusToBadge("failed")).toBe("error");
  });

  test("timed_out maps to error", () => {
    expect(mapLinkStatusToBadge("timed_out")).toBe("error");
  });

  test("cancelled maps to error", () => {
    expect(mapLinkStatusToBadge("cancelled")).toBe("error");
  });

  test("interrupted maps to error", () => {
    expect(mapLinkStatusToBadge("interrupted")).toBe("error");
  });

  test("all ToolChildSessionLinkStatus values are covered", () => {
    const statuses: ToolChildSessionLinkStatus[] = [
      "linked", "running", "cancelling", "completed", "failed", "timed_out", "cancelled", "interrupted",
    ];
    for (const status of statuses) {
      const result = mapLinkStatusToBadge(status);
      expect(typeof result).toBe("string");
      expect(["running", "completed", "error"]).toContain(result);
    }
  });
});

describe("PartRenderer", () => {
  const defaultProps = { projectSlug: "demo", focusStoreSessionId: "session-1", childSessionLinks: [] as never[] };

  test("renders interrupted text with badge", () => {
    const part: TextPart = {
      type: "text",
      id: "text-1",
      text: "Partial response content",
      createdAt: Date.now(),
      completedAt: Date.now(),
      meta: { interrupted: true, discardedFromContext: true },
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("⚠ Response was interrupted");
    expect(text).toContain("Partial response content");
  });

  test("renders normal text without badge", () => {
    const part: TextPart = {
      type: "text",
      id: "text-2",
      text: "Normal response",
      createdAt: Date.now(),
      completedAt: Date.now(),
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).not.toContain("⚠ Response was interrupted");
    expect(text).toContain("Normal response");
  });

  test("renders interrupted reasoning with badge", () => {
    const part: ReasoningPart = {
      type: "reasoning",
      id: "reasoning-1",
      text: "Partial reasoning",
      createdAt: Date.now(),
      completedAt: Date.now(),
      meta: { interrupted: true },
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("⚠ Response was interrupted");
    expect(text).toContain("Reasoning");
  });

  test("renders recovery-notice part", () => {
    const part: RecoveryNoticePart = {
      type: "recovery-notice",
      id: "recovery-1",
      status: "retrying",
      message: "Retrying after rate limit",
      attempt: 2,
      createdAt: Date.now(),
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("Retrying");
    expect(text).toContain("Retrying after rate limit");
  });

  test("renders recovery-notice failed status", () => {
    const part: RecoveryNoticePart = {
      type: "recovery-notice",
      id: "recovery-2",
      status: "failed",
      message: "All retries exhausted",
      attempt: 3,
      errorKind: "context_overflow",
      createdAt: Date.now(),
      completedAt: Date.now(),
    };
    const el = PartRenderer({ part, ...defaultProps });
    const text = textContent(el);
    expect(text).toContain("Recovery failed");
    expect(text).toContain("context_overflow");
  });
});