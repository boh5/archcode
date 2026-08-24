import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes, useLocation, useParams } from "react-router-dom";
import { SettingsModalProvider } from "../context/settings-modal";
import { hitlStore } from "../store/hitl-store";
import { sessionRuntimeStore } from "../store/session-runtime-store";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
  currentSessionSnapshotGeneration,
} from "../store/session-store";
import { queryKeys } from "../api/queries";
import type { ProjectAutomationInventoryItem, ProjectSessionInventoryItem } from "../api/types";
import {
  sessionAuthoritativeSnapshot,
  type SessionAuthoritativeSnapshotFixture,
} from "../test-support/session-authoritative-snapshot";

const globals = [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(target: JSDOM): void {
  for (const name of globals) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  for (const [name, value] of Object.entries({
    window: target.window,
    document: target.window.document,
    navigator: target.window.navigator,
    Node: target.window.Node,
    Element: target.window.Element,
    HTMLElement: target.window.HTMLElement,
    HTMLButtonElement: target.window.HTMLButtonElement,
    HTMLInputElement: target.window.HTMLInputElement,
    HTMLSelectElement: target.window.HTMLSelectElement,
    HTMLTextAreaElement: target.window.HTMLTextAreaElement,
    DocumentFragment: target.window.DocumentFragment,
    Event: target.window.Event,
    CustomEvent: target.window.CustomEvent,
    KeyboardEvent: target.window.KeyboardEvent,
    MouseEvent: target.window.MouseEvent,
    MutationObserver: target.window.MutationObserver,
    getComputedStyle: target.window.getComputedStyle.bind(target.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(target.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(target.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
  Object.defineProperty(target.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
}

function restoreGlobals(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

const bootstrapDom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
installDom(bootstrapDom);
const [{ ProjectSessionsRoute }, { SessionComposerDock }, { AutomationsRoute }] = await Promise.all([
  import("./project-sessions"),
  import("../components/features/SessionComposerDock"),
  import("./automations"),
]);
restoreGlobals();
bootstrapDom.window.close();

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
const modelRuntime = {
  revision: "m1",
  providers: [{
    id: "test",
    displayName: "Test",
    models: [{ id: "model", qualifiedId: "test:model", displayName: "Test Model", variants: [] }],
  }],
  profileDefaults: {
    principal: { model: "test:model" },
    deep: { model: "test:model" },
    fast: { model: "test:model" },
  },
};

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let requests: Array<{ method: string; path: string; body?: string }>;

function applySnapshot(
  store: ReturnType<typeof createWebSessionStore>,
  snapshot: SessionAuthoritativeSnapshotFixture,
): void {
  store.getState().applyAuthoritativeSnapshot(
    sessionAuthoritativeSnapshot(store.getState().sessionId, snapshot),
    currentSessionSnapshotGeneration(),
  );
}

function DirectSessionDestination() {
  const location = useLocation();
  const { slug = "", sessionId = "" } = useParams<{ slug: string; sessionId: string }>();
  const focusComposer = location.state?.focusComposer === true;
  return (
    <div data-testid="session-destination">
      <output data-testid="session-location">{location.pathname}|focusComposer={String(focusComposer)}</output>
      <SessionComposerDock slug={slug} sessionId={sessionId} focusComposer={focusComposer} />
    </div>
  );
}

function RouteLocation() {
  const location = useLocation();
  return <output data-testid="route-location">{location.pathname}</output>;
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for the Sessions interaction state");
}

beforeEach(() => {
  notifyManager.setScheduler((callback) => callback());
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/projects/demo/sessions",
  });
  installDom(dom);
  requests = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({ method, path: url.pathname, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (method === "POST" && url.pathname === "/api/projects/demo/sessions") {
        return Response.json({ sessionId: "direct-new" });
      }
      if (url.pathname === "/api/projects/demo/sessions") return Response.json({ sessions: [] });
      if (url.pathname === "/api/projects/demo/todos") return Response.json({ todos: [] });
      if (url.pathname === "/api/projects/demo/automations") return Response.json({ automations: [] });
      if (url.pathname === "/api/config/model-runtime") return Response.json(modelRuntime);
      return new Response("not found", { status: 404 });
    }),
  });
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  hitlStore.getState().reset();

  const store = createWebSessionStore("direct-new", "demo");
  applySnapshot(store, {
    rootSessionId: "direct-new",
    eventCursor: -1,
    agentName: "lead",
    modelSelection: { revision: 0 },
    nextModelSelection: { requested: requestedModelSelection, resolved: binding },
    pendingMessages: [],
  });
  sessionRuntimeStore.getState().applySnapshot({
    type: "session.runtime.snapshot",
    projectSlugs: ["demo"],
    families: [{ projectSlug: "demo", rootSessionId: "direct-new", activity: "idle" }],
    createdAt: 1,
  });
  hitlStore.getState().applySnapshot({
    type: "hitl.snapshot",
    projectSlugs: ["demo"],
    entries: [],
    createdAt: 1,
  });

  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(queryKeys.modelRuntime, modelRuntime);
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  await act(async () => root.unmount());
  client.clear();
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  hitlStore.getState().reset();
  dom.window.close();
  restoreGlobals();
});

describe("Runs and Schedules interactions", () => {
  test("keeps a dependency-waiting Session label visible in every row layout", async () => {
    const item = {
      session: {
        sessionId: "waiting-session",
        title: "Dependency wait",
        agentName: "lead",
        source: { kind: "direct" },
        updatedAt: 2,
      },
      latestExecution: { id: "waiting-execution", status: "suspended", startedAt: 1 },
    } as ProjectSessionInventoryItem;
    client.setQueryData(queryKeys.sessions("demo"), [item]);
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "waiting-session", activity: "waiting_for_human" }],
      createdAt: 2,
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <MemoryRouter initialEntries={["/projects/demo/sessions"]}>
              <Routes>
                <Route path="/projects/:slug/sessions" element={<ProjectSessionsRoute />} />
              </Routes>
            </MemoryRouter>
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => document.querySelector('[aria-labelledby="sessions-running"]')?.textContent?.includes("Dependency wait") === true);
    const row = document.querySelector('a[aria-label^="Dependency wait,"]');
    const waitingLabel = row?.querySelector('[title="Waiting · Waiting for dependency"]');
    expect(row?.textContent).toContain("Waiting");
    expect(waitingLabel).toBeInstanceOf(dom.window.HTMLElement);
    expect(waitingLabel?.parentElement?.classList.contains("flex")).toBe(true);
    expect(waitingLabel?.parentElement?.classList.contains("hidden")).toBe(false);
    expect(row?.querySelector(".font-mono")).toBeNull();
  });

  test("waits for authoritative runtime and HITL snapshots before classifying Sessions", async () => {
    const item = {
      session: {
        sessionId: "live-session",
        title: "Live Session",
        agentName: "lead",
        source: { kind: "direct" },
        updatedAt: 2,
      },
      latestExecution: { id: "completed-execution", status: "completed", startedAt: 1, endedAt: 2 },
    } as ProjectSessionInventoryItem;
    client.setQueryData(queryKeys.sessions("demo"), [item]);
    sessionRuntimeStore.getState().reset();
    hitlStore.getState().reset();

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <MemoryRouter initialEntries={["/projects/demo/sessions"]}>
              <Routes>
                <Route path="/projects/:slug/sessions" element={<ProjectSessionsRoute />} />
              </Routes>
            </MemoryRouter>
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => document.body.textContent?.includes("Loading Session state…") === true);
    expect(document.querySelector("h1")?.textContent).toContain("— active");

    await act(async () => {
      sessionRuntimeStore.getState().applySnapshot({
        type: "session.runtime.snapshot",
        projectSlugs: ["demo"],
        families: [{ projectSlug: "demo", rootSessionId: "live-session", activity: "running" }],
        createdAt: 2,
      });
      hitlStore.getState().applySnapshot({
        type: "hitl.snapshot",
        projectSlugs: ["demo"],
        entries: [],
        createdAt: 2,
      });
    });
    await waitFor(() => document.querySelector('[aria-labelledby="sessions-running"]')?.textContent?.includes("Live Session") === true);
    expect(document.querySelector("h1")?.textContent).toContain("1 active");
  });

  test("defers the desktop Automation selection until every state projection is authoritative", async () => {
    const item = {
      automation: {
        id: "automation-ready",
        projectSlug: "demo",
        origin: { kind: "direct" },
        name: "Ready Automation",
        trigger: { kind: "interval", everyMs: 60_000 },
        action: { kind: "start_session", message: "Check the project.", location: "project" },
        status: "active",
        createdAt: "2026-08-24T00:00:00.000Z",
        updatedAt: "2026-08-24T00:00:00.000Z",
        nextFireAt: "2026-08-24T01:00:00.000Z",
      },
      latestInvocation: null,
    } as ProjectAutomationInventoryItem;
    client.setQueryData(queryKeys.projectAutomations("demo"), [item]);
    client.setQueryData(queryKeys.sessions("demo"), []);
    client.setQueryData(queryKeys.projectTodos("demo"), []);
    sessionRuntimeStore.getState().reset();
    hitlStore.getState().reset();
    Object.defineProperty(dom.window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: true,
        media: "(min-width: 841px)",
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => true,
      } as MediaQueryList),
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <MemoryRouter initialEntries={["/projects/demo/automations"]}>
              <Routes>
                <Route path="/projects/:slug/automations" element={<><AutomationsRoute /><RouteLocation /></>} />
                <Route path="/projects/:slug/automations/:automationId" element={<><AutomationsRoute detail={<div>Selected Automation</div>} /><RouteLocation /></>} />
              </Routes>
            </MemoryRouter>
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => document.body.textContent?.includes("Loading Automation state…") === true);
    expect(document.querySelector('[data-testid="route-location"]')?.textContent).toBe("/projects/demo/automations");

    await act(async () => {
      sessionRuntimeStore.getState().applySnapshot({
        type: "session.runtime.snapshot",
        projectSlugs: ["demo"],
        families: [],
        createdAt: 2,
      });
      hitlStore.getState().applySnapshot({
        type: "hitl.snapshot",
        projectSlugs: ["demo"],
        entries: [],
        createdAt: 2,
      });
    });
    await waitFor(() => document.querySelector('[data-testid="route-location"]')?.textContent === "/projects/demo/automations/automation-ready");
    expect(document.body.textContent).toContain("Ready Automation");
  });

  test("operates the Session source listbox with roving focus and predictable departure", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <MemoryRouter initialEntries={["/projects/demo/sessions"]}>
              <Routes>
                <Route path="/projects/:slug/sessions" element={<ProjectSessionsRoute />} />
              </Routes>
            </MemoryRouter>
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => document.querySelector('[data-testid="session-source-picker"]') !== null);

    const picker = document.querySelector('[data-testid="session-source-picker"]');
    const trigger = picker?.querySelector("button");
    if (!(trigger instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Session source trigger");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Session source: All sources");

    await act(async () => trigger.click());
    await waitFor(() => trigger.getAttribute("aria-expanded") === "true");
    const listbox = document.querySelector('[role="listbox"][aria-label="Session source"]');
    const options = [...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    expect(options.map((option) => [option.textContent?.trim(), option.getAttribute("aria-selected")])).toEqual([
      ["All sources", "true"],
      ["Todo", "false"],
      ["Automation", "false"],
      ["Direct", "false"],
    ]);
    await waitFor(() => document.activeElement === options[0]);

    await act(async () => {
      options[0]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(document.activeElement).toBe(options[3]);
    await act(async () => {
      options[3]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => trigger.getAttribute("aria-label") === "Session source: Direct");
    await waitFor(() => document.activeElement === trigger);

    await act(async () => {
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    });
    await waitFor(() => trigger.getAttribute("aria-expanded") === "true");
    const reopenedOptions = [...document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')];
    await waitFor(() => document.activeElement === reopenedOptions[3]);
    await act(async () => {
      reopenedOptions[3]?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => trigger.getAttribute("aria-expanded") === "false" && document.activeElement === trigger);

    await act(async () => trigger.click());
    await waitFor(() => document.querySelector('[role="listbox"]') !== null);
    const tabOption = document.activeElement;
    await act(async () => {
      tabOption?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    const newSession = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("New Session"));
    if (!(newSession instanceof dom.window.HTMLButtonElement)) throw new Error("Missing New Session button");
    expect(document.activeElement).toBe(newSession);

    await act(async () => {
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await waitFor(() => document.querySelector('[role="listbox"]') !== null);
    await act(async () => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Filter Sessions");

    await act(async () => trigger.click());
    await waitFor(() => document.querySelector('[role="listbox"]') !== null);
    await act(async () => {
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    });
    await waitFor(() => trigger.getAttribute("aria-expanded") === "false");
  });

  test("reverse Tab follows the visible filter controls before leaving Sources", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <MemoryRouter initialEntries={["/projects/demo/sessions?q=test"]}>
              <Routes>
                <Route path="/projects/:slug/sessions" element={<ProjectSessionsRoute />} />
              </Routes>
            </MemoryRouter>
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => document.querySelector('[aria-label="Clear Session filter"]') !== null);

    const trigger = document.querySelector<HTMLButtonElement>('[data-testid="session-source-picker"] > button');
    const clear = document.querySelector<HTMLButtonElement>('[aria-label="Clear Session filter"]');
    if (!trigger || !clear) throw new Error("Missing Sources or Clear control");

    await act(async () => {
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await waitFor(() => document.querySelector('[role="listbox"]') !== null);
    await act(async () => {
      document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    });
    expect(document.activeElement).toBe(clear);
  });

  test("creates one direct root, navigates exactly, and focuses the ready composer", async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <SettingsModalProvider>
            <MemoryRouter initialEntries={["/projects/demo/sessions"]}>
              <Routes>
                <Route path="/projects/:slug/sessions" element={<ProjectSessionsRoute />} />
                <Route path="/projects/:slug/sessions/:sessionId" element={<DirectSessionDestination />} />
              </Routes>
            </MemoryRouter>
          </SettingsModalProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => Array.from(document.querySelectorAll("button")).some((button) => button.textContent?.includes("New Session")));
    const newSession = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("New Session"));
    if (!(newSession instanceof dom.window.HTMLButtonElement)) throw new Error("Missing New Session action");

    await act(async () => newSession.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);
    await waitFor(() => document.activeElement?.getAttribute("aria-label") === "Message");

    const createRequests = requests.filter((request) => request.method === "POST" && request.path === "/api/projects/demo/sessions");
    expect(createRequests).toEqual([{ method: "POST", path: "/api/projects/demo/sessions" }]);
    expect(document.querySelector('[data-testid="session-location"]')?.textContent).toBe(
      "/projects/demo/sessions/direct-new|focusComposer=true",
    );
    const composer = document.querySelector('textarea[aria-label="Message"]');
    expect(composer).toBeInstanceOf(dom.window.HTMLTextAreaElement);
    expect(document.activeElement).toBe(composer);
  });
});
