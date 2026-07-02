import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { GoalState, DoneCondition, DoneResult } from "../api/types";
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
      if (url.includes("/api/projects/demo/goals/goal-1") && !url.endsWith("/goals")) {
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
});
