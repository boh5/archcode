import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { TodoProgressButton } from "./TodoProgressButton";
import { __resetWebSessionStoresForTest, getWebSessionStore } from "../../store/session-store";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();
const binding = { selection: { model: "test:model" }, providerId: "test", modelId: "model", providerDisplayName: "Test", modelDisplayName: "Test Model", resolution: "profile_default" as const, modelRuntimeRevision: "m1" };

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  for (const [name, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, MouseEvent: dom.window.MouseEvent, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  __resetWebSessionStoresForTest();
  container = document.getElementById("root")!;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  __resetWebSessionStoresForTest();
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

async function render(sessionId = "session"): Promise<void> {
  await act(async () => root.render(<TodoProgressButton slug="demo" sessionId={sessionId} />));
}

async function wait(milliseconds: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}

describe("TodoProgressButton interactions", () => {
  test("hides when the Session has no todos", async () => {
    await render();
    expect(container.querySelector("button")).toBeNull();
  });

  test("shows progress, hover preview, and pinned popover with readable step states", async () => {
    getWebSessionStore("session", "demo").setState({
      todos: [
        { id: "done", content: "Inspect layout", status: "completed" },
        { id: "current", content: "Build shell", status: "in_progress" },
        { id: "next", content: "P0 Run tests", status: "pending" },
      ],
      isRunning: true,
    });
    await render();
    const trigger = container.querySelector('[data-testid="todo-progress-trigger"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute("aria-label")).toContain("1 of 3 complete, running");
    expect(trigger.textContent).toBe("1/3Todos");
    expect(trigger.querySelector('[data-testid="progress-ring"]')?.getAttribute("data-percent")).toBe("33");
    expect(trigger.querySelector(".animate-spin")).toBeNull();

    await act(async () => trigger.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
    await wait(120);
    const preview = container.querySelector('[role="region"]') as HTMLElement;
    const hoverLayer = container.querySelector('[data-testid="todo-progress-hover-layer"]') as HTMLElement;
    expect(preview.textContent).toContain("Completed");
    expect(preview.className).toContain("select-text");
    expect(hoverLayer.className).toContain("sm:pt-2");
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Current");
    expect(container.querySelector('[aria-current="step"] .animate-spin')).toBeNull();
    expect(container.querySelector('[role="region"]')?.textContent).toContain("Upcoming");
    expect(container.querySelector('[role="region"]')?.textContent).toContain("P0");
    expect(container.querySelector('[role="region"]')?.textContent).toContain("Run tests");
    expect(container.querySelector('[role="region"]')?.textContent).not.toContain("P0 Run tests");

    await act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent("mouseout", {
        bubbles: true,
        relatedTarget: hoverLayer,
      }));
      hoverLayer.dispatchEvent(new dom.window.MouseEvent("mouseover", {
        bubbles: true,
        relatedTarget: trigger,
      }));
    });
    await wait(220);
    expect(container.querySelector('[role="region"]')).not.toBeNull();

    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const pinnedLayer = container.querySelector('[data-testid="todo-progress-hover-layer"]') as HTMLElement;
    expect(pinnedLayer.className).toContain("fixed left-3 right-3 top-[100px]");
    expect(pinnedLayer.className).toContain("sm:absolute sm:left-auto sm:right-0");
    expect(container.querySelector('button[aria-label="Close todo progress"]')).not.toBeNull();

    const currentStore = getWebSessionStore("session", "demo");
    await act(async () => currentStore.setState({ todos: [] }));
    expect(container.querySelector('[data-testid="todo-progress-trigger"]')).toBeNull();
    await act(async () => currentStore.setState({
      todos: [{ id: "reappeared", content: "Continue the same session", status: "pending" }],
    }));
    const reappearedTrigger = container.querySelector('[data-testid="todo-progress-trigger"]') as HTMLButtonElement;
    expect(reappearedTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="region"]')).toBeNull();

    getWebSessionStore("next-session", "demo").setState({
      todos: [{ id: "next", content: "Review another session", status: "pending" }],
    });
    await render("next-session");
    expect(container.querySelector('[role="region"]')).toBeNull();

    const nextTrigger = container.querySelector('[data-testid="todo-progress-trigger"]') as HTMLButtonElement;
    expect(nextTrigger.getAttribute("aria-expanded")).toBe("false");
    await act(async () => nextTrigger.click());
    await act(async () => nextTrigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="region"]')).toBeNull();
    expect(document.activeElement).toBe(nextTrigger);
  });

  test("holds the hover preview open while text selection crosses its boundary", async () => {
    getWebSessionStore("session", "demo").setState({
      todos: [{ id: "copy", content: "Copy this Todo text", status: "in_progress" }],
      isRunning: true,
    });
    await render();
    const trigger = container.querySelector('[data-testid="todo-progress-trigger"]') as HTMLButtonElement;
    await act(async () => trigger.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true })));
    await wait(120);

    const layer = container.querySelector('[data-testid="todo-progress-hover-layer"]') as HTMLElement;
    expect(layer.textContent).toContain("Copy this Todo text");
    await act(async () => {
      layer.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
      layer.dispatchEvent(new dom.window.MouseEvent("mouseout", {
        bubbles: true,
        relatedTarget: document.body,
      }));
    });
    await wait(220);
    expect(container.querySelector('[role="region"]')).not.toBeNull();

    await act(async () => document.body.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true })));
    await wait(220);
    expect(container.querySelector('[role="region"]')).toBeNull();
  });

  test("announces failed and completed execution states from real Session state", async () => {
    const store = getWebSessionStore("session", "demo");
    store.setState({ todos: [{ id: "one", content: "Run tests", status: "pending" }], executions: [{ id: "e1", startedAt: 1, status: "failed", endedAt: 2, error: "boom", binding, origin: "user_message" }] });
    await render();
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("failed");

    await act(async () => store.setState({ todos: [{ id: "one", content: "Run tests", status: "completed" }], executions: [{ id: "e2", startedAt: 1, status: "completed", endedAt: 2, binding, origin: "user_message" }] }));
    expect(container.querySelector("button")?.getAttribute("aria-label")).toContain("completed");
  });
});
