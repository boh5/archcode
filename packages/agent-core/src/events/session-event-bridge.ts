import type { GlobalSSEEvent, GlobalSessionEventEnvelope } from "@archcode/protocol";
import type { StoreApi } from "zustand";
import { scopedKey } from "../store/key";
import type { SessionEventEnvelope, SessionStoreState } from "../store/types";

export interface SubscribeSessionEventsInput {
  readonly slug: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly startEventId?: number;
  readonly onEvent: (event: GlobalSSEEvent) => void;
}

export interface SessionEventBridgeOptions {
  readonly getStore?: (workspaceRoot: string, sessionId: string) => StoreApi<SessionStoreState> | undefined;
}

interface SubscriptionRegistration extends SubscribeSessionEventsInput {
  lastForwardedNextEventId: number;
  unsubscribeStore?: () => void;
}

export class SessionEventBridge {
  readonly #subscriptions = new Map<string, Set<SubscriptionRegistration>>();
  readonly #attachedStores = new Map<string, StoreApi<SessionStoreState>>();
  readonly #getStore?: (workspaceRoot: string, sessionId: string) => StoreApi<SessionStoreState> | undefined;

  constructor(options: SessionEventBridgeOptions = {}) {
    this.#getStore = options.getStore;
  }

  subscribe(input: SubscribeSessionEventsInput): () => void {
    const key = scopedKey(input.workspaceRoot, input.sessionId);
    const registration: SubscriptionRegistration = {
      ...input,
      lastForwardedNextEventId: input.startEventId ?? 0,
    };
    const registrations = this.#subscriptions.get(key) ?? new Set<SubscriptionRegistration>();
    registrations.add(registration);
    this.#subscriptions.set(key, registrations);

    const store = this.#attachedStores.get(key) ?? this.#getStore?.(input.workspaceRoot, input.sessionId);
    if (store) this.#attachSubscription(registration, store);

    return () => {
      registration.unsubscribeStore?.();
      registrations.delete(registration);
      if (registrations.size === 0) {
        this.#subscriptions.delete(key);
        this.#attachedStores.delete(key);
      }
    };
  }

  hasSubscriptions(workspaceRoot: string, sessionId: string): boolean {
    return (this.#subscriptions.get(scopedKey(workspaceRoot, sessionId))?.size ?? 0) > 0;
  }

  attachSession(
    workspaceRoot: string,
    sessionId: string,
    store: StoreApi<SessionStoreState>,
  ): void {
    const key = scopedKey(workspaceRoot, sessionId);
    this.#attachedStores.set(key, store);
    const registrations = this.#subscriptions.get(key);
    if (!registrations) return;
    for (const registration of registrations) {
      this.#attachSubscription(registration, store);
    }
  }

  detachSession(workspaceRoot: string, sessionId: string): void {
    const key = scopedKey(workspaceRoot, sessionId);
    this.#attachedStores.delete(key);
    const registrations = this.#subscriptions.get(key);
    if (!registrations) return;
    for (const registration of registrations) {
      registration.unsubscribeStore?.();
      registration.unsubscribeStore = undefined;
    }
    this.#subscriptions.delete(key);
  }

  #attachSubscription(
    registration: SubscriptionRegistration,
    store: StoreApi<SessionStoreState>,
  ): void {
    registration.unsubscribeStore?.();
    registration.unsubscribeStore = store.subscribe((current) => this.#forwardCurrent(registration, current));
    this.#forwardCurrent(registration, store.getState());
  }

  #forwardCurrent(registration: SubscriptionRegistration, current: SessionStoreState): void {
    if (current.nextEventId <= registration.lastForwardedNextEventId) return;

    if (registration.lastForwardedNextEventId < current.eventOffset) {
      registration.lastForwardedNextEventId = current.nextEventId;
      registration.onEvent({
        type: "reset",
        slug: registration.slug,
        sessionId: registration.sessionId,
        reason: "lagged",
      });
      return;
    }

    const start = registration.lastForwardedNextEventId - current.eventOffset;
    const envelopes: SessionEventEnvelope[] = current.events.slice(start);
    registration.lastForwardedNextEventId = current.nextEventId;
    for (const envelope of envelopes) {
      const event: GlobalSessionEventEnvelope = {
        type: "event",
        slug: registration.slug,
        sessionId: registration.sessionId,
        eventId: envelope.id,
        createdAt: envelope.createdAt,
        kind: envelope.kind,
        payload: envelope.payload,
        agentName: current.agentName,
      };
      registration.onEvent(event);
    }
  }
}
