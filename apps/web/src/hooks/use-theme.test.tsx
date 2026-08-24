import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ThemeProvider, useTheme } from "./use-theme";

const originals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
let root: Root;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html data-theme="dark"><body><div id="root"></div></body></html>', { url: "http://localhost/" });
  Object.defineProperty(dom.window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    StorageEvent: dom.window.StorageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  root = createRoot(document.getElementById("root")!);
});

afterEach(async () => {
  await act(async () => root.unmount());
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  dom.window.close();
});

function ThemeProbe() {
  const { theme, toggleTheme } = useTheme();
  return <button type="button" onClick={toggleTheme}>{theme}</button>;
}

describe("ThemeProvider", () => {
  test("commits one storage write for one toggle under StrictMode", async () => {
    window.localStorage.setItem("archcodeTheme", "dark");
    const originalSetItem = dom.window.Storage.prototype.setItem;
    const setItem = mock(function (this: Storage, key: string, value: string) {
      originalSetItem.call(this, key, value);
    });
    Object.defineProperty(dom.window.Storage.prototype, "setItem", { configurable: true, value: setItem });

    await act(async () => root.render(<StrictMode><ThemeProvider><ThemeProbe /></ThemeProvider></StrictMode>));
    setItem.mockClear();
    await act(async () => (document.querySelector("button") as HTMLButtonElement).click());

    expect(setItem).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem("archcodeTheme")).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector("button")?.textContent).toBe("light");
  });

  test("converges state and document theme from a cross-tab storage event", async () => {
    window.localStorage.setItem("archcodeTheme", "dark");
    await act(async () => root.render(<ThemeProvider><ThemeProbe /></ThemeProvider>));

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", {
        key: "archcodeTheme",
        newValue: "light",
        storageArea: window.localStorage,
      }));
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector("button")?.textContent).toBe("light");
  });

  test("uses the system theme when storage reads are blocked", async () => {
    Object.defineProperty(dom.window.Storage.prototype, "getItem", {
      configurable: true,
      value: () => { throw new DOMException("blocked", "SecurityError"); },
    });

    await act(async () => root.render(<ThemeProvider><ThemeProbe /></ThemeProvider>));

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector("button")?.textContent).toBe("light");
  });

  test("keeps the current tab theme usable when storage writes are blocked", async () => {
    window.localStorage.setItem("archcodeTheme", "dark");
    Object.defineProperty(dom.window.Storage.prototype, "setItem", {
      configurable: true,
      value: () => { throw new DOMException("full", "QuotaExceededError"); },
    });

    await act(async () => root.render(<StrictMode><ThemeProvider><ThemeProbe /></ThemeProvider></StrictMode>));
    await act(async () => (document.querySelector("button") as HTMLButtonElement).click());

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.querySelector("button")?.textContent).toBe("light");
  });
});
