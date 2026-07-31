import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectTodo, SessionSummary } from "../api/types";
import { WorkbenchLayoutProvider } from "../context/workbench-layout";

const bootstrapDom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/projects/demo/todos",
});
installDomGlobals(bootstrapDom);
const {
  planWorkCommand,
  ProjectTodosRoute,
  TODO_PLAN_ACTION_LABEL,
} = await import("./project-todos");
bootstrapDom.window.close();

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let responseMode: "success" | "failure";
let patches: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof mock>;
let sessionSummaries: SessionSummary[];
let requests: Array<{ method: string; path: string; body?: unknown }>;
let sessionDetailResponse: () => Response | Promise<Response>;
let messageResponse: () => Response | Promise<Response>;
let createSessionResponse: () => Response | Promise<Response>;

const todos: ProjectTodo[] = [
  todo("idea", "Idea", "idea"),
  todo("idea-next", "Next idea", "idea"),
  todo("ready", "Ready", "ready"),
];

function todo(id: string, title: string, status: ProjectTodo["status"]): ProjectTodo {
  return { id, title, body: "", status, revision: 3, createdAt: 1, updatedAt: 1 };
}

function installDomGlobals(target: JSDOM): void {
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
    CustomEvent: target.window.CustomEvent,
    MouseEvent: target.window.MouseEvent,
    TouchEvent: target.window.TouchEvent,
    KeyboardEvent: target.window.KeyboardEvent,
    MutationObserver: target.window.MutationObserver,
    getComputedStyle: target.window.getComputedStyle.bind(target.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos" });
  installDomGlobals(dom);
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value() { return rectFor(this); } });
  responseMode = "success";
  patches = [];
  requests = [];
  sessionSummaries = [];
  sessionDetailResponse = () => Response.json({
    nextModelSelection: {
      requested: { mode: "profile_default", selection: { model: "test:model" } },
      resolved: {
        selection: { model: "test:model" },
        providerId: "test",
        modelId: "model",
        providerDisplayName: "Test",
        modelDisplayName: "Model",
        resolution: "profile_default",
        modelRuntimeRevision: "runtime-1",
      },
    },
  });
  messageResponse = () => Response.json({ clientRequestId: "plan-command", status: "command" });
  createSessionResponse = () => Response.json({ todo: todos[2], sessionId: "discussion-new" });
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    requests.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (method === "PATCH" && path.endsWith("/todos/idea")) {
      patches.push(body as Record<string, unknown>);
      if (responseMode === "failure") return Response.json({ error: { code: "CONFLICT", message: "stale Todo" } }, { status: 409 });
      return Response.json({ todo: { ...todos[0], status: "ready" } });
    }
    if (method === "POST" && path.endsWith("/messages")) return messageResponse();
    if (method === "POST" && path.endsWith("/sessions")) return createSessionResponse();
    if (path.endsWith("/todos")) return Response.json({ todos });
    if (path.endsWith("/sessions")) return Response.json({ sessions: sessionSummaries });
    if (path.includes("/sessions/")) return sessionDetailResponse();
    if (path.endsWith("/automations")) return Response.json({ automations: [] });
    return new Response("not found", { status: 404 });
  });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  dom.window.close();
});

async function render(initialEntry = "/projects/demo/todos"): Promise<void> {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><WorkbenchLayoutProvider><MemoryRouter initialEntries={[initialEntry]}><Routes><Route path="/projects/:slug/todos" element={<ProjectTodosRoute />} /><Route path="/projects/:slug/sessions/:sessionId" element={<div data-testid="session-page" />} /></Routes></MemoryRouter></WorkbenchLayoutProvider></QueryClientProvider>);
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("Timed out waiting for the Todo interaction state");
}

async function renderSelectedTodo(): Promise<void> {
  await render("/projects/demo/todos?todo=ready");
  await waitFor(() => document.querySelector('[data-testid="todo-detail-drawer"]') !== null);
}

function addDiscussionSummary(sessionId = "discussion-latest"): void {
  sessionSummaries.push({
    sessionId,
    rootSessionId: sessionId,
    cwd: "/tmp",
    agentName: "discussion",
    profile: "principal",
    activeSkillNames: ["shape-todo"],
    modelSelection: { revision: 0 },
    title: "Plan discussion",
    projectTodo: { todoId: "ready", entry: "discussion" },
    createdAt: 2,
    updatedAt: 3,
  });
}

function findPlanButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(TODO_PLAN_ACTION_LABEL),
  );
  if (!(button instanceof dom.window.HTMLButtonElement)) {
    throw new Error("Plan action button was not rendered");
  }
  return button;
}

function findActionGroup(label: string): HTMLElement {
  const group = [...document.querySelectorAll('[role="group"]')].find((candidate) =>
    candidate.getAttribute("aria-label") === label
  );
  if (!(group instanceof dom.window.HTMLElement)) {
    throw new Error(`Action group "${label}" was not rendered`);
  }
  return group;
}

function actionGroupButtonLabels(label: string): string[] {
  return [...findActionGroup(label).querySelectorAll("button")].map((button) => button.textContent?.trim() ?? "");
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function rectFor(element: Element): DOMRect {
  const testId = element.getAttribute("data-testid");
  const laneXs = { idea: 0, ready: 300, in_progress: 600, done: 900 };
  if (testId?.startsWith("todo-lane-")) {
    const lane = testId.slice("todo-lane-".length) as keyof typeof laneXs;
    return rect(laneXs[lane], 0, 240, 500);
  }
  if (testId === "todo-idea") return rect(0, 100, 220, 56);
  if (testId === "todo-idea-next") return rect(0, 180, 220, 56);
  if (testId === "todo-ready") return rect(300, 100, 220, 56);
  return rect(0, 0, 0, 0);
}

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

async function key(target: HTMLElement, value: string): Promise<void> {
  await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, code: value === " " ? "Space" : value, bubbles: true })));
  await settle();
}

function laneContains(lane: string, todoId: string): boolean {
  return document.querySelector(`[data-testid=\"todo-lane-${lane}\"]`)?.querySelector(`[data-testid=\"todo-${todoId}\"]`) !== null;
}

function laneOrder(lane: string): string[] {
  return [...document.querySelector(`[data-testid=\"todo-lane-${lane}\"]`)!.querySelectorAll("article")].map((card) => card.getAttribute("data-testid")!);
}

function announcementText(): string {
  return [...document.querySelectorAll('[role="status"], [aria-live]')].map((node) => node.textContent).join(" ");
}

function pointerEvent(type: string, x: number, y: number): MouseEvent {
  const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
  Object.defineProperties(event, { isPrimary: { value: true }, pointerId: { value: 1 } });
  return event;
}

async function pointerDrag(handle: HTMLElement, destination: { x: number; y: number }): Promise<void> {
  await act(async () => handle.dispatchEvent(pointerEvent("pointerdown", 10, 110)));
  await act(async () => document.dispatchEvent(pointerEvent("pointermove", 20, 110)));
  await settle();
  await act(async () => document.dispatchEvent(pointerEvent("pointermove", destination.x, destination.y)));
  await settle();
  await act(async () => document.dispatchEvent(pointerEvent("pointerup", destination.x, destination.y)));
  await settle();
}

function touchEvent(type: string, x: number, y: number, target: EventTarget): TouchEvent {
  const touch: Touch = {
    identifier: 1,
    target,
    clientX: x,
    clientY: y,
    pageX: x,
    pageY: y,
    screenX: x,
    screenY: y,
    radiusX: 1,
    radiusY: 1,
    rotationAngle: 0,
    force: 1,
  };
  return new dom.window.TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === "touchend" ? [] : [touch],
    changedTouches: [touch],
    targetTouches: type === "touchend" ? [] : [touch],
  });
}

async function touchDrag(handle: HTMLElement, destination: { x: number; y: number }): Promise<void> {
  await act(async () => handle.dispatchEvent(touchEvent("touchstart", 10, 110, handle)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 190)); });
  await act(async () => handle.dispatchEvent(touchEvent("touchmove", destination.x, destination.y, handle)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => handle.dispatchEvent(touchEvent("touchend", destination.x, destination.y, handle)));
  await settle();
}

