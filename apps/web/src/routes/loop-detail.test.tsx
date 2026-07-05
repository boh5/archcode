import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { LoopKillState, LoopRunReport, LoopState } from "../api/types";
import { LoopDetailRoute } from "./loop-detail";
import { EditLoopForm } from "../components/features/CreateLoopDialog";

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

  // React 19 input polyfill calls attachEvent/detachEvent which JSDOM lacks.
  const htmlProto = dom.window.HTMLElement.prototype as unknown as {
    attachEvent?: unknown;
    detachEvent?: unknown;
  };
  htmlProto.attachEvent = htmlProto.attachEvent ?? (() => {});
  htmlProto.detachEvent = htmlProto.detachEvent ?? (() => {});

  return dom;
}

function submitForm(container: Element): void {
  const form = container.querySelector("form");
  if (!form) throw new Error("Missing form");
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
      limits: {
        maxIterationsPerRun: 6,
        maxTokensPerRun: 1000,
        maxWallClockMsPerRun: 600000,
        maxRunsPerDay: 4,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      budget: {
        maxIterationsPerRun: 6,
        maxTokensPerRun: 1000,
        maxWallClockMsPerRun: 600000,
        maxRunsPerDay: 4,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      toolProfileId: "loop_github_pr_watch",
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
    latestBudget: {
      budget: {
        maxIterationsPerRun: 6,
        maxTokensPerRun: 1000,
        maxWallClockMsPerRun: 600000,
        maxRunsPerDay: 4,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      usage: {
        iterations: 2,
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
        wallClockMs: 120000,
        runsToday: 1,
        resetDateUtc: "2026-07-05",
        pricingUnavailable: true,
      },
      updatedAt: 1700000120000,
    },
    latestCollisions: {
      targets: [{ type: "pr", owner: "archcode", repo: "workbench", number: 42 }],
      activeLeases: [],
      conflicts: [],
      updatedAt: 1700000120000,
    },
    latestIntegrations: {
      errors: [
        {
          integrationId: "github",
          reason: "integration_auth_missing",
          message: "GitHub token not configured",
          occurredAt: 1700000120000,
        },
      ],
      updatedAt: 1700000120000,
    },
    lastRun: makeRun({
      runId: "run-last",
      status: "succeeded",
      trigger: "interval",
      endedAt: 1700000060000,
      sessionId: "session-last",
      goalId: "goal-last",
      summary: "Previous run completed with a local health summary.",
      reason: "completed",
      budgetUsage: {
        iterations: 2,
        inputTokens: 100,
        outputTokens: 90,
        totalTokens: 190,
        wallClockMs: 90000,
        runsToday: 1,
        resetDateUtc: "2026-07-05",
        pricingUnavailable: true,
      },
      collisionTargets: [{ type: "pr", owner: "archcode", repo: "workbench", number: 42 }],
      integrationErrors: [],
      toolProfileId: "loop_github_pr_watch",
    }),
    currentRun: makeRun({
      runId: "run-current",
      status: "running",
      trigger: "manual",
      sessionId: "session-current",
      goalId: "goal-current",
      reason: "completed",
      toolProfileId: "loop_github_pr_watch",
    }),
    ...overrides,
  };
}

function setupLoopDetailFetch(input: {
  loop?: LoopState;
  runs?: LoopRunReport[];
  stateMarkdown?: string;
  triggerConflict?: boolean;
  killState?: LoopKillState;
} = {}): { paths: string[]; fetchMock: ReturnType<typeof mock>; setLoop: (loop: LoopState) => void; getPatchBody: () => Record<string, unknown> | undefined } {
  let currentLoop = input.loop ?? makeLoop();
  let killState: LoopKillState = input.killState ?? { globalKillActive: true, activatedAt: 1700000110000, activatedBy: "web", reason: "maintenance stop" };
  let patchBody: Record<string, unknown> | undefined;
  let runs = input.runs ?? [
    makeRun({
      runId: "run-history-1",
      status: "failed",
      trigger: "manual",
      sessionId: "session-history",
      goalId: "goal-history",
      summary: "Investigated the failure.",
      error: "Typecheck failed",
      reason: "execution_failed",
      budgetUsage: {
        iterations: 3,
        inputTokens: 400,
        outputTokens: 250,
        totalTokens: 650,
        wallClockMs: 180000,
        runsToday: 2,
        resetDateUtc: "2026-07-05",
        estimatedUsd: 0.0123,
      },
      collisionTargets: [{ type: "pr", owner: "archcode", repo: "workbench", number: 42 }],
      collisionConflicts: [
        {
          targetKey: "github:archcode/workbench:pr:42",
          target: { type: "pr", owner: "archcode", repo: "workbench", number: 42 },
          conflictingLease: {
            targetKey: "github:archcode/workbench:pr:42",
            target: { type: "pr", owner: "archcode", repo: "workbench", number: 42 },
            loopId: "other-loop",
            runId: "other-run",
            priority: 1,
            createdAt: 1700000000000,
            expiresAt: 1700003600000,
          },
          detectedAt: 1700000010000,
        },
      ],
      integrationErrors: [
        {
          integrationId: "github",
          reason: "integration_auth_missing",
          message: "GitHub token not configured",
          occurredAt: 1700000010000,
        },
      ],
      toolProfileId: "loop_github_pr_watch",
    }),
    makeRun({
      runId: "run-history-2",
      status: "skipped",
      trigger: "interval",
      skippedReason: "Loop is already running",
      reason: "scheduler_overlap",
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

    if (path === "/api/projects/demo/loops/loop-1" && init?.method === "PATCH") {
      patchBody = init.body ? JSON.parse(init.body as string) : undefined;
      const nextConfig = patchBody?.config as LoopState["config"] | undefined;
      currentLoop = {
        ...currentLoop,
        config: nextConfig ?? currentLoop.config,
        updatedAt: 1700000330000,
      };
      return Response.json({ loop: currentLoop });
    }

    if (path === "/api/projects/demo/loops/loop-1/runs/current/cancel" && init?.method === "POST") {
      const report = currentLoop.currentRun
        ? { ...currentLoop.currentRun, status: "cancelled" as const, reason: "cancelled_by_user" as const, endedAt: 1700000310000 }
        : undefined;
      currentLoop = { ...currentLoop, currentRun: undefined, lastRun: report ?? currentLoop.lastRun, updatedAt: 1700000310000 };
      return Response.json({ ok: true, loopId: "loop-1", runId: report?.runId ?? null, status: report?.status ?? "none", reason: report?.reason, report });
    }

    if (path === "/api/projects/demo/loops/kill-all" && init?.method === "POST") {
      killState = { globalKillActive: true, activatedAt: 1700000320000, activatedBy: "web", reason: "Activated from Loop detail guardrail controls" };
      return Response.json({ killState });
    }

    if (path === "/api/projects/demo/loops/kill-all" && init?.method === "DELETE") {
      killState = { globalKillActive: false };
      return Response.json({ killState });
    }

    if (path === "/api/projects/demo/loops/kill-state") {
      return Response.json({ killState });
    }

    if (path === "/api/projects/demo/loops/loop-1/budget") {
      return Response.json({ loopId: "loop-1", budget: currentLoop.latestBudget ?? null });
    }

    if (path === "/api/projects/demo/loops/loop-1/collisions") {
      return Response.json({ loopId: "loop-1", collisions: currentLoop.latestCollisions });
    }

    if (path === "/api/projects/demo/loops/loop-1/integrations") {
      return Response.json({
        loopId: "loop-1",
        integrations: {
          statuses: [
            {
              integrationId: "github",
              status: "auth_missing",
              reason: "integration_auth_missing",
              message: "GitHub token not configured",
              updatedAt: 1700000120000,
            },
            {
              integrationId: "github_actions",
              status: "rate_limited",
              reason: "integration_rate_limited",
              message: "Actions API retry later",
              retryAfterMs: 60000,
              updatedAt: 1700000120000,
            },
          ],
          snapshot: currentLoop.latestIntegrations,
          updatedAt: 1700000120000,
        },
      });
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
    getPatchBody: () => patchBody,
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
        expect(container.textContent).toContain("Guardrails");
        expect(container.textContent).toContain("Run History");
        expect(container.textContent).toContain("State");
      });

      const pageText = container.textContent ?? "";
      expect(pageText).toContain("interval 60000ms");
      expect(pageText).toContain("goal");
      expect(pageText).toContain("act");
      expect(pageText).toContain("loop_github_pr_watch");
      expect(pageText).toContain("explicit_per_run");
      expect(pageText).toContain("6");
      expect(pageText).toContain("tokens 1000");
      expect(pageText).toContain("Review failing tests and summarize concrete next steps.");
      expect(pageText).toContain("Triage Follow-up Goal by architect");
      expect(pageText).toContain("run-current running manual reason completed");
      expect(pageText).toContain("run-last succeeded interval reason completed");
      expect(pageText).toContain("run-history-1");
      expect(pageText).toContain("Typecheck failed");
      expect(pageText).toContain("Loop is already running");
      expect(pageText).toContain("Generated state summary from markdown.");
      expect(container.querySelector('[data-testid="loop-detail-page"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="loop-budget-card"]')?.textContent).toContain("80% / 100%");
      expect(container.querySelector('[data-testid="loop-budget-card"]')?.textContent).toContain("800 tokens remaining");
      expect(container.querySelector('[data-testid="loop-budget-card"]')?.textContent).toContain("USD availability");
      expect(container.querySelector('[data-testid="loop-cancel-current-run-button"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="loop-global-kill-button"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="loop-global-kill-banner"]')?.textContent).toContain("maintenance stop");
      expect(container.querySelector('[data-testid="loop-collision-log"]')?.textContent).toContain("github:archcode/workbench:pr:42");
      expect(container.querySelector('[data-testid="loop-integration-status"]')?.textContent).toContain("GitHub token configured: no");
      expect(container.querySelector('[data-testid="loop-integration-status"]')?.textContent).toContain("60000ms retry-after");
      const historyRow = container.querySelector('[data-testid="loop-run-history-row-run-history-1"]');
      expect(historyRow?.textContent).toContain("reason: execution_failed");
      expect(historyRow?.textContent).toContain("budget: 3 iterations");
      expect(historyRow?.textContent).toContain("collision conflicts: github:archcode/workbench:pr:42");
      expect(historyRow?.textContent).toContain("integration: github integration_auth_missing");

      expect(container.querySelector('a[href="/projects/demo/sessions/session-current"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/goals/goal-current"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/sessions/session-history"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/goals/goal-history"]')).not.toBeNull();

      const lowerText = pageText.toLowerCase();
      expect(lowerText).not.toContain("readiness");
      expect(lowerText).not.toContain("cron");

      const triggerButton = findElementByText(container, "Trigger manual run") as HTMLButtonElement;
      expect(triggerButton.disabled).toBe(true);

      await act(async () => {
        findElementByText(container, "Clear global kill").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("DELETE /api/projects/demo/loops/kill-all");
        const nextTrigger = findElementByText(container, "Trigger manual run") as HTMLButtonElement;
        expect(nextTrigger.disabled).toBe(false);
      });

      await act(async () => {
        findElementByText(container, "Trigger manual run").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/loop-1/trigger");
        expect(container.textContent).toContain("run-triggered running manual reason none");
      });

      await act(async () => {
        findElementByText(container, "Cancel current run").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/loop-1/runs/current/cancel");
      });

      await act(async () => {
        findElementByText(container, "Activate global kill").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/kill-all");
        expect(container.querySelector('[data-testid="loop-global-kill-banner"]')?.textContent).toContain("Activated from Loop detail guardrail controls");
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
      killState: { globalKillActive: false },
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

  test("edit loop dialog pre-fills config and patches Phase 4 config", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    const { paths, getPatchBody } = setupLoopDetailFetch({ killState: { globalKillActive: false } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.textContent).toContain("Edit Loop");
        expect(container.querySelector('[data-testid="loop-edit-button"]')).not.toBeNull();
      });

      const baseLoop = makeLoop();
      const seededBudget = {
        maxIterationsPerRun: 6,
        maxTokensPerRun: 1000,
        maxWallClockMsPerRun: 600000,
        maxRunsPerDay: 4,
        softThresholdRatio: 0.65,
        hardThresholdRatio: 0.9,
      };
      const loop = makeLoop({
        config: {
          ...baseLoop.config,
          limits: seededBudget,
          budget: seededBudget,
        },
      });
      await act(async () => {
        reactRoot.render(
          <QueryClientProvider client={queryClient}>
            <EditLoopForm slug="demo" loop={loop} />
          </QueryClientProvider>,
        );
      });

      const dialogScope = document.body;

      await waitFor(() => {
        const titleInput = dialogScope.querySelector("#new-loop-title") as HTMLInputElement | null;
        expect(titleInput?.value).toBe("Daily Triage Loop");
        expect((dialogScope.querySelector("#new-loop-every-ms") as HTMLInputElement | null)?.value).toBe("60000");
        expect((dialogScope.querySelector("#new-loop-tool-profile") as HTMLSelectElement | null)?.value).toBe("loop_github_pr_watch");
        expect((dialogScope.querySelector("#new-loop-max-tokens") as HTMLInputElement | null)?.value).toBe("1000");
        expect((dialogScope.querySelector("#new-loop-goal-title") as HTMLInputElement | null)?.value).toBe("Triage Follow-up Goal");
        expectRatioInputsNativelyValid(dialogScope, "0.65", "0.9");
      });

      await act(async () => {
        submitForm(dialogScope);
      });

      await waitFor(() => {
        expect(paths).toContain("PATCH /api/projects/demo/loops/loop-1");
        expect(getPatchBody()).toBeDefined();
      });

      const patchBody = getPatchBody()!;
      expect(patchBody.presetId).toBeUndefined();
      const config = patchBody.config as Record<string, unknown>;
      expect(config.title).toBe("Daily Triage Loop");
      expect(config.schedule).toEqual({ kind: "interval", everyMs: 60000 });
      expect(config.runKind).toBe("goal");
      expect(config.mode).toBe("act");
      expect(config.approvalPolicy).toBe("explicit_per_run");
      expect(config.toolProfileId).toBe("loop_github_pr_watch");
      expect(config.limits).toEqual({
        maxIterationsPerRun: 6,
        maxTokensPerRun: 1000,
        maxWallClockMsPerRun: 600000,
        maxRunsPerDay: 4,
        softThresholdRatio: 0.65,
        hardThresholdRatio: 0.9,
      });
      expect(config.budget).toEqual(config.limits);
      const goalTemplate = config.goalTemplate as Record<string, unknown>;
      expect(goalTemplate.title).toBe("Triage Follow-up Goal");
      expect(Array.isArray(goalTemplate.doneConditions)).toBe(true);
      expect(goalTemplate.doneConditions).toHaveLength(1);
      expect("goalTemplateId" in config).toBe(false);
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
