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
mock.module("../components/features/WorkSearchDialog", () => ({
  WorkSearchDialog: () => null,
}));
mock.module("../context/add-project-modal", () => ({ useAddProjectModal: () => ({ openAddProjectModal: () => {} }) }));
mock.module("../context/settings-modal", () => ({ useSettingsModal: () => ({ openSettingsModal: () => {} }) }));
mock.module("../context/global-sse", () => ({
  useGlobalSSE: () => ({ hitlNoticeIdentities: [] }),
  resolveHitlNoticeEntries: () => [],
}));
mock.module("../store/hitl-store", () => ({
  hitlStore,
  hitlAttentionPath: () => "/",
  scopedHitlIdentity: () => "hitl",
}));

const { RootLayout } = await import("./root-layout");
const { ThemeProvider } = await import("../hooks/use-theme");

function installDom(width = 1440): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/projects/demo/sessions/root",
  });
  Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true });
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
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
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

describe("RootLayout global shell", () => {
  test("keeps the Project Bar stable across global and project routes", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const router = createMemoryRouter([{
      element: <RootLayout />,
      children: [
        { path: "/", element: <div data-testid="canvas">Entry</div> },
        { path: "/projects/:slug/todos", element: <div data-testid="canvas">Todos</div> },
      ],
    }], { initialEntries: ["/"] });

    await act(async () => root.render(<ThemeProvider><RouterProvider router={router} /></ThemeProvider>));
    const projectBar = document.querySelector('[data-testid="project-bar"]');
    expect(projectBar?.parentElement?.className).toContain("w-12");
    expect(projectBar?.parentElement?.className).toContain("min-[721px]:w-[52px]");
    await act(async () => { await router.navigate("/projects/demo/todos"); });

    expect(document.querySelector('[data-testid="project-bar"]')).toBe(projectBar);
    expect(document.querySelector('[data-testid="canvas"]')?.textContent).toBe("Todos");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves keyboard focus to the unique work canvas from the skip link", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const router = createMemoryRouter([{
      element: <RootLayout />,
      children: [{ path: "/", element: <div>Entry</div> }],
    }], { initialEntries: ["/"] });

    await act(async () => root.render(<ThemeProvider><RouterProvider router={router} /></ThemeProvider>));
    const skip = document.querySelector('a[href="#work-canvas"]') as HTMLAnchorElement;
    const canvas = document.querySelector("main#work-canvas") as HTMLElement;
    skip.focus();
    await act(async () => skip.click());

    expect(document.activeElement).toBe(canvas);
    expect(document.querySelectorAll("main#work-canvas")).toHaveLength(1);

    await act(async () => root.unmount());
    dom.window.close();
  });
});
