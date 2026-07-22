import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { queryKeys } from "../../api/queries";
import { sessionRuntimeStore } from "../../store/session-runtime-store";
import { __resetWebSessionStoresForTest, createWebSessionStore } from "../../store/session-store";

type ComposerQueueListComponent = typeof import("./ComposerQueueList").ComposerQueueList;

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;
let ComposerQueueList: ComposerQueueListComponent;

const requestedModelSelection = { mode: "profile_default" as const, selection: { model: "test:model" } };
const invalidRequestedModelSelection = { mode: "session_override" as const, selection: { model: "test:removed" } };
const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Test Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "m1",
};
const modelRuntime = {
  revision: "m1",
  providers: [{
    id: "test",
    displayName: "Test",
    models: [{ id: "model", qualifiedId: "test:model", displayName: "Test Model", variants: [] }],
  }],
  profileDefaults: {
    principal: { model: "test:model" },
    deep: { model: "test:model" },
    fast: { model: "test:model" },
  },
};

function change(element: HTMLTextAreaElement, value: string): void {
  act(() => {
    const previous = element.value;
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
    (element as unknown as { _valueTracker?: { setValue(value: string): void } })._valueTracker?.setValue(previous);
    const propsKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
    const props = propsKey
      ? (element as unknown as Record<string, { onChange?: (event: { target: HTMLTextAreaElement }) => void }>)[propsKey]
      : undefined;
    props?.onChange?.({ target: element });
  });
}

