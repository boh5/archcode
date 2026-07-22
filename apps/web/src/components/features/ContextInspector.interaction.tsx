import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { JSDOM } from "jsdom";

const originals = new Map<string, PropertyDescriptor | undefined>();

mock.module("./context-inspector/SessionInspector", () => ({
  SessionInspector: ({ activeTab }: { activeTab: string }) => <div data-testid="active-panel">{activeTab}</div>,
}));

const { ContextInspector } = await import("./ContextInspector");

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: "http://localhost/projects/demo/sessions/root",
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
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

describe("ContextInspector keyboard tabs", () => {
  test("supports ArrowLeft/ArrowRight/Home/End while keeping focus and URL state aligned", async () => {
    const dom = installDom();
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => root.render(
      <MemoryRouter initialEntries={["/projects/demo/sessions/root"]}>
        <ContextInspector kind="session" />
      </MemoryRouter>,
    ));

    const tab = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((element) => element.textContent === label)!;
    const key = async (target: HTMLButtonElement, value: string) => {
      target.focus();
      await act(async () => target.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: value,
        bubbles: true,
      })));
    };

    expect(tab("Agents").getAttribute("aria-selected")).toBe("true");
    await key(tab("Agents"), "ArrowRight");
    expect(tab("Changes").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Changes"));
    expect(container.querySelector('[data-testid="active-panel"]')?.textContent).toBe("changes");

    await key(tab("Changes"), "End");
    expect(tab("Context").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Context"));

    await key(tab("Context"), "Home");
    expect(tab("Agents").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Agents"));

    await key(tab("Agents"), "ArrowLeft");
    expect(tab("Context").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Context"));

    await act(async () => root.unmount());
    dom.window.close();
  });
});
