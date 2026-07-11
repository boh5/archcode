import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { GlobalSSEHitlRealtimeEvent } from "@archcode/protocol";
import type { HitlProjection, LoopIntegrationStatusItem, LoopKillState, LoopRunReport, LoopState } from "../api/types";
import { LoopDetailRoute } from "./loop-detail";
import { hitlStore } from "../store/hitl-store";

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
      templateId: "goal_runner",
      title: "Daily Triage Loop",
      schedule: { kind: "interval", everyMs: 60000 },
      approvalPolicy: "explicit_per_run",
      useWorktree: false,
      limits: {
        maxIterationsPerRun: 6,
        maxTokensPerRun: 1000,
        maxWallClockMsPerRun: 600000,
        maxRunsPerDay: 4,
        softThresholdRatio: 0.8,
        hardThresholdRatio: 1,
      },
      taskPrompt: "Review failing tests and summarize concrete next steps.",
      goalTemplate: {
        title: "Triage Follow-up Goal",
        objective: "Investigate failing tests and propose fixes.",
        acceptanceCriteria: "Reviewer can decide DONE from logs and diff.",
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
      targets: [{ type: "pr", owner: "test-owner", repo: "test-repo", number: 42 }],
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
      collisionTargets: [{ type: "pr", owner: "test-owner", repo: "test-repo", number: 42 }],
      integrationErrors: [],
    }),
    currentRun: makeRun({
      runId: "run-current",
      status: "running",
      trigger: "manual",
      sessionId: "session-current",
      goalId: "goal-current",
      reason: "completed",
    }),
    ...overrides,
  };
}

function seedRealtimeHitl(...projections: HitlProjection[]): void {
  for (const projection of projections) {
    const event: GlobalSSEHitlRealtimeEvent = {
      type: "hitl.event",
      projectSlug: projection.project.slug,
      owner: projection.owner,
      hitlId: projection.hitlId,
      createdAt: Date.now(),
      payload: { type: "hitl.request", status: "pending" },
      projection,
    };
    hitlStore.getState().applyRealtimeEvent(event);
  }
}

