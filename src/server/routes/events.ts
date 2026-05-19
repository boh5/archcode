import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StoreApi } from "zustand";
import type { SpecraRuntime } from "../../main";
import type { ProjectInfo } from "../../projects/types";
import { loadSessionTranscript } from "../../store/helpers";
import { createSessionStore, getSessionStore, scopedKey } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import { EventRing, type RingEntry } from "../event-ring";
import { AgentRunner } from "../agent-runner";
import { BadRequestError, ProjectNotFoundError } from "../errors";

const HEARTBEAT_INTERVAL_MS = 15000;

export interface SessionStreamState {
  ring: EventRing;
  store?: StoreApi<SessionStoreState>;
  pushedEventCount: number;
}

export const sessionStreams = new Map<string, SessionStreamState>();

export function getSessionRing(workspaceRoot: string, sessionId: string): EventRing | undefined {
  return sessionStreams.get(scopedKey(workspaceRoot, sessionId))?.ring;
}

export function ensureSessionRing(workspaceRoot: string, sessionId: string): EventRing {
  const key = scopedKey(workspaceRoot, sessionId);
  const existing = sessionStreams.get(key);
  if (existing) {
    return existing.ring;
  }

  const state: SessionStreamState = {
    ring: new EventRing(),
    pushedEventCount: 0,
  };
  sessionStreams.set(key, state);
  return state.ring;
}

export function removeSessionStream(workspaceRoot: string, sessionId: string): void {
  sessionStreams.delete(scopedKey(workspaceRoot, sessionId));
}

export function createEventsRoutes(runtime: SpecraRuntime, agentRunner: AgentRunner): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const slug = requiredParam(c.req.param("slug"), "slug");
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");
    const project = await resolveProject(runtime, slug);
    const state = await getSessionStreamState(runtime, agentRunner, sessionId, project.workspaceRoot);
    const lastId = readLastEventId(c.req.query("lastEventId"), c.req.header("Last-Event-ID"));

    return streamSSE(c, async (stream) => {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      const writeEntry = async (entry: RingEntry): Promise<void> => {
        if (closed) return;
        await stream.writeSSE({
          event: entry.event,
          id: String(entry.id),
          data: entry.data,
        });
      };

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
      };

      stream.onAbort(cleanup);

      try {
        if (lastId !== undefined && lastId < state.ring.currentId) {
          for (const entry of state.ring.since(lastId)) {
            await writeEntry(entry);
          }
        }

        unsubscribe = state.store?.subscribe((current, previous) => {
          if (closed) return;
          pushNewEvents(state, current, previous).forEach((entry) => {
            void writeEntry(entry).catch(() => cleanup());
          });
        });

        heartbeat = setInterval(() => {
          if (closed) return;
          void stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => cleanup());
        }, HEARTBEAT_INTERVAL_MS);

        await new Promise<void>((resolveDone) => {
          stream.onAbort(() => {
            cleanup();
            resolveDone();
          });
        });
      } finally {
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
    existing.pushedEventCount = countStoreEvents(existing.store.getState());
    return existing;
  }

  const store = await resolveStore(runtime, agentRunner, sessionId, workspaceRoot);
  const state: SessionStreamState = {
    ring: new EventRing(),
    store,
    pushedEventCount: countStoreEvents(store.getState()),
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

function pushNewEvents(
  state: SessionStreamState,
  current: SessionStoreState,
  previous: SessionStoreState,
): RingEntry[] {
  const previousEvents = flattenStoreEvents(previous);
  const currentEvents = flattenStoreEvents(current);
  const start = Math.max(state.pushedEventCount, previousEvents.length);
  state.pushedEventCount = currentEvents.length;

  return currentEvents
    .slice(start)
    .map((event) => state.ring.push("stream", JSON.stringify(event)));
}

function flattenStoreEvents(state: SessionStoreState): unknown[] {
  const events: unknown[] = [];

  for (const message of state.messages) {
    for (const part of message.parts) {
      if (message.role === "user" && part.type === "text") {
        events.push({ type: "user-message", content: part.text });
      }
      if (message.role === "user" && part.type === "system-notice") {
        events.push({ type: "system-notice", message: part.notice });
      }
      if (message.role === "assistant" && part.type === "text") {
        events.push({ type: "text-delta", text: part.text });
      }
      if (message.role === "assistant" && part.type === "reasoning") {
        events.push({ type: "reasoning-delta", text: part.text });
      }
      if (part.type === "tool" && part.state === "running") {
        events.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
      }
      if (part.type === "tool" && part.state === "completed") {
        events.push({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output, isError: false, ...(part.meta ? { meta: part.meta } : {}) });
      }
      if (part.type === "tool" && part.state === "error") {
        events.push({ type: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.errorMessage, isError: true, ...(part.meta ? { meta: part.meta } : {}) });
      }
      if (part.type === "compaction") {
        events.push({ type: "compact", summary: part.summary, tailStartId: part.tailStartId });
      }
    }
  }

  for (const step of state.steps) {
    events.push({ type: "step-start", step: step.step });
    if (step.completedAt !== undefined) {
      events.push({ type: "step-end", step: step.step, finishReason: step.finishReason ?? "unknown", ...(step.usage === undefined ? {} : { usage: step.usage }) });
    }
    if (step.error !== undefined) {
      events.push({ type: "loop-error", step: step.step, error: step.error });
    }
  }

  for (const reminder of state.reminders) {
    events.push({ type: "reminder", reminder });
  }

  if (state.todos.length > 0) {
    events.push({ type: "todo-write", todos: state.todos });
  }

  return events;
}

function countStoreEvents(state: SessionStoreState): number {
  return flattenStoreEvents(state).length;
}

function readLastEventId(queryValue: string | undefined, headerValue: string | undefined): number | undefined {
  const raw = queryValue ?? headerValue;
  if (raw === undefined || raw.trim() === "") return undefined;

  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function resolveProject(runtime: SpecraRuntime, slug: string): Promise<ProjectInfo> {
  const project = await runtime.projectRegistry.get(slug);
  if (!project) {
    throw new ProjectNotFoundError(slug);
  }

  return project;
}
