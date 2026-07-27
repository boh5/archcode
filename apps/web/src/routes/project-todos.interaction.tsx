import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ProjectTodo } from "../api/types";
import { ProjectTodosRoute } from "./project-todos";

let dom: JSDOM;
let root: Root;
let client: QueryClient;
let responseMode: "success" | "failure";
let patches: Array<Record<string, unknown>>;
let fetchMock: ReturnType<typeof mock>;

const todos: ProjectTodo[] = [
  todo("idea", "Idea", "idea"),
  todo("idea-next", "Next idea", "idea"),
  todo("ready", "Ready", "ready"),
];

function todo(id: string, title: string, status: ProjectTodo["status"]): ProjectTodo {
  return { id, title, body: "", status, revision: 3, createdAt: 1, updatedAt: 1 };
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", { url: "http://localhost/projects/demo/todos" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    TouchEvent: dom.window.TouchEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  Object.defineProperty(dom.window.HTMLElement.prototype, "getBoundingClientRect", { configurable: true, value() { return rectFor(this); } });
  responseMode = "success";
  patches = [];
  fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === "string" ? input : input.toString(), "http://localhost").pathname;
    if (init?.method === "PATCH" && path.endsWith("/todos/idea")) {
      patches.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      if (responseMode === "failure") return Response.json({ error: { code: "CONFLICT", message: "stale Todo" } }, { status: 409 });
      return Response.json({ todo: { ...todos[0], status: "ready" } });
    }
    if (path.endsWith("/todos")) return Response.json({ todos });
    if (path.endsWith("/sessions")) return Response.json({ sessions: [] });
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/projects/demo/todos"]}><Routes><Route path="/projects/:slug/todos" element={<ProjectTodosRoute />} /></Routes></MemoryRouter></QueryClientProvider>);
  });
  await settle();
}

async function settle(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
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
    expect(announcementText()).toContain("Moving Idea to Ideas, position 2 of 2.");

    await key(handle, "ArrowDown");
    expect(patches).toEqual([]);
    expect(laneOrder("idea")).toEqual(["todo-idea-next", "todo-idea"]);

    await key(handle, " ");
    await settle();
    expect(patches).toEqual([{ expectedRevision: 3, beforeTodoId: null }]);
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
