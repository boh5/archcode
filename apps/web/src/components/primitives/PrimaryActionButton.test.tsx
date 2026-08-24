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
    expect(className).toContain("bg-[var(--primary-fill)]");
    expect(className).toContain("border-brand");
    expect(className).toContain("gap-1.5");
    expect(className).toContain("px-[13px]");
    expect(className).toContain("tracking-[-0.01em]");
    expect(className).toContain("focus-visible:outline-[var(--focus-color)]");
    expect(className).toContain("disabled:cursor-not-allowed");
    expect(className).toContain("primary-action-button");
    expect(className).toContain("h-11");
    expect(className).toContain("min-[761px]:h-[34px]");
    expect(className).toContain("[@media(pointer:coarse)]:h-11");
    expect(className).toContain("ml-auto");
    await act(async () => root.unmount());
    dom.window.close();
  });

  test("keeps New Todo primary while Runs and Schedules creation stay quiet", async () => {
    const [navigator, automations, sessions] = await Promise.all([
      Bun.file(new URL("../features/ProjectTodoNavigator.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../routes/automations.tsx", import.meta.url)).text(),
      Bun.file(new URL("../../routes/project-sessions.tsx", import.meta.url)).text(),
    ]);
    expect(navigator).toContain('import { PrimaryActionButton } from "../primitives/PrimaryActionButton"');
    expect(navigator).toContain("<PrimaryActionButton");
    expect(automations).toContain("border-border-default bg-bg-surface");
    expect(automations).toContain("min-[761px]:h-[34px]");
    expect(automations).toContain('<Plus size={14} aria-hidden="true" /> New Automation');
    expect(sessions).toContain("border-border-default bg-bg-surface");
    expect(sessions).toContain("min-[641px]:h-[34px]");
    expect(sessions).toContain('<Plus size={14} aria-hidden="true" /> New Session');
  });
});
