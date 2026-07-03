import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import type { LoopState } from "../api/types";
import { LoopsRoute } from "./loops";
import { CreateLoopForm, buildLoopConfig } from "../components/features/CreateLoopDialog";
import type { DoneCondition } from "../api/types";

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

function findElementByText(container: Element, text: string): Element {
  const elements = Array.from(container.querySelectorAll("*")).reverse();
  const match = elements.find((element) => element.textContent?.includes(text));
  if (!match) throw new Error(`Unable to find element containing "${text}"`);
  return match;
}

function makeLoop(overrides: Partial<LoopState> = {}): LoopState {
  return {
    loopId: "loop-1",
    projectId: "demo",
    config: {
      title: "Test Loop",
      schedule: { kind: "manual" },
      runKind: "session",
      mode: "report",
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 8 },
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
): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <CreateLoopForm slug={slug} onCreated={onCreated} />
      </QueryClientProvider>,
    );
  });
}

function makeTestsPassCondition(): DoneCondition {
  return { id: crypto.randomUUID(), kind: "tests_pass", params: { command: "bun test" }, required: true };
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
          title: "Daily Triage Loop",
          schedule: { kind: "interval", everyMs: 60000 },
          runKind: "session",
          mode: "report",
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
      }),
      makeLoop({
        loopId: "loop-2",
        config: {
          title: "Manual Goal Loop",
          schedule: { kind: "manual" },
          runKind: "goal",
          mode: "act",
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
      expect(container.textContent).toContain("interval 60000ms");
      expect(container.textContent).toContain("manual");
      expect(container.textContent).toContain("runKind: session");
      expect(container.textContent).toContain("runKind: goal");
      expect(container.textContent).toContain("mode: report");
      expect(container.textContent).toContain("mode: act");
      expect(container.textContent).toContain("succeeded");
      expect(container.textContent).toContain("next:");
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

  test("creates manual session loop with manual schedule", async () => {
    const config = buildLoopConfig({
      title: "Manual Session",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      runKind: "session",
      mode: "report",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 8,
      taskPrompt: "",
      instructions: "",
      goalTitle: "",
      goalAuthor: "architect",
      goalPrompt: "",
      goalInstructions: "",
      goalConditions: [],
      goalMaxRetries: 2,
      goalEscalateOnFailure: true,
      goalApprovalPoints: ["after_plan", "before_complete"],
      goalReviewerAgent: "reviewer",
    });

    expect(config.title).toBe("Manual Session");
    expect(config.schedule).toEqual({ kind: "manual" });
    expect(config.runKind).toBe("session");
    expect(config.mode).toBe("report");
    expect(config.approvalPolicy).toBe("interactive");
    expect(config.limits).toEqual({ maxIterationsPerRun: 8 });
    expect(config.goalTemplate).toBeUndefined();
    expect("goalTemplateId" in config).toBe(false);
  });

  test("creates interval session loop with everyMs and interval schedule", async () => {
    const config = buildLoopConfig({
      title: "Interval Session",
      description: "",
      scheduleKind: "interval",
      everyMs: 60000,
      runKind: "session",
      mode: "report",
      approvalPolicy: "interactive",
      maxIterationsPerRun: 8,
      taskPrompt: "",
      instructions: "",
      goalTitle: "",
      goalAuthor: "architect",
      goalPrompt: "",
      goalInstructions: "",
      goalConditions: [],
      goalMaxRetries: 2,
      goalEscalateOnFailure: true,
      goalApprovalPoints: ["after_plan", "before_complete"],
      goalReviewerAgent: "reviewer",
    });

    expect(config.title).toBe("Interval Session");
    expect(config.schedule).toEqual({ kind: "interval", everyMs: 60000 });
    expect(config.runKind).toBe("session");
    expect(config.mode).toBe("report");
    expect(config.approvalPolicy).toBe("interactive");
    expect(config.limits).toEqual({ maxIterationsPerRun: 8 });
    expect(config.goalTemplate).toBeUndefined();
    expect("goalTemplateId" in config).toBe(false);
  });

  test("goal loop inline template create submits goalTemplate fields and no goalTemplateId", async () => {
    const condition = makeTestsPassCondition();
    const config = buildLoopConfig({
      title: "Goal Loop",
      description: "",
      scheduleKind: "manual",
      everyMs: 60000,
      runKind: "goal",
      mode: "act",
      approvalPolicy: "explicit_per_run",
      maxIterationsPerRun: 4,
      taskPrompt: "",
      instructions: "",
      goalTitle: "Inline Goal Title",
      goalAuthor: "architect",
      goalPrompt: "",
      goalInstructions: "",
      goalConditions: [condition],
      goalMaxRetries: 2,
      goalEscalateOnFailure: true,
      goalApprovalPoints: ["after_plan", "before_complete"],
      goalReviewerAgent: "reviewer",
    });

    expect(config.title).toBe("Goal Loop");
    expect(config.runKind).toBe("goal");
    expect(config.mode).toBe("act");
    expect(config.approvalPolicy).toBe("explicit_per_run");
    expect(config.limits).toEqual({ maxIterationsPerRun: 4 });
    expect(config.goalTemplate).toBeDefined();
    expect(config.goalTemplate!.title).toBe("Inline Goal Title");
    expect(config.goalTemplate!.doneConditions).toBeDefined();
    expect(config.goalTemplate!.doneConditions.length).toBe(1);
    expect(config.goalTemplate!.doneConditions[0].kind).toBe("tests_pass");
    expect(config.goalTemplate!.retryPolicy).toBeDefined();
    expect(config.goalTemplate!.retryPolicy.maxRetries).toBe(2);
    expect(config.goalTemplate!.approvalPoints).toEqual(["after_plan", "before_complete"]);
    expect(config.goalTemplate!.reviewerAgent).toBe("reviewer");
    expect(config.goalTemplate!.author).toBe("architect");
    expect("goalTemplateId" in config).toBe(false);
  });

  test("preset quick starts show only daily_triage and changelog_drafter as enabled", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    let presetBody: Record<string, unknown> | undefined;

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : new URL(input instanceof URL ? input.href : input.url).href;
      if (url.endsWith("/api/projects/demo/loops") && init?.method === "POST") {
        presetBody = init.body ? JSON.parse(init.body as string) : undefined;
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
      expect(prBabysitterButton.disabled).toBe(true);

      const ciSweeperButton = container.querySelector('button[aria-label="Preset CI Sweeper"]') as HTMLButtonElement;
      expect(ciSweeperButton).not.toBeNull();
      expect(ciSweeperButton.disabled).toBe(true);

      const dependencySweeperButton = container.querySelector('button[aria-label="Preset Dependency Sweeper"]') as HTMLButtonElement;
      expect(dependencySweeperButton).not.toBeNull();
      expect(dependencySweeperButton.disabled).toBe(true);

      const postMergeButton = container.querySelector('button[aria-label="Preset Post-Merge Cleanup"]') as HTMLButtonElement;
      expect(postMergeButton).not.toBeNull();
      expect(postMergeButton.disabled).toBe(true);

      const issueTriageButton = container.querySelector('button[aria-label="Preset Issue Triage"]') as HTMLButtonElement;
      expect(issueTriageButton).not.toBeNull();
      expect(issueTriageButton.disabled).toBe(true);

      await act(async () => {
        dailyTriageButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      });

      await waitFor(() => {
        expect(presetBody).toBeDefined();
      });

      expect(presetBody!.presetId).toBe("daily_triage");
      expect(presetBody!.config).toBeUndefined();
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