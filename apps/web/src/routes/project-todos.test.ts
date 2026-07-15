import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Automation, GoalState, ProjectTodo, SessionSummary } from "../api/types";
import { queryKeys } from "../api/queries";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { JSDOM } from "jsdom";
import { sessionRuntimeStore } from "../store/session-runtime-store";
import { deriveProjectTodoGroups, ProjectTodosRoute } from "./project-todos";

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

interface RequestRecord {
  path: string;
  method: string;
  body?: Record<string, unknown>;
}

interface RouteFixture {
  container: HTMLElement;
  dom: JSDOM;
  queryClient: QueryClient;
  reactRoot: Root;
  requests: RequestRecord[];
}

let originalGlobalDescriptors: Map<DomGlobalName, PropertyDescriptor | undefined> | undefined;

function todo(overrides: Partial<ProjectTodo> = {}): ProjectTodo {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "Todo",
    body: "",
    status: "idea",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function session(sessionId: string): SessionSummary {
  return {
    sessionId,
    cwd: "/workspace/demo",
    rootSessionId: sessionId,
    agentName: "engineer",
    modelInfo: null,
    title: "Session",
    createdAt: 1,
    updatedAt: 1,
  };
}

function goal(id: string, status: GoalState["status"]): GoalState {
  return {
    id,
    projectSlug: "demo",
    createdFromSessionId: "source",
    title: "Goal",
    objective: "Objective",
    acceptanceCriteria: "Acceptance",
    useWorktree: false,
    status,
    attempt: 1,
    reviewGeneration: 0,
    appliedBudgetHitlIds: [],
    mainSessionId: "goal-main",
    childSessionIds: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z",
  };
}

function automation(id: string, status: Automation["status"]): Automation {
  return {
    id,
    projectSlug: "demo",
    createdFromSessionId: "source",
    name: "Automation",
    trigger: { kind: "interval", everyMs: 60_000 },
    action: { kind: "start_session", message: "Run", location: "project" },
    status,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function saveGlobalDescriptors(): void {
  if (originalGlobalDescriptors) return;
  originalGlobalDescriptors = new Map(
    DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
}

function restoreGlobals(): void {
  if (!originalGlobalDescriptors) return;
  for (const [name, descriptor] of originalGlobalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originalGlobalDescriptors = undefined;
}

function installDom(): JSDOM {
  saveGlobalDescriptors();
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/projects/demo/todos",
  });
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "MouseEvent", { value: dom.window.MouseEvent, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "attachEvent", { value: () => {}, configurable: true });
  Object.defineProperty(dom.window.HTMLElement.prototype, "detachEvent", { value: () => {}, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    configurable: true,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { value: clearTimeout, configurable: true });
  return dom;
}

async function waitFor(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
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

function requestPath(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.pathname + input.search;
  const url = new URL(input.url);
  return url.pathname + url.search;
}

async function setupRoute(input: {
  todos: ProjectTodo[];
  sessions?: SessionSummary[];
  goals?: GoalState[];
  automations?: Automation[];
  initialEntry?: string;
  todosResponse?: () => ProjectTodo[];
  mutationResponse?: (request: RequestRecord) => Response | Promise<Response>;
}): Promise<RouteFixture> {
  const dom = installDom();
  const container = document.getElementById("root");
  if (!container) throw new Error("Missing test root");
  const requests: RequestRecord[] = [];

  const fetchMock = mock(async (fetchInput: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = requestPath(fetchInput);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    const request = { path, method, body };
    requests.push(request);

    if (method !== "GET") {
      if (input.mutationResponse) return input.mutationResponse(request);
      const selected = input.todos.find((item) => path.includes(item.id)) ?? input.todos[0];
      return Response.json({ todo: selected, sessionId: "destination-session" });
    }
    if (path === "/api/projects/demo/todos") return Response.json({ todos: input.todosResponse?.() ?? input.todos });
    if (path === "/api/projects/demo/sessions") return Response.json({ sessions: input.sessions ?? [] });
    if (path === "/api/projects/demo/goals") return Response.json({ goals: input.goals ?? [] });
    if (path === "/api/projects/demo/automations") return Response.json({ automations: input.automations ?? [] });
    return new Response("Not found", { status: 404 });
  });
  Object.defineProperty(globalThis, "fetch", { value: fetchMock, configurable: true });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const reactRoot = createRoot(container);

  await act(async () => {
    reactRoot.render(
      createElement(QueryClientProvider, { client: queryClient },
        createElement(MemoryRouter, { initialEntries: [input.initialEntry ?? "/projects/demo/todos"] },
          createElement(Routes, null,
            createElement(Route, { path: "/projects/:slug/todos", element: createElement(ProjectTodosRoute) }),
            createElement(Route, { path: "/projects/:slug/sessions/:sessionId", element: createElement("div", { "data-testid": "session-destination" }, "Session destination") }),
          ),
        ),
      ),
    );
  });

  await waitFor(() => {
    expect(container.textContent).toContain("Board");
    if (input.todos[0]) expect(container.querySelector(`[data-testid="todo-${input.todos[0].id}"]`)).not.toBeNull();
  });
  return { container, dom, queryClient, reactRoot, requests };
}

async function cleanupRoute(fixture: RouteFixture): Promise<void> {
  await waitFor(() => {
    expect(fixture.queryClient.isFetching()).toBe(0);
    expect(fixture.queryClient.isMutating()).toBe(0);
  });
  await act(async () => fixture.reactRoot.unmount());
  fixture.queryClient.clear();
  fixture.dom.window.close();
}

function card(container: Element, id: string): HTMLElement {
  const result = container.querySelector(`[data-testid="todo-${id}"]`);
  if (!(result instanceof HTMLElement)) throw new Error(`Missing Todo card ${id}`);
  return result;
}

function button(container: Element, label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!result) throw new Error(`Missing button ${label}`);
  return result;
}

async function click(dom: JSDOM, element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
}

async function expand(fixture: RouteFixture, id: string): Promise<HTMLElement> {
  const result = card(fixture.container, id);
  const trigger = result.querySelector("button");
  if (!trigger) throw new Error(`Missing card trigger ${id}`);
  if (trigger.getAttribute("aria-expanded") !== "true") await click(fixture.dom, trigger);
  return card(fixture.container, id);
}

async function setControlValue(dom: JSDOM, control: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = control.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) throw new Error("Missing native value setter");
  await act(async () => {
    const previous = control.value;
    setter.call(control, value);
    (control as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(control).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (control as unknown as Record<string, { onChange?: (event: { target: typeof control }) => void }>)[propsKey]
      : undefined;
    props?.onChange?.({ target: control });
  });
}

describe("Project Todo board projection", () => {
  test("separates status groups and derives In Progress from activation", () => {
    const groups = deriveProjectTodoGroups([
      todo({ id: "idea", status: "idea" }),
      todo({ id: "ready", status: "ready" }),
      todo({ id: "running", status: "ready", activation: { kind: "session", sourceSessionId: "s", todoRevision: 1, snapshot: { title: "Todo", body: "" }, resourceId: "s" } }),
      todo({ id: "done", status: "done" }),
    ]);

    expect(groups.idea.map((item) => item.id)).toEqual(["idea"]);
    expect(groups.ready.map((item) => item.id)).toEqual(["ready"]);
    expect(groups.in_progress.map((item) => item.id)).toEqual(["running"]);
    expect(groups.done.map((item) => item.id)).toEqual(["done"]);
  });
});

describe("ProjectTodosRoute interactions", () => {
  beforeEach(() => {
    mock.restore();
    sessionRuntimeStore.getState().reset();
  });

  afterEach(() => {
    sessionRuntimeStore.getState().reset();
    restoreGlobals();
    mock.restore();
  });

  test("selects the Todo's Board, Rejected, or Archived view and expands it from the URL", async () => {
    const cases: Array<{ selected: ProjectTodo; expectedView: "Board" | "Rejected" | "Archived" }> = [
      { selected: todo({ id: "board-target", title: "Board target", status: "ready" }), expectedView: "Board" },
      { selected: todo({ id: "rejected-target", title: "Rejected target", status: "rejected", rejectionReason: "Not now" }), expectedView: "Rejected" },
      { selected: todo({ id: "archived-target", title: "Archived target", status: "done", archivedAt: 2 }), expectedView: "Archived" },
    ];

    for (const { selected, expectedView } of cases) {
      const fixture = await setupRoute({
        todos: [selected],
        initialEntry: `/projects/demo/todos?todo=${selected.id}`,
      });
      try {
        await waitFor(() => {
          expect(button(fixture.container, expectedView).getAttribute("aria-pressed")).toBe("true");
          const selectedCard = card(fixture.container, selected.id);
          expect(selectedCard.querySelector("button")?.getAttribute("aria-expanded")).toBe("true");
          expect(selectedCard.textContent).toContain(selected.title);
          expect(selectedCard.textContent).toContain("Edit");
        });
      } finally {
        await cleanupRoute(fixture);
      }
    }
  });

  test("creates a new Todo from the board capture field", async () => {
    const created = todo({ id: "created", title: "Capture billing edge cases" });
    const fixture = await setupRoute({
      todos: [],
      mutationResponse: (request) => request.path === "/api/projects/demo/todos"
        ? Response.json({ todo: created }, { status: 201 })
        : new Response("Not found", { status: 404 }),
    });

    try {
      const titleInput = fixture.container.querySelector('[aria-label="New Todo title"]') as HTMLInputElement | null;
      if (!titleInput) throw new Error("Missing new Todo title input");
      await setControlValue(fixture.dom, titleInput, "  Capture billing edge cases  ");
      const createButton = fixture.container.querySelector('button[aria-label="New Todo"]');
      if (!createButton) throw new Error("Missing New Todo button");
      await click(fixture.dom, createButton);

      await waitFor(() => expect(fixture.requests).toContainEqual({
        path: "/api/projects/demo/todos",
        method: "POST",
        body: { title: "Capture billing edge cases" },
      }));
      await waitFor(() => expect(titleInput.value).toBe(""));
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("switches to Board so a newly created Idea is visible from Rejected and Archived", async () => {
    for (const initialTodo of [
      todo({ id: "rejected-parent", status: "rejected", rejectionReason: "Not now" }),
      todo({ id: "archived-parent", status: "done", archivedAt: 1 }),
    ]) {
      const created = todo({ id: `created-from-${initialTodo.id}`, title: "Visible new idea" });
      let currentTodos = [initialTodo];
      const fixture = await setupRoute({
        todos: currentTodos,
        initialEntry: `/projects/demo/todos?todo=${initialTodo.id}`,
        todosResponse: () => currentTodos,
        mutationResponse: (request) => {
          if (request.path !== "/api/projects/demo/todos") return new Response("Not found", { status: 404 });
          currentTodos = [...currentTodos, created];
          return Response.json({ todo: created }, { status: 201 });
        },
      });

      try {
        const titleInput = fixture.container.querySelector('[aria-label="New Todo title"]') as HTMLInputElement | null;
        if (!titleInput) throw new Error("Missing new Todo title input");
        await setControlValue(fixture.dom, titleInput, created.title);
        const createButton = fixture.container.querySelector('button[aria-label="New Todo"]');
        if (!createButton) throw new Error("Missing New Todo button");
        await click(fixture.dom, createButton);

        await waitFor(() => {
          expect(button(fixture.container, "Board").getAttribute("aria-pressed")).toBe("true");
          expect(card(fixture.container, created.id).textContent).toContain(created.title);
        });
      } finally {
        await cleanupRoute(fixture);
      }
    }
  });

  test("shows associations and a state-appropriate primary action while cards stay collapsed", async () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "activation-session", activity: "running" }],
      createdAt: 1,
    });
    const snapshot = { title: "Linked Todo", body: "" };
    const fixture = await setupRoute({
      todos: [
        todo({ id: "linked", title: "Linked Todo", status: "ready", discussionSessionId: "discussion-session", activation: { kind: "session", sourceSessionId: "activation-session", todoRevision: 1, snapshot, resourceId: "activation-session" } }),
        todo({ id: "ready-primary", title: "Ready primary", status: "ready" }),
        todo({ id: "idea-primary", title: "Idea primary", status: "idea" }),
      ],
      sessions: [session("discussion-session"), session("activation-session")],
    });

    try {
      const linked = card(fixture.container, "linked");
      expect(linked.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
      expect(linked.textContent).toContain("Discussion");
      expect(linked.textContent).toContain("Activation · Session · running");
      expect(button(linked, "Return to Ready")).toBeDefined();

      expect(button(card(fixture.container, "ready-primary"), "Start Session")).toBeDefined();
      expect(button(card(fixture.container, "idea-primary"), "Discuss")).toBeDefined();
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("uses pressed view buttons and exposes the complete valid action matrix", async () => {
    const fixture = await setupRoute({
      todos: [
        todo({ id: "idea", title: "Idea", status: "idea" }),
        todo({ id: "ready", title: "Ready", status: "ready" }),
        todo({ id: "done", title: "Done", status: "done" }),
        todo({ id: "rejected", title: "Rejected", status: "rejected", rejectionReason: "Outside product direction" }),
      ],
    });

    try {
      expect(fixture.container.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
      expect(button(fixture.container, "Board").getAttribute("aria-pressed")).toBe("true");
      expect(button(fixture.container, "Rejected").getAttribute("aria-pressed")).toBe("false");

      const readyCard = await expand(fixture, "ready");
      for (const action of ["Discuss", "Start Session", "Start Goal", "Create Automation", "Move to Idea", "Reject", "Mark Done", "Archive"]) {
        expect(button(readyCard, action)).toBeDefined();
      }

      const doneCard = await expand(fixture, "done");
      expect(button(doneCard, "Reopen")).toBeDefined();
      expect(button(doneCard, "Archive")).toBeDefined();

      await click(fixture.dom, button(fixture.container, "Rejected"));
      await waitFor(() => expect(fixture.container.textContent).toContain("Outside product direction"));
      expect(button(fixture.container, "Rejected").getAttribute("aria-pressed")).toBe("true");
      const rejectedCard = await expand(fixture, "rejected");
      expect(button(rejectedCard, "Restore to Idea")).toBeDefined();
      expect(button(rejectedCard, "Archive")).toBeDefined();
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("sends ready rejection, ready completion, and done archive mutations", async () => {
    const fixture = await setupRoute({
      todos: [
        todo({ id: "ready-reject", title: "Reject me", status: "ready", revision: 3 }),
        todo({ id: "ready-done", title: "Finish me", status: "ready", revision: 4 }),
        todo({ id: "done-archive", title: "Archive me", status: "done", revision: 5 }),
      ],
    });

    try {
      const rejectCard = await expand(fixture, "ready-reject");
      await click(fixture.dom, button(rejectCard, "Reject"));
      const reason = rejectCard.querySelector('[aria-label="Rejection reason"]') as HTMLTextAreaElement | null;
      if (!reason) throw new Error("Missing rejection reason input");
      await setControlValue(fixture.dom, reason, "No longer valuable");
      await click(fixture.dom, button(rejectCard, "Reject Todo"));

      const doneCard = await expand(fixture, "ready-done");
      await click(fixture.dom, button(doneCard, "Mark Done"));

      const archiveCard = await expand(fixture, "done-archive");
      await click(fixture.dom, button(archiveCard, "Archive"));

      await waitFor(() => {
        expect(fixture.requests).toContainEqual({
          path: "/api/projects/demo/todos/ready-reject",
          method: "PATCH",
          body: { expectedRevision: 3, patch: { status: "rejected", rejectionReason: "No longer valuable" } },
        });
        expect(fixture.requests).toContainEqual({
          path: "/api/projects/demo/todos/ready-done",
          method: "PATCH",
          body: { expectedRevision: 4, patch: { status: "done" } },
        });
        expect(fixture.requests).toContainEqual({
          path: "/api/projects/demo/todos/done-archive/archive",
          method: "POST",
          body: { expectedRevision: 5 },
        });
      });
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("executes Mark Ready, Move to Idea, Reopen, and Return to Ready transitions", async () => {
    const snapshot = { title: "Running", body: "" };
    const fixture = await setupRoute({
      todos: [
        todo({ id: "mark-ready", title: "Mark ready", status: "idea", revision: 10 }),
        todo({ id: "move-idea", title: "Move idea", status: "ready", revision: 11 }),
        todo({ id: "reopen", title: "Reopen", status: "done", revision: 12 }),
        todo({ id: "return-ready", title: "Return ready", status: "ready", revision: 13, activation: { kind: "session", sourceSessionId: "running-session", todoRevision: 13, snapshot, resourceId: "running-session" } }),
      ],
      sessions: [session("running-session")],
    });

    try {
      await click(fixture.dom, button(await expand(fixture, "mark-ready"), "Mark Ready"));
      await click(fixture.dom, button(await expand(fixture, "move-idea"), "Move to Idea"));
      await click(fixture.dom, button(await expand(fixture, "reopen"), "Reopen"));
      await click(fixture.dom, button(await expand(fixture, "return-ready"), "Return to Ready"));

      await waitFor(() => {
        expect(fixture.requests).toContainEqual({ path: "/api/projects/demo/todos/mark-ready", method: "PATCH", body: { expectedRevision: 10, patch: { status: "ready" } } });
        expect(fixture.requests).toContainEqual({ path: "/api/projects/demo/todos/move-idea", method: "PATCH", body: { expectedRevision: 11, patch: { status: "idea" } } });
        expect(fixture.requests).toContainEqual({ path: "/api/projects/demo/todos/reopen", method: "PATCH", body: { expectedRevision: 12, patch: { status: "ready" } } });
        expect(fixture.requests).toContainEqual({ path: "/api/projects/demo/todos/return-ready/return-to-ready", method: "POST", body: { expectedRevision: 13 } });
      });
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("restores rejected and archived Todos through their explicit views", async () => {
    const rejected = await setupRoute({
      todos: [todo({ id: "restore-idea", status: "rejected", rejectionReason: "Needs evidence", revision: 14 })],
      initialEntry: "/projects/demo/todos?todo=restore-idea",
    });
    try {
      await click(rejected.dom, button(await expand(rejected, "restore-idea"), "Restore to Idea"));
      await waitFor(() => expect(rejected.requests).toContainEqual({ path: "/api/projects/demo/todos/restore-idea", method: "PATCH", body: { expectedRevision: 14, patch: { status: "idea" } } }));
    } finally {
      await cleanupRoute(rejected);
    }

    const archived = await setupRoute({
      todos: [todo({ id: "restore-archived", status: "done", archivedAt: 2, revision: 15 })],
      initialEntry: "/projects/demo/todos?todo=restore-archived",
    });
    try {
      await click(archived.dom, button(await expand(archived, "restore-archived"), "Restore"));
      await waitFor(() => expect(archived.requests).toContainEqual({ path: "/api/projects/demo/todos/restore-archived/restore", method: "POST", body: { expectedRevision: 15 } }));
    } finally {
      await cleanupRoute(archived);
    }
  });

  test("requires visible rejection feedback before sending a rejection", async () => {
    const fixture = await setupRoute({ todos: [todo({ id: "blank-rejection", status: "idea", revision: 16 })] });
    try {
      const rejectionCard = await expand(fixture, "blank-rejection");
      await click(fixture.dom, button(rejectionCard, "Reject"));
      await click(fixture.dom, button(rejectionCard, "Reject Todo"));

      expect(rejectionCard.textContent).toContain("Rejection reason is required");
      expect(rejectionCard.querySelector('[role="alert"]')).not.toBeNull();
      expect(fixture.requests.some((request) => request.method === "PATCH")).toBe(false);
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("opens a Shaper discussion and starts the selected Activation kind", async () => {
    const discussion = await setupRoute({ todos: [todo({ id: "discuss", title: "Discuss me", revision: 6 })] });
    try {
      const discussionCard = await expand(discussion, "discuss");
      await click(discussion.dom, button(discussionCard, "Discuss"));
      await waitFor(() => expect(discussion.container.querySelector('[data-testid="session-destination"]')).not.toBeNull());
      expect(discussion.requests).toContainEqual({
        path: "/api/projects/demo/todos/discuss/discuss",
        method: "POST",
        body: { expectedRevision: 6 },
      });
      expect(discussion.requests.filter((request) => request.path === "/api/projects/demo/sessions" && request.method === "GET").length).toBeGreaterThanOrEqual(2);
    } finally {
      await cleanupRoute(discussion);
    }

    const activation = await setupRoute({ todos: [todo({ id: "activate", title: "Activate me", status: "ready", revision: 7 })] });
    try {
      const activationCard = await expand(activation, "activate");
      await click(activation.dom, button(activationCard, "Start Goal"));
      await waitFor(() => expect(activation.container.querySelector('[data-testid="session-destination"]')).not.toBeNull());
      expect(activation.requests).toContainEqual({
        path: "/api/projects/demo/todos/activate/activate",
        method: "POST",
        body: { kind: "goal", expectedRevision: 7 },
      });
    } finally {
      await cleanupRoute(activation);
    }
  });

  test("starts Session and Automation Activations with the selected kind", async () => {
    for (const activationCase of [
      { id: "start-session", label: "Start Session", kind: "session" },
      { id: "create-automation", label: "Create Automation", kind: "automation" },
    ] as const) {
      const fixture = await setupRoute({ todos: [todo({ id: activationCase.id, status: "ready", revision: 17 })] });
      try {
        await click(fixture.dom, button(await expand(fixture, activationCase.id), activationCase.label));
        await waitFor(() => expect(fixture.container.querySelector('[data-testid="session-destination"]')).not.toBeNull());
        expect(fixture.requests).toContainEqual({
          path: `/api/projects/demo/todos/${activationCase.id}/activate`,
          method: "POST",
          body: { kind: activationCase.kind, expectedRevision: 17 },
        });
      } finally {
        await cleanupRoute(fixture);
      }
    }
  });

  test("navigates after activation refetch moves the Todo card into In Progress", async () => {
    const ready = todo({ id: "move-on-activate", title: "Move on activate", status: "ready", revision: 17 });
    const activated = todo({
      ...ready,
      revision: 18,
      activation: {
        kind: "session",
        sourceSessionId: "destination-session",
        todoRevision: 17,
        snapshot: { title: ready.title, body: ready.body },
        resourceId: "destination-session",
      },
    });
    let currentTodos = [ready];
    const fixture = await setupRoute({
      todos: currentTodos,
      todosResponse: () => currentTodos,
      mutationResponse: (request) => {
        if (request.path !== "/api/projects/demo/todos/move-on-activate/activate") {
          return new Response("Not found", { status: 404 });
        }
        currentTodos = [activated];
        return Response.json({ todo: activated, sessionId: "destination-session" });
      },
    });

    try {
      await click(fixture.dom, button(await expand(fixture, ready.id), "Start Session"));
      await waitFor(() => {
        expect(fixture.requests.filter((request) => request.path === "/api/projects/demo/todos" && request.method === "GET").length).toBeGreaterThanOrEqual(2);
        expect(fixture.container.querySelector('[data-testid="session-destination"]')).not.toBeNull();
      });
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("projects unbound, deleted, and exact authoritative Activation resources distinctly", async () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "session-found", activity: "running" }],
      createdAt: 1,
    });
    const snapshot = { title: "Todo", body: "" };
    const fixture = await setupRoute({
      todos: [
        todo({ id: "unbound", status: "ready", activation: { kind: "goal", sourceSessionId: "source-unbound", todoRevision: 1, snapshot } }),
        todo({ id: "deleted", status: "ready", activation: { kind: "goal", sourceSessionId: "source-deleted", todoRevision: 1, snapshot, resourceId: "goal-missing" } }),
        todo({ id: "found-goal", status: "ready", activation: { kind: "goal", sourceSessionId: "source-goal", todoRevision: 1, snapshot, resourceId: "goal-found" } }),
        todo({ id: "found-automation", status: "ready", activation: { kind: "automation", sourceSessionId: "source-automation", todoRevision: 1, snapshot, resourceId: "automation-found" } }),
        todo({ id: "found-session", status: "ready", activation: { kind: "session", sourceSessionId: "session-found", todoRevision: 1, snapshot, resourceId: "session-found" } }),
      ],
      sessions: [session("session-found")],
      goals: [goal("goal-found", "reviewing")],
      automations: [automation("automation-found", "paused")],
    });

    try {
      const unbound = await expand(fixture, "unbound");
      expect(unbound.textContent).toContain("Source Session");
      expect(unbound.textContent).toContain("Preparing resource…");
      expect(unbound.textContent).not.toContain("Deleted");

      const deleted = await expand(fixture, "deleted");
      expect(deleted.textContent).toContain("Deleted");
      expect(deleted.textContent).not.toContain("Preparing resource…");
      expect(deleted.textContent).not.toContain("Source Session");

      expect((await expand(fixture, "found-goal")).textContent).toContain("Goal · reviewing");
      expect((await expand(fixture, "found-automation")).textContent).toContain("Automation · paused");
      expect((await expand(fixture, "found-session")).textContent).toContain("Session · running");
    } finally {
      await cleanupRoute(fixture);
    }
  });

  test("keeps the edit draft and base revision across prop updates, then surfaces conflict", async () => {
    const initial = todo({ id: "conflict", title: "Original title", body: "Original body", revision: 4 });
    const serverVersion = { ...initial, title: "Server title", body: "Server body", revision: 5, updatedAt: 2 };
    let authoritativeTodos = [initial];
    const fixture = await setupRoute({
      todos: [initial],
      todosResponse: () => authoritativeTodos,
      mutationResponse: (request) => {
        if (request.method === "PATCH") {
          authoritativeTodos = [serverVersion];
          return Response.json({ error: { code: "PROJECT_TODO_REVISION_CONFLICT", message: "Todo changed while you were editing" } }, { status: 409 });
        }
        return Response.json({ todo: initial });
      },
    });

    try {
      const conflictCard = await expand(fixture, "conflict");
      await click(fixture.dom, button(conflictCard, "Edit"));
      const titleInput = conflictCard.querySelector('[aria-label="Todo title"]') as HTMLInputElement | null;
      if (!titleInput) throw new Error("Missing title input");
      await setControlValue(fixture.dom, titleInput, "My draft title");

      await act(async () => {
        fixture.queryClient.setQueryData(queryKeys.projectTodos("demo"), [serverVersion]);
      });
      expect((card(fixture.container, "conflict").querySelector('[aria-label="Todo title"]') as HTMLInputElement).value).toBe("My draft title");

      await click(fixture.dom, button(card(fixture.container, "conflict"), "Save"));
      await waitFor(() => expect(card(fixture.container, "conflict").textContent).toContain("Todo changed while you were editing"));
      await waitFor(() => expect(fixture.requests.filter((request) => request.path === "/api/projects/demo/todos" && request.method === "GET").length).toBeGreaterThanOrEqual(2));
      expect(fixture.requests).toContainEqual({
        path: "/api/projects/demo/todos/conflict",
        method: "PATCH",
        body: { expectedRevision: 4, patch: { title: "My draft title", body: "Original body" } },
      });

      await click(fixture.dom, button(card(fixture.container, "conflict"), "Cancel"));
      await click(fixture.dom, button(card(fixture.container, "conflict"), "Edit"));
      expect((card(fixture.container, "conflict").querySelector('[aria-label="Todo title"]') as HTMLInputElement).value).toBe("Server title");
    } finally {
      await cleanupRoute(fixture);
    }
  });
});
