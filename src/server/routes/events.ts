import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StoreApi } from "zustand";
import type { SpecraRuntime } from "../../runtime";
import { loadSessionTranscript } from "../../store/helpers";
import { createSessionStore, getSessionStore, scopedKey } from "../../store/store";
import type { SessionEventEnvelope, SessionStoreState } from "../../store/types";
import { AgentRunner } from "../agent-runner";
import { BadRequestError } from "../errors";
import { resolveProject } from "../resolve";

export interface EventsRoutesOptions {
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15000;

export interface SessionStreamState {
  store?: StoreApi<SessionStoreState>;
  lastSentEventId: number;
}

export const sessionStreams = new Map<string, SessionStreamState>();

export function removeSessionStream(workspaceRoot: string, sessionId: string): void {
  sessionStreams.delete(scopedKey(workspaceRoot, sessionId));
}

export function createEventsRoutes(runtime: SpecraRuntime, agentRunner: AgentRunner, options?: EventsRoutesOptions): Hono {
  const heartbeatIntervalMs = options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const app = new Hono();

  app.get("/", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const project = await resolveProject(runtime, slug);
    const state = await getSessionStreamState(runtime, agentRunner, sessionId, project.workspaceRoot);
    const lastEventId = readLastEventId(c.req.query("lastEventId"), c.req.header("Last-Event-ID"));

    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let writeQueue = Promise.resolve();
      let nextEventIdToSend = state.store?.getState().nextEventId ?? 0;
      let resolveDone: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });

      const writeEnvelope = async (envelope: SessionEventEnvelope): Promise<void> => {
        if (closed) return;
        await stream.writeSSE({
          event: "stream",
          id: String(envelope.id),
          data: JSON.stringify(envelope.payload),
        });
        if (envelope.payload.type === "shutdown") {
          cleanup();
        }
      };

      const writeReset = async (): Promise<void> => {
        if (closed) return;
        await stream.writeSSE({ event: "reset", data: "{}" });
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        resolveDone?.();
      };

      stream.onAbort(cleanup);

      const enqueue = (write: () => Promise<void>): void => {
        writeQueue = writeQueue.then(write).catch(() => cleanup());
      };

      const enqueueNewEvents = (current: SessionStoreState): void => {
        if (closed || current.nextEventId <= nextEventIdToSend) return;
        if (nextEventIdToSend < current.eventOffset) {
          enqueue(async () => {
            await writeReset();
            cleanup();
          });
          return;
        }

        const start = nextEventIdToSend - current.eventOffset;
        const envelopes = current.events.slice(start);
        nextEventIdToSend = current.nextEventId;
        state.lastSentEventId = nextEventIdToSend - 1;
        enqueue(async () => {
          for (const envelope of envelopes) {
            await writeEnvelope(envelope);
          }
        });
      };

      try {
        const store = state.store;
        if (!store) {
          await writeReset();
          return;
        }

        const initial = store.getState();
        const resetRequired = lastEventId !== undefined && isStaleCursor(lastEventId, initial);
        if (resetRequired) {
          await writeReset();
          return;
        }

        nextEventIdToSend = lastEventId === undefined ? initial.eventOffset : lastEventId + 1;
        unsubscribe = store.subscribe((current) => enqueueNewEvents(current));
        enqueueNewEvents(initial);
        enqueueNewEvents(store.getState());

        heartbeat = setInterval(() => {
          if (closed) return;
          enqueue(async () => {
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
          });
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

async function getSessionStreamState(
  runtime: SpecraRuntime,
  agentRunner: AgentRunner,
  sessionId: string,
  workspaceRoot: string,
): Promise<SessionStreamState> {
  const key = scopedKey(workspaceRoot, sessionId);
  const existing = sessionStreams.get(key);
  if (existing) {
    existing.store = await resolveStore(runtime, agentRunner, sessionId, workspaceRoot, existing.store);
    existing.lastSentEventId = existing.store.getState().nextEventId - 1;
    return existing;
  }

  const store = await resolveStore(runtime, agentRunner, sessionId, workspaceRoot);
  const state: SessionStreamState = {
    store,
    lastSentEventId: store.getState().nextEventId - 1,
  };
  sessionStreams.set(key, state);
  return state;
}

async function resolveStore(
  runtime: SpecraRuntime,
  agentRunner: AgentRunner,
  sessionId: string,
  workspaceRoot: string,
  fallback?: StoreApi<SessionStoreState>,
): Promise<StoreApi<SessionStoreState>> {
  const jobAgent = agentRunner.getJob(workspaceRoot, sessionId)
    ? runtime.sessionAgentManager.get(workspaceRoot, sessionId)
    : undefined;
  if (jobAgent) return jobAgent.store;

  const registered = getSessionStore(sessionId, workspaceRoot);
  if (registered) return registered;
  if (fallback) return fallback;

  try {
    return await loadSessionTranscript(sessionId, workspaceRoot);
  } catch {
    return createSessionStore(sessionId, workspaceRoot);
  }
}

function readLastEventId(queryValue: string | undefined, headerValue: string | undefined): number | undefined {
  const raw = queryValue ?? headerValue;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isStaleCursor(lastEventId: number, state: SessionStoreState): boolean {
  return lastEventId < state.eventOffset - 1 || lastEventId >= state.nextEventId;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

