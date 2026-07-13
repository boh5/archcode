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

function findAllWithClass(value: unknown, className: string): ElementLike[] {
  return findAll(value, (el) => {
    const cls = el.props?.className;
    return typeof cls === "string" && cls.includes(className);
  });
}

const Fragment = Symbol.for("react.fragment");
const jsxDEV = mock((type: unknown, props: Record<string, unknown> | null, _key?: unknown) => ({
  type,
  props: props ?? {},
  key: undefined,
}));

let stateValues: unknown[] = [];
let stateCursor = 0;

function resetHookState(): void {
  stateValues = [];
  stateCursor = 0;
}

function prepareRerender(): void {
  stateCursor = 0;
}

mock.module("react", () => ({
  default: {},
  useState: <T,>(initial: T): [T, (value: T | ((previous: T) => T)) => void] => {
    const index = stateCursor;
    stateCursor += 1;
    if (stateValues.length <= index) stateValues[index] = initial;
    const setState = (value: T | ((previous: T) => T)) => {
      const previous = stateValues[index] as T;
      stateValues[index] = typeof value === "function" ? (value as (previous: T) => T)(previous) : value;
    };
    return [stateValues[index] as T, setState];
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

interface MockLinkProps {
  readonly children?: unknown;
  readonly className?: string;
  readonly to: string;
  readonly [key: string]: unknown;
}

mock.module("react-router-dom", () => ({
  Link: ({ children, className, to, ...props }: MockLinkProps) => jsxDEV("a", { ...props, href: to, className, children }),
}));

type RespondHitlArgs = { identity: { owner: HitlProjection["owner"]; hitlId: string }; body: { type?: string; decision?: string; outcome?: string; answers?: string[] } };
type CancelHitlArgs = { identity: { owner: HitlProjection["owner"]; hitlId: string }; reason?: string };

const respondHitl = mock((_args: RespondHitlArgs) => {});
const cancelHitl = mock((_args: CancelHitlArgs) => {});

let respondIsPending = false;
let cancelIsPending = false;

mock.module("../../api/mutations", () => ({
  useRespondHitl: () => ({ mutate: respondHitl, mutateAsync: respondHitl, isPending: respondIsPending }),
  useCancelHitl: () => ({ mutate: cancelHitl, mutateAsync: cancelHitl, isPending: cancelIsPending }),
}));

const { HitlCard } = await import("./HitlCard");

function makeDisplayPayload(overrides: Partial<HitlProjection["displayPayload"]> = {}): HitlProjection["displayPayload"] {
  return {
    title: "Action required",
    summary: undefined,
    fields: undefined,
    redacted: true,
    ...overrides,
  };
}

function makeProjection(overrides: Partial<HitlProjection> = {}): HitlProjection {
  return {
    hitlId: "hitl-1",
    project: { slug: "demo", name: "Demo Project" },
    owner: { projectSlug: "demo", ownerType: "session", ownerId: "session-1" },
    source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
    status: "pending",
    displayPayload: makeDisplayPayload({ title: "Approve?", summary: "Please approve" }),
    allowedActions: ["approve", "deny", "cancel"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeRedactedProjection(overrides: Partial<HitlProjection> = {}): HitlProjection {
  return makeProjection({
    displayPayload: makeDisplayPayload({
      title: "Approve budget [REDACTED]",
      summary: "Budget approval requires human confirmation [REDACTED]",
      fields: [
        { label: "action", value: "approve_budget" },
        { label: "context", value: "[REDACTED]" },
      ],
    }),
    ...overrides,
  });
}

describe("HitlCard", () => {
  beforeEach(() => {
    respondHitl.mockClear();
    cancelHitl.mockClear();
    respondIsPending = false;
    cancelIsPending = false;
    resetHookState();
  });

  test("renders data-testid='hitl-card'", () => {
    const projection = makeProjection();
    const result = HitlCard({ projection });
    const card = findByTestId(result, "hitl-card");
    expect(card).toBeDefined();
  });

  test("renders source label for goal_approval", () => {
    const projection = makeProjection({ source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"} });
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("goal approval");
  });

  test("renders source label for ask_user", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Which option?" }),
    });
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("question");
  });

  test("renders source label for goal_review", () => {
    const projection = makeProjection({
      source: { type: "goal_review", goalId: "goal-1" , resumeStatus: "reviewing"},
      allowedActions: ["approve", "deny", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Review artifacts" }),
    });
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text.toLowerCase()).toContain("goal review");
  });

  test("renders display title from displayPayload", () => {
    const projection = makeProjection({
      displayPayload: makeDisplayPayload({ title: "Deploy to prod?" }),
    });
    const result = HitlCard({ projection });
    const titleEl = findByTestId(result, "hitl-display-title");
    expect(titleEl).toBeDefined();
    expect(textContent(titleEl)).toContain("Deploy to prod?");
  });

  test("renders display summary from displayPayload when present", () => {
    const projection = makeProjection({
      displayPayload: makeDisplayPayload({ title: "Deploy?", summary: "Confirm deployment" }),
    });
    const result = HitlCard({ projection });
    const summaryEl = findByTestId(result, "hitl-display-summary");
    expect(summaryEl).toBeDefined();
    expect(textContent(summaryEl)).toContain("Confirm deployment");
  });

  test("does not render summary element when summary is absent", () => {
    const projection = makeProjection({
      displayPayload: makeDisplayPayload({ title: "Deploy?", summary: undefined }),
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-display-summary")).toBeUndefined();
  });

  test("renders display fields when present", () => {
    const projection = makeProjection({
      displayPayload: makeDisplayPayload({
        title: "Approve?",
        fields: [
          { label: "action", value: "deploy" },
          { label: "context", value: "[REDACTED]" },
        ],
      }),
    });
    const result = HitlCard({ projection });
    const fieldsEl = findByTestId(result, "hitl-display-fields");
    expect(fieldsEl).toBeDefined();
    const text = textContent(fieldsEl);
    expect(text).toContain("action");
    expect(text).toContain("deploy");
    expect(text).toContain("context");
    expect(text).toContain("[REDACTED]");
  });

  test("does not render fields element when fields are absent", () => {
    const projection = makeProjection({
      displayPayload: makeDisplayPayload({ title: "Approve?", fields: undefined }),
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-display-fields")).toBeUndefined();
  });

  test("renders project name", () => {
    const projection = makeProjection({ project: { slug: "demo", name: "My Awesome Project" } });
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text).toContain("My Awesome Project");
  });

  test("renders owner context with owner link", () => {
    const projection = makeProjection({
      owner: { projectSlug: "demo", ownerType: "session", ownerId: "sess-abc" },
    });
    const result = HitlCard({ projection });
    const ownerEl = findByTestId(result, "hitl-owner");
    expect(ownerEl).toBeDefined();
    expect(textContent(ownerEl)).toContain("sess-abc");
    const ownerLink = findByTestId(result, "hitl-owner-link");
    expect(ownerLink).toBeDefined();
    expect(ownerLink?.props?.to).toBe("/projects/demo/sessions/sess-abc");
  });

  test("renders ancestry context when present", () => {
    const projection = makeProjection({
      owner: { projectSlug: "demo", ownerType: "session", ownerId: "child-session" },
      ancestry: { goalId: "goal-1" },
    });
    const result = HitlCard({ projection });
    const ancestryEl = findByTestId(result, "hitl-ancestry");
    expect(ancestryEl).toBeDefined();
    expect(textContent(ancestryEl)).toContain("goal-1");
  });

  test("renders approve and deny buttons for goal_approval", () => {
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-approve-button")).toBeDefined();
    expect(findByTestId(result, "hitl-deny-button")).toBeDefined();
  });

  test("renders cancel button", () => {
    const projection = makeProjection();
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-cancel-button")).toBeDefined();
  });

  test("approve button calls respondHitl with decision=approved", () => {
    const projection = makeProjection({
      hitlId: "hitl-approve-test",
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.identity.owner.projectSlug).toBe("demo");
    expect(callArg.identity.hitlId).toBe("hitl-approve-test");
    expect(callArg.body.type).toBe("approval_decision");
    expect(callArg.body.decision).toBe("approved");
  });

  test("deny button calls respondHitl with decision=denied", () => {
    const projection = makeProjection({
      hitlId: "hitl-deny-test",
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const denyBtn = findByTestId(result, "hitl-deny-button");
    const onClick = denyBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.identity.owner.projectSlug).toBe("demo");
    expect(callArg.identity.hitlId).toBe("hitl-deny-test");
    expect(callArg.body.type).toBe("approval_decision");
    expect(callArg.body.decision).toBe("denied");
  });

  test("cancel button calls cancelHitl", () => {
    const projection = makeProjection({ hitlId: "hitl-cancel-test" });
    const result = HitlCard({ projection });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    const onClick = cancelBtn?.props?.onClick as (() => void) | undefined;
    expect(typeof onClick).toBe("function");
    onClick!();
    expect(cancelHitl).toHaveBeenCalledTimes(1);
    const callArg = cancelHitl.mock.calls[0]?.[0] as unknown as CancelHitlArgs;
    expect(callArg.identity.owner.projectSlug).toBe("demo");
    expect(callArg.identity.hitlId).toBe("hitl-cancel-test");
  });

  test("goal_review renders DONE/NOT DONE action buttons", () => {
    const projection = makeProjection({
      source: { type: "goal_review", goalId: "goal-1" , resumeStatus: "reviewing"},
      allowedActions: ["approve", "deny", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Review artifacts" }),
    });
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text).toContain("DONE");
    expect(text).toContain("NOT DONE");
    expect(findByTestId(result, "hitl-approve-button")).toBeDefined();
    expect(findByTestId(result, "hitl-deny-button")).toBeDefined();
  });

  test("goal_review DONE calls respondHitl with outcome=DONE", () => {
    const projection = makeProjection({
      hitlId: "review-1",
      source: { type: "goal_review", goalId: "goal-1" , resumeStatus: "reviewing"},
      allowedActions: ["approve", "deny", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Review" }),
    });
    const result = HitlCard({ projection });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.identity.owner.projectSlug).toBe("demo");
    expect(callArg.identity.hitlId).toBe("review-1");
    expect(callArg.body.type).toBe("review_outcome");
    expect(callArg.body.outcome).toBe("DONE");
  });

  test("goal_review NOT DONE calls respondHitl with outcome=NOT_DONE", () => {
    const projection = makeProjection({
      hitlId: "review-2",
      source: { type: "goal_review", goalId: "goal-1" , resumeStatus: "reviewing"},
      allowedActions: ["approve", "deny", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Review" }),
    });
    const result = HitlCard({ projection });
    const notDoneBtn = findByTestId(result, "hitl-deny-button");
    const onClick = notDoneBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.identity.owner.projectSlug).toBe("demo");
    expect(callArg.identity.hitlId).toBe("review-2");
    expect(callArg.body.type).toBe("review_outcome");
    expect(callArg.body.outcome).toBe("NOT_DONE");
  });

  test("tool_permission renders Allow Once, Allow for Project, and Deny buttons", () => {
    const projection = makeProjection({
      hitlId: "perm-1",
      source: { type: "tool_permission", sessionId: "session-1", toolCallId: "tc-1", toolName: "file_write" },
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-approve-button")).toBeDefined();
    expect(findByTestId(result, "hitl-approve-always-button")).toBeDefined();
    expect(findByTestId(result, "hitl-deny-button")).toBeDefined();
  });

  test("tool_permission Allow Once calls respondHitl with decision=approve_once", () => {
    const projection = makeProjection({
      hitlId: "perm-once",
      source: { type: "tool_permission", sessionId: "session-1", toolCallId: "tc-1", toolName: "file_write" },
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.body.type).toBe("permission_decision");
    expect(callArg.body.decision).toBe("approve_once");
  });

  test("tool_permission Allow for Project calls respondHitl with decision=approve_always", () => {
    const projection = makeProjection({
      hitlId: "perm-always",
      source: { type: "tool_permission", sessionId: "session-1", toolCallId: "tc-1", toolName: "file_write" },
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const approveAlwaysBtn = findByTestId(result, "hitl-approve-always-button");
    const onClick = approveAlwaysBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.body.type).toBe("permission_decision");
    expect(callArg.body.decision).toBe("approve_always");
  });

  test("tool_permission Deny calls respondHitl with decision=deny", () => {
    const projection = makeProjection({
      hitlId: "perm-deny",
      source: { type: "tool_permission", sessionId: "session-1", toolCallId: "tc-1", toolName: "file_write" },
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const denyBtn = findByTestId(result, "hitl-deny-button");
    const onClick = denyBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.body.type).toBe("permission_decision");
    expect(callArg.body.decision).toBe("deny");
  });



  test("ask_user renders submit and cancel buttons", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Which option?" }),
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-approve-button")).toBeDefined();
    expect(findByTestId(result, "hitl-cancel-button")).toBeDefined();
  });

  test("ask_user submit button is disabled until an answer exists", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Which option?" }),
    });

    const result = HitlCard({ projection });

    expect(findByTestId(result, "hitl-approve-button")?.props?.disabled).toBe(true);
  });

  test("ask_user custom text enables Submit Answer without pressing Enter", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({
        title: "Need input",
        questions: [{ header: "Decision", question: "What should we do?", options: [], custom: true }],
      }),
    });

    let result = HitlCard({ projection });
    const input = findAll(result, (element) => element.type === "input" && element.props?.placeholder === "Type your own answer…")[0];
    const onChange = input?.props?.onChange as ((event: { target: { value: string } }) => void) | undefined;
    onChange?.({ target: { value: "Proceed" } });

    prepareRerender();
    result = HitlCard({ projection });

    const submit = findByTestId(result, "hitl-approve-button");
    expect(submit?.props?.disabled).toBe(false);
    const onClick = submit?.props?.onClick as (() => void) | undefined;
    onClick?.();
    expect(respondHitl).toHaveBeenCalledTimes(1);
    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.body.type).toBe("question_answer");
    expect(callArg.body.answers).toEqual(["Proceed"]);
  });

  test("ask_user presents multiple questions as tabs and confirms the complete answer set", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({
        title: "Need input",
        questions: [
          { header: "First", question: "Pick a path", options: [{ label: "A", description: "Alpha" }], custom: false },
          { header: "Second", question: "Explain why", options: [], custom: true },
        ],
      }),
    });

    let result = HitlCard({ projection });
    const tabs = findAll(result, (element) => element.props?.role === "tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map(textContent)).toEqual(["First", "Second", "Confirm"]);
    expect(findByTestId(result, "hitl-question-tab-0")?.props?.["aria-selected"]).toBe(true);
    expect(textContent(findByTestId(result, "hitl-question-pane"))).toContain("Pick a path");
    expect(textContent(findByTestId(result, "hitl-question-pane"))).not.toContain("Explain why");

    const optionInput = findAll(result, (element) => element.type === "input" && element.props?.value === "A")[0];
    const onOptionChange = optionInput?.props?.onChange as (() => void) | undefined;
    onOptionChange?.();

    prepareRerender();
    result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-question-tab-1")?.props?.["aria-selected"]).toBe(true);
    expect(textContent(findByTestId(result, "hitl-question-pane"))).toContain("Explain why");
    expect(textContent(findByTestId(result, "hitl-question-pane"))).not.toContain("Pick a path");

    const customInput = findAll(result, (element) => element.type === "input" && element.props?.placeholder === "Type your own answer…")[0];
    const onCustomChange = customInput?.props?.onChange as ((event: { target: { value: string } }) => void) | undefined;
    onCustomChange?.({ target: { value: "Because it is safe" } });

    prepareRerender();
    result = HitlCard({ projection });
    const next = findByTestId(result, "hitl-question-next-button");
    expect(next?.props?.disabled).toBe(false);
    const onNext = next?.props?.onClick as (() => void) | undefined;
    onNext?.();

    expect(respondHitl).not.toHaveBeenCalled();

    prepareRerender();
    result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-confirm-tab")?.props?.["aria-selected"]).toBe(true);
    const confirmation = findByTestId(result, "hitl-confirm-pane");
    expect(textContent(confirmation)).toContain("Pick a path");
    expect(textContent(confirmation)).toContain("A");
    expect(textContent(confirmation)).toContain("Explain why");
    expect(textContent(confirmation)).toContain("Because it is safe");

    const confirm = findByTestId(result, "hitl-approve-button");
    expect(textContent(confirm)).toContain("Confirm Answers");
    expect(confirm?.props?.disabled).toBe(false);
    const onConfirm = confirm?.props?.onClick as (() => void) | undefined;
    onConfirm?.();

    const callArg = respondHitl.mock.calls[0]?.[0] as unknown as RespondHitlArgs;
    expect(callArg.body.type).toBe("question_answer");
    expect(callArg.body.answers).toEqual(["A", "Because it is safe"]);
  });

  test("multiple-choice questions wait for Next instead of advancing after each selection", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({
        title: "Need input",
        questions: [
          {
            header: "Areas",
            question: "Which areas?",
            options: [
              { label: "API", description: "Backend" },
              { label: "UI", description: "Frontend" },
            ],
            multiple: true,
            custom: false,
          },
          { header: "Confirm scope", question: "Ready?", options: [{ label: "Yes", description: "Continue" }], custom: false },
        ],
      }),
    });

    let result = HitlCard({ projection });
    const apiOption = findAll(result, (element) => element.type === "input" && element.props?.value === "API")[0];
    const onApiChange = apiOption?.props?.onChange as (() => void) | undefined;
    onApiChange?.();

    prepareRerender();
    result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-question-tab-0")?.props?.["aria-selected"]).toBe(true);
    const next = findByTestId(result, "hitl-question-next-button");
    expect(next?.props?.disabled).toBe(false);
    const onNext = next?.props?.onClick as (() => void) | undefined;
    onNext?.();

    prepareRerender();
    result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-question-tab-1")?.props?.["aria-selected"]).toBe(true);
  });


  test("question payload does not repeat question text in summary or fields", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({
        title: "Question",
        summary: "What now?",
        fields: [{ label: "Q", value: "What now?" }],
        questions: [{ header: "Q", question: "What now?", options: [], custom: true }],
      }),
    });

    const result = HitlCard({ projection });

    expect(findByTestId(result, "hitl-display-summary")).toBeUndefined();
    expect(findByTestId(result, "hitl-display-fields")).toBeUndefined();
    expect(textContent(findByTestId(result, "hitl-question-pane"))).toContain("What now?");
  });

  test("renders display title for approval source", () => {
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      displayPayload: makeDisplayPayload({ title: "deploy_to_production" }),
    });
    const result = HitlCard({ projection });
    const titleEl = findByTestId(result, "hitl-display-title");
    expect(textContent(titleEl)).toContain("deploy_to_production");
  });

  test("goal_approval card uses warning border accent", () => {
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
    });
    const result = HitlCard({ projection });
    const cards = findAllWithClass(result, "border-warning");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("goal_review card uses accent border", () => {
    const projection = makeProjection({
      source: { type: "goal_review", goalId: "goal-1" , resumeStatus: "reviewing"},
      allowedActions: ["approve", "deny", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Review" }),
    });
    const result = HitlCard({ projection });
    const cards = findAllWithClass(result, "border-accent");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("ask_user card uses info border", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
      displayPayload: makeDisplayPayload({ title: "Question" }),
    });
    const result = HitlCard({ projection });
    const cards = findAllWithClass(result, "border-info");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("redacted display payload shows [REDACTED] and never exposes raw secrets", () => {
    const projection = makeRedactedProjection({ hitlId: "hitl-redacted" });
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sk-test-secret");
    expect(text).not.toContain("apiKey=sk-test-secret");
  });

  test("redacted display payload fields render [REDACTED] values", () => {
    const projection = makeRedactedProjection();
    const result = HitlCard({ projection });
    const fieldsEl = findByTestId(result, "hitl-display-fields");
    expect(fieldsEl).toBeDefined();
    const fieldsText = textContent(fieldsEl);
    expect(fieldsText).toContain("[REDACTED]");
    expect(fieldsText).not.toContain("sk-test-secret");
  });

  test("displayPayload has redacted: true marker", () => {
    const projection = makeRedactedProjection();
    expect(projection.displayPayload.redacted).toBe(true);
  });

  test("serialized card text never contains raw secret patterns", () => {
    const projection = makeRedactedProjection({
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
    const result = HitlCard({ projection });
    const text = textContent(result);
    expect(text).not.toContain("sk-test-secret");
    expect(text).not.toContain("apiKey=sk");
    expect(text).toContain("[REDACTED]");
  });

  test("approve button is disabled when respond mutation is pending", () => {
    respondIsPending = true;
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    expect(approveBtn?.props?.disabled).toBe(true);
  });

  test("deny button is disabled when respond mutation is pending", () => {
    respondIsPending = true;
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const denyBtn = findByTestId(result, "hitl-deny-button");
    expect(denyBtn?.props?.disabled).toBe(true);
  });

  test("cancel button is disabled when cancel mutation is pending", () => {
    cancelIsPending = true;
    const projection = makeProjection();
    const result = HitlCard({ projection });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    expect(cancelBtn?.props?.disabled).toBe(true);
  });

  test("all buttons are disabled when any mutation is pending", () => {
    respondIsPending = true;
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-approve-button")?.props?.disabled).toBe(true);
    expect(findByTestId(result, "hitl-deny-button")?.props?.disabled).toBe(true);
    expect(findByTestId(result, "hitl-cancel-button")?.props?.disabled).toBe(true);
  });

  test("approve handler does not call respondHitl when already pending", () => {
    respondIsPending = true;
    const projection = makeProjection({
      hitlId: "hitl-pending",
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    const approveBtn = findByTestId(result, "hitl-approve-button");
    const onClick = approveBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(respondHitl).not.toHaveBeenCalled();
  });

  test("cancel handler does not call cancelHitl when already pending", () => {
    cancelIsPending = true;
    const projection = makeProjection({ hitlId: "hitl-pending-cancel" });
    const result = HitlCard({ projection });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    const onClick = cancelBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(cancelHitl).not.toHaveBeenCalled();
  });

  test("buttons are not disabled when no mutation is pending", () => {
    const projection = makeProjection({
      source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan" , resumeStatus: "running"},
      allowedActions: ["approve", "deny", "cancel"],
    });
    const result = HitlCard({ projection });
    expect(findByTestId(result, "hitl-approve-button")?.props?.disabled).toBe(false);
    expect(findByTestId(result, "hitl-deny-button")?.props?.disabled).toBe(false);
    expect(findByTestId(result, "hitl-cancel-button")?.props?.disabled).toBe(false);
  });

  test("never calls /api/questions or /api/permissions endpoints", () => {
    const projection = makeProjection({
      source: { type: "ask_user", sessionId: "session-1" },
      allowedActions: ["answer", "cancel"],
    });
    const result = HitlCard({ projection });
    const cancelBtn = findByTestId(result, "hitl-cancel-button");
    const onClick = cancelBtn?.props?.onClick as (() => void) | undefined;
    onClick!();
    expect(cancelHitl).toHaveBeenCalledTimes(1);
    const callArg = cancelHitl.mock.calls[0]?.[0] as unknown as CancelHitlArgs;
    expect(callArg.identity.owner.projectSlug).toBe("demo");
    expect(callArg.identity.hitlId).toBe("hitl-1");
  });
});
