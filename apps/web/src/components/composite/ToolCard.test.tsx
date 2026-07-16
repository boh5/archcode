import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DiffFile, PendingToolPart, RunningToolPart, CompletedToolPart, ErrorToolPart } from "@archcode/protocol";
import { Clock, LoaderCircle, Check, X, TriangleAlert, Plug } from "lucide-react";

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

const setState = mock(<T,>(_value: T | ((previous: T) => T)) => {});
let mockedBooleanState = true;
const useState = mock(<T,>(initialOrInitializer: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] => {
  const initial = typeof initialOrInitializer === "function"
    ? (initialOrInitializer as () => T)()
    : initialOrInitializer;
  return [
    (typeof initial === "boolean" ? mockedBooleanState : initial) as T,
    setState as (value: T | ((previous: T) => T)) => void,
  ];
});

mock.module("react", () => ({
  default: {},
  useState,
  useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useMemo: <T,>(factory: () => T) => factory(),
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

const { ToolCard } = await import("./ToolCard");

beforeEach(() => {
  mockedBooleanState = true;
  setState.mockClear();
});

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
  test("collapsed card contains only its summary row and expands through one disclosure control", () => {
    mockedBooleanState = false;
    const part = makeError({
      toolName: "bash",
      input: { description: "Fail safely", command: "exit 1" },
      errorMessage: "private failure detail",
    });

    const el = ToolCard({ part });
    const text = textContent(el);
    const buttons = findAllWithType(el, "button");

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props?.["aria-expanded"]).toBe(false);
    expect(text).toContain("Fail safely");
    expect(text).not.toContain("command:");
    expect(text).not.toContain("private failure detail");

    (buttons[0]?.props?.onClick as (() => void))();
    expect(setState).toHaveBeenCalledTimes(1);
  });

  test("collapsed ask_user omits question/answer details while keeping the question summary", () => {
    mockedBooleanState = false;
    const part = makeCompleted({
      toolName: "ask_user",
      input: {
        questions: [{ header: "File", question: "Which file?", options: [], custom: true }],
      },
      output: "model-facing result",
      meta: { askUser: { answers: [["src/main.ts"]] } },
    });

    const text = textContent(ToolCard({ part }));
    expect(text).toContain("Which file?");
    expect(text).not.toContain("Question");
    expect(text).not.toContain("Answer");
    expect(text).not.toContain("src/main.ts");
  });

  test("collapsed invalid and unknown-result cards omit their detail messages", () => {
    mockedBooleanState = false;
    const invalidText = textContent(ToolCard({ part: makeRunning({ toolName: "bash", input: { command: "pwd" } }) }));
    const unknownText = textContent(ToolCard({
      part: makeError({
        errorMessage: "Tool execution result unknown: execution was interrupted",
        meta: { unknownResult: true },
      }),
    }));

    expect(invalidText).not.toContain("Invalid bash input");
    expect(unknownText).toContain("unknown");
    expect(unknownText).not.toContain("Result unknown");
    expect(unknownText).not.toContain("execution was interrupted before completion");
  });

  test("diff summary always shows files and shows totals only for complete finite counts", () => {
    mockedBooleanState = false;
    const complete = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/target.ts" },
      meta: {
        diffs: {
          files: [
            { path: "a.ts", additions: 3, deletions: 1, hunks: [] },
            { path: "b.ts", additions: 2, deletions: 4, hunks: [] },
          ],
        },
      },
    });
    const partial = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/target.ts" },
      meta: {
        diffs: {
          files: [
            { path: "a.ts", additions: 3, deletions: 1, hunks: [] },
            { path: "b.ts", additions: 2, hunks: [] },
          ],
        },
      },
    });

    const completeText = textContent(ToolCard({ part: complete }));
    const partialText = textContent(ToolCard({ part: partial }));
    expect(completeText).toContain("2 files · +5 −5");
    expect(completeText).not.toContain("a.ts");
    expect(partialText).toContain("2 files");
    expect(partialText).not.toContain("+5");
    expect(partialText).not.toContain("−");
  });

  test("malformed diff metadata contributes no summary or collapsed diff detail", () => {
    mockedBooleanState = false;
    const part = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/target.ts" },
      meta: { diffs: { files: [{ path: "malformed.ts" }] } },
    });

    const text = textContent(ToolCard({ part }));
    expect(text).not.toContain("files");
    expect(text).not.toContain("malformed.ts");
  });

  test("empty output without other details has no disclosure affordance", () => {
    mockedBooleanState = false;
    const part = makeCompleted({ toolName: "custom_tool", input: {}, output: "" });
    const el = ToolCard({ part });
    const button = findAllWithType(el, "button")[0];

    expect(button?.props?.disabled).toBe(true);
    expect(button?.props?.["aria-expanded"]).toBeUndefined();
  });

  test("pending state renders status icon and tool name without input", () => {
    const part = makePending({ toolName: "bash", toolCallId: "call-pending" });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(findAllWithType(el, Clock).length).toBeGreaterThan(0);
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
    expect(findAllWithType(el, LoaderCircle).length).toBeGreaterThan(0);
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
    expect(findAllWithType(el, Check).length).toBeGreaterThan(0);
    expect(text).toContain("file_read");
    expect(text).toContain("done");
  });

  test("completed ask_user without metadata shows raw output and never infers a bare answer", () => {
    const part = makeCompleted({
      toolName: "ask_user",
      input: {
        questions: [{ header: "Recent goal", question: "What do you want to learn or finish?", options: [], custom: true }],
      },
      output: "agent",
    });

    const el = ToolCard({ part });
    const text = textContent(el);

    expect(text).toContain("agent");
    expect(text).not.toContain("Answer");
  });

  test("completed ask_user renders every structured answer from metadata", () => {
    const part = makeCompleted({
      toolName: "ask_user",
      input: {
        questions: [
          { header: "File", question: "Which file?", options: [], custom: true },
          { header: "Style", question: "Which styles?", options: [], multiple: true, custom: true },
        ],
      },
      output: "model-facing formatted result",
      meta: {
        askUser: {
          answers: [["src/main.ts"], ["Dark mode", "Compact"]],
        },
      },
    });

    const el = ToolCard({ part });
    const text = textContent(el);

    expect(text).toContain("Which file?");
    expect(text).toContain("src/main.ts");
    expect(text).toContain("Which styles?");
    expect(text).toContain("Dark mode, Compact");
    expect(text).not.toContain("model-facing formatted result");
  });

  test.each([
    ["missing answers", {}],
    ["old version", { version: 1, answers: [["agent"]] }],
    ["extra key", { answers: [["agent"]], extra: true }],
    ["wrong nesting", { answers: ["agent"] }],
    ["answer count mismatch", { answers: [["agent"], ["extra"]] }],
    ["empty answer", { answers: [[]] }],
  ])("completed ask_user with %s metadata shows raw output", (_label, askUser) => {
    const part = makeCompleted({
      toolName: "ask_user",
      input: {
        questions: [{ header: "Recent goal", question: "What do you want to learn or finish?", options: [], custom: true }],
      },
      output: "raw ask_user output",
      meta: { askUser },
    });

    const text = textContent(ToolCard({ part }));
    expect(text).toContain("raw ask_user output");
    expect(text).not.toContain("Answer");
  });

  test.each([
    ["unknown key", { header: "Recent goal", question: "What next?", options: [], custom: true, extra: true }],
    ["oversized header", { header: "x".repeat(31), question: "What next?", options: [], custom: true }],
  ])("completed ask_user with malformed question structure (%s) shows raw output", (_label, question) => {
    const part = makeCompleted({
      toolName: "ask_user",
      input: {
        questions: [question],
      },
      output: "raw ask_user output",
      meta: { askUser: { answers: [["agent"]] } },
    });

    expect(textContent(ToolCard({ part }))).toContain("raw ask_user output");
  });

  test("failed ask_user keeps the error message instead of presenting it as an answer", () => {
    const part = makeError({
      toolName: "ask_user",
      input: {
        questions: [{ header: "Goal", question: "What do you want to build?", options: [], custom: true }],
      },
      errorMessage: "Question was cancelled",
    });

    const text = textContent(ToolCard({ part }));

    expect(text).toContain("Question was cancelled");
    expect(text).not.toContain("AnswerQuestion was cancelled");
  });

  test("error state renders X icon and error label", () => {
    const part = makeError({
      toolName: "bash",
      input: { description: "Bad command", command: "exit 1" },
      errorMessage: "Command exited with code 1",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(findAllWithType(el, X).length).toBeGreaterThan(0);
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

  test("diff metadata with an old version is ignored safely", () => {
    const part = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/src/index.ts" },
      output: "Edit applied",
      meta: {
        diffs: {
          version: 1,
          files: [{ path: "malformed-only.ts", hunks: [] }],
        },
      },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).toContain("Edit applied");
    expect(text).not.toContain("malformed-only.ts");
    expect(text).not.toContain("M");
  });

  test("nested malformed diff metadata is ignored safely", () => {
    const part = makeCompleted({
      toolName: "file_edit",
      input: { filePath: "/src/index.ts" },
      output: "raw edit output",
      meta: {
        diffs: {
          files: [{
            path: "malformed-only.ts",
            hunks: [{
              header: "@@",
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: [{ type: "add", content: "x", extra: true }],
            }],
          }],
        },
      },
    });

    const text = textContent(ToolCard({ part }));
    expect(text).toContain("raw edit output");
    expect(text).not.toContain("malformed-only.ts");
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
    expect(findAllWithType(el, Plug).length).toBeGreaterThan(0);
    expect(text).toContain("context7/search");
  });

  test("error tool with unknownResult renders warning styling instead of error", () => {
    const part = makeError({
      toolName: "bash",
      input: { description: "Run command", command: "make build" },
      errorMessage: "Tool execution result unknown: execution was interrupted",
      meta: { unknownResult: true },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(findAllWithType(el, TriangleAlert).length).toBeGreaterThan(0);
    expect(text).toContain("unknown");
    expect(text).toContain("Result unknown");
    const warningEls = findAllWithClass(el, "bg-warning-muted");
    expect(warningEls.length).toBeGreaterThan(0);
    const warningTextEls = findAllWithClass(el, "text-warning");
    expect(warningTextEls.length).toBeGreaterThan(0);
  });

  test("error tool without unknownResult renders normal error styling", () => {
    const part = makeError({
      toolName: "bash",
      input: { description: "Bad command", command: "exit 1" },
      errorMessage: "Command failed",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(findAllWithType(el, X).length).toBeGreaterThan(0);
    expect(text).toContain("error");
    expect(text).not.toContain("unknown");
    const errorEls = findAllWithClass(el, "bg-error-muted");
    expect(errorEls.length).toBeGreaterThan(0);
  });

  test("error tool with unknownResult shows warning message", () => {
    const part = makeError({
      toolName: "file_edit",
      input: { filePath: "/src/app.ts" },
      errorMessage: "Tool execution result unknown: execution was interrupted",
      meta: { unknownResult: true },
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(findAllWithType(el, TriangleAlert).length).toBeGreaterThan(0);
    expect(text).toContain("Result unknown");
    expect(text).toContain("execution was interrupted before completion");
  });

  test("unknown-result warning preserves original error message for operator context", () => {
    const part = makeError({
      toolName: "file_write",
      input: { filePath: "/src/app.ts" },
      errorMessage: "Tool execution result unknown: execution was interrupted",
      meta: { unknownResult: true },
    });

    const text = textContent(ToolCard({ part }));

    expect(text).toContain("Tool execution result unknown: execution was interrupted");
    expect(text).toContain("Result unknown");
  });

  test("error tool without unknownResult does not show warning message", () => {
    const part = makeError({
      toolName: "bash",
      input: { description: "Bad command", command: "exit 1" },
      errorMessage: "Command failed",
    });
    const el = ToolCard({ part });
    const text = textContent(el);
    expect(text).not.toContain("Result unknown");
  });
});
