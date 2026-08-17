import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

const navigate = mock((_href: string) => {});
const onOpenChange = mock((_open: boolean) => {});

mock.module("react-router-dom", () => ({ useNavigate: () => navigate }));
mock.module("../../api/queries", () => ({
  useWorkSearch: () => ({
    data: {
      results: [
        { kind: "project", project: { slug: "demo", name: "Demo" }, entityId: "demo", title: "Project result", href: "/projects/demo/todos" },
        { kind: "todo", project: { slug: "demo", name: "Demo" }, entityId: "todo-1", title: "Todo result", href: "/projects/demo/todos/todo-1", context: "archived" },
        { kind: "session", project: { slug: "demo", name: "Demo" }, entityId: "session-1", title: "Session result", href: "/projects/demo/sessions/session-1" },
        { kind: "automation", project: { slug: "demo", name: "Demo" }, entityId: "automation-1", title: "Automation result", href: "/projects/demo/automations/automation-1", context: "active" },
      ],
      truncated: false,
      projectErrors: [],
    },
    isLoading: false,
    error: null,
  }),
}));

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    MouseEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
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

afterEach(() => {
  restoreDom();
  navigate.mockClear();
  onOpenChange.mockClear();
});

describe("WorkSearchDialog", () => {
  test("opens every current result kind at its exact server-provided deep link", async () => {
    const dom = installDom();
    const { WorkSearchDialog } = await import("./WorkSearchDialog");
    const root = createRoot(document.getElementById("root")!);
    const returnFocusRef = { current: document.createElement("button") };

    await act(async () => root.render(<WorkSearchDialog open onOpenChange={onOpenChange} returnFocusRef={returnFocusRef} />));
    expect(Array.from(document.querySelectorAll("h3"), (heading) => heading.textContent)).toEqual(["Projects", "Demo"]);
    const resultRows = Array.from(document.querySelectorAll<HTMLButtonElement>("section button"));
    expect(resultRows).toHaveLength(4);
    expect(resultRows.every((row) => row.className.includes("grid-cols-[22px_minmax(0,1fr)_auto]"))).toBe(true);
    expect(resultRows[0]?.textContent).toContain("deProject resultProject · demoProject");
    expect(resultRows[1]?.textContent).toContain("Todo resultTodoArchived");
    expect(resultRows[1]?.querySelector("span[aria-hidden=true]")?.className).toContain("bg-text-muted");
    expect(resultRows[3]?.textContent).toContain("Automation resultAutomationScheduled");
    expect(resultRows[3]?.querySelector("span[aria-hidden=true]")?.className).toContain("bg-text-muted");
    for (const title of ["Project result", "Todo result", "Session result", "Automation result"]) {
      const button = Array.from(document.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(title));
      expect(button).toBeDefined();
      await act(async () => button!.click());
    }

    expect(navigate.mock.calls.map(([href]) => href)).toEqual([
      "/projects/demo/todos",
      "/projects/demo/todos/todo-1",
      "/projects/demo/sessions/session-1",
      "/projects/demo/automations/automation-1",
    ]);
    expect(onOpenChange).toHaveBeenCalledTimes(4);
    expect(onOpenChange.mock.calls.every(([open]) => open === false)).toBe(true);

    await act(async () => root.unmount());
    dom.window.close();
  });
});
