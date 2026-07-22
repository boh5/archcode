import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigationType } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { TOOL_DELEGATE, createEmptySessionStats } from "@archcode/protocol";
import type { GlobalSSEHitlRealtimeEvent, ToolChildSessionLink } from "@archcode/protocol";
import type { HitlView, ProjectTodo, Session } from "../api/types";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
  evictIdleSessionStores,
  findWebSessionStore,
  getWebSessionStore,
  markSessionForeground,
} from "../store/session-store";
import { hitlStore } from "../store/hitl-store";
import { focusedSessionQueryOptions } from "../api/queries";
import { SessionRoute } from "./session";
import { WorkbenchLayoutProvider, useWorkbenchLayout } from "../context/workbench-layout";
import { SettingsModalProvider } from "../context/settings-modal";

function createSession(input: {
  id: string;
  rootSessionId: string;
  parentSessionId?: string;
  title: string;
  messages: NonNullable<Session["messages"]>;
  childSessionLinks?: ToolChildSessionLink[];
}): Session {
  return {
    sessionId: input.id,
    cwd: "/workspace",
    rootSessionId: input.rootSessionId,
    parentSessionId: input.parentSessionId,
    title: input.title,
    createdAt: 1,
    updatedAt: 1,
    agentName: "lead",
    profile: "principal",
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    nextModelSelection: {
      requested: { mode: "profile_default", selection: { model: "test:model" } },
      resolved: {
        selection: { model: "test:model" }, providerId: "test", modelId: "model",
        providerDisplayName: "Test", modelDisplayName: "Test Model", resolution: "profile_default",
        modelRuntimeRevision: "m1",
      },
    },
    messages: input.messages,
    pendingMessages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionLinks: input.childSessionLinks ?? [],
    stats: createEmptySessionStats(),
    executions: [],
    executionInputCheckpoints: [],
    eventCursor: 0,
  };
}

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

function installDom(): JSDOM {
  saveGlobalDescriptors();

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
      <SettingsModalProvider>
        <WorkbenchLayoutProvider>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/projects/demo/sessions/root-session"]}>
              <Routes>
                <Route path="/projects/:slug/sessions/:sessionId" element={<SessionRoute />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </WorkbenchLayoutProvider>
      </SettingsModalProvider>,
    );
  });
}

function LocationProbe() {
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <output data-testid="location">
      {location.pathname}{location.search}|{navigationType}
    </output>
  );
}

