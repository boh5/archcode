import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

import { ChatMessages } from "./ChatMessages";
import {
  __resetWebSessionStoresForTest,
  createWebSessionStore,
} from "../../store/session-store";
import { sessionRuntimeStore } from "../../store/session-runtime-store";
import { queryKeys } from "../../api/queries";

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof mock>;

const requestedModelSelection = { mode: "profile_default" as const, selection: { model: "test:model" } };
const binding = { selection: { model: "test:model" }, providerId: "test", modelId: "model", providerDisplayName: "Test", modelDisplayName: "Test Model", resolution: "profile_default" as const, modelRuntimeRevision: "m1" };
const catalogM1 = {
  revision: "m1",
  providers: [{ id: "test", displayName: "Test", models: [
    { id: "model", qualifiedId: "test:model", displayName: "Test Model", variants: [] },
    { id: "x", qualifiedId: "test:x", displayName: "X", variants: [] },
  ] }],
  profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } },
};
const catalogM2 = {
  revision: "m2",
  providers: [{ id: "test", displayName: "Test", models: [
    { id: "model", qualifiedId: "test:model", displayName: "Test Model", variants: [] },
  ] }],
  profileDefaults: { principal: { model: "test:model" }, deep: { model: "test:model" }, fast: { model: "test:model" } },
};

function createClient(catalog = catalogM1): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  client.setQueryData(queryKeys.modelRuntime, catalog);
  return client;
}

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    scrollIntoView: { configurable: true, value: () => {} },
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  fetchMock = mock(async () => new Response(JSON.stringify({
    clientRequestId: "request-retry",
    messageId: "message-retry",
    status: "queued",
  }), { status: 202, headers: { "content-type": "application/json" } }));
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
});

afterEach(() => {
  act(() => root.unmount());
  __resetWebSessionStoresForTest();
  sessionRuntimeStore.getState().reset();
  dom.window.close();
});

