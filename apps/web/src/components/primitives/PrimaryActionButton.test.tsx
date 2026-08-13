import { afterEach, describe, expect, test } from "bun:test";
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrimaryActionButton } from "./PrimaryActionButton";

const originals = new Map<string, PropertyDescriptor | undefined>();

function installDom(): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
  return dom;
}

afterEach(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

describe("PrimaryActionButton", () => {
  test("owns the shared grammar and forwards the concrete button ref", async () => {
    const dom = installDom();
    const root = createRoot(document.getElementById("root")!);
    const ref = createRef<HTMLButtonElement>();
    await act(async () => root.render(<PrimaryActionButton ref={ref} disabled className="ml-auto">Create</PrimaryActionButton>));
    const action = ref.current!;
    const className = action.className;
    expect(action.type).toBe("button");
    expect(action.disabled).toBe(true);
    expect(className).toContain("bg-brand");
    expect(className).toContain("border-brand");
    expect(className).toContain("gap-1.5");
    expect(className).toContain("px-[13px]");
    expect(className).toContain("tracking-[-0.01em]");
    expect(className).toContain("focus-visible:outline-brand");
    expect(className).toContain("disabled:cursor-not-allowed");
    expect(className).toContain("primary-action-button");
    expect(className).toContain("h-11");
    expect(className).toContain("min-[761px]:h-8");
    expect(className).toContain("[@media(pointer:coarse)]:h-11");
    expect(className).toContain("ml-auto");
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("is the shared creation control for Todo, Automation, and Session inventories", async () => {
    const [todos, automations, sessions] = await Promise.all([
      Bun.file(new URL("../../routes/project-todos.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../routes/automations.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../routes/project-sessions.tsx", import.meta.url)).text(),
    ]);
    expect(todos).toContain('import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton"');
    expect(todos).toContain('<PrimaryActionButton ref={newTodoTriggerRef} className="min-[761px]:h-9"');
    expect(automations).toContain('import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton"');
    expect(automations).toContain('<PrimaryActionButton className="px-2.5 min-[761px]:px-[13px]" onClick={() => setCreating(true)}>');
    expect(sessions).toContain('import { PrimaryActionButton } from "../components/primitives/PrimaryActionButton"');
    expect(sessions).toContain("<PrimaryActionButton");
  });
});
