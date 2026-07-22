import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { JSDOM } from "jsdom";
import { ProjectTodosRoute, deriveProjectTodoGroups } from "./project-todos";
import { runtimeFamilyKey, sessionRuntimeStore } from "../store/session-runtime-store";

const todos = [
  { id: "idea", title: "Idea", body: "Shape this", status: "idea", revision: 1, createdAt: 1, updatedAt: 1 },
  { id: "ready", title: "Ready", body: "Ready body", status: "ready", revision: 1, createdAt: 1, updatedAt: 1 },
  { id: "active", title: "Active", body: "Active body", status: "ready", revision: 1, createdAt: 1, updatedAt: 1, activation: { kind: "session", sourceSessionId: "source", resourceId: "linked", todoRevision: 1, snapshot: { title: "Active", body: "Active body" } } },
  { id: "done", title: "Done", body: "Done body", status: "done", revision: 1, createdAt: 1, updatedAt: 1 },
  { id: "rejected", title: "Rejected", body: "Rejected body", status: "rejected", rejectionReason: "No", revision: 1, createdAt: 1, updatedAt: 1 },
  { id: "archived", title: "Archived", body: "Archived body", status: "done", revision: 1, archivedAt: 2, createdAt: 1, updatedAt: 2 },
  { id: "discussed", title: "Discussed", body: "Continue this", status: "idea", discussionSessionId: "discussion", revision: 1, createdAt: 1, updatedAt: 1 },
] as const;

const DOM_GLOBAL_NAMES = ["window", "document", "navigator", "HTMLElement", "MouseEvent", "IS_REACT_ACT_ENVIRONMENT", "requestAnimationFrame", "cancelAnimationFrame", "fetch"] as const;
type DomGlobalName = (typeof DOM_GLOBAL_NAMES)[number];

let originalGlobals: Map<DomGlobalName, PropertyDescriptor | undefined>;
let root: Root;
let container: HTMLDivElement;
let observedRequests: Array<{ path: string; method: string; body?: unknown }>;

function installDom() {
  originalGlobals = new Map(DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos" });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
  });
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "MouseEvent", { value: dom.window.MouseEvent, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  Object.defineProperty(globalThis, "requestAnimationFrame", { value: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0), configurable: true });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { value: clearTimeout, configurable: true });
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      observedRequests.push({ path: String(input), method: init?.method ?? "GET", ...(body === undefined ? {} : { body }) });
      return responseFor(String(input), init?.method ?? "GET");
    },
    configurable: true,
  });
  container = dom.window.document.querySelector("#root") as HTMLDivElement;
  root = createRoot(container);
}

function restoreDom() {
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
}

function responseFor(path: string, method = "GET") {
  if (path === "/api/projects/demo/todos") return json({ todos });
  if (path === "/api/projects/demo/sessions") return json({ sessions: [{ sessionId: "source" }, { sessionId: "linked" }] });
  if (path === "/api/projects/demo/automations") return json({ automations: [] });
  if (method !== "GET" && path.startsWith("/api/projects/demo/todos/")) {
    const id = path.split("/")[5] ?? "idea";
    return json({ todo: todos.find((todo) => todo.id === id) ?? todos[0], sessionId: "created-session" });
  }
  return json({ error: { message: `Unexpected request ${path}` } }, 500);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function render(entry = "/projects/demo/todos", readyText = "Ideas") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[entry]}>
          <Routes><Route path="/projects/:slug/todos" element={<ProjectTodosRoute />} /><Route path="*" element={<div>navigated</div>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await waitFor(() => expect(container.textContent).toContain(readyText));
}

async function waitFor(assertion: () => void) {
  const deadline = Date.now() + 1_500;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
  }
  throw lastError;
}

async function expand(id: string): Promise<HTMLElement> {
  const card = container.querySelector(`[data-testid="todo-${id}"]`) as HTMLElement;
  await act(async () => (card.querySelector("button") as HTMLButtonElement).click());
  return card;
}

function actionLabels(card: HTMLElement): string[] {
  return Array.from(card.querySelectorAll("button"))
    .slice(1)
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean);
}

