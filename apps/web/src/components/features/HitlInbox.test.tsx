import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HitlProjection } from "../../api/types";

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

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, _key?: unknown) => ({
  type,
  props: props ?? {},
  key: undefined,
}));

mock.module("react", () => ({
  default: {},
  useState: <T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => {
    const setState = mock((_value: T | ((previous: T) => T)) => {});
    return [initial, setState];
  },
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
}));

mock.module("react/jsx-dev-runtime", () => ({
  Fragment,
  jsxDEV,
  jsx: jsxDEV,
  jsxs: jsxDEV,
}));

mock.module("react-router-dom", () => ({
  Link: ({ children, className, to, ...props }: { children?: unknown; className?: string; to: string; [key: string]: unknown }) =>
    jsxDEV("a", { ...props, href: to, className, children }),
}));

const respondHitl = mock((_args: { identity: { owner: HitlProjection["owner"]; hitlId: string }; body: unknown }) => {});
const cancelHitl = mock((_args: { identity: { owner: HitlProjection["owner"]; hitlId: string }; reason?: string }) => {});

mock.module("../../api/mutations", () => ({
  useRespondHitl: () => ({ mutate: respondHitl, mutateAsync: respondHitl, isPending: false }),
  useCancelHitl: () => ({ mutate: cancelHitl, mutateAsync: cancelHitl, isPending: false }),
}));

const { HitlInbox, HitlCard } = await import("./HitlCard");

function makeProjection(overrides: Partial<HitlProjection> = {}): HitlProjection {
  return {
    hitlId: "hitl-1",
    project: { slug: "demo", name: "Demo Project" },
    owner: { projectSlug: "demo", ownerType: "session", ownerId: "session-1" },
    source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
    status: "pending",
    displayPayload: { title: "Approve?", summary: "Please approve", redacted: true },
    allowedActions: ["approve", "deny", "cancel"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("HitlInbox", () => {
  beforeEach(() => {
    respondHitl.mockClear();
    cancelHitl.mockClear();
  });

  test("renders data-testid='hitl-inbox'", () => {
    const result = HitlInbox({ projections: [] });
    const inbox = findByTestId(result, "hitl-inbox");
    expect(inbox).toBeDefined();
  });

  test("renders empty state when no projections", () => {
    const result = HitlInbox({ projections: [] });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("no pending approvals");
  });

  test("returns null when empty and hideWhenEmpty is enabled", () => {
    const result = HitlInbox({ projections: [], hideWhenEmpty: true });
    expect(result).toBeNull();
  });

  test("renders custom empty message", () => {
    const result = HitlInbox({ projections: [], emptyMessage: "No HITL for this loop" });
    const text = textContent(result);
    expect(text).toContain("No HITL for this loop");
  });

  test("renders HitlCard for each projection", () => {
    const projections = [
      makeProjection({ hitlId: "hitl-a", displayPayload: { title: "Approval A", redacted: true } }),
      makeProjection({ hitlId: "hitl-b", displayPayload: { title: "Approval B", redacted: true } }),
    ];
    const result = HitlInbox({ projections });
    const cards = findAll(result, (el) => el.type === HitlCard);
    expect(cards).toHaveLength(2);
  });

  test("deduplicates projections by owner-qualified identity", () => {
    const projections = [
      makeProjection({ hitlId: "hitl-dup", displayPayload: { title: "Dup A", redacted: true } }),
      makeProjection({ hitlId: "hitl-dup", displayPayload: { title: "Dup B", redacted: true } }),
    ];
    const result = HitlInbox({ projections });
    const cards = findAll(result, (el) => el.type === HitlCard);
    expect(cards).toHaveLength(1);
  });

  test("renders the same hitlId under different owners separately", () => {
    const projections = [
      makeProjection({ hitlId: "shared-id", owner: { projectSlug: "demo", ownerType: "session", ownerId: "session-a" } }),
      makeProjection({ hitlId: "shared-id", owner: { projectSlug: "demo", ownerType: "session", ownerId: "session-b" } }),
    ];

    const result = HitlInbox({ projections });

    expect(findAll(result, (el) => el.type === HitlCard)).toHaveLength(2);
  });

  test("filters resume_claimed projections after the user responds", () => {
    const projections = [
      makeProjection({ hitlId: "hitl-pending", status: "pending" }),
      makeProjection({ hitlId: "hitl-claimed", status: "resume_claimed" }),
    ];

    const result = HitlInbox({ projections });

    const cards = findAll(result, (el) => el.type === HitlCard);
    expect(cards).toHaveLength(1);
    const cardProps = cards[0]?.props as { projection: HitlProjection } | undefined;
    expect(cardProps?.projection.hitlId).toBe("hitl-pending");
  });

  test("shows same hitlId on child Session and parent Goal/Loop pages without duplicates within a page", () => {
    const sharedProjection = makeProjection({
      hitlId: "shared-hitl",
      owner: { projectSlug: "demo", ownerType: "session", ownerId: "child-session" },
      ancestry: { goalId: "goal-1", loopId: "loop-1" },
    });
    const result = HitlInbox({ projections: [sharedProjection, sharedProjection] });
    const cards = findAll(result, (el) => el.type === HitlCard);
    expect(cards).toHaveLength(1);
  });

  test("renders owner context with ancestry for parent surface display", () => {
    const projection = makeProjection({
      hitlId: "child-hitl",
      owner: { projectSlug: "demo", ownerType: "session", ownerId: "child-session" },
      ancestry: { loopId: "loop-1", goalId: "goal-1" },
    });
    const result = HitlInbox({ projections: [projection] });
    const cards = findAll(result, (el) => el.type === HitlCard);
    expect(cards).toHaveLength(1);
    const cardProps = cards[0]?.props as { projection: HitlProjection } | undefined;
    expect(cardProps?.projection.owner.ownerId).toBe("child-session");
    expect(cardProps?.projection.ancestry?.loopId).toBe("loop-1");
    expect(cardProps?.projection.ancestry?.goalId).toBe("goal-1");
  });

  test("renders loading state", () => {
    const result = HitlInbox({ projections: [], isLoading: true });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("loading");
  });

  test("renders loading state when hideWhenEmpty is enabled", () => {
    const result = HitlInbox({ projections: [], isLoading: true, hideWhenEmpty: true });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("loading");
  });

  test("uses custom test id", () => {
    const result = HitlInbox({ projections: [makeProjection()], testId: "dashboard-approval-queue" });
    expect(findByTestId(result, "dashboard-approval-queue")).toBeDefined();
  });

  test("renders title with count badge when projections exist", () => {
    const projections = [
      makeProjection({ hitlId: "hitl-a" }),
      makeProjection({ hitlId: "hitl-b" }),
    ];
    const result = HitlInbox({ projections });
    const text = textContent(result);
    expect(text).toContain("Approval Queue");
    expect(text).toContain("2");
  });
});
