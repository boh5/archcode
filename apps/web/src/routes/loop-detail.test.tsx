import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { LoopRunReport, LoopState } from "../api/types";
import { LoopDetailRoute } from "./loop-detail";

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

function installDom(path = "/projects/demo/loops/loop-1"): JSDOM {
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

async function waitFor(assertion: () => void, timeoutMs = 3000): Promise<void> {
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

async function renderLoopDetailRoute(
  root: Root,
  queryClient: QueryClient,
  initialPath = "/projects/demo/loops/loop-1",
): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/projects/:slug/loops/:loopId" element={<LoopDetailRoute />} />
            <Route path="/projects/:slug/loops" element={<div data-testid="loops-list" />} />
            <Route path="/projects/:slug/sessions/:sessionId" element={<div data-testid="session-route" />} />
            <Route path="/projects/:slug/goals/:goalId" element={<div data-testid="goal-route" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function findElementByText(container: Element, text: string): Element {
  const elements = Array.from(container.querySelectorAll("*")).reverse();
  const match = elements.find((element) => element.textContent?.includes(text));
  if (!match) throw new Error(`Unable to find element containing "${text}"`);
  return match;
}

function makeRun(overrides: Partial<LoopRunReport> = {}): LoopRunReport {
  return {
    runId: "run-1",
    loopId: "loop-1",
    status: "succeeded",
    trigger: "manual",
    startedAt: 1700000000000,
    ...overrides,
  };
}

function makeLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
    projectId: "demo",
    config: {
      title: "Daily Triage Loop",
      description: "Checks local project health",
      schedule: { kind: "interval", everyMs: 60000 },
      runKind: "goal",
      mode: "act",
      approvalPolicy: "explicit_per_run",
      limits: { maxIterationsPerRun: 6 },
      taskPrompt: "Review failing tests and summarize concrete next steps.",
      goalTemplate: {
        title: "Triage Follow-up Goal",
        author: "architect",
        doneConditions: [
          { id: "cond-1", kind: "tests_pass", params: { command: "bun test" }, required: true },
        ],
        retryPolicy: { maxRetries: 2, backoffMs: 1000, escalateOnFailure: true },
        approvalPoints: ["after_plan"],
        reviewerAgent: "reviewer",
      },
    },
    status: "active",
    createdAt: 1700000000000,
    updatedAt: 1700000100000,
    nextRunAt: 1700000200000,
    runCount: 2,
    stateVersion: 1,
    generatedStateSummary: "Generated state summary from the latest loop run.",
    lastRun: makeRun({
      runId: "run-last",
      status: "succeeded",
      trigger: "interval",
      endedAt: 1700000060000,
      sessionId: "session-last",
      goalId: "goal-last",
      summary: "Previous run completed with a local health summary.",
    }),
    currentRun: makeRun({
      runId: "run-current",
      status: "running",
      trigger: "manual",
      sessionId: "session-current",
      goalId: "goal-current",
    }),
    ...overrides,
  };
}

function setupLoopDetailFetch(input: {
  loop?: LoopState;
  runs?: LoopRunReport[];
  stateMarkdown?: string;
  triggerConflict?: boolean;
} = {}): { paths: string[]; fetchMock: ReturnType<typeof mock>; setLoop: (loop: LoopState) => void } {
  let currentLoop = input.loop ?? makeLoop();
  let runs = input.runs ?? [
    makeRun({
      runId: "run-history-1",
      status: "failed",
      trigger: "manual",
      sessionId: "session-history",
      goalId: "goal-history",
      summary: "Investigated the failure.",
      error: "Typecheck failed",
    }),
    makeRun({
      runId: "run-history-2",
      status: "skipped",
      trigger: "interval",
      skippedReason: "Loop is already running",
    }),
  ];
  const paths: string[] = [];

  const fetchMock = mock(async (inputValue: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = toPath(inputValue);
    paths.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/api/projects/demo/loops/loop-1/trigger" && init?.method === "POST") {
      if (input.triggerConflict) {
        return Response.json(
          { error: { code: "LOOP_ACTIVE_CONFLICT", message: "manual trigger blocked" } },
          { status: 409 },
        );
      }

      const report = makeRun({
        runId: "run-triggered",
        status: "running",
        trigger: "manual",
        sessionId: "session-triggered",
        goalId: "goal-triggered",
      });
      runs = [report, ...runs];
      currentLoop = {
        ...currentLoop,
        currentRun: report,
        runCount: currentLoop.runCount + 1,
        updatedAt: 1700000300000,
      };
      return Response.json({ report });
    }

    if (path === "/api/projects/demo/loops/loop-1/pause" && init?.method === "POST") {
      currentLoop = { ...currentLoop, status: "paused", updatedAt: 1700000400000 };
      return Response.json({ loop: currentLoop });
    }

    if (path === "/api/projects/demo/loops/loop-1/resume" && init?.method === "POST") {
      currentLoop = { ...currentLoop, status: "active", nextRunAt: 1700000500000, updatedAt: 1700000500000 };
      return Response.json({ loop: currentLoop });
    }

    if (path === "/api/projects/demo/loops/loop-1/runs") {
      return Response.json({ runs });
    }

    if (path === "/api/projects/demo/loops/loop-1/state") {
      return Response.json({
        markdown: input.stateMarkdown ?? "# Loop State\n\nGenerated state summary from markdown.",
        state: currentLoop,
      });
    }

    if (path === "/api/projects/demo/loops/loop-1") {
      return Response.json({ loop: currentLoop });
    }

    return new Response("Not found", { status: 404 });
  });

  Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

  return {
    paths,
    fetchMock,
    setLoop: (loop: LoopState) => {
      currentLoop = loop;
    },
  };
}

