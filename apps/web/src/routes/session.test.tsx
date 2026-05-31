import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { TOOL_DELEGATE } from "@specra/protocol";
import type { Session } from "../api/types";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
  evictIdleSessionStores,
  findWebSessionStore,
  getWebSessionStore,
  markSessionForeground,
} from "../store/session-store";
import { focusedSessionQueryOptions } from "../api/queries";
import { SessionRoute } from "./session";

function createSession(input: {
  id: string;
  rootSessionId: string;
  parentSessionId?: string;
  title: string;
  messages: NonNullable<Session["messages"]>;
}): Session {
  return {
    id: input.id,
    sessionId: input.id,
    rootSessionId: input.rootSessionId,
    parentSessionId: input.parentSessionId,
    title: input.title,
    createdAt: 1,
    updatedAt: 1,
    messages: input.messages,
    steps: [],
    todos: [],
    reminders: [],
    eventCursor: 0,
  };
}

function installDom(): JSDOM {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/projects/demo/sessions/root-session",
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
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value: () => {}, configurable: true });

  return dom;
}

async function waitFor(assertion: () => void): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < 1500) {
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
  if (!match) throw new Error(`Unable to find element containing ${text}`);
  return match;
}

async function renderSessionRoute(root: Root, queryClient: QueryClient): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/projects/demo/sessions/root-session"]}>
          <Routes>
            <Route path="/projects/:slug/sessions/:sessionId" element={<SessionRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

describe("SessionRoute store-level behavior", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("markSessionForeground(true) pins the store against eviction", () => {
    const store = createWebSessionStore("fg-pin", "demo");
    markSessionForeground("demo", "fg-pin", true);

    for (let i = 0; i < 22; i++) {
      createWebSessionStore(`evictable-${i}`, "demo");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("fg-pin", "demo")).toBe(store);
  });

  test("markSessionForeground(false) releases the pin, allowing eviction", () => {
    createWebSessionStore("fg-unpin", "demo");
    markSessionForeground("demo", "fg-unpin", true);
    markSessionForeground("demo", "fg-unpin", false);

    for (let i = 0; i < 22; i++) {
      createWebSessionStore(`evictable-unpin-${i}`, "demo");
    }

    evictIdleSessionStores();

    expect(findWebSessionStore("fg-unpin", "demo")).toBeUndefined();
  });

  test("getWebSessionStore followed by initializeFromSnapshot populates the store", () => {
    const slug = "demo";
    const sessionId = "route-snapshot";
    const sessionData = {
      messages: [{ id: "m1", role: "user" as const, parts: [{ type: "text" as const, id: "p1", text: "hello", createdAt: Date.now() }], createdAt: Date.now() }],
      steps: [],
      todos: [],
      reminders: [],
      title: "Test Session",
      rootSessionId: "root-1",
      eventCursor: 5,
    };

    const store = createWebSessionStore(sessionId, slug);
    store.getState().initializeFromSnapshot(sessionData);

    const state = store.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.title).toBe("Test Session");
    expect(state.nextEventId).toBe(6);
  });

  test("does not use per-session connection state from old SSE transport", () => {
    const store = createWebSessionStore("no-sse", "demo");
    const state = store.getState();

    expect(state).not.toHaveProperty("connectionState");
    expect(state).not.toHaveProperty("setConnectionState");
    expect(state).not.toHaveProperty("lastEventId");
    expect(state).not.toHaveProperty("setLastEventId");
  });
});

