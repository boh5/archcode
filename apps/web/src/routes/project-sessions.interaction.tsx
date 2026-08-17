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
const [{ ProjectSessionsRoute }, { SessionComposerDock }] = await Promise.all([
  import("./project-sessions"),
  import("../components/features/SessionComposerDock"),
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

describe("ProjectSessionsRoute direct creation", () => {
  test("renders the prototype-native Session source selector and updates its canonical value", async () => {
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

    const select = document.querySelector('[data-testid="session-source-picker"] select');
    if (!(select instanceof dom.window.HTMLSelectElement)) throw new Error("Missing native Session source selector");
    expect(select.getAttribute("aria-label")).toBe("Session source");
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["all", "All sources"],
      ["todo", "Todo"],
      ["automation", "Automation"],
      ["direct", "Direct"],
    ]);

    await act(async () => {
      select.value = "direct";
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    });
    await waitFor(() => select.value === "direct");
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
