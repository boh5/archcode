import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectTodo, SessionSummary } from "../api/types";
import {
  automationsQueryOptions,
  projectTodosQueryOptions,
  sessionsQueryOptions,
} from "../api/queries";
import { sessionRuntimeStore } from "../store/session-runtime-store";

type ProjectTodosModule = typeof import("./project-todos");

const todos = {
  idea: todo({ id: "idea", title: "Idea", status: "idea" }),
  ready: todo({ id: "ready", title: "Ready", status: "ready" }),
  active: todo({
    id: "active",
    title: "Active",
    status: "ready",
    activation: {
      kind: "session",
      sourceSessionId: "source",
      resourceId: "linked",
      todoRevision: 1,
      snapshot: { title: "Active", body: "Body" },
    },
  }),
  done: todo({ id: "done", title: "Done", status: "done" }),
  rejected: todo({
    id: "rejected",
    title: "Rejected",
    status: "rejected",
    rejectionReason: "Not aligned",
  }),
  archived: todo({
    id: "archived",
    title: "Archived",
    status: "done",
    archivedAt: 2,
  }),
};

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let nextMutation: ReturnType<typeof Promise.withResolvers<ObservedRequest>> | undefined;
let deriveProjectTodoGroups: ProjectTodosModule["deriveProjectTodoGroups"];
let ProjectTodosRoute: ProjectTodosModule["ProjectTodosRoute"];
let renderSequence = 0;

interface ObservedRequest {
  path: string;
  method: string;
  body?: unknown;
}

function todo(
  input: Pick<ProjectTodo, "id" | "title" | "status">
    & Partial<ProjectTodo>,
): ProjectTodo {
  return {
    body: "Body",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...input,
  };
}

beforeEach(async () => {
  notifyManager.setScheduler((callback) => callback());
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost/projects/demo/todos",
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => undefined },
    detachEvent: { configurable: true, value: () => undefined },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 0;
    },
    cancelAnimationFrame: () => undefined,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(input);
      if (method === "GET") {
        if (path === "/api/projects/demo/todos") {
          return Response.json({ todos: Object.values(todos) });
        }
        if (path === "/api/projects/demo/sessions") {
          return Response.json({ sessions: [] });
        }
        if (path === "/api/projects/demo/automations") {
          return Response.json({ automations: [] });
        }
      }
      const request: ObservedRequest = {
        path,
        method,
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      };
      if (request.method !== "GET") nextMutation?.resolve(request);
      const todoId = request.path.split("/")[5] as keyof typeof todos | undefined;
      return Response.json({
        todo: todoId === undefined ? todos.idea : todos[todoId] ?? todos.idea,
        sessionId: "created-session",
      });
    }),
  });
  container = document.querySelector("#root") as HTMLDivElement;
  root = createRoot(container);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  sessionRuntimeStore.getState().reset();
  renderSequence = 0;
  ({ deriveProjectTodoGroups, ProjectTodosRoute } = await import("./project-todos"));
});

afterEach(async () => {
  notifyManager.setScheduler((callback) => queueMicrotask(callback));
  await act(async () => root.unmount());
  client.clear();
  sessionRuntimeStore.getState().reset();
  dom.window.close();
  nextMutation = undefined;
});

