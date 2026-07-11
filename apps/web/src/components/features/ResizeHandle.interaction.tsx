import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ResizeHandle } from "./ResizeHandle";

let dom: JSDOM;
let root: Root;
let container: HTMLElement;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  Object.defineProperty(globalThis, "window", { value: dom.window, configurable: true });
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  Object.defineProperty(globalThis, "HTMLElement", { value: dom.window.HTMLElement, configurable: true });
  Object.defineProperty(globalThis, "KeyboardEvent", { value: dom.window.KeyboardEvent, configurable: true });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { value: true, configurable: true });
  container = document.getElementById("root")!;
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
});

describe("ResizeHandle interactions", () => {
  test("exposes separator values and keyboard resizing for the left panel", async () => {
    const onChange = mock((_value: number) => {});
    await act(async () => root.render(<ResizeHandle label="Resize sidebar" controls="sidebar" value={280} min={220} max={420} direction={1} onChange={onChange} />));
    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(separator.getAttribute("aria-valuenow")).toBe("280");
    expect(separator.getAttribute("aria-valuemin")).toBe("220");
    expect(separator.getAttribute("aria-valuemax")).toBe("420");
    separator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    separator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(onChange.mock.calls).toEqual([[290], [220]]);
  });

  test("reverses horizontal key semantics for the right inspector edge", async () => {
    const onChange = mock((_value: number) => {});
    await act(async () => root.render(<ResizeHandle label="Resize inspector" controls="inspector" value={360} min={300} max={560} direction={-1} onChange={onChange} />));
    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    separator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }));
    separator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(onChange.mock.calls).toEqual([[400], [560]]);
  });
});
