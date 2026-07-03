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

const respondHitl = mock((_args: { projectSlug: string; hitlId: string; body: unknown }) => {});
const cancelHitl = mock((_args: { projectSlug: string; hitlId: string; reason?: string }) => {});

let respondIsPending = false;
let cancelIsPending = false;

mock.module("../../api/mutations", () => ({
  useRespondHitl: () => ({ mutate: respondHitl, mutateAsync: respondHitl, isPending: respondIsPending }),
  useCancelHitl: () => ({ mutate: cancelHitl, mutateAsync: cancelHitl, isPending: cancelIsPending }),
}));

const { HitlCard } = await import("./HitlCard");

// ─── Factory helpers ───

function makeDisplayPayload(overrides: Partial<DashboardHitlItem["displayPayload"]> = {}): DashboardHitlItem["displayPayload"] {
  return {
    title: "Action required",
    summary: undefined,
    fields: undefined,
    redacted: true,
    ...overrides,
  };
}

function makeHitlItem(overrides: Partial<DashboardHitlItem> = {}): DashboardHitlItem {
  return {
    hitlId: "hitl-1",
    sessionId: "session-1",
    kind: "approval",
    displayPayload: makeDisplayPayload({ title: "Approve?", summary: "Please approve" }),
    trigger: { projectSlug: "demo", goalId: "goal-1", source: "test" },
    createdAt: 1_000,
    projectSlug: "demo",
    projectName: "Demo Project",
    status: "pending",
    ...overrides,
  };
}

