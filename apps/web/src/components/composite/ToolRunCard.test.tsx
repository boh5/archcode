import { beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  CompletedToolPart,
  ErrorToolPart,
  InterruptedToolPart,
  RunningToolPart,
  ToolPart,
} from "@archcode/protocol";
import type { ToolRunItem } from "../../lib/tool-runs";

interface ElementLike {
  type?: unknown;
  props?: Record<string, unknown> | null;
}

function isElement(value: unknown): value is ElementLike {
  return typeof value === "object" && value !== null && "props" in value;
}

function childrenOf(value: unknown): unknown[] {
  if (!isElement(value)) return [];
  const children = value.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function findButtons(value: unknown): ElementLike[] {
  const buttons: ElementLike[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!isElement(node)) return;
    if (node.type === "button") buttons.push(node);
    childrenOf(node).forEach(visit);
  };
  visit(value);
  return buttons;
}

function findByTestId(value: unknown, testId: string): ElementLike | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const match = findByTestId(child, testId);
      if (match) return match;
    }
    return undefined;
  }
  if (!isElement(value)) return undefined;
  if (value.props?.["data-testid"] === testId) return value;
  for (const child of childrenOf(value)) {
    const match = findByTestId(child, testId);
    if (match) return match;
  }
  return undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value.props?.children);
}

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, key?: unknown) => {
  const resolvedProps = props ?? {};
  if (typeof type === "function") return type(resolvedProps);
  return { type, props: resolvedProps, key };
});

let booleanStates: boolean[] = [];
let setters: ReturnType<typeof mock>[] = [];

