import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { DashboardGoal, DashboardHitlItem, DashboardLoop, LoopRunReport } from "../api/types";
import { Dashboard } from "./dashboard";

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

function installDom(): JSDOM {
  saveGlobalDescriptors();

  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/",
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

async function renderDashboard(root: Root, queryClient: QueryClient): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>,
    );
  });
}

async function setupDashboard(fetchHandler: (path: string, init?: RequestInit) => Response | Promise<Response>): Promise<{
  container: HTMLElement;
  dom: JSDOM;
  queryClient: QueryClient;
  reactRoot: Root;
}> {
  const dom = installDom();
  const container = document.getElementById("root");
  if (!container) throw new Error("Missing test root");

  const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.pathname + input.search
        : new URL(input.url).pathname + new URL(input.url).search;

    return fetchHandler(path, init);
  });
  Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const reactRoot = createRoot(container);

  return { container, dom, queryClient, reactRoot };
}

async function cleanupDashboard(input: { dom: JSDOM; queryClient: QueryClient; reactRoot: Root }): Promise<void> {
  await waitFor(() => {
    expect(input.queryClient.isFetching()).toBe(0);
    expect(input.queryClient.isMutating()).toBe(0);
  });

  await act(async () => {
    input.reactRoot.unmount();
  });
  input.queryClient.clear();
  input.dom.window.close();
}

function findAllByTestId(container: Element, testId: string): Element[] {
  return Array.from(container.querySelectorAll(`[data-testid="${testId}"]`));
}

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
    displayPayload: { title: "Approve?", summary: "Please approve", redacted: true },
    trigger: { projectSlug: "demo", goalId: "goal-1", source: "test" },
    createdAt: 1_000,
    projectSlug: "demo",
    projectName: "Demo Project",
    status: "pending",
    ...overrides,
  };
}

function makeLoopRun(overrides: Partial<LoopRunReport> = {}): LoopRunReport {
  return {
    runId: "run-1",
    loopId: "loop-1",
    status: "running",
    trigger: "manual",
    startedAt: 1700000000000,
    ...overrides,
  };
}

function makeLoop(overrides: Partial<DashboardLoop> = {}): DashboardLoop {
  return {
    loopId: "loop-1",
    title: "Daily Triage Loop",
    status: "active",
    currentRun: makeLoopRun({ runId: "run-current", status: "running" }),
    lastRun: makeLoopRun({ runId: "run-last", status: "succeeded", endedAt: 1700000060000 }),
    nextRunAt: 1700000600000,
    runKind: "session",
    mode: "report",
    projectSlug: "demo",
    projectName: "Demo Project",
    ...overrides,
  };
}

function createDashboardHandler(input: {
  goals?: DashboardGoal[];
  loops?: DashboardLoop[];
  hitl?: DashboardHitlItem[];
  delayGoals?: boolean;
  delayLoops?: boolean;
  delayHitl?: boolean;
}): (path: string) => Promise<Response> {
  return async (path: string) => {
    if (path === "/api/goals?status=active") {
      if (input.delayGoals) await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ goals: input.goals ?? [] });
    }

    if (path === "/api/loops?status=active") {
      if (input.delayLoops) await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ loops: input.loops ?? [] });
    }

    if (path === "/api/hitl?status=pending") {
      if (input.delayHitl) await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ hitl: input.hitl ?? [] });
    }

    if (path.startsWith("/api/hitl/")) {
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  };
}

// ─── Tests ───