async function clickAction(card: HTMLElement, label: string): Promise<void> {
  const button = Array.from(card.querySelectorAll("button")).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing ${label} action`);
  observedRequests = [];
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
  await waitFor(() => expect(observedRequests.some((request) => request.method !== "GET")).toBe(true));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}

async function renderFresh(entry = "/projects/demo/todos", readyText = "Ideas"): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
  observedRequests = [];
  await render(entry, readyText);
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  act(() => {
    const previous = element.value;
    const prototype = element instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    (element as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (element as unknown as Record<string, { onChange?: (event: { target: typeof element }) => void }>)[propsKey]
      : undefined;
    props?.onChange?.({ target: element });
  });
}

describe("ProjectTodosRoute presentation contracts", () => {
  beforeEach(() => {
    installDom();
    observedRequests = [];
    sessionRuntimeStore.getState().reset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restoreDom();
    sessionRuntimeStore.getState().reset();
  });

  test("preserves workflow grouping and the flat responsive grid contract", async () => {
    expect(deriveProjectTodoGroups(todos)).toMatchObject({
      idea: [todos[0], todos[6]], ready: [todos[1], todos[4]], in_progress: [todos[2]], done: [todos[3], todos[5]],
    });
    await render();
    const board = container.querySelector("main > div");
    expect(board?.className).toContain("grid-cols-1");
    expect(board?.className).toContain("min-[800px]:grid-cols-2");
    expect(board?.className).toContain("min-[1200px]:grid-cols-4");
    expect(board?.className).not.toContain("min-w-[880px]");
    expect(Array.from(container.querySelectorAll("section[aria-label]")).map((lane) => lane.getAttribute("aria-label"))).toEqual(["Ideas", "Ready", "In Progress", "Done"]);
  });

  test("uses archived presentation priority and preserves URL-driven archived view", async () => {
    await render("/projects/demo/todos?todo=archived", "Archived Todos");
    await waitFor(() => expect(container.querySelector('[data-testid="todo-archived"]')?.textContent).toContain("Archived"));
    expect(container.querySelector('[data-testid="todo-archived"] button')?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Archived Todos");
  });

  test("shows linked Session activity only in the association, while card In Progress remains static", async () => {
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["demo"],
      families: [{ projectSlug: "demo", rootSessionId: "source", activity: "idle" }, { projectSlug: "demo", rootSessionId: "linked", activity: "running" }],
      createdAt: 1,
    });
    await render();
    const card = container.querySelector('[data-testid="todo-active"]') as HTMLElement;
    expect(card.textContent).toContain("In Progress");
    expect(card.querySelector("button [data-motion=loop]")).toBeNull();
    expect(card.querySelector('[aria-label="Activation session"] [data-testid="activity-arc"], [data-testid="activity-arc"]')).not.toBeNull();
  });

  test("keeps the original editable body affordance", async () => {
    await render();
    const card = container.querySelector('[data-testid="todo-idea"]') as HTMLElement;
    await act(async () => (card.querySelector("button") as HTMLButtonElement).click());
    await act(async () => Array.from(card.querySelectorAll("button")).find((button) => button.textContent === "Edit")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
    const textarea = card.querySelector('textarea[aria-label="Todo body"]') as HTMLTextAreaElement;
    expect(textarea.rows).toBe(4);
    expect(textarea.className).toContain("resize-y");
    expect(textarea.className).not.toContain("min-h-");
  });

  test("preserves every lifecycle action matrix and adds no drag or More-menu affordance", async () => {
    await render();
    expect(actionLabels(await expand("idea"))).toEqual(["Edit", "Discuss", "Mark Ready", "Reject", "Archive"]);
    expect(actionLabels(await expand("ready"))).toEqual(["Edit", "Discuss", "Start Session", "Create Automation", "Move to Idea", "Reject", "Mark Done", "Archive"]);
    expect(actionLabels(await expand("active"))).toEqual(["Edit", "Discuss", "Return to Ready", "Mark Done"]);
    expect(actionLabels(await expand("done"))).toEqual(["Edit", "Reopen", "Archive"]);

    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Rejected")?.click());
    expect(actionLabels(await expand("rejected"))).toEqual(["Edit", "Discuss", "Restore to Idea", "Archive"]);
    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Archived")?.click());
    expect(actionLabels(await expand("archived"))).toEqual(["Edit", "Restore"]);

    expect(container.querySelector("[draggable=true]")).toBeNull();
    expect(container.querySelector("[ondrop], [ondragstart], [aria-label*=More]")).toBeNull();
  });

  test("keeps status, activation, and lifecycle actions on their original mutation endpoints", async () => {
    await render();

    const idea = await expand("idea");
    await clickAction(idea, "Mark Ready");
    expect(observedRequests).toContainEqual({
      path: "/api/projects/demo/todos/idea",
      method: "PATCH",
      body: { expectedRevision: 1, patch: { status: "ready" } },
    });

    const ready = await expand("ready");
    await clickAction(ready, "Create Automation");
    expect(observedRequests).toContainEqual({
      path: "/api/projects/demo/todos/ready/activate",
      method: "POST",
      body: { kind: "automation", expectedRevision: 1 },
    });
  });

  test("keeps discussion and terminal lifecycle actions on their original handlers", async () => {
    await render();

    const active = await expand("active");
    await clickAction(active, "Return to Ready");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/active/return-to-ready", method: "POST", body: { expectedRevision: 1 } });

    const done = await expand("done");
    await clickAction(done, "Reopen");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/done", method: "PATCH", body: { expectedRevision: 1, patch: { status: "ready" } } });

    await act(async () => Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Archived")?.click());
    const archived = await expand("archived");
    await clickAction(archived, "Restore");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/archived/restore", method: "POST", body: { expectedRevision: 1 } });
  });

  test("preserves Discuss, Continue, Session activation, and every remaining lifecycle handler", async () => {
    await render();

    await clickAction(await expand("idea"), "Discuss");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/idea/discuss", method: "POST", body: { expectedRevision: 1 } });

    await renderFresh();
    await clickAction(await expand("discussed"), "Continue Discussion");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/discussed/discuss", method: "POST", body: { expectedRevision: 1 } });

    await renderFresh();
    await clickAction(await expand("ready"), "Start Session");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/ready/activate", method: "POST", body: { kind: "session", expectedRevision: 1 } });

    await renderFresh();
    await clickAction(await expand("ready"), "Move to Idea");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/ready", method: "PATCH", body: { expectedRevision: 1, patch: { status: "idea" } } });

    await renderFresh();
    await clickAction(await expand("ready"), "Mark Done");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/ready", method: "PATCH", body: { expectedRevision: 1, patch: { status: "done" } } });

    await renderFresh();
    await clickAction(await expand("idea"), "Archive");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/idea/archive", method: "POST", body: { expectedRevision: 1 } });

    await renderFresh("/projects/demo/todos?todo=rejected", "Rejected Todos");
    await clickAction(container.querySelector('[data-testid="todo-rejected"]') as HTMLElement, "Restore to Idea");
    expect(observedRequests).toContainEqual({ path: "/api/projects/demo/todos/rejected", method: "PATCH", body: { expectedRevision: 1, patch: { status: "idea" } } });
  });

  test("preserves Reject submission and Edit-save payloads", async () => {
    await render();
    const idea = await expand("idea");
    await act(async () => Array.from(idea.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Reject")?.click());
    const rejectionReason = idea.querySelector('textarea[aria-label="Rejection reason"]') as HTMLTextAreaElement;
    changeValue(rejectionReason, "Not aligned");
    await clickAction(idea, "Reject Todo");
    expect(observedRequests).toContainEqual({
      path: "/api/projects/demo/todos/idea",
      method: "PATCH",
      body: { expectedRevision: 1, patch: { status: "rejected", rejectionReason: "Not aligned" } },
    });

    await renderFresh();
    const editing = await expand("idea");
    await act(async () => Array.from(editing.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Edit")?.click());
    changeValue(editing.querySelector('input[aria-label="Todo title"]') as HTMLInputElement, "Edited title");
    changeValue(editing.querySelector('textarea[aria-label="Todo body"]') as HTMLTextAreaElement, "Edited body");
    await clickAction(editing, "Save");
    expect(observedRequests).toContainEqual({
      path: "/api/projects/demo/todos/idea",
      method: "PATCH",
      body: { expectedRevision: 1, patch: { title: "Edited title", body: "Edited body" } },
    });
  });
});
