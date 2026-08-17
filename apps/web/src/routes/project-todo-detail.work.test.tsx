import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { HitlView } from "@archcode/protocol";
import type { ProjectSessionInventoryItem, ProjectTodo } from "../api/types";
import { hitlStore } from "../store/hitl-store";

mock.module("../components/primitives/MarkdownContent", () => ({
  MarkdownContent: ({ children }: { children: ReactNode }) => <pre>{children}</pre>,
}));

const bootstrapDom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
installDom(bootstrapDom);
const {
  ProjectTodoDetailRoute,
  createTodoWorkNavigationState,
  readTodoWorkReturnState,
} = await import("./project-todo-detail");
bootstrapDom.window.close();

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let requests: Array<{ method: string; path: string; body?: unknown }>;
let sessionInventoryResponse: Promise<Response> | undefined;

const currentTodo: ProjectTodo = {
  id: "todo-1",
  content: "# Model profile defaults per project\n\nKeep project profile overrides strict.",
  attachmentIds: [],
  status: "in_progress",
  revision: 3,
  createdAt: 1,
  updatedAt: 4,
};

let inventory: ProjectSessionInventoryItem[];

function defaultInventory(): ProjectSessionInventoryItem[] {
  return [
    workItem("work-1", "Implementation", { kind: "todo", todoId: "todo-1", entry: "work" }, "running", 10),
    workItem("discussion-1", "Plan review", { kind: "todo", todoId: "todo-1", entry: "discussion" }, "completed", 9),
    workItem("automation-1", "Profile sweep", { kind: "automation", automationId: "auto-1", invocationId: "inv-1", todoId: "todo-1" }, "completed", 8),
  ];
}

function workItem(
  sessionId: string,
  title: string,
  source: ProjectSessionInventoryItem["session"]["source"],
  status: "running" | "completed",
  updatedAt: number,
): ProjectSessionInventoryItem {
  return {
    session: {
      sessionId,
      rootSessionId: sessionId,
      cwd: `/workspace/${sessionId}`,
      agentName: source.kind === "todo" && source.entry === "discussion" ? "discussion" : "lead",
      profile: "principal",
      activeSkillNames: [],
      modelSelection: { revision: 0 },
      title,
      source,
      createdAt: 1,
      updatedAt,
    },
    latestExecution: {
      id: `${sessionId}-execution`,
      status,
      startedAt: 2,
      ...(status === "completed" ? { endedAt: updatedAt } : {}),
    },
  };
}

function hitlView(
  hitlId: string,
  ownerSessionId: string,
  title: string,
  source: "tool_permission" | "ask_user",
): HitlView {
  return {
    hitlId,
    owner: { type: "session", id: ownerSessionId },
    source: source === "tool_permission"
      ? { type: "tool_permission", toolCallId: `call-${hitlId}`, toolName: "Bash" }
      : { type: "ask_user", toolCallId: `call-${hitlId}` },
    status: "pending",
    displayPayload: { title, redacted: true },
    allowedActions: source === "tool_permission" ? ["approve", "deny", "cancel"] : ["answer", "cancel"],
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
  };
}

function installDom(target: JSDOM): void {
  Object.assign(globalThis, {
    window: target.window,
    document: target.window.document,
    navigator: target.window.navigator,
    HTMLElement: target.window.HTMLElement,
    HTMLButtonElement: target.window.HTMLButtonElement,
    HTMLInputElement: target.window.HTMLInputElement,
    HTMLTextAreaElement: target.window.HTMLTextAreaElement,
    Element: target.window.Element,
    Node: target.window.Node,
    NodeFilter: target.window.NodeFilter,
    DocumentFragment: target.window.DocumentFragment,
    Event: target.window.Event,
    MouseEvent: target.window.MouseEvent,
    MutationObserver: target.window.MutationObserver,
    getComputedStyle: target.window.getComputedStyle.bind(target.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(target.window.HTMLElement.prototype, "attachEvent", { configurable: true, value() {} });
  Object.defineProperty(target.window.HTMLElement.prototype, "detachEvent", { configurable: true, value() {} });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos/todo-1/work" });
  installDom(dom);
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  requests = [];
  inventory = defaultInventory();
  sessionInventoryResponse = undefined;
  hitlStore.getState().reset();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (path === "/api/projects/demo/todos") return Response.json({ todos: [currentTodo] });
    if (path === "/api/projects/demo/sessions" && method === "GET") return sessionInventoryResponse ?? Response.json({ sessions: inventory });
    if (path.endsWith("/attachments")) return Response.json({ todoRevision: 3, attachments: [] });
    if (path.endsWith("/plan")) return Response.json({ plan: null });
    if (path.endsWith("/sessions") && method === "POST") return Response.json({ todo: currentTodo, sessionId: "created-session" });
    return Response.json({ error: { code: "NOT_FOUND", message: "not found" } }, { status: 404 });
  }) });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  hitlStore.getState().reset();
  dom.window.close();
});

