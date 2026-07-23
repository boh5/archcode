import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompletedToolPart, ErrorToolPart, FinalizedToolResult, PendingToolPart, RunningToolPart } from "@archcode/protocol";

interface ElementLike { type?: unknown; props?: Record<string, unknown> | null }
function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}
function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value.props?.children;
  return children === undefined || children === null ? [] : Array.isArray(children) ? children : [children];
}
function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return isElement(value) ? textContent(value.props?.children) : "";
}
function findByTestId(value: unknown, testId: string): ElementLike | undefined {
  if (isElement(value) && value.props?.["data-testid"] === testId) return value;
  for (const child of childrenOf(value)) {
    const found = findByTestId(child, testId);
    if (found) return found;
  }
  return undefined;
}
function findByType(value: unknown, type: unknown): ElementLike | undefined {
  if (isElement(value) && value.type === type) return value;
  for (const child of childrenOf(value)) {
    const found = findByType(child, type);
    if (found) return found;
  }
  return undefined;
}
function findAllWithClass(value: unknown, className: string): ElementLike[] {
  const matches: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const child of node) visit(child); return; }
    if (!isElement(node)) return;
    if (typeof node.props?.className === "string" && node.props.className.includes(className)) matches.push(node);
    for (const child of childrenOf(node)) visit(child);
  };
  visit(value);
  return matches;
}
function findByData(value: unknown, key: string, expected: string): ElementLike | undefined {
  if (isElement(value) && value.props?.[key] === expected) return value;
  for (const child of childrenOf(value)) {
    const found = findByData(child, key, expected);
    if (found) return found;
  }
  return undefined;
}

const Fragment = Symbol.for("react.fragment");
const jsx = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const normalized = props ?? {};
  return typeof type === "function" ? type(normalized) : { type, props: normalized, key };
});
let stateValues: boolean[] = [true, false];
let stateIndex = 0;
const setState = mock(() => {});