function setupLoopDetailFetch(input: {
  loop?: LoopState;
  runs?: LoopRunReport[];
  stateMarkdown?: string;
  triggerConflict?: boolean;
  killState?: LoopKillState;
  integrationStatuses?: LoopIntegrationStatusItem[];
} = {}): { paths: string[]; fetchMock: ReturnType<typeof mock> } {
  let currentLoop = input.loop ?? makeLoop();
  let killState: LoopKillState = input.killState ?? { globalKillActive: true, activatedAt: 1700000110000, activatedBy: "web", reason: "maintenance stop" };
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
      collisionTargets: [{ type: "pr", owner: "test-owner", repo: "test-repo", number: 42 }],
      collisionConflicts: [
        {
          targetKey: "github:test-owner/test-repo:pr:42",
          target: { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 },
          conflictingLease: {
            targetKey: "github:test-owner/test-repo:pr:42",
            target: { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 },
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
          statuses: input.integrationStatuses ?? [
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

  return { paths, fetchMock };
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
    hitlStore.getState().removeProject("demo");
  });

  afterEach(() => {
    hitlStore.getState().removeProject("demo");
    restoreGlobals();
    mock.restore();
  });

  test("primary view shows canonical status (badge + activity), next run, last result, attention, recent results, settings; hides diagnostics", async () => {
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
        expect(container.querySelector('[data-testid="loop-status-section"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="loop-attention-section"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="loop-recent-results-section"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="loop-settings-section"]')).not.toBeNull();
      });

      const statusSection = container.querySelector('[data-testid="loop-status-section"]')!;
      expect(statusSection.textContent).toContain("Running");
      expect(statusSection.textContent).toContain("Running manual run (session session-current)");
      expect(statusSection.textContent).toContain("run count");
      expect(statusSection.textContent).toContain("next run");
      expect(statusSection.textContent).toContain("last result");

      const settingsSection = container.querySelector('[data-testid="loop-settings-section"]')!;
      expect(settingsSection.textContent).toContain("template");
      expect(settingsSection.textContent).toContain("goal_runner");
      expect(settingsSection.textContent).toContain("schedule");
      expect(settingsSection.textContent).toContain("interval 60000ms");
      expect(settingsSection.textContent).toContain("worktree");
      expect(settingsSection.textContent).toContain("disabled");
      expect(settingsSection.textContent).toContain("budget defaults");
      expect(settingsSection.textContent).toContain("iterations 6");
      expect(settingsSection.textContent).toContain("task prompt");
      expect(settingsSection.textContent).toContain("Review failing tests and summarize concrete next steps.");
      expect(settingsSection.textContent).toContain("goal template");
      expect(settingsSection.textContent).toContain("objective: Investigate failing tests and propose fixes.");
      expect(settingsSection.textContent).toContain("acceptance: Reviewer can decide DONE from logs and diff.");
      expect(settingsSection.textContent).not.toContain("Triage Follow-up Goal");

      const recentSection = container.querySelector('[data-testid="loop-recent-results-section"]')!;
      expect(recentSection.textContent).toContain("Failed");
      expect(recentSection.textContent).toContain("Typecheck failed");
      expect(recentSection.textContent).toContain("Loop is already running");
      expect(recentSection.querySelector('[data-testid="loop-recent-result-run-history-1"]')).not.toBeNull();

      expect(container.querySelector('a[href="/projects/demo/sessions/session-current"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/goals/goal-current"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/sessions/session-history"]')).not.toBeNull();
      expect(container.querySelector('a[href="/projects/demo/goals/goal-history"]')).not.toBeNull();

      expect(container.querySelector('[data-testid="loop-detail-page"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="loop-cancel-current-run-button"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="loop-global-kill-button"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="loop-global-kill-banner"]')?.textContent).toContain("maintenance stop");

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
      });

      await act(async () => {
        findElementByText(container, "Resume").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(paths).toContain("POST /api/projects/demo/loops/loop-1/resume");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("Advanced Debug is collapsed by default and diagnostics are hidden until expanded", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    setupLoopDetailFetch();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="loop-advanced-debug-section"]')).not.toBeNull();
      });

      const toggle = container.querySelector('[data-testid="loop-advanced-debug-toggle"]') as HTMLButtonElement | null;
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(container.querySelector('[data-testid="loop-advanced-debug-content"]')).toBeNull();

      expect(container.querySelector('[data-testid="loop-budget-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-collision-log"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-integration-status"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-queue-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-trigger-health"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-run-history-section"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-state-section"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-raw-config-card"]')).toBeNull();

      await act(async () => {
        toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="loop-advanced-debug-content"]')).not.toBeNull();
        expect(toggle?.getAttribute("aria-expanded")).toBe("true");
      });

      expect(container.querySelector('[data-testid="loop-budget-card"]')?.textContent).toContain("80% / 100%");
      expect(container.querySelector('[data-testid="loop-budget-card"]')?.textContent).toContain("800 tokens remaining");
      expect(container.querySelector('[data-testid="loop-budget-card"]')?.textContent).toContain("USD availability");
      expect(container.querySelector('[data-testid="loop-collision-log"]')?.textContent).toContain("github:test-owner/test-repo:pr:42");
      const integrationStatus = container.querySelector('[data-testid="loop-integration-status"]')?.textContent ?? "";
      expect(integrationStatus).toContain("github");
      expect(integrationStatus).toContain("auth_missing");
      expect(integrationStatus).toContain("GitHub token configured: no");
      expect(integrationStatus).toContain("github_actions");
      expect(integrationStatus).toContain("rate_limited");
      expect(integrationStatus).toContain("60000ms retry-after");

      const historyRow = container.querySelector('[data-testid="loop-run-history-row-run-history-1"]');
      expect(historyRow?.textContent).toContain("reason: execution_failed");
      expect(historyRow?.textContent).toContain("budget: 3 iterations");
      expect(historyRow?.textContent).toContain("collision conflicts: github:test-owner/test-repo:pr:42");
      expect(historyRow?.textContent).toContain("integration: github integration_auth_missing");

      expect(container.querySelector('[data-testid="loop-state-section"]')?.textContent).toContain("Generated state summary from markdown.");
      const rawConfig = container.querySelector('[data-testid="loop-raw-config-card"]')?.textContent ?? "";
      expect(rawConfig).toContain("approval policy");
      expect(rawConfig).toContain("explicit_per_run");
      expect(rawConfig).toContain("cleanup policy");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("Advanced Debug reveals seeded collision and integration diagnostics after expansion", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    setupLoopDetailFetch({
      killState: { globalKillActive: true, activatedAt: 1700000110000, activatedBy: "seeded-kill-switch", reason: "Seeded kill switch" },
      runs: [
        makeRun({
          runId: "run-1",
          status: "skipped",
          trigger: "manual",
          reason: "collision_conflict",
          skippedReason: "PR target is already leased by another Loop run.",
          collisionTargets: [{ type: "pr", owner: "test-owner", repo: "test-repo", number: 42 }],
          collisionConflicts: [
            {
              targetKey: "github:test-owner/test-repo:pr:42",
              target: { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 },
              conflictingLease: {
                targetKey: "github:test-owner/test-repo:pr:42",
                target: { type: "pr", owner: "test-owner", repo: "test-repo", number: 42 },
                loopId: "other-loop",
                runId: "other-run",
                priority: 10,
                createdAt: 1700000000000,
                expiresAt: 1700003600000,
              },
              detectedAt: 1700000010000,
            },
          ],
        }),
      ],
      integrationStatuses: [
        {
          integrationId: "github",
          status: "auth_missing",
          reason: "integration_auth_missing",
          message: "GitHub token not configured",
          updatedAt: 1700000120000,
        },
        {
          integrationId: "github_actions",
          status: "ready",
          message: "GitHub Actions configured",
          updatedAt: 1700000120000,
        },
      ],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="loop-advanced-debug-section"]')).not.toBeNull();
      });

      expect(container.querySelector('[data-testid="loop-global-kill-banner"]')?.textContent).toContain("Seeded kill switch");

      const toggle = container.querySelector('[data-testid="loop-advanced-debug-toggle"]') as HTMLButtonElement | null;
      await act(async () => {
        toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="loop-advanced-debug-content"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="loop-budget-card"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="loop-collision-log"]')?.textContent).toContain("github:test-owner/test-repo:pr:42");
        const integrationStatus = container.querySelector('[data-testid="loop-integration-status"]')?.textContent ?? "";
        expect(integrationStatus).toContain("github");
        expect(integrationStatus).toContain("auth_missing");
        expect(integrationStatus).toContain("GitHub token configured: no");
        expect(integrationStatus).toContain("github_actions");
        expect(integrationStatus).toContain("ready");
        expect(integrationStatus).toContain("GitHub token configured: yes");
        const runRow = container.querySelector('[data-testid="loop-run-history-row-run-1"]');
        expect(runRow?.textContent).toContain("reason: collision_conflict");
        expect(runRow?.textContent).toContain("collision conflicts: github:test-owner/test-repo:pr:42");
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("Advanced Debug exposes trigger health, worktree, and cleanup diagnostics after expansion", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    const triggerCleanupLoop = makeLoop({
      config: {
        ...makeLoop().config,
        schedule: { kind: "cron", expression: "*/15 * * * *" },
        triggers: [{ kind: "on_pr", cadenceMs: 60000, baseBranch: "main", prScope: "review_requested" }],
        cleanupPolicy: { enabled: true, action: "pause", deleteUnchangedWorktrees: true, preserveChangedArtifacts: true, requiresNoPendingQueue: true },
      },
      lastScheduledAt: 1700000010000,
      nextScheduledAt: 1700000910000,
      lastEnqueuedAt: 1700000020000,
      missedCount: 2,
      cleanupState: "auto_paused",
      triggerHealth: [
        { triggerKind: "on_pr", status: "degraded", cadenceMs: 60000, lastCheckedAt: 1700000040000, lastError: "rate limited", missedCount: 2 },
      ],
    });
    setupLoopDetailFetch({
      loop: triggerCleanupLoop,
      killState: { globalKillActive: false },
      runs: [
        makeRun({
          runId: "run-trigger-cleanup",
          status: "skipped",
          trigger: "on_pr",
          jobId: "job-current",
          subjectKey: "github:test-owner/test-repo:pr:42",
          dedupeKey: "loop-1:on_pr:42",
          branchKey: "test-owner/test-repo:feature-loop",
          worktreePath: "/safe/worktrees/loop-1",
          baseSha: "base123",
          resolvedHeadSha: "head456",
          missedCount: 2,
          blockedReason: "needs-review",
          cleanupState: "cleanup_candidate",
          observedArtifacts: [
            { path: "src/file.ts", status: "modified", sizeBytes: 42 },
            { path: "src/new.ts", status: "created", sizeBytes: 13 },
          ],
          summary: "Evidence: session and goal links remain the only navigation affordances.",
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
        expect(container.querySelector('[data-testid="loop-advanced-debug-section"]')).not.toBeNull();
      });

      const toggle = container.querySelector('[data-testid="loop-advanced-debug-toggle"]') as HTMLButtonElement | null;
      await act(async () => {
        toggle!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="loop-advanced-debug-content"]')).not.toBeNull();
      });

      expect(container.querySelector('[data-testid="loop-queue-card"]')).toBeNull();
      expect(container.querySelector('[data-testid="loop-trigger-health"]')?.textContent).toContain("degraded");
      expect(container.querySelector('[data-testid="loop-trigger-health"]')?.textContent).toContain("rate limited");
      expect(container.querySelector('[data-testid="loop-run-worktree-status"]')?.textContent).toContain("path /safe/worktrees/loop-1");
      expect(container.querySelector('[data-testid="loop-run-worktree-status"]')?.textContent).toContain("branch test-owner/test-repo:feature-loop");
      expect(container.querySelector('[data-testid="loop-run-blocked-reason"]')?.textContent).toContain("needs-review");
      expect(container.querySelector('[data-testid="loop-run-history-section"]')?.textContent).toContain("diff stats: modified 1, created 1");
      expect(container.querySelector('[data-testid="loop-run-history-section"]')?.textContent).toContain("cleanup: cleanup_candidate");
      const rawConfig = container.querySelector('[data-testid="loop-raw-config-card"]')?.textContent ?? "";
      expect(rawConfig).toContain("cleanup policy");
      expect(rawConfig).toContain("delete unchanged worktrees");
      expect(rawConfig).toContain("auto_paused");
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

  test("renders simple error when route params are missing", async () => {
    installDom("/loops/missing");
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
    }
  });

  test("renders visible HITL section with loop-scoped projections", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const loopHitl: HitlProjection[] = [
      {
        hitlId: "loop-hitl-1",
        project: { slug: "demo", name: "Demo" },
        owner: { projectSlug: "demo", ownerType: "loop", ownerId: "loop-1" },
        source: { type: "loop_approval", loopId: "loop-1", approvalPoint: "explicit_per_run" },
        status: "pending",
        displayPayload: { title: "Approve loop run?", redacted: true },
        allowedActions: ["approve", "deny", "cancel"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        hitlId: "child-session-hitl",
        project: { slug: "demo", name: "Demo" },
        owner: { projectSlug: "demo", ownerType: "session", ownerId: "child-session" },
        ancestry: { loopId: "loop-1" },
        source: { type: "ask_user", sessionId: "child-session" },
        status: "pending",
        displayPayload: { title: "Which option?", redacted: true },
        allowedActions: ["answer", "cancel"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    setupLoopDetailFetch({ killState: { globalKillActive: false } });
    seedRealtimeHitl(...loopHitl);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        const hitlSection = container.querySelector('[data-testid="loop-hitl-section"]');
        expect(hitlSection).not.toBeNull();
      });

      const hitlSection = container.querySelector('[data-testid="loop-hitl-section"]')!;
      expect(hitlSection.textContent).toContain("HITL");
      expect(hitlSection.querySelectorAll('[data-testid="hitl-card"]')).toHaveLength(2);
      expect(hitlSection.textContent).toContain("Approve loop run?");
      expect(hitlSection.textContent).toContain("Which option?");
      expect(hitlSection.textContent).toContain("child-session");
      expect(hitlSection.textContent).toContain("loop-1");
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("primary view does not expose forbidden diagnostic labels before Advanced Debug", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    setupLoopDetailFetch({ killState: { globalKillActive: false } });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderLoopDetailRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(container.querySelector('[data-testid="loop-advanced-debug-section"]')).not.toBeNull();
      });

      const primarySections = [
        container.querySelector('[data-testid="loop-status-section"]'),
        container.querySelector('[data-testid="loop-attention-section"]'),
        container.querySelector('[data-testid="loop-recent-results-section"]'),
        container.querySelector('[data-testid="loop-settings-section"]'),
        container.querySelector('[data-testid="loop-hitl-section"]'),
      ].filter((node): node is Element => node !== null);

      for (const section of primarySections) {
        const text = (section.textContent ?? "").toLowerCase();
        expect(text).not.toContain("approval policy");
        expect(text).not.toContain("collision targets");
        expect(text).not.toContain("cleanup policy");
        expect(text).not.toContain("dedupe");
        expect(text).not.toContain("queue subject");
        expect(text).not.toContain("branch key");
        expect(text).not.toContain("trigger health");
        expect(text).not.toContain("queue / worktree");
        expect(text).not.toContain("tool profile");
        expect(text).not.toContain("extra tools");
      }

      expect(container.querySelector('[data-testid="loop-advanced-debug-content"]')).toBeNull();
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });
});
