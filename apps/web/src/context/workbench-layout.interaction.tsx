import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { WorkbenchLayoutProvider, useWorkbenchLayout, useWorkbenchPanelSizes } from "./workbench-layout";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(width: number): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" });
  Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true, writable: true });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Event: dom.window.Event, IS_REACT_ACT_ENVIRONMENT: true })) {
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

function Probe() {
  const layout = useWorkbenchLayout();
  const sizes = useWorkbenchPanelSizes();
  return <>
    <button type="button" aria-controls="context-inspector" aria-expanded={layout.inspectorExpanded} onClick={layout.openInspectorSurface}>Open inspector</button>
    <button type="button" onClick={layout.toggleInspectorSurface}>Toggle inspector</button>
    <button type="button" aria-controls="project-todo-drawer" onClick={layout.openNavigatorDrawer}>Open navigator</button>
    <button type="button" onClick={() => sizes.setInspectorWidth(420)}>Resize inspector</button>
    {layout.isNavigatorDrawer
      ? layout.navigatorDrawerOpen ? <div data-project-todo-drawer><a href="#drawer">Drawer Todo</a></div> : null
      : <nav data-project-todo-navigator><a href="#sibling" aria-current="page">Sibling Todo</a></nav>}
    {layout.isInspectorOverlay
      ? layout.inspectorOverlayOpen ? <aside id="context-inspector"><button type="button" role="tab" tabIndex={0}>Overlay Context</button></aside> : null
      : !layout.inspectorCollapsed ? <aside id="context-inspector"><button type="button" role="tab" tabIndex={0}>Sibling Context</button></aside> : null}
    <output data-testid="navigator-drawer">{String(layout.isNavigatorDrawer)}</output><output data-testid="navigator-open">{String(layout.navigatorDrawerOpen)}</output><output data-testid="inspector-overlay">{String(layout.isInspectorOverlay)}</output><output data-testid="inspector-open">{String(layout.inspectorOverlayOpen)}</output><output data-testid="inspector-expanded">{String(layout.inspectorExpanded)}</output><output data-testid="inspector-collapsed">{String(layout.inspectorCollapsed)}</output><output data-testid="inspector-width">{String(sizes.inspectorWidth)}</output><output data-testid="inspector-return-focus">{layout.inspectorReturnFocusRef.current?.textContent ?? "none"}</output><output data-testid="navigator-return-focus">{layout.navigatorDrawerReturnFocusRef.current?.textContent ?? "none"}</output>
  </>;
}

afterEach(restoreDom);

describe("WorkbenchLayout responsive surfaces", () => {
  test("opens the Inspector overlay at 1260px and remembers the exact trigger", async () => {
    const dom = installDom(1260);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));
    const opener = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Open inspector")!;
    opener.focus();
    await act(async () => opener.click());
    expect(document.querySelector('[data-testid="inspector-overlay"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="inspector-open"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="inspector-expanded"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="inspector-return-focus"]')?.textContent).toBe("Open inspector");
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("keeps sibling Inspector collapse and width preferences at 1261px", async () => {
    const dom = installDom(1261);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));
    const buttons = Array.from(document.querySelectorAll("button"));
    await act(async () => buttons.find((button) => button.textContent === "Toggle inspector")!.click());
    await act(async () => buttons.find((button) => button.textContent === "Resize inspector")!.click());
    expect(document.querySelector('[data-testid="inspector-overlay"]')?.textContent).toBe("false");
    expect(document.querySelector('[data-testid="inspector-collapsed"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="inspector-width"]')?.textContent).toBe("420");
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("hard-cuts the Todo navigator between 980px drawer and 981px sibling", async () => {
    const dom = installDom(980);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));
    const opener = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Open navigator")!;
    opener.focus();
    await act(async () => opener.click());
    const drawerLink = document.querySelector('[data-project-todo-drawer] a') as HTMLAnchorElement;
    drawerLink.focus();
    expect(document.querySelector('[data-testid="navigator-drawer"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="navigator-open"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="navigator-return-focus"]')?.textContent).toBe("Open navigator");
    Object.defineProperty(dom.window, "innerWidth", { value: 981, configurable: true, writable: true });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    expect(document.querySelector('[data-testid="navigator-drawer"]')?.textContent).toBe("false");
    expect(document.querySelector('[data-testid="navigator-open"]')?.textContent).toBe("false");
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 10)));
    expect(document.activeElement?.textContent).toBe("Sibling Todo");

    Object.defineProperty(dom.window, "innerWidth", { value: 980, configurable: true, writable: true });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(opener);
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves Inspector focus in both directions across 1260/1261", async () => {
    const dom = installDom(1261);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));
    const opener = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Open inspector")!;
    const siblingTab = document.querySelector('#context-inspector [role="tab"]') as HTMLButtonElement;
    siblingTab.focus();

    Object.defineProperty(dom.window, "innerWidth", { value: 1260, configurable: true, writable: true });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 10)));
    expect(document.activeElement).toBe(opener);

    await act(async () => opener.click());
    const overlayTab = document.querySelector('#context-inspector [role="tab"]') as HTMLButtonElement;
    overlayTab.focus();
    expect(document.activeElement).toBe(overlayTab);
    expect(document.activeElement instanceof HTMLElement).toBe(true);
    expect((document.activeElement as HTMLElement).closest("#context-inspector")).not.toBeNull();
    Object.defineProperty(dom.window, "innerWidth", { value: 1261, configurable: true, writable: true });
    await act(async () => dom.window.dispatchEvent(new dom.window.Event("resize")));
    await act(async () => new Promise((resolve) => dom.window.setTimeout(resolve, 10)));
    expect(document.querySelector('[data-testid="inspector-collapsed"]')?.textContent).toBe("false");
    expect(document.querySelector('#context-inspector [role="tab"]')?.textContent).toBe("Sibling Context");
    expect(document.activeElement?.textContent).toBe("Sibling Context");

    await act(async () => root.unmount());
    dom.window.close();
  });
});
