import { describe, expect, mock, test } from "bun:test";

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

// ─── Mocks ───

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") {
    return type(resolvedProps);
  }
  return { type, props: resolvedProps, key };
});

const mockNavigate = mock((_path: string) => {});
mock.module("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
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
    const result = ToolChip({ name: "grep", status: "success", input: { pattern: "TODO" } });
    const text = textContent(result);
    expect(text).toContain("🔍");
  });

  test("renders tool name and primary summary for grep with input", () => {
    const result = ToolChip({ name: "grep", status: "success", input: { pattern: "TODO" } });
    const text = textContent(result);
    expect(text).toContain("grep");
    expect(text).toContain("TODO");
  });

  test("renders bash with description as summary", () => {
    const result = ToolChip({ name: "bash", status: "default", input: { description: "List files", command: "ls" } });
    const text = textContent(result);
    expect(text).toContain("💻");
    expect(text).toContain("bash");
    expect(text).toContain("List files");
  });

  test("renders success status icon", () => {
    const result = ToolChip({ name: "grep", status: "success", input: { pattern: "TODO" } });
    const text = textContent(result);
    expect(text).toContain("✓");
  });

  test("renders error status icon", () => {
    const result = ToolChip({ name: "bash", status: "error", input: { description: "Run command", command: "pwd" } });
    const text = textContent(result);
    expect(text).toContain("✗");
  });

  test("renders tool name when primary is dash", () => {
    const result = ToolChip({ name: "todo_write", status: "default", input: {} });
    const text = textContent(result);
    expect(text).toContain("todo_write");
  });

  test("renders MCP tool with plug icon", () => {
    const result = ToolChip({ name: "mcp__context7__resolve", status: "success", input: { query: "react hooks" } });
    const text = textContent(result);
    expect(text).toContain("🔌");
  });
});

describe("DelegationCard", () => {
  const baseProps = {
    agentId: "agent-1",
    agentType: "explorer",
    agentName: "Explorer Agent",
    status: "running" as const,
    depth: 1,
    startedAt: Date.now() - 60000,
    summary: "Searching for relevant files",
    tools: [
      { name: "grep", status: "success" as const, input: { pattern: "TODO" } },
      { name: "file_read", status: "default" as const, input: { filePath: "/src/index.ts" } },
    ],
    projectSlug: "my-project",
    parentSessionId: "session-1",
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
    const text = textContent(result);
    expect(text).toContain("🔍");
    expect(text).toContain("📄");
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

  test("falls back to explorer for unknown agent type", () => {
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
});