function SessionDestination() {
  const location = useLocation();
  return <div data-testid="session-destination">{location.pathname}{location.search}|{JSON.stringify(location.state)}</div>;
}

async function mountRoute(initialEntry: string): Promise<void> {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/projects/:slug/todos/:todoId" element={<ProjectTodoDetailRoute />} />
          <Route path="/projects/:slug/todos/:todoId/work" element={<ProjectTodoDetailRoute />} />
          <Route path="/projects/:slug/sessions/:sessionId" element={<SessionDestination />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  ));
  await waitFor(() => document.querySelector("[data-selected-todo-shell]") !== null);
}

async function renderRoute(initialEntry: string): Promise<void> {
  await mountRoute(initialEntry);
  await waitFor(() => client.isFetching() === 0);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  throw new Error("Timed out waiting for selected Todo route");
}

describe("selected Todo and Work routes", () => {
  test("uses one compact selected-Todo shell for the canonical Todo document", async () => {
    await renderRoute("/projects/demo/todos/todo-1");
    await waitFor(() => document.querySelector("#todo-content-heading") !== null);

    expect(document.querySelectorAll("[data-selected-todo-shell]")).toHaveLength(1);
    expect(document.querySelector("[data-selected-todo-shell] h1")?.textContent).toBe("Model profile defaults per project");
    expect(document.querySelector('nav[aria-label="Todo sections"] a[aria-current="page"]')?.textContent).toBe("Todo");
    expect(document.querySelector("#todo-content-heading")?.textContent).toBe("Todo content");
  });

  test("starts a bound Discussion directly from the Todo document", async () => {
    await renderRoute("/projects/demo/todos/todo-1");
    const discuss = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Discuss")!;
    await act(async () => discuss.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);

    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/projects/demo/todos/todo-1/sessions",
      body: { expectedRevision: 3, entry: "discussion" },
    });
    expect(document.querySelector('[data-testid="session-destination"]')?.textContent).toContain("/projects/demo/sessions/created-session");
  });

  test("keeps the navigator Todo-only and expands every Worker request on the Todo Work page", async () => {
    inventory[0] = {
      ...inventory[0]!,
      session: {
        ...inventory[0]!.session,
        goal: {
          instanceId: "goal-1",
          status: "blocked",
        } as NonNullable<ProjectSessionInventoryItem["session"]["goal"]>,
      },
    };
    const first = hitlView("permission-1", "child-build", "Run protected command", "tool_permission");
    const second = hitlView("question-1", "child-analyst", "Choose the migration boundary", "ask_user");
    second.createdAt = "2026-08-17T00:01:00.000Z";
    hitlStore.getState().applySnapshot({
      type: "hitl.snapshot",
      projectSlugs: ["demo"],
      entries: [
        {
          projectSlug: "demo",
          hitlId: first.hitlId,
          ownerSessionId: "child-build",
          rootSessionId: "work-1",
          ownerAgentName: "build",
          ownerSessionTitle: "Implement strict migration",
          view: first,
        },
        {
          projectSlug: "demo",
          hitlId: second.hitlId,
          ownerSessionId: "child-analyst",
          rootSessionId: "work-1",
          ownerAgentName: "analyst",
          ownerSessionTitle: "Review migration boundary",
          view: second,
        },
      ],
      createdAt: 1,
    });

    await renderRoute("/projects/demo/todos/todo-1/work");

    expect(document.querySelector("#todo-work-needs-you-heading")?.parentElement?.textContent).toContain("3");
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('section[aria-labelledby="todo-work-needs-you-heading"] a'));
    expect(links).toHaveLength(3);
    expect(links.map((link) => link.querySelector("strong")?.textContent)).toEqual([
      "Run protected command",
      "Choose the migration boundary",
      "Goal is blocked",
    ]);
    expect(links.map((link) => link.querySelector("small")?.textContent)).toEqual([
      "Build · Implement strict migration",
      "Analyst · Review migration boundary",
      "Lead · Implementation",
    ]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/projects/demo/sessions/work-1?hitl=permission-1&focus=child-build",
      "/projects/demo/sessions/work-1?hitl=question-1&focus=child-analyst",
      "/projects/demo/sessions/work-1",
    ]);

    await act(async () => links[1]!.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);
    expect(document.querySelector('[data-testid="session-destination"]')?.textContent).toContain(
      "/projects/demo/sessions/work-1?hitl=question-1&focus=child-analyst",
    );
  });

  test("continues the latest bound Work directly from the Todo document", async () => {
    await renderRoute("/projects/demo/todos/todo-1");
    const continueWork = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Continue Work")!;
    await act(async () => continueWork.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);

    expect(document.querySelector('[data-testid="session-destination"]')?.textContent).toContain("/projects/demo/sessions/work-1");
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/sessions"))).toBe(false);
  });

  test("starts bound Work directly when the Todo has no Work Session", async () => {
    inventory = inventory.filter(({ session }) => !(session.source.kind === "todo" && session.source.entry === "work"));
    await renderRoute("/projects/demo/todos/todo-1");
    const startWork = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Start Work")!;
    await act(async () => startWork.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);

    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/projects/demo/todos/todo-1/sessions",
      body: { expectedRevision: 3, entry: "work" },
    });
    expect(document.querySelector('[data-testid="session-destination"]')?.textContent).toContain("/projects/demo/sessions/created-session");
  });

  test("waits for authoritative linked Work before enabling the Todo primary", async () => {
    let resolveInventory!: (response: Response) => void;
    sessionInventoryResponse = new Promise<Response>((resolve) => { resolveInventory = resolve; });
    await mountRoute("/projects/demo/todos/todo-1");

    const loading = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Loading work…")!;
    expect(loading.disabled).toBe(true);
    await act(async () => loading.click());
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/sessions"))).toBe(false);

    resolveInventory(Response.json({ sessions: inventory }));
    await waitFor(() => client.isFetching() === 0);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const continueWork = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Continue Work")!;
    expect(continueWork.disabled).toBe(false);
    await act(async () => continueWork.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);
    expect(document.querySelector('[data-testid="session-destination"]')?.textContent).toContain("/projects/demo/sessions/work-1");
  });

  test("keeps Work unavailable after linked Work inventory failure", async () => {
    sessionInventoryResponse = Promise.resolve(Response.json({ error: { code: "INTERNAL_ERROR", message: "inventory unavailable" } }, { status: 500 }));
    await renderRoute("/projects/demo/todos/todo-1");

    const unavailable = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Work unavailable")!;
    expect(unavailable.disabled).toBe(true);
    await act(async () => unavailable.click());
    expect(requests.some((request) => request.method === "POST" && request.path.endsWith("/sessions"))).toBe(false);
  });

  test("renders and filters every linked root family on the Work destination", async () => {
    await renderRoute("/projects/demo/todos/todo-1/work");
    await waitFor(() => document.querySelector("#active-todo-work") !== null);

    expect(document.querySelectorAll("[data-selected-todo-shell]")).toHaveLength(1);
    expect(document.querySelector('nav[aria-label="Todo sections"] a[aria-current="page"]')?.textContent).toBe("Work3");
    expect(document.body.textContent).toContain("Implementation");
    expect(document.body.textContent).toContain("Plan review");
    expect(document.body.textContent).toContain("Profile sweep");

    const automationFilter = [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Work type filter"] button')].find((button) => button.textContent === "Automations")!;
    await act(async () => automationFilter.click());
    expect(document.body.textContent).not.toContain("Implementation");
    expect(document.body.textContent).not.toContain("Plan review");
    expect(document.body.textContent).toContain("Profile sweep");
  });

  test("opens the canonical Session URL with route-local Work restoration state", async () => {
    await renderRoute("/projects/demo/todos/todo-1/work");
    await waitFor(() => document.querySelector("#active-todo-work") !== null);
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="Filter work"]')!;
    await act(async () => { filter.value = "implement"; filter.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    const row = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.getAttribute("aria-label")?.startsWith("Implementation,"))!;
    await act(async () => row.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);

    const destination = document.querySelector('[data-testid="session-destination"]')!.textContent ?? "";
    expect(destination).toContain("/projects/demo/sessions/work-1");
    expect(destination).toContain('"fromTodoWork":true');
    expect(destination).toContain('"todoId":"todo-1"');
  });

  test("starts Work through the existing Todo-to-Session mutation", async () => {
    await renderRoute("/projects/demo/todos/todo-1/work");
    const startWork = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "New work session")!;
    await act(async () => startWork.click());
    await waitFor(() => document.querySelector('[data-testid="session-destination"]') !== null);

    expect(requests).toContainEqual({
      method: "POST",
      path: "/api/projects/demo/todos/todo-1/sessions",
      body: { expectedRevision: 3, entry: "work" },
    });
    expect(document.querySelector('[data-testid="session-destination"]')?.textContent).toContain("/projects/demo/sessions/created-session");
  });

  test("keeps Work restoration state scoped to the exact Todo", () => {
    const state = createTodoWorkNavigationState({ todoId: "todo-1", filter: "plan", kind: "discussion", scrollTop: 18 });
    expect(readTodoWorkReturnState(state, "todo-1")).toEqual({ todoId: "todo-1", filter: "plan", kind: "discussion", scrollTop: 18 });
    expect(readTodoWorkReturnState(state, "todo-2")).toBeUndefined();
    expect(readTodoWorkReturnState({ todoWork: state.todoWork }, "todo-1")).toBeUndefined();
  });
});
