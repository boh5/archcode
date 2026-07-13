import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { DashboardGoal, HitlProjection } from "../api/types";
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
        <MemoryRouter initialEntries={["/"]}>
          <Dashboard />
        </MemoryRouter>
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
    objective: "Simplify the Goal experience",
    acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
    status: "running",
    attempt: 1,
    reviewGeneration: 0,
    pendingHitlIds: [],
    approvalRefs: [],
    appliedHitlIds: [],
    childSessionIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    projectSlug: "demo",
    projectName: "Demo Project",
    ...overrides,
    version: 4,
    createdFromSessionId: "origin",
    useWorktree: overrides.useWorktree ?? false,
    mainSessionId: "main-session",
    startedAt: "2026-01-01T00:00:00Z",
  };
}

function makeHitlItem(overrides: Partial<HitlProjection> = {}): HitlProjection {
  return {
    hitlId: "hitl-1",
    project: { slug: "demo", name: "Demo Project" },
    owner: { projectSlug: "demo", ownerType: "session", ownerId: "session-1" },
    source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan"},
    status: "pending",
    displayPayload: { title: "Approve?", summary: "Please approve", redacted: true },
    allowedActions: ["approve", "deny", "cancel"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function createDashboardHandler(input: {
  goals?: DashboardGoal[];
  hitl?: HitlProjection[];
  projects?: Array<{ slug: string; name: string; workspaceRoot: string }>;
  delayGoals?: boolean;
  delayHitl?: boolean;
}): (path: string) => Promise<Response> {
  const projects = input.projects ?? [{ slug: "demo", name: "Demo Project", workspaceRoot: "/demo" }];
  const hitlBySlug = new Map<string, HitlProjection[]>();
  for (const item of input.hitl ?? []) {
    const slug = item.project.slug;
    const list = hitlBySlug.get(slug) ?? [];
    list.push(item);
    hitlBySlug.set(slug, list);
  }
  return async (path: string) => {
    if (path === "/api/projects") {
      if (input.delayHitl) await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ projects });
    }

    if (path === "/api/goals?status=active") {
      if (input.delayGoals) await new Promise((resolve) => setTimeout(resolve, 50));
      return Response.json({ goals: input.goals ?? [] });
    }


    if (path.startsWith("/api/projects/") && path.includes("/hitl?scope=project")) {
      if (input.delayHitl) await new Promise((resolve) => setTimeout(resolve, 50));
      const slug = path.split("/")[3];
      return Response.json({ hitl: hitlBySlug.get(slug) ?? [] });
    }

    if (path.startsWith("/api/projects/") && path.includes("/hitl/") && path.endsWith("/respond")) {
      return Response.json({ ok: true, hitlId: path.split("/").slice(-2, -1)[0] });
    }

    if (path.startsWith("/api/projects/") && path.includes("/hitl/") && path.endsWith("/cancel")) {
      return Response.json({ ok: true, hitlId: path.split("/").slice(-2, -1)[0] });
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

  test("does not render approval queue when no pending HITL", async () => {
    const ctx = await setupDashboard(createDashboardHandler({}));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        expect(ctx.container.textContent).toContain("No active goals across projects");
        expect(ctx.container.textContent).toContain("No active automations across projects");
        expect(ctx.container.querySelector('[data-testid="dashboard-approval-queue"]')).toBeNull();
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders active goals from two projects", async () => {
    const goal1 = makeGoal({ id: "goal-a", title: "Alpha Goal", projectSlug: "alpha", projectName: "Alpha Project", status: "running" });
    const goal2 = makeGoal({ id: "goal-b", title: "Beta Goal", projectSlug: "beta", projectName: "Beta Project", status: "reviewing" });
    const ctx = await setupDashboard(createDashboardHandler({ goals: [goal1, goal2] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        const text = goalsSection?.textContent ?? "";
        expect(text).toContain("Alpha Goal");
        expect(text).toContain("Alpha Project");
        expect(text).toContain("running");
        expect(text).toContain("Beta Goal");
        expect(text).toContain("Beta Project");
        expect(text).toContain("reviewing");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });


  test("renders HITL cards in approval queue", async () => {
    const hitl1 = makeHitlItem({ hitlId: "h1", source: { type: "goal_approval", goalId: "goal-1", approvalPoint: "after_plan"}, displayPayload: { title: "Deploy?", summary: "Confirm", redacted: true }, project: { slug: "demo", name: "Alpha Project" } });
    const hitl2 = makeHitlItem({ hitlId: "h2", source: { type: "ask_user", sessionId: "session-1" }, displayPayload: { title: "Which option?", summary: "Pick one", redacted: true }, project: { slug: "demo", name: "Beta Project" }, allowedActions: ["answer", "cancel"] });
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

  test("hides approval queue empty state when no pending HITL", async () => {
    const ctx = await setupDashboard(createDashboardHandler({ hitl: [] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        expect(ctx.queryClient.isFetching()).toBe(0);
        expect(ctx.container.querySelector('[data-testid="dashboard-approval-queue"]')).toBeNull();
        expect(ctx.container.textContent?.toLowerCase()).not.toContain("no pending approvals");
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

  test("renders goal status badge", async () => {
    const goal = makeGoal({ status: "running" });
    const ctx = await setupDashboard(createDashboardHandler({ goals: [goal] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        const text = goalsSection?.textContent ?? "";
        expect(text).toContain("running");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("renders goal attempt count when > 1", async () => {
    const goal = makeGoal({ attempt: 3 });
    const ctx = await setupDashboard(createDashboardHandler({ goals: [goal] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const goalsSection = ctx.container.querySelector('[data-testid="dashboard-active-goals"]');
        const text = goalsSection?.textContent ?? "";
        expect(text).toContain("attempt");
        expect(text).toContain("3");
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
      source: { type: "goal_approval", goalId: "goal-budget", approvalPoint: "after_plan"},
      displayPayload: {
        title: "Approve budget [REDACTED]",
        summary: "Budget approval [REDACTED]",
        fields: [
          { label: "action", value: "approve_budget" },
          { label: "context", value: "[REDACTED]" },
        ],
        redacted: true,
      },
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
        source: { type: "goal_approval", goalId: "goal-budget", approvalPoint: "after_plan"},
        displayPayload: {
          title: "Approve budget [REDACTED]",
          summary: "Budget warning [REDACTED]",
          fields: [
            { label: "action", value: "goal.approval.after_plan" },
            { label: "context", value: "[REDACTED]" },
          ],
          redacted: true,
        },
      }),
      payload: {
        title: "RAW payload should never render sk-test-secret",
        context: { apiKey: "sk-test-secret-dashboard", connection: "apiKey=sk-test-secret-dashboard" },
      },
    } as HitlProjection & { payload: unknown };
    const ctx = await setupDashboard(createDashboardHandler({ hitl: [unsafeApiItem] }));

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        const queueSection = ctx.container.querySelector('[data-testid="dashboard-approval-queue"]');
        expect(queueSection).not.toBeNull();
        const text = queueSection?.textContent ?? "";
        expect(text).toContain("Approve budget [REDACTED]");
        expect(text).toContain("after_plan");
        expect(text).toContain("[REDACTED]");
        expect(text).not.toContain("RAW payload should never render");
        expect(text).not.toContain("sk-test-secret-dashboard");
        expect(text).not.toContain("apiKey=sk");
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });

  test("Dashboard never fetches global /api/hitl?status=pending endpoint", async () => {
    const ctx = await setupDashboard(async (path: string) => {
      if (path === "/api/hitl?status=pending" || path.startsWith("/api/hitl/")) {
        throw new Error(`Dashboard must not fetch global HITL endpoint: ${path}`);
      }
      return createDashboardHandler({ hitl: [] })(path);
    });

    try {
      await renderDashboard(ctx.reactRoot, ctx.queryClient);

      await waitFor(() => {
        expect(ctx.queryClient.isFetching()).toBe(0);
        expect(ctx.container.querySelector('[data-testid="dashboard-approval-queue"]')).toBeNull();
      });
    } finally {
      await cleanupDashboard(ctx);
    }
  });
});
