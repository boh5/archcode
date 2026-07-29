import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectTodo } from "../api/types";
import { continueWorkUpdateInput, createDragAnnouncements, deriveProjectTodoGroups, moveTodoInBoard, ProjectTodosRoute } from "./project-todos";
import { WorkbenchLayoutProvider } from "../context/workbench-layout";

let dom: JSDOM;
let root: Root;
let client: QueryClient;

const todos: ProjectTodo[] = [
  todo("idea", "Idea", "idea"),
  todo("ready", "Ready", "ready"),
  todo("progress", "Progress", "in_progress"),
  todo("done", "Done", "done"),
  todo("rejected", "Rejected", "rejected"),
];

function todo(id: string, title: string, status: ProjectTodo["status"]): ProjectTodo {
  return { id, title, body: "", status, ...(status === "rejected" ? { rejectionReason: "Not now" } : {}), revision: 1, createdAt: 1, updatedAt: 1 };
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos?todo=ready" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://localhost").pathname;
    if (init?.method === "POST" && path.endsWith("/sessions")) return Response.json({ todo: todos[1], sessionId: "work-1" });
    if (path.endsWith("/todos")) return Response.json({ todos });
    if (path.endsWith("/sessions")) return Response.json({ sessions: [{ sessionId: "work-0", rootSessionId: "work-0", cwd: "/tmp", agentName: "lead", profile: "principal", activeSkillNames: [], modelSelection: {}, title: "Existing work", projectTodo: { todoId: "ready", entry: "work" }, createdAt: 1, updatedAt: 2 }] });
    if (path.endsWith("/automations")) return Response.json({ automations: [{ id: "auto-1", projectSlug: "demo", createdFromSessionId: "work-0", projectTodoId: "ready", name: "Nightly", trigger: { kind: "once", at: "2026-01-01" }, action: { kind: "start_session", message: "go", location: "project" }, status: "active", createdAt: "2026-01-01", updatedAt: "2026-01-02" }] });
    return new Response("not found", { status: 404 });
  }) });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => { await act(async () => root.unmount()); client.clear(); dom.window.close(); });

async function render(): Promise<void> {
  await act(async () => root.render(<QueryClientProvider client={client}><WorkbenchLayoutProvider><MemoryRouter initialEntries={["/projects/demo/todos?todo=ready"]}><Routes><Route path="/projects/:slug/todos" element={<ProjectTodosRoute />} /></Routes></MemoryRouter></WorkbenchLayoutProvider></QueryClientProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe("Project Todos board", () => {
  test("groups the four canonical board states and excludes rejected Todos", () => {
    expect(deriveProjectTodoGroups(todos)).toMatchObject({ idea: [todos[0]], ready: [todos[1]], in_progress: [todos[2]], done: [todos[3]] });
  });

  test("keeps a drag order local and computes cross-lane placement without a general board model", () => {
    expect(moveTodoInBoard({ idea: ["idea"], ready: ["ready"], in_progress: ["progress"], done: ["done"] }, "ready", "in_progress", 0)).toEqual({ idea: ["idea"], ready: [], in_progress: ["ready", "progress"], done: ["done"] });
  });

  test("reorders in both same-lane directions at the hovered index", () => {
    const order = { idea: ["a", "b", "c"], ready: [], in_progress: [], done: [] };
    expect(moveTodoInBoard(order, "a", "idea", 1).idea).toEqual(["b", "a", "c"]);
    expect(moveTodoInBoard(order, "c", "idea", 0).idea).toEqual(["c", "a", "b"]);
  });

  test("announces the Todo title, target lane, position, completion, and cancellation", () => {
    const order = { idea: ["idea"], ready: ["ready"], in_progress: ["progress"], done: ["done"] };
    const announcements = createDragAnnouncements(order, new Map(todos.map((todo) => [todo.id, todo])));
    const active = { id: "ready" };
    const over = { id: "progress" };
    const dropped = createDragAnnouncements(
      { idea: ["idea"], ready: [], in_progress: ["ready", "progress"], done: ["done"] },
      new Map(todos.map((todo) => [todo.id, todo])),
    );

    expect(announcements.onDragStart({ active })).toBe("Picked up Ready.");
    expect(announcements.onDragOver({ active, over })).toBe("Moving Ready to In Progress, position 1 of 1.");
    expect(dropped.onDragEnd({ active, over })).toBe("Dropped Ready in In Progress, position 1 of 2.");
    expect(announcements.onDragCancel({ active })).toBe("Cancelled move for Ready.");
  });

  test("requires Ready to enter In Progress before continuing existing work", () => {
    expect(continueWorkUpdateInput(todos[1]!)).toEqual({ expectedRevision: 1, status: "in_progress" });
    expect(continueWorkUpdateInput(todos[2]!)).toBeUndefined();
    expect(continueWorkUpdateInput(todos[3]!)).toBeUndefined();
  });

  test("renders four lanes and an accessible drag handle", async () => {
    await render();
    expect(document.querySelector('[data-testid="todo-lane-idea"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="todo-lane-ready"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="todo-lane-in_progress"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="todo-lane-done"]')).not.toBeNull();
    const handle = document.querySelector('[aria-label="Drag Ready"]') as HTMLButtonElement;
    expect(handle).not.toBeNull();
    expect(handle.className).toContain("min-h-11");
    expect(handle.className).toContain("w-11");
    expect(handle.className).toContain("cursor-grab");
    expect(document.querySelector('[data-testid="todo-open-ready"]')?.className).toContain("cursor-pointer");
  });

});