mock.module("react", () => ({
  default: {},
  useState: <T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => {
    const setter = mock((_value: T | ((previous: T) => T)) => {});
    setters.push(setter);
    const value = typeof initial === "boolean" && booleanStates.length > 0
      ? booleanStates.shift() as T
      : initial;
    return [value, setter];
  },
  useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
  useRef: <T,>(initial: T) => ({ current: initial }),
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

const Icon = (props: Record<string, unknown>) => jsxDEV("svg", props);
mock.module("lucide-react", () => ({
  Ban: Icon,
  Brain: Icon,
  Calendar: Icon,
  Check: Icon,
  Circle: Icon,
  CircleAlert: Icon,
  ChevronDown: Icon,
  ChevronRight: Icon,
  CircleCheck: Icon,
  CircleDashed: Icon,
  CirclePause: Icon,
  CircleQuestionMark: Icon,
  CircleStop: Icon,
  CircleX: Icon,
  Clock: Icon,
  Clock3: Icon,
  FileText: Icon,
  GitBranch: Icon,
  Globe: Icon,
  Gauge: Icon,
  Handshake: Icon,
  LoaderCircle: Icon,
  MessageCircleQuestion: Icon,
  MessageSquare: Icon,
  Pencil: Icon,
  Plug: Icon,
  Search: Icon,
  Target: Icon,
  Terminal: Icon,
  TriangleAlert: Icon,
  Wrench: Icon,
  X: Icon,
  Zap: Icon,
}));

mock.module("../primitives/MarkdownContent", () => ({
  MarkdownContent: ({ children }: { children: unknown }) => jsxDEV("div", { children }),
}));

const { ToolRunCard } = await import("./ToolRunCard");

function completed(id: string, path: string, toolName = "file_read"): CompletedToolPart {
  return {
    type: "tool",
    id,
    state: "completed",
    toolCallId: `call-${id}`,
    toolName,
    input: { path },
    result: {
      isError: false,
      output: {
        preview: `contents of ${path}`,
        completeness: "complete",
        observed: { bytes: 10, lines: 1 },
        canonical: { bytes: 10, lines: 1 },
        stored: { bytes: 10, lines: 1 },
        omitted: { bytes: 0, lines: 0 },
        recovery: { kind: "none" },
      },
    },
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
  };
}

function running(id: string, path: string): RunningToolPart {
  return {
    type: "tool",
    id,
    state: "running",
    toolCallId: `call-${id}`,
    toolName: "file_read",
    input: { path },
    createdAt: 1,
    startedAt: 1,
  };
}

function failed(id: string, path: string): ErrorToolPart {
  const base = completed(id, path);
  return {
    ...base,
    state: "error",
    result: {
      ...base.result,
      isError: true,
    },
  };
}

function interrupted(id: string, path: string): InterruptedToolPart {
  return {
    type: "tool",
    id,
    state: "interrupted",
    toolCallId: `call-${id}`,
    toolName: "file_read",
    input: { path },
    createdAt: 1,
    startedAt: 1,
    endedAt: 2,
  };
}

function artifact(id: string, path: string): CompletedToolPart {
  const base = completed(id, path);
  return {
    ...base,
    result: {
      ...base.result,
      output: {
        ...base.result.output,
        recovery: {
          kind: "artifact",
          outputRef: "abcdefghijklmnopqrstuv",
          expiresAt: 10,
          canRead: true,
          canSearch: true,
        },
      },
    },
  };
}

function props(tools: ToolPart[], items?: ToolRunItem[]) {
  return {
    id: `tool-run:${tools[0]?.id ?? "empty"}`,
    tools,
    projectSlug: "project",
    sessionId: "session",
    items: items ?? tools.map((part) => ({
      message: { id: "message", role: "assistant" as const, parts: [part], createdAt: 1 },
      part,
    })),
  };
}

beforeEach(() => {
  booleanStates = [];
  setters = [];
});

describe("ToolRunCard", () => {
  test("shows the last authoritative tool while the run is active", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      completed("one", "a.ts"),
      running("two", "b.ts"),
    ]));

    expect(findButtons(element)).toHaveLength(1);
    expect(findButtons(element)[0]?.props?.["aria-controls"]).toBe("tool-run:one-body");
    expect(findButtons(element)[0]?.props?.["aria-label"]).toBe("2 tool calls, file_read, b.ts, Running");
    expect(findByTestId(element, "tool-run-representative")?.props?.["data-tool-id"]).toBe("two");
    expect(textContent(element)).toContain("file_read");
    expect(textContent(element)).toContain("b.ts");
    expect(textContent(element)).not.toContain("a.ts");
    expect(textContent(element)).not.toContain("Running");
  });

  test("selects the last active tool when a later parallel call has already settled", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      running("one", "a.ts"),
      completed("two", "b.ts"),
    ]));

    expect(textContent(element)).toContain("a.ts");
    expect(textContent(element)).not.toContain("b.ts");
    expect(textContent(element)).not.toContain("Running");
    expect(findButtons(element)[0]?.props?.["aria-label"]).toContain("Running");
    expect(findByTestId(element, "tool-run-representative")?.props?.["data-tool-id"]).toBe("one");
  });

  test("caps long canonical names so the active target keeps a readable column", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      { ...running("one", "react"), toolName: "mcp__context7__resolve-library-id" },
      { ...completed("two", "react-dom"), toolName: "mcp__context7__resolve-library-id" },
    ]));
    const representative = findByTestId(element, "tool-run-representative");
    const toolName = childrenOf(representative)[1];

    expect(isElement(toolName) && toolName.props?.className).toContain("max-w-[180px]");
    expect(isElement(toolName) && toolName.props?.className).toContain("truncate");
    expect(isElement(toolName) && toolName.props?.title).toBe("mcp__context7__resolve-library-id");
    expect(textContent(element)).toContain("react");
  });

  test("shows every exact tool name in execution order after every call settles", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      completed("one", "a.ts"),
      completed("two", "pattern", "grep"),
      completed("three", "bun test", "bash"),
    ]));
    const names = findByTestId(element, "tool-run-tool-names");

    expect(textContent(names)).toBe("file_read, grep, bash");
    expect(names?.props?.title).toBe("file_read, grep, bash");
    expect(names?.props?.className).toContain("truncate");
    expect(findButtons(element)[0]?.props?.["aria-label"]).toBe(
      "3 tool calls, file_read, grep, bash, Completed",
    );
    expect(textContent(element)).not.toContain("a.ts");
    expect(textContent(element)).not.toContain("Completed");
  });

  test("reports an aggregate error when an earlier tool failed", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      failed("one", "a.ts"),
      completed("two", "b.ts"),
    ]));
    const summary = findByTestId(element, "tool-run-tool-names");
    const summaryButton = findButtons(element)[0];

    expect(textContent(summary)).toBe("file_read, file_read");
    expect(textContent(element)).toContain("Error");
    expect(summaryButton?.props?.["aria-label"]).toBe(
      "2 tool calls, file_read, file_read, Error",
    );
  });

  test("reports interrupted calls distinctly in the grouped summary and rows", () => {
    booleanStates = [true];
    const element = ToolRunCard(props([
      completed("one", "a.ts"),
      interrupted("two", "b.ts"),
      interrupted("three", "c.ts"),
    ]));
    const summaryButton = findButtons(element)[0];

    expect(summaryButton?.props?.["aria-label"]).toBe(
      "3 tool calls, file_read, file_read, file_read, 2 Interrupted",
    );
    expect(textContent(element)).toContain("2 Interrupted");
    expect(textContent(element)).not.toContain("Completed");
    expect(textContent(findByTestId(element, "tool-run-list"))).toContain("Interrupted");
  });

  test("keeps the interrupted count visible when another grouped call failed", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      failed("one", "a.ts"),
      interrupted("two", "b.ts"),
    ]));
    expect(findButtons(element)[0]?.props?.["aria-label"]).toBe(
      "2 tool calls, file_read, file_read, Error, 1 Interrupted",
    );
    expect(textContent(element)).toContain("Error");
    expect(textContent(element)).toContain("Interrupted");
  });

  test("expands on demand to a flat tool-only ordered list", () => {
    booleanStates = [true];
    const first = completed("one", "a.ts");
    const second = completed("two", "b.ts");
    const message = { id: "message", role: "assistant" as const, parts: [first, second], createdAt: 1 };
    const element = ToolRunCard(props([first, second], [
      { message, part: first },
      { message, part: second },
    ]));
    const buttons = findButtons(element);

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.props?.["aria-expanded"]).toBe(true);
    expect(buttons[0]?.props?.className).toContain("max-w-[696px]");
    const list = findByTestId(element, "tool-run-list");
    const listText = textContent(list);
    expect(listText.indexOf("a.ts")).toBeLessThan(listText.indexOf("b.ts"));
    expect(list?.props?.role).toBe("list");
    expect(list?.props?.className).not.toContain("max-w-[720px]");
  });

  test("keeps per-call error state and artifact recovery inside an expanded run", () => {
    booleanStates = [true, false, false, true, false];
    const element = ToolRunCard(props([
      failed("one", "a.ts"),
      artifact("two", "large.txt"),
    ]));

    expect(textContent(findByTestId(element, "tool-run-list"))).toContain("Error");
    expect(findByTestId(element, "tool-output-open")).toBeDefined();
    expect(findByTestId(element, "tool-run-list")?.props?.role).toBe("list");
  });
});
