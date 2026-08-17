import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { JSDOM } from "jsdom";
import { ApiError } from "../../api/client";

type MutationKind = "create" | "run" | "discussion";
type MutationEntry = {
  variables: unknown;
  onSuccess?: (value: unknown) => void;
  onError?: (cause: unknown) => void;
};

const mutationStore: Record<MutationKind, {
  pending: boolean;
  entries: MutationEntry[];
  rerender?: () => void;
}> = {
  create: { pending: false, entries: [] },
  run: { pending: false, entries: [] },
  discussion: { pending: false, entries: [] },
};
let uuidCounter = 0;

mock.module("../../api/mutations", () => ({
  useCreateProjectTodo: () => useMockMutation("create"),
  useRunProjectTodoNow: () => useMockMutation("run"),
  useStartProjectTodoDiscussion: () => useMockMutation("discussion"),
}));
mock.module("../../lib/client-uuid", () => ({
  createClientUuid: () => `capture-test-request-${++uuidCounter}`,
}));
mock.module("@radix-ui/react-dialog", () => ({
  Root: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div data-testid="dialog-root">{children}</div> : null,
  Portal: ({ children }: { children: ReactNode }) => <>{children}</>,
  Overlay: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => <div {...props}>{children}</div>,
  Content: ({ children, onEscapeKeyDown, onPointerDownOutside, onInteractOutside, onOpenAutoFocus, onCloseAutoFocus, ...props }: { children: ReactNode; onEscapeKeyDown?: (event: KeyboardEvent) => void; onPointerDownOutside?: (event: Event) => void; onInteractOutside?: (event: Event) => void; onOpenAutoFocus?: (event: Event) => void; onCloseAutoFocus?: (event: Event) => void; [key: string]: unknown }) => (
    <div
      {...props}
      role="dialog"
      onKeyDown={(event) => { if (event.key === "Escape") onEscapeKeyDown?.(event.nativeEvent); }}
      onPointerDown={(event) => { onPointerDownOutside?.(event.nativeEvent); onInteractOutside?.(event.nativeEvent); }}
    >{children}</div>
  ),
  Title: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => <h2 {...props}>{children}</h2>,
  Description: ({ children, ...props }: { children: ReactNode; [key: string]: unknown }) => <p {...props}>{children}</p>,
}));

const { ProjectTodoCaptureDialog } = await import("./ProjectTodoCaptureDialog");

function useMockMutation(kind: MutationKind) {
  const [, setRevision] = useState(0);
  const state = mutationStore[kind];
  state.rerender = () => setRevision((revision) => revision + 1);
  return {
    get isPending() { return state.pending; },
    mutate(variables: unknown, options: { onSuccess?: (value: unknown) => void; onError?: (cause: unknown) => void }) {
      state.pending = true;
      state.entries.push({ variables, onSuccess: options.onSuccess, onError: options.onError });
      state.rerender?.();
    },
  };
}

const originals = new Map<string, PropertyDescriptor | undefined>();
let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;

function installDom(): void {
  dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", { url: "http://localhost" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    PointerEvent: dom.window.MouseEvent,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
  Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
  const elementPrototype = dom.window.HTMLElement.prototype as unknown as { attachEvent?: () => void; detachEvent?: () => void };
  elementPrototype.attachEvent = () => {};
  elementPrototype.detachEvent = () => {};
  container = document.getElementById("root") as unknown as HTMLDivElement;
  root = createRoot(container);
}

function resetMutations(): void {
  for (const state of Object.values(mutationStore)) {
    state.pending = false;
    state.entries.length = 0;
    state.rerender = undefined;
  }
  uuidCounter = 0;
}

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
  resetMutations();
});

beforeEach(() => {
  installDom();
  resetMutations();
});

async function renderCapture(slug = "demo", open = true, onOpenChange = mock(() => {}), onSaved = mock(() => {})): Promise<{ slug: string; onOpenChange: typeof onOpenChange; onSaved: typeof onSaved }> {
  const trigger = document.createElement("button");
  trigger.textContent = "New todo";
  document.body.append(trigger);
  const returnFocusRef = { current: trigger };
  await act(async () => root.render(
    <MemoryRouter>
      <ProjectTodoCaptureDialog slug={slug} open={open} returnFocusRef={returnFocusRef} onOpenChange={onOpenChange} onSaved={onSaved} />
    </MemoryRouter>,
  ));
  return { slug, onOpenChange, onSaved };
}

