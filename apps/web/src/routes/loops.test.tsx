import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { LoopState } from "../api/types";
import { LoopsRoute } from "./loops";
import { CreateLoopForm } from "../components/features/CreateLoopDialog";

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

function installDom(path = "/projects/demo/loops"): JSDOM {
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

  // React 19 input polyfill calls attachEvent/detachEvent which JSDOM lacks.
  const htmlProto = dom.window.HTMLElement.prototype as unknown as {
    attachEvent?: unknown;
    detachEvent?: unknown;
  };
  htmlProto.attachEvent = htmlProto.attachEvent ?? (() => {});
  htmlProto.detachEvent = htmlProto.detachEvent ?? (() => {});

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

function makeLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
    projectId: "demo",
    config: {
      templateId: "watch_report",
      title: "Test Loop",
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: {
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMsPerRun: 900000,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      budget: {
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMsPerRun: 900000,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      taskPrompt: "Run a local report.",
    },
    status: "active",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    runCount: 0,
    stateVersion: 1,
    ...overrides,
  };
}

async function renderLoopsRoute(
  root: Root,
  queryClient: QueryClient,
  initialPath = "/projects/demo/loops",
): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/projects/:slug/loops" element={<LoopsRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function renderCreateLoopForm(
  root: Root,
  queryClient: QueryClient,
  slug = "demo",
  onCreated: (loopId: string) => void = () => {},
  initialState?: Partial<import("../components/features/CreateLoopDialog").LoopFormState>,
): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CreateLoopForm slug={slug} onCreated={onCreated} initialState={initialState} />
      </QueryClientProvider>,
    );
  });
}

function submitCreateLoopForm(container: Element): void {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing create loop form");
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}

// ─── Tests ───