describe("ChatMessages transcript ownership", () => {
  test("shows model audit only for an invalidated request and keeps the assistant label neutral", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      messages: [{
        id: "user-a", role: "user", executionId: "execution-a", createdAt: 1, completedAt: 1,
        parts: [{ type: "text", id: "text-a", text: "Use old model", createdAt: 1, completedAt: 1 }],
        modelAudit: { requested: { mode: "session_override", selection: { model: "test:removed" } }, actual: { model: "test:model" }, reason: "config_invalidated" },
      }, {
        id: "assistant-a", role: "assistant", executionId: "execution-a", createdAt: 2, completedAt: 2,
        parts: [{ type: "text", id: "text-b", text: "Historical answer", createdAt: 2, completedAt: 2 }],
      }],
      executions: [{ id: "execution-a", startedAt: 1, endedAt: 2, status: "completed", binding, origin: "user_message" }],
      nextModelSelection: { requested: { mode: "session_override", selection: { model: "test:new" } }, resolved: { ...binding, selection: { model: "test:new" }, modelId: "new", modelDisplayName: "New Model" } },
    });
    const client = createClient();
    const inspectModelAudit = mock((_messageId: string) => {});
    await act(async () => { root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} onInspectModelAudit={inspectModelAudit} /></QueryClientProvider>); });
    expect(container.querySelector('[data-testid="message-model-change-user-a"]')?.textContent).toBe("Model changed: test:removed → test:model");
    expect(container.textContent).not.toContain("Override:");
    expect(container.textContent).not.toContain("Actual:");
    expect(container.textContent).not.toContain("Inspect");
    expect(container.querySelector('[data-testid="assistant-model-assistant-a"]')?.textContent).toBe("Test Model");
    expect(container.textContent).not.toContain("New Model");
    const details = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Details")!;
    await act(async () => details.click());
    expect(inspectModelAudit).toHaveBeenCalledWith("user-a");
  });

  test("does not render request-versus-actual audit chrome for a normal canonical message", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      messages: [{
        id: "user-normal", role: "user", executionId: "execution-a", createdAt: 1, completedAt: 1,
        parts: [{ type: "text", id: "text-normal", text: "Normal request", createdAt: 1, completedAt: 1 }],
        modelAudit: { requested: requestedModelSelection, actual: { model: "test:model" } },
      }, {
        id: "assistant-normal", role: "assistant", executionId: "execution-a", createdAt: 2, completedAt: 2,
        parts: [{ type: "text", id: "text-answer", text: "Normal answer", createdAt: 2, completedAt: 2 }],
      }],
      executions: [{ id: "execution-a", startedAt: 1, endedAt: 2, status: "completed", binding, origin: "user_message" }],
    });
    const client = createClient();
    await act(async () => { root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} /></QueryClientProvider>); });
    expect(container.textContent).not.toContain("Agent default:");
    expect(container.textContent).not.toContain("Actual:");
    expect(container.textContent).not.toContain("Inspect");
    expect(container.textContent).not.toContain("Details");
    expect(container.querySelector('[data-testid="assistant-model-assistant-normal"]')?.textContent).toBe("Test Model");
  });

  test("offers Steer only when the queued request resolves to the active binding", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      pendingMessages: [{ id: "queued", clientRequestId: "request", content: "Follow up", source: "user", state: "queued", revision: 1, acceptedAt: 1, updatedAt: 1, requestedModelSelection }],
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
    });
    sessionRuntimeStore.getState().applySnapshot({ type: "session.runtime.snapshot", projectSlugs: ["project-1"], families: [{ projectSlug: "project-1", rootSessionId: "session-1", activity: "running", steerTargetExecutionId: "execution-a" }], createdAt: 1 });
    store.setState({ activeModelBinding: { ...binding, selection: { model: "test:other" } } });
    const client = createClient();
    await act(async () => { root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} /></QueryClientProvider>); });
    expect(container.textContent).not.toContain("Steer");
    await act(async () => store.setState({ activeModelBinding: binding }));
    expect(container.textContent).toContain("Steer");

    const invalidRequested = { mode: "session_override" as const, selection: { model: "test:removed" } };
    await act(async () => store.setState({
      pendingMessages: [{ id: "queued", clientRequestId: "request", content: "Follow up", source: "user", state: "queued", revision: 2, acceptedAt: 1, updatedAt: 2, requestedModelSelection: invalidRequested }],
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
    }));
    expect(container.textContent).toContain("Steer");

    await act(async () => store.setState({
      nextModelSelection: { requested: requestedModelSelection, resolved: { ...binding, selection: { model: "test:other" } } },
    }));
    expect(container.textContent).not.toContain("Steer");
  });

  test("shows each invalid queued request and the current model it will actually use", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      pendingMessages: [
        { id: "queued-x", clientRequestId: "request-x", content: "Use X", source: "user", state: "queued", revision: 1, acceptedAt: 1, updatedAt: 1, requestedModelSelection: { mode: "session_override", selection: { model: "test:x-invalid" } } },
        { id: "queued-y", clientRequestId: "request-y", content: "Use Y", source: "user", state: "queued", revision: 1, acceptedAt: 2, updatedAt: 2, requestedModelSelection: { mode: "session_override", selection: { model: "test:y-invalid" } } },
      ],
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
    });
    const client = createClient();
    await act(async () => { root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} /></QueryClientProvider>); });

    expect(container.querySelector('[data-testid="pending-requested-model-queued-x"]')).toBeNull();
    expect(container.querySelector('[data-testid="pending-requested-model-queued-y"]')).toBeNull();
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')?.textContent).toBe("Model changed: test:x-invalid → test:model");
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-y"]')?.textContent).toBe("Model changed: test:y-invalid → test:model");
  });

  test("does not infer queue invalidation or Steer while the catalog is loading", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    const requestedX = { mode: "session_override" as const, selection: { model: "test:x" } };
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      pendingMessages: [{ id: "queued-x", clientRequestId: "request-x", content: "Use X", source: "user", state: "queued", revision: 1, acceptedAt: 1, updatedAt: 1, requestedModelSelection: requestedX }],
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      activeModelBinding: binding,
    });
    sessionRuntimeStore.getState().applySnapshot({ type: "session.runtime.snapshot", projectSlugs: ["project-1"], families: [{ projectSlug: "project-1", rootSessionId: "session-1", activity: "running", steerTargetExecutionId: "execution-a" }], createdAt: 1 });
    let resolveCatalog!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveCatalog = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    await act(async () => {
      root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} /></QueryClientProvider>);
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="pending-requested-model-queued-x"]')?.textContent).toContain("test:x");
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')).toBeNull();
    expect(container.textContent).not.toContain("Steer");

    await act(async () => {
      resolveCatalog(Response.json(catalogM1));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  test("keeps queue projection neutral when Session refresh wins before catalog refresh", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    const requestedX = { mode: "session_override" as const, selection: { model: "test:x" } };
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1", eventCursor: -1,
      pendingMessages: [{ id: "queued-x", clientRequestId: "request-x", content: "Use X", source: "user", state: "queued", revision: 1, acceptedAt: 1, updatedAt: 1, requestedModelSelection: requestedX }],
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      activeModelBinding: binding,
    });
    sessionRuntimeStore.getState().applySnapshot({ type: "session.runtime.snapshot", projectSlugs: ["project-1"], families: [{ projectSlug: "project-1", rootSessionId: "session-1", activity: "running", steerTargetExecutionId: "execution-a" }], createdAt: 1 });
    const client = createClient(catalogM1);
    await act(async () => { root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} /></QueryClientProvider>); });
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')).toBeNull();

    let resolveCatalog!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveCatalog = resolve; }));
    let refresh!: Promise<void>;
    await act(async () => {
      refresh = client.invalidateQueries({ queryKey: queryKeys.modelRuntime });
      await Promise.resolve();
      store.setState({ nextModelSelection: { requested: requestedModelSelection, resolved: { ...binding, modelRuntimeRevision: "m2" } } });
    });
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')).toBeNull();
    expect(container.textContent).not.toContain("Steer");

    await act(async () => {
      resolveCatalog(Response.json(catalogM2));
      await refresh;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')?.textContent).toBe("Model changed: test:x → test:model");
    expect(container.textContent).toContain("Steer");
  });

  test("keeps queue projection neutral when catalog refresh wins before Session refresh", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    const requestedX = { mode: "session_override" as const, selection: { model: "test:x" } };
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1", eventCursor: -1,
      pendingMessages: [{ id: "queued-x", clientRequestId: "request-x", content: "Use X", source: "user", state: "queued", revision: 1, acceptedAt: 1, updatedAt: 1, requestedModelSelection: requestedX }],
      nextModelSelection: { requested: requestedModelSelection, resolved: binding },
      activeModelBinding: binding,
    });
    sessionRuntimeStore.getState().applySnapshot({ type: "session.runtime.snapshot", projectSlugs: ["project-1"], families: [{ projectSlug: "project-1", rootSessionId: "session-1", activity: "running", steerTargetExecutionId: "execution-a" }], createdAt: 1 });
    const client = createClient(catalogM1);
    await act(async () => { root.render(<QueryClientProvider client={client}><ChatMessages slug="project-1" sessionId="session-1" agents={[]} /></QueryClientProvider>); });

    fetchMock.mockImplementationOnce(async () => Response.json(catalogM2));
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.modelRuntime }); });
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')).toBeNull();
    expect(container.textContent).not.toContain("Steer");

    await act(async () => {
      store.setState({ nextModelSelection: { requested: requestedModelSelection, resolved: { ...binding, modelRuntimeRevision: "m2" } } });
    });
    expect(container.querySelector('[data-testid="pending-model-invalidation-queued-x"]')?.textContent).toBe("Model changed: test:x → test:model");
    expect(container.textContent).toContain("Steer");
  });

  test("renders queued states as ordinary user bubbles without repeated identity chrome", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      agentName: "lead",
      eventCursor: -1,
      messages: [
        {
          id: "canonical-user",
          role: "user",
          parts: [{ type: "text", id: "canonical-text", text: "Canonical request", createdAt: 1, completedAt: 1 }],
          createdAt: 1,
          completedAt: 1,
        },
        {
          id: "agent-answer",
          role: "assistant",
          parts: [{ type: "text", id: "agent-text", text: "Agent answer", createdAt: 2, completedAt: 2 }],
          createdAt: 2,
          completedAt: 2,
        },
      ],
      pendingMessages: [{
        id: "queued-user",
        clientRequestId: "queued-request",
        content: "Queued request",
        source: "user",
        state: "queued",
        revision: 1,
        acceptedAt: 3,
        updatedAt: 3,
        requestedModelSelection,
      }],
    });
    store.getState().addLocalSendingMessage({ clientRequestId: "sending-request", content: "Sending request", requestedModelSelection, createdAt: 4 });
    store.getState().addLocalSendingMessage({ clientRequestId: "failed-request", content: "Failed request", requestedModelSelection, createdAt: 5 });
    store.getState().setLocalSendingMessageStatus("failed-request", "retryable");
    const client = createClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ChatMessages
            slug="project-1"
            sessionId="session-1"
            agents={[{ name: "lead", displayName: "Lead Engineer" }]}
          />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const scroller = container.querySelector('[data-testid="conversation-scroller"]');
    const rail = container.querySelector('[data-testid="conversation-transcript-rail"]');
    expect(scroller?.className).not.toContain("max-w");
    expect(rail?.className).toContain("max-w-[880px]");
    expect(rail?.className).toContain("gap-[16px]");

    const canonicalUser = container.querySelector('[data-message-kind="canonical-user"]');
    expect(canonicalUser).not.toBeNull();
    expect(canonicalUser?.querySelector("svg")).toBeNull();
    const queuedUser = container.querySelector('[data-message-kind="queued-user"]');
    const sendingUser = container.querySelector('[data-message-kind="sending-user"]');
    const failedUser = container.querySelector('[data-message-kind="failed-user"]');
    expect(queuedUser).not.toBeNull();
    expect(sendingUser).not.toBeNull();
    expect(failedUser).not.toBeNull();
    expect(rail?.contains(queuedUser)).toBe(true);
    expect(rail?.contains(sendingUser)).toBe(true);
    expect(rail?.contains(failedUser)).toBe(true);
    expect(queuedUser?.className).toContain("justify-end");
    expect(queuedUser?.textContent).toContain("Queued request");
    expect(queuedUser?.textContent).toContain("Queued");
    expect(sendingUser?.textContent).toContain("Sending…");
    expect(failedUser?.textContent).toContain("Send status unknown");
    expect(container.querySelector('[data-testid="composer-pending-messages"]')).toBeNull();

    const agent = container.querySelector('[data-message-kind="agent"]');
    expect(agent).not.toBeNull();
    expect(agent?.textContent).not.toContain("Lead Engineer");
    expect(agent?.querySelector(".border-agent-lead")).not.toBeNull();
    expect(agent?.getAttribute("tabindex")).toBeNull();
    const timestamp = agent?.querySelector("time");
    expect(timestamp).not.toBeNull();
    expect(timestamp?.className).toContain("opacity-0");
    expect(timestamp?.className).toContain("group-hover:opacity-100");
    expect(timestamp?.className).toContain("group-focus-within:opacity-100");
    expect(timestamp?.textContent).toContain("Sent");
    expect(agent?.querySelector('button[aria-label="More actions"]')).toBeNull();
  });

  test("keeps canonical history stable and appends queued messages after it", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({
      rootSessionId: "session-1",
      eventCursor: -1,
      messages: [
        {
          id: "message-a",
          role: "user",
          parts: [{ type: "text", id: "part-a", text: "First request", createdAt: 1, completedAt: 1 }],
          createdAt: 1,
          completedAt: 1,
        },
        {
          id: "message-answer",
          role: "assistant",
          parts: [{ type: "text", id: "part-answer", text: "First answer", createdAt: 10, completedAt: 10 }],
          createdAt: 10,
          completedAt: 10,
        },
        {
          id: "message-b",
          role: "user",
          clientRequestId: "request-b",
          parts: [{ type: "text", id: "part-b", text: "Queued follow-up", createdAt: 2, completedAt: 11 }],
          createdAt: 2,
          completedAt: 11,
        },
      ],
      pendingMessages: [{
        id: "pending-b",
        clientRequestId: "pending-request-b",
        content: "Still queued",
        source: "user",
        state: "queued",
        revision: 1,
        acceptedAt: 0,
        updatedAt: 0,
        requestedModelSelection,
      }],
    });
    const client = createClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ChatMessages slug="project-1" sessionId="session-1" agents={[]} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const text = container.textContent ?? "";
    expect(text.indexOf("First request")).toBeLessThan(text.indexOf("First answer"));
    expect(text.indexOf("First answer")).toBeLessThan(text.indexOf("Queued follow-up"));
    expect(text.indexOf("Queued follow-up")).toBeLessThan(text.indexOf("Still queued"));
  });

  test("retries an unknown POST outcome with the exact same clientRequestId", async () => {
    const store = createWebSessionStore("session-1", "project-1");
    store.getState().initializeFromSnapshot({ rootSessionId: "session-1", eventCursor: -1 });
    store.getState().addLocalSendingMessage({
      clientRequestId: "request-retry",
      content: "Do not duplicate me",
      requestedModelSelection,
      createdAt: 1,
    });
    store.getState().setLocalSendingMessageStatus("request-retry", "retryable");
    const client = createClient();

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ChatMessages slug="project-1" sessionId="session-1" agents={[]} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const retry = document.querySelector('button[aria-label="Retry sending message"]');
    if (!(retry instanceof dom.window.HTMLButtonElement)) throw new Error("Missing retry button");
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/projects/project-1/sessions/session-1/messages");
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Do not duplicate me",
      clientRequestId: "request-retry",
      requestedModelSelection,
    });
  });

});
