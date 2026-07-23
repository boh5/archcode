import { describe, expect, mock, test } from "bun:test";
import { CornerDownRight } from "lucide-react";

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

const { DelegationCard } = await import("./DelegationCard");

// ─── Tests ───

describe("DelegationCard", () => {
  const baseProps = {
    sessionId: "session-child-1",
    focusStoreSessionId: "session-root-1",
    taskTitle: "Find relevant files",
    visualKind: "running" as const,
    executionStatusLabel: "Running",
    startedAt: Date.now() - 60000,
    hasInput: true,
    input: {
      agent_type: "explore",
      profile: "fast",
      skills: ["analyze-work"],
      title: "Find relevant files",
      objective: "Searching for relevant files",
      background: true,
    },
    projectSlug: "my-project",
  };

  test("renders every recorded delegation key without display aliases", () => {
    const result = DelegationCard(baseProps);
    const text = textContent(result);
    expect(text).toContain("delegate");
    expect(text).toContain("agent_type");
    expect(text).toContain("explore");
    expect(text).toContain("profile");
    expect(text).toContain("fast");
    expect(text).toContain("skills");
    expect(text).toContain("analyze-work");
    expect(text).toContain("title");
    expect(text).toContain("background");
    expect(text).toContain("true");
    expect(text).toContain("objective");
    expect(text).toContain("Find relevant files");
    expect(text).toContain("Searching for relevant files");
    expect(text).not.toContain("Agent");
    expect(text).not.toContain("Profile");
    expect(text).not.toContain("Skills");
    expect(text).not.toContain("Goal");
    expect(text).not.toContain("Mode");
    expect(text).not.toContain("Foreground");
    expect(findAll(result, (element) => element.type === CornerDownRight)).toHaveLength(1);
    expect(findAllWithClass(result, "bg-agent-")).toHaveLength(0);
  });

  test("renders running status with elapsed time", () => {
    const result = DelegationCard(baseProps);
    const text = textContent(result);
    expect(text).toContain("Running");
    expect(findAll(result, (element) => element.props?.["data-child-visual-kind"] === "running")).toHaveLength(1);
  });

  test("renders execution completion", () => {
    const result = DelegationCard({ ...baseProps, visualKind: "completed", executionStatusLabel: "Completed" });
    const text = textContent(result);
    expect(text).toContain("Completed");
  });

  test("renders a unified stopped state with its specific reason", () => {
    const result = DelegationCard({
      ...baseProps,
      visualKind: "stopped",
      executionStatusLabel: "Stopped",
      executionStatusDetail: "Cancelled",
    });
    expect(textContent(result)).toContain("Stopped");
    expect(textContent(result)).toContain("Cancelled");
    expect(findAll(result, (element) => element.props?.["data-child-visual-kind"] === "stopped")).toHaveLength(1);
  });

  test("renders the raw background parameter when it is false", () => {
    const result = DelegationCard({
      ...baseProps,
      input: { ...(baseProps.input as Record<string, unknown>), background: false },
    });
    const text = textContent(result);
    expect(text).toContain("background");
    expect(text).toContain("false");
    expect(text).not.toContain("Foreground");
    expect(text).not.toContain("Mode");
  });

  test("child navigation is a native keyboard-accessible button", () => {
    const result = DelegationCard(baseProps);
    const buttons = findAll(result, (element) => element.type === "button");
    expect(buttons.length).toBe(1);
    expect(textContent(buttons[0])).toContain("Open child session");
    expect(buttons[0]?.props?.type).toBe("button");
    const onClick = buttons[0]?.props?.onClick as (() => void) | undefined;
    expect(onClick).toBeFunction();
    onClick!();
    expect(mockGetWebSessionStore).toHaveBeenCalledWith("session-root-1", "my-project");
    expect(mockSetFocusSessionId).toHaveBeenCalledWith("session-child-1");
  });

  test("omits absent metadata and navigation when no child is linked", () => {
    const result = DelegationCard({
      ...baseProps,
      sessionId: "",
      taskTitle: undefined,
      hasInput: false,
      input: undefined,
      canNavigate: false,
    });
    const text = textContent(result);
    expect(text).toContain("Child session pending");
    expect(text).not.toContain("Agent");
    expect(text).not.toContain("Profile");
    expect(text).not.toContain("background");
    expect(findAll(result, (element) => element.type === "button")).toHaveLength(0);
  });
});
