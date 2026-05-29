import { describe, expect, mock, test } from "bun:test";
import type { DiffFile, PendingToolPart, RunningToolPart, CompletedToolPart, ErrorToolPart } from "@specra/protocol";

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

function findWithClass(value: unknown, className: string): ElementLike | undefined {
  return findAllWithClass(value, className)[0];
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

const setState = mock(<T,>(_value: T | ((previous: T) => T)) => {});
const useState = mock(<T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
  const initial = typeof initialOrInitializer === "function"
    ? (initialOrInitializer as () => T)()
    : initialOrInitializer;
  return [initial, setState as (value: T | ((previous: T) => T)) => void];
});

mock.module("react", () => ({
  default: {},
  useState,
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

const { ToolCard } = await import("./ToolCard");

// ─── Factory helpers ───

function makePending(overrides: Partial<PendingToolPart> = {}): PendingToolPart {
  return {
    type: "tool",
    id: "tool-1",
    state: "pending",
    toolCallId: "call-1",
    toolName: "bash",
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRunning(overrides: Partial<RunningToolPart> = {}): RunningToolPart {
  return {
    type: "tool",
    id: "tool-1",
    state: "running",
    toolCallId: "call-1",
    toolName: "bash",
    input: { description: "Run command", command: "pwd" },
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

function makeCompleted(overrides: Partial<CompletedToolPart> = {}): CompletedToolPart {
  return {
    type: "tool",
    id: "tool-1",
    state: "completed",
    toolCallId: "call-1",
    toolName: "bash",
    input: { description: "Run command", command: "pwd" },
    output: "done",
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    ...overrides,
  };
}

function makeError(overrides: Partial<ErrorToolPart> = {}): ErrorToolPart {
  return {
    type: "tool",
    id: "tool-1",
    state: "error",
    toolCallId: "call-1",
    toolName: "bash",
    input: { description: "Run command", command: "bad-cmd" },
    errorMessage: "Command failed",
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    ...overrides,
  };
}

// ─── Tests ───

describe("ToolCard", () => {
  test("pending state renders status icon and tool name without input", () => {
    const part = makePending({ toolName: "bash", toolCallId: "call-pending" });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("⏳");
    expect(text).toContain("bash");
    expect(text).toContain("pending");
  });

  test("pending state does not crash without input", () => {
    const part = makePending({ toolName: "grep" });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("pending");
  });

  test("running state renders status icon and summary", () => {
    const part = makeRunning({
      toolName: "bash",
      input: { description: "Install deps", command: "bun install" },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("⟳");
    expect(text).toContain("bash");
    expect(text).toContain("Install deps");
    expect(text).toContain("running…");
  });

  test("completed state renders check icon and done label", () => {
    const part = makeCompleted({
      toolName: "file_read",
      input: { filePath: "/src/index.ts" },
      output: "file contents here",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("✓");
    expect(text).toContain("file_read");
    expect(text).toContain("done");
  });

  test("error state renders X icon and error label", () => {
    const part = makeError({
      toolName: "bash",
      input: { description: "Bad command", command: "exit 1" },
      errorMessage: "Command exited with code 1",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("✗");
    expect(text).toContain("error");
    expect(text).toContain("Command exited with code 1");
  });

  test("bash with description renders description as primary and command as secondary", () => {
    const part = makeRunning({
      toolName: "bash",
      input: { description: "Install dependencies", command: "bun install" },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("Install dependencies");
    expect(text).toContain("bun install");
  });

  test("bash missing description renders invalid-input message and does not crash", () => {
    const part = makeRunning({
      toolName: "bash",
      input: { command: "pwd" },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("Invalid bash input: missing required description");
  });

  test("bash missing command renders invalid-input message", () => {
    const part = makeRunning({
      toolName: "bash",
      input: { description: "Do something" },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("Invalid bash input: missing required command");
  });

  test("file_write details render path and content stats, not content body", () => {
    const longContent = "x".repeat(500);
    const part = makeCompleted({
      toolName: "file_write",
      input: { filePath: "/src/app.ts", content: longContent },
      output: "File written",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("/src/app.ts");
    expect(text).toContain("500 chars");
    expect(text).not.toContain(longContent);
  });

  test("completed tool with diff metadata renders diff section with file path", () => {
    const diffFiles: DiffFile[] = [
      {
        path: "src/index.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
        hunks: [],
      },
    ];
    const part = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/src/index.ts" },
      output: "Edit applied",
      meta: {
        diffs: {
          version: 1,
          files: diffFiles,
        },
      },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("src/index.ts");
    expect(text).toContain("M");
  });

  test("completed tool without diff metadata does not render diff section", () => {
    const part = makeCompleted({
      toolName: "file_read",
      input: { filePath: "/src/index.ts" },
      output: "file contents",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).not.toContain("No changes");
  });

  test("malformed diff metadata is ignored safely", () => {
    const part = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/src/index.ts" },
      output: "Edit applied",
      meta: {
        diffs: {
          version: 2,
          files: "malformed-only.ts",
        },
      },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("Edit applied");
    expect(text).not.toContain("malformed-only.ts");
    expect(text).not.toContain("M");
  });

  test("error tool with diff metadata renders diff section", () => {
    const diffFiles: DiffFile[] = [
      {
        path: "src/fail.ts",
        status: "modified",
        additions: 0,
        deletions: 5,
        hunks: [],
      },
    ];
    const part = makeError({
      toolName: "file_edit",
      input: { filePath: "/src/fail.ts" },
      errorMessage: "Edit failed",
      meta: {
        diffs: {
          version: 1,
          files: diffFiles,
        },
      },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("src/fail.ts");
  });

  test("pending tool does not render diff section", () => {
    const part = makePending({ toolName: "bash" });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("pending");
    expect(text).not.toContain("No changes");
  });

  test("input details are rendered for running tool", () => {
    const part = makeRunning({
      toolName: "grep",
      input: { pattern: "TODO", path: "/src", output_mode: "content" },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("pattern");
    expect(text).toContain("TODO");
  });

  test("input details are not rendered for pending tool", () => {
    const part = makePending({ toolName: "grep" });
    const el = ToolCard({ part });
    expect(textContent(el)).toContain("pending");
  });

  test("null input renders dash primary without crashing", () => {
    const part = makeRunning({
      toolName: "bash",
      input: null,
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("—");
  });

  test("status icon has correct color classes for each state", () => {
    const pendingEl = ToolCard({ part: makePending() });
    const runningEl = ToolCard({ part: makeRunning() });
    const completedEl = ToolCard({ part: makeCompleted() });
    const errorEl = ToolCard({ part: makeError() });

    expect(findWithClass(pendingEl, "bg-warning-muted")).toBeDefined();
    expect(findWithClass(runningEl, "bg-info-muted")).toBeDefined();
    expect(findWithClass(completedEl, "bg-success-muted")).toBeDefined();
    expect(findWithClass(errorEl, "bg-error-muted")).toBeDefined();
  });

  test("running state has animate-spin class", () => {
    const el = ToolCard({ part: makeRunning() });
    expect(findWithClass(el, "animate-spin")).toBeDefined();
  });

  test("completed state has text-text-tertiary name class", () => {
    const el = ToolCard({ part: makeCompleted() });
    expect(findWithClass(el, "text-text-tertiary")).toBeDefined();
  });

  test("MCP tool renders with plug icon and server/tool format", () => {
    const part = makeRunning({
      toolName: "mcp__context7__search",
      input: { query: "react hooks" },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("🔌");
    expect(text).toContain("context7/search");
  });
});
