import { describe, expect, mock, test } from "bun:test";
import { Search, Terminal, Plug, FileText, Check, X } from "lucide-react";

// ─── Test helpers ───

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value?.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value?.props?.children);
}

function findAll(
  value: unknown,
  predicate: (element: ElementLike) => boolean,
): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!isElement(node)) return;
    if (predicate(node)) matches.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(value);
  return matches;
}

function findAllWithClass(value: unknown, className: string): ElementLike[] {
  return findAll(value, (el) => {
    const cls = el?.props?.className;
    return typeof cls === "string" && cls.includes(className);
  });
}

function findAllWithType(value: unknown, type: unknown): ElementLike[] {
  return findAll(value, (el) => el.type === type);
}

// ─── Mocks ───

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    return type(resolvedProps);
  }
  return { type, props: resolvedProps, key };
});

const mockSetFocusSessionId = mock((_id: string | null) => {});
const mockStoreState = {
  setFocusSessionId: mockSetFocusSessionId,
};
const mockGetWebSessionStore = mock((_sessionId: string, _slug?: string) => ({
  getState: () => mockStoreState,
}));
mock.module("../../store/session-store", () => ({
  getWebSessionStore: mockGetWebSessionStore,
}));

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

const { DelegationCard, ToolChip } = await import("./DelegationCard");

// ─── Tests ───

describe("ToolChip", () => {
  test("renders tool name when no input provided", () => {
    const result = ToolChip({ name: "grep", status: "success" });
    const text = textContent(result);
    expect(text).toContain("grep");
  });

  test("renders category icon for grep", () => {
    const result = ToolChip({ name: "grep", status: "success", input: { pattern: "needle" } });
    expect(findAllWithType(result, Search).length).toBeGreaterThan(0);
  });

  test("renders tool name and primary summary for grep with input", () => {
    const result = ToolChip({ name: "grep", status: "success", input: { pattern: "needle" } });
    const text = textContent(result);
    expect(text).toContain("grep");
    expect(text).toContain("needle");
  });

  test("renders bash with description as summary", () => {
    const result = ToolChip({ name: "bash", status: "default", input: { description: "List files", command: "ls" } });
    expect(findAllWithType(result, Terminal).length).toBeGreaterThan(0);
    const text = textContent(result);
    expect(text).toContain("bash");
    expect(text).toContain("List files");
  });

  test("renders success status icon", () => {
    const result = ToolChip({ name: "grep", status: "success", input: { pattern: "needle" } });
    expect(findAllWithType(result, Check).length).toBeGreaterThan(0);
  });

  test("renders error status icon", () => {
    const result = ToolChip({ name: "bash", status: "error", input: { description: "Run command", command: "pwd" } });
    expect(findAllWithType(result, X).length).toBeGreaterThan(0);
  });

  test("renders tool name when primary is dash", () => {
    const result = ToolChip({ name: "todo_write", status: "default", input: {} });
    const text = textContent(result);
    expect(text).toContain("todo_write");
  });

  test("renders MCP tool with plug icon", () => {
    const result = ToolChip({ name: "mcp__context7__resolve", status: "success", input: { query: "react hooks" } });
    expect(findAllWithType(result, Plug).length).toBeGreaterThan(0);
  });
});

describe("DelegationCard", () => {
  const baseProps = {
    sessionId: "session-child-1",
    focusStoreSessionId: "session-root-1",
    agentType: "explore",
    agentName: "Explorer Agent",
    status: "running" as const,
    depth: 1,
    startedAt: Date.now() - 60000,
    summary: "Searching for relevant files",
    tools: [
      { name: "grep", status: "success" as const, input: { pattern: "needle" } },
      { name: "file_read", status: "default" as const, input: { filePath: "/src/index.ts" } },
    ],
    projectSlug: "my-project",
  };

  test("renders agent name and summary", () => {
    const result = DelegationCard(baseProps);
    const text = textContent(result);
    expect(text).toContain("Explorer Agent");
    expect(text).toContain("Searching for relevant files");
  });

  test("renders agent initials from shared constants", () => {
    const result = DelegationCard(baseProps);
    const text = textContent(result);
    expect(text).toContain("E");
  });

  test("renders tool chips with category icons", () => {
    const result = DelegationCard(baseProps);
    expect(findAllWithType(result, Search).length).toBeGreaterThan(0);
    expect(findAllWithType(result, FileText).length).toBeGreaterThan(0);
  });

  test("renders running status with elapsed time", () => {
    const result = DelegationCard(baseProps);
    const text = textContent(result);
    expect(text).toContain("Running");
  });

  test("renders completed status", () => {
    const result = DelegationCard({ ...baseProps, status: "completed" });
    const text = textContent(result);
    expect(text).toContain("Completed");
    expect(text).toContain("done");
  });

  test("renders depth indicator", () => {
    const result = DelegationCard(baseProps);
    const text = textContent(result);
    expect(text).toContain("depth 1");
  });

  test("falls back to explore for unknown agent type", () => {
    const result = DelegationCard({ ...baseProps, agentType: "unknown_type" });
    const text = textContent(result);
    expect(text).toContain("E");
  });

  test("renders tool chips without input (fallback to name)", () => {
    const props = {
      ...baseProps,
      tools: [{ name: "grep", status: "success" as const }],
    };
    const result = DelegationCard(props);
    const text = textContent(result);
    expect(text).toContain("grep");
  });

  test("clicking view conversation calls setFocusSessionId on store", () => {
    const result = DelegationCard(baseProps);
    const buttons = findAllWithClass(result, "bg-bg-elevated");
    expect(buttons.length).toBe(1);
    const onClick = buttons[0]?.props?.onClick as (() => void) | undefined;
    expect(onClick).toBeFunction();
    onClick!();
    expect(mockGetWebSessionStore).toHaveBeenCalledWith("session-root-1", "my-project");
    expect(mockSetFocusSessionId).toHaveBeenCalledWith("session-child-1");
  });
});