async function rerenderCapture(slug = "demo", open = true, onOpenChange = mock(() => {}), onSaved = mock(() => {})): Promise<void> {
  const trigger = document.querySelector("button") ?? document.createElement("button");
  const returnFocusRef = { current: trigger };
  await act(async () => root.render(
    <MemoryRouter>
      <ProjectTodoCaptureDialog slug={slug} open={open} returnFocusRef={returnFocusRef} onOpenChange={onOpenChange} onSaved={onSaved} />
    </MemoryRouter>,
  ));
}

async function changeContent(value: string): Promise<void> {
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement | null;
  if (!textarea) throw new Error(`Missing capture textarea: ${document.body.innerHTML}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), "value")?.set;
  setter?.call(textarea, value);
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (textarea as unknown as Record<string, { onChange?: (event: { target: HTMLTextAreaElement }) => void }>)[propsKey] : undefined;
  await act(async () => {
    if (props?.onChange) props.onChange({ target: textarea });
    else textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === label);
  if (!(found instanceof dom.window.HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return found;
}

function saveActionButton(): HTMLButtonElement {
  const candidate = [...document.querySelectorAll("button")].find((item) => ["Save", "Retry save"].includes(item.textContent?.trim() ?? ""));
  if (!(candidate instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Save action");
  return candidate;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function finish(kind: MutationKind, entry: MutationEntry, outcome: "success" | "error", value: unknown): Promise<void> {
  await act(async () => {
    const state = mutationStore[kind];
    if (state.entries[state.entries.length - 1] === entry) state.pending = false;
    if (outcome === "success") entry.onSuccess?.(value);
    else entry.onError?.(value);
    state.rerender?.();
  });
}

async function flushFocus(): Promise<void> {
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

describe("ProjectTodoCaptureDialog interactions", () => {
  test("isolates late Save callbacks with a local operation token", async () => {
    const result = await renderCapture("alpha");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).placeholder).toBe("Describe an idea, bug, feature, refactor, or other work…");
    await changeContent("first todo");
    await click(button("Save"));
    const first = mutationStore.create.entries[0]!;
    await finish("create", first, "error", new Error("temporary failure"));
    await flushFocus();
    expect(document.activeElement?.textContent?.trim()).toBe("Retry save");

    await changeContent("second todo");
    await click(saveActionButton());
    const second = mutationStore.create.entries[1]!;
    await finish("create", first, "success", { todo: { id: "stale" } });

    expect(result.onSaved).not.toHaveBeenCalled();
    expect(result.onOpenChange).not.toHaveBeenCalled();

    await finish("create", second, "success", { todo: { id: "fresh" } });
    expect(result.onSaved).toHaveBeenCalledTimes(1);
    expect(result.onOpenChange).toHaveBeenCalledWith(false);
  });

  test("reuses the same Run now clientRequestId for a retryable failure", async () => {
    await renderCapture("demo");
    await changeContent("run this");
    await click(button("Run now"));
    const first = mutationStore.run.entries[0]!;
    const firstId = (first.variables as { clientRequestId: string }).clientRequestId;
    await finish("run", first, "error", new Error("temporary failure"));
    await flushFocus();
    expect(document.activeElement?.textContent?.trim()).toBe("Retry run");
    await click(button("Retry run"));
    const second = mutationStore.run.entries[1]!;
    expect((second.variables as { clientRequestId: string }).clientRequestId).toBe(firstId);
  });

  test("reuses the same Start discussion clientRequestId for a retryable failure", async () => {
    await renderCapture("demo");
    await changeContent("shape this");
    await click(button("Start discussion"));
    const first = mutationStore.discussion.entries[0]!;
    const firstId = (first.variables as { clientRequestId: string }).clientRequestId;
    await finish("discussion", first, "error", new Error("temporary failure"));
    await flushFocus();
    expect(document.activeElement?.textContent?.trim()).toBe("Retry discussion");
    await click(button("Retry discussion"));
    const second = mutationStore.discussion.entries[1]!;
    expect((second.variables as { clientRequestId: string }).clientRequestId).toBe(firstId);
  });

  test("locks every dismissal and submit control while a request is pending", async () => {
    const result = await renderCapture("demo");
    await changeContent("pending work");
    await click(button("Save"));

    expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect((document.querySelector("button[aria-label='Close New Todo']") as HTMLButtonElement).disabled).toBe(true);
    for (const candidate of document.querySelectorAll("footer button")) expect((candidate as HTMLButtonElement).disabled).toBe(true);
    await click(button("Saving…"));
    expect(mutationStore.create.entries).toHaveLength(1);
    const beforeClose = result.onOpenChange.mock.calls.length;
    await click(document.querySelector("button[aria-label='Close New Todo']") as HTMLButtonElement);
    await act(async () => {
      const dialog = document.querySelector("[role='dialog']")!;
      const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      const outside = new dom.window.MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      dialog.dispatchEvent(escape);
      dialog.dispatchEvent(outside);
      expect(escape.defaultPrevented).toBe(true);
      expect(outside.defaultPrevented).toBe(true);
    });
    expect(result.onOpenChange.mock.calls.length).toBe(beforeClose);
    expect(mutationStore.create.entries).toHaveLength(1);
  });

  test("renders typed run recovery links and blocks unchanged follow-up actions", async () => {
    await renderCapture("alpha/project");
    await changeContent("retained work");
    await click(button("Run now"));
    const entry = mutationStore.run.entries[0]!;
    await finish("run", entry, "error", new ApiError({
      code: "TODO_RUN_NOW_RECOVERY",
      message: "Work already exists",
      status: 409,
      details: { scopeCode: "PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED", todoId: "todo/1", sessionId: "session/1" },
    }));
    await flushFocus();

    expect((document.querySelector("a[href='/projects/alpha%2Fproject/todos/todo%2F1']") as HTMLAnchorElement | null)?.textContent).toContain("Open Todo");
    expect((document.querySelector("a[href='/projects/alpha%2Fproject/sessions/session%2F1']") as HTMLAnchorElement | null)?.textContent).toContain("Open Session");
    expect(button("Save").disabled).toBe(true);
    expect(button("Start discussion").disabled).toBe(true);
    expect(button("Run now").disabled).toBe(true);
    expect(document.activeElement?.getAttribute("role")).toBe("alert");
  });

  test("renders typed discussion recovery links with the same exact route encoding", async () => {
    await renderCapture("alpha/project");
    await changeContent("retained discussion");
    await click(button("Start discussion"));
    const entry = mutationStore.discussion.entries[0]!;
    await finish("discussion", entry, "error", new ApiError({
      code: "TODO_START_DISCUSSION_RECOVERY",
      message: "Discussion already exists",
      status: 409,
      details: { scopeCode: "PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED", todoId: "todo/2", sessionId: "session/2" },
    }));

    expect((document.querySelector("a[href='/projects/alpha%2Fproject/todos/todo%2F2']") as HTMLAnchorElement | null)?.textContent).toContain("Open Todo");
    expect((document.querySelector("a[href='/projects/alpha%2Fproject/sessions/session%2F2']") as HTMLAnchorElement | null)?.textContent).toContain("Open Session");
    expect(button("Save").disabled).toBe(true);
    expect(button("Start discussion").disabled).toBe(true);
    expect(button("Run now").disabled).toBe(true);
  });

  test("ignores callbacks after a slug change or unmount", async () => {
    const result = await renderCapture("alpha");
    await changeContent("route-bound work");
    await click(button("Run now"));
    const routeEntry = mutationStore.run.entries[0]!;
    await rerenderCapture("beta", true, result.onOpenChange, result.onSaved);
    const callsAfterRouteChange = result.onOpenChange.mock.calls.length;
    await finish("run", routeEntry, "success", { session: { sessionId: "stale-session" } });
    expect(result.onOpenChange.mock.calls.length).toBe(callsAfterRouteChange);
    expect(result.onSaved).not.toHaveBeenCalled();

    await changeContent("unmounted work");
    await click(button("Run now"));
    const unmountedEntry = mutationStore.run.entries[1]!;
    await act(async () => root.unmount());
    await expect(finish("run", unmountedEntry, "success", { session: { sessionId: "after-unmount" } })).resolves.toBeUndefined();
    expect(result.onSaved).not.toHaveBeenCalled();
  });
});
