import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { WorkbenchLayoutProvider } from "../../context/workbench-layout";
import { SidebarToggleButton } from "./SidebarToggleButton";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
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
  });
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

afterEach(restoreDom);

describe("SidebarToggleButton", () => {
  test("keeps one work-canvas control mounted while the sidebar state changes", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);

    await act(async () => root.render(
      <WorkbenchLayoutProvider>
        <header><SidebarToggleButton /></header>
      </WorkbenchLayoutProvider>,
    ));

    const button = container.querySelector<HTMLButtonElement>("header > button")!;
    expect(button.getAttribute("aria-label")).toBe("Collapse project sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.className).toContain("h-8");
    expect(button.className).not.toContain("border-border-default");

    button.focus();
    await act(async () => button.click());
    expect(container.querySelector("header > button")).toBe(button);
    expect(button.getAttribute("aria-label")).toBe("Expand project sidebar");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    expect(button.querySelector(".lucide-panel-left-open")).not.toBeNull();

    await act(async () => root.unmount());
    dom.window.close();
  });
});
