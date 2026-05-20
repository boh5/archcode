import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SpecraRuntime } from "@specra/agent-core";
import { ProjectRegistry } from "@specra/agent-core";
import { saveSessionTranscript } from "@specra/agent-core";
import { createSessionStore } from "@specra/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "sessions-routes");

const createScopedSessionStore = createSessionStore as unknown as typeof createSessionStore & ((sessionId: string, workspaceRoot: string) => ReturnType<typeof createSessionStore>);

interface SessionSummaryBody {
  sessions: Array<{
    sessionId: string;
    title?: string | null;
    createdAt: number;
    lastUpdatedAt?: number;
  }>;
}

interface SessionFileBody {
  sessionId: string;
  createdAt: number;
  title?: string | null;
  messages: unknown[];
  steps?: unknown[];
  eventCursor?: number;
}

function createTestRuntime(projectRegistry: ProjectRegistry): SpecraRuntime {
  return {
    sessionAgentManager: {
      get: () => undefined,
      getOrCreate: async () => undefined,
      dispose: () => undefined,
      disposeAll: () => undefined,
      getByWorkspace: () => [],
      isTombstoned: () => false,
      acquireSlot: () => undefined,
      releaseSlot: () => undefined,
      abortAndDispose: async () => undefined,
    },
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    agentFor: async (_root: string, _sid: string) => undefined,
  } as unknown as SpecraRuntime;
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceRoot = join(tempRoot, "workspaces", name);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir });
  const runtime = createTestRuntime(projectRegistry);
  const workspaceRoot = await makeWorkspace(testName);
  const project = await projectRegistry.add({ workspaceRoot, name: testName });

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    workspaceRoot,
  };
}

async function saveEmptySession(
  workspaceRoot: string,
  sessionId: string,
  createdAt: number,
  title: string | null = null,
): Promise<void> {
  const store = createScopedSessionStore(sessionId, workspaceRoot);
  store.setState({
    sessionId,
    createdAt,
    title,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    childSessionIds: new Set(),
    parentSessionId: undefined,
    subAgentDescriptions: new Map(),
  });
  await saveSessionTranscript(store.getState(), workspaceRoot);
}

describe("sessions routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET /api/projects/:slug/sessions returns empty list initially", async () => {
    const { app, project } = await createTestApp("empty-list");

    const res = await app.request(`/api/projects/${project.slug}/sessions`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [] });
  });

  test("POST /api/projects/:slug/sessions creates new session", async () => {
    const { app, project } = await createTestApp("create-session");

    const res = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
    });
    const body = (await res.json()) as SessionFileBody;

    expect(res.status).toBe(201);
    expect(typeof body.sessionId).toBe("string");
    expect(typeof body.createdAt).toBe("number");
    expect(body.messages).toEqual([]);
  });

  test("GET /api/projects/:slug/sessions after create returns list with one session", async () => {
    const { app, project } = await createTestApp("list-after-create");

    const created = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
    });
    const session = (await created.json()) as SessionFileBody;
    const res = await app.request(`/api/projects/${project.slug}/sessions`);
    const body = (await res.json()) as SessionSummaryBody;

    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([
      {
        sessionId: session.sessionId,
        title: null,
        createdAt: session.createdAt,
      },
    ]);
  });

  test("GET /api/projects/:slug/sessions/:sessionId returns full session data", async () => {
    const { app, project } = await createTestApp("read-session");
    const created = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
    });
    const session = (await created.json()) as SessionFileBody;

    const res = await app.request(`/api/projects/${project.slug}/sessions/${session.sessionId}`);
    const body = (await res.json()) as SessionFileBody;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      messages: [],
    });
  });

  test("GET /api/projects/:slug/sessions/:sessionId for non-existent session returns 404", async () => {
    const { app, project } = await createTestApp("read-missing-session");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing-session`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing-session" },
    });
  });

  test("GET /api/projects/:slug/sessions/:sessionId returns eventCursor from live store without resetting events", async () => {
    const { app, project, workspaceRoot } = await createTestApp("live-store-events");
    const sessionId = crypto.randomUUID();

    // Create a store and register it (simulating an active session)
    const store = createScopedSessionStore(sessionId, workspaceRoot);

    // Append events to simulate an active session
    store.getState().append({ type: "text-delta", text: "Hello" });
    store.getState().append({ type: "text-delta", text: "World" });

    const nextEventId = store.getState().nextEventId;
    const eventsBefore = store.getState().events.length;

    // GET session — should hit Priority 2: registered store
    const res = await app.request(`/api/projects/${project.slug}/sessions/${sessionId}`);
    const body = (await res.json()) as SessionFileBody;

    expect(res.status).toBe(200);
    // eventCursor should be nextEventId - 1 (not -1)
    expect(body.eventCursor).toBe(nextEventId - 1);
    // The live store's events must NOT be reset
    expect(store.getState().events.length).toBe(eventsBefore);
    expect(store.getState().nextEventId).toBe(nextEventId);
  });

  test("DELETE /api/projects/:slug/sessions/:sessionId returns ok", async () => {
    const { app, project } = await createTestApp("delete-session");
    const created = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
    });
    const session = (await created.json()) as SessionFileBody;

    const res = await app.request(`/api/projects/${project.slug}/sessions/${session.sessionId}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("DELETE /api/projects/:slug/sessions/:sessionId for non-existent session returns ok", async () => {
    const { app, project } = await createTestApp("delete-missing-session");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("GET /api/projects/:slug/sessions for non-existent project slug returns 404", async () => {
    const { app } = await createTestApp("missing-project");

    const res = await app.request("/api/projects/missing/sessions");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
    });
  });

  test("GET /api/projects/:slug/sessions sorts sessions by latest timestamp descending", async () => {
    const { app, project, workspaceRoot } = await createTestApp("sorted-sessions");
    await saveEmptySession(workspaceRoot, "older", 1_000, "Older");
    await saveEmptySession(workspaceRoot, "newer", 2_000, "Newer");

    const res = await app.request(`/api/projects/${project.slug}/sessions`);
    const body = (await res.json()) as SessionSummaryBody;

    expect(res.status).toBe(200);
    expect(body.sessions.map((session) => session.sessionId)).toEqual(["newer", "older"]);
  });
});