function makeRedactedHitlItem(overrides: Partial<DashboardHitlItem> = {}): DashboardHitlItem {
  return makeHitlItem({
    displayPayload: makeDisplayPayload({
      title: "Approve budget [REDACTED]",
      summary: "Budget approval requires human confirmation [REDACTED]",
      fields: [
        { label: "action", value: "approve_budget" },
        { label: "context", value: "[REDACTED]" },
      ],
    }),
    trigger: { projectSlug: "demo", goalId: "goal-budget", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
    ...overrides,
  });
}

// ─── Tests ───

describe("HitlCard", () => {
  beforeEach(() => {
    respondHitl.mockClear();
    cancelHitl.mockClear();
    respondIsPending = false;
    cancelIsPending = false;
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
      displayPayload: makeDisplayPayload({ title: "Which option?" }),
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("question");
  });

  test("renders kind label for review", () => {
    const item = makeHitlItem({
      kind: "review",
      displayPayload: makeDisplayPayload({ title: "Review artifacts" }),
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("review");
  });

  test("renders display title from displayPayload", () => {
    const item = makeHitlItem({
      displayPayload: makeDisplayPayload({ title: "Deploy to prod?" }),
    });
    const result = HitlCard({ item });
    const titleEl = findByTestId(result, "hitl-display-title");
    expect(titleEl).toBeDefined();
    expect(textContent(titleEl)).toContain("Deploy to prod?");
  });

  test("renders display summary from displayPayload when present", () => {
    const item = makeHitlItem({
      displayPayload: makeDisplayPayload({ title: "Deploy?", summary: "Confirm deployment" }),
    });
    const result = HitlCard({ item });
    const summaryEl = findByTestId(result, "hitl-display-summary");
    expect(summaryEl).toBeDefined();
    expect(textContent(summaryEl)).toContain("Confirm deployment");
  });

  test("does not render summary element when summary is absent", () => {
    const item = makeHitlItem({
      displayPayload: makeDisplayPayload({ title: "Deploy?", summary: undefined }),
    });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-display-summary")).toBeUndefined();
  });

  test("renders display fields when present", () => {
    const item = makeHitlItem({
      displayPayload: makeDisplayPayload({
        title: "Approve?",
        fields: [
          { label: "action", value: "deploy" },
          { label: "context", value: "[REDACTED]" },
        ],
      }),
    });
    const result = HitlCard({ item });
    const fieldsEl = findByTestId(result, "hitl-display-fields");
    expect(fieldsEl).toBeDefined();
    const text = textContent(fieldsEl);
    expect(text).toContain("action");
    expect(text).toContain("deploy");
    expect(text).toContain("context");
    expect(text).toContain("[REDACTED]");
  });

  test("does not render fields element when fields are absent", () => {
    const item = makeHitlItem({
      displayPayload: makeDisplayPayload({ title: "Approve?", fields: undefined }),
    });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-display-fields")).toBeUndefined();
  });

  test("renders project name", () => {
    const item = makeHitlItem({ projectName: "My Awesome Project" });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("My Awesome Project");
  });

  test("renders goal context from trigger when present", () => {
    const item = makeHitlItem({ trigger: { projectSlug: "demo", goalId: "goal-xyz", source: "test" } });
    const result = HitlCard({ item });
    const goalEl = findByTestId(result, "hitl-context-goal");
    expect(goalEl).toBeDefined();
    expect(textContent(goalEl)).toContain("goal-xyz");
  });

  test("renders session context", () => {
    const item = makeHitlItem({ sessionId: "sess-abc" });
    const result = HitlCard({ item });
    const sessionEl = findByTestId(result, "hitl-context-session");
    expect(sessionEl).toBeDefined();
    expect(textContent(sessionEl)).toContain("sess-abc");
  });

  test("renders trigger context from approval point source", () => {
    const item = makeHitlItem({
      trigger: { projectSlug: "demo", goalId: "goal-1", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
    });
    const result = HitlCard({ item });
    const triggerEl = findByTestId(result, "hitl-context-trigger");
    expect(triggerEl).toBeDefined();
    expect(textContent(triggerEl)).toContain("approval_budget_1");
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

  test("approve button calls respondHitl with decision=approved", () => {
    const item = makeHitlItem({ kind: "approval", hitlId: "hitl-approve-test" });
    const result = HitlCard({ item });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { projectSlug: string; hitlId: string; body: { decision?: string } };
    expect(callArg.projectSlug).toBe("demo");
    expect(callArg.hitlId).toBe("hitl-approve-test");
    expect(callArg.body.decision).toBe("approved");
  });

  test("deny button calls respondHitl with decision=denied", () => {
    const item = makeHitlItem({ kind: "approval", hitlId: "hitl-deny-test" });
    const result = HitlCard({ item });
    const denyBtn = findByTestId(result, "hitl-deny-button");
    const onClick = denyBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { projectSlug: string; hitlId: string; body: { decision?: string } };
    expect(callArg.projectSlug).toBe("demo");
    expect(callArg.hitlId).toBe("hitl-deny-test");
    expect(callArg.body.decision).toBe("denied");
  });

  test("cancel button calls cancelHitl", () => {
    const item = makeHitlItem({ hitlId: "hitl-cancel-test" });
    const result = HitlCard({ item });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    const onClick = cancelBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(cancelHitl).toHaveBeenCalledTimes(1);
    const callArg = cancelHitl.mock.calls[0]?.[0] as unknown as { projectSlug: string; hitlId: string };
    expect(callArg.projectSlug).toBe("demo");
    expect(callArg.hitlId).toBe("hitl-cancel-test");
  });

  test("review kind renders DONE/NOT DONE action buttons", () => {
    const item = makeHitlItem({
      kind: "review",
      displayPayload: makeDisplayPayload({ title: "Review artifacts" }),
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("DONE");
    expect(text).toContain("NOT DONE");
    expect(findByTestId(result, "hitl-approve-button")).toBeDefined();
    expect(findByTestId(result, "hitl-deny-button")).toBeDefined();
    expect(findByTestId(result, "hitl-request-changes-button")).toBeUndefined();
  });

  test("review DONE calls respondHitl with outcome=DONE", () => {
    const item = makeHitlItem({
      kind: "review",
      hitlId: "review-1",
      displayPayload: makeDisplayPayload({ title: "Review" }),
    });
    const result = HitlCard({ item });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { projectSlug: string; hitlId: string; body: { outcome?: string } };
    expect(callArg.projectSlug).toBe("demo");
    expect(callArg.hitlId).toBe("review-1");
    expect(callArg.body.outcome).toBe("DONE");
  });

  test("review NOT DONE calls respondHitl with outcome=NOT_DONE", () => {
    const item = makeHitlItem({
      kind: "review",
      hitlId: "review-2",
      displayPayload: makeDisplayPayload({ title: "Review" }),
    });
    const result = HitlCard({ item });
    const notDoneBtn = findByTestId(result, "hitl-deny-button");
    const onClick = notDoneBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as { projectSlug: string; hitlId: string; body: { outcome?: string } };
    expect(callArg.projectSlug).toBe("demo");
    expect(callArg.hitlId).toBe("review-2");
    expect(callArg.body.outcome).toBe("NOT_DONE");
  });

  test("question kind renders submit and cancel buttons", () => {
    const item = makeHitlItem({
      kind: "question",
      displayPayload: makeDisplayPayload({ title: "Which option?" }),
    });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-cancel-button")).toBeDefined();
  });

  test("renders display title for approval kind", () => {
    const item = makeHitlItem({
      kind: "approval",
      displayPayload: makeDisplayPayload({ title: "deploy_to_production" }),
    });
    const result = HitlCard({ item });
    const titleEl = findByTestId(result, "hitl-display-title");
    expect(textContent(titleEl)).toContain("deploy_to_production");
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
      displayPayload: makeDisplayPayload({ title: "Review" }),
    });
    const result = HitlCard({ item });
    const cards = findAllWithClass(result, "border-accent");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("question card uses info border", () => {
    const item = makeHitlItem({
      kind: "question",
      displayPayload: makeDisplayPayload({ title: "Question" }),
    });
    const result = HitlCard({ item });
    const cards = findAllWithClass(result, "border-info");
    expect(cards.length).toBeGreaterThan(0);
  });

  // ─── Redaction tests ───

  test("redacted display payload shows [REDACTED] and never exposes raw secrets", () => {
    const item = makeRedactedHitlItem({ hitlId: "hitl-redacted" });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-test-secret");
    expect(text).not.toContain("apiKey=sk-test-secret");
  });

  test("redacted display payload fields render [REDACTED] values", () => {
    const item = makeRedactedHitlItem();
    const result = HitlCard({ item });
    const fieldsEl = findByTestId(result, "hitl-display-fields");
    expect(fieldsEl).toBeDefined();
    const fieldsText = textContent(fieldsEl);
    expect(fieldsText).toContain("[REDACTED]");
    expect(fieldsText).not.toContain("sk-test-secret");
  });

  test("displayPayload has redacted: true marker", () => {
    const item = makeRedactedHitlItem();
    expect(item.displayPayload.redacted).toBe(true);
  });

  test("serialized card text never contains raw secret patterns", () => {
    const item = makeRedactedHitlItem({
      displayPayload: makeDisplayPayload({
        title: "Approve budget [REDACTED]",
        summary: "Budget approval [REDACTED]",
        fields: [
          { label: "action", value: "approve_budget" },
          { label: "context", value: "[REDACTED]" },
          { label: "apiKey", value: "[REDACTED]" },
        ],
      }),
    });
    const result = HitlCard({ item });
    const text = textContent(result);
    expect(text).not.toContain("sk-test-secret");
    expect(text).not.toContain("apiKey=sk");
    expect(text).toContain("[REDACTED]");
  });

  // ─── Duplicate-click suppression tests ───

  test("approve button is disabled when respond mutation is pending", () => {
    respondIsPending = true;
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    expect(approveBtn?.props?.disabled).toBe(true);
  });

  test("deny button is disabled when respond mutation is pending", () => {
    respondIsPending = true;
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    const denyBtn = findByTestId(result, "hitl-deny-button");
    expect(denyBtn?.props?.disabled).toBe(true);
  });

  test("cancel button is disabled when cancel mutation is pending", () => {
    cancelIsPending = true;
    const item = makeHitlItem();
    const result = HitlCard({ item });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    expect(cancelBtn?.props?.disabled).toBe(true);
  });

  test("all buttons are disabled when any mutation is pending", () => {
    respondIsPending = true;
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-approve-button")?.props?.disabled).toBe(true);
    expect(findByTestId(result, "hitl-deny-button")?.props?.disabled).toBe(true);
    expect(findByTestId(result, "hitl-cancel-button")?.props?.disabled).toBe(true);
  });

  test("approve handler does not call respondHitl when already pending", () => {
    respondIsPending = true;
    const item = makeHitlItem({ kind: "approval", hitlId: "hitl-pending" });
    const result = HitlCard({ item });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).not.toHaveBeenCalled();
  });

  test("cancel handler does not call cancelHitl when already pending", () => {
    cancelIsPending = true;
    const item = makeHitlItem({ hitlId: "hitl-pending-cancel" });
    const result = HitlCard({ item });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    const onClick = cancelBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(cancelHitl).not.toHaveBeenCalled();
  });

  test("buttons are not disabled when no mutation is pending", () => {
    const item = makeHitlItem({ kind: "approval" });
    const result = HitlCard({ item });
    expect(findByTestId(result, "hitl-approve-button")?.props?.disabled).toBe(false);
    expect(findByTestId(result, "hitl-deny-button")?.props?.disabled).toBe(false);
    expect(findByTestId(result, "hitl-cancel-button")?.props?.disabled).toBe(false);
  });
});