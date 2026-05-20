import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Hono } from "hono";
import type { SpecraRuntime } from "../../runtime";
import {
  loadSessionTranscript,
  saveSessionTranscript,
  type SessionFile,
} from "../../store/helpers";
import { getSessionsDir } from "../../store/sessions-dir";
import { createSessionStore, getSessionStore } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import type { AgentRunner } from "../agent-runner";
import { BadRequestError, SessionNotFoundError } from "../errors";
import { resolveProject } from "../resolve";
import { removeSessionStream } from "./events";

interface SessionSummary {
  sessionId: string;
  title?: string | null;
  createdAt: number;
  lastUpdatedAt?: number;
}

interface SessionWithSortKey {
  summary: SessionSummary;
  sortKey: number;
}

interface SessionTimestamps {
  lastUpdatedAt?: number;
  updatedAt?: number;
}

export function createSessionsRoutes(runtime: SpecraRuntime, agentRunner: AgentRunner): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessions = await listSessionSummaries(project.workspaceRoot);

    return c.json({ sessions });
  });

  app.post("/", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const store = createSessionStore(crypto.randomUUID(), project.workspaceRoot);

    await saveSessionTranscript(store.getState(), project.workspaceRoot);

    return c.json(toSessionFile(store.getState()), 201);
  });

  app.get("/:sessionId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    try {
      // Priority 1: active job agent store
      const jobAgent = agentRunner.getJob(project.workspaceRoot, sessionId)
        ? runtime.sessionAgentManager.get(project.workspaceRoot, sessionId)
        : undefined;
      if (jobAgent) {
        return c.json(toSessionFile(jobAgent.store.getState()));
      }

      // Priority 2: registered store (from previous load or SSE connection)
      const registered = getSessionStore(sessionId, project.workspaceRoot);
      if (registered) {
        return c.json(toSessionFile(registered.getState()));
      }

      // Priority 3: load from disk (cold session)
      const store = await loadSessionTranscript(sessionId, project.workspaceRoot);
      return c.json(toSessionFile(store.getState()));
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new SessionNotFoundError(sessionId);
      }
      throw error;
    }
  });

  app.delete("/:sessionId", async (c) => {
    const project = await resolveProject(runtime, requiredParam(c.req.param("slug"), "slug"));
    const sessionId = requiredParam(c.req.param("sessionId"), "sessionId");

    await agentRunner.abortAndWait(project.workspaceRoot, sessionId);
    runtime.sessionAgentManager.dispose(project.workspaceRoot, sessionId);
    removeSessionStream(project.workspaceRoot, sessionId);
    agentRunner.cleanupSession(project.workspaceRoot, sessionId);

    const path = join(getSessionsDir(project.workspaceRoot), `${sessionId}.json`);

    if (await Bun.file(path).exists()) {
      await rm(path);
    }

    return c.json({ ok: true });
  });

  return app;
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) {
    throw new BadRequestError(`${name} is required`);
  }

  return value;
}

async function listSessionSummaries(workspaceRoot: string): Promise<SessionSummary[]> {
  const dir = getSessionsDir(workspaceRoot);
  const names = await readSessionFileNames(dir);
  const sessions: SessionWithSortKey[] = [];

  for (const name of names) {
    const raw = await Bun.file(join(dir, name)).json();
    const timestamps = readSessionTimestamps(raw);
    const store = await loadSessionTranscript(basename(name, ".json"), workspaceRoot);
    const parsed = toSessionFile(store.getState());
    sessions.push({
      summary: {
        sessionId: parsed.sessionId,
        title: parsed.title,
        createdAt: parsed.createdAt,
        ...(timestamps.lastUpdatedAt === undefined ? {} : { lastUpdatedAt: timestamps.lastUpdatedAt }),
      },
      sortKey: timestamps.lastUpdatedAt ?? timestamps.updatedAt ?? parsed.createdAt,
    });
  }

  return sessions
    .sort((left, right) => right.sortKey - left.sortKey)
    .map((session) => session.summary);
}

function readSessionTimestamps(value: unknown): SessionTimestamps {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.lastUpdatedAt === "number" ? { lastUpdatedAt: record.lastUpdatedAt } : {}),
    ...(typeof record.updatedAt === "number" ? { updatedAt: record.updatedAt } : {}),
  };
}

async function readSessionFileNames(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

function toSessionFile(state: SessionStoreState): SessionFile {
  return {
    sessionId: state.sessionId,
    createdAt: state.createdAt,
    title: state.title ?? null,
    messages: state.messages,
    steps: state.steps,
    todos: state.todos,
    reminders: state.reminders,
    childSessionIds: Array.from(state.childSessionIds),
    ...(state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId }),
    subAgentDescriptions: Array.from(state.subAgentDescriptions),
    eventCursor: state.nextEventId > 0 ? state.nextEventId - 1 : -1,
  };
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
