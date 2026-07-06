import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { GoalArtifactFile, GoalArtifactName, GoalState, DoneCondition, DoneResult, DashboardHitlItem } from "../api/types";
import { GoalDetailRoute } from "./goal-detail";

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

function makeDoneCondition(overrides: Partial<DoneCondition> = {}): DoneCondition {
  return {
    id: "cond-1",
    kind: "tests_pass",
    params: { command: "bun test" },
    required: true,
    ...overrides,
  } as DoneCondition;
}

function makeDoneResult(overrides: Partial<DoneResult> = {}): DoneResult {
  return {
    conditionId: "cond-1",
    passed: true,
    evidence: "All tests passed",
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "goal-1",
    projectId: "demo",
    title: "Test Goal",
    status: "running",
    phase: "build",
    doneConditions: [],
    doneResults: {},
    reviewerAgent: "reviewer",
    retryPolicy: { maxRetries: 3, backoffMs: 1000, escalateOnFailure: true },
    retryCount: 0,
    approvalPoints: [],
    author: "orchestrator",
    childSessionIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeHitlItem(overrides: Partial<DashboardHitlItem> = {}): DashboardHitlItem {
  return {
    hitlId: "hitl-1",
    sessionId: "session-1",
    kind: "approval",
    displayPayload: { title: "Approve?", summary: "Please approve", redacted: true },
    trigger: { projectSlug: "demo", goalId: "goal-1", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
    createdAt: 1_000,
    projectSlug: "demo",
    projectName: "Demo Project",
    status: "pending",
    ...overrides,
  };
}

/** Fetch mock that serves the current goal plus a list of project-scoped HITL items. */
function installGoalHitlFetchMock(opts: {
  goal: GoalState;
  hitl: DashboardHitlItem[];
}): ReturnType<typeof mock> {
  const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;

    // Project-scoped HITL list route must be checked before the generic goal route.
    if (url.endsWith("/api/projects/demo/hitl") || url.includes("/api/projects/demo/hitl?")) {
      return Response.json({ hitl: opts.hitl });
    }
    if (url.includes("/api/projects/demo/hitl/") && init?.method === "POST") {
      return Response.json({ ok: true, hitlId: url.split("/").slice(-2, -1)[0] });
    }
    if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/projects/:slug/goals/:goalId" element={<GoalDetailRoute />} />
            <Route path="/projects/:slug/sessions/:sessionId" element={<div data-testid="session-mock" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

// ─── Tests ───

describe("GoalDetailRoute", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    restoreGlobals();
    mock.restore();
  });

  test("renders goal title and phase/status header", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ title: "My Feature Goal", status: "running", phase: "build" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        expect(container.textContent).toContain("build");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("overview tab shows done conditions with pass/fail/evidence", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const passingCondition = makeDoneCondition({ id: "cond-pass", kind: "tests_pass", params: { command: "bun test" } });
    const failingCondition = makeDoneCondition({ id: "cond-fail", kind: "typecheck_pass", params: { command: "bun run typecheck" } });
    const uncheckedCondition = makeDoneCondition({ id: "cond-unchecked", kind: "file_exists", params: { path: "/src/index.ts" } });

    const goal = makeGoal({
      doneConditions: [passingCondition, failingCondition, uncheckedCondition],
      doneResults: {
        "cond-pass": makeDoneResult({ conditionId: "cond-pass", passed: true, evidence: "17 pass, 0 fail" }),
        "cond-fail": makeDoneResult({ conditionId: "cond-fail", passed: false, evidence: "TS2322: type error in foo.ts" }),
      },
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        const overview = container.querySelector('[data-testid="goal-overview"]');
        expect(overview).not.toBeNull();
      });

      const overviewText = container.querySelector('[data-testid="goal-overview"]')!.textContent ?? "";
      expect(overviewText).toContain("tests_pass");
      expect(overviewText).toContain("bun test");
      expect(overviewText).toContain("17 pass, 0 fail");
      expect(overviewText).toContain("typecheck_pass");
      expect(overviewText).toContain("bun run typecheck");
      expect(overviewText).toContain("TS2322: type error in foo.ts");
      expect(overviewText).toContain("file_exists");
      expect(overviewText).toContain("/src/index.ts");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("overview tab shows retry chain and reviewer evidence", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const reviewerCondition: DoneCondition = {
      id: "cond-review",
      kind: "user_confirmed",
      params: { prompt: "Reviewer approval" },
      required: true,
    };

    const goal = makeGoal({
      status: "failed",
      phase: "review",
      retryCount: 2,
      lastError: "Verification failed: typecheck errors remain",
      doneConditions: [reviewerCondition],
      doneResults: {
        "cond-review": makeDoneResult({
          conditionId: "cond-review",
          passed: false,
          evidence: "Reviewer rejected: missing edge case handling",
        }),
      },
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        const overview = container.querySelector('[data-testid="goal-overview"]');
        expect(overview).not.toBeNull();
      });

      const overviewText = container.querySelector('[data-testid="goal-overview"]')!.textContent ?? "";
      expect(overviewText).toContain("2");
      expect(overviewText).toContain("Verification failed: typecheck errors remain");
      expect(overviewText).toContain("Reviewer rejected: missing edge case handling");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("sessions tab shows child sessions", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({
      childSessionIds: ["plan-session-1", "build-session-1", "review-session-1"],
      mainSessionId: "main-session-1",
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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

      await act(async () => {
        findElementByText(container, "Sessions").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const sessionsTab = container.querySelector('[data-testid="goal-tab-sessions"]');
        expect(sessionsTab).not.toBeNull();
      });

      const sessionsText = container.querySelector('[data-testid="goal-tab-sessions"]')!.textContent ?? "";
      expect(sessionsText).toContain("main-session-1");
      expect(sessionsText).toContain("plan-session-1");
      expect(sessionsText).toContain("build-session-1");
      expect(sessionsText).toContain("review-session-1");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("chat tab renders chat replay view", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ mainSessionId: "main-session-1" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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

      await act(async () => {
        findElementByText(container, "Chat").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const chatTab = container.querySelector('[data-testid="goal-tab-chat"]');
        expect(chatTab).not.toBeNull();
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("switching tabs updates visible content", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({
      childSessionIds: ["child-1"],
      mainSessionId: "main-1",
      doneConditions: [makeDoneCondition({ id: "cond-1", kind: "tests_pass" })],
      doneResults: {
        "cond-1": makeDoneResult({ conditionId: "cond-1", passed: true, evidence: "ok" }),
      },
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        expect(container.querySelector('[data-testid="goal-overview"]')).not.toBeNull();
      });

      await act(async () => {
        findElementByText(container, "Sessions").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="goal-tab-sessions"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="goal-overview"]')).toBeNull();
      });

      await act(async () => {
        findElementByText(container, "Chat").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="goal-tab-chat"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="goal-tab-sessions"]')).toBeNull();
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("draft goal renders Lock Goal button and calls lock endpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const draftGoal = makeGoal({ id: "goal-1", title: "Draft Goal", status: "draft", phase: "plan" });
    const lockedGoal = makeGoal({ id: "goal-1", title: "Draft Goal", status: "locked", phase: "plan", lockedBy: "architect" });
    let currentGoal: GoalState = draftGoal;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1/lock") && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        expect(body.lockedBy).toStartWith("web-");
        currentGoal = lockedGoal;
        return Response.json(lockedGoal);
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        expect(container.textContent).toContain("Draft Goal");
        expect(container.textContent).toContain("Lock Goal");
      });

      await act(async () => {
        findElementByText(container, "Lock Goal").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.textContent).toContain("locked");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("locked goal renders Run Goal button and calls run endpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const lockedGoal = makeGoal({ id: "goal-1", title: "Locked Goal", status: "locked", phase: "plan", lockedBy: "architect" });
    const runningGoal = makeGoal({ id: "goal-1", title: "Locked Goal", status: "running", phase: "plan", mainSessionId: "session-1" });
    let currentGoal: GoalState = lockedGoal;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1/run") && init?.method === "POST") {
        currentGoal = runningGoal;
        return Response.json(runningGoal);
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        expect(container.textContent).toContain("Locked Goal");
        expect(container.textContent).toContain("Run Goal");
      });

      await act(async () => {
        findElementByText(container, "Run Goal").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
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

  test("paused goal renders Resume Goal button and calls run endpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const pausedGoal = makeGoal({ id: "goal-1", title: "Paused Goal", status: "paused", phase: "plan", mainSessionId: "session-1" });
    const reservedGoal = makeGoal({ id: "goal-1", title: "Paused Goal", status: "paused", phase: "plan", mainSessionId: "session-1" });
    let currentGoal: GoalState = pausedGoal;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1/run") && init?.method === "POST") {
        currentGoal = reservedGoal;
        return Response.json(reservedGoal);
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
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
        expect(container.textContent).toContain("Paused Goal");
        expect(container.textContent).toContain("Resume Goal");
      });

      await act(async () => {
        findElementByText(container, "Resume Goal").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/run"), expect.objectContaining({ method: "POST" }));
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("displays run mutation errors", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const lockedGoal = makeGoal({ id: "goal-1", title: "Locked Goal", status: "locked", phase: "plan", lockedBy: "architect" });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals/goal-1/run") && init?.method === "POST") {
        return Response.json({ error: { code: "BAD_REQUEST", message: "Goal is already reserved" } }, { status: 409 });
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
        return Response.json(lockedGoal);
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
        expect(container.textContent).toContain("Run Goal");
      });

      await act(async () => {
        findElementByText(container, "Run Goal").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.textContent).toContain("Goal is already reserved");
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

  // ─── Artifacts tab tests ───

  function makeArtifactFile(name: GoalArtifactName, overrides: Partial<GoalArtifactFile> = {}): GoalArtifactFile {
    return {
      name,
      path: `.archcode/goals/goal-1/artifacts/${name}`,
      mediaType: "text/markdown",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sizeBytes: 128,
      sha256: "abc123",
      ...overrides,
    };
  }

  function installArtifactFetchMock(opts: {
    goal: GoalState;
    artifacts: GoalArtifactFile[];
    contents: Record<string, string>;
  }): ReturnType<typeof mock> {
    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;

      if (url.endsWith("/artifacts")) {
        return Response.json({ artifacts: opts.artifacts });
      }
      const artifactMatch = url.match(/\/artifacts\/([^/]+)$/);
      if (artifactMatch) {
        const name = decodeURIComponent(artifactMatch[1]);
        const content = opts.contents[name];
        if (content === undefined) {
          return new Response("Not found", { status: 404 });
        }
        const artifact = opts.artifacts.find((file) => file.name === name);
        return Response.json({ artifact, content });
      }
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals") && !url.includes("/artifacts")) {
        return Response.json(opts.goal);
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });
    return fetchMock;
  }

  test("artifacts tab renders read-only markdown for present artifacts", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ status: "running", phase: "build" });
    const artifacts = [
      makeArtifactFile("plan.md"),
      makeArtifactFile("review.md"),
      makeArtifactFile("budget.md"),
    ];
    const contents: Record<string, string> = {
      "plan.md": "# Plan\n\nImplementation steps for the goal.",
      "review.md": "# Review\n\nReviewer notes.",
      "budget.md": "# Budget\n\nToken usage ledger.",
    };

    installArtifactFetchMock({ goal, artifacts, contents });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      await act(async () => {
        findElementByText(container, "Artifacts").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="goal-tab-artifacts"]')).not.toBeNull();
      });

      await act(async () => {
        container.querySelector('[data-testid="artifact-tab-plan"]')!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const viewer = container.querySelector('[data-testid="artifact-markdown-viewer"]');
        expect(viewer).not.toBeNull();
        expect(viewer!.textContent).toContain("Plan");
        expect(viewer!.textContent).toContain("Implementation steps for the goal");
      });

      expect(container.querySelector('[data-testid="artifact-edit-button"]')).toBeNull();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("artifacts tab exposes all canonical daily-use artifacts and renders final report", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ status: "completed", phase: "review" });
    const artifacts = [
      makeArtifactFile("plan.md"),
      makeArtifactFile("build.md"),
      makeArtifactFile("review.md"),
      makeArtifactFile("spec-compliance.md"),
      makeArtifactFile("approvals.md"),
      makeArtifactFile("budget.md"),
      makeArtifactFile("retry-log.md"),
      makeArtifactFile("final-report.md"),
    ];
    const contents: Record<string, string> = {
      "plan.md": "# Plan\n\nPlan artifact locked after Plan Agent.",
      "build.md": "# Build\n\nBuild artifact for implementation evidence.",
      "review.md": "# Review\n\nReviewer verdict: DONE.",
      "spec-compliance.md": "# Spec Compliance\n\nAC-001 satisfied. AC-002 satisfied.",
      "approvals.md": "# Approval History\n\nafter_plan approved.",
      "budget.md": "# Budget Ledger\n\napproval_budget_1 approved.",
      "retry-log.md": "# Retry Log\n\nAttempt 1 scheduled; Attempt 1 running.",
      "final-report.md": "# Final Report\n\nFinal status | completed\nReview outcome | DONE",
    };

    installArtifactFetchMock({ goal, artifacts, contents });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      await act(async () => {
        findElementByText(container, "Artifacts").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        for (const testId of [
          "artifact-tab-plan",
          "artifact-tab-build",
          "artifact-tab-review",
          "artifact-tab-spec-compliance",
          "artifact-tab-approvals",
          "artifact-tab-budget",
          "artifact-tab-retry-log",
          "artifact-tab-final-report",
        ]) {
          expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
        }
        expect(container.textContent).toContain("8 artifacts present");
      });

      await act(async () => {
        container.querySelector('[data-testid="artifact-tab-final-report"]')!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const viewer = container.querySelector('[data-testid="artifact-markdown-viewer"]');
        expect(viewer).not.toBeNull();
        expect(viewer!.textContent).toContain("Final Report");
        expect(viewer!.textContent).toContain("completed");
        expect(viewer!.textContent).toContain("DONE");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("artifacts tab shows review and budget content when selected", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ status: "running", phase: "review" });
    const artifacts = [
      makeArtifactFile("plan.md"),
      makeArtifactFile("review.md"),
      makeArtifactFile("budget.md"),
    ];
    const contents: Record<string, string> = {
      "plan.md": "# Plan\n\nSteps.",
      "review.md": "# Review\n\nReviewer evidence and verdict.",
      "budget.md": "# Budget\n\n| Phase | Tokens |\n|---|---|\n| plan | 100 |",
    };

    installArtifactFetchMock({ goal, artifacts, contents });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      await act(async () => {
        findElementByText(container, "Artifacts").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="goal-tab-artifacts"]')).not.toBeNull();
      });

      await act(async () => {
        container.querySelector('[data-testid="artifact-tab-review"]')!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const viewer = container.querySelector('[data-testid="artifact-markdown-viewer"]');
        expect(viewer).not.toBeNull();
        expect(viewer!.textContent).toContain("Reviewer evidence and verdict");
      });

      await act(async () => {
        container.querySelector('[data-testid="artifact-tab-budget"]')!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const viewer = container.querySelector('[data-testid="artifact-markdown-viewer"]');
        expect(viewer).not.toBeNull();
        expect(viewer!.textContent).toContain("Budget");
        expect(viewer!.textContent).toContain("plan");
        expect(viewer!.textContent).toContain("100");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("missing artifact empty state shows No artifact available", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ status: "running", phase: "build" });
    const artifacts = [
      makeArtifactFile("plan.md"),
      makeArtifactFile("review.md"),
      makeArtifactFile("budget.md"),
    ];
    const contents: Record<string, string> = {
      "plan.md": "# Plan\n\nSteps.",
      "review.md": "# Review\n\nNotes.",
      "budget.md": "# Budget\n\nLedger.",
    };

    installArtifactFetchMock({ goal, artifacts, contents });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Test Goal");
      });

      await act(async () => {
        findElementByText(container, "Artifacts").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="goal-tab-artifacts"]')).not.toBeNull();
      });

      await act(async () => {
        container.querySelector('[data-testid="artifact-tab-final-report"]')!.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const viewer = container.querySelector('[data-testid="artifact-markdown-viewer"]');
        expect(viewer).not.toBeNull();
        expect(viewer!.textContent).toContain("No artifact available");
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

    const goal = makeGoal({ id: "goal-1", status: "running", phase: "build" });
    const matchingItem = makeHitlItem({
      hitlId: "hitl-goal-1",
      kind: "approval",
      displayPayload: { title: "Approve budget?", summary: "Confirm spend", redacted: true },
      trigger: { projectSlug: "demo", goalId: "goal-1", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
    });

    installGoalHitlFetchMock({ goal, hitl: [matchingItem] });

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
      expect(queue.textContent).toContain("Approval Queue");
      expect(queue.textContent).toContain("Approve budget?");
      expect(queue.textContent).toContain("Confirm spend");
      expect(queue.querySelectorAll('[data-testid="hitl-card"]')).toHaveLength(1);
      expect(queue.querySelector('[data-testid="hitl-context-session"]')?.getAttribute("href")).toBe("/projects/demo/sessions/session-1");
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

    const goal = makeGoal({ id: "goal-1", status: "running", phase: "build" });
    const ownItem = makeHitlItem({
      hitlId: "hitl-own",
      displayPayload: { title: "Own approval", redacted: true },
      trigger: { projectSlug: "demo", goalId: "goal-1", source: "goal.approval.after_plan" },
    });
    const otherItem = makeHitlItem({
      hitlId: "hitl-other",
      displayPayload: { title: "Other goal approval", redacted: true },
      trigger: { projectSlug: "demo", goalId: "goal-other", source: "goal.approval.after_plan" },
    });

    installGoalHitlFetchMock({ goal, hitl: [ownItem, otherItem] });

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
      expect(queueText).not.toContain("Other goal approval");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("goal approval queue shows empty state when no matching HITL", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running", phase: "build" });
    const unrelatedItem = makeHitlItem({
      hitlId: "hitl-unrelated",
      displayPayload: { title: "Unrelated", redacted: true },
      trigger: { projectSlug: "demo", goalId: "goal-other", source: "test" },
    });

    installGoalHitlFetchMock({ goal, hitl: [unrelatedItem] });

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
      expect(queueText).not.toContain("Unrelated");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("goal approval queue renders only redacted displayPayload and never raw secrets", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goal = makeGoal({ id: "goal-1", status: "running", phase: "build" });
    const redactedItem = makeHitlItem({
      hitlId: "hitl-redacted",
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
      trigger: { projectSlug: "demo", goalId: "goal-1", source: "goal.approval.approval_budget_1", approvalPoint: "approval_budget_1" },
    });
    const unsafeApiItem: DashboardHitlItem & { payload: unknown } = {
      ...redactedItem,
      hitlId: "hitl-unsafe",
      payload: {
        title: "RAW payload sk-test-secret-goal",
        context: { apiKey: "sk-test-secret-goal", connection: "apiKey=sk-test-secret-goal" },
      },
    };

    installGoalHitlFetchMock({ goal, hitl: [redactedItem, unsafeApiItem] });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        const queue = container.querySelector('[data-testid="goal-approval-queue"]');
        expect(queue).not.toBeNull();
        expect(queue!.querySelectorAll('[data-testid="hitl-card"]')).toHaveLength(2);
      });

      const queueText = container.querySelector('[data-testid="goal-approval-queue"]')!.textContent ?? "";
      expect(queueText).toContain("[REDACTED]");
      expect(queueText).toContain("approve_budget");
      expect(queueText).not.toContain("RAW payload");
      expect(queueText).not.toContain("sk-test-secret-goal");
      expect(queueText).not.toContain("apiKey=sk");
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

    const goal = makeGoal({ id: "goal-1", status: "running", phase: "build" });
    const matchingItem = makeHitlItem({
      hitlId: "hitl-cancel-target",
      kind: "approval",
      displayPayload: { title: "Approve?", redacted: true },
      trigger: { projectSlug: "demo", goalId: "goal-1", source: "goal.approval.after_plan" },
    });

    const fetchMock = installGoalHitlFetchMock({ goal, hitl: [matchingItem] });

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