beforeEach(async () => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { configurable: true, value: () => {} },
    detachEvent: { configurable: true, value: () => {} },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    DocumentFragment: dom.window.DocumentFragment,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  fetchMock = mock(async () => Response.json({
    messageId: "queued-row",
    clientRequestId: "retry-client",
    status: "queued",
    revision: 8,
  }, { status: 202 }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  ({ ComposerQueueList } = await import("./ComposerQueueList"));
});

afterEach(() => {
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  dom.window.close();
});

describe("ComposerQueueList", () => {
  test("owns every Queue state and preserves Edit, Delete, Steer, Retry, and model invalidation", async () => {
    const store = createWebSessionStore("session-queue", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-queue",
      eventCursor: -1,
      agentName: "lead",
      activeModelBinding: binding,
      modelSelection: { revision: 0 },
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      pendingMessages: [{
        id: "queued-row",
        clientRequestId: "queued-client",
        content: "Original queued instruction",
        source: "user",
        state: "queued",
        revision: 7,
        acceptedAt: 1,
        updatedAt: 1,
        requestedModelSelection: invalidRequestedModelSelection,
      }, {
        id: "steering-row",
        clientRequestId: "steering-client",
        content: "Steering instruction",
        source: "user",
        state: "steering",
        revision: 3,
        acceptedAt: 2,
        updatedAt: 3,
        targetExecutionId: "execution-current",
        requestedModelSelection,
      }],
    });
    store.getState().addLocalSendingMessage({
      clientRequestId: "queued-client",
      content: "Duplicate optimistic instruction",
      requestedModelSelection,
      createdAt: 0,
    });
    store.getState().addLocalSendingMessage({
      clientRequestId: "sending-client",
      content: "Sending instruction",
      requestedModelSelection,
      createdAt: 3,
    });
    store.getState().addLocalSendingMessage({
      clientRequestId: "retry-client",
      content: "Retry without duplication",
      requestedModelSelection,
      createdAt: 4,
    });
    store.getState().setLocalSendingMessageStatus("retry-client", "retryable");
    sessionRuntimeStore.getState().applySnapshot({
      type: "session.runtime.snapshot",
      projectSlugs: ["project-1"],
      families: [{
        projectSlug: "project-1",
        rootSessionId: "session-queue",
        activity: "running",
        steerTargetExecutionId: "execution-current",
      }],
      createdAt: 1,
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    client.setQueryData(queryKeys.modelRuntime, modelRuntime);

    await act(async () => {
      root.render(<QueryClientProvider client={client}><ComposerQueueList slug="project-1" sessionId="session-queue" /></QueryClientProvider>);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-queue-state="queued"]')).not.toBeNull();
    expect(container.querySelector('[data-queue-state="steering"]')).not.toBeNull();
    expect(container.querySelector('[data-queue-state="sending"]')).not.toBeNull();
    expect(container.querySelector('[data-queue-state="retryable"]')).not.toBeNull();
    expect(container.querySelector('[data-queue-visual="queued"] .lucide-clock-3')).not.toBeNull();
    expect(container.querySelector('[data-queue-visual="steering"] [data-testid="activity-arc"]')).not.toBeNull();
    expect(container.querySelector('[data-queue-visual="sending"] .lucide-loader-circle')?.classList.contains("animate-activity")).toBe(true);
    expect(container.querySelector('[data-queue-visual="retryable"] .lucide-triangle-alert')).not.toBeNull();
    expect(container.querySelector('[data-queue-visual="queued"]')?.className).not.toContain("uppercase");
    expect(container.querySelector('[data-queue-visual="steering"]')?.className).not.toContain("text-text-muted");
    expect(container.textContent).not.toContain("Duplicate optimistic instruction");
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-row"]')?.textContent)
      .toBe("Model changed: test:removed → test:model");
    const invalidation = container.querySelector('[data-testid="pending-model-invalidation-queued-row"]');
    const localModel = container.querySelector('[data-testid="local-requested-model-sending-client"]');
    expect(invalidation?.className).not.toContain("max-[560px]:hidden");
    expect(invalidation?.className).toContain("max-[560px]:max-w-16");
    expect(localModel?.className).not.toContain("max-[560px]:hidden");
    expect(localModel?.className).toContain("max-[560px]:max-w-16");

    const queuedRow = container.querySelector('[data-testid="composer-queue-queued-row"]');
    expect(queuedRow?.textContent).toContain("Steer");
    expect(queuedRow?.textContent).toContain("Edit");
    expect(queuedRow?.textContent).toContain("Delete");
    expect(container.querySelector('[data-testid="composer-queue-steering-row"]')?.querySelector("button")).toBeNull();

    const edit = [...container.querySelectorAll("button")].find((button) => button.textContent === "Edit");
    if (!(edit instanceof dom.window.HTMLButtonElement)) throw new Error("Missing Edit button");
    await act(async () => {
      edit.click();
      await Promise.resolve();
    });
    const editField = document.querySelector('textarea[aria-label="Edit queued message"]');
    if (!(editField instanceof dom.window.HTMLTextAreaElement)) throw new Error("Missing queue editor");
    change(editField, "Updated queued instruction");
    const save = [...document.querySelectorAll("button")].find((button) => button.textContent === "Save");
    if (!(save instanceof dom.window.HTMLButtonElement)) throw new Error("Missing queue Save button");
    await act(async () => {
      save.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const steer = [...container.querySelectorAll("button")].find((button) => button.textContent === "Steer");
    const remove = [...container.querySelectorAll("button")].find((button) => button.textContent === "Delete");
    const retry = container.querySelector('button[aria-label="Retry sending message"]');
    if (!(steer instanceof dom.window.HTMLButtonElement) || !(remove instanceof dom.window.HTMLButtonElement) || !(retry instanceof dom.window.HTMLButtonElement)) {
      throw new Error("Missing direct queue actions");
    }
    await act(async () => {
      steer.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      remove.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const requests = fetchMock.mock.calls.map(([path, init]) => ({ path: String(path), init: init as RequestInit | undefined }));
    const edited = requests.find(({ path, init }) => path.endsWith("/messages/queued-row") && init?.method === "PATCH");
    const deleted = requests.find(({ path, init }) => path.endsWith("/messages/queued-row") && init?.method === "DELETE");
    const steered = requests.find(({ path }) => path.endsWith("/messages/queued-row/steer"));
    const retried = requests.find(({ path, init }) => path.endsWith("/sessions/session-queue/messages") && init?.method === "POST");
    expect(JSON.parse(String(edited?.init?.body))).toEqual({ text: "Updated queued instruction", expectedRevision: 7 });
    expect(JSON.parse(String(deleted?.init?.body))).toEqual({ expectedRevision: 7 });
    expect(JSON.parse(String(steered?.init?.body))).toEqual({ expectedRevision: 7, expectedExecutionId: "execution-current" });
    expect(JSON.parse(String(retried?.init?.body))).toEqual({
      text: "Retry without duplication",
      clientRequestId: "retry-client",
      requestedModelSelection,
    });

    expect(container.querySelector('[data-testid="composer-queue-queued-row"]')).not.toBeNull();
    await act(async () => store.setState({ pendingMessages: store.getState().pendingMessages.filter((message) => message.id !== "queued-row") }));
    expect(container.querySelector('[data-testid="composer-queue-queued-row"]')).toBeNull();
  });
});
