import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { WorkbenchLayoutProvider, useWorkbenchLayout, useWorkbenchPanelSizes } from "./workbench-layout";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(initialMatches = true): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches: initialMatches,
    media: "(max-width: 760px)",
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
  return (
    <>
      <button type="button" aria-expanded={layout.inspectorExpanded} onClick={layout.openInspectorSurface}>Open inspector</button>
      <button type="button" onClick={layout.toggleInspectorSurface}>Toggle inspector</button>
      <button type="button" onClick={() => sizes.setInspectorWidth(420)}>Resize inspector</button>
      <output data-testid="mobile-mode">{String(layout.isMobile)}</output>
      <output data-testid="inspector-open">{String(layout.mobileInspectorOpen)}</output>
      <output data-testid="inspector-collapsed">{String(layout.inspectorCollapsed)}</output>
      <output data-testid="inspector-width">{String(sizes.inspectorWidth)}</output>
      <output data-testid="return-focus">{layout.mobileInspectorReturnFocusRef.current?.textContent ?? "none"}</output>
    </>
  );
}

afterEach(restoreDom);

describe("WorkbenchLayout inspector state", () => {
  test("opens the mobile inspector and remembers its actual opener", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const opener = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Open inspector")!;
    opener.focus();
    await act(async () => opener.click());

    expect(document.querySelector('[data-testid="mobile-mode"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="inspector-open"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="return-focus"]')?.textContent).toBe("Open inspector");

    await act(async () => root.unmount());
    dom.window.close();
  });

  test("retains desktop inspector collapse and width preferences", async () => {
    const dom = installDom(false);
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(<WorkbenchLayoutProvider><Probe /></WorkbenchLayoutProvider>));

    const buttons = Array.from(document.querySelectorAll("button"));
    await act(async () => buttons.find((button) => button.textContent === "Toggle inspector")!.click());
    await act(async () => buttons.find((button) => button.textContent === "Resize inspector")!.click());

    expect(document.querySelector('[data-testid="inspector-collapsed"]')?.textContent).toBe("true");
    expect(document.querySelector('[data-testid="inspector-width"]')?.textContent).toBe("420");

    await act(async () => root.unmount());
    dom.window.close();
  });
});