describe("LoopsRoute", () => {
  beforeEach(() => {
    mock.restore();
  });

  afterEach(() => {
    restoreGlobals();
    mock.restore();
  });

  test("renders loop list with title, primary state, schedule, last run, and next run; hides internals", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const loops: LoopState[] = [
      makeLoop({
        loopId: "loop-1",
        config: {
          templateId: "watch_report",
          title: "Daily Triage Loop",
          schedule: { kind: "cron", expression: "*/15 * * * *" },
          triggers: [{ kind: "on_pr", cadenceMs: 60000 }],
          approvalPolicy: "interactive",
          limits: { maxIterationsPerRun: 8 },
        },
        status: "active",
        lastRun: {
          runId: "run-1",
          loopId: "loop-1",
          status: "succeeded",
          trigger: "interval",
          startedAt: 1700000000000,
          endedAt: 1700000010000,
        },
        nextRunAt: 1700000060000,
        currentJob: {
          jobId: "job-1",
          loopId: "loop-1",
          status: "blocked",
          triggerKind: "on_pr",
          subjectKey: "github:test-owner/test-repo:pr:42",
          dedupeKey: "loop-1:on_pr:42",
          branchKey: "test-owner/test-repo:feature-loop",
          queuedAt: 1700000020000,
          attempts: 1,
          blockedReason: "needs-review",
          worktreePath: "/safe/worktrees/loop-1",
          cleanupState: "cleanup_candidate",
        },
        queuedJobs: [
          {
            jobId: "job-2",
            loopId: "loop-1",
            status: "queued",
            triggerKind: "cron",
            subjectKey: "cron:*/15",
            dedupeKey: "loop-1:cron:1700000060000",
            queuedAt: 1700000060000,
            attempts: 0,
          },
        ],
        triggerHealth: [
          { triggerKind: "on_pr", status: "healthy", cadenceMs: 60000, lastCheckedAt: 1700000030000 },
        ],
        cleanupState: "auto_paused",
      }),
      makeLoop({
        loopId: "loop-2",
        config: {
          templateId: "goal_runner",
          title: "Manual Goal Loop",
          schedule: { kind: "manual" },
          approvalPolicy: "explicit_per_run",
          limits: { maxIterationsPerRun: 4 },
        },
        status: "paused",
      }),
    ];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/loops") && !url.includes("/loops/")) {
        return Response.json({ loops });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopsRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Daily Triage Loop");
        expect(container.textContent).toContain("Manual Goal Loop");
      });

      expect(container.textContent).toContain("cron UTC */15 * * * *");
      expect(container.textContent).toContain("manual");
      expect(container.textContent).toContain("template: watch_report");
      expect(container.textContent).toContain("template: goal_runner");
      expect(container.textContent).toContain("Completed");
      expect(container.textContent).toContain("Awaiting Input");
      expect(container.textContent).toContain("next:");

      const primaryStates = container.querySelectorAll('[data-testid="loop-primary-state"]');
      expect(primaryStates.length).toBe(2);

      const lowerText = (container.textContent ?? "").toLowerCase();
      expect(lowerText).not.toContain("trigger health");
      expect(lowerText).not.toContain("queue:");
      expect(lowerText).not.toContain("cleanup");
      expect(lowerText).not.toContain("dedupekey");
      expect(lowerText).not.toContain("subjectkey");
      expect(lowerText).not.toContain("branchkey");
      expect(lowerText).not.toContain("runkind");
      expect(lowerText).not.toContain("toolprofileid");
      expect(lowerText).not.toContain("job-1");
      expect(lowerText).not.toContain("job-2");
      expect(lowerText).not.toContain("needs-review");
      expect(lowerText).not.toContain("auto_paused");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("shows empty state with New Loop button when no loops exist", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.includes("/api/projects/demo/loops") && !url.includes("/loops/")) {
        return Response.json({ loops: [] });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopsRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("No loops yet");
      });

      const newLoopButtons = Array.from(container.querySelectorAll("button")).filter((b) =>
        b.textContent?.includes("New Loop"),
      );
      expect(newLoopButtons.length).toBeGreaterThanOrEqual(1);
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("creates manual session loop", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let postedBody: Record<string, unknown> | undefined;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        postedBody = init.body ? JSON.parse(init.body as string) : undefined;
        return Response.json({ loop: makeLoop() });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "watch_report",
        title: "Manual Session",
        scheduleKind: "manual",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Summarize local project health.",
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);

      await act(async () => {
        submitCreateLoopForm(container);
      });

      await waitFor(() => {
        expect(postedBody).toBeDefined();
      });

      expect(postedBody!.templateId).toBe("watch_report");
      expect(postedBody!.config).toBeUndefined();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("creates interval session loop", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let postedBody: Record<string, unknown> | undefined;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        postedBody = init.body ? JSON.parse(init.body as string) : undefined;
        return Response.json({ loop: makeLoop() });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "watch_report",
        title: "Interval Session",
        scheduleKind: "interval",
        everyMs: 60000,
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Draft the interval report.",
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);

      await act(async () => {
        submitCreateLoopForm(container);
      });

      await waitFor(() => {
        expect(postedBody).toBeDefined();
      });

      expect(postedBody!.templateId).toBe("watch_report");
      expect(postedBody!.config).toBeUndefined();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("creates cron session loop with five-field UTC expression", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let postedBody: Record<string, unknown> | undefined;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        postedBody = init.body ? JSON.parse(init.body as string) : undefined;
        return Response.json({ loop: makeLoop() });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "watch_report",
        title: "Cron Session",
        scheduleKind: "cron",
        cronExpression: "*/15 * * * *",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Draft the cron report.",
      });

      expect(container.querySelector('[data-testid="loop-schedule-kind"]')).not.toBeNull();
      expect((container.querySelector('[data-testid="loop-cron-expression"]') as HTMLInputElement | null)?.value).toBe("*/15 * * * *");
      const submitButton = container.querySelector('[data-testid="loop-create-submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);

      await act(async () => {
        submitCreateLoopForm(container);
      });

      await waitFor(() => {
        expect(postedBody).toBeDefined();
      });

      expect(postedBody!.templateId).toBe("watch_report");
      expect(postedBody!.config).toBeUndefined();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("rejects six-field cron expression with exact validation text", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    Object.defineProperty(globalThis, "fetch", { value: mock(async () => new Response("Unexpected", { status: 500 })), configurable: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "watch_report",
        title: "Invalid Cron",
        scheduleKind: "cron",
        cronExpression: "*/15 * * * * *",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Summarize local project health.",
      });

      expect(container.textContent).toContain("Cron must be a 5-field UTC expression");
      const submitButton = container.querySelector('[data-testid="loop-create-submit"]') as HTMLButtonElement;
      expect(submitButton.disabled).toBe(true);
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("creates pr_babysitter loop from template selection", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let postedBody: Record<string, unknown> | undefined;
    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        postedBody = init.body ? JSON.parse(init.body as string) : undefined;
        return Response.json({ loop: makeLoop() });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "pr_babysitter",
        title: "PR Watch",
        scheduleKind: "manual",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Watch pull requests.",
      });

      expect(container.textContent).toContain("PR Babysitter");
      await act(async () => {
        submitCreateLoopForm(container);
      });

      await waitFor(() => {
        expect(postedBody).toBeDefined();
      });

      expect(postedBody!.templateId).toBe("pr_babysitter");
      expect(postedBody!.config).toBeUndefined();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("invalid cron expression shows exact validation text and disables submit", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    Object.defineProperty(globalThis, "fetch", { value: mock(async () => new Response("Unexpected", { status: 500 })), configurable: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "pr_babysitter",
        title: "Bad Cron",
        scheduleKind: "cron",
        cronExpression: "*/15 * * * * *",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Watch pull requests.",
      });

      expect(container.textContent).toContain("Cron must be a 5-field UTC expression");
      const submitButton = container.querySelector('[data-testid="loop-create-submit"]') as HTMLButtonElement;
      expect(submitButton.disabled).toBe(true);
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("renders required selectors and keeps forbidden loop form UI absent", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    Object.defineProperty(globalThis, "fetch", { value: mock(async () => new Response("Unexpected", { status: 500 })), configurable: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "watch_report",
        title: "Selector Check",
        scheduleKind: "cron",
        cronExpression: "*/15 * * * *",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        taskPrompt: "Summarize local project health.",
      });

      for (const testId of [
        "loop-schedule-kind",
        "loop-cron-expression",
        "loop-create-submit",
      ]) {
        expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      }
      const lowerText = (container.textContent ?? "").toLowerCase();
      expect(lowerText).not.toContain("readiness");
      expect(lowerText).not.toContain("custom pattern");
      expect(lowerText).not.toContain("auto approve");
      expect(lowerText).not.toContain("auto-approval");
      expect(lowerText).not.toContain("projectconfig");
      expect(lowerText).not.toContain("runkind");
      expect(lowerText).not.toContain("toolprofileid");
      expect(lowerText).not.toContain("mode");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("goal loop inline template", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let postedBody: Record<string, unknown> | undefined;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        postedBody = init.body ? JSON.parse(init.body as string) : undefined;
        return Response.json({ loop: makeLoop() });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "goal_runner",
        title: "Goal Loop",
        scheduleKind: "manual",
        approvalPolicy: "explicit_per_run",
        maxIterationsPerRun: 4,
        maxTokensPerRun: 160000,
        maxWallClockMinutesPerRun: 20,
        maxRunsPerDay: 3,
        goalTitle: "Inline Goal Title",
        goalObjective: "Investigate failing tests and propose fixes.",
        goalAcceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);

      await act(async () => {
        submitCreateLoopForm(container);
      });

      await waitFor(() => {
        expect(postedBody).toBeDefined();
      });

      expect(postedBody!.templateId).toBe("goal_runner");
      expect(postedBody!.config).toBeUndefined();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("template quick starts can be selected and submit with templateId only", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let postedBody: Record<string, unknown> | undefined;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        postedBody = init.body ? JSON.parse(init.body as string) : undefined;
        const loop = makeLoop({ loopId: "loop-preset" });
        return Response.json({ loop });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Quick Starts");
      });

      const quickStartButtons = Array.from(container.querySelectorAll('button[aria-label^="Template "]'));
      expect(quickStartButtons.length).toBe(4);

      const prBabysitterButton = quickStartButtons.find((b) =>
        b.getAttribute("aria-label")?.includes("PR Babysitter"),
      ) as HTMLButtonElement | undefined;
      expect(prBabysitterButton).toBeDefined();
      expect(prBabysitterButton!.disabled).toBe(false);

      await act(async () => {
        prBabysitterButton!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(container.textContent).toContain("GitHub.com integration with an env token");
        expect(container.textContent).toContain("does not merge, rebase, approve, or force-push");
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);

      await act(async () => {
        submitCreateLoopForm(container);
      });

      await waitFor(() => {
        expect(postedBody).toBeDefined();
      });

      expect(postedBody!.presetId).toBeUndefined();
      expect(postedBody!.templateId).toBe("pr_babysitter");
      expect(postedBody!.config).toBeUndefined();
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
      if (url.includes("/api/projects/demo/loops") && !url.includes("/loops/")) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return Response.json({ loops: [] });
      }
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopsRoute(reactRoot, queryClient);

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
