import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type {
  GlobalSSEEvent,
  GlobalSSEHeartbeatEvent,
  GlobalSSELaggedEvent,
  GlobalSessionEventEnvelope,
} from "@archcode/protocol";
import { MAX_EVENTS } from "@archcode/protocol";
import { globalEventBus, type GlobalEventBus } from "../events/global-event-bus";

export interface GlobalEventsRoutesOptions {
  heartbeatIntervalMs?: number;
  maxQueuedEvents?: number;
  onBeforeWrite?: (event: GlobalSSEEvent) => Promise<void> | void;
  initialEvents?: () => Promise<readonly GlobalSSEEvent[]> | readonly GlobalSSEEvent[];
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;

type QueuedGlobalEvent = GlobalSSEEvent;

export function createGlobalEventsRoutes(
  bus: GlobalEventBus = globalEventBus,
  options?: GlobalEventsRoutesOptions,
): Hono {
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxQueuedEvents = options?.maxQueuedEvents ?? MAX_EVENTS;
  const app = new Hono();

  app.get("/", (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let writeQueue = Promise.resolve();
      let queuedEvents: QueuedGlobalEvent[] = [];
      let bufferedInitialLiveEvents: QueuedGlobalEvent[] = [];
      let bufferingInitialEvents = true;
      let writing = false;
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        resolveDone?.();
      };

      stream.onAbort(cleanup);

      const writeEvent = async (event: GlobalSSEEvent): Promise<void> => {
        if (closed) return;
        await options?.onBeforeWrite?.(event);
        if (closed) return;
        await stream.writeSSE(toSSEMessage(event));
      };

      const flushQueuedEvents = async (): Promise<void> => {
        if (writing || closed) return;
        writing = true;
        try {
          while (!closed) {
            const event = queuedEvents.shift();
            if (!event) break;
            await writeEvent(event);
          }
        } finally {
          writing = false;
        }
      };

      const enqueue = (write: () => Promise<void>): void => {
        writeQueue = writeQueue.then(write).catch(() => cleanup());
      };

      const enqueueFlush = (): void => {
        enqueue(flushQueuedEvents);
      };

      const enqueueGlobalEvent = (event: GlobalSSEEvent): void => {
        if (closed) return;
        queuedEvents = appendBounded(queuedEvents, event, maxQueuedEvents);
        enqueueFlush();
      };

      const enqueueBusEvent = (event: GlobalSSEEvent): void => {
        if (closed) return;
        if (bufferingInitialEvents) {
          bufferedInitialLiveEvents = appendBounded(bufferedInitialLiveEvents, event, maxQueuedEvents);
          return;
        }
        enqueueGlobalEvent(event);
      };

      try {
        unsubscribe = bus.subscribe(enqueueBusEvent);
        const initialEvents = await options?.initialEvents?.();
        for (const event of initialEvents ?? []) enqueueGlobalEvent(event);
        bufferingInitialEvents = false;
        for (const event of bufferedInitialLiveEvents) enqueueGlobalEvent(event);
        bufferedInitialLiveEvents = [];
        heartbeat = setInterval(() => {
          enqueueGlobalEvent(createHeartbeatEvent());
        }, heartbeatIntervalMs);

        await done;
      } finally {
        await writeQueue.catch(() => undefined);
        cleanup();
      }
    });
  });

  return app;
}

function createHeartbeatEvent(): GlobalSSEHeartbeatEvent {
  return { type: "heartbeat", createdAt: Date.now() };
}

function createLaggedEvent(dropped: number): GlobalSSELaggedEvent {
  return { type: "lagged", dropped, reason: "client_backpressure" };
}

function appendBounded(events: QueuedGlobalEvent[], event: GlobalSSEEvent, maxQueuedEvents: number): QueuedGlobalEvent[] {
  const next = [...events, event];
  const overflow = next.length - maxQueuedEvents;
  if (overflow <= 0) return next;

  let dropped = 0;
  const retained: QueuedGlobalEvent[] = [];
  for (const queued of next) {
    if (dropped < overflow && queued.type === "event") {
      dropped += 1;
      continue;
    }
    retained.push(queued);
  }
  return dropped > 0 ? [createLaggedEvent(dropped), ...retained] : retained.slice(-maxQueuedEvents);
}

function toSSEMessage(event: GlobalSSEEvent): { event: string; data: string; id?: string } {
  if (event.type === "event") {
    return {
      event: "event",
      id: compositeEventId(event),
      data: JSON.stringify(event),
    };
  }

  return {
    event: event.type,
    data: JSON.stringify(event),
  };
}

function compositeEventId(event: GlobalSessionEventEnvelope): string {
  return `${event.slug}:${event.sessionId}:${event.eventId}`;
}
