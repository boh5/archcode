import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { InspectorToggleButton } from "./InspectorToggleButton";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
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

describe("InspectorToggleButton", () => {
  test("switches its label and icon with the inspector state", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);

    await act(async () => root.render(<InspectorToggleButton expanded onToggle={() => {}} />));
    let button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Collapse context inspector");
    expect(button.getAttribute("data-state")).toBe("expanded");
    expect(button.className).toContain("max-[799px]:hidden");
    expect(button.querySelector(".lucide-panel-right-close")).not.toBeNull();

    await act(async () => root.render(<InspectorToggleButton expanded={false} onToggle={() => {}} />));
    button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Expand context inspector");
    expect(button.getAttribute("data-state")).toBe("collapsed");
    expect(button.querySelector(".lucide-panel-right-open")).not.toBeNull();

    await act(async () => root.unmount());
    dom.window.close();
  });
});
