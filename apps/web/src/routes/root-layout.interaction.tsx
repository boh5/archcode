import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { JSDOM } from "jsdom";
import { createStore } from "zustand/vanilla";

const originals = new Map<string, PropertyDescriptor | undefined>();
const hitlStore = createStore(() => ({ views: {} }));

mock.module("../components/features/ProjectBar", () => ({
  ProjectBar: () => <nav aria-label="Projects" data-testid="project-bar">Projects</nav>,
}));
mock.module("../components/features/ContextInspector", () => ({
  ContextInspector: () => <aside data-testid="context-inspector">Inspector</aside>,
}));
mock.module("../components/features/ResizeHandle", () => ({
  ResizeHandle: ({ controls }: { controls: string }) => <div role="separator" aria-controls={controls} />,
}));
mock.module("../components/features/HitlBell", () => ({ HitlBell: () => null }));
mock.module("../context/add-project-modal", () => ({
  useAddProjectModal: () => ({ openAddProjectModal: () => {} }),
}));
mock.module("../context/settings-modal", () => ({
  useSettingsModal: () => ({ openSettingsModal: () => {} }),
}));
mock.module("../context/global-sse", () => ({
  useGlobalSSE: () => ({ hitlNoticeIdentities: [] }),
  resolveHitlNoticeEntries: () => [],
}));
mock.module("../store/hitl-store", () => ({
  hitlStore,
  hitlAttentionPath: () => "/",
  scopedHitlIdentity: () => "hitl",
  useAttentionVisibleScopedHitl: () => [],
  selectSessionFamilyHitl: () => [],
}));
mock.module("../store/session-runtime-store", () => ({
  runtimeFamilyKey: (slug: string, sessionId: string) => `${slug}:${sessionId}`,
  useSessionRuntimeFamilies: () => ({}),
  useSessionRuntimeInitialized: () => true,
}));
mock.module("../api/queries", () => ({
  useProjects: () => ({ data: [] }),
  useSessions: () => ({
    data: [{
      sessionId: "root",
      rootSessionId: "root",
      title: "Root session",
      updatedAt: 2,
    }],
  }),
  useAutomations: () => ({
    data: [{
      id: "automation-1",
      name: "Nightly review",
      status: "active",
      trigger: { kind: "interval", everyMs: 60_000 },
      action: { kind: "run_session" },
    }],
  }),
}));
mock.module("../api/mutations", () => ({
  useCreateSession: () => ({ mutate: () => {}, isPending: false }),
  usePostMessage: () => ({ mutate: () => {} }),
}));
mock.module("../components/features/ProjectActionMenu", () => ({ ProjectActionDropdown: () => null }));
mock.module("../components/features/EditProjectDialog", () => ({ EditProjectDialog: () => null }));
mock.module("../components/features/CloseProjectDialog", () => ({ CloseProjectDialog: () => null }));

const { RootLayout } = await import("./root-layout");

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/projects/demo/sessions/root",
  });
  Object.defineProperty(dom.window, "innerWidth", { value: 1440, configurable: true });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({
      matches: false,
      media: "(max-width: 760px)",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }),
    configurable: true,
  });
  dom.window.localStorage.setItem("archcode.workbench.layout", JSON.stringify({
    sidebarWidth: 337,
    inspectorWidth: 360,
    sidebarCollapsed: false,
    inspectorCollapsed: false,
    focusMode: false,
  }));
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    Event: dom.window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
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

describe("RootLayout persistent project shell", () => {
  test("keeps Project Bar, Sidebar DOM and local state while only the routed canvas changes", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    const router = createMemoryRouter([{
      element: <RootLayout />,
      children: [
        { path: "/projects/:slug", element: <div data-testid="canvas">Dashboard canvas</div> },
        { path: "/projects/:slug/todos", element: <div data-testid="canvas">Todos canvas</div> },
        { path: "/projects/:slug/sessions/:sessionId", element: <div data-testid="canvas">Session canvas</div> },
      ],
    }], { initialEntries: ["/projects/demo/sessions/root"] });

    await act(async () => root.render(<RouterProvider router={router} />));
    const projectBarBefore = container.querySelector('[data-testid="project-bar"]');
    const sidebarBefore = container.querySelector("#project-sidebar")!;
    expect(sidebarBefore.parentElement?.getAttribute("style")).toContain("width: 337px");

    const automationsTab = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((element) => element.textContent === "Automations")!;
    await act(async () => automationsTab.click());
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search automations"]')!;
    await act(async () => {
      const previous = search.value;
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(search, "nightly");
      (search as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
      const propsKey = Object.keys(search).find((key) => key.startsWith("__reactProps$"));
      const props = propsKey
        ? (search as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]
        : undefined;
      props?.onChange?.({ target: search });
    });

    await act(async () => { await router.navigate("/projects/demo"); });
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe("Dashboard canvas");
    expect(container.querySelector('[data-testid="project-bar"]')).toBe(projectBarBefore);
    expect(container.querySelector("#project-sidebar")).toBe(sidebarBefore);
    expect(automationsTab.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Search automations"]')?.value).toBe("nightly");
    expect(container.querySelector('[data-testid="context-inspector"]')).toBeNull();

    const collapse = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse project sidebar"]')!;
    await act(async () => collapse.click());
    expect(container.querySelector("#project-sidebar")).toBeNull();
    await act(async () => { await router.navigate("/projects/demo/todos"); });
    expect(container.querySelector("#project-sidebar")).toBeNull();
    expect(container.querySelector('[data-testid="canvas"]')?.textContent).toBe("Todos canvas");

    const expand = container.querySelector<HTMLButtonElement>('button[aria-label="Expand project sidebar"]')!;
    await act(async () => expand.click());
    expect(container.querySelector("#project-sidebar")?.parentElement?.getAttribute("style")).toContain("width: 337px");

    await act(async () => root.unmount());
    dom.window.close();
  });
});
