import type { GlobalSessionEventEnvelope, SessionEventEnvelope } from "@archcode/protocol";

export interface SessionEventSourceEvent {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly envelope: SessionEventEnvelope;
}

export interface SessionEventSource {
  subscribeToSessionEvents(listener: (event: SessionEventSourceEvent) => void): () => void;
}

export interface SessionEventBridgeOptions {
  readonly source: SessionEventSource;
  readonly resolveProjectSlug: (workspaceRoot: string) => string | undefined;
}

export type SessionEventListener = (event: GlobalSessionEventEnvelope) => void;

/**
 * Maps durable StoreManager events onto the global SSE wire shape.
 * Its lifetime is independent of any Execution; Queue mutations while idle use the same path.
 */
export class SessionEventBridge {
  readonly #listeners = new Set<SessionEventListener>();
  readonly #resolveProjectSlug: SessionEventBridgeOptions["resolveProjectSlug"];
  readonly #unsubscribeSource: () => void;

  constructor(options: SessionEventBridgeOptions) {
    this.#resolveProjectSlug = options.resolveProjectSlug;
    this.#unsubscribeSource = options.source.subscribeToSessionEvents(
      (event) => this.#forward(event),
    );
  }

  subscribe(listener: SessionEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.#listeners.clear();
    this.#unsubscribeSource();
  }

  #forward(sourceEvent: SessionEventSourceEvent): void {
    const slug = this.#resolveProjectSlug(sourceEvent.workspaceRoot);
    if (slug === undefined) return;
    const event: GlobalSessionEventEnvelope = {
      type: "event",
      slug,
      sessionId: sourceEvent.sessionId,
      eventId: sourceEvent.envelope.id,
      createdAt: sourceEvent.envelope.createdAt,
      payload: sourceEvent.envelope.payload,
      agentName: sourceEvent.agentName,
    };
    for (const listener of this.#listeners) listener(event);
  }
}
