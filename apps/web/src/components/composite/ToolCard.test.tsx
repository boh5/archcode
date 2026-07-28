import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompletedToolPart, ErrorToolPart, FinalizedToolResult, InterruptedToolPart, PendingToolPart, RunningToolPart } from "@archcode/protocol";

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
function findByProp(value: unknown, name: string, expected: unknown): ElementLike | undefined {
  if (isElement(value) && value.props?.[name] === expected) return value;
  for (const child of childrenOf(value)) {
    const found = findByProp(child, name, expected);
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
  DiffView: ({ files, defaultExpanded }: { files: Array<{ path: string }>; defaultExpanded?: boolean }) => ({
    type: "diff",
    props: { "data-default-expanded": defaultExpanded, children: files.map((file) => file.path).join(",") },
  }),
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
  test("renders Bash output as a terminal with concise process details", () => {
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
    expect(text).not.toContain("observed 200 B / 20 lines");
    expect(text).not.toContain("canonical 180 B / 18 lines");
    expect(text).toContain("60 B / 6 lines omitted");
    expect(text).toContain("exit 0");
    expect(text).toContain("42 ms");
  });

  test("renders diff and ask_user only from strict presentations", () => {
    const element = ToolCard({
      part: {
        ...completed({
          isError: false,
          output: { ...baseOutput, preview: "raw preview must not supply answers" },
          details: {
            presentations: [
              {
                kind: "diff",
                files: [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1, hunks: [] }],
                simplified: true,
                truncated: true,
              },
              { kind: "ask_user", answers: [{ question: "Proceed?", answers: ["Yes"] }] },
            ],
          },
        }),
        toolName: "ask_user",
        input: {
          questions: [{
            header: "Scope",
            question: "Proceed?",
            options: [{ label: "Yes", description: "Continue" }],
          }],
        },
      },
      projectSlug: "demo",
      sessionId: "root-1",
    });
    const text = textContent(element);
    expect(text).toContain("1 file · +2 −1");
    expect(text).toContain("showing a simplified, truncated diff");
    expect(findByTestId(element, "tool-diff-disclosure")).toBeDefined();
    expect(text).toContain("Proceed?");
    expect(text).toContain("Yes");
    expect(text).not.toContain("questions:");
    expect(text).not.toContain("header:");
    expect(text).not.toContain("options:");
    expect(text).not.toContain("description:");
    expect(text).not.toContain("raw preview must not supply answers");
    expect(findByType(element, "diff")?.props?.["data-default-expanded"]).toBe(true);
  });

  test("caps a long canonical tool name while preserving its full title", () => {
    const element = ToolCard({
      part: {
        type: "tool",
        id: "tool-long",
        state: "running",
        toolCallId: "call-long",
        toolName: "mcp__context7__resolve-library-id",
        input: { libraryName: "react" },
        createdAt: 1,
        startedAt: 2,
      },
      projectSlug: "demo",
      sessionId: "root-1",
    });
    const summary = findByProp(element, "data-tool-summary-static", "");
    const toolName = findByProp(summary, "title", "mcp__context7__resolve-library-id");

    expect(summary?.props?.className).toContain("minmax(0,112px)");
    expect(isElement(toolName) && toolName.props?.className).toContain("truncate");
    expect(isElement(toolName) && toolName.props?.title).toBe("mcp__context7__resolve-library-id");
    expect(findByType(element, "button")).toBeUndefined();
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
    expect(textContent(collapsed)).toContain("pwd");
    expect(textContent(collapsed)).not.toContain("canonical preview");
    const button = findByType(collapsed, "button")!;
    expect(button.props?.["aria-expanded"]).toBe(false);
    expect(button.props?.["aria-controls"]).toBe("tool-1-details");
    expect(findByType(button, "svg")).toBeDefined();
    expect(findByProp(button, "title", "pwd")).toBeDefined();

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
    expect(findByType(pendingElement, "button")).toBeUndefined();
    expect(findByType(runningElement, "button")).toBeUndefined();
    expect(findByProp(runningElement, "data-tool-summary-static", "")?.props?.["aria-label"]).toContain("Running");
  });

  test("renders interrupted as a stopped non-final state", () => {
    const interrupted: InterruptedToolPart = {
      type: "tool",
      id: "interrupted",
      state: "interrupted",
      toolCallId: "interrupted",
      toolName: "bash",
      input: { command: "sleep 10", description: "Wait" },
      createdAt: 1,
      startedAt: 2,
      endedAt: 3,
    };
    const element = ToolCard({
      part: interrupted,
      projectSlug: "demo",
      sessionId: "root-1",
    });
    expect(textContent(element)).toContain("Interrupted");
    expect(textContent(element)).not.toContain("Completed");
    expect(textContent(element)).not.toContain("Error");
    expect(findByProp(element, "data-tool-summary-static", "")?.props?.["aria-label"]).toContain("Interrupted");
  });

  test("shows the exact Bash command and does not duplicate runtime schema validation in Web", () => {
    const valid = ToolCard({ part: completed({ isError: false, output: baseOutput }), projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(valid)).toContain("pwd");
    expect(textContent(valid)).not.toContain("Show path");

    stateValues = [true, false];
    stateIndex = 0;
    const invalidPart: CompletedToolPart = { ...completed({ isError: false, output: baseOutput }), input: { command: "pwd" } };
    const invalid = ToolCard({ part: invalidPart, projectSlug: "demo", sessionId: "root-1" });
    expect(textContent(invalid)).toContain("pwd");
    expect(textContent(invalid)).not.toContain("Invalid bash input: missing required description");
    expect(textContent(valid)).not.toContain("Completed");
  });

  test("prefers the exact Bash command over a human description", () => {
    const element = ToolCard({
      part: {
        ...completed({ isError: false, output: baseOutput }),
        input: {
          description: "Run the focused verification",
          command: "bun test ./src/focused.test.ts",
        },
      },
      projectSlug: "demo",
      sessionId: "session-1",
    });

    expect(textContent(element)).toContain("bun test ./src/focused.test.ts");
    expect(textContent(element)).not.toContain("Run the focused verification");
  });

  test("renders authoritative runtime schema errors from the finalized result", () => {
    const part: ErrorToolPart = {
      ...completed({
        isError: true,
        output: { ...baseOutput, preview: "Required field description is missing" },
        details: {
          error: {
            kind: "validation",
            code: "TOOL_SCHEMA_INVALID_INPUT",
            name: "ToolInputValidationError",
          },
        },
      }),
      state: "error",
      input: { command: "pwd" },
    };

    const element = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    const text = textContent(element);
    expect(text).toContain("TOOL_SCHEMA_INVALID_INPUT");
    expect(text).toContain("Required field description is missing");
  });

  test("keeps a bounded ordinary-tool error preview available without raw input tables", () => {
    const part: ErrorToolPart = {
      ...completed({
        isError: true,
        output: { ...baseOutput, preview: "README.md could not be read" },
      }),
      state: "error",
      toolName: "file_read",
      input: { path: "README.md" },
    };

    const element = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    const text = textContent(element);
    expect(text).toContain("README.md could not be read");
    expect(text).not.toContain("path:");
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

  test("summarizes ordinary MCP calls without exposing a raw argument table", () => {
    const part: CompletedToolPart = {
      ...completed({ isError: false, output: baseOutput }),
      toolName: "mcp__docs__lookup",
      input: {
        query: "React",
        libraryName: "react",
        count: 3,
      },
    };
    const element = ToolCard({ part, projectSlug: "demo", sessionId: "root-1" });
    const text = textContent(element);
    expect(text).toContain("mcp__docs__lookup");
    expect(text).toContain("React");
    expect(text).not.toContain("query:");
    expect(text).not.toContain("libraryName:");
    expect(text).not.toContain("count:");
    expect(text).not.toContain("tool:");
    expect(text).not.toContain("input:");
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
  });
});
