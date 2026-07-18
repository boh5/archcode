import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { GlobalSSEHitlRealtimeEvent } from "@archcode/protocol";
import type { GoalState, GoalEvidenceRef, HitlView } from "../api/types";
import { hitlStore } from "../store/hitl-store";
import { GoalDetailRoute } from "./goal-detail";
import { WorkbenchLayoutProvider } from "../context/workbench-layout";

// ─── Test helpers ───

const DOM_GLOBAL_NAMES = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "MouseEvent",
  "IS_REACT_ACT_ENVIRONMENT",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "fetch",
] as const;

type DomGlobalName = (typeof DOM_GLOBAL_NAMES)[number];

let originalGlobalDescriptors: Map<DomGlobalName, PropertyDescriptor | undefined> | undefined;

function saveGlobalDescriptors(): void {
  if (originalGlobalDescriptors) return;

  originalGlobalDescriptors = new Map(
    DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
}

function restoreGlobals(): void {
  if (!originalGlobalDescriptors) return;

  for (const [name, descriptor] of originalGlobalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }

  originalGlobalDescriptors = undefined;
}

function installDom(path = "/projects/demo/goals/goal-1"): JSDOM {
  saveGlobalDescriptors();

  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: `http://localhost${path}`,
  });

  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "MouseEvent", { value: dom.window.MouseEvent, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { value: clearTimeout, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });

  return dom;
}

async function waitFor(assertion: () => void, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  throw lastError;
}

function findElementByText(container: Element, text: string): Element {
  const elements = Array.from(container.querySelectorAll("*")).reverse();
  const match = elements.find((element) => element.textContent?.includes(text));
  if (!match) throw new Error(`Unable to find element containing "${text}"`);
  return match;
}

function makeEvidenceRef(overrides: Partial<GoalEvidenceRef> = {}): GoalEvidenceRef {
  return {
    kind: "tool_call",
    ref: "tool-123",
    summary: "Tests passed",
    ...overrides,
  };
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "goal-1",
    projectSlug: "demo",
    title: "Test Goal",
    objective: "Simplify the Goal experience",
    acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    status: "running",
    attempt: 1,
    reviewGeneration: 0,
    appliedBudgetHitlIds: [],
    createdFromSessionId: "origin",
    useWorktree: false,
    mainSessionId: "main-session",
    startedAt: "2026-01-01T00:00:00Z",
    childSessionIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeHitlItem(overrides: Partial<HitlView> = {}): HitlView {
  return {
    hitlId: "hitl-1",
    owner: { type: "goal", id: "goal-1" },
    source: { type: "goal_budget", approvalPoint: "after_plan"},
    status: "pending",
    displayPayload: { title: "Approve?", summary: "Please approve", redacted: true },
    allowedActions: ["approve", "deny", "cancel"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function seedRealtimeHitl(...projections: HitlView[]): void {
  for (const projection of projections) {
    const event: GlobalSSEHitlRealtimeEvent = {
      type: "hitl.event",
      projectSlug: "demo",
      hitlId: projection.hitlId,
      createdAt: Date.now(),
      payload: { type: "hitl.request" },
      view: projection,
    };
    hitlStore.getState().applyRealtimeEvent(event);
  }
}

function installGoalHitlFetchMock(opts: {
  goal: GoalState;
}): ReturnType<typeof mock> {
  const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;

    if (url.includes("/api/projects/demo/hitl/") && init?.method === "POST") {
      const hitlId = url.split("/").slice(-2, -1)[0]!;
      return Response.json({
        hitlId,
        status: "cancelled",
        view: makeHitlItem({
          hitlId,
          owner: { type: "goal", id: opts.goal.id },
          status: "cancelled",
          allowedActions: [],
          resolvedAt: "2026-01-01T00:00:01.000Z",
        }),
      });
    }
    if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
      return Response.json(opts.goal);
    }
    return new Response("Not found", { status: 404 });
  });
  Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });
  return fetchMock;
}

