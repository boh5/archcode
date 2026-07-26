import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HitlView } from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { hitlStore } from "../../store/hitl-store";
import { sessionRuntimeStore } from "../../store/session-runtime-store";
import { __resetWebSessionStoresForTest, createWebSessionStore } from "../../store/session-store";
import { SessionComposerDock } from "./SessionComposerDock";
import { SettingsModalProvider } from "../../context/settings-modal";
import type { SessionGoalView } from "../../api/types";
import { queryKeys } from "../../api/queries";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;

const requestedModelSelection = { mode: "profile_default" as const, selection: { model: "test:model" } };
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
const modelRuntime = {
  revision: "m1",
  providers: [{ id: "test", displayName: "Test", models: [{ id: "model", qualifiedId: "test:model", displayName: "Test Model", variants: [] }] }],
  profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } },
};
const activeGoal: SessionGoalView = {
  instanceId: "goal-1",
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
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
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
  fetchMock = mock(async (input: RequestInfo | URL) => String(input).endsWith("/api/config/model-runtime") ? Response.json({
    revision: "m1",
    providers: [{ id: "test", displayName: "Test", models: [{ id: "model", qualifiedId: "test:model", displayName: "Test Model", variants: [] }] }],
    profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } },
  }) : Response.json({
    clientRequestId: "request-retry",
    messageId: "message-retry",
    status: "queued",
  }, { status: 202 }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
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
  test("keeps HITL first at natural height, then Goal, Queue, and collapsed Input", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      agentName: "lead",
      goal: activeGoal,
      ...modelState,
      pendingMessages: [{
        id: "queued-user",
        clientRequestId: "queued-request",
        content: "Queued request",
        source: "user",
        state: "queued",
        revision: 1,
        acceptedAt: 3,
        updatedAt: 3,
        requestedModelSelection,
      }, {
        id: "steering-user",
        clientRequestId: "steering-request",
        content: "Steering request",
        source: "user",
        state: "steering",
        revision: 2,
        acceptedAt: 4,
        updatedAt: 5,
        targetExecutionId: "execution-1",
        requestedModelSelection,
      }],
    });
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-retry",
      content: "Retry this exact request",
      requestedModelSelection,
      createdAt: 4,
    });
    store.getState().setLocalSendingMessageStatus("request-retry", "retryable");
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-sending",
      content: "Sending this request",
      requestedModelSelection,
      createdAt: 6,
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [{
        projectSlug: "project-1",
        rootSessionId: "session-1",
        activity: "running",
        steerTargetExecutionId: "execution-1",
      }],
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
      entries: [{ projectSlug: "project-1", hitlId: hitlView.hitlId, ownerSessionId: "session-1", rootSessionId: "session-1", view: hitlView }],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider><SessionComposerDock slug="project-1" sessionId="session-1" /></SettingsModalProvider>
        </QueryClientProvider>,
      );
    });

    const dock = container.querySelector('[data-testid="session-composer-dock"]');
    const rail = container.querySelector('[data-testid="conversation-composer-rail"]');
    const attention = container.querySelector('[data-testid="composer-attention-stack"]');
    const queue = container.querySelector('[data-testid="composer-queue-list"]');
    const inputSlot = container.querySelector('[data-testid="composer-input-slot"]');
    const goal = container.querySelector('[data-testid="session-goal-summary-row"]');
    const card = container.querySelector('[data-testid="composer-card"]');
    const hitlBody = container.querySelector('[data-testid="hitl-decision-body"]');
    expect(dock?.className).not.toContain("max-h-[");
    expect(dock?.className).not.toContain("overflow");
    expect(dock?.classList.contains("border-t")).toBe(true);
    expect(rail?.className).toContain("w-full");
    expect(rail?.className).not.toContain("max-w-[");
    expect(attention).not.toBeNull();
    expect(attention?.className).not.toContain("overflow");
    expect(hitlBody?.className).not.toContain("overflow");
    expect(queue?.className).toContain("max-h-[160px]");
    expect(queue?.className).toContain("max-[799px]:max-h-[116px]");
    expect(queue?.className).toContain("overflow-y-auto");
    expect(inputSlot?.className).toContain("shrink-0");
    expect(goal?.className).toContain("shrink-0");
    expect(card?.className).toContain("rounded-sm");
    expect(card?.getAttribute("data-density")).toBe("collapsed");
    expect(card?.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("Queued request");
    expect(container.textContent).toContain("Retry this exact request");
    expect(container.textContent).toContain("Steering request");
    expect(container.textContent).toContain("Sending this request");
    expect(container.textContent).toContain("Continue?");
    expect(container.textContent).not.toContain("Choose a direction");
    const ordered = Array.from(rail?.children ?? []);
    expect(ordered.map((element) => element.getAttribute("data-testid"))).toEqual([
      "composer-attention-stack",
      "session-goal-summary-row",
      "composer-queue-list",
      "composer-input-slot",
    ]);
    expect(attention?.querySelector('[data-testid="hitl-decision-card"]')).not.toBeNull();
    expect(attention?.querySelector('[data-testid="hitl-decision-actions"]')).not.toBeNull();
    expect(container.querySelector("progress, [role=progressbar]")).toBeNull();
    expect(container.querySelector('[data-testid="hitl-queue-composer-trigger"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="hitl-owner-link"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Queue message"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.textContent).toContain("Steer");
    expect(container.querySelector('button[title="Attach file"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Retry sending message"]')).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const composerTrigger = container.querySelector('[data-testid="hitl-queue-composer-trigger"]');
    if (!(composerTrigger instanceof dom.window.HTMLButtonElement)) throw new Error("Missing queued-message composer trigger");
    await act(async () => composerTrigger.click());
    const expandedCard = container.querySelector('[data-testid="composer-card"]');
    expect(expandedCard?.querySelector("textarea")?.className).toContain("border-0");
    expect(container.querySelector('button[aria-label="Queue message"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Collapse queued-message composer"]')).not.toBeNull();
  });

  test("steps through multi-question Ask User and submits only from Confirm", async () => {
    const store = createWebSessionStore("session-2", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-2",
      eventCursor: -1,
      agentName: "lead",
      ...modelState,
      pendingMessages: [],
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [{
        projectSlug: "project-1",
        rootSessionId: "session-2",
        activity: "idle",
      }],
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
      entries: [{ projectSlug: "project-1", hitlId: hitlView.hitlId, ownerSessionId: "session-2", rootSessionId: "session-2", view: hitlView }],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider><SessionComposerDock slug="project-1" sessionId="session-2" /></SettingsModalProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const attention = container.querySelector('[data-testid="composer-attention-stack"]');
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(attention?.className).not.toContain("overflow");
    expect(container.querySelector('[data-testid="hitl-decision-body"]')?.className).not.toContain("overflow");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Approach", "Areas", "Confirm"]);
    expect(container.querySelector('[data-testid="hitl-option-list"]')?.className).toContain("flex-col");
    expect(container.textContent).not.toContain("Choose delivery details");
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Which approach?");
    expect(container.textContent).not.toContain("Which areas?");

    const direct = container.querySelector('input[value="Direct"]');
    if (!(direct instanceof dom.window.HTMLInputElement)) throw new Error("Missing Direct option");
    await act(async () => direct.click());
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");

    const ui = container.querySelector('input[value="UI"]');
    if (!(ui instanceof dom.window.HTMLInputElement)) throw new Error("Missing UI option");
    await act(async () => ui.click());
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");

    const review = container.querySelector('[data-testid="hitl-question-next-button"]');
    if (!(review instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Review answers button");
    expect(review.textContent).toContain("Review answers");
    expect(review.disabled).toBe(false);
    await act(async () => review.click());

    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("Review your answers");
    expect(container.textContent).toContain("Direct");
    expect(container.textContent).toContain("UI");

    const conflictResponse = Promise.withResolvers<Response>();
    fetchMock.mockImplementationOnce(async () => await conflictResponse.promise);
    const mutationRejected = new Promise<void>((resolve) => {
      const unsubscribe = client.getMutationCache().subscribe((event) => {
        if (event.type !== "updated" || event.mutation.state.status !== "error") return;
        unsubscribe();
        resolve();
      });
    });
    const confirm = container.querySelector('[data-testid="hitl-approve-button"]');
    if (!(confirm instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Confirm Answers button");
    expect(confirm.textContent).toContain("Confirm Answers");
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
      conflictResponse.resolve(
        Response.json({ message: "This request was already resolved" }, { status: 409 }),
      );
      await mutationRejected;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const responseCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith("/hitl/hitl-multi/respond"));
    if (!responseCall) throw new Error("Missing HITL response request");
    const [path, init] = responseCall as unknown as [string, RequestInit];
    expect(path).toBe("/api/projects/project-1/hitl/hitl-multi/respond");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "question_answer",
      answers: ["Direct", "UI"],
    });
    const alertText = container.querySelector('[role="alert"]')?.textContent;
    expect(alertText).toContain("Request failed with status 409");
    expect(container.querySelector('[data-testid="hitl-decision-card"]')).not.toBeNull();
  });

  test("shows one active request at a time and navigates the pending request queue", async () => {
    const store = createWebSessionStore("session-3", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-3",
      eventCursor: -1,
      agentName: "lead",
      ...modelState,
      pendingMessages: [],
    });
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [{
        projectSlug: "project-1",
        rootSessionId: "session-3",
        activity: "idle",
      }],
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
        { projectSlug: "project-1", hitlId: first.hitlId, ownerSessionId: "session-3", rootSessionId: "session-3", view: first },
        { projectSlug: "project-1", hitlId: second.hitlId, ownerSessionId: "session-3", rootSessionId: "session-3", view: second },
      ],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider><SessionComposerDock slug="project-1" sessionId="session-3" /></SettingsModalProvider>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelectorAll('[data-testid="hitl-decision-card"]')).toHaveLength(1);
    expect(container.textContent).toContain("First request");
    expect(container.textContent).not.toContain("Second request");
    expect(container.querySelector('[data-testid="hitl-request-navigator"]')?.textContent).toContain("1/2");

    const next = container.querySelector('button[aria-label="Next request"]');
    if (!(next instanceof dom.window.HTMLButtonElement)) throw new Error("Missing next request control");
    await act(async () => next.click());

    expect(container.querySelectorAll('[data-testid="hitl-decision-card"]')).toHaveLength(1);
    expect(container.textContent).toContain("Second request");
    expect(container.textContent).not.toContain("First request");
    expect(container.querySelector('[data-testid="hitl-request-navigator"]')?.textContent).toContain("2/2");
    expect(container.querySelector('button[aria-label="Previous request"]')?.hasAttribute("disabled")).toBe(false);
    expect(container.querySelector('button[aria-label="Next request"]')?.hasAttribute("disabled")).toBe(true);
  });
});
