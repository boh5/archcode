import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { WorkbenchLayoutProvider, useWorkbenchLayout } from "./workbench-layout";
import { focusElementAfterLayoutChange } from "../lib/focus-control";

const originals = new Map<string, PropertyDescriptor | undefined>();

interface MutableMediaQuery {
  media: MediaQueryList;
  setMatches: (matches: boolean) => void;
}

function installDom(initialMatches = true): JSDOM & { mutableMedia: MutableMediaQuery } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: initialMatches,
    media: "(max-width: 799px)",
    onchange: null,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(dom.window, "matchMedia", { value: () => media, configurable: true });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return Object.assign(dom, {
    mutableMedia: {
      media: media as unknown as MediaQueryList,
      setMatches: (matches: boolean) => {
        media.matches = matches;
        const event = { matches, media: media.media } as MediaQueryListEvent;
        for (const listener of listeners) listener(event);
      },
    },
  });
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
  return (
    <>
      <button type="button" aria-expanded={layout.inspectorExpanded} onClick={() => layout.setMobileInspectorOpen(true)}>Open</button>
      {layout.mobileInspectorOpen && <button type="button" onClick={() => layout.setMobileInspectorOpen(false)}>Close</button>}
      <output data-testid="return-focus">{layout.mobileInspectorReturnFocusRef.current?.textContent ?? "none"}</output>
      <output data-testid="mobile-mode">{String(layout.isMobile)}</output>
      <output data-testid="navigation-open">{String(layout.mobileNavigationOpen)}</output>
      <output data-testid="inspector-open">{String(layout.mobileInspectorOpen)}</output>
      <button type="button" onClick={() => layout.setMobileNavigationOpen(true)}>Open navigation</button>
      <button type="button" onClick={layout.toggleFocusMode}>Toggle focus</button>
      <output data-testid="focus-mode">{String(layout.focusMode)}</output>
      <nav aria-label="Projects"><button type="button" aria-label="Open dashboard">Desktop dashboard</button></nav>
      <button type="button" data-state={layout.inspectorCollapsed ? "collapsed" : "expanded"} aria-controls="context-inspector">Desktop inspector</button>
      <aside id="context-inspector"><button type="button" role="tab" tabIndex={0}>Inspector active tab</button></aside>
      <button type="button" aria-label="Open work navigation">Compact navigation</button>
      <button type="button" aria-label="Open context inspector">Compact inspector</button>
      <div role="separator" tabIndex={0} aria-controls="project-sidebar">Project sidebar resize</div>
      <div role="separator" tabIndex={0} aria-controls="context-inspector">Context inspector resize</div>
    </>
  );
}

afterEach(restoreDom);

describe("WorkbenchLayout mobile inspector", () => {
  test("announces the drawer state and records the actual opener for focus restoration", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const open = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open")!;
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="mobile-mode"]')?.textContent).toBe("true");
    open.focus();
    await act(async () => open.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="return-focus"]')?.textContent).toBe("Open");

    const close = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Close")!;
    close.focus();
    await act(async () => close.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="return-focus"]')?.textContent).toBe("Open");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("closes mobile surfaces when the viewport leaves the mobile breakpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const buttons = Array.from(container.querySelectorAll("button"));
    const openNavigation = buttons.find((button) => button.textContent === "Open navigation")!;
    await act(async () => openNavigation.click());
    expect(container.querySelector('[data-testid="inspector-open"]')?.textContent).toBe("false");
    expect(container.querySelector('[data-testid="navigation-open"]')?.textContent).toBe("true");
    openNavigation.focus();

    await act(async () => dom.mutableMedia.setMatches(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(container.querySelector('[data-testid="mobile-mode"]')?.textContent).toBe("false");
    expect(container.querySelector('[data-testid="navigation-open"]')?.textContent).toBe("false");
    expect(container.querySelector('[data-testid="inspector-open"]')?.textContent).toBe("false");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open dashboard");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves focus from a mobile inspector to its visible desktop surface at the breakpoint", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const openInspector = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Open")!;
    await act(async () => openInspector.click());
    openInspector.focus();
    await act(async () => dom.mutableMedia.setMatches(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.activeElement?.textContent).toBe("Inspector active tab");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves desktop navigation focus to the compact navigation trigger at the mobile breakpoint", async () => {
    const dom = installDom(false);
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const dashboard = container.querySelector('button[aria-label="Open dashboard"]') as HTMLButtonElement;
    dashboard.focus();
    await act(async () => dom.mutableMedia.setMatches(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open work navigation");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves desktop inspector focus to the compact inspector trigger at the mobile breakpoint", async () => {
    const dom = installDom(false);
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const inspectorTab = Array.from(container.querySelectorAll('[role="tab"]')).find((element) => element.textContent === "Inspector active tab") as HTMLButtonElement;
    inspectorTab.focus();
    await act(async () => dom.mutableMedia.setMatches(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open context inspector");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves desktop sidebar resize focus to compact navigation at the mobile breakpoint", async () => {
    const dom = installDom(false);
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    (container.querySelector('[role="separator"][aria-controls="project-sidebar"]') as HTMLElement).focus();
    await act(async () => dom.mutableMedia.setMatches(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open work navigation");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("moves desktop inspector resize focus to compact inspector at the mobile breakpoint", async () => {
    const dom = installDom(false);
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    (container.querySelector('[role="separator"][aria-controls="context-inspector"]') as HTMLElement).focus();
    await act(async () => dom.mutableMedia.setMatches(true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open context inspector");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("entering focus mode closes mobile navigation instead of leaving a hidden open drawer", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const buttons = Array.from(container.querySelectorAll("button"));
    await act(async () => buttons.find((button) => button.textContent === "Open navigation")!.click());
    expect(container.querySelector('[data-testid="navigation-open"]')?.textContent).toBe("true");
    await act(async () => buttons.find((button) => button.textContent === "Toggle focus")!.click());
    expect(container.querySelector('[data-testid="focus-mode"]')?.textContent).toBe("true");
    expect(container.querySelector('[data-testid="navigation-open"]')?.textContent).toBe("false");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("hands focus to the replacement control after a desktop layout transition", async () => {
    const dom = installDom();
    const replacement = document.createElement("button");
    replacement.setAttribute("aria-label", "Expand project sidebar");
    document.body.append(replacement);

    focusElementAfterLayoutChange('button[aria-label="Expand project sidebar"]');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(document.activeElement).toBe(replacement);

    dom.window.close();
  });
});
