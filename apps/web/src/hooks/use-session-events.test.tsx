import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { PermissionRequest, QuestionRequest } from "../api/types";
import type {
  PermissionTerminalEvent,
  QuestionTerminalEvent,
  SessionEventPayload,
  StreamEvent,
} from "@specra/protocol";

type UseSessionEventsHook = typeof import("./use-session-events").useSessionEvents;
type WebSessionStoreFactory = typeof import("../store/session-store").createWebSessionStore;
type MockSessionState = {
  append: (event: SessionEventPayload) => void;
  addPermissionRequest: (request: PermissionRequest) => void;
  addQuestionRequest: (request: QuestionRequest) => void;
  handlePermissionTerminal: (event: PermissionTerminalEvent) => void;
  handleQuestionTerminal: (event: QuestionTerminalEvent) => void;
  resetTransientState: () => void;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
  connectionState: "connecting" | "open" | "reconnecting" | "closed";
  lastEventId: string | null;
  setConnectionState: (state: "connecting" | "open" | "reconnecting" | "closed") => void;
  setLastEventId: (id: string | null) => void;
};

type EventListener = (event: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly close = mock(() => {});
  private readonly listeners = new Map<string, EventListener[]>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, data: unknown, lastEventId = "event-1"): void {
    const event = { data: JSON.stringify(data), lastEventId } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  dispatchRaw(type: string, rawData: string, lastEventId = "event-1"): void {
    const event = { data: rawData, lastEventId } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }

  static reset(): void {
    MockEventSource.instances = [];
  }
}

const originalEventSource = globalThis.EventSource;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
let act: (callback: () => void) => void;
let createRoot: (container: Element | DocumentFragment) => Root;
let useSessionEvents: UseSessionEventsHook;
let createWebSessionStore: WebSessionStoreFactory;
let activeRoot: { cleanup?: () => void } | null = null;
const sessionRegistry = new Map<string, ReturnType<WebSessionStoreFactory>>();

function createMockRoot(_container: Element | DocumentFragment): Root {
  const rootState: { cleanup?: () => void } = {};

  return {
    render(children: unknown) {
      const element = children as { type?: (props: unknown) => unknown; props?: unknown };
      activeRoot = rootState;
      element.type?.(element.props);
      activeRoot = null;
    },
    unmount() {
      rootState.cleanup?.();
      rootState.cleanup = undefined;
    },
  } as Root;
}

function scopedMockKey(sessionId: string, slug?: string): string {
  return slug === undefined ? sessionId : `${slug}\0${sessionId}`;
}

function createMockSessionStore(sessionId: string, slug?: string): ReturnType<WebSessionStoreFactory> {
  const key = scopedMockKey(sessionId, slug);
  const existing = sessionRegistry.get(key);
  if (existing) return existing;

  let state: MockSessionState = {
    append: () => {},
    addPermissionRequest: (request) => {
      const pendingPermissions = new Map(state.pendingPermissions);
      pendingPermissions.set(request.id, request);
      state = { ...state, pendingPermissions };
    },
    addQuestionRequest: (request) => {
      const pendingQuestions = new Map(state.pendingQuestions);
      pendingQuestions.set(request.id, request);
      state = { ...state, pendingQuestions };
    },
    handlePermissionTerminal: (event) => {
      const pendingPermissions = new Map(state.pendingPermissions);
      pendingPermissions.delete(event.permissionId);
      state = { ...state, pendingPermissions };
    },
    handleQuestionTerminal: (event) => {
      const pendingQuestions = new Map(state.pendingQuestions);
      pendingQuestions.delete(event.questionId);
      state = { ...state, pendingQuestions };
    },
    resetTransientState: () => {
      state = {
        ...state,
        pendingPermissions: new Map(),
        pendingQuestions: new Map(),
        connectionState: "connecting",
        lastEventId: null,
      };
    },
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
    connectionState: "connecting",
    lastEventId: null,
    setConnectionState: (connectionState) => {
      state = { ...state, connectionState };
    },
    setLastEventId: (lastEventId) => {
      state = { ...state, lastEventId };
    },
  };

  const store = {
    getInitialState: () => state,
    getState: () => state,
    setState: (partial: Partial<MockSessionState>) => {
      state = { ...state, ...partial };
    },
    subscribe: () => () => {},
  } as unknown as ReturnType<WebSessionStoreFactory>;

  sessionRegistry.set(key, store);
  return store;
}

interface ScheduledTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

let currentTime = 0;
let nextTimerId = 1;
let scheduledTimers: ScheduledTimer[] = [];

