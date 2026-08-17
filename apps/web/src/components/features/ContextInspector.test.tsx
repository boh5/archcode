import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { JSDOM } from "jsdom";
import { InspectorShell, sessionInspectorTabs } from "./ContextInspector";
import type { SessionInspectorProjection } from "./context-inspector/session-inspector-projection";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost/" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
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

function projection(input: { agents?: number; changes?: number; loading?: boolean; error?: unknown }): SessionInspectorProjection {
  return {
    agents: {
      items: Array.from({ length: input.agents ?? 0 }, (_, index) => ({ sessionId: `agent-${index}` })) as never,
      isLoading: input.loading === true,
      error: input.error ?? null,
    },
    changes: {
      files: Array.from({ length: input.changes ?? 0 }, (_, index) => ({ path: `file-${index}` })) as never,
      isLoading: input.loading === true,
      error: input.error ?? null,
    },
  };
}

afterEach(restoreDom);

describe("ContextInspector tabs", () => {
  test("derives authoritative loading, zero, unavailable, and updated counts", () => {
    expect(sessionInspectorTabs(projection({ loading: true })).map((tab) => tab.count)).toEqual(["loading", "loading", undefined]);
    expect(sessionInspectorTabs(projection({})).map((tab) => tab.count)).toEqual([0, 0, undefined]);
    expect(sessionInspectorTabs(projection({ agents: 3, changes: 2 })).map((tab) => tab.count)).toEqual([3, 2, undefined]);
    expect(sessionInspectorTabs(projection({ error: new Error("offline") })).map((tab) => tab.count)).toEqual(["unavailable", "unavailable", undefined]);
  });

  test("renders count updates and preserves Arrow/Home/End roving focus", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const render = (value: SessionInspectorProjection) => (
      <MemoryRouter>
        <InspectorShell
          id="test-inspector"
          kind="session"
          tabs={sessionInspectorTabs(value)}
          renderPanel={(activeTab) => <div>{activeTab}</div>}
        />
      </MemoryRouter>
    );

    await act(async () => root.render(render(projection({ loading: true }))));
    expect(document.querySelector('[data-testid="inspector-count-agents"]')?.textContent).toBe("…");
    await act(async () => root.render(render(projection({ agents: 2, changes: 0 }))));
    expect(document.querySelector('[data-testid="inspector-count-agents"]')?.textContent).toBe("2");
    expect(document.querySelector('[data-testid="inspector-count-changes"]')?.textContent).toBe("0");
    expect(document.querySelector('[role="tablist"]')?.className).toContain("gap-[3px]");
    expect(document.querySelector('[data-testid="inspector-count-agents"]')?.className).toContain("min-w-4");
    expect(document.querySelector('[data-testid="inspector-count-agents"]')?.className).toContain("rounded-full");
    expect(document.querySelector('[role="tab"]')?.className).toContain("after:left-[7px]");

    const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    tabs[0]!.focus();
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    await act(async () => tabs[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);
    await act(async () => tabs[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(tabs[0]);
    await act(async () => tabs[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(document.activeElement).toBe(tabs[2]);

    await act(async () => root.unmount());
    dom.window.close();
  });
});
