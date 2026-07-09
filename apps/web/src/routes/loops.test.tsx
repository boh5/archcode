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

function expectRatioInputsNativelyValid(container: Element, soft: string, hard: string): void {
  const softInput = container.querySelector("#new-loop-soft-ratio") as HTMLInputElement | null;
  const hardInput = container.querySelector("#new-loop-hard-ratio") as HTMLInputElement | null;
  if (!softInput || !hardInput) throw new Error("Missing ratio inputs");

  expect(softInput.step).toBe("0.01");
  expect(hardInput.step).toBe("0.01");
  expect(softInput.value).toBe(soft);
  expect(hardInput.value).toBe(hard);
  expect(softInput.checkValidity()).toBe(true);
  expect(hardInput.checkValidity()).toBe(true);
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

  test("renders loop list with title, status, schedule, runKind, mode, last run, and next run", async () => {
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

      expect(container.textContent).toContain("active");
      expect(container.textContent).toContain("paused");
      expect(container.textContent).toContain("cron UTC */15 * * * *");
      expect(container.textContent).toContain("manual");
      expect(container.textContent).toContain("template: watch_report");
      expect(container.textContent).toContain("template: goal_runner");
      expect(container.textContent).toContain("succeeded");
      expect(container.textContent).toContain("next:");
      expect(container.querySelector('[data-testid="loop-trigger-health"]')?.textContent).toContain("on_pr healthy 60000ms");
      expect(container.textContent).toContain("job-1 blocked on_pr blocked needs-review");
      expect(container.textContent).toContain("queued: 1");
      expect(container.textContent).toContain("cleanup: auto_paused");
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
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_local_report",
        taskPrompt: "Summarize local project health.",
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);
      expectRatioInputsNativelyValid(container, "0.8", "1");

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
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_local_report",
        taskPrompt: "Draft the interval report.",
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);
      expectRatioInputsNativelyValid(container, "0.8", "1");

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
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_local_report",
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
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_local_report",
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

  test("creates manual schedule with separate on_pr trigger payload", async () => {
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
        title: "Manual PR Watch",
        scheduleKind: "manual",
        triggerOnPr: true,
        triggerCadenceMs: 60000,
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_github_pr_watch",
        taskPrompt: "Watch pull requests.",
      });

      expect((container.querySelector('[data-testid="loop-trigger-on-pr"]') as HTMLInputElement | null)?.checked).toBe(true);
      expect((container.querySelector('[data-testid="loop-trigger-cadence-ms"]') as HTMLInputElement | null)?.value).toBe("60000");
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

  test("invalid on_pr cadence shows exact validation text and disables submit", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    Object.defineProperty(globalThis, "fetch", { value: mock(async () => new Response("Unexpected", { status: 500 })), configurable: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const reactRoot = createRoot(container);

    try {
      await renderCreateLoopForm(reactRoot, queryClient, "demo", () => {}, {
        templateId: "pr_babysitter",
        title: "Bad Cadence",
        scheduleKind: "manual",
        triggerOnPr: true,
        triggerCadenceMs: 29000,
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_github_pr_watch",
        taskPrompt: "Watch pull requests.",
      });

      expect(container.textContent).toContain("Cadence must be at least 30000 ms");
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
        triggerOnPr: true,
        triggerCadenceMs: 60000,
        runKind: "session",
        mode: "report",
        approvalPolicy: "interactive",
        maxIterationsPerRun: 8,
        maxTokensPerRun: 120000,
        maxWallClockMinutesPerRun: 15,
        maxRunsPerDay: 2,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
        toolProfileId: "loop_local_report",
        taskPrompt: "Summarize local project health.",
      });

      for (const testId of [
        "loop-schedule-kind",
        "loop-cron-expression",
        "loop-trigger-on-pr",
        "loop-trigger-cadence-ms",
        "loop-max-concurrent",
        "loop-create-submit",
      ]) {
        expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
      }
      const maxConcurrent = container.querySelector('[data-testid="loop-max-concurrent"]') as HTMLInputElement;
      expect(maxConcurrent.disabled).toBe(true);
      const lowerText = (container.textContent ?? "").toLowerCase();
      expect(lowerText).not.toContain("readiness");
      expect(lowerText).not.toContain("custom pattern");
      expect(lowerText).not.toContain("auto approve");
      expect(lowerText).not.toContain("auto-approval");
      expect(lowerText).not.toContain("projectconfig");
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
        runKind: "goal",
        mode: "act",
        approvalPolicy: "explicit_per_run",
        maxIterationsPerRun: 4,
        maxTokensPerRun: 160000,
        maxWallClockMinutesPerRun: 20,
        maxRunsPerDay: 3,
        softThresholdRatio: 0.75,
        hardThresholdRatio: 1,
        toolProfileId: "loop_goal_action",
        goalTitle: "Inline Goal Title",
        goalObjective: "Investigate failing tests and propose fixes.",
        goalAcceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);
      expectRatioInputsNativelyValid(container, "0.75", "1");

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

  test("preset quick starts can be selected and submit editable config with budget and tool profile", async () => {
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

      const dailyTriageButton = container.querySelector('button[aria-label="Preset Daily Triage"]') as HTMLButtonElement;
      expect(dailyTriageButton).not.toBeNull();
      expect(dailyTriageButton.disabled).toBe(false);

      const changelogButton = container.querySelector('button[aria-label="Preset Changelog Drafter"]') as HTMLButtonElement;
      expect(changelogButton).not.toBeNull();
      expect(changelogButton.disabled).toBe(false);

      const prBabysitterButton = container.querySelector('button[aria-label="Preset PR Babysitter"]') as HTMLButtonElement;
      expect(prBabysitterButton).not.toBeNull();
      expect(prBabysitterButton.disabled).toBe(false);

      const ciSweeperButton = container.querySelector('button[aria-label="Preset CI Sweeper"]') as HTMLButtonElement;
      expect(ciSweeperButton).not.toBeNull();
      expect(ciSweeperButton.disabled).toBe(false);

      const dependencySweeperButton = container.querySelector('button[aria-label="Preset Dependency Sweeper"]') as HTMLButtonElement;
      expect(dependencySweeperButton).not.toBeNull();
      expect(dependencySweeperButton.disabled).toBe(false);

      const postMergeButton = container.querySelector('button[aria-label="Preset Post-Land Cleanup"]') as HTMLButtonElement;
      expect(postMergeButton).not.toBeNull();
      expect(postMergeButton.disabled).toBe(false);

      const issueTriageButton = container.querySelector('button[aria-label="Preset Issue Triage"]') as HTMLButtonElement;
      expect(issueTriageButton).not.toBeNull();
      expect(issueTriageButton.disabled).toBe(false);

      await act(async () => {
        prBabysitterButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(container.textContent).toContain("GitHub.com integration with an env token");
        expect(container.textContent).toContain("PR Babysitter does not merge, rebase, approve, or force-push");
      });

      const submitButton = container.querySelector('button[type="submit"]') as HTMLButtonElement;
      expect(submitButton).not.toBeNull();
      expect(submitButton.disabled).toBe(false);
      expectRatioInputsNativelyValid(container, "0.8", "1");

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
