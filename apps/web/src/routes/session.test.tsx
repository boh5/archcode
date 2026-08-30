import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigationType,
} from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { TOOL_DELEGATE, createEmptySessionStats } from "@archcode/protocol";
import type {
  GlobalSSEHitlRealtimeEvent,
  LoadedToolRef,
  RootSessionSource,
  ToolChildSessionLink,
  ToolAuthorizationSnapshot,
} from "@archcode/protocol";
import type { HitlView, ProjectTodo, Session } from "../api/types";
import {
  __resetWebSessionStoresForTest,
  currentSessionSnapshotGeneration,
  createWebSessionStore,
  evictIdleSessionStores,
  findWebSessionStore,
  getWebSessionStore,
  markSessionForeground,
} from "../store/session-store";
import {
  sessionAuthoritativeSnapshot,
  type SessionAuthoritativeSnapshotFixture,
} from "../test-support/session-authoritative-snapshot";
const memoryPolicy = {
  policy: { useMemory: true, autoLearning: true },
  epoch: { bootId: "test-memory-boot", generation: 0 },
};
const toolAuthorizationSnapshot: ToolAuthorizationSnapshot = {
  extraTools: [],
  toolProjection: null,
};
const loadedToolRefs: LoadedToolRef[] = [];
import { hitlStore } from "../store/hitl-store";
import {
  diffQueryOptions,
  focusedSessionQueryOptions,
  projectTodosQueryOptions,
  sessionQueryOptions,
} from "../api/queries";
import {
  effectiveSessionFocusId,
  hasSessionSnapshotRecoveryOwner,
  deriveSessionShellMode,
  sessionInspectorTopInset,
  sessionSourceErrorReturn,
  SessionRoute,
} from "./session";
import { WorkbenchLayoutProvider, useWorkbenchLayout } from "../context/workbench-layout";
import { SettingsModalProvider } from "../context/settings-modal";

function applySnapshot(
  store: ReturnType<typeof createWebSessionStore>,
  snapshot: SessionAuthoritativeSnapshotFixture,
) {
  return store.getState().applyAuthoritativeSnapshot(
    sessionAuthoritativeSnapshot(store.getState().sessionId, snapshot),
    currentSessionSnapshotGeneration(),
  );
}

describe("root Session source presentation", () => {
  test("derives every shell only from its canonical root source", () => {
    expect(deriveSessionShellMode({ kind: "direct" }, "demo")).toMatchObject({
      kind: "source-only",
      sourceLabel: "Direct",
      backLabel: "Runs",
    });
    expect(deriveSessionShellMode(
      { kind: "todo", todoId: "todo-1", entry: "work" },
      "demo",
    )).toMatchObject({ kind: "todo-bound", todoId: "todo-1", sourceLabel: "Todo · Work" });
    expect(deriveSessionShellMode(
      { kind: "automation", automationId: "auto-1", invocationId: "run-1", todoId: null },
      "demo",
    )).toEqual({
      kind: "source-only",
      sessionKind: "AUTOMATION SESSION",
      sourceLabel: "Automation",
      backLabel: "Schedules",
      backTo: "/projects/demo/automations/auto-1?invocation=run-1",
    });
    expect(deriveSessionShellMode(
      { kind: "automation", automationId: "auto-1", invocationId: "run-1", todoId: "todo-1" },
      "demo",
    )).toMatchObject({ kind: "todo-bound", todoId: "todo-1", sourceLabel: "Automation" });
  });

  test("matches the source-aware Inspector inset contract", () => {
    const direct = deriveSessionShellMode({ kind: "direct" }, "demo");
    const todo = deriveSessionShellMode({ kind: "todo", todoId: "todo-1", entry: "work" }, "demo");
    expect(sessionInspectorTopInset({ mode: direct, viewportWidth: 560 })).toBe(58);
    expect(sessionInspectorTopInset({ mode: todo, viewportWidth: 560 })).toBe(145);
    expect(sessionInspectorTopInset({ mode: todo, viewportWidth: 720 })).toBe(115);
    expect(sessionInspectorTopInset({ mode: todo, viewportWidth: 721 })).toBe(108);
    expect(sessionInspectorTopInset({ mode: todo, viewportWidth: 980 })).toBe(108);
    expect(sessionInspectorTopInset({ mode: todo, viewportWidth: 1260 })).toBe(108);
  });

  test("keeps the exact Automation return identity when its linked Todo is unavailable", () => {
    expect(sessionSourceErrorReturn({
      kind: "automation",
      automationId: "auto-1",
      invocationId: "run-1",
      todoId: "missing-todo",
    }, "demo")).toEqual({
      label: "Schedules",
      to: "/projects/demo/automations/auto-1?invocation=run-1",
    });
  });

  test("returns a Todo-sourced Session with an unavailable Todo to Runs", () => {
    expect(sessionSourceErrorReturn({
      kind: "todo",
      todoId: "missing-todo",
      entry: "work",
    }, "demo")).toEqual({
      label: "Runs",
      to: "/projects/demo/sessions",
    });
  });
});