function toPath(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname + input.search;
  const url = new URL(input.url);
  return url.pathname + url.search;
}

describe("LoopDetailRoute", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    restoreGlobals();
    mock.restore();
  });

  test("trigger pause resume buttons call endpoints, refetch visible status, and keep forbidden UI absent", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    const { paths } = setupLoopDetailFetch();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Daily Triage Loop");
        expect(container.textContent).toContain("Config");
        expect(container.textContent).toContain("Live Status");
        expect(container.textContent).toContain("Run History");
        expect(container.textContent).toContain("State");
      });

      const pageText = container.textContent ?? "";
      expect(pageText).toContain("interval 60000ms");
      expect(pageText).toContain("goal");
      expect(pageText).toContain("act");
      expect(pageText).toContain("explicit_per_run");
      expect(pageText).toContain("6");
      expect(pageText).toContain("Review failing tests and summarize concrete next steps.");
      expect(pageText).toContain("Triage Follow-up Goal by architect");
      expect(pageText).toContain("run-current running manual");
      expect(pageText).toContain("run-last succeeded interval");
      expect(pageText).toContain("run-history-1");
      expect(pageText).toContain("Typecheck failed");
      expect(pageText).toContain("Loop is already running");
      expect(pageText).toContain("Generated state summary from markdown.");

      expect(container.querySelector('a[href="/projects/demo/sessions/session-current"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/goals/goal-current"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/sessions/session-history"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/goals/goal-history"]')).not.toBeNull();

      const lowerText = pageText.toLowerCase();
      expect(lowerText).not.toContain("readiness");
      expect(lowerText).not.toContain("budget");
      expect(lowerText).not.toContain("cron");

      await act(async () => {
        findElementByText(container, "Trigger manual run").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/loop-1/trigger");
        expect(container.textContent).toContain("run-triggered running manual");
      });

      await act(async () => {
        findElementByText(container, "Pause").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/loop-1/pause");
        expect(container.querySelector('[data-testid="loop-status-badge"]')?.textContent).toContain("paused");
      });

      await act(async () => {
        findElementByText(container, "Resume").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/loop-1/resume");
        expect(container.querySelector('[data-testid="loop-status-badge"]')?.textContent).toContain("active");
        expect(container.textContent).toContain("2023-11-14T22:21:40.000Z");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("trigger conflict 409 displays Loop is already running", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    setupLoopDetailFetch({
      triggerConflict: true,
      runs: [
        makeRun({
          runId: "run-conflict-history",
          status: "failed",
          trigger: "manual",
          summary: "Previous manual run failed before the conflict check.",
          error: "Typecheck failed",
        }),
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Trigger manual run");
      });

      expect(container.textContent).not.toContain("Loop is already running");
      expect(container.querySelector('[role="alert"]')).toBeNull();

      await act(async () => {
        findElementByText(container, "Trigger manual run").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        const alert = container.querySelector('[role="alert"]');
        expect(alert).not.toBeNull();
        expect(alert?.textContent).toContain("Loop is already running");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("renders simple error when route params are missing", async () => {
    const dom = installDom("/loops/missing");
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    setupLoopDetailFetch();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await act(async () => {
        reactRoot.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/loops/missing"]}>
              <Routes>
                <Route path="/loops/:loopId" element={<LoopDetailRoute />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      });

      await waitFor(() => {
        expect(container.textContent).toContain("Missing loop route parameters");
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
