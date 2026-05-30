import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { SpecraRuntime } from "@specra/agent-core";
import { NotRootSessionError, ProjectRegistry, SessionDeleteConflictError, silentLogger } from "@specra/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "sessions-routes");

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

type StoredSessionBody = SessionFileBody & {
  title: string | null;
  todos: unknown[];
  reminders: unknown[];
  parentSessionId?: string;
};

class MissingSessionFileError extends Error {
  code = "ENOENT";
}

function createStoredSession(sessionId: string = crypto.randomUUID(), createdAt = Date.now(), title: string | null = null, parentSessionId?: string): StoredSessionBody {
  return {
    sessionId,
    createdAt,
    title,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    ...(parentSessionId !== undefined ? { parentSessionId } : {}),
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry) {
  const sessions = new Map<string, StoredSessionBody>();
  const calls = {
    createSession: 0,
    getSessionFile: 0,
    listSessions: 0,
    deleteSession: [] as Array<{ workspaceRoot: string; sessionId: string }>,
  };

  const runtime = {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    createSession: async (workspaceRoot: string) => {
      calls.createSession += 1;
      const session = createStoredSession();
      sessions.set(`${workspaceRoot}\0${session.sessionId}`, session);
      return session;
    },
    getSessionFile: async (workspaceRoot: string, sessionId: string) => {
      calls.getSessionFile += 1;
      const session = sessions.get(`${workspaceRoot}\0${sessionId}`);
      if (!session) throw new MissingSessionFileError();
      return session;
    },
    listSessions: async (workspaceRoot: string) => {
      calls.listSessions += 1;
      return [...sessions.entries()]
        .filter(([key]) => key.startsWith(`${workspaceRoot}\0`))
        .map(([, session]) => ({
          sessionId: session.sessionId,
          title: session.title,
          createdAt: session.createdAt,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    listSessionTree: async (workspaceRoot: string, rootSessionId: string) => {
      const key = `${workspaceRoot}\0${rootSessionId}`;
      const session = sessions.get(key);
      if (!session) throw new MissingSessionFileError();
      if (session.parentSessionId !== undefined) {
        throw new NotRootSessionError(rootSessionId, session.parentSessionId);
      }
      return {
        root: {
          session: {
            sessionId: rootSessionId,
            rootSessionId,
            title: session.title ?? null,
            createdAt: session.createdAt,
          },
          children: [],
        },
        diagnostics: [],
      };
    },
    submitAgentJob: () => {
      throw new Error("not implemented");
    },
    abortAgentJob: () => false,
    abortAgentJobAndWait: async () => undefined,
    abortAllAgentJobs: async () => undefined,
    isAgentJobRunning: () => false,
    getAgentJob: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async (workspaceRoot: string, sessionId: string) => {
      calls.deleteSession.push({ workspaceRoot, sessionId });
      if (sessionId === "conflict-session") {
        throw new SessionDeleteConflictError([sessionId]);
      }
      const key = `${workspaceRoot}\0${sessionId}`;
      if (!sessions.has(key)) throw new MissingSessionFileError();
      sessions.delete(key);
    },
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    requestPermission: async () => "timeout",
    respondPermission: () => false,
    requestQuestion: async () => ({ isError: true, reason: "Cancelled" }),
    respondQuestion: () => false,
    cleanupDeferredSession: () => undefined,
    notifyRuntimeShutdown: () => undefined,
  } as unknown as SpecraRuntime;

  return { runtime, sessions, calls };
}

async function makeWorkspace(name: string): Promise<string> {
  const workspaceRoot = resolve(tempRoot, "workspaces", name);
  await mkdir(workspaceRoot, { recursive: true });
  return workspaceRoot;
}

async function createTestApp(testName: string) {
  const homeDir = resolve(tempRoot, "homes", testName);
  await mkdir(homeDir, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const { runtime, sessions, calls } = createTestRuntime(projectRegistry);
  const workspaceRoot = await makeWorkspace(testName);
  const project = await projectRegistry.add({ workspaceRoot, name: testName });

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    workspaceRoot,
    sessions,
    calls,
  };
}

function saveEmptySession(
  workspaceRoot: string,
  sessions: Map<string, StoredSessionBody>,
  sessionId: string,
  createdAt: number,
  title: string | null = null,
): void {
  sessions.set(`${workspaceRoot}\0${sessionId}`, createStoredSession(sessionId, createdAt, title));
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

  test("GET /api/projects/:slug/sessions/:sessionId delegates to runtime session projection", async () => {
    const { app, project, calls } = await createTestApp("runtime-get-session");
    const created = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
    });
    const session = (await created.json()) as SessionFileBody;

    const res = await app.request(`/api/projects/${project.slug}/sessions/${session.sessionId}`);

    expect(res.status).toBe(200);
    expect(calls.getSessionFile).toBe(1);
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

  test("DELETE /api/projects/:slug/sessions/:sessionId for non-existent session returns 404", async () => {
    const { app, project } = await createTestApp("delete-missing-session");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing-session" },
    });
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
    const { app, project, workspaceRoot, sessions } = await createTestApp("sorted-sessions");
    saveEmptySession(workspaceRoot, sessions, "older", 1_000, "Older");
    saveEmptySession(workspaceRoot, sessions, "newer", 2_000, "Newer");

    const res = await app.request(`/api/projects/${project.slug}/sessions`);
    const body = (await res.json()) as SessionSummaryBody;

    expect(res.status).toBe(200);
    expect(body.sessions.map((session) => session.sessionId)).toEqual(["newer", "older"]);
  });

  test("DELETE /api/projects/:slug/sessions/:sessionId delegates cleanup to runtime", async () => {
    const { app, project, calls } = await createTestApp("delete-session-runtime");
    const created = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
    });
    const session = (await created.json()) as SessionFileBody;

    await app.request(`/api/projects/${project.slug}/sessions/${session.sessionId}`, {
      method: "DELETE",
    });

    expect(calls.deleteSession).toEqual([{ workspaceRoot: project.workspaceRoot, sessionId: session.sessionId }]);
  });

  test("GET /api/projects/:slug/sessions/:sessionId/tree returns root tree for root session", async () => {
    const { app, project, workspaceRoot, sessions } = await createTestApp("tree-root");
    const rootSession = createStoredSession("root-session-1", 1000, "Root");
    sessions.set(`${workspaceRoot}\0root-session-1`, rootSession);

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session-1/tree`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      root: {
        session: {
          sessionId: "root-session-1",
          rootSessionId: "root-session-1",
          title: "Root",
          createdAt: 1000,
        },
        children: [],
      },
      diagnostics: [],
    });
  });

  test("GET /api/projects/:slug/sessions/:sessionId/tree returns 400 for child session", async () => {
    const { app, project, workspaceRoot, sessions } = await createTestApp("tree-child");
    const childSession = createStoredSession("child-session", 1000, "Child", "root-session");
    sessions.set(`${workspaceRoot}\0child-session`, childSession);

    const res = await app.request(`/api/projects/${project.slug}/sessions/child-session/tree`);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: 'Session "child-session" is not a root session' },
    });
  });

  test("GET /api/projects/:slug/sessions/:sessionId/tree returns 404 for missing session", async () => {
    const { app, project } = await createTestApp("tree-missing");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing-session/tree`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing-session" },
    });
  });

  test("DELETE /api/projects/:slug/sessions/:sessionId returns 409 for running session conflict", async () => {
    const { app, project } = await createTestApp("delete-conflict");

    const res = await app.request(`/api/projects/${project.slug}/sessions/conflict-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("DELETE_CONFLICT");
    expect(body.error.details).toEqual({ sessionIds: ["conflict-session"] });
  });
});
