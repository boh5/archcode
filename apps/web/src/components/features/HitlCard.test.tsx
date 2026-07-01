import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { DashboardHitlItem } from "../../api/types";

// ─── Test helpers (shared JSX tree-walking utilities) ───

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

function findAllWithClass(value: unknown, className: string): ElementLike[] {
  return findAll(value, (el) => {
    const cls = el.props?.className;
    return typeof cls === "string" && cls.includes(className);
  });
}

// ─── Mocks ───

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

const respondHitl = mock((_args: { hitlId: string; body: unknown }) => {});
const cancelHitl = mock((_args: { hitlId: string; reason?: string }) => {});

mock.module("../../api/mutations", () => ({
  useRespondHitl: () => ({ mutate: respondHitl, mutateAsync: respondHitl }),
  useCancelHitl: () => ({ mutate: cancelHitl, mutateAsync: cancelHitl }),
}));

const { HitlCard } = await import("./HitlCard");

// ─── Factory helpers ───

function makeHitlItem(overrides: Partial<DashboardHitlItem> = {}): DashboardHitlItem {
  return {
    hitlId: "hitl-1",
    sessionId: "session-1",
    kind: "approval",
    payload: { kind: "approval", action: "run_tool", context: {} },
    trigger: { projectSlug: "demo", goalId: "goal-1", source: "test" },
    createdAt: 1_000,
    projectSlug: "demo",
    projectName: "Demo Project",
    status: "pending",
    ...overrides,
  };
}

// ─── Tests ───

describe("HitlCard", () => {
  beforeEach(() => {
    respondHitl.mockClear();
    cancelHitl.mockClear();
  });

  test("renders data-testid='hitl-card'", () => {
    const item = makeHitlItem();
    const result = HitlCard({ item });
    const card = findByTestId(result, "hitl-card");
    expect(card).toBeDefined();
  });

  test("renders kind label for approval", () => {
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("approval");
  });

  test("renders kind label for question", () => {
    const item = makeHitlItem({
      kind: "question",
      payload: { kind: "question", options: [{ label: "Yes" }, { label: "No" }] },
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("question");
  });

  test("renders kind label for review", () => {
    const item = makeHitlItem({
      kind: "review",
      payload: { kind: "review", artifacts: [{ path: "/src/index.ts", description: "Main file" }] },
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("review");
  });

  test("renders prompt text from payload title/message", () => {
    const item = makeHitlItem({
      payload: { kind: "approval", action: "deploy", context: {}, title: "Deploy to prod?", message: "Confirm deployment" },
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("Deploy to prod?");
    expect(text).toContain("Confirm deployment");
  });

  test("renders project name", () => {
    const item = makeHitlItem({ projectName: "My Awesome Project" });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("My Awesome Project");
  });

  test("renders approve and deny buttons for approval kind", () => {
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-approve-button")).toBeDefined();
    expect(findByTestId(result, "hitl-deny-button")).toBeDefined();
  });

  test("renders cancel button", () => {
    const item = makeHitlItem();
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-cancel-button")).toBeDefined();
  });

  test("approve button calls respondHitl with decision=approve", () => {
    const item = makeHitlItem({ kind: "approval", hitlId: "hitl-approve-test" });
    const result = HitlCard({ item });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { hitlId: string; body: { decision?: string } };
    expect(callArg.hitlId).toBe("hitl-approve-test");
    expect(callArg.body.decision).toBe("approve");
  });

  test("deny button calls respondHitl with decision=deny", () => {
    const item = makeHitlItem({ kind: "approval", hitlId: "hitl-deny-test" });
    const result = HitlCard({ item });
    const denyBtn = findByTestId(result, "hitl-deny-button");
    const onClick = denyBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { hitlId: string; body: { decision?: string } };
    expect(callArg.hitlId).toBe("hitl-deny-test");
    expect(callArg.body.decision).toBe("deny");
  });

  test("cancel button calls cancelHitl", () => {
    const item = makeHitlItem({ hitlId: "hitl-cancel-test" });
    const result = HitlCard({ item });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    const onClick = cancelBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(cancelHitl).toHaveBeenCalledTimes(1);
    const callArg = cancelHitl.mock.calls[0]?.[0] as unknown as { hitlId: string };
    expect(callArg.hitlId).toBe("hitl-cancel-test");
  });

  test("review kind renders approve/reject/request-changes buttons", () => {
    const item = makeHitlItem({
      kind: "review",
      payload: { kind: "review", artifacts: [{ path: "/src/x.ts", description: "x" }] },
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("approve");
    expect(text.toLowerCase()).toContain("reject");
    expect(text.toLowerCase()).toContain("request changes");
  });

  test("review approve calls respondHitl with verdict=approve", () => {
    const item = makeHitlItem({
      kind: "review",
      hitlId: "review-1",
      payload: { kind: "review", artifacts: [] },
    });
    const result = HitlCard({ item });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { hitlId: string; body: { verdict?: string } };
    expect(callArg.hitlId).toBe("review-1");
    expect(callArg.body.verdict).toBe("approve");
  });

  test("question kind renders submit and cancel buttons", () => {
    const item = makeHitlItem({
      kind: "question",
      payload: { kind: "question", options: [{ label: "Option A" }, { label: "Option B" }] },
    });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-cancel-button")).toBeDefined();
  });

  test("renders payload action for approval kind", () => {
    const item = makeHitlItem({
      payload: { kind: "approval", action: "deploy_to_production", context: { env: "prod" } },
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("deploy_to_production");
  });

  test("renders review artifacts list", () => {
    const item = makeHitlItem({
      kind: "review",
      payload: {
        kind: "review",
        artifacts: [
          { path: "/src/index.ts", description: "Entry point" },
          { path: "/src/utils.ts", description: "Utilities" },
        ],
      },
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("/src/index.ts");
    expect(text).toContain("/src/utils.ts");
  });

  test("renders goalId from trigger when present", () => {
    const item = makeHitlItem({ trigger: { projectSlug: "demo", goalId: "goal-xyz", source: "test" } });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("goal-xyz");
  });

  test("approval card uses warning border accent", () => {
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    const cards = findAllWithClass(result, "border-warning");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("review card uses accent border", () => {
    const item = makeHitlItem({
      kind: "review",
      payload: { kind: "review", artifacts: [] },
    });
    const result = HitlCard({ item });
    const cards = findAllWithClass(result, "border-accent");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("question card uses info border", () => {
    const item = makeHitlItem({
      kind: "question",
      payload: { kind: "question", options: [] },
    });
    const result = HitlCard({ item });
    const cards = findAllWithClass(result, "border-info");
    expect(cards.length).toBeGreaterThan(0);
  });
});