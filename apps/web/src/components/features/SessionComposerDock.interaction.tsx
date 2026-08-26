import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  notifyManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import type { HitlView, LoadedToolRef, ToolAuthorizationSnapshot } from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { hitlStore } from "../../store/hitl-store";
import { sessionRuntimeStore } from "../../store/session-runtime-store";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
  currentSessionSnapshotGeneration,
} from "../../store/session-store";
import {
  sessionAuthoritativeSnapshot,
  type SessionAuthoritativeSnapshotFixture,
} from "../../test-support/session-authoritative-snapshot";

function applySnapshot(
  store: ReturnType<typeof createWebSessionStore>,
  snapshot: SessionAuthoritativeSnapshotFixture,
) {
  return store.getState().applyAuthoritativeSnapshot(
    sessionAuthoritativeSnapshot(store.getState().sessionId, snapshot),
    currentSessionSnapshotGeneration(),
  );
}
import { SessionComposerDock } from "./SessionComposerDock";
import { SettingsModalProvider } from "../../context/settings-modal";
import type { SessionGoalView } from "../../api/types";
import { queryKeys } from "../../api/queries";

const toolAuthorizationSnapshot: ToolAuthorizationSnapshot = {
  extraTools: [],
  toolProjection: null,
};
const loadedToolRefs: LoadedToolRef[] = [];

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;

const requestedModelSelection = {
  mode: "profile_default" as const,
  selection: { model: "test:model" },
};
const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Test Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "m1",
};
const modelState = {
  modelSelection: { revision: 0 },
  nextModelSelection: { requested: requestedModelSelection, resolved: binding },
};
const idleRuntimeSnapshot = {
  executionCount: 0,
  isRunning: false,
  isStreamingModel: false,
  currentExecutionId: undefined,
  currentAssistantMessageId: undefined,
} as const;
const modelRuntime = {
  revision: "m1",
  providers: [
    {
      id: "test",
      displayName: "Test",
      models: [
        {
          id: "model",
          qualifiedId: "test:model",
          displayName: "Test Model",
          variants: [],
        },
      ],
    },
  ],
  profileDefaults: {
    principal: { model: "test:model" },
    deep: { model: "test:model" },
    fast: { model: "test:model" },
  },
};
const activeGoal: SessionGoalView = {
  instanceId: "goal-1",
  settlementReceipts: [],
  generation: 2,
  objective: "Complete the current work",
  status: "active",
  usage: {
    executionCount: 3,
    executionTimeMs: 90_000,
    tokens: {
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    },
  },
  createdAt: 1,
  activatedAt: 1,
  updatedAt: 2,
};

beforeEach(() => {
  notifyManager.setScheduler((callback) => callback());
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  fetchMock = mock(async (input: RequestInfo | URL) =>
    String(input).endsWith("/api/config/model-runtime")
      ? Response.json({
          revision: "m1",
          providers: [
            {
              id: "test",
              displayName: "Test",
              models: [
                {
                  id: "model",
                  qualifiedId: "test:model",
                  displayName: "Test Model",
                  variants: [],
                },
              ],
            },
          ],
          profileDefaults: {
            principal: { model: "test:model" },
            deep: { model: "test:model" },
            fast: { model: "test:model" },
          },
        })
      : Response.json(
          {
            clientRequestId: "request-retry",
            messageId: "message-retry",
            status: "queued",
          },
          { status: 202 },
        ),
  );
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchMock,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  hitlStore.getState().reset();
});

afterEach(() => {
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  hitlStore.getState().reset();
  dom.window.close();
});