async function renderTodo(
  value: ProjectTodo,
  sessions: SessionSummary[] = [],
): Promise<void> {
  client.setQueryData(projectTodosQueryOptions("demo").queryKey, Object.values(todos));
  client.setQueryData(sessionsQueryOptions("demo").queryKey, sessions);
  client.setQueryData(automationsQueryOptions("demo").queryKey, []);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          key={`${value.id}:${renderSequence++}`}
          initialEntries={[`/projects/demo/todos?todo=${encodeURIComponent(value.id)}`]}
        >
          <Routes>
            <Route path="/projects/:slug/todos" element={<ProjectTodosRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function labels(): string[] {
  return Array.from(document.querySelectorAll('[data-testid="todo-detail-drawer"] button'))
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean);
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>(
    '[data-testid="todo-detail-drawer"] button',
  ))
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing ${label} button`);
  return match;
}

async function clickAndCapture(label: string): Promise<ObservedRequest> {
  nextMutation = Promise.withResolvers<ObservedRequest>();
  const mutationSettled = new Promise<void>((resolve) => {
    const unsubscribe = client.getMutationCache().subscribe((event) => {
      if (event.type !== "updated"
        || (event.mutation.state.status !== "success"
          && event.mutation.state.status !== "error")) return;
      unsubscribe();
      resolve();
    });
  });
  let request!: ObservedRequest;
  await act(async () => {
    button(label).click();
    request = await nextMutation!.promise;
    await mutationSettled;
  });
  nextMutation = undefined;
  return request;
}

function changeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const previous = element.value;
    const prototype = element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    (element as unknown as { _valueTracker?: { setValue(value: string): void } })
      ._valueTracker?.setValue(previous);
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (element as unknown as Record<
          string,
          { onChange?: (event: { target: typeof element }) => void }
        >)[propsKey]
      : undefined;
    props?.onChange?.({ target: element });
  });
}

describe("Project Todo deterministic contracts", () => {
  test("groups every workflow state without rendering or timers", () => {
    expect(deriveProjectTodoGroups(Object.values(todos))).toMatchObject({
      idea: [todos.idea],
      ready: [todos.ready, todos.rejected],
      in_progress: [todos.active],
      done: [todos.done, todos.archived],
    });
  });

  test("opens an archived Todo from the URL in the archived view", async () => {
    await renderTodo(todos.archived);

    expect(container.textContent).toContain("Archived Todos");
    expect(container.querySelector('[data-testid="todo-archived"] button')?.getAttribute("aria-expanded"))
      .toBe("true");
    expect(document.querySelector('[data-testid="todo-detail-drawer"]')).not.toBeNull();
  });

  test("keeps card status static while linked Session activity stays in its association", async () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [
        { projectSlug: "demo", rootSessionId: "source", activity: "idle" },
        { projectSlug: "demo", rootSessionId: "linked", activity: "running" },
      ],
      createdAt: 1,
    });
    await renderTodo(todos.active, [
      { sessionId: "source" } as SessionSummary,
      { sessionId: "linked" } as SessionSummary,
    ]);

    const card = container.querySelector('[data-testid="todo-active"]') as HTMLElement;
    expect(card.textContent).toContain("In Progress");
    expect(card.querySelector("button [data-motion=loop]")).toBeNull();
    expect(card.querySelector('[data-testid="activity-arc"]')).not.toBeNull();
  });

  test("uses a resizable four-row body editor", async () => {
    await renderTodo(todos.idea);
    await act(async () => button("Edit").click());

    const textarea = document.querySelector(
      'textarea[aria-label="Todo body"]',
    ) as HTMLTextAreaElement;
    expect(textarea.rows).toBe(4);
    expect(textarea.className).toContain("resize-y");
  });

  test("keeps the Todo drawer above the project rail at narrow widths", async () => {
    const todoSource = await Bun.file(new URL("./project-todos.tsx", import.meta.url)).text();
    const layoutSource = await Bun.file(new URL("./root-layout.tsx", import.meta.url)).text();

    expect(layoutSource).toContain('className="relative z-[55] w-11');
    expect(todoSource).toContain('className="fixed inset-0 z-[60]');
    expect(todoSource).toContain('right-0 z-[61] flex w-[min(430px,calc(100%-18px))]');
  });

  test("exposes the lifecycle action matrix", async () => {
    await renderTodo(todos.idea);
    expect(labels()).toEqual(["Edit", "Discuss", "Mark Ready", "Reject", "Archive"]);

    await renderTodo(todos.ready);
    expect(labels()).toEqual([
      "Edit",
      "Discuss",
      "Start Session",
      "Create Automation",
      "Move to Idea",
      "Reject",
      "Mark Done",
      "Archive",
    ]);

    await renderTodo(todos.active);
    expect(labels()).toEqual(["Edit", "Discuss", "Return to Ready", "Mark Done"]);

    await renderTodo(todos.done);
    expect(labels()).toEqual(["Edit", "Reopen", "Archive"]);

    await renderTodo(todos.rejected);
    expect(labels()).toEqual(["Edit", "Discuss", "Restore to Idea", "Archive"]);

    await renderTodo(todos.archived);
    expect(labels()).toEqual(["Edit", "Restore"]);
  });

  test("routes status, discussion, activation, archive, restore, and return actions", async () => {
    await renderTodo(todos.idea);
    expect(await clickAndCapture("Mark Ready")).toEqual({
      path: "/api/projects/demo/todos/idea",
      method: "PATCH",
      body: { expectedRevision: 1, patch: { status: "ready" } },
    });
    expect(await clickAndCapture("Discuss")).toEqual({
      path: "/api/projects/demo/todos/idea/discuss",
      method: "POST",
      body: { expectedRevision: 1 },
    });
    await renderTodo(todos.idea);
    expect(await clickAndCapture("Archive")).toEqual({
      path: "/api/projects/demo/todos/idea/archive",
      method: "POST",
      body: { expectedRevision: 1 },
    });

    await renderTodo(todos.ready);
    expect(await clickAndCapture("Start Session")).toEqual({
      path: "/api/projects/demo/todos/ready/activate",
      method: "POST",
      body: { kind: "session", expectedRevision: 1 },
    });
    await renderTodo(todos.ready);
    expect(await clickAndCapture("Create Automation")).toEqual({
      path: "/api/projects/demo/todos/ready/activate",
      method: "POST",
      body: { kind: "automation", expectedRevision: 1 },
    });

    await renderTodo(todos.active);
    expect(await clickAndCapture("Return to Ready")).toEqual({
      path: "/api/projects/demo/todos/active/return-to-ready",
      method: "POST",
      body: { expectedRevision: 1 },
    });

    await renderTodo(todos.done);
    expect(await clickAndCapture("Reopen")).toEqual({
      path: "/api/projects/demo/todos/done",
      method: "PATCH",
      body: { expectedRevision: 1, patch: { status: "ready" } },
    });

    await renderTodo(todos.archived);
    expect(await clickAndCapture("Restore")).toEqual({
      path: "/api/projects/demo/todos/archived/restore",
      method: "POST",
      body: { expectedRevision: 1 },
    });
  });

  test("submits deterministic Edit and Reject payloads", async () => {
    await renderTodo(todos.idea);
    await act(async () => button("Edit").click());
    changeValue(
      document.querySelector('input[aria-label="Todo title"]') as HTMLInputElement,
      "Edited title",
    );
    changeValue(
      document.querySelector('textarea[aria-label="Todo body"]') as HTMLTextAreaElement,
      "Edited body",
    );
    expect(await clickAndCapture("Save")).toEqual({
      path: "/api/projects/demo/todos/idea",
      method: "PATCH",
      body: {
        expectedRevision: 1,
        patch: { title: "Edited title", body: "Edited body" },
      },
    });

    await renderTodo(todos.idea);
    await act(async () => button("Reject").click());
    changeValue(
      document.querySelector('textarea[aria-label="Rejection reason"]') as HTMLTextAreaElement,
      "Not aligned",
    );
    expect(await clickAndCapture("Reject Todo")).toEqual({
      path: "/api/projects/demo/todos/idea",
      method: "PATCH",
      body: {
        expectedRevision: 1,
        patch: { status: "rejected", rejectionReason: "Not aligned" },
      },
    });
  });
});
