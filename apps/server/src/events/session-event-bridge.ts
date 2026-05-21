import { scopedKey } from "@specra/agent-core";
import type { SessionStoreState } from "@specra/agent-core";
import type {
  GlobalSSEEvent,
  GlobalSSELaggedEvent,
  GlobalSSEResetEvent,
  GlobalSessionEventEnvelope,
} from "@specra/protocol";
import type { StoreApi } from "zustand";
import { globalEventBus, type GlobalEventBus } from "./global-event-bus";

export interface RegisterSessionEventBridgeInput {
  slug: string;
  workspaceRoot: string;
  sessionId: string;
  store: StoreApi<SessionStoreState>;
}

interface BridgeRegistration extends RegisterSessionEventBridgeInput {
  lastForwardedNextEventId: number;
  unsubscribeStore: () => void;
}

const registrations = new Map<string, BridgeRegistration>();
let eventBus: GlobalEventBus = globalEventBus;

function emitGlobal(event: GlobalSSEEvent): void {
  eventBus.emit(event);
}

function emitLagged(input: RegisterSessionEventBridgeInput, dropped: number): void {
  const laggedEvent: GlobalSSELaggedEvent = {
    type: "lagged",
    dropped,
    reason: "client_backpressure",
  };
  void laggedEvent;

  const resetEvent: GlobalSSEResetEvent = {
    type: "reset",
    slug: input.slug,
    sessionId: input.sessionId,
    reason: "lagged",
  };
  emitGlobal(resetEvent);
}

function forwardCurrent(registration: BridgeRegistration, current: SessionStoreState): void {
  if (current.nextEventId <= registration.lastForwardedNextEventId) return;

  if (registration.lastForwardedNextEventId < current.eventOffset) {
    emitLagged(registration, current.eventOffset - registration.lastForwardedNextEventId);
    registration.lastForwardedNextEventId = current.nextEventId;
    return;
  }

  const start = registration.lastForwardedNextEventId - current.eventOffset;
  const envelopes = current.events.slice(start);
  registration.lastForwardedNextEventId = current.nextEventId;

  for (const envelope of envelopes) {
    const globalEnvelope: GlobalSessionEventEnvelope = {
      type: "event",
      slug: registration.slug,
      sessionId: registration.sessionId,
      eventId: envelope.id,
      createdAt: envelope.createdAt,
      kind: envelope.kind,
      payload: envelope.payload,
    };
    emitGlobal(globalEnvelope);
  }
}

export function registerSessionEventBridge(input: RegisterSessionEventBridgeInput): () => void {
  const key = scopedKey(input.workspaceRoot, input.sessionId);
  const existing = registrations.get(key);
  existing?.unsubscribeStore();

  const registration: BridgeRegistration = {
    ...input,
    lastForwardedNextEventId: existing?.lastForwardedNextEventId ?? 0,
    unsubscribeStore: () => undefined,
  };

  registration.unsubscribeStore = input.store.subscribe((current) => forwardCurrent(registration, current));
  registrations.set(key, registration);
  forwardCurrent(registration, input.store.getState());

  return () => {
    const current = registrations.get(key);
    if (current !== registration) return;
    current.unsubscribeStore();
    registrations.delete(key);
  };
}

export function unregisterSessionEventBridge(workspaceRoot: string, sessionId: string): void {
  const key = scopedKey(workspaceRoot, sessionId);
  const current = registrations.get(key);
  current?.unsubscribeStore();
  registrations.delete(key);
}

export function appendShutdownToActiveSessionStores(reason: string): void {
  for (const registration of registrations.values()) {
    registration.store.getState().append({ type: "shutdown", reason });
  }
}

export function __setGlobalEventBusForTest(bus: GlobalEventBus): void {
  eventBus = bus;
}

export function __resetSessionEventBridgesForTest(): void {
  for (const registration of registrations.values()) {
    registration.unsubscribeStore();
  }
  registrations.clear();
  eventBus = globalEventBus;
}

export function __getSessionEventBridgeCountForTest(): number {
  return registrations.size;
}
