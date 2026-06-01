import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StoreApi } from "zustand";
import type {
  GlobalSessionEventEnvelope,
  GlobalSSEHeartbeatEvent,
  GlobalSSEResetEvent,
  GlobalSSELaggedEvent,
  GlobalSSEShutdownEvent,
} from "@specra/protocol";
import type { WebSessionStoreState } from "../store/session-store";
import { parseSSEEvent, handleSSEEvent } from "./global-sse";
import type { SSEEventHandlerDeps } from "./global-sse";

function createMockStore(): StoreApi<WebSessionStoreState> {
  return {
    getState: () => ({ applyRemoteEnvelope: mockApplyRemoteEnvelope } as unknown as WebSessionStoreState),
    subscribe: () => () => {},
    getInitialState: () => ({} as WebSessionStoreState),
  } as unknown as StoreApi<WebSessionStoreState>;
}

const mockApplyRemoteEnvelope = mock((_envelope: GlobalSessionEventEnvelope) => {});
const mockInitializeFromSnapshot = mock((_data: Partial<WebSessionStoreState>) => {});
const mockFindWebSessionStore = mock(
  (_sessionId: string, _slug?: string) => undefined as StoreApi<WebSessionStoreState> | undefined,
);
const mockCreateWebSessionStore = mock(
  (_sessionId: string, _slug?: string) => createMockStore(),
);
const mockInvalidateQueries = mock((_opts: { queryKey: readonly unknown[] }) => Promise.resolve());
const mockOnShutdown = mock(() => {});
const mockOnHeartbeat = mock((_createdAt: number) => {});

function createDeps(): SSEEventHandlerDeps {
  return {
    findStore: mockFindWebSessionStore,
    createStore: mockCreateWebSessionStore,
    invalidateQueries: mockInvalidateQueries,
    onShutdown: mockOnShutdown,
    onHeartbeat: mockOnHeartbeat,
  };
}

