import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { Root } from "react-dom/client";
import type { PermissionRequest, QuestionRequest } from "../api/types";
import type { StreamEvent } from "../../../store/types";

type UseSessionEventsHook = typeof import("./use-session-events").useSessionEvents;
type WebSessionStoreFactory = typeof import("../store/session-store").createWebSessionStore;
type MockSessionState = {
  append: (event: StreamEvent) => void;
  addPermissionRequest: (request: PermissionRequest) => void;
  addQuestionRequest: (request: QuestionRequest) => void;
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

function createMockSessionStore(sessionId: string): ReturnType<WebSessionStoreFactory> {
  const existing = sessionRegistry.get(sessionId);
  if (existing) return existing;

  let state: MockSessionState = {
    append: () => {},
    addPermissionRequest: () => {},
    addQuestionRequest: () => {},
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

  sessionRegistry.set(sessionId, store);
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

function TestHarness(props: { slug: string; sessionId: string }) {
  useSessionEvents(props.slug, props.sessionId);
  return null;
}

function renderHook(slug: string, sessionId: string): { root: Root; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  act(() => {
    root.render({ type: TestHarness, props: { slug, sessionId } } as unknown as React.ReactNode);
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

  test("receiving stream events calls store.append", () => {
    const sessionId = "stream-session";
    const store = createWebSessionStore(sessionId);
    const append = mock(() => {});
    store.setState({ append });
    const rendered = renderHook("demo", sessionId);
    const event: StreamEvent = { type: "text-delta", text: "hello" };

    MockEventSource.instances[0]?.dispatch("stream", event, "stream-1");

    expect(append).toHaveBeenCalledWith(event);
    expect(store.getState().lastEventId).toBe("stream-1");

    unmount(rendered);
  });

  test("receiving permission.request calls store.addPermissionRequest", () => {
    const sessionId = "permission-session";
    const store = createWebSessionStore(sessionId);
    const addPermissionRequest = mock(() => {});
    store.setState({ addPermissionRequest });
    const rendered = renderHook("demo", sessionId);
    const request: PermissionRequest = {
      id: "permission-1",
      sessionId,
      toolName: "bash",
      toolCallId: "tool-1",
      input: { command: "pwd" },
      description: "Run command",
    };

    MockEventSource.instances[0]?.dispatch("permission.request", request, "permission-event");

    expect(addPermissionRequest).toHaveBeenCalledWith(request);
    expect(store.getState().lastEventId).toBe("permission-event");

    unmount(rendered);
  });

  test("receiving question.request calls store.addQuestionRequest", () => {
    const sessionId = "question-session";
    const store = createWebSessionStore(sessionId);
    const addQuestionRequest = mock(() => {});
    store.setState({ addQuestionRequest });
    const rendered = renderHook("demo", sessionId);
    const request: QuestionRequest = {
      id: "question-1",
      sessionId,
      toolName: "ask_user",
      toolCallId: "tool-2",
      questions: [{ text: "Continue?" }],
    };

    MockEventSource.instances[0]?.dispatch("question.request", request, "question-event");

    expect(addQuestionRequest).toHaveBeenCalledWith(request);
    expect(store.getState().lastEventId).toBe("question-event");

    unmount(rendered);
  });

  test("onerror triggers close and reconnect with lastEventId in URL", () => {
    const sessionId = "reconnect-session";
    const store = createWebSessionStore(sessionId);
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
});