describe("Project Todos drag interactions", () => {
  test("keyboard pickup, same-lane move, and drop makes one canonical PATCH only at drop and announces it", async () => {
    await render();
    const handle = document.querySelector('[aria-label="Drag Idea"]') as HTMLButtonElement;
    handle.focus();

    await key(handle, " ");
    expect(patches).toEqual([]);
    expect(document.querySelector('[data-testid="todo-board"]')?.className).toContain("cursor-grabbing");
    expect(handle.className).toContain("cursor-grabbing");
    expect(announcementText()).toContain("Moving Idea to Ideas, position 2 of 2.");

    await key(handle, "ArrowDown");
    expect(patches).toEqual([]);
    expect(laneOrder("idea")).toEqual(["todo-idea-next", "todo-idea"]);

    await key(handle, " ");
    await settle();
    expect(patches).toEqual([{ expectedRevision: 3, beforeTodoId: null }]);
    expect(document.querySelector('[data-testid="todo-board"]')?.className).not.toContain("cursor-grabbing");
    expect(announcementText()).toContain("Dropped Idea in Ideas, position 2 of 2.");
  });

  test("Escape cancels a keyboard drag, restores the canonical board, and announces cancellation", async () => {
    await render();
    const handle = document.querySelector('[aria-label="Drag Idea"]') as HTMLButtonElement;
    handle.focus();

    await key(handle, " ");
    await key(handle, "ArrowDown");
    expect(laneOrder("idea")).toEqual(["todo-idea-next", "todo-idea"]);

    await key(handle, "Escape");
    expect(patches).toEqual([]);
    expect(laneOrder("idea")).toEqual(["todo-idea", "todo-idea-next"]);
    expect(announcementText()).toContain("Cancelled move for Idea.");
  });

  test("pointer cross-lane drop uses one PATCH and announces the destination", async () => {
    await render();
    await pointerDrag(document.querySelector('[aria-label="Drag Idea"]') as HTMLButtonElement, { x: 500, y: 120 });
    expect(patches).toEqual([{ expectedRevision: 3, status: "ready", beforeTodoId: null }]);
    expect(announcementText()).toContain("Dropped Idea in Ready, position 2 of 2.");
  });

  test("a rejected pointer drop PATCH restores the canonical lane and surfaces the server error", async () => {
    responseMode = "failure";
    await render();
    await pointerDrag(document.querySelector('[aria-label="Drag Idea"]') as HTMLButtonElement, { x: 500, y: 120 });
    await settle();
    await settle();
    expect(patches).toEqual([{ expectedRevision: 3, status: "ready", beforeTodoId: null }]);
    expect(laneContains("idea", "idea")).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Could not move Todo: stale Todo");
  });

  test("touch cross-lane drop activates the TouchSensor and uses the same canonical PATCH", async () => {
    await render();
    await touchDrag(document.querySelector('[aria-label="Drag Idea"]') as HTMLButtonElement, { x: 500, y: 120 });
    expect(patches).toEqual([{ expectedRevision: 3, status: "ready", beforeTodoId: null }]);
  });
});

