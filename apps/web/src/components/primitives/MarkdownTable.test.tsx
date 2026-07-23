import { afterEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MarkdownContent } from "./MarkdownContent";

const originals = new Map<string, PropertyDescriptor | undefined>();
const clipboardWrite = mock(async () => {});
let dom: JSDOM;
let root: Root;

function installDom(): HTMLDivElement {
  dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "http://localhost" },
  );
  clipboardWrite.mockClear();
  Object.defineProperty(dom.window.navigator, "clipboard", {
    configurable: true,
    value: { write: clipboardWrite },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    ClipboardItem: class ClipboardItem {
      constructor(readonly items: Record<string, Blob>) {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  const container = document.getElementById("root") as HTMLDivElement;
  root = createRoot(container);
  return container;
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
  restoreDom();
});

describe("MarkdownTable", () => {
  test("opens every copy format inside the project-owned unclipped surface", async () => {
    const container = installDom();
    await act(async () => root.render(
      <MarkdownContent>
        {"| State | Owner |\n| --- | --- |\n| Running | Lead |"}
      </MarkdownContent>,
    ));

    const surface = container.querySelector(
      '[data-markdown-table="surface"]',
    ) as HTMLElement;
    const copyButton = surface.querySelector(
      'button[title="Copy table"]',
    ) as HTMLButtonElement;

    expect(surface.getAttribute("data-streamdown")).toBe("table-wrapper");
    expect(surface.querySelector('[data-markdown-table="scroll"]')).not.toBeNull();
    expect(copyButton).not.toBeNull();

    await act(async () => copyButton.click());

    const menuText = copyButton.parentElement?.textContent ?? "";
    expect(menuText).toContain("Markdown");
    expect(menuText).toContain("CSV");
    expect(menuText).toContain("TSV");
    expect(surface.querySelector('[data-markdown-table="actions"]')).not.toBeNull();

    const markdownOption = surface.querySelector(
      'button[title="Copy table as Markdown"]',
    ) as HTMLButtonElement;
    await act(async () => markdownOption.click());
    expect(clipboardWrite).toHaveBeenCalledTimes(1);
    expect(copyButton.textContent).toContain("Table copied");
  });
});
