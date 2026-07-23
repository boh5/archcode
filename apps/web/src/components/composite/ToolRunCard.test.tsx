import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompletedToolPart, RunningToolPart, ToolPart } from "@archcode/protocol";
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

mock.module("./ReasoningBlock", () => ({
  ReasoningBlock: ({ part }: { part: { text: string } }) => jsxDEV("div", { children: part.text }),
}));
mock.module("./ToolCard", () => ({
  ToolCard: ({ part }: { part: ToolPart }) => jsxDEV("button", {
    "data-child-tool": part.id,
    "aria-expanded": false,
    children: `${part.toolName}:${"input" in part ? String((part.input as { filePath?: string }).filePath) : ""}`,
  }),
}));

const { ToolRunCard } = await import("./ToolRunCard");

function completed(id: string, filePath: string): CompletedToolPart {
  return {
    type: "tool",
    id,
    state: "completed",
    toolCallId: `call-${id}`,
    toolName: "file_read",
    input: { filePath },
    result: {
      isError: false,
      output: {
        preview: `contents of ${filePath}`,
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

function running(id: string, filePath: string): RunningToolPart {
  return {
    type: "tool",
    id,
    state: "running",
    toolCallId: `call-${id}`,
    toolName: "file_read",
    input: { filePath },
    createdAt: 1,
    startedAt: 1,
  };
}

function props(tools: ToolPart[], items?: ToolRunItem[]) {
  return {
    id: `tool-run:${tools[0]?.id ?? "empty"}`,
    tools,
    items: items ?? tools.map((part) => ({
      message: { id: "message", role: "assistant" as const, parts: [part], createdAt: 1 },
      part,
    })),
    projectSlug: "demo",
    sessionId: "root-1",
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
    const summaryChildren = childrenOf(findButtons(element)[0]);
    expect(isElement(summaryChildren[0]) ? summaryChildren[0].props?.["data-tool-visual-kind"] : undefined).toBe("loading");
    const lastSummaryChild = summaryChildren.at(-1);
    expect(isElement(lastSummaryChild) ? lastSummaryChild.type : undefined).toBe("svg");
    expect(textContent(element)).toContain("file_read");
    expect(textContent(element)).toContain("b.ts");
    expect(textContent(element)).not.toContain("a.ts");
    expect(textContent(element)).toContain("2");
    expect(textContent(element)).toContain("Running");
  });

  test("still selects the last tool for a parallel run when an earlier call remains active", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      running("one", "a.ts"),
      completed("two", "b.ts"),
    ]));

    expect(textContent(element)).toContain("b.ts");
    expect(textContent(element)).not.toContain("a.ts");
    expect(textContent(element)).toContain("Running");
  });

  test("returns to the first tool after every call settles", () => {
    booleanStates = [false];
    const element = ToolRunCard(props([
      completed("one", "a.ts"),
      completed("two", "b.ts"),
    ]));

    expect(textContent(element)).toContain("a.ts");
    expect(textContent(element)).not.toContain("b.ts");
    expect(textContent(element)).toContain("Completed");
  });

  test("expands to a flat ordered list whose child tools remain collapsed", () => {
    booleanStates = [true];
    const first = completed("one", "a.ts");
    const second = completed("two", "b.ts");
    const message = { id: "message", role: "assistant" as const, parts: [first, second], createdAt: 1 };
    const element = ToolRunCard(props([first, second], [
      { message, part: first },
      {
        message,
        part: { type: "reasoning", id: "reason", text: "Reasoning detail", createdAt: 1, completedAt: 1 },
      },
      { message, part: second },
    ]));
    const buttons = findButtons(element);

    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.props?.["aria-expanded"]).toBe(true);
    expect(buttons[1]?.props?.["aria-expanded"]).toBe(false);
    expect(buttons[2]?.props?.["aria-expanded"]).toBe(false);
    expect(textContent(element).indexOf("a.ts")).toBeLessThan(textContent(element).indexOf("Reasoning detail"));
    expect(textContent(element).indexOf("Reasoning detail")).toBeLessThan(textContent(element).indexOf("b.ts"));
  });
});
