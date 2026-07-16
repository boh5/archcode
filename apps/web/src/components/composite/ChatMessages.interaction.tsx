import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { ChatMessages } from "./ChatMessages";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
} from "../../store/session-store";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    scrollIntoView: { configurable: true, value: () => {} },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
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
  fetchMock = mock(async () => new Response(JSON.stringify({
    clientRequestId: "request-retry",
    messageId: "message-retry",
    status: "queued",
  }), { status: 202, headers: { "content-type": "application/json" } }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
});

afterEach(() => {
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  dom.window.close();
});

describe("ChatMessages optimistic retry", () => {
  test("keeps canonical transcript order when a queued message has an earlier acceptance time", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      messages: [
        {
          id: "message-a",
          role: "user",
          parts: [{ type: "text", id: "part-a", text: "First request", createdAt: 1, completedAt: 1 }],
          createdAt: 1,
          completedAt: 1,
        },
        {
          id: "message-answer",
          role: "assistant",
          parts: [{ type: "text", id: "part-answer", text: "First answer", createdAt: 10, completedAt: 10 }],
          createdAt: 10,
          completedAt: 10,
        },
        {
          id: "message-b",
          role: "user",
          clientRequestId: "request-b",
          parts: [{ type: "text", id: "part-b", text: "Queued follow-up", createdAt: 2, completedAt: 11 }],
          createdAt: 2,
          completedAt: 11,
        },
      ],
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ChatMessages slug="project-1" sessionId="session-1" agents={[]} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const text = container.textContent ?? "";
    expect(text.indexOf("First request")).toBeLessThan(text.indexOf("First answer"));
    expect(text.indexOf("First answer")).toBeLessThan(text.indexOf("Queued follow-up"));
  });

  test("retries an unknown POST outcome with the exact same clientRequestId", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({ rootSessionId: "session-1", eventCursor: -1 });
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-retry",
      content: "Do not duplicate me",
      createdAt: 1,
    });
    store.getState().setLocalSendingMessageStatus("request-retry", "retryable");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ChatMessages slug="project-1" sessionId="session-1" agents={[]} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const retry = document.querySelector('button[aria-label="Retry sending message"]');
    if (!(retry instanceof dom.window.HTMLButtonElement)) throw new Error("Missing retry button");
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/projects/project-1/sessions/session-1/messages");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Do not duplicate me",
      clientRequestId: "request-retry",
    });
  });
});