function createSession(input: {
  id: string;
  rootSessionId: string;
  parentSessionId?: string;
  title: string;
  messages: NonNullable<Session["messages"]>;
  childSessionLinks?: ToolChildSessionLink[];
  goal?: Session["goal"];
  source?: RootSessionSource;
  agentName?: string;
  profile?: Session["profile"];
  delegationRequest?: Session["delegationRequest"];
}): Session {
  return {
    sessionId: input.id,
    cwd: "/workspace",
    rootSessionId: input.rootSessionId,
    parentSessionId: input.parentSessionId,
    goal: input.goal,
    source: input.source ?? { kind: "direct" },
    title: input.title,
    createdAt: 1,
    updatedAt: 1,
    agentName: input.agentName ?? "lead",
    profile: input.profile ?? "principal",
    delegationRequest: input.delegationRequest,
    activeSkillNames: [],
    modelSelection: { revision: 0 },
    nextModelSelection: {
      requested: {
        mode: "profile_default",
        selection: { model: "test:model" },
      },
      resolved: {
        selection: { model: "test:model" },
        providerId: "test",
        modelId: "model",
        providerDisplayName: "Test",
        modelDisplayName: "Test Model",
        resolution: "profile_default",
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
    executionCount: 0,
    isRunning: false,
    isStreamingModel: false,
    currentExecutionId: undefined,
    currentAssistantMessageId: undefined,
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

let originalGlobalDescriptors:
  Map<DomGlobalName, PropertyDescriptor | undefined> | undefined;

function saveGlobalDescriptors(): void {
  if (originalGlobalDescriptors) return;

  originalGlobalDescriptors = new Map(
    DOM_GLOBAL_NAMES.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
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

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: "http://localhost/projects/demo/sessions/root-session",
    },
  );

  Object.defineProperty(globalThis, "window", {
    value: dom.window,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: dom.window.document,
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: dom.window.navigator,
    configurable: true,
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    value: dom.window.HTMLElement,
    configurable: true,
  });
  Object.defineProperty(globalThis, "MouseEvent", {
    value: dom.window.MouseEvent,
    configurable: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    value: () => {},
    configurable: true,
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", {
    value: () => {},
    configurable: true,
  });

  return dom;
}

function findElementByText(container: Element, text: string): Element {
  const elements = Array.from(container.querySelectorAll("*")).reverse();
  const match = elements.find((element) => element.textContent?.includes(text));
  if (!match) throw new Error(`Unable to find element containing ${text}`);
  return match;
}

async function renderSessionRoute(
  root: Root,
  queryClient: QueryClient,
  initialEntry = "/projects/demo/sessions/root-session",
): Promise<void> {
  await queryClient.fetchQuery(sessionQueryOptions("demo", "root-session"));
  await act(async () => {
    root.render(
      <SettingsModalProvider>
        <WorkbenchLayoutProvider>
          <QueryClientProvider client={queryClient}>
            <MemoryRouter
              initialEntries={[initialEntry]}
            >
              <Routes>
                <Route
                  path="/projects/:slug/sessions/:sessionId"
                  element={<SessionRoute />}
                />
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
      {location.pathname}
      {location.search}|{navigationType}
    </output>
  );
}

function LayoutProbe() {
  const layout = useWorkbenchLayout();
  return (
    <output data-testid="inspector-expanded">
      {String(layout.inspectorExpanded)}
    </output>
  );
}

describe("SessionRoute store-level behavior", () => {
  beforeEach(() => {
    __resetWebSessionStoresForTest();
  });

  test("keeps the Inspector control available across the 760px layout boundary", async () => {
    const sessionSource = await Bun.file(
      new URL("./session.tsx", import.meta.url),
    ).text();
    const panelToggleSource = await Bun.file(
      new URL("../components/features/PanelToggleButton.tsx", import.meta.url),
    ).text();
    expect(sessionSource).toContain("<InspectorToggleButton");
    expect(panelToggleSource).toContain("[@media(pointer:coarse)]:h-11");
  });

  test("wires the Invocation client request id to canonical and queued message owners", async () => {
    const sessionSource = await Bun.file(new URL("./session.tsx", import.meta.url)).text();
    expect(sessionSource).toContain('searchParams.get("invocation")');
    expect(sessionSource.match(/focusClientRequestId=\{focusClientRequestId\}/g)).toHaveLength(4);
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

  test("getWebSessionStore followed by authoritative snapshot populates the store", () => {
    const slug = "demo";
    const sessionId = "route-snapshot";
    const sessionData = {
      executionCount: 0,
      isRunning: false,
      isStreamingModel: false,
      currentExecutionId: undefined,
      currentAssistantMessageId: undefined,
      messages: [
        {
          id: "m1",
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              id: "p1",
              text: "hello",
              createdAt: Date.now(),
            },
          ],
          createdAt: Date.now(),
        },
      ],
      steps: [],
      todos: [],
      reminders: [],
      title: "Test Session",
      rootSessionId: "root-1",
      eventCursor: 5,
    };

    const store = createWebSessionStore(sessionId, slug);
    applySnapshot(store, sessionData);

    const state = store.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.title).toBe("Test Session");
    expect(state.nextEventId).toBe(6);
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

  test("treats a self-focus URL as the root view with no focused owner", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Root Session",
      messages: [],
    });
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
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    await queryClient.fetchQuery(sessionQueryOptions("demo", "root-session"));
    const reactRoot = createRoot(container);

    try {
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter initialEntries={["/projects/demo/sessions/root-session?focus=root-session"]}>
                  <Routes>
                    <Route path="/projects/:slug/sessions/:sessionId" element={<SessionRoute />} />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </WorkbenchLayoutProvider>
          </SettingsModalProvider>,
        );
      });

      expect(container.textContent).not.toContain("Back to Root Session");
      expect(container.querySelector("textarea")).not.toBeNull();
      expect(getWebSessionStore("root-session", "demo").getState().focusSessionId).toBeNull();
      expect(fetchMock.mock.calls.filter(([input]) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return new URL(url, "http://localhost").pathname
          === "/api/projects/demo/sessions/root-session";
      })).toHaveLength(1);
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("keeps the root composer mounted while full diff replaces the canvas", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");
    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Root Session",
      messages: [],
    });
    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/projects/demo/todos") return Response.json({ todos: [] });
      if (path === "/api/projects/demo/sessions/root-session") return Response.json(rootSession);
      if (path === "/api/projects/demo/diff") return Response.json({ files: [] });
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
    });
    const reactRoot = createRoot(container);

    try {
      await queryClient.fetchQuery({
        ...diffQueryOptions("demo", "root-session"),
        staleTime: Infinity,
      });
      await renderSessionRoute(
        reactRoot,
        queryClient,
        "/projects/demo/sessions/root-session?view=diff",
      );
      expect(container.querySelector('[data-testid="session-diff-canvas"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="session-composer-dock"]')).not.toBeNull();
      expect(container.querySelector('[data-session-diff-heading]')?.textContent).toBe("0 files changed");
      expect(container.textContent).toContain("Current checkout");
      expect(container.textContent).toContain("Uncommitted diff");
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
      restoreGlobals();
      mock.restore();
    }
  });

  test("hydrates the Session Goal and renders usage changes directly from the live store", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const initialGoal: NonNullable<Session["goal"]> = {
      instanceId: "goal-live",
      settlementReceipts: [],
      generation: 1,
      objective: "Keep Goal usage live after settlement",
      status: "active",
      usage: {
        tokens: {
          inputTokens: 1_000,
          outputTokens: 500,
          totalTokens: 1_500,
          reasoningTokens: 0,
          cachedInputTokens: 0,
        },
        executionTimeMs: 90_000,
        executionCount: 1,
      },
      createdAt: 1,
      activatedAt: 1,
      updatedAt: 1,
    };
    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Live Goal usage",
      messages: [],
      goal: initialGoal,
    });

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/projects/demo/todos")
        return Response.json({ todos: [] });
      if (path === "/api/projects/demo/sessions/root-session")
        return Response.json(rootSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    const reactRoot = createRoot(container);

    try {
      await renderSessionRoute(reactRoot, queryClient);

      const row = container.querySelector(
        '[data-testid="session-goal-summary-row"]',
      );
      expect(row?.textContent).toContain("1,500");
      expect(
        getWebSessionStore("root-session", "demo").getState().goal,
      ).toEqual(initialGoal);

      const updatedGoal: NonNullable<Session["goal"]> = {
        ...initialGoal,
        usage: {
          tokens: {
            inputTokens: 1_750,
            outputTokens: 1_000,
            totalTokens: 2_750,
            reasoningTokens: 250,
            cachedInputTokens: 500,
          },
          executionTimeMs: 150_000,
          executionCount: 2,
        },
      };
      await act(async () => {
        getWebSessionStore("root-session", "demo")
          .getState()
          .applyRemoteEnvelope({
            type: "event",
            slug: "demo",
            sessionId: "root-session",
            eventId: 1,
            createdAt: 2,
            agentName: "lead",
            payload: {
              type: "session.goal_changed",
              action: "usage_recorded",
              instanceId: updatedGoal.instanceId,
              generation: updatedGoal.generation,
              goal: updatedGoal,
              status: updatedGoal.status,
              occurredAt: 2,
            },
          });
      });

      const updatedRow = container.querySelector(
        '[data-testid="session-goal-summary-row"]',
      );
      expect(updatedRow?.textContent).toContain("2,750");
      expect(updatedRow?.textContent).not.toContain("1,500");
      expect(
        fetchMock.mock.calls.filter(([input]) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          return (
            new URL(url, "http://localhost").pathname ===
            "/api/projects/demo/sessions/root-session"
          );
        }),
      ).toHaveLength(1);
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("opens the Context inspector when an invalidated message requests model details", async () => {
    const dom = installDom();
    dom.window.localStorage.setItem(
      "archcode.workbench.layout",
      JSON.stringify({
        inspectorWidth: 360,
        inspectorCollapsed: true,
      }),
    );
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Model audit",
      messages: [
        {
          id: "message-invalidated",
          role: "user",
          executionId: "execution-1",
          parts: [
            {
              type: "text",
              id: "part-1",
              text: "Use the old model",
              createdAt: 1,
              completedAt: 1,
            },
          ],
          modelAudit: {
            requested: {
              mode: "session_override",
              selection: { model: "test:old" },
            },
            actual: { model: "test:model" },
            reason: "config_invalidated",
          },
          createdAt: 1,
          completedAt: 1,
        },
      ],
    });
    rootSession.executions = [
      {
        id: "execution-1",
        memoryPolicy,
        origin: "user_message",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
        maxSteps: 10,
        executionSkills: [],
        toolAuthorizationSnapshot,
        loadedToolRefs,
        durationMs: 1,
        runs: [],
        terminalSettlement: {
          key: "terminal:execution-1",
          goalInstanceId: null,
        },
      },
    ];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/projects/demo/todos")
        return Response.json({ todos: [] });
      if (path === "/api/projects/demo/sessions/root-session")
        return Response.json(rootSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    const reactRoot = createRoot(container);

    try {
      await queryClient.fetchQuery(sessionQueryOptions("demo", "root-session"));
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter
                  initialEntries={["/projects/demo/sessions/root-session"]}
                >
                  <Routes>
                    <Route
                      path="/projects/:slug/sessions/:sessionId"
                      element={
                        <>
                          <SessionRoute />
                          <LocationProbe />
                          <LayoutProbe />
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

      expect(container.textContent).toContain(
        "Model changed: test:old → test:model",
      );
      expect(
        container.querySelector('[data-testid="inspector-expanded"]')
          ?.textContent,
      ).toBe("false");
      const details = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Details",
      );
      if (!details) throw new Error("Missing model audit Details button");
      await act(async () =>
        details.dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        ),
      );

      expect(
        container.querySelector('[data-testid="location"]')?.textContent,
      ).toBe(
        "/projects/demo/sessions/root-session?message=message-invalidated&inspector=context|PUSH",
      );
      expect(
        container.querySelector('[data-testid="inspector-expanded"]')
          ?.textContent,
      ).toBe("true");
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
          runOrdinal: 0,
          stepId: "root-step",
          outputPhase: "commentary",
          createdAt: 1,
          parts: [
            {
              type: "tool",
              id: "delegate-part",
              state: "completed",
              toolCallId: "delegate-call",
              toolName: TOOL_DELEGATE,
              input: {
                agent_type: "explore",
                title: "Explore child session",
                objective: "Explore child session",
                skills: [],
                background: false,
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
          childExecutionId: "child-execution",
          childAgentName: "explore",
          childProfile: "fast",
          childSkillNames: [],
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
    rootSession.executions = [
      {
        id: "root-execution",
        memoryPolicy,
        origin: "tool_call",
        status: "completed",
        startedAt: 1,
        endedAt: 2,
        durationMs: 1,
        maxSteps: 10,
        executionSkills: [],
        toolAuthorizationSnapshot,
        loadedToolRefs,
        runs: [],
        terminalSettlement: {
          key: "terminal:root-execution",
          goalInstanceId: null,
        },
      },
    ];
    const childSession = createSession({
      id: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
      title: "Child Session",
      agentName: "explore",
      profile: "fast",
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Trace the contract",
        objective: "Inspect the current Session contract.",
        skills: [],
        background: false,
      },
      messages: [
        {
          id: "child-message",
          role: "assistant",
          executionId: "child-execution",
          runOrdinal: 0,
          stepId: "child-step",
          outputPhase: "final_answer",
          createdAt: 2,
          parts: [
            {
              type: "assistant-output",
              id: "child-text",
              blockId: "child-block",
              text: "Child content",
              createdAt: 2,
            },
          ],
        },
      ],
    });
    childSession.executions = [
      {
        id: "child-execution",
        memoryPolicy,
        origin: "goal_continuation",
        status: "completed",
        startedAt: 2,
        endedAt: 3,
        durationMs: 1,
        maxSteps: 10,
        executionSkills: [],
        toolAuthorizationSnapshot,
        loadedToolRefs,
        runs: [],
        terminalSettlement: {
          key: "terminal:child-execution",
          goalInstanceId: null,
        },
      },
    ];
    childSession.todos = [
      {
        id: "child-todo",
        content: "Inspect child output",
        status: "in_progress",
      },
    ];

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const path =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.pathname
            : new URL(input.url).pathname;

      if (path.endsWith("/sessions/root-session"))
        return Response.json(rootSession);
      if (path.endsWith("/sessions/child-session"))
        return Response.json(childSession);
      if (path === "/api/agents") return Response.json({
        agents: [
          { name: "lead", displayName: "Lead" },
          { name: "explore", displayName: "Explore" },
        ],
      });
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    const reactRoot = createRoot(container);

    try {
      await renderSessionRoute(reactRoot, queryClient);

      expect(
        getWebSessionStore("root-session", "demo").getState().focusSessionId,
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="work-summary-work:root-execution:implicit"]'),
      ).not.toBeNull();
      expect(container.textContent).not.toContain("Open child session");
      expect(container.querySelector('[data-testid="hitl-inbox"]')).toBeNull();

      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="work-summary-work:root-execution:implicit"]',
          )
          ?.dispatchEvent(
            new dom.window.MouseEvent("click", { bubbles: true }),
          );
      });

      expect(container.textContent).toContain("Open child session");

      await queryClient.fetchQuery(
        sessionQueryOptions("demo", "child-session"),
      );
      await act(async () => {
        findElementByText(container, "Open child session").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(
        getWebSessionStore("root-session", "demo").getState().focusSessionId,
      ).toBe("child-session");
      expect(container.textContent).toContain("Back to Root Session");
      expect(container.querySelector("[data-focused-child-heading]")?.textContent).toContain("Explore Session");
      expect(container.querySelector("[data-focused-child-heading]")?.textContent).toContain("Child of Lead · Trace the contract");
      expect(container.querySelector("[data-focused-child-heading]")?.textContent).toContain("Read-only · Composer stays with Lead");
      expect(container.querySelector("[data-focused-child-heading]")?.textContent).toContain("Completed");
      expect(container.querySelectorAll("[data-session-context-header]")).toHaveLength(1);
      expect(
        container.querySelector('button[aria-controls~="context-inspector"]'),
      ).not.toBeNull();
      expect(container.querySelector('[data-testid="hitl-inbox"]')).toBeNull();

      await act(async () => {
        findElementByText(container, "Back to Root Session").dispatchEvent(
          new dom.window.MouseEvent("click", { bubbles: true }),
        );
      });

      expect(
        getWebSessionStore("root-session", "demo").getState().focusSessionId,
      ).toBeNull();
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
        questions: [
          {
            header: "Scope",
            question: "Continue?",
            options: [{ label: "Yes", description: "Continue" }],
            custom: true,
          },
        ],
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
      ownerAgentName: "lead",
      ownerSessionTitle: "Root Session",
      createdAt: 1,
      payload: { type: "hitl.request" },
      view,
    };
    hitlStore.getState().applyRealtimeEvent(event);

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path.endsWith("/sessions/root-session"))
        return Response.json(rootSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    const reactRoot = createRoot(container);

    try {
      await renderSessionRoute(reactRoot, queryClient);

      const surface = container.querySelector(
        '[data-testid="session-composer-dock"]',
      );
      const transcriptSurface = container.querySelector(
        '[data-testid="session-transcript-surface"]',
      );
      const viewport = container.querySelector(
        '[data-testid="execution-workstream-viewport"]',
      );
      const scroller = container.querySelector(
        '[data-testid="execution-workstream-scroller"]',
      );
      const rail = container.querySelector(
        '[data-testid="conversation-composer-rail"]',
      );
      const threadColumn = container.querySelector(
        '[data-testid="composer-thread-column"]',
      );
      const attention = container.querySelector(
        '[data-testid="composer-attention-stack"]',
      );
      const decision = container.querySelector(
        '[data-testid="hitl-decision-card"]',
      );
      expect(decision).not.toBeNull();
      expect(transcriptSurface?.contains(viewport)).toBe(true);
      expect(transcriptSurface?.contains(surface)).toBe(true);
      expect(viewport?.contains(scroller)).toBe(true);
      expect(viewport?.contains(surface)).toBe(false);
      expect(surface?.classList.contains("border-0")).toBe(true);
      expect(surface?.classList.contains("bg-transparent")).toBe(true);
      expect(surface?.classList.contains("px-5")).toBe(false);
      expect(rail?.className).toContain("w-full");
      expect(rail?.className).toContain("!max-w-[900px]");
      expect(rail?.className).toContain("!px-3");
      expect(rail?.className).toContain("min-[761px]:!px-[26px]");
      expect(rail?.className).toContain("min-[761px]:pt-[14px]");
      expect(rail?.className).toContain("min-[761px]:pb-4");
      expect(threadColumn?.className).toContain("mx-auto");
      expect(threadColumn?.className).toContain("!max-w-[848px]");
      expect(attention?.firstElementChild?.firstElementChild).toBe(decision);
      expect(container.textContent).toContain("Continue?");
      expect(container.textContent).not.toContain("Need input");
      expect(
        container.querySelector('[data-testid="hitl-owner-link"]'),
      ).toBeNull();
      expect(container.querySelector('input[type="radio"]')).not.toBeNull();
      expect(
        container.querySelector('input[aria-label="Scope custom answer"]'),
      ).not.toBeNull();
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("renders one Todo shell with Work active and returns to its exact Work list", async () => {
    const dom = installDom();
    const container = document.getElementById("root");
    if (!container) throw new Error("Missing test root");

    const rootSession = createSession({
      id: "root-session",
      rootSessionId: "root-session",
      title: "Shape offline mode",
      messages: [],
    });
    rootSession.source = {
      kind: "todo",
      todoId: "todo-offline-mode",
      entry: "discussion",
    };
    const projectTodo: ProjectTodo = {
      id: "todo-offline-mode",
      content: "Add resilient offline mode",
      attachmentIds: [],
      status: "ready",
      revision: 3,
      createdAt: 1,
      updatedAt: 2,
    };

    const fetchMock = mock(async (input: Parameters<typeof fetch>[0]) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/projects/demo/sessions/root-session")
        return Response.json(rootSession);
      if (path === "/api/projects/demo/todos")
        return Response.json({ todos: [projectTodo] });
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    const reactRoot = createRoot(container);

    try {
      await queryClient.fetchQuery(sessionQueryOptions("demo", "root-session"));
      await queryClient.fetchQuery(projectTodosQueryOptions("demo"));
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter
                  initialEntries={["/projects/demo/sessions/root-session"]}
                >
                  <Routes>
                    <Route
                      path="/projects/:slug/sessions/:sessionId"
                      element={<SessionRoute />}
                    />
                    <Route
                      path="/projects/:slug/todos/:todoId/work"
                      element={<LocationProbe />}
                    />
                  </Routes>
                </MemoryRouter>
              </QueryClientProvider>
            </WorkbenchLayoutProvider>
          </SettingsModalProvider>,
        );
      });

      const shell = container.querySelector('[data-selected-todo-shell]');
      expect(shell?.querySelector("h1")?.textContent).toBe("Add resilient offline mode");
      expect(shell?.querySelector('a[aria-current="page"]')?.textContent).toContain("Work");
      expect(container.textContent).toContain("Todo · Discussion");
      expect(container.querySelectorAll("[data-selected-todo-shell]")).toHaveLength(1);

      const back = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.includes("All work"),
      );
      if (!back) throw new Error("Missing All work action");
      await act(async () => {
        back.dispatchEvent(
          new dom.window.MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      expect(
        container.querySelector('[data-testid="location"]')?.textContent,
      ).toBe("/projects/demo/todos/todo-offline-mode/work|PUSH");
    } finally {
      await act(async () => reactRoot.unmount());
      queryClient.clear();
      dom.window.close();
    }
  });

  test("replaces a direct child URL with the canonical root URL focused on that child", async () => {
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
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, "http://localhost").pathname;
      if (path === "/api/projects") return Response.json({ projects: [] });
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/projects/demo/todos")
        return Response.json({ todos: [] });
      if (path === "/api/projects/demo/sessions/child-1")
        return Response.json(childSession);
      if (path === "/api/projects/demo/sessions/root-1")
        return Response.json(rootSession);
      return new Response("Not found", { status: 404 });
    });
    Object.defineProperty(globalThis, "fetch", {
      value: fetchMock,
      configurable: true,
    });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      },
    });
    await Promise.all([
      queryClient.fetchQuery(sessionQueryOptions("demo", "child-1")),
      queryClient.fetchQuery(sessionQueryOptions("demo", "root-1")),
      queryClient.fetchQuery(projectTodosQueryOptions("demo")),
    ]);
    const reactRoot = createRoot(container);

    try {
      await act(async () => {
        reactRoot.render(
          <SettingsModalProvider>
            <WorkbenchLayoutProvider>
              <QueryClientProvider client={queryClient}>
                <MemoryRouter
                  initialEntries={["/projects/demo/sessions/child-1"]}
                >
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

      expect(
        container.querySelector('[data-testid="location"]')?.textContent,
      ).toBe("/projects/demo/sessions/root-1?focus=child-1|REPLACE");
      expect(container.textContent).toContain("Back to Root Session");
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

  test("self-focus has no focused query or retry owner while child focus stays independent", () => {
    const selfFocus = effectiveSessionFocusId("root-1", "root-1");
    expect(selfFocus).toBeNull();
    expect(focusedSessionQueryOptions("demo", selfFocus).enabled).toBe(false);
    expect(hasSessionSnapshotRecoveryOwner("demo", selfFocus)).toBe(false);

    const childFocus = effectiveSessionFocusId("root-1", "child-1");
    expect(childFocus).toBe("child-1");
    expect(focusedSessionQueryOptions("demo", childFocus).enabled).toBe(true);
    expect(hasSessionSnapshotRecoveryOwner("demo", "root-1")).toBe(true);
    expect(hasSessionSnapshotRecoveryOwner("demo", childFocus)).toBe(true);
    expect(new Set(["root-1", childFocus])).toEqual(new Set(["root-1", "child-1"]));
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
      executionCount: 0,
      isRunning: false,
      isStreamingModel: false,
      currentExecutionId: undefined,
      currentAssistantMessageId: undefined,
      messages: [
        {
          id: "m1",
          role: "assistant" as const,
          executionId: "child-execution",
          runOrdinal: 0,
          stepId: "child-step",
          outputPhase: "final_answer" as const,
          parts: [
            {
              type: "assistant-output" as const,
              id: "p1",
              blockId: "child-block",
              text: "child response",
              createdAt: Date.now(),
            },
          ],
          createdAt: Date.now(),
        },
      ],
      steps: [],
      todos: [],
      reminders: [],
      title: "Child Session",
      rootSessionId,
      parentSessionId: rootSessionId,
      eventCursor: 3,
    };
    applySnapshot(childStore, snapshot);

    const state = childStore.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.title).toBe("Child Session");
    expect(state.rootSessionId).toBe(rootSessionId);
    expect(state.parentSessionId).toBe(rootSessionId);
  });
});