function installFakeTimers(): void {
  currentTime = 0;
  nextTimerId = 1;
  scheduledTimers = [];

  globalThis.setTimeout = ((callback: TimerHandler, delay = 0) => {
    const id = nextTimerId++;
    scheduledTimers.push({
      id,
      dueAt: currentTime + delay,
      callback: typeof callback === "function" ? () => callback() : () => {},
    });
    return id;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id?: number) => {
    if (id === undefined) return;
    scheduledTimers = scheduledTimers.filter((timer) => timer.id !== id);
  }) as typeof clearTimeout;
}

function restoreFakeTimers(): void {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  scheduledTimers = [];
}

function advanceTimers(ms: number): void {
  const targetTime = currentTime + ms;

  while (true) {
    scheduledTimers.sort((a, b) => a.dueAt - b.dueAt);
    const nextTimer = scheduledTimers[0];
    if (!nextTimer || nextTimer.dueAt > targetTime) break;

    scheduledTimers.shift();
    currentTime = nextTimer.dueAt;
    nextTimer.callback();
  }

  currentTime = targetTime;
}

function TestHarness(props: {
  slug: string;
  sessionId: string;
  options?: { eventCursor?: number; onReset?: () => void };
}) {
  useSessionEvents(props.slug, props.sessionId, props.options);
  return null;
}

function renderHook(
  slug: string,
  sessionId: string,
  options?: { eventCursor?: number; onReset?: () => void },
): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render({
      type: TestHarness,
      props: { slug, sessionId, options },
    } as unknown as React.ReactNode);
  });

  return { root, container };
}

function unmount(rendered: { root: Root; container: HTMLDivElement }): void {
  act(() => {
    rendered.root.unmount();
  });
  rendered.container.remove();
}