describe("SessionRoute focused view store behavior", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("clicking DelegationCard focuses child session and back breadcrumb clears focus", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Root Session",
      messages: [
        {
          id: "root-message",
          role: "assistant",
          createdAt: 1,
          parts: [
            {
              type: "tool",
              id: "delegate-part",
              state: "completed",
              toolCallId: "delegate-call",
              toolName: TOOL_DELEGATE,
              input: { agent_type: "explorer", description: "Explore child session" },
              output: JSON.stringify({ sessionId: "child-session" }),
              createdAt: 1,
              startedAt: 1,
              endedAt: 2,
            },
          ],
        },
      ],
    });
    const childSession = createSession({
      id: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Child Session",
      messages: [
        {
          id: "child-message",
          role: "assistant",
          createdAt: 2,
          parts: [{ type: "text", id: "child-text", text: "Child content", createdAt: 2 }],
        },
      ],
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const path = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;

      if (path.endsWith("/workflow")) return Response.json(null);
      if (path.endsWith("/sessions/root-session")) return Response.json(rootSession);
      if (path.endsWith("/sessions/child-session")) return Response.json(childSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await renderSessionRoute(reactRoot, queryClient);

      await waitFor(() => {
        expect(getWebSessionStore("root-session", "demo").getState().focusSessionId).toBeNull();
        expect(container.textContent).toContain("View full conversation");
      });

      await act(async () => {
        findElementByText(container, "View full conversation").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(getWebSessionStore("root-session", "demo").getState().focusSessionId).toBe("child-session");
        expect(container.textContent).toContain("← Back to Root Session");
        expect(container.textContent).toContain("Child Session");
      });

      await act(async () => {
        findElementByText(container, "Back to Root Session").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(getWebSessionStore("root-session", "demo").getState().focusSessionId).toBeNull();
      });
    } finally {
      await act(async () => {
        reactRoot.unmount();
      });
      queryClient.clear();
      dom.window.close();
    }
  });

  test("setFocusSessionId(null) clears focus, returning to root session view", () => {
    const slug = "demo";
    const sessionId = "root-session";
    const store = getWebSessionStore(sessionId, slug);

    store.getState().setFocusSessionId("child-1");
    expect(store.getState().focusSessionId).toBe("child-1");

    store.getState().setFocusSessionId(null);
    expect(store.getState().focusSessionId).toBeNull();
  });

  test("setFocusSessionId transitions from one child to another", () => {
    const slug = "demo";
    const sessionId = "root-session";
    const store = getWebSessionStore(sessionId, slug);

    store.getState().setFocusSessionId("child-1");
    expect(store.getState().focusSessionId).toBe("child-1");

    store.getState().setFocusSessionId("child-2");
    expect(store.getState().focusSessionId).toBe("child-2");
  });

  test("focusedSessionQueryOptions is disabled when focusSessionId is null", () => {
    const options = focusedSessionQueryOptions("demo", null);
    expect(options.enabled).toBe(false);
  });

  test("focusedSessionQueryOptions is disabled when slug is empty", () => {
    const options = focusedSessionQueryOptions("", "child-1");
    expect(options.enabled).toBe(false);
  });

  test("focusedSessionQueryOptions is enabled when slug and focusSessionId are set", () => {
    const options = focusedSessionQueryOptions("demo", "child-1");
    expect(options.enabled).toBe(true);
  });

  test("focusedSessionQueryOptions is disabled when focusSessionId is empty string", () => {
    const options = focusedSessionQueryOptions("demo", "");
    expect(options.enabled).toBe(false);
  });

  test("focusedSessionQueryOptions uses correct query key", () => {
    const options = focusedSessionQueryOptions("my-project", "child-abc");
    const key = options.queryKey as unknown as string[];
    expect(key).toEqual(["projects", "my-project", "sessions", "child-abc", "focused"]);
  });

  test("child session store can be initialized from focused session snapshot", () => {
    const slug = "demo";
    const rootSessionId = "root-1";
    const childSessionId = "child-1";

    const rootStore = getWebSessionStore(rootSessionId, slug);
    rootStore.getState().setFocusSessionId(childSessionId);

    const childStore = getWebSessionStore(childSessionId, slug);
    const snapshot = {
      messages: [{ id: "m1", role: "assistant" as const, parts: [{ type: "text" as const, id: "p1", text: "child response", createdAt: Date.now() }], createdAt: Date.now() }],
      steps: [],
      todos: [],
      reminders: [],
      title: "Child Session",
      rootSessionId,
      parentSessionId: rootSessionId,
      eventCursor: 3,
    };
    childStore.getState().initializeFromSnapshot(snapshot);

    const state = childStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.title).toBe("Child Session");
    expect(state.rootSessionId).toBe(rootSessionId);
    expect(state.parentSessionId).toBe(rootSessionId);
  });
});
