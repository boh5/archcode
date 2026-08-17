import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { JSDOM } from "jsdom";
import type { Project } from "../api/types";

const project: Project = { slug: "demo", name: "Demo", workspaceRoot: "/repo", addedAt: "2026-01-01T00:00:00.000Z" };
let projectsQuery: Record<string, unknown>;
const refetch = mock(() => Promise.resolve());

mock.module("../api/queries", () => ({ useProjects: () => projectsQuery }));
mock.module("../components/features/ContextInspector", () => ({ ContextInspector: () => <aside>Inspector</aside> }));
mock.module("../components/features/ProjectTodoCaptureDialog", () => ({ ProjectTodoCaptureDialog: () => null }));
mock.module("../components/features/ProjectTodoNavigator", () => ({ ProjectTodoNavigator: ({ project: item }: { project: Project }) => <nav data-testid="todo-navigator">{item.name}</nav> }));
mock.module("../components/features/ResizeHandle", () => ({ ResizeHandle: () => <div role="separator" /> }));
mock.module("../context/workbench-layout", () => ({
  useWorkbenchLayout: () => ({
    isNavigatorDrawer: false,
    navigatorDrawerOpen: false,
    openNavigatorDrawer: () => {},
    closeNavigatorDrawer: () => {},
    isInspectorOverlay: false,
    inspectorCollapsed: false,
    inspectorOverlayOpen: false,
    inspectorReturnFocusRef: { current: null },
    navigatorDrawerReturnFocusRef: { current: null },
    closeInspectorOverlay: () => {},
  }),
  useWorkbenchPanelSizes: () => ({ inspectorWidth: 312, setInspectorWidth: () => {} }),
  useCloseWorkbenchOverlaysOnNavigation: () => {},
}));
mock.module("./root-entry", () => ({ LAST_PROJECT_STORAGE_KEY: "archcode.last-project" }));
mock.module("./use-project-todo-navigation", () => ({
  useProjectTodoNavigation: () => ({
    projection: {
      allTodos: { count: 0, current: true, state: "ready" },
      needsYou: { count: 0, rows: [], state: "ready" },
      inProgress: { count: 0, rows: [], state: "ready" },
      ready: { count: 0, rows: [], state: "ready" },
      runs: { count: 0, current: false, state: "ready" },
      schedules: { count: 0, current: false, state: "ready" },
    },
    retry: () => {},
    retrying: false,
  }),
}));

const { ProjectLayout, ProjectRoute } = await import("./project");
const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(path: string): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `http://localhost${path}` });
  Object.defineProperty(dom.window, "innerWidth", { value: 1440, configurable: true });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
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

afterEach(() => { restoreDom(); refetch.mockClear(); });

describe("ProjectLayout", () => {
  test("owns the Todo navigator and records a successfully verified project", async () => {
    const dom = installDom("/projects/demo/todos");
    projectsQuery = { data: [project], error: null, isLoading: false, isFetching: false, refetch };
    const router = createMemoryRouter([{ path: "/projects/:slug", element: <ProjectLayout />, children: [{ path: "todos", element: <div data-testid="canvas">Todos</div> }] }], { initialEntries: ["/projects/demo/todos"] });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(document.querySelector('[data-testid="todo-navigator"]')?.textContent).toBe("Demo");
    expect(document.querySelector('[data-testid="canvas"]')?.textContent).toBe("Todos");
    expect(dom.window.localStorage.getItem("archcode.last-project")).toBe("demo");
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("redirects an unknown slug only after a successful registry response", async () => {
    const dom = installDom("/projects/missing");
    dom.window.localStorage.setItem("archcode.last-project", "missing");
    projectsQuery = { data: [project], error: null, isLoading: false, isFetching: false, refetch };
    const router = createMemoryRouter([{ path: "/", element: <div data-testid="root-entry">Root</div> }, { path: "/projects/:slug", element: <ProjectLayout /> }], { initialEntries: ["/projects/missing"] });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(document.querySelector('[data-testid="root-entry"]')?.textContent).toBe("Root");
    expect(dom.window.localStorage.getItem("archcode.last-project")).toBeNull();
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("keeps the failed project URL in place and exposes Retry", async () => {
    const dom = installDom("/projects/demo");
    projectsQuery = { data: undefined, error: new Error("offline"), isLoading: false, isFetching: false, refetch };
    const router = createMemoryRouter([{ path: "/projects/:slug", element: <ProjectLayout /> }], { initialEntries: ["/projects/demo"] });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<RouterProvider router={router} />));
    const retry = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Retry"))!;
    await act(async () => retry.click());
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(router.state.location.pathname).toBe("/projects/demo");
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("redirects the project index to All todos with replace semantics", async () => {
    const dom = installDom("/projects/demo");
    const router = createMemoryRouter([{ path: "/projects/:slug", children: [{ index: true, element: <ProjectRoute /> }, { path: "todos", element: <div data-testid="todos">Todos</div> }] }], { initialEntries: ["/projects/demo"] });
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(router.state.location.pathname).toBe("/projects/demo/todos");
    await act(async () => root.unmount());
    dom.window.close();
  });
});
