import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HitlView } from "@archcode/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { hitlStore } from "../../store/hitl-store";
import { sessionRuntimeStore } from "../../store/session-runtime-store";
import { __resetWebSessionStoresForTest, createWebSessionStore } from "../../store/session-store";
import { SessionComposerDock } from "./SessionComposerDock";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  fetchMock = mock(async () => Response.json({
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
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  hitlStore.getState().reset();
  dom.window.close();
});

describe("SessionComposerDock", () => {
  test("owns HITL above the composer without taking queued messages out of chat", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      modelInfo: { providerId: "test", modelId: "model", qualifiedId: "test:model", displayName: "Test Model" },
      pendingMessages: [{
        id: "queued-user",
        clientRequestId: "queued-request",
        content: "Queued request",
        source: "user",
        state: "queued",
        revision: 1,
        acceptedAt: 3,
        updatedAt: 3,
      }],
    });
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-retry",
      content: "Retry this exact request",
      createdAt: 4,
    });
    store.getState().setLocalSendingMessageStatus("request-retry", "retryable");
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
      entries: [{ projectSlug: "project-1", view: hitlView }],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SessionComposerDock slug="project-1" sessionId="session-1" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const dock = container.querySelector('[data-testid="session-composer-dock"]');
    const rail = container.querySelector('[data-testid="conversation-composer-rail"]');
    const attention = container.querySelector('[data-testid="composer-attention-stack"]');
    const card = container.querySelector('[data-testid="composer-card"]');
    const textarea = card?.querySelector("textarea");
    expect(dock?.classList.contains("border-t")).toBe(false);
    expect(rail?.className).toContain("max-w-[880px]");
    expect(attention).not.toBeNull();
    expect(card?.className).toContain("rounded-[16px]");
    expect(textarea?.className).toContain("border-0");
    expect(container.textContent).not.toContain("Queued request");
    expect(container.textContent).not.toContain("Retry this exact request");
    expect(container.textContent).toContain("Choose a direction");
    expect(container.querySelector('[data-testid="composer-pending-messages"]')).toBeNull();
    expect(container.querySelector('[data-testid="hitl-owner-link"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Queue message"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Stop session"]')).not.toBeNull();
    expect(container.textContent).not.toContain("Steer");
    expect(container.querySelector('button[title="Attach file"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Retry sending message"]')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  test("steps through multi-question Ask User and submits only from Confirm", async () => {
    const store = createWebSessionStore("session-2", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-2",
      eventCursor: -1,
      modelInfo: { providerId: "test", modelId: "model", qualifiedId: "test:model", displayName: "Test Model" },
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
      entries: [{ projectSlug: "project-1", view: hitlView }],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SessionComposerDock slug="project-1" sessionId="session-2" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const attention = container.querySelector('[data-testid="composer-attention-stack"]');
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(attention?.className).toContain("overflow-x-hidden");
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(["Approach", "Areas", "Confirm"]);
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

    fetchMock.mockImplementationOnce(async () => Response.json({
      hitlId: hitlView.hitlId,
      status: "answered",
      view: { ...hitlView, status: "answered", allowedActions: [] },
    }));
    const confirm = container.querySelector('[data-testid="hitl-approve-button"]');
    if (!(confirm instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Confirm Answers button");
    expect(confirm.textContent).toContain("Confirm Answers");
    expect(confirm.disabled).toBe(false);
    await act(async () => {
      confirm.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/projects/project-1/hitl/hitl-multi/respond");
    expect(JSON.parse(String(init.body))).toEqual({
      type: "question_answer",
      answers: ["Direct", "UI"],
    });
  });
});