describe("SessionComposerDock", () => {
  test("gives pending decisions the expanded priority stack above the always-visible Input", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    applySnapshot(store, {
      rootSessionId: "session-1",
      eventCursor: -1,
      agentName: "lead",
      goal: activeGoal,
      ...modelState,
      pendingMessages: [
        {
          id: "queued-user",
          clientRequestId: "queued-request",
          content: "Queued request",
          attachments: [],
          source: "user",
          executionSkillNames: [],
          state: "queued",
          revision: 1,
          acceptedAt: 3,
          updatedAt: 3,
          requestedModelSelection,
        },
        {
          id: "steering-user",
          clientRequestId: "steering-request",
          content: "Steering request",
          attachments: [],
          source: "user",
          executionSkillNames: [],
          state: "steering",
          revision: 2,
          acceptedAt: 4,
          updatedAt: 5,
          targetExecutionId: "execution-1",
          requestedModelSelection,
        },
      ],
    });
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-retry",
      content: "Retry this exact request",
      attachments: [],
      requestedModelSelection,
      createdAt: 4,
    });
    store.getState().setLocalSendingMessageStatus("request-retry", "retryable");
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-sending",
      content: "Sending this request",
      attachments: [],
      requestedModelSelection,
      createdAt: 6,
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [
        {
          projectSlug: "project-1",
          rootSessionId: "session-1",
          activity: "running",
          steerTargetExecutionId: "execution-1",
        },
      ],
      createdAt: 1,
    });
    const hitlView: HitlView = {
      hitlId: "hitl-1",
      owner: { type: "session", id: "session-1" },
      source: { type: "ask_user", toolCallId: "call-1" },
      status: "pending",
      displayPayload: {
        title: "Choose a direction",
        questions: [{ header: "Choice", question: "Continue?", custom: true }],
        redacted: true,
      },
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["project-1"],
      entries: [
        {
          projectSlug: "project-1",
          hitlId: hitlView.hitlId,
          ownerSessionId: "session-1",
          rootSessionId: "session-1",
          ownerAgentName: "lead",
          ownerSessionTitle: "Session 1",
          view: hitlView,
        },
      ],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <SessionComposerDock slug="project-1" sessionId="session-1" />
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });

    const dock = container.querySelector(
      '[data-testid="session-composer-dock"]',
    );
    const scrollbarAlignment = container.querySelector<HTMLElement>(
      '[data-testid="composer-scrollbar-alignment"]',
    );
    const rail = container.querySelector(
      '[data-testid="conversation-composer-rail"]',
    );
    const threadColumn = container.querySelector(
      '[data-testid="composer-thread-column"]',
    );
    const priority = container.querySelector(
      '[data-testid="composer-priority-stack"]',
    );
    const attention = container.querySelector(
      '[data-testid="composer-attention-stack"]',
    );
    const queue = container.querySelector(
      '[data-testid="composer-queue-list"]',
    );
    const inputSlot = container.querySelector(
      '[data-testid="composer-input-slot"]',
    );
    const goal = container.querySelector(
      '[data-testid="session-goal-summary-row"]',
    );
    const card = container.querySelector('[data-testid="composer-card"]');
    expect(dock?.className).toContain("max-h-[min(78dvh,640px)]");
    expect(dock?.className).toContain("overflow-visible");
    expect(dock?.className).toContain("bg-transparent");
    expect(dock?.className).toContain("border-0");
    expect((dock as HTMLElement | null)?.style.scrollbarGutter).toBe("");
    expect(scrollbarAlignment?.className).toContain("px-0");
    expect(scrollbarAlignment?.className).toContain("min-[761px]:px-[var(--session-scrollbar-gutter,0px)]");
    expect(rail?.className).toContain("w-full");
    expect(rail?.className).toContain("!max-w-[900px]");
    expect(rail?.className).toContain("!px-3");
    expect(rail?.className).toContain("min-[761px]:!px-[26px]");
    expect(threadColumn?.className).toContain("max-w-[852px]");
    expect(threadColumn?.className).toContain("!max-w-[848px]");
    expect(threadColumn?.className).toContain("mx-auto");
    expect(threadColumn?.className).toContain("gap-2");
    expect(priority?.className).toContain("overflow-y-auto");
    expect(priority?.className).toContain("overscroll-contain");
    expect(attention).not.toBeNull();
    expect(attention?.className).toContain("shrink-0");
    expect(queue?.className).toContain("shrink-0");
    expect(inputSlot?.className).toContain("shrink-0");
    expect(inputSlot?.className).toContain("z-[2]");
    expect(goal?.className).toContain("shrink-0");
    expect(card?.className).toContain("rounded-xl");
    expect(card?.querySelector("textarea")).not.toBeNull();
    expect(container.textContent).toContain("Queued request");
    expect(container.textContent).toContain("Retry this exact request");
    expect(container.textContent).toContain("Steering request");
    expect(container.textContent).toContain("Sending this request");
    expect(container.textContent).toContain("Continue?");
    expect(container.textContent).not.toContain("Choose a direction");
    const ordered = Array.from(threadColumn?.children ?? []);
    expect(
      ordered.map((element) => element.getAttribute("data-testid")),
    ).toEqual([
      "composer-priority-stack",
      "composer-input-slot",
    ]);
    const priorityOrder = Array.from(priority?.children ?? []);
    expect(
      priorityOrder.map((element) => element.getAttribute("data-testid")),
    ).toEqual([
      "composer-attention-stack",
      "session-goal-summary-row",
      "composer-queue-list",
    ]);
    expect(
      attention?.querySelector('[data-testid="hitl-decision-card"]'),
    ).not.toBeNull();
    expect(
      attention?.querySelector('[data-testid="hitl-decision-actions"]'),
    ).not.toBeNull();
    expect(container.querySelector("progress, [role=progressbar]")).toBeNull();
    expect(
      container.querySelector('[data-testid="hitl-owner-link"]'),
    ).toBeNull();
    const terminalAction = container.querySelectorAll(
      '[data-testid="composer-terminal-action"]',
    );
    expect(terminalAction).toHaveLength(1);
    expect(terminalAction[0]?.getAttribute("aria-label")).toBe("Stop session");
    expect(container.textContent).toContain("Steer");
    expect(container.querySelector('button[title="Attach file"]')).not.toBeNull();
    expect(
      container.querySelector('button[aria-label="Retry sending message"]'),
    ).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    expect(card?.querySelector("textarea")?.className).toContain(
      "border-0",
    );
  });

  test("keeps a terminal failure visible in the always-present Composer", async () => {
    const store = createWebSessionStore("session-failed", "project-1");
    applySnapshot(store, {
      rootSessionId: "session-failed",
      eventCursor: -1,
      agentName: "lead",
      ...modelState,
      pendingMessages: [],
      executions: [{
        id: "execution-failed",
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        origin: "user_message",
        status: "failed",
        maxSteps: 10,
        executionSkills: [],
        toolAuthorizationSnapshot,
        loadedToolRefs,
        memoryPolicy: {
          policy: { useMemory: true, autoLearning: true },
          epoch: { bootId: "test-memory-boot", generation: 0 },
        },
        runs: [],
        terminalSettlement: { key: "terminal", goalInstanceId: null },
      }],
      executionCount: 1,
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [{
        projectSlug: "project-1",
        rootSessionId: "session-failed",
        activity: "idle",
      }],
      createdAt: 1,
    });
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["project-1"],
      entries: [],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <SessionComposerDock slug="project-1" sessionId="session-failed" />
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });

    const card = container.querySelector('[data-testid="composer-card"]');
    expect(card).not.toBeNull();
    expect(card?.querySelector("textarea")).not.toBeNull();
    expect(card?.textContent).toContain("Failed");
    const dock = container.querySelector(
      '[data-testid="session-composer-dock"]',
    );
    expect(dock?.className).toContain("max-h-[min(52dvh,460px)]");
    expect(dock?.className).toContain("min-[761px]:max-h-[min(48dvh,520px)]");
  });

  test("steps through multi-question Ask User and submits only from Confirm", async () => {
    const store = createWebSessionStore("session-2", "project-1");
    applySnapshot(store, {
      rootSessionId: "session-2",
      eventCursor: -1,
      agentName: "lead",
      ...modelState,
      pendingMessages: [],
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [
        {
          projectSlug: "project-1",
          rootSessionId: "session-2",
          activity: "idle",
        },
      ],
      createdAt: 1,
    });
    const hitlView: HitlView = {
      hitlId: "hitl-multi",
      owner: { type: "session", id: "session-2" },
      source: { type: "ask_user", toolCallId: "call-multi" },
      status: "pending",
      displayPayload: {
        title: "Choose delivery details",
        questions: [
          {
            header: "Approach",
            question: "Which approach?",
            options: [
              { label: "Direct", description: "Make the change now" },
              { label: "Plan", description: "Write a plan first" },
            ],
            custom: false,
          },
          {
            header: "Areas",
            question: "Which areas?",
            options: [
              { label: "UI", description: "Frontend" },
              { label: "API", description: "Backend" },
            ],
            multiple: true,
            custom: false,
          },
        ],
        redacted: true,
      },
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["project-1"],
      entries: [
        {
          projectSlug: "project-1",
          hitlId: hitlView.hitlId,
          ownerSessionId: "session-2",
          rootSessionId: "session-2",
          ownerAgentName: "lead",
          ownerSessionTitle: "Session 2",
          view: hitlView,
        },
      ],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <SessionComposerDock slug="project-1" sessionId="session-2" />
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const attention = container.querySelector(
      '[data-testid="composer-attention-stack"]',
    );
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(attention?.className).not.toContain("overflow");
    expect(
      container.querySelector('[data-testid="hitl-decision-body"]')?.className,
    ).not.toContain("overflow");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      "Approach",
      "Areas",
      "Confirm",
    ]);
    expect(
      container.querySelector('[data-testid="hitl-option-list"]')?.className,
    ).toContain("flex-col");
    expect(container.textContent).not.toContain("Choose delivery details");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Which approach?");
    expect(container.textContent).not.toContain("Which areas?");

    const direct = container.querySelector('input[value="Direct"]');
    if (!(direct instanceof dom.window.HTMLInputElement))
      throw new Error("Missing Direct option");
    await act(async () => direct.click());
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");

    const ui = container.querySelector('input[value="UI"]');
    if (!(ui instanceof dom.window.HTMLInputElement))
      throw new Error("Missing UI option");
    await act(async () => ui.click());
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");

    const review = container.querySelector(
      '[data-testid="hitl-question-next-button"]',
    );
    if (!(review instanceof dom.window.HTMLButtonElement))
      throw new Error("Missing Review answers button");
    expect(review.textContent).toContain("Review answers");
    expect(review.disabled).toBe(false);
    await act(async () => review.click());

    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Review your answers");
    expect(container.textContent).toContain("Direct");
    expect(container.textContent).toContain("UI");

    const conflictResponse = Promise.withResolvers<Response>();
    fetchMock.mockImplementationOnce(
      async () => await conflictResponse.promise,
    );
    const mutationRejected = new Promise<void>((resolve) => {
      const unsubscribe = client.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.mutation.state.status !== "error")
          return;
        unsubscribe();
        resolve();
      });
    });
    const confirm = container.querySelector(
      '[data-testid="hitl-approve-button"]',
    );
    if (!(confirm instanceof dom.window.HTMLButtonElement))
      throw new Error("Missing Confirm Answers button");
    expect(confirm.textContent).toContain("Confirm Answers");
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
      conflictResponse.resolve(
        Response.json(
          { message: "This request was already resolved" },
          { status: 409 },
        ),
      );
      await mutationRejected;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const responseCall = fetchMock.mock.calls.find(([path]) =>
      String(path).endsWith("/hitl/hitl-multi/respond"),
    );
    if (!responseCall) throw new Error("Missing HITL response request");
    const [path, init] = responseCall as unknown as [string, RequestInit];
    expect(path).toBe("/api/projects/project-1/hitl/hitl-multi/respond");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "question_answer",
      answers: ["Direct", "UI"],
    });
    const alertText = container.querySelector('[role="alert"]')?.textContent;
    expect(alertText).toContain("Request failed with status 409");
    expect(
      container.querySelector('[data-testid="hitl-decision-card"]'),
    ).not.toBeNull();
  });

  test("shows one active request at a time and navigates the pending request queue", async () => {
    const store = createWebSessionStore("session-3", "project-1");
    applySnapshot(store, {
      rootSessionId: "session-3",
      eventCursor: -1,
      agentName: "lead",
      ...modelState,
      pendingMessages: [],
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [
        {
          projectSlug: "project-1",
          rootSessionId: "session-3",
          activity: "idle",
        },
      ],
      createdAt: 1,
    });
    const makeHitl = (hitlId: string, title: string): HitlView => ({
      hitlId,
      owner: { type: "session", id: "session-3" },
      source: { type: "ask_user", toolCallId: `call-${hitlId}` },
      status: "pending",
      displayPayload: {
        title,
        questions: [{ header: "Choice", question: `${title}?`, custom: true }],
        redacted: true,
      },
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });
    const first = makeHitl("hitl-first", "First request");
    const second = makeHitl("hitl-second", "Second request");
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["project-1"],
      entries: [
        {
          projectSlug: "project-1",
          hitlId: first.hitlId,
          ownerSessionId: "session-3",
          rootSessionId: "session-3",
          ownerAgentName: "lead",
          ownerSessionTitle: "Session 3",
          view: first,
        },
        {
          projectSlug: "project-1",
          hitlId: second.hitlId,
          ownerSessionId: "session-3",
          rootSessionId: "session-3",
          ownerAgentName: "lead",
          ownerSessionTitle: "Session 3",
          view: second,
        },
      ],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <SessionComposerDock slug="project-1" sessionId="session-3" />
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelectorAll('[data-testid="hitl-decision-card"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("First request");
    expect(container.textContent).not.toContain("Second request");
    expect(
      container.querySelector('[data-testid="hitl-request-navigator"]')
        ?.textContent,
    ).toContain("1/2");

    const next = container.querySelector('button[aria-label="Next request"]');
    if (!(next instanceof dom.window.HTMLButtonElement))
      throw new Error("Missing next request control");
    await act(async () => next.click());

    expect(
      container.querySelectorAll('[data-testid="hitl-decision-card"]'),
    ).toHaveLength(1);
    expect(container.textContent).toContain("Second request");
    expect(container.textContent).not.toContain("First request");
    expect(
      container.querySelector('[data-testid="hitl-request-navigator"]')
        ?.textContent,
    ).toContain("2/2");
    expect(
      container
        .querySelector('button[aria-label="Previous request"]')
        ?.hasAttribute("disabled"),
    ).toBe(false);
    expect(
      container
        .querySelector('button[aria-label="Next request"]')
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });
});
