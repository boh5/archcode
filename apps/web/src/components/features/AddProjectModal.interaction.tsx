import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import type { DirectoryEntry } from "../../api/types";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const addProjectMutate = mock((_variables: { path: string }) => {});
const navigate = mock((_path: string) => {});
let nextTimerId = 1;
let scheduledTimers = new Map<number, TimerHandler>();

function resolvedDirectory(path: string): DirectoryEntry | undefined {
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (!["/workspace", "/workspace/archcode", "/workspace/other"].includes(normalized)) {
    return undefined;
  }
  return {
    name: normalized.slice(normalized.lastIndexOf("/") + 1),
    path: normalized,
  };
}

mock.module("../../api/mutations", () => ({
  useAddProject: () => ({
    mutate: addProjectMutate,
    isPending: false,
    error: null,
  }),
}));

mock.module("../../api/queries", () => ({
  useDirectoryList: (path: string) => ({
    data: {
      current: resolvedDirectory(path),
      entries: [],
      truncated: false,
    },
    isLoading: false,
    error: null,
  }),
  useDirectorySearch: () => ({
    data: { entries: [], truncated: false },
    isLoading: false,
    error: null,
  }),
}));

mock.module("react-router-dom", () => ({
  useNavigate: () => navigate,
}));

const { AddProjectModal } = await import("./AddProjectModal");

function installDom(): void {
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
    getClientRects: { configurable: true, value: () => ({ length: 1 }) },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
}

function installFakeTimers(): void {
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

function changeInput(value: string): void {
  const input = container.querySelector("input");
  if (!input) throw new Error("Missing directory input");

  const previous = input.value;
  Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set?.call(input, value);
  (input as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey
    ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey]
    : undefined;
  if (!props?.onChange) throw new Error("Missing directory input change handler");
  props.onChange({ target: input });
}

function addProjectButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === "Add Project");
  if (!button) throw new Error("Missing Add Project button");
  return button;
}

async function flushDebounce(): Promise<void> {
  const callbacks = [...scheduledTimers.values()];
  scheduledTimers.clear();
  await act(async () => {
    for (const callback of callbacks) {
      if (typeof callback === "function") callback();
    }
  });
}

beforeEach(() => {
  installDom();
  installFakeTimers();
  addProjectMutate.mockClear();
  navigate.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  scheduledTimers.clear();
});

describe("AddProjectModal interactions", () => {
  test("contains keyboard focus and restores the exact opening control", async () => {
    const origin = document.createElement("button");
    origin.textContent = "Open project";
    document.body.prepend(origin);
    origin.focus();

    await act(async () => root.render(<AddProjectModal open returnFocusTarget={origin} onClose={() => {}} />));
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    const input = container.querySelector("input") as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    const close = container.querySelector('button[aria-label="Close"]') as HTMLButtonElement;
    close.focus();

    await act(async () => {
      close.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () => root.render(<AddProjectModal open={false} returnFocusTarget={origin} onClose={() => {}} />));
    await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    expect({
      tag: document.activeElement?.tagName,
      text: document.activeElement?.textContent,
      isOrigin: document.activeElement === origin,
      originConnected: origin.isConnected,
    }).toEqual({ tag: "BUTTON", text: "Open project", isOrigin: true, originConnected: true });
  });

  test("invalidates edited paths immediately and selects only the resolved input", async () => {
    await act(async () => root.render(<AddProjectModal open onClose={() => {}} />));

    act(() => changeInput("/workspace/archcode"));
    await flushDebounce();
    expect(addProjectButton().disabled).toBe(false);
    expect(container.textContent).toContain("/workspace/archcode");

    act(() => changeInput("/workspace/other"));
    expect(addProjectButton().disabled).toBe(true);
    await flushDebounce();
    expect(addProjectButton().disabled).toBe(false);

    act(() => changeInput("/workspace"));
    expect(addProjectButton().disabled).toBe(true);
    await flushDebounce();
    act(() => addProjectButton().click());

    expect(addProjectMutate).toHaveBeenCalledTimes(1);
    expect(addProjectMutate).toHaveBeenCalledWith(
      { path: "/workspace" },
      expect.any(Object),
    );
  });
});