function LayoutProbe() {
  const layout = useWorkbenchLayout();
  return <output data-testid="inspector-expanded">{String(layout.inspectorExpanded)}</output>;
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
    hitlStore.getState().reset();
  });

  afterEach(() => {
    restoreGlobals();
    mock.restore();
  });

  test("opens the Context inspector when an invalidated message requests model details", async () => {
    const dom = installDom();
    dom.window.localStorage.setItem("archcode.workbench.layout", JSON.stringify({
      sidebarWidth: 280,
      inspectorWidth: 360,
      sidebarCollapsed: false,
      inspectorCollapsed: true,
      focusMode: false,
    }));
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Model audit",
      messages: [{
        id: "message-invalidated",
        role: "user",
        executionId: "execution-1",
        parts: [{ type: "text", id: "part-1", text: "Use the old model", createdAt: 1, completedAt: 1 }],
        modelAudit: {
          requested: { mode: "session_override", selection: { model: "test:old" } },
          actual: { model: "test:model" },
          reason: "config_invalidated",
        },
        createdAt: 1,
        completedAt: 1,
      }],
    });
    rootSession.executions = [{
      id: "execution-1",
      origin: "user_message",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
      binding: rootSession.nextModelSelection.resolved,
    }];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/projects/demo/todos") return Response.json({ todos: [] });
      if (path === "/api/projects/demo/sessions/root-session") return Response.json(rootSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/projects/demo/sessions/root-session"]}>
                  <Routes>
                    <Route
                      path="/projects/:slug/sessions/:sessionId"
                      element={<><SessionRoute /><LocationProbe /><LayoutProbe /></>}
                    />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </WorkbenchLayoutProvider>
          </SettingsModalProvider>,
        );
      });

      await waitFor(() => expect(container.textContent).toContain("Model changed: test:old → test:model"));
      expect(container.querySelector('[data-testid="inspector-expanded"]')?.textContent).toBe("false");
      const details = Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Details");
      if (!details) throw new Error("Missing model audit Details button");
      await act(async () => details.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));

      await waitFor(() => {
        expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
          "/projects/demo/sessions/root-session?message=message-invalidated&inspector=context|PUSH",
        );
        expect(container.querySelector('[data-testid="inspector-expanded"]')?.textContent).toBe("true");
      });
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
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
          executionId: "root-execution",
          createdAt: 1,
          parts: [
            {
              type: "tool",
              id: "delegate-part",
              state: "completed",
              toolCallId: "delegate-call",
              toolName: TOOL_DELEGATE,
              input: {
                agent_type: "explore", title: "Explore child session", objective: "Explore child session",
                skills: [], background: false,
              },
              result: {
                isError: false,
                output: {
                  preview: "Sub-agent completed.",
                  completeness: "complete",
                  observed: { bytes: 20, lines: 1 },
                  canonical: { bytes: 20, lines: 1 },
                  stored: { bytes: 20, lines: 1 },
                  omitted: { bytes: 0, lines: 0 },
                  recovery: { kind: "none" },
                },
              },
              createdAt: 1,
              startedAt: 1,
              endedAt: 2,
            },
          ],
        },
      ],
      childSessionLinks: [
        {
          parentSessionId: "root-session",
          parentToolCallId: "delegate-call",
          toolName: "delegate",
          childSessionId: "child-session",
          childAgentName: "explore", childProfile: "fast", childSkillNames: [],
          title: "Explore child session",
          depth: 1,
          background: false,
          status: "completed",
          createdAt: 1,
          startedAt: 1,
          endedAt: 2,
          durationMs: 1000,
        },
      ],
    });
    rootSession.executions = [{
      id: "root-execution",
      origin: "tool_call",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      binding: rootSession.nextModelSelection.resolved,
    }];
    const childSession = createSession({
      id: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Child Session",
      messages: [
        {
          id: "child-message",
          role: "assistant",
          executionId: "child-execution",
          createdAt: 2,
          parts: [{ type: "text", id: "child-text", text: "Child content", createdAt: 2 }],
        },
      ],
    });
    childSession.executions = [{
      id: "child-execution",
      origin: "goal_continuation",
      status: "completed",
      startedAt: 2,
      endedAt: 3,
      durationMs: 1,
      binding: childSession.nextModelSelection.resolved,
    }];
    childSession.todos = [{ id: "child-todo", content: "Inspect child output", status: "in_progress" }];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const path = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.pathname
          : new URL(input.url).pathname;

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
        expect(container.textContent).toContain("Open child session");
        expect(container.querySelector('[data-testid="hitl-inbox"]')).toBeNull();
      });

      await act(async () => {
        findElementByText(container, "Open child session").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      await waitFor(() => {
        expect(getWebSessionStore("root-session", "demo").getState().focusSessionId).toBe("child-session");
        expect(container.textContent).toContain("← Back to Root Session");
        expect(container.textContent).toContain("Child Session");
        expect(container.querySelector('button[aria-label^="Todo progress"]')).not.toBeNull();
        expect(container.querySelector('button[aria-controls~="context-inspector"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="hitl-inbox"]')).toBeNull();
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

  test("renders a pending approval inside the unified composer attention stack", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Root Session",
      messages: [],
    });
    const view: HitlView = {
      hitlId: "hitl-session-padding",
      owner: { type: "session", id: "root-session" },
      source: { type: "ask_user", toolCallId: "call-1" },
      status: "pending",
      displayPayload: {
        title: "Need input",
        questions: [{ header: "Scope", question: "Continue?", options: [{ label: "Yes", description: "Continue" }], custom: true }],
        redacted: true,
      },
      allowedActions: ["answer", "cancel"],
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    const event: GlobalSSEHitlRealtimeEvent = {
      type: "hitl.event",
      projectSlug: "demo",
      hitlId: view.hitlId,
      ownerSessionId: "root-session",
      rootSessionId: "root-session",
      createdAt: 1,
      payload: { type: "hitl.request" },
      view,
    };
    hitlStore.getState().applyRealtimeEvent(event);

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path.endsWith("/sessions/root-session")) return Response.json(rootSession);
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
        const surface = container.querySelector('[data-testid="session-composer-dock"]');
        const rail = container.querySelector('[data-testid="conversation-composer-rail"]');
        const attention = container.querySelector('[data-testid="composer-attention-stack"]');
        const decision = container.querySelector('[data-testid="hitl-decision-card"]');
        expect(decision).not.toBeNull();
        expect(surface?.classList.contains("border-t")).toBe(true);
        expect(surface?.classList.contains("px-5")).toBe(false);
        expect(rail?.className).toContain("max-w-[880px]");
        expect(rail?.className).toContain("px-[16px]");
        expect(rail?.className).toContain("sm:px-[20px]");
        expect(attention?.className).toContain("rounded-[14px]");
        expect(container.textContent).toContain("Need input");
        expect(container.querySelector('[data-testid="hitl-owner-link"]')).toBeNull();
        expect(container.querySelector('input[type="radio"]')).not.toBeNull();
        expect(container.querySelector('input[aria-label="Scope custom answer"]')).not.toBeNull();
      });
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("links a root Discussion Session back to its exact Project Todo", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Shape offline mode",
      messages: [],
    });
    const projectTodo: ProjectTodo = {
      id: "todo-offline-mode",
      title: "Add resilient offline mode",
      body: "",
      status: "ready",
      revision: 3,
      discussionSessionId: "root-session",
      activation: {
        kind: "session",
        sourceSessionId: "root-session",
        todoRevision: 3,
        snapshot: { title: "Add resilient offline mode", body: "" },
      },
      createdAt: 1,
      updatedAt: 2,
    };

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/projects/demo/sessions/root-session") return Response.json(rootSession);
      if (path === "/api/projects/demo/todos") return Response.json({ todos: [projectTodo] });
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={["/projects/demo/sessions/root-session"]}>
                <Routes>
                  <Route path="/projects/:slug/sessions/:sessionId" element={<SessionRoute />} />
                  <Route path="/projects/:slug/todos" element={<LocationProbe />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
            </WorkbenchLayoutProvider>
          </SettingsModalProvider>,
        );
      });

      await waitFor(() => {
        const link = container.querySelector('[data-testid="project-todo-backlink"]');
        expect(link?.textContent).toBe("Add resilient offline mode");
        expect(link?.getAttribute("href")).toBe("/projects/demo/todos?todo=todo-offline-mode");
        expect(container.textContent).toContain("Discussion Todo · Activation source");
      });

      const link = container.querySelector('[data-testid="project-todo-backlink"]');
      if (!link) throw new Error("Missing Project Todo backlink");
      await act(async () => {
        link.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
          "/projects/demo/todos?todo=todo-offline-mode|PUSH",
        );
      });
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("direct child URL is replaced by the canonical root URL focused on that child", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-1",
      rootSessionId: "root-1",
      title: "Root Session",
      messages: [],
    });
    const childSession = createSession({
      id: "child-1",
      rootSessionId: "root-1",
      parentSessionId: "root-1",
      title: "Child Session",
      messages: [],
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") {
        return Response.json({
          projects: [{
            slug: "demo",
            name: "Demo",
            workspaceRoot: "/workspace",
            addedAt: "2026-01-01T00:00:00.000Z",
          }],
        });
      }
      if (path === "/api/projects/demo/sessions/child-1") return Response.json(childSession);
      if (path === "/api/projects/demo/sessions/root-1") return Response.json(rootSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
            <QueryClientProvider client={queryClient}>
            <MemoryRouter initialEntries={["/projects/demo/sessions/child-1"]}>
              <Routes>
                <Route
                  path="/projects/:slug/sessions/:sessionId"
                  element={
                    <>
                      <SessionRoute />
                      <LocationProbe />
                    </>
                  }
                />
              </Routes>
            </MemoryRouter>
            </QueryClientProvider>
            </WorkbenchLayoutProvider>
          </SettingsModalProvider>,
        );
      });

      await waitFor(() => {
        expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
          "/projects/demo/sessions/root-1?focus=child-1|REPLACE",
        );
        expect(container.textContent).toContain("← Back to Root Session");
      });

        expect(container.querySelector("textarea")).not.toBeNull();
      expect(container.querySelector('button[title="Stop"]')).toBeNull();
    } finally {
      await act(async () => reactRoot.unmount());
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
    expect(key).toEqual(["projects", "my-project", "sessions", "child-abc"]);
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