async function renderGoalDetailRoute(
  root: Root,
  queryClient: QueryClient,
  initialPath = "/projects/demo/goals/goal-1",
): Promise<void> {
  await act(async () => {
    root.render(
      <WorkbenchLayoutProvider>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/projects/:slug/goals/:goalId" element={<GoalDetailRoute />} />
            <Route path="/projects/:slug/sessions/:sessionId" element={<div data-testid="session-mock" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
      </WorkbenchLayoutProvider>,
    );
  });
}

// ─── Tests ───

describe("GoalDetailRoute", () => {
  beforeEach(() => {
    mock.restore();
    hitlStore.getState().removeProject("demo");
  });

  afterEach(() => {
    hitlStore.getState().removeProject("demo");
    restoreGlobals();
    mock.restore();
  });

  test("renders goal title and status header", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ title: "My Feature Goal", status: "running" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("My Feature Goal");
        expect(container.textContent).toContain("running");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("keeps objective and acceptance criteria out of the work canvas", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({
      objective: "Refactor the auth module to use JWT.",
      acceptanceCriteria: "All auth tests pass and Reviewer confirms DONE.",
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => expect(container.textContent).toContain("Open execution session"));
      expect(container.textContent).not.toContain("Refactor the auth module to use JWT.");
      expect(container.textContent).not.toContain("All auth tests pass and Reviewer confirms DONE.");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("keeps review evidence in the context inspector rather than the work canvas", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({
      status: "done",
      review: {
        executionId: "review-exec-1",
        delegationContractHash: "review-contract-1",
        reviewGeneration: 1,
        verdict: "DONE",
        summary: "All acceptance criteria met. Tests pass and diff is clean.",
        evidenceRefs: [
          makeEvidenceRef({ kind: "tool_call", ref: "tool-abc", summary: "bun test passed: 17 pass, 0 fail" }),
          makeEvidenceRef({ kind: "diff", ref: "diff-1", summary: "Clean diff with auth module changes" }),
        ],
        reviewerSessionId: "review-session-1",
        decidedAt: "2026-01-02T00:00:00.000Z",
        result: {
          status: "completed",
          summary: "All acceptance criteria met. Tests pass and diff is clean.",
          deliverables: [],
          evidence: [],
          criteria: [],
          verification: [],
          unresolved: [],
        },
      },
      finalSummary: "Auth module successfully refactored to JWT.",
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => expect(container.textContent).toContain("Test Goal"));
      expect(container.querySelector('[data-testid="goal-review-receipt"]')).toBeNull();
      expect(container.textContent).not.toContain("bun test passed: 17 pass, 0 fail");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("keeps blocker and budget summaries in the context inspector", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({
      status: "running",
      budget: {
        status: "warning",
        usedTokens: 80000,
        maxTokens: 100000,
        reason: "Approaching token limit",
        updatedAt: "2026-01-01T12:00:00.000Z",
      },
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => expect(container.textContent).toContain("Test Goal"));
      expect(container.textContent).not.toContain("Waiting for budget approval");
      expect(container.textContent).not.toContain("80,000 / 100,000 tokens");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("work canvas links to the main execution session", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({
      childSessionIds: ["plan-session-1", "build-session-1", "review-session-1"],
      mainSessionId: "main-session-1",
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      await waitFor(() => {
        expect(container.textContent).toContain("Open execution session");
      });
      expect(container.querySelector('a[href="/projects/demo/sessions/main-session-1"]')).not.toBeNull();
      expect(container.textContent).not.toContain("plan-session-1");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("does not retain the old placeholder chat tab", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ mainSessionId: "main-session-1" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      expect(container.querySelector('[data-testid="goal-tab-chat"]')).toBeNull();
      expect(container.textContent).not.toContain("Chat replay is available");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("no Artifact tab is rendered", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ status: "running" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      expect(container.textContent).not.toContain("Artifacts");
      expect(container.querySelector('[data-testid="goal-artifacts-tab"]')).toBeNull();
      expect(container.querySelector('[data-testid="goal-tab-artifacts"]')).toBeNull();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("no /artifacts network requests are made", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ status: "running" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/artifacts")) {
        throw new Error("Artifact endpoint should not be called");
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("not_done goal renders Retry Goal button and calls retry endpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const notDoneGoal = makeGoal({ id: "goal-1", title: "Not Done Goal", status: "not_done", attempt: 1, lastFailureSummary: "Tests failed" });
    const runningGoal = makeGoal({ id: "goal-1", title: "Not Done Goal", status: "running", attempt: 2, mainSessionId: "session-1" });
    let currentGoal: GoalState = notDoneGoal;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1/retry") && init?.method === "POST") {
        currentGoal = runningGoal;
        return Response.json(runningGoal);
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
        return Response.json(currentGoal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Not Done Goal");
        expect(container.textContent).toContain("Retry Goal");
      });

      await act(async () => {
        findElementByText(container, "Retry Goal").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/retry"), expect.objectContaining({ method: "POST" }));
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("shows error state when goal fetch fails", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const fetchMock = mock(async (_input: Parameters<typeof fetch>[0]) => {
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Request failed with status 404");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  // ─── Goal-scoped Approval Queue tests ───

  test("overview tab renders goal-scoped approval queue with matching HITL item", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running" });
    const matchingItem = makeHitlItem({
      hitlId: "hitl-goal-1",
      owner: { type: "goal", id: "goal-1" },
      source: { type: "goal_budget", approvalPoint: "after_plan"},
      displayPayload: { title: "Approve budget?", summary: "Confirm spend", redacted: true },
    });

    installGoalHitlFetchMock({ goal });
    seedRealtimeHitl(matchingItem);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        const queue = container.querySelector('[data-testid="goal-approval-queue"]');
        expect(queue).not.toBeNull();
      });

      const queue = container.querySelector('[data-testid="goal-approval-queue"]')!;
      expect(queue.textContent).toContain("Goal approvals");
      expect(queue.textContent).toContain("Approve budget?");
      expect(queue.textContent).toContain("Confirm spend");
      expect(queue.querySelectorAll('[data-testid="hitl-card"]')).toHaveLength(1);
      expect(queue.querySelector('[data-testid="hitl-owner-link"]')?.getAttribute("href")).toBe("/projects/demo/goals/goal-1");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("goal approval queue filters out HITL items for other goals", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running" });
    const ownItem = makeHitlItem({
      hitlId: "hitl-own",
      owner: { type: "goal", id: "goal-1" },
      source: { type: "goal_budget", approvalPoint: "after_plan"},
      displayPayload: { title: "Own approval", redacted: true },
    });

    installGoalHitlFetchMock({ goal });
    seedRealtimeHitl(
      ownItem,
      makeHitlItem({
        hitlId: "hitl-other-goal",
        owner: { type: "goal", id: "goal-2" },
        source: { type: "goal_budget", approvalPoint: "after_plan"},
        displayPayload: { title: "Other approval", redacted: true },
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        const queue = container.querySelector('[data-testid="goal-approval-queue"]');
        expect(queue).not.toBeNull();
        expect(queue!.querySelectorAll('[data-testid="hitl-card"]')).toHaveLength(1);
      });

      const queueText = container.querySelector('[data-testid="goal-approval-queue"]')!.textContent ?? "";
      expect(queueText).toContain("Own approval");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("renders delivery inspection as read-only", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running" });
    installGoalHitlFetchMock({ goal });
    seedRealtimeHitl(makeHitlItem({
      hitlId: "hitl-inspection",
      owner: { type: "goal", id: goal.id },
      status: "answered",
      requiresInspection: true,
      allowedActions: [],
    }));

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => expect(container.textContent).toContain("Manual inspection is required"));
      expect(container.querySelector('[data-testid="hitl-cancel-button"]')).toBeNull();
      expect(container.textContent).not.toContain("Approve budget");
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("goal approval queue shows empty state when no matching HITL", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running" });

    installGoalHitlFetchMock({ goal });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        const queue = container.querySelector('[data-testid="goal-approval-queue"]');
        expect(queue).not.toBeNull();
        expect(queue!.querySelectorAll('[data-testid="hitl-card"]')).toHaveLength(0);
      });

      const queueText = container.querySelector('[data-testid="goal-approval-queue"]')!.textContent ?? "";
      expect(queueText.toLowerCase()).toContain("no pending approvals");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("clicking cancel on goal approval queue card calls hitl cancel endpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running" });
    const matchingItem = makeHitlItem({
      hitlId: "hitl-cancel-target",
      owner: { type: "goal", id: "goal-1" },
      source: { type: "goal_budget", approvalPoint: "after_plan"},
      displayPayload: { title: "Approve?", redacted: true },
    });

    const fetchMock = installGoalHitlFetchMock({ goal });
    seedRealtimeHitl(matchingItem);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="goal-approval-queue"]')).not.toBeNull();
      });

      const cancelButton = container.querySelector('[data-testid="goal-approval-queue"] [data-testid="hitl-cancel-button"]');
      expect(cancelButton).not.toBeNull();

      await act(async () => {
        cancelButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/api/projects/demo/hitl/hitl-cancel-target/cancel"),
          expect.objectContaining({ method: "POST" }),
        );
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });
});
