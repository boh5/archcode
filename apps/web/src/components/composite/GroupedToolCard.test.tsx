import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CompletedToolPart } from "@archcode/protocol";

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

const { GroupedToolCard } = await import("./GroupedToolCard");

function makeTool(id: string, filePath: string): CompletedToolPart {
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
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
  };
}

beforeEach(() => {
  booleanStates = [];
  setters = [];
});

describe("GroupedToolCard", () => {
  test("collapsed group renders only the batch summary", () => {
    booleanStates = [false];
    const el = GroupedToolCard({ tools: [makeTool("one", "a.ts"), makeTool("two", "b.ts")], projectSlug: "demo", sessionId: "root-1" });

    expect(findButtons(el)).toHaveLength(1);
    expect(textContent(el)).toContain("Read 2 items");
    expect(textContent(el)).not.toContain("file_read");
    expect(textContent(el)).not.toContain("a.ts");
    expect(textContent(el)).not.toContain("b.ts");
  });

  test("expanded group renders independently collapsible child summary rows", () => {
    booleanStates = [true, false, false];
    const el = GroupedToolCard({ tools: [makeTool("one", "a.ts"), makeTool("two", "b.ts")], projectSlug: "demo", sessionId: "root-1" });
    const buttons = findButtons(el);

    expect(buttons).toHaveLength(3);
    expect(buttons[0]?.props?.["aria-expanded"]).toBe(true);
    expect(buttons[1]?.props?.["aria-expanded"]).toBe(false);
    expect(buttons[2]?.props?.["aria-expanded"]).toBe(false);
    expect(textContent(el)).toContain("a.ts");
    expect(textContent(el)).toContain("b.ts");
    expect(textContent(el)).not.toContain("contents of a.ts");
    expect(textContent(el)).not.toContain("contents of b.ts");

    (buttons[1]?.props?.onClick as (() => void))();
    expect(setters[1]).toHaveBeenCalledTimes(1);
    expect(setters[0]).not.toHaveBeenCalled();
    expect(setters[2]).not.toHaveBeenCalled();
  });
});