describe("parseSSEEvent", () => {
  test("parses valid event type", () => {
    const data = JSON.stringify({ type: "event", slug: "p", sessionId: "s", eventId: 1, createdAt: 0, kind: "text-start", payload: { type: "text-start" } });
    const result = parseSSEEvent("event", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("event");
  });

  test("parses heartbeat event", () => {
    const data = JSON.stringify({ type: "heartbeat", createdAt: 123 });
    const result = parseSSEEvent("heartbeat", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("heartbeat");
  });

  test("parses reset event", () => {
    const data = JSON.stringify({ type: "reset", slug: "p", sessionId: "s", reason: "stale_cursor" });
    const result = parseSSEEvent("reset", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("reset");
  });

  test("parses lagged event", () => {
    const data = JSON.stringify({ type: "lagged", dropped: 5, reason: "client_backpressure" });
    const result = parseSSEEvent("lagged", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("lagged");
  });

  test("parses shutdown event", () => {
    const data = JSON.stringify({ type: "shutdown", reason: "server_shutdown" });
    const result = parseSSEEvent("shutdown", data);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("shutdown");
  });

  test("returns null for malformed JSON", () => {
    const result = parseSSEEvent("event", "not-json");
    expect(result).toBeNull();
  });

  test("returns null for unknown event type", () => {
    const result = parseSSEEvent("event", JSON.stringify({ type: "unknown" }));
    expect(result).toBeNull();
  });

  test("returns null for unknown SSE event name", () => {
    const result = parseSSEEvent("unknown-type", JSON.stringify({ type: "event" }));
    expect(result).not.toBeNull();
  });
});

describe("handleSSEEvent", () => {
  let deps: SSEEventHandlerDeps;

  beforeEach(() => {
    mockApplyRemoteEnvelope.mockClear();
    mockInitializeFromSnapshot.mockClear();
    mockFindWebSessionStore.mockClear();
    mockCreateWebSessionStore.mockClear();
    mockInvalidateQueries.mockClear();
    mockOnShutdown.mockClear();
    mockOnHeartbeat.mockClear();
    deps = createDeps();
  });

  test("routes event to matching session store via applyRemoteEnvelope", () => {
    const mockStore = createMockStore();
    mockFindWebSessionStore.mockReturnValue(mockStore);

    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "my-project",
      sessionId: "session-1",
      eventId: 42,
      createdAt: Date.now(),
      kind: "text-start",
      payload: { type: "text-start" },
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockFindWebSessionStore).toHaveBeenCalledWith("session-1", "my-project");
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("creates a store when no matching session store exists", () => {
    mockFindWebSessionStore.mockReturnValue(undefined);
    const mockStore = createMockStore();
    mockCreateWebSessionStore.mockReturnValue(mockStore);

    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "my-project",
      sessionId: "unknown-session",
      eventId: 1,
      createdAt: Date.now(),
      kind: "text-start",
      payload: { type: "text-start" },
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockFindWebSessionStore).toHaveBeenCalledWith("unknown-session", "my-project");
    expect(mockCreateWebSessionStore).toHaveBeenCalledWith("unknown-session", "my-project");
    expect(mockApplyRemoteEnvelope).toHaveBeenCalledWith(envelope);
  });

  test("invalidates topology queries and preloads child metadata on child session link", () => {
    const parentStore = createMockStore();
    const childStore = {
      ...createMockStore(),
      getState: () => ({
        applyRemoteEnvelope: mockApplyRemoteEnvelope,
        initializeFromSnapshot: mockInitializeFromSnapshot,
      } as unknown as WebSessionStoreState),
    } as StoreApi<WebSessionStoreState>;
    parentStore.getState = () => ({
      applyRemoteEnvelope: mockApplyRemoteEnvelope,
      rootSessionId: "root-session",
    } as unknown as WebSessionStoreState);
    mockFindWebSessionStore.mockReturnValue(undefined);
    mockFindWebSessionStore.mockImplementation((sessionId) => sessionId === "parent-session" ? parentStore : undefined);
    mockCreateWebSessionStore.mockReturnValue(childStore);

    const envelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: "proj",
      sessionId: "parent-session",
      eventId: 1,
      createdAt: Date.now(),
      kind: "tool-child-session-link",
      payload: {
        type: "tool-child-session-link",
        link: {
          parentSessionId: "parent-session",
          parentToolCallId: "call-1",
          toolName: "delegate",
          childSessionId: "child-session",
          childAgentName: "explore",
          title: "Explore files",
          depth: 1,
          background: true,
          status: "running",
          createdAt: 123,
        },
      },
    };

    handleSSEEvent({ event: "event", data: JSON.stringify(envelope) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions"] });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ["projects", "proj", "sessions", "root-session", "tree"] });
    expect(mockCreateWebSessionStore).toHaveBeenCalledWith("child-session", "proj");
    expect(mockInitializeFromSnapshot).toHaveBeenCalledWith({
      rootSessionId: "root-session",
      parentSessionId: "parent-session",
      title: "Explore files",
      createdAt: 123,
    });
  });

  test("invalidates session query on reset event", () => {
    const resetEvent: GlobalSSEResetEvent = {
      type: "reset",
      slug: "my-project",
      sessionId: "session-1",
      reason: "stale_cursor",
    };

    handleSSEEvent({ event: "reset", data: JSON.stringify(resetEvent) }, deps);

    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: ["projects", "my-project", "sessions", "session-1"],
    });
  });

  test("does not call shutdown on reset event", () => {
    const resetEvent: GlobalSSEResetEvent = {
      type: "reset",
      slug: "proj",
      sessionId: "s1",
      reason: "lagged",
    };

    handleSSEEvent({ event: "reset", data: JSON.stringify(resetEvent) }, deps);

    expect(mockOnShutdown).not.toHaveBeenCalled();
  });

  test("handles lagged event without side effects", () => {
    const laggedEvent: GlobalSSELaggedEvent = {
      type: "lagged",
      dropped: 50,
      reason: "client_backpressure",
    };

    handleSSEEvent({ event: "lagged", data: JSON.stringify(laggedEvent) }, deps);

    expect(mockOnShutdown).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
  });

  test("updates heartbeat timestamp on heartbeat event", () => {
    const heartbeat: GlobalSSEHeartbeatEvent = {
      type: "heartbeat",
      createdAt: 1700000000000,
    };

    handleSSEEvent({ event: "heartbeat", data: JSON.stringify(heartbeat) }, deps);

    expect(mockOnHeartbeat).toHaveBeenCalledWith(1700000000000);
  });

  test("calls onShutdown on shutdown event", () => {
    const shutdown: GlobalSSEShutdownEvent = {
      type: "shutdown",
      reason: "server_shutdown",
    };

    handleSSEEvent({ event: "shutdown", data: JSON.stringify(shutdown) }, deps);

    expect(mockOnShutdown).toHaveBeenCalled();
  });

  test("ignores malformed JSON in event data", () => {
    handleSSEEvent({ event: "event", data: "not-json" }, deps);

    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
  });

  test("ignores unknown SSE event types with valid JSON", () => {
    handleSSEEvent({ event: "unknown-type", data: JSON.stringify({ type: "unknown" }) }, deps);

    expect(mockFindWebSessionStore).not.toHaveBeenCalled();
    expect(mockOnShutdown).not.toHaveBeenCalled();
    expect(mockOnHeartbeat).not.toHaveBeenCalled();
    expect(mockInvalidateQueries).not.toHaveBeenCalled();
  });
});