describe("Project Todos Plan interactions", () => {
  test("groups drawer actions by intent without changing their lifecycle availability", async () => {
    addDiscussionSummary();
    await renderSelectedTodo();

    const content = document.querySelector('[aria-label="Todo content"]');
    const actions = document.querySelector('[aria-label="Todo actions"]');
    const groups = [...actions!.querySelectorAll(':scope > div > [role="group"]')];

    expect([...content!.querySelectorAll("button")].map((button) => button.textContent?.trim())).toEqual(["Edit"]);
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Discuss & Plan",
      "Execution",
      "Lifecycle",
    ]);
    expect(actionGroupButtonLabels("Discuss & Plan")).toEqual([
      "Continue Discussion",
      "New Discussion",
      TODO_PLAN_ACTION_LABEL,
    ]);
    expect(actionGroupButtonLabels("Execution")).toEqual([
      "Start Work",
      "Create Automation",
    ]);
    expect(actionGroupButtonLabels("Lifecycle")).toEqual([
      "Reject",
      "Move to Ideas",
      "Move to In Progress",
      "Move to Done",
      "Archive",
    ]);
  });

  test("renders the responsive drawer controls and creates one atomic Plan Discussion when none exists", async () => {
    await renderSelectedTodo();

    const drawer = document.querySelector('[data-testid="todo-detail-drawer"]');
    const close = document.querySelector('[aria-label="Close Todo details"]');
    const planButton = findPlanButton();
    expect(drawer?.className).toContain("w-[min(430px,calc(100%_-_18px))]");
    expect(close?.className).toContain("focus-visible:ring-2");
    expect(close?.className).toContain("[@media(pointer:coarse)]:h-11");
    expect(planButton.className).toContain("[@media(pointer:coarse)]:min-h-11");
    expect(planButton.disabled).toBe(false);

    await click(planButton);

    const creates = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({
      expectedRevision: 3,
      entry: "discussion",
      initialIntent: "plan",
    });
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(0);
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("keeps Plan available for a busy Discussion and creates one atomic replacement", async () => {
    addDiscussionSummary();
    sessionDetailResponse = () => Response.json({
      currentExecutionId: "execution-active",
      nextModelSelection: {
        requested: { mode: "profile_default", selection: { model: "test:model" } },
      },
    });
    await renderSelectedTodo();

    const planButton = findPlanButton();
    expect(planButton.disabled).toBe(false);
    await click(planButton);

    const creates = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ entry: "discussion", initialIntent: "plan" });
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(0);
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("reuses an idle Discussion with exactly one Plan command", async () => {
    addDiscussionSummary();
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    )).toHaveLength(0);
    const messages = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatchObject({
      text: planWorkCommand("ready"),
      attachmentIds: [],
      requestedModelSelection: {
        mode: "profile_default",
        selection: { model: "test:model" },
      },
    });
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("falls back to a new Plan Discussion when idle reuse loses the acceptance race", async () => {
    addDiscussionSummary();
    messageResponse = () => Response.json({
      error: {
        code: "BAD_REQUEST",
        message: "The Session is waiting for a tool response.",
        details: {
          scopeCode: "SESSION_TOOL_BATCH_ACTIVE",
          sessionId: "discussion-latest",
        },
      },
    }, { status: 409 });
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(1);
    const creates = requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ entry: "discussion", initialIntent: "plan" });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("falls back to a new Plan Discussion when the linked Session is stale", async () => {
    addDiscussionSummary();
    sessionDetailResponse = () => Response.json({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found" },
    }, { status: 404 });
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    )).toHaveLength(1);
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(0);
    await waitFor(() => document.querySelector('[data-testid="session-page"]') !== null);
  });

  test("does not replace an unavailable project with a new Plan Discussion", async () => {
    addDiscussionSummary();
    sessionDetailResponse = () => Response.json({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
    }, { status: 404 });
    await renderSelectedTodo();

    await click(findPlanButton());

    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/todos/ready/sessions"),
    )).toHaveLength(0);
    expect(document.querySelector('[data-testid="session-page"]')).toBeNull();
    const error = findActionGroup("Discuss & Plan").querySelector('[role="alert"]');
    expect(error?.textContent).toBe("Project not found");
  });

  test("shows local progress, blocks a duplicate click, and recovers beside the Plan action", async () => {
    addDiscussionSummary();
    let resolveMessage: ((response: Response) => void) | undefined;
    messageResponse = () => new Promise<Response>((resolve) => {
      resolveMessage = resolve;
    });
    await renderSelectedTodo();

    const planButton = findPlanButton();
    await act(async () => {
      planButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      planButton.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => planButton.textContent?.includes("Opening Plan…") === true);

    expect(planButton.disabled).toBe(true);
    expect(planButton.querySelector(".animate-activity")).not.toBeNull();
    expect(requests.filter((request) =>
      request.method === "POST" && request.path.endsWith("/messages"),
    )).toHaveLength(1);

    await act(async () => {
      resolveMessage?.(Response.json({
        error: { code: "INTERNAL_ERROR", message: "Plan service unavailable" },
      }, { status: 500 }));
    });
    await waitFor(() => planButton.disabled === false);

    expect(planButton.textContent).toContain(TODO_PLAN_ACTION_LABEL);
    const error = findActionGroup("Discuss & Plan").querySelector('[role="alert"]');
    expect(error?.textContent).toBe("Plan service unavailable");
  });
});
