import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { JSDOM } from "jsdom";
import type { ProjectTodoNavigationProjection } from "../../routes/project-todo-navigation";

mock.module("./ProjectActionMenu", () => ({ ProjectActionDropdown: ({ trigger }: { trigger: ReactNode }) => trigger }));
mock.module("./EditProjectDialog", () => ({ EditProjectDialog: () => null }));
mock.module("./CloseProjectDialog", () => ({ CloseProjectDialog: () => null }));

const { ProjectTodoNavigator } = await import("./ProjectTodoNavigator");
const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/projects/demo/todos/active" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return dom;
}

function restoreDom(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

afterEach(restoreDom);

describe("ProjectTodoNavigator", () => {
  test("renders the 276px shell, one New todo trigger, and one duplicate-row current marker", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const todo = { id: "active", content: "# Active work", attachmentIds: [], status: "in_progress" as const, revision: 1, createdAt: 1, updatedAt: 1 };
    const runningTodo = { ...todo, id: "running", content: "# Running work", status: "idea" as const };
    const projection: ProjectTodoNavigationProjection = {
      allTodos: { count: 2, current: false, state: "ready" },
      needsYou: { count: 1, state: "ready", rows: [{ todo, label: "Active work", current: true, attentionCount: 3 }] },
      running: { count: 1, state: "ready", rows: [{ todo: runningTodo, label: "Running work", current: false, targetSessionId: "work-1" }] },
      inProgress: { count: 1, state: "ready", rows: [{ todo, label: "Active work", current: false, operationalState: { label: "Ready to review", kind: "completed" } }] },
      ready: { count: 0, state: "ready", rows: [] },
      runs: { count: 2, current: false, state: "ready" },
      schedules: { count: 3, current: false, state: "ready" },
    };
    const onNewTodo = mock(() => {});
    await act(async () => root.render(<MemoryRouter><ProjectTodoNavigator project={{ slug: "demo", name: "Demo", workspaceRoot: "/repo", addedAt: "2026-01-01" }} projection={projection} newTodoTriggerRef={{ current: null }} retrying={false} onNewTodo={onNewTodo} onProjectClosed={() => {}} onRetry={() => {}} /></MemoryRouter>));

    const navigator = document.querySelector("[data-project-todo-navigator]") as HTMLElement;
    expect(navigator.className).toContain("w-[276px]");
    const triggers = Array.from(document.querySelectorAll("button")).filter((button) => button.textContent?.trim() === "New todo");
    expect(triggers).toHaveLength(1);
    await act(async () => triggers[0]!.click());
    expect(onNewTodo).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    const needsLink = document.querySelector('a[href="/projects/demo/todos/active/work"]');
    expect(needsLink).not.toBeNull();
    expect(needsLink?.querySelector('[aria-label="3 actions need you"]')?.textContent).toBe("3");
    expect(document.querySelector('a[href="/projects/demo/sessions/work-1"]')?.querySelector('[data-navigator-status="live"]')).not.toBeNull();
    const lifecycleLink = document.querySelector('a[href="/projects/demo/todos/active"]');
    expect(lifecycleLink?.querySelector('[data-navigator-status="review"]')?.className).toContain("bg-brand");
    expect(lifecycleLink?.textContent).toContain("Ready to review");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("gives All todos, Runs, and Schedules explicit loading and retryable error states", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const loadingProjection: ProjectTodoNavigationProjection = {
      allTodos: { current: true, state: "loading" },
      needsYou: { count: 0, state: "ready", rows: [] },
      running: { state: "loading", rows: [] },
      inProgress: { count: 0, state: "ready", rows: [] },
      ready: { count: 0, state: "ready", rows: [] },
      runs: { current: false, state: "loading" },
      schedules: { current: false, state: "loading" },
    };
    const onRetry = mock(() => {});
    const navigator = (projection: ProjectTodoNavigationProjection) => <MemoryRouter><ProjectTodoNavigator project={{ slug: "demo", name: "Demo", workspaceRoot: "/repo", addedAt: "2026-01-01" }} projection={projection} newTodoTriggerRef={{ current: null }} retrying={false} onNewTodo={() => {}} onProjectClosed={() => {}} onRetry={onRetry} /></MemoryRouter>;
    await act(async () => root.render(navigator(loadingProjection)));

    expect(Array.from(document.querySelectorAll('[role="status"]')).map((status) => status.getAttribute("aria-label"))).toEqual([
      "All todos loading",
      "Runs loading",
      "Schedules loading",
    ]);
    expect(document.body.textContent).not.toContain("—");

    const errorProjection: ProjectTodoNavigationProjection = {
      ...loadingProjection,
      allTodos: { current: true, state: "error" },
      runs: { current: false, state: "error" },
      schedules: { current: false, state: "error" },
    };
    await act(async () => root.render(navigator(errorProjection)));

    expect(Array.from(document.querySelectorAll('[role="alert"]')).map((alert) => alert.textContent)).toEqual([
      "Unavailable",
      "Unavailable",
      "Unavailable",
    ]);
    const retries = Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-label^="Retry "]'));
    expect(retries.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Retry All todos",
      "Retry Runs",
      "Retry Schedules",
    ]);
    for (const retry of retries) await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("—");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("offers a visible close action when rendered inside the mobile drawer", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const projection: ProjectTodoNavigationProjection = {
      allTodos: { count: 0, current: true, state: "ready" },
      needsYou: { count: 0, state: "ready", rows: [] },
      running: { count: 0, state: "ready", rows: [] },
      inProgress: { count: 0, state: "ready", rows: [] },
      ready: { count: 0, state: "ready", rows: [] },
      runs: { count: 0, current: false, state: "ready" },
      schedules: { count: 0, current: false, state: "ready" },
    };
    const onClose = mock(() => {});
    await act(async () => root.render(<MemoryRouter><ProjectTodoNavigator project={{ slug: "demo", name: "Demo", workspaceRoot: "/repo", addedAt: "2026-01-01" }} projection={projection} newTodoTriggerRef={{ current: null }} retrying={false} onClose={onClose} onNewTodo={() => {}} onProjectClosed={() => {}} onRetry={() => {}} /></MemoryRouter>));

    const close = document.querySelector('button[aria-label="Close navigation"]') as HTMLButtonElement;
    expect(close).not.toBeNull();
    await act(async () => close.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    dom.window.close();
  });
});