describe("useSessionEvents", () => {
  beforeAll(async () => {
    mock.module("react", () => ({
      act: (callback: () => void) => callback(),
      useEffect: (callback: () => void | (() => void)) => {
        const cleanup = callback();
        if (typeof cleanup === "function" && activeRoot) {
          activeRoot.cleanup = cleanup;
        }
      },
      useRef: (initial: unknown) => ({ current: initial }),
    }));
    mock.module("react-dom/client", () => ({
      createRoot: createMockRoot,
    }));
    mock.module("../store/session-store", () => ({
      createWebSessionStore: createMockSessionStore,
      useSessionStore: () => undefined,
    }));

    [{ act }, { createRoot }, { createWebSessionStore }, { useSessionEvents }] = await Promise.all([
      import("react"),
      import("react-dom/client"),
      import("../store/session-store"),
      import("./use-session-events"),
    ]);
  });

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event;
    installFakeTimers();
    MockEventSource.reset();
    sessionRegistry.clear();
    globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  });

  afterEach(() => {
    globalThis.EventSource = originalEventSource;
    restoreFakeTimers();
    MockEventSource.reset();
  });

  test("initial connection creates EventSource with correct URL", () => {
    const rendered = renderHook("demo", "session-1");

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe(
      "/api/projects/demo/sessions/session-1/events",
    );

    unmount(rendered);
  });

  test("initial connection uses eventCursor in URL when provided", () => {
    const sessionId = "cursor-session";
    const rendered = renderHook("demo", sessionId, { eventCursor: 42 });

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe(
      "/api/projects/demo/sessions/cursor-session/events?lastEventId=42",
    );

    unmount(rendered);
  });

  test("eventCursor not used when store already has lastEventId", () => {
    const sessionId = "cursor-priority-session";
    const store = createWebSessionStore(sessionId, "demo");
    store.setState({ lastEventId: "existing-5" });
    const rendered = renderHook("demo", sessionId, { eventCursor: 99 });

    expect(MockEventSource.instances[0]?.url).toBe(
      "/api/projects/demo/sessions/cursor-priority-session/events?lastEventId=existing-5",
    );

    unmount(rendered);
  });

  test("browser refresh reconnects with eventCursor from the refreshed session snapshot", () => {
    const sessionId = "refresh-session";
    const firstRender = renderHook("demo", sessionId, { eventCursor: 7 });
    const firstSource = MockEventSource.instances[0]!;

    MockEventSource.instances[0]?.dispatch("stream", { type: "system-notice", message: "before-refresh" }, "12");
    unmount(firstRender);

    expect(firstSource.close).toHaveBeenCalled();
    const store = createWebSessionStore(sessionId, "demo");
    store.setState({ lastEventId: null });
    const secondRender = renderHook("demo", sessionId, { eventCursor: 12 });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.url).toBe(
      "/api/projects/demo/sessions/refresh-session/events?lastEventId=12",
    );

    unmount(secondRender);
  });

  test("receiving stream events calls store.append", () => {
    const sessionId = "stream-session";
    const store = createWebSessionStore(sessionId, "demo");
    const append = mock(() => {});
    store.setState({ append });
    const rendered = renderHook("demo", sessionId);
    const event: StreamEvent = { type: "text-delta", text: "hello" };

    MockEventSource.instances[0]?.dispatch("stream", event, "stream-1");

    expect(append).toHaveBeenCalledWith(event);
    expect(store.getState().lastEventId).toBe("stream-1");

    unmount(rendered);
  });

  test("receiving permission.request via stream calls store.addPermissionRequest with mapped data", () => {
    const sessionId = "permission-session";
    const store = createWebSessionStore(sessionId, "demo");
    const addPermissionRequest = mock(() => {});
    store.setState({ addPermissionRequest });
    const rendered = renderHook("demo", sessionId);

    // Server sends PermissionRequestEvent format through stream
    const serverEvent = {
      type: "permission.request",
      permissionId: "permission-1",
      toolName: "bash",
      args: { command: "pwd" },
      description: "Run command",
    };

    MockEventSource.instances[0]?.dispatch("stream", serverEvent, "permission-event");

    // Hook should map to frontend PermissionRequest format
    expect(addPermissionRequest).toHaveBeenCalledWith({
      id: "permission-1",
      sessionId,
      toolName: "bash",
      toolCallId: "",
      input: { command: "pwd" },
      description: "Run command",
    });
    expect(store.getState().lastEventId).toBe("permission-event");

    unmount(rendered);
  });

  test("receiving question.request via stream calls store.addQuestionRequest with parsed JSON", () => {
    const sessionId = "question-session";
    const store = createWebSessionStore(sessionId, "demo");
    const addQuestionRequest = mock(() => {});
    store.setState({ addQuestionRequest });
    const rendered = renderHook("demo", sessionId);

    const serverEvent = {
      type: "question.request",
      questionId: "question-1",
      question: JSON.stringify({
        toolName: "ask_user",
        toolCallId: "call-1",
        questions: [{ text: "Continue?" }],
      }),
    };

    MockEventSource.instances[0]?.dispatch("stream", serverEvent, "question-event");

    expect(addQuestionRequest).toHaveBeenCalledWith({
      id: "question-1",
      sessionId,
      toolName: "ask_user",
      toolCallId: "call-1",
      questions: [{ text: "Continue?" }],
    });
    expect(store.getState().lastEventId).toBe("question-event");

    unmount(rendered);
  });

  test("malformed JSON in question.request payload falls back gracefully", () => {
    const sessionId = "malformed-question-session";
    const store = createWebSessionStore(sessionId, "demo");
    const addQuestionRequest = mock(() => {});
    store.setState({ addQuestionRequest });
    const rendered = renderHook("demo", sessionId);

    const serverEvent = {
      type: "question.request",
      questionId: "question-1",
      question: "not valid json {bad",
    };

    MockEventSource.instances[0]?.dispatch("stream", serverEvent, "question-event");

    expect(addQuestionRequest).toHaveBeenCalledWith({
      id: "question-1",
      sessionId,
      toolName: "ask_user",
      toolCallId: "",
      questions: [{ text: "not valid json {bad" }],
    });

    unmount(rendered);
  });

  test("malformed SSE stream data is skipped without crashing", () => {
    const sessionId = "bad-json-sse-session";
    const store = createWebSessionStore(sessionId, "demo");
    const append = mock(() => {});
    store.setState({ append });
    const rendered = renderHook("demo", sessionId);

    MockEventSource.instances[0]?.dispatchRaw("stream", "{invalid json}", "bad-1");

    expect(append).not.toHaveBeenCalled();

    unmount(rendered);
  });

  test("receiving permission.terminal via stream calls store.handlePermissionTerminal", () => {
    const sessionId = "terminal-session";
    const store = createWebSessionStore(sessionId, "demo");
    const handlePermissionTerminal = mock(() => {});
    store.setState({ handlePermissionTerminal });
    const rendered = renderHook("demo", sessionId);

    const terminalEvent: PermissionTerminalEvent = {
      type: "permission.terminal",
      permissionId: "permission-1",
      status: "resolved",
    };

    MockEventSource.instances[0]?.dispatch("stream", terminalEvent, "terminal-1");

    expect(handlePermissionTerminal).toHaveBeenCalledWith(terminalEvent);
    expect(store.getState().lastEventId).toBe("terminal-1");

    unmount(rendered);
  });

  test("permission terminal stream event removes a pending permission", () => {
    const sessionId = "pending-terminal-session";
    const store = createWebSessionStore(sessionId, "demo");
    store.getState().addPermissionRequest({
      id: "permission-1",
      sessionId,
      toolName: "bash",
      toolCallId: "",
      input: { command: "pwd" },
      description: "Run command",
    });
    store.getState().addPermissionRequest({
      id: "permission-2",
      sessionId,
      toolName: "edit",
      toolCallId: "",
      input: { file: "x" },
      description: "Edit file",
    });
    const rendered = renderHook("demo", sessionId);

    MockEventSource.instances[0]?.dispatch(
      "stream",
      { type: "permission.terminal", permissionId: "permission-1", status: "resolved" } satisfies PermissionTerminalEvent,
      "terminal-remove-1",
    );

    expect(store.getState().pendingPermissions.has("permission-1")).toBe(false);
    expect(store.getState().pendingPermissions.has("permission-2")).toBe(true);
    expect(store.getState().lastEventId).toBe("terminal-remove-1");

    unmount(rendered);
  });

  test("receiving question.terminal via stream calls store.handleQuestionTerminal", () => {
    const sessionId = "q-terminal-session";
    const store = createWebSessionStore(sessionId, "demo");
    const handleQuestionTerminal = mock(() => {});
    store.setState({ handleQuestionTerminal });
    const rendered = renderHook("demo", sessionId);

    const terminalEvent: QuestionTerminalEvent = {
      type: "question.terminal",
      questionId: "question-1",
      status: "resolved",
      answer: "yes",
    };

    MockEventSource.instances[0]?.dispatch("stream", terminalEvent, "qt-1");

    expect(handleQuestionTerminal).toHaveBeenCalledWith(terminalEvent);
    expect(store.getState().lastEventId).toBe("qt-1");

    unmount(rendered);
  });

  test("question terminal stream event removes a pending question", () => {
    const sessionId = "pending-question-terminal-session";
    const store = createWebSessionStore(sessionId, "demo");
    store.getState().addQuestionRequest({
      id: "question-1",
      sessionId,
      toolName: "ask_user",
      toolCallId: "",
      questions: [{ text: "Continue?" }],
    });
    store.getState().addQuestionRequest({
      id: "question-2",
      sessionId,
      toolName: "ask_user",
      toolCallId: "",
      questions: [{ text: "Stop?" }],
    });
    const rendered = renderHook("demo", sessionId);

    MockEventSource.instances[0]?.dispatch(
      "stream",
      { type: "question.terminal", questionId: "question-1", status: "resolved", answer: "yes" } satisfies QuestionTerminalEvent,
      "question-terminal-remove-1",
    );

    expect(store.getState().pendingQuestions.has("question-1")).toBe(false);
    expect(store.getState().pendingQuestions.has("question-2")).toBe(true);
    expect(store.getState().lastEventId).toBe("question-terminal-remove-1");

    unmount(rendered);
  });

  test("receiving shutdown via stream payload closes connection", () => {
    const sessionId = "shutdown-session";
    const store = createWebSessionStore(sessionId, "demo");
    const setConnectionState = mock(() => {});
    store.setState({ setConnectionState });
    const rendered = renderHook("demo", sessionId);
    const source = MockEventSource.instances[0]!;

    act(() => {
      source.dispatch("stream", { type: "shutdown", reason: "server stopping" }, "sd-1");
    });

    expect(setConnectionState).toHaveBeenCalledWith("closed");
    expect(source.close).toHaveBeenCalled();

    unmount(rendered);
  });

  test("receiving reset event triggers onReset callback, calls resetTransientState, and closes EventSource", () => {
    const sessionId = "reset-session";
    const store = createWebSessionStore(sessionId, "demo");
    const resetTransientState = mock(() => {});
    const onReset = mock(() => {});
    store.setState({ resetTransientState });
    const rendered = renderHook("demo", sessionId, { onReset });
    const source = MockEventSource.instances[0]!;

    act(() => {
      source.dispatch("reset", {}, "reset-1");
    });

    expect(resetTransientState).toHaveBeenCalled();
    expect(source.close).toHaveBeenCalled();
    expect(onReset).toHaveBeenCalled();

    unmount(rendered);
  });

  test("reset clears transient state and parent refetch can reconnect with new cursor", () => {
    const sessionId = "reset-refetch-session";
    const store = createWebSessionStore(sessionId, "demo");
    const onReset = mock(() => {});
    store.getState().addPermissionRequest({
      id: "permission-reset",
      sessionId,
      toolName: "bash",
      toolCallId: "",
      input: { command: "pwd" },
      description: "Run command",
    });
    store.getState().addQuestionRequest({
      id: "question-reset",
      sessionId,
      toolName: "ask_user",
      toolCallId: "",
      questions: [{ text: "Continue?" }],
    });
    store.setState({ lastEventId: "stale-99", connectionState: "open" });
    const firstRender = renderHook("demo", sessionId, { eventCursor: 99, onReset });
    const firstSource = MockEventSource.instances[0]!;

    act(() => {
      firstSource.dispatch("reset", {}, "reset-gap");
    });

    expect(store.getState().pendingPermissions.size).toBe(0);
    expect(store.getState().pendingQuestions.size).toBe(0);
    expect(store.getState().lastEventId).toBeNull();
    expect(firstSource.close).toHaveBeenCalled();
    expect(onReset).toHaveBeenCalled();
    unmount(firstRender);

    const secondRender = renderHook("demo", sessionId, { eventCursor: 123, onReset });
    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.url).toBe(
      "/api/projects/demo/sessions/reset-refetch-session/events?lastEventId=123",
    );

    unmount(secondRender);
  });

  test("onerror triggers close and reconnect with lastEventId in URL", () => {
    const sessionId = "reconnect-session";
    const store = createWebSessionStore(sessionId, "demo");
    store.setState({ lastEventId: "event-9" });
    const rendered = renderHook("demo", sessionId);
    const source = MockEventSource.instances[0]!;

    act(() => {
      source.emitError();
    });

    expect(source.close).toHaveBeenCalled();
    expect(store.getState().connectionState).toBe("reconnecting");

    act(() => {
      advanceTimers(1_000);
    });

    expect(MockEventSource.instances).toHaveLength(2);
    expect(MockEventSource.instances[1]?.url).toBe(
      "/api/projects/demo/sessions/reconnect-session/events?lastEventId=event-9",
    );

    unmount(rendered);
  });

  test("exponential backoff uses 1s, 2s, 4s, then max 30s", () => {
    const sessionId = "backoff-session";
    const rendered = renderHook("demo", sessionId);
    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];

    for (const delay of expectedDelays) {
      const source = MockEventSource.instances.at(-1)!;
      act(() => {
        source.emitError();
      });
      expect(source.close).toHaveBeenCalled();

      act(() => {
        advanceTimers(delay - 1);
      });
      expect(MockEventSource.instances.at(-1)).toBe(source);

      act(() => {
        advanceTimers(1);
      });
      expect(MockEventSource.instances.at(-1)).not.toBe(source);
    }

    expect(MockEventSource.instances).toHaveLength(expectedDelays.length + 1);

    unmount(rendered);
  });

  test("onopen resets backoff", () => {
    const sessionId = "reset-session";
    const rendered = renderHook("demo", sessionId);
    const firstSource = MockEventSource.instances[0]!;

    act(() => {
      firstSource.emitError();
      advanceTimers(1_000);
    });
    const secondSource = MockEventSource.instances[1]!;

    act(() => {
      secondSource.emitOpen();
      secondSource.emitError();
    });

    act(() => {
      advanceTimers(999);
    });
    expect(MockEventSource.instances).toHaveLength(2);

    act(() => {
      advanceTimers(1);
    });
    expect(MockEventSource.instances).toHaveLength(3);

    unmount(rendered);
  });

  test("unmount closes EventSource and clears pending timeout", () => {
    const rendered = renderHook("demo", "cleanup-session");
    const source = MockEventSource.instances[0]!;

    act(() => {
      source.emitError();
    });
    unmount(rendered);

    expect(source.close).toHaveBeenCalled();

    act(() => {
      advanceTimers(1_000);
    });
    expect(MockEventSource.instances).toHaveLength(1);
  });

  test("createWebSessionStore scopes same session id by slug", () => {
    const slugAStore = createWebSessionStore("same-session", "slug-a");
    const slugBStore = createWebSessionStore("same-session", "slug-b");
    const unscopedStore = createWebSessionStore("same-session");

    expect(slugAStore).not.toBe(slugBStore);
    expect(slugAStore).not.toBe(unscopedStore);
    expect(slugBStore).not.toBe(unscopedStore);
    expect(createWebSessionStore("same-session", "slug-a")).toBe(slugAStore);
    expect(createWebSessionStore("same-session")).toBe(unscopedStore);
  });
});
