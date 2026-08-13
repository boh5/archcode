import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { Pencil } from "lucide-react";
import { IconAction } from "./IconAction";

const originals = new Map<string, PropertyDescriptor | undefined>();
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let nextTimerId = 1;
let scheduledTimers = new Map<number, TimerHandler>();

function installDom(): void {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  container = document.getElementById("root") as HTMLDivElement;
  root = createRoot(container);
  nextTimerId = 1;
  scheduledTimers = new Map();
  globalThis.setTimeout = ((callback: TimerHandler) => {
    const id = nextTimerId++;
    scheduledTimers.set(id, callback);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    if (id !== undefined) scheduledTimers.delete(id);
  }) as typeof clearTimeout;
}

function restoreDom(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

afterEach(() => {
  act(() => root?.unmount());
  dom?.window.close();
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  scheduledTimers.clear();
  restoreDom();
});

async function flushTimers(): Promise<void> {
  const callbacks = [...scheduledTimers.values()];
  scheduledTimers.clear();
  await act(async () => {
    for (const callback of callbacks) {
      if (typeof callback === "function") callback();
    }
  });
}

describe("IconAction", () => {
  test("keeps the original click synchronous and portals a focus tooltip", async () => {
    installDom();
    const onClick = mock(() => {});
    await act(async () => root.render(<IconAction label="Edit goal" onClick={onClick}><Pencil size={14} /></IconAction>));
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toBe("Edit goal");
    expect(button.className).toContain("h-8 w-8");

    button.click();
    expect(onClick).toHaveBeenCalledTimes(1);
    await act(async () => button.focus());
    const tooltip = document.body.querySelector('[role="tooltip"]') as HTMLElement;
    expect(tooltip?.textContent).toBe("Edit goal");
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThanOrEqual(8);

    await act(async () => button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  test("opens the delayed hover tooltip only when its controlled timer fires", async () => {
    installDom();
    await act(async () => root.render(<IconAction label="Pause goal"><span>icon</span></IconAction>));
    const button = container.querySelector("button") as HTMLButtonElement;

    await act(async () => button.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

    await flushTimers();
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe("Pause goal");

    await act(async () => button.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true })));
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

});
