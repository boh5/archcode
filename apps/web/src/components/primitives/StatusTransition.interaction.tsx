import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { VisualStatusKind } from "../../lib/status-visuals";
import { StatusGlyph } from "./StatusGlyph";
import { useStatusTransition } from "./useStatusTransition";

const originals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

function installDom(): void {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  container = document.getElementById("root") as HTMLDivElement;
  root = createRoot(container);
}

function restoreDom(): void {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
}

function Harness({ identity, kind, theme = "dark" }: { identity: string; kind: VisualStatusKind; theme?: "dark" | "light" }) {
  const transition = useStatusTransition(identity, kind);
  return <StatusGlyph className={`theme-${theme}`} kind={kind} transition={transition} label={kind} />;
}

afterEach(() => {
  act(() => root?.unmount());
  dom?.window.close();
  restoreDom();
});

describe("status transitions", () => {
  test("animates completion once only for a same-entity mounted transition", async () => {
    installDom();

    await act(async () => root.render(<Harness identity="tool-1" kind="pending" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-complete");

    await act(async () => root.render(<Harness identity="tool-1" kind="completed" />));
    expect(container.firstElementChild?.className).toContain("animate-status-complete");

    await act(async () => root.render(<Harness identity="tool-1" kind="completed" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-complete");

    await act(async () => root.render(<Harness identity="tool-2" kind="completed" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-complete");
  });

  test("keeps initial, identity, theme, root-child, and remount Needs-you renders static", async () => {
    installDom();

    await act(async () => root.render(<Harness identity="root" kind="needs_you" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-attention");

    await act(async () => root.render(<Harness identity="root" kind="pending" />));
    await act(async () => root.render(<Harness identity="root" kind="needs_you" />));
    expect(container.firstElementChild?.className).toContain("animate-status-attention");

    await act(async () => root.render(<Harness identity="root" kind="needs_you" theme="light" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-attention");

    await act(async () => root.render(<Harness identity="child" kind="needs_you" theme="light" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-attention");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => root.render(<Harness identity="root" kind="needs_you" />));
    expect(container.firstElementChild?.className).not.toContain("animate-status-attention");
  });
});