mock.module("react", () => ({
  default: {},
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
  useState: <T,>(initial: T): [T, (value: T) => void] => [
    (stateValues[stateIndex++] ?? initial) as T,
    setState,
  ],
}));
mock.module("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV: jsx, jsx, jsxs: jsx }));
mock.module("lucide-react", () => ({
  Ban: () => null,
  Calendar: () => null,
  Check: () => null,
  ChevronRight: (props: Record<string, unknown>) => ({ type: "svg", props }),
  Clock: () => null,
  Clock3: () => null,
  Circle: () => null,
  CircleAlert: () => null,
  CircleCheck: () => null,
  CircleDashed: () => null,
  CirclePause: () => null,
  CircleStop: () => null,
  CircleX: () => null,
  FileText: () => null,
  Gauge: () => null,
  Pencil: () => null,
  Search: () => null,
  GitBranch: () => null,
  Terminal: () => null,
  MessageSquare: () => null,
  Wrench: () => null,
  Globe: () => null,
  Handshake: () => null,
  Zap: () => null,
  Brain: () => null,
  Plug: () => null,
  CircleQuestionMark: () => null,
  Target: () => null,
  LoaderCircle: (props: Record<string, unknown>) => ({ type: "svg", props }),
  MessageCircleQuestion: () => null,
  TriangleAlert: () => null,
  X: () => null,
}));
mock.module("./ToolOutputViewer", () => ({
  ToolOutputViewer: ({ outputRef }: { outputRef: string }) => ({ type: "viewer", props: { children: outputRef } }),
}));
mock.module("../diff/DiffView", () => ({
  DiffView: ({ files }: { files: Array<{ path: string }> }) => ({ type: "diff", props: { children: files.map((file) => file.path).join(",") } }),
}));

const { ToolCard } = await import("./ToolCard");

const baseOutput: FinalizedToolResult["output"] = {
  preview: "canonical preview",
  completeness: "partial",
  observed: { bytes: 200, lines: 20 },
  canonical: { bytes: 180, lines: 18 },
  stored: { bytes: 120, lines: 12 },
  omitted: { bytes: 60, lines: 6 },
  recovery: { kind: "none" },
};

function completed(result: FinalizedToolResult): CompletedToolPart {
  return {
    type: "tool",
    id: "tool-1",
    state: "completed",
    toolCallId: "call-1",
    toolName: "bash",
    input: { command: "pwd", description: "Show path" },
    result,
    createdAt: 1,
    startedAt: 2,
    endedAt: 3,
  };
}

beforeEach(() => {
  stateValues = [true, false];
  stateIndex = 0;
  setState.mockClear();
});

describe("ToolCard strict result consumer", () => {
  test("renders unified preview, completeness, counts, omitted and process details", () => {
    const element = ToolCard({
      part: completed({
        isError: false,
        output: baseOutput,
        details: { process: { exitCode: 0, signal: null, timedOut: false, aborted: false, durationMs: 42 } },
      }),
      projectSlug: "demo",
      sessionId: "root-1",
    });
    const text = textContent(element);
    expect(text).toContain("canonical preview");
    expect(text).toContain("partial");
    expect(text).toContain("observed 200 B / 20 lines");
    expect(text).toContain("omitted 60 B / 6 lines");
    expect(text).toContain("42 ms");
  });

  test("renders diff and ask_user only from strict presentations", () => {
    const element = ToolCard({
      part: completed({
        isError: false,
        output: { ...baseOutput, preview: "raw preview must not supply answers" },
        details: {
          presentations: [
            { kind: "diff", files: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, hunks: [] }] },
            { kind: "ask_user", answers: [{ question: "Proceed?", answers: ["Yes"] }] },
          ],
        },
      }),
      projectSlug: "demo",
      sessionId: "root-1",
    });
    const text = textContent(element);
    expect(text).toContain("1 file · +2 −1");
    expect(text).toContain("Proceed?");
    expect(text).toContain("Yes");
    expect(text).not.toContain("raw preview must not supply answers");
  });

  test("uses details.unknownResult and exposes artifact recovery with stable testid", () => {
    const part: ErrorToolPart = {
      ...completed({
        isError: true,
        output: {
          ...baseOutput,
          recovery: { kind: "artifact", outputRef: "abcdefghijklmnopqrstuv", expiresAt: 10, canRead: true, canSearch: true },
        },
        details: { unknownResult: true },
      }),
      state: "error",
    };
    const element = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(element)).toContain("Result unknown");
    expect(findByTestId(element, "tool-output-open")).toBeDefined();
  });

  test("collapses to the summary row and expands through the one disclosure control", () => {
    stateValues = [false, false];
    stateIndex = 0;
    const collapsed = ToolCard({ part: completed({ isError: false, output: baseOutput }), projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(collapsed)).toContain("Show path");
    expect(textContent(collapsed)).not.toContain("canonical preview");
    const button = findByType(collapsed, "button")!;
    expect(button.props?.["aria-expanded"]).toBe(false);
    const summaryChildren = childrenOf(button);
    expect(isElement(summaryChildren[0]) ? summaryChildren[0].props?.["data-tool-visual-kind"] : undefined).toBe("completed");
    const lastSummaryChild = summaryChildren.at(-1);
    expect(isElement(lastSummaryChild) ? lastSummaryChild.type : undefined).toBe("svg");

    stateValues = [true, false];
    stateIndex = 0;
    const expanded = ToolCard({ part: completed({ isError: false, output: baseOutput }), projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(expanded)).toContain("canonical preview");
  });

  test("renders pending and running states without assuming input is present", () => {
    const pending: PendingToolPart = { type: "tool", id: "p", state: "pending", toolCallId: "p", toolName: "grep", createdAt: 1 };
    const running: RunningToolPart = { type: "tool", id: "r", state: "running", toolCallId: "r", toolName: "grep", input: { pattern: "needle" }, createdAt: 1, startedAt: 2 };
    const pendingElement = ToolCard({ part: pending, projectSlug: "demo", sessionId: "root-1" });
    const runningElement = ToolCard({ part: running, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(pendingElement)).toContain("Pending");
    expect(textContent(runningElement)).toContain("Running");
    expect(textContent(runningElement)).toContain("needle");
    const statusBase = findByData(runningElement, "data-tool-visual-kind", "loading");
    expect(statusBase).toBeDefined();
    expect(String(statusBase?.props?.className)).not.toContain("animate-");
    expect(findAllWithClass(runningElement, "animate-activity")).toHaveLength(1);
  });

  test("uses bash description, presents invalid inputs safely, and styles completed state", () => {
    const valid = ToolCard({ part: completed({ isError: false, output: baseOutput }), projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(valid)).toContain("Show path");
    expect(textContent(valid)).toContain("pwd");

    stateValues = [true, false];
    stateIndex = 0;
    const invalidPart: CompletedToolPart = { ...completed({ isError: false, output: baseOutput }), input: { command: "pwd" } };
    const invalid = ToolCard({ part: invalidPart, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(invalid)).toContain("Invalid bash input: missing required description");
    expect(textContent(valid)).toContain("Completed");
  });

  test("keeps strict diff and ask_user presentations out of collapsed cards", () => {
    const part = completed({
      isError: false,
      output: baseOutput,
      details: { presentations: [
        { kind: "diff", files: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, hunks: [] }] },
        { kind: "ask_user", answers: [{ question: "Proceed?", answers: ["Yes"] }] },
      ] },
    });
    stateValues = [false, false];
    stateIndex = 0;
    const collapsed = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(collapsed)).toContain("1 file · +2 −1");
    expect(textContent(collapsed)).not.toContain("Proceed?");

    stateValues = [true, false];
    stateIndex = 0;
    const expanded = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(expanded)).toContain("Proceed?");
    expect(textContent(expanded)).toContain("Yes");
  });

  test("renders MCP names and preserves error context for unknown results", () => {
    const part: ErrorToolPart = {
      ...completed({ isError: true, output: baseOutput, details: { unknownResult: true, error: { kind: "runtime", code: "TOOL_UNKNOWN_RESULT", name: "Interrupted" } } }),
      state: "error",
      toolName: "mcp__docs__lookup",
      input: {},
    };
    const element = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(element)).toContain("mcp__docs__lookup");
    expect(textContent(element)).toContain("Unknown");
    expect(textContent(element)).toContain("TOOL_UNKNOWN_RESULT");
    expect(findByData(element, "data-tool-visual-kind", "warning")).toBeDefined();
  });
});
