import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DashboardGoal, DashboardHitlItem } from "../api/types";

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
  const children = value.props?.children;
  if (children === undefined || children === null) return [];
  return Array.isArray(children) ? children : [children];
}

function textContent(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (!isElement(value)) return "";
  return textContent(value.props?.children);
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

function findByTestId(value: unknown, testId: string): ElementLike | undefined {
  return findAll(value, (el) => el.props?.["data-testid"] === testId)[0];
}

function findAllByTestId(value: unknown, testId: string): ElementLike[] {
  return findAll(value, (el) => el.props?.["data-testid"] === testId);
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

mock.module("react", () => {
  const createElement = (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => {
    const resolvedProps = props ?? {};
    const childArray = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
    if (childArray !== undefined) {
      resolvedProps.children = childArray;
    }
    if (typeof type === "function") {
      return type(resolvedProps);
    }
    return { type, props: resolvedProps, key: undefined };
  };
  return {
    default: { createElement },
    createElement,
    useState,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (_callback: () => void | (() => void), _deps?: unknown[]) => {},
    useRef: <T,>(initial: T) => ({ current: initial }),
    useMemo: <T,>(factory: () => T) => factory(),
    createContext: <T,>(_defaultValue: T) => ({ Provider: ({ children }: { children: unknown }) => children }),
    useContext: <T,>(_ctx: T) => ({}),
    forwardRef: (render: (props: unknown, ref: unknown) => unknown) => {
      const Comp = (props: unknown) => render(props, null);
      Comp.displayName = "forwardRef";
      return Comp;
    },
  };
});

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

const useActiveGoals = mock(() => ({ data: [], isLoading: false }));
const useHitl = mock(() => ({ data: [], isLoading: false }));

mock.module("../api/queries", () => ({
  useActiveGoals,
  useHitl,
  queryKeys: {
    projects: ["projects"],
    goals: ["goals"],
    activeGoals: ["goals", "active"],
    projectGoals: (slug: string) => ["projects", slug, "goals"],
    goal: (slug: string, goalId: string) => ["projects", slug, "goals", goalId],
    hitl: ["hitl", "pending"],
    projectHitl: (slug: string) => ["projects", slug, "hitl"],
    sessions: (slug: string) => ["projects", slug, "sessions"],
    session: (slug: string, sessionId: string) => ["projects", slug, "sessions", sessionId],
    focusedSession: (slug: string, sessionId: string) => ["projects", slug, "sessions", sessionId, "focused"],
    tree: (slug: string, rootSessionId: string) => ["projects", slug, "sessions", rootSessionId, "tree"],
    diff: (slug: string) => ["projects", slug, "diff"],
    directories: {
      list: (path: string, limit?: number) => ["directories", "list", path, limit],
      search: (query: string, limit?: number) => ["directories", "search", query, limit],
    },
  },
}));

const respondHitlMock = mock((_args: unknown) => {});
const cancelHitlMock = mock((_args: unknown) => {});
mock.module("../api/mutations", () => ({
  useRespondHitl: () => ({ mutate: respondHitlMock, mutateAsync: respondHitlMock }),
  useCancelHitl: () => ({ mutate: cancelHitlMock, mutateAsync: cancelHitlMock }),
}));

const { Dashboard } = await import("./dashboard");

// ─── Factory helpers ───

function makeGoal(overrides: Partial<DashboardGoal> = {}): DashboardGoal {
  return {
    id: "goal-1",
    projectId: "demo",
    title: "Test Goal",
    status: "running",
    phase: "build",
    doneConditions: [],
    doneResults: {},
    reviewerAgent: "reviewer",
    retryPolicy: { maxRetries: 3, backoffMs: 5000, escalateOnFailure: true },
    retryCount: 0,
    approvalPoints: [],
    author: "user",
    childSessionIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    projectSlug: "demo",
    projectName: "Demo Project",
    ...overrides,
  };
}

function makeHitlItem(overrides: Partial<DashboardHitlItem> = {}): DashboardHitlItem {
  return {
    hitlId: "hitl-1",
    sessionId: "session-1",
    kind: "approval",
    payload: { kind: "approval", action: "run_tool", context: {}, title: "Approve?", message: "Please approve" },
    trigger: { projectSlug: "demo", goalId: "goal-1", source: "test" },
    createdAt: 1_000,
    projectSlug: "demo",
    projectName: "Demo Project",
    status: "pending",
    ...overrides,
  };
}

// ─── Tests ───

describe("Dashboard", () => {
  beforeEach(() => {
    useActiveGoals.mockReturnValue({ data: [], isLoading: false } as never);
    useHitl.mockReturnValue({ data: [], isLoading: false } as never);
  });

  test("renders data-testid='dashboard-active-goals' section", () => {
    const result = Dashboard();
    expect(findByTestId(result, "dashboard-active-goals")).toBeDefined();
  });

  test("renders data-testid='dashboard-approval-queue' section", () => {
    const result = Dashboard();
    expect(findByTestId(result, "dashboard-approval-queue")).toBeDefined();
  });

  test("renders active goals from two projects", () => {
    const goal1 = makeGoal({ id: "goal-a", title: "Alpha Goal", projectSlug: "alpha", projectName: "Alpha Project", status: "running", phase: "build" });
    const goal2 = makeGoal({ id: "goal-b", title: "Beta Goal", projectSlug: "beta", projectName: "Beta Project", status: "verifying", phase: "review" });
    useActiveGoals.mockReturnValue({ data: [goal1, goal2], isLoading: false } as never);

    const result = Dashboard();
    const goalsSection = findByTestId(result, "dashboard-active-goals");
    const text = textContent(goalsSection);
    expect(text).toContain("Alpha Goal");
    expect(text).toContain("Alpha Project");
    expect(text).toContain("running");
    expect(text).toContain("Build");
    expect(text).toContain("Beta Goal");
    expect(text).toContain("Beta Project");
    expect(text).toContain("verifying");
    expect(text).toContain("Review");
  });

  test("renders HITL cards in approval queue", () => {
    const hitl1 = makeHitlItem({ hitlId: "h1", kind: "approval", payload: { kind: "approval", action: "deploy", context: {}, title: "Deploy?", message: "Confirm" }, projectName: "Alpha Project" });
    const hitl2 = makeHitlItem({ hitlId: "h2", kind: "question", payload: { kind: "question", options: [{ label: "Yes" }], title: "Which option?", message: "Pick one" }, projectName: "Beta Project" });
    useHitl.mockReturnValue({ data: [hitl1, hitl2], isLoading: false } as never);

    const result = Dashboard();
    const queueSection = findByTestId(result, "dashboard-approval-queue");
    const cards = findAllByTestId(queueSection, "hitl-card");
    expect(cards).toHaveLength(2);
  });

  test("shows empty state when no active goals", () => {
    useActiveGoals.mockReturnValue({ data: [], isLoading: false } as never);
    const result = Dashboard();
    const goalsSection = findByTestId(result, "dashboard-active-goals");
    const text = textContent(goalsSection);
    expect(text.toLowerCase()).toContain("no active");
  });

  test("shows empty state when no pending HITL", () => {
    useHitl.mockReturnValue({ data: [], isLoading: false } as never);
    const result = Dashboard();
    const queueSection = findByTestId(result, "dashboard-approval-queue");
    const text = textContent(queueSection);
    expect(text.toLowerCase()).toContain("no pending");
  });

  test("shows loading state for active goals", () => {
    useActiveGoals.mockReturnValue({ data: undefined, isLoading: true } as never);
    const result = Dashboard();
    const goalsSection = findByTestId(result, "dashboard-active-goals");
    const text = textContent(goalsSection);
    expect(text.toLowerCase()).toContain("loading");
  });

  test("shows loading state for approval queue", () => {
    useHitl.mockReturnValue({ data: undefined, isLoading: true } as never);
    const result = Dashboard();
    const queueSection = findByTestId(result, "dashboard-approval-queue");
    const text = textContent(queueSection);
    expect(text.toLowerCase()).toContain("loading");
  });

  test("renders goal status and phase badges", () => {
    const goal = makeGoal({ status: "paused", phase: "plan" });
    useActiveGoals.mockReturnValue({ data: [goal], isLoading: false } as never);

    const result = Dashboard();
    const goalsSection = findByTestId(result, "dashboard-active-goals");
    const text = textContent(goalsSection);
    expect(text).toContain("paused");
    expect(text).toContain("Plan");
  });

  test("renders goal retry count when > 0", () => {
    const goal = makeGoal({ retryCount: 2 });
    useActiveGoals.mockReturnValue({ data: [goal], isLoading: false } as never);

    const result = Dashboard();
    const goalsSection = findByTestId(result, "dashboard-active-goals");
    const text = textContent(goalsSection);
    expect(text).toContain("retry");
    expect(text).toContain("2");
  });

  test("renders dashboard header", () => {
    const result = Dashboard();
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("dashboard");
  });
});