describe("Dashboard", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    restoreGlobals();
    mock.restore();
  });

  test("renders data-testid='dashboard-active-goals' section", async () => {
    const ctx = await setupDashboard(createDashboardHandler({}));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        expect(ctx.container.querySelector('[data-testid="dashboard-active-goals"]')).not.toBeNull();
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders data-testid='dashboard-approval-queue' section", async () => {
    const ctx = await setupDashboard(createDashboardHandler({}));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        expect(ctx.container.querySelector('[data-testid="dashboard-approval-queue"]')).not.toBeNull();
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders active goals from two projects", async () => {
    const goal1 = makeGoal({ id: "goal-a", title: "Alpha Goal", projectSlug: "alpha", projectName: "Alpha Project", status: "running", phase: "build" });
    const goal2 = makeGoal({ id: "goal-b", title: "Beta Goal", projectSlug: "beta", projectName: "Beta Project", status: "verifying", phase: "review" });
    const ctx = await setupDashboard(createDashboardHandler({ goals: [goal1, goal2] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        const text = goalsSection?.textContent ?? "";
        expect(text).toContain("Alpha Goal");
        expect(text).toContain("Alpha Project");
        expect(text).toContain("running");
        expect(text).toContain("Build");
        expect(text).toContain("Beta Goal");
        expect(text).toContain("Beta Project");
        expect(text).toContain("verifying");
        expect(text).toContain("Review");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("active loops section renders row current last next fields and detail link without forbidden UI", async () => {
    const loop = makeLoop({
      loopId: "loop-active-1",
      title: "Nightly Loop Sweep",
      projectSlug: "alpha",
      projectName: "Alpha Project",
      currentRun: makeLoopRun({ loopId: "loop-active-1", runId: "run-current-alpha", status: "running" }),
      lastRun: makeLoopRun({ loopId: "loop-active-1", runId: "run-last-alpha", status: "succeeded", endedAt: 1700000100000 }),
      nextRunAt: 1700000900000,
      runKind: "goal",
      mode: "act",
    });
    const ctx = await setupDashboard(createDashboardHandler({ loops: [loop] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const loopsSection = ctx.container.querySelector('[data-testid="dashboard-active-loops"]');
        expect(loopsSection).not.toBeNull();
        const text = loopsSection?.textContent ?? "";
        expect(text).toContain("Nightly Loop Sweep");
        expect(text).toContain("Alpha Project");
        expect(text).toContain("active");
        expect(text).toContain("goal");
        expect(text).toContain("act");
        expect(text).toContain("current: running run-current-alpha");
        expect(text).toContain("last: succeeded run-last-alpha");
        expect(text).toContain("next: 2023-11-14T22:28:20.000Z");
      });

      const detailLink = ctx.container.querySelector('a[href="/projects/alpha/loops/loop-active-1"]');
      expect(detailLink).not.toBeNull();

      const lowerText = ctx.container.querySelector('[data-testid="dashboard-active-loops"]')?.textContent?.toLowerCase() ?? "";
      expect(lowerText).not.toContain("readiness");
      expect(lowerText).not.toContain("budget");
      expect(lowerText).not.toContain("cron");
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders HITL cards in approval queue", async () => {
    const hitl1 = makeHitlItem({ hitlId: "h1", kind: "approval", displayPayload: { title: "Deploy?", summary: "Confirm", redacted: true }, projectName: "Alpha Project" });
    const hitl2 = makeHitlItem({ hitlId: "h2", kind: "question", displayPayload: { title: "Which option?", summary: "Pick one", redacted: true }, projectName: "Beta Project" });
    const ctx = await setupDashboard(createDashboardHandler({ hitl: [hitl1, hitl2] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const queueSection = ctx.container.querySelector('[data-testid="dashboard-approval-queue"]');
        expect(queueSection).not.toBeNull();
        expect(findAllByTestId(queueSection!, "hitl-card")).toHaveLength(2);
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("shows empty state when no active goals", async () => {
    const ctx = await setupDashboard(createDashboardHandler({ goals: [] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        expect((goalsSection?.textContent ?? "").toLowerCase()).toContain("no active");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("shows empty state when no pending HITL", async () => {
    const ctx = await setupDashboard(createDashboardHandler({ hitl: [] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const queueSection = ctx.container.querySelector('[data-testid="dashboard-approval-queue"]');
        expect((queueSection?.textContent ?? "").toLowerCase()).toContain("no pending");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("shows loading state for active goals", async () => {
    const ctx = await setupDashboard(createDashboardHandler({ delayGoals: true }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      expect((ctx.container.querySelector('[data-testid="dashboard-active-goals"]')?.textContent ?? "").toLowerCase()).toContain("loading");
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("shows loading state for approval queue", async () => {
    const ctx = await setupDashboard(createDashboardHandler({ delayHitl: true }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      expect((ctx.container.querySelector('[data-testid="dashboard-approval-queue"]')?.textContent ?? "").toLowerCase()).toContain("loading");
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders goal status and phase badges", async () => {
    const goal = makeGoal({ status: "paused", phase: "plan" });
    const ctx = await setupDashboard(createDashboardHandler({ goals: [goal] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        const text = goalsSection?.textContent ?? "";
        expect(text).toContain("paused");
        expect(text).toContain("Plan");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders goal retry count when > 0", async () => {
    const goal = makeGoal({ retryCount: 2 });
    const ctx = await setupDashboard(createDashboardHandler({ goals: [goal] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        const text = goalsSection?.textContent ?? "";
        expect(text).toContain("retry");
        expect(text).toContain("2");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders dashboard header", async () => {
    const ctx = await setupDashboard(createDashboardHandler({}));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        expect(ctx.container.textContent?.toLowerCase()).toContain("dashboard");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("redacted HITL cards show [REDACTED] and never expose raw secrets", async () => {
    const redactedItem = makeHitlItem({
      hitlId: "h-redacted",
      kind: "approval",
      displayPayload: {
        title: "Approve budget [REDACTED]",
        summary: "Budget approval [REDACTED]",
        fields: [
          { label: "action", value: "approve_budget" },
          { label: "context", value: "[REDACTED]" },
        ],
        redacted: true,
      },
      trigger: { projectSlug: "demo", goalId: "goal-budget", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
    });
    const ctx = await setupDashboard(createDashboardHandler({ hitl: [redactedItem] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const queueSection = ctx.container.querySelector('[data-testid="dashboard-approval-queue"]');
        expect(queueSection).not.toBeNull();
        const text = queueSection?.textContent ?? "";
        expect(text).toContain("[REDACTED]");
        expect(text).not.toContain("sk-test-secret");
        expect(text).not.toContain("apiKey=sk");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("approval queue ignores accidental raw HITL payload and renders displayPayload only", async () => {
    const unsafeApiItem = {
      ...makeHitlItem({
        hitlId: "h-unsafe-payload",
        kind: "approval",
        displayPayload: {
          title: "Approve budget [REDACTED]",
          summary: "Budget warning [REDACTED]",
          fields: [
            { label: "action", value: "goal.approval.approval_budget_1" },
            { label: "context", value: "[REDACTED]" },
          ],
          redacted: true,
        },
        trigger: { projectSlug: "demo", goalId: "goal-budget", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
      }),
      payload: {
        title: "RAW payload should never render sk-test-secret",
        context: { apiKey: "sk-test-secret-dashboard", connection: "apiKey=sk-test-secret-dashboard" },
      },
    } as DashboardHitlItem & { payload: unknown };
    const ctx = await setupDashboard(createDashboardHandler({ hitl: [unsafeApiItem] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const queueSection = ctx.container.querySelector('[data-testid="dashboard-approval-queue"]');
        expect(queueSection).not.toBeNull();
        const text = queueSection?.textContent ?? "";
        expect(text).toContain("Approve budget [REDACTED]");
        expect(text).toContain("approval_budget_1");
        expect(text).toContain("[REDACTED]");
        expect(text).not.toContain("RAW payload should never render");
        expect(text).not.toContain("sk-test-secret-dashboard");
        expect(text).not.toContain("apiKey=sk");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });
});
