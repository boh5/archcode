import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { GoalState } from "../api/types";
import { GoalsRoute } from "./goals";

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

function installDom(path = "/projects/demo/goals"): JSDOM {
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

function makeGoal(overrides: Partial<GoalState> = {}): GoalState {
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
    version: 4,
    createdFromSessionId: "origin",
    useWorktree: overrides.useWorktree ?? false,
    mainSessionId: "main-session",
    startedAt: "2026-01-01T00:00:00Z",
  };
}

async function renderGoalsRoute(
  root: Root,
  queryClient: QueryClient,
  initialPath = "/projects/demo/goals",
): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/projects/:slug/goals" element={<GoalsRoute />} />
            <Route path="/projects/:slug/goals/:goalId" element={<div data-testid="goal-detail-mock" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

// ─── Tests ───

describe("GoalsRoute", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    restoreGlobals();
    mock.restore();
  });

  test("renders goal list with title and status", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goals: GoalState[] = [
      makeGoal({ id: "goal-1", title: "Implement auth", status: "running" }),
      makeGoal({ id: "goal-2", title: "Add tests", status: "done" }),
    ];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals") && !url.includes("/goals/")) {
        return Response.json({ goals });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalsRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Implement auth");
        expect(container.textContent).toContain("Add tests");
      });

      expect(container.textContent).toContain("running");
      expect(container.textContent).toContain("done");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("clicking a goal navigates to goal detail", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goals: GoalState[] = [
      makeGoal({ id: "goal-abc", title: "Click me goal" }),
    ];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals") && !url.includes("/goals/")) {
        return Response.json({ goals });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalsRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Click me goal");
      });

      await act(async () => {
        findElementByText(container, "Click me goal").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const detailMock = container.querySelector('[data-testid="goal-detail-mock"]');
        expect(detailMock).not.toBeNull();
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("shows empty state with New Goal button when no goals exist", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals") && !url.includes("/goals/")) {
        return Response.json({ goals: [] });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalsRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("No goals yet");
      });

      const newGoalButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
        b.textContent?.includes("New Goal"),
      );
      expect(newGoalButtons.length).toBeGreaterThanOrEqual(1);
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("non-empty list header shows New Goal button", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const goals: GoalState[] = [makeGoal({ id: "goal-1", title: "Solo goal" })];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals") && !url.includes("/goals/")) {
        return Response.json({ goals });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalsRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Solo goal");
      });

      const newGoalButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
        b.textContent?.includes("New Goal"),
      );
      expect(newGoalButtons.length).toBeGreaterThanOrEqual(1);
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("shows loading state while fetching", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/goals") && !url.includes("/goals/")) {
        // Delay to keep loading state visible
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json({ goals: [] });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderGoalsRoute(reactRoot, queryClient);

      expect(container.textContent).toContain("Loading");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });
});
