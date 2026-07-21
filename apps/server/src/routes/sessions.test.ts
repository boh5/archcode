import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRuntime } from "@archcode/agent-core";
import { NotRootSessionError, ProjectRegistry, SessionDeleteConflictError, SessionDeleteInProgressError, SessionDeleteOwnerConflictError, SessionFamilyStopConflictError, SessionFamilyStopInProgressError, SessionModelSelectionNotAllowedError, silentLogger } from "@archcode/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "sessions-routes");

interface SessionSummaryBody {
  sessions: Array<{
    sessionId: string;
    rootSessionId: string;
    parentSessionId?: string;
    title?: string | null;
    createdAt: number;
    updatedAt: number;
  }>;
}

interface SessionFileBody {
  sessionId: string;
  rootSessionId: string;
  parentSessionId?: string;
  createdAt: number;
  updatedAt: number;
  title?: string | null;
  messages: unknown[];
  steps?: unknown[];
  eventCursor?: number;
}

type StoredSessionBody = SessionFileBody & {
  title: string | null;
  todos: unknown[];
  reminders: unknown[];
  rootSessionId: string;
  parentSessionId?: string;
};

class MissingSessionFileError extends Error {
  code = "ENOENT";
}

function createStoredSession(input: {
  sessionId?: string;
  createdAt?: number;
  title?: string | null;
  rootSessionId?: string;
  parentSessionId?: string;
} = {}): StoredSessionBody {
  const sessionId = input.sessionId ?? crypto.randomUUID();
  return {
    sessionId,
    createdAt: input.createdAt ?? Date.now(),
    updatedAt: input.createdAt ?? Date.now(),
    title: input.title ?? null,
    messages: [],
    steps: [],
    todos: [],
    reminders: [],
    rootSessionId: input.rootSessionId ?? sessionId,
    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry) {
  const sessions = new Map<string, StoredSessionBody>();
  const modelSelectionRevisions = new Map<string, number>();
  const calls = {
    createSession: 0,
    getSessionFile: 0,
    listSessions: 0,
    updateSessionGoalControl: [] as Array<{
      workspaceRoot: string;
      sessionId: string;
      action: "edit" | "pause" | "resume" | "clear" | "budget";
      objective?: string;
      expectedGeneration?: number;
      tokenBudget?: number;
    }>,
    stopSessionFamily: [] as Array<{ workspaceRoot: string; rootSessionId: string }>,
    deleteSession: [] as Array<{ workspaceRoot: string; sessionId: string }>,
  };

  const runtime = {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    warnings: [],
    contextResolver: undefined,
    subscribeSessionRuntimeChanges: () => () => undefined,
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
        .filter(([, session]) => session.parentSessionId === undefined)
        .map(([, session]) => ({
          sessionId: session.sessionId,
          rootSessionId: session.rootSessionId,
          ...(session.parentSessionId === undefined ? {} : { parentSessionId: session.parentSessionId }),
          title: session.title,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    getSessionModelState: async (workspaceRoot: string, sessionId: string) => {
      const key = `${workspaceRoot}\0${sessionId}`;
      if (!sessions.has(key)) throw new MissingSessionFileError();
      const revision = modelSelectionRevisions.get(key) ?? 0;
      return testModelState(revision);
    },
    patchSessionModelSelection: async (input: {
      workspaceRoot: string;
      sessionId: string;
      expectedRevision: number;
    }) => {
      const key = `${input.workspaceRoot}\0${input.sessionId}`;
      const session = sessions.get(key);
      if (!session) throw new MissingSessionFileError();
      if (session.parentSessionId !== undefined || session.rootSessionId !== session.sessionId) {
        throw new SessionModelSelectionNotAllowedError(session.sessionId, "not_root_lead");
      }
      const revision = (modelSelectionRevisions.get(key) ?? input.expectedRevision) + 1;
      modelSelectionRevisions.set(key, revision);
      return testModelState(revision);
    },
    updateSessionGoalControl: async (input: {
      workspaceRoot: string;
      sessionId: string;
      action: "edit" | "pause" | "resume" | "clear" | "budget";
      objective?: string;
      expectedGeneration?: number;
      tokenBudget?: number;
    }) => {
      if (!sessions.has(`${input.workspaceRoot}\0${input.sessionId}`)) throw new MissingSessionFileError();
      calls.updateSessionGoalControl.push(input);
      return sessions.get(`${input.workspaceRoot}\0${input.sessionId}`)!;
    },
    listSessionTree: async (workspaceRoot: string, rootSessionId: string) => {
      const key = `${workspaceRoot}\0${rootSessionId}`;
      const session = sessions.get(key);
      if (!session) throw new MissingSessionFileError();
      if (session.parentSessionId !== undefined) {
        throw new NotRootSessionError(rootSessionId, session.parentSessionId);
      }
      type RuntimeTreeNode = {
        session: { sessionId: string; rootSessionId: string; parentSessionId?: string; title: string | null; createdAt: number };
        children: RuntimeTreeNode[];
      };
      const toNode = (nodeSession: StoredSessionBody): RuntimeTreeNode => ({
        session: {
          sessionId: nodeSession.sessionId,
          rootSessionId: nodeSession.rootSessionId,
          ...(nodeSession.parentSessionId === undefined ? {} : { parentSessionId: nodeSession.parentSessionId }),
          title: nodeSession.title ?? null,
          createdAt: nodeSession.createdAt,
        },
        children: [...sessions.entries()]
          .filter(([entryKey, candidate]) => entryKey.startsWith(`${workspaceRoot}\0`) && candidate.parentSessionId === nodeSession.sessionId)
          .map(([, candidate]) => toNode(candidate)),
      });

      return {
        root: toNode(session),
        diagnostics: [],
      };
    },
    stopSessionFamily: async (workspaceRoot: string, rootSessionId: string) => {
      const session = sessions.get(`${workspaceRoot}\0${rootSessionId}`);
      if (session === undefined) throw new MissingSessionFileError();
      if (session.parentSessionId !== undefined || session.rootSessionId !== rootSessionId) {
        throw new NotRootSessionError(rootSessionId, session.parentSessionId ?? session.rootSessionId);
      }
      calls.stopSessionFamily.push({ workspaceRoot, rootSessionId });
      if (rootSessionId === "stuck-root") {
        throw new SessionFamilyStopConflictError(rootSessionId, ["child-1"]);
      }
      if (rootSessionId === "stopping-root") {
        throw new SessionFamilyStopInProgressError(rootSessionId, rootSessionId);
      }
      if (rootSessionId === "deleting-root") {
        throw new SessionDeleteInProgressError(rootSessionId, rootSessionId);
      }
    },
    abortAllSessionExecutions: async () => undefined,
    getSessionFamilyActivity: () => "idle" as const,
    getSessionExecution: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async (workspaceRoot: string, sessionId: string) => {
      calls.deleteSession.push({ workspaceRoot, sessionId });
      if (sessionId === "conflict-session") {
        throw new SessionDeleteConflictError([sessionId]);
      }
      if (sessionId === "deleting-session") {
        throw new SessionDeleteInProgressError(sessionId, "root-session");
      }
      if (sessionId === "stopping-session") {
        throw new SessionFamilyStopInProgressError(sessionId, "root-session");
      }
      if (sessionId === "owned-session") {
        throw new SessionDeleteOwnerConflictError([
          { sessionId, ownerType: "project_todo", ownerId: "11111111-1111-4111-8111-111111111111" },
        ]);
      }
      if (sessionId === "todo-owned-session") {
        throw new SessionDeleteOwnerConflictError([
          { sessionId, ownerType: "project_todo", ownerId: "11111111-1111-4111-8111-111111111111" },
        ]);
      }
      const key = `${workspaceRoot}\0${sessionId}`;
      if (!sessions.has(key)) throw new MissingSessionFileError();
      sessions.delete(key);
    },
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    notifyRuntimeShutdown: () => undefined,
  } as unknown as AgentRuntime;

  return { runtime, sessions, calls };
}

function testModelState(revision: number) {
  const requested = {
    mode: "profile_default" as const,
    selection: { model: "local:test", variant: "fast" },
  };
  return {
    modelSelection: { revision },
    nextModelSelection: {
      requested,
      resolved: {
        selection: requested.selection,
        providerId: "local",
        modelId: "test",
        providerDisplayName: "Local",
        modelDisplayName: "Test Model",
        resolution: "profile_default" as const,
        modelRuntimeRevision: "runtime-1",
      },
    },
  };
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
  sessions.set(`${workspaceRoot}\0${sessionId}`, createStoredSession({ sessionId, createdAt, title }));
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

  test("POST /api/projects/:slug/sessions/:rootSessionId/stop drains the Session Family", async () => {
    const { app, project, workspaceRoot, calls, sessions } = await createTestApp("stop-session-family");
    saveEmptySession(workspaceRoot, sessions, "root-session", 1_000);

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session/stop`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.stopSessionFamily).toEqual([{ workspaceRoot, rootSessionId: "root-session" }]);
  });

  test("POST /api/projects/:slug/sessions/:rootSessionId/stop rejects a child Session", async () => {
    const { app, project, workspaceRoot, calls, sessions } = await createTestApp("stop-child-session");
    sessions.set(`${workspaceRoot}\0child-session`, createStoredSession({
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
    }));

    const res = await app.request(`/api/projects/${project.slug}/sessions/child-session/stop`, {
      method: "POST",
    });

    expect(res.status).toBe(400);
    expect(calls.stopSessionFamily).toEqual([]);
  });

  test("POST /api/projects/:slug/sessions/:rootSessionId/stop returns 404 for a missing root", async () => {
    const { app, project, calls } = await createTestApp("stop-missing-root");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing-root/stop`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
    expect(calls.stopSessionFamily).toEqual([]);
  });

  test("POST /api/projects/:slug/sessions/:rootSessionId/stop exposes a stable drain conflict", async () => {
    const { app, project, workspaceRoot, calls, sessions } = await createTestApp("stop-stuck-root");
    saveEmptySession(workspaceRoot, sessions, "stuck-root", 1_000);

    const res = await app.request(`/api/projects/${project.slug}/sessions/stuck-root/stop`, {
      method: "POST",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "SESSION_STOP_CONFLICT",
        message: 'Session family "stuck-root" did not stop: child-1',
        details: { rootSessionId: "stuck-root", sessionIds: ["child-1"] },
      },
    });
    expect(calls.stopSessionFamily).toEqual([{ workspaceRoot, rootSessionId: "stuck-root" }]);
  });

  test("POST /api/projects/:slug/sessions/:rootSessionId/stop rejects a request body", async () => {
    const { app, project, calls } = await createTestApp("stop-session-family-body");

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session/stop`, {
      method: "POST",
      body: JSON.stringify({ force: true }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(calls.stopSessionFamily).toEqual([]);
  });

  test("POST /api/projects/:slug/sessions rejects any request body", async () => {
    const { app, project, calls } = await createTestApp("create-session-with-body");

    const res = await app.request(`/api/projects/${project.slug}/sessions`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(calls.createSession).toBe(0);
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
        rootSessionId: session.sessionId,
        title: null,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
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

  test("Session Goal controls delegate to the runtime-owned control plane", async () => {
    const { app, project, workspaceRoot, calls, sessions } = await createTestApp("session-goal-controls");
    saveEmptySession(workspaceRoot, sessions, "root-session", 1_000);

    const edit = await app.request(`/api/projects/${project.slug}/sessions/root-session/goal`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objective: "Finish the migration and pass all tests.", expectedGeneration: 2 }),
    });
    const pause = await app.request(`/api/projects/${project.slug}/sessions/root-session/goal/pause`, { method: "POST" });
    const budget = await app.request(`/api/projects/${project.slug}/sessions/root-session/goal/budget`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tokenBudget: 50_000 }),
    });
    const clear = await app.request(`/api/projects/${project.slug}/sessions/root-session/goal`, { method: "DELETE" });

    expect([edit.status, pause.status, budget.status, clear.status]).toEqual([200, 200, 200, 200]);
    expect(calls.updateSessionGoalControl).toEqual([
      {
        workspaceRoot,
        sessionId: "root-session",
        action: "edit",
        objective: "Finish the migration and pass all tests.",
        expectedGeneration: 2,
      },
      { workspaceRoot, sessionId: "root-session", action: "pause" },
      { workspaceRoot, sessionId: "root-session", action: "budget", tokenBudget: 50_000 },
      { workspaceRoot, sessionId: "root-session", action: "clear" },
    ]);
  });

  test("GET/PATCH model selection returns the complete next model before first send", async () => {
    const { app, project } = await createTestApp("session-model-selection");
    const created = await app.request(`/api/projects/${project.slug}/sessions`, { method: "POST" });
    const session = (await created.json()) as SessionFileBody;
    const path = `/api/projects/${project.slug}/sessions/${session.sessionId}/model-selection`;

    const initial = await app.request(path);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({
      modelSelection: { revision: 0 },
      nextModelSelection: {
        requested: { mode: "profile_default", selection: { model: "local:test", variant: "fast" } },
        resolved: { modelDisplayName: "Test Model", resolution: "profile_default" },
      },
    });

    const patched = await app.request(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: 0,
        requestedModelSelection: {
          mode: "session_override",
          selection: { model: "local:test", variant: "fast" },
        },
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ modelSelection: { revision: 1 } });
  });

  test("PATCH model selection rejects a child Session at the API boundary", async () => {
    const { app, project, workspaceRoot, sessions } = await createTestApp("child-model-selection");
    sessions.set(`${workspaceRoot}\0child-session`, createStoredSession({
      sessionId: "child-session",
      rootSessionId: "root-session",
      parentSessionId: "root-session",
    }));

    const response = await app.request(
      `/api/projects/${project.slug}/sessions/child-session/model-selection`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedRevision: 0,
          requestedModelSelection: {
            mode: "session_override",
            selection: { model: "local:test", variant: "fast" },
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: expect.stringContaining("root Lead Session"),
        details: {
          scopeCode: "SESSION_MODEL_SELECTION_NOT_ALLOWED",
          sessionId: "child-session",
          reason: "not_root_lead",
        },
      },
    });
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

  test("GET /api/projects/:slug/sessions returns only root sessions with identity fields", async () => {
    const { app, project, workspaceRoot, sessions } = await createTestApp("root-only-sessions");
    sessions.set(`${workspaceRoot}\0root-session`, createStoredSession({ sessionId: "root-session", createdAt: 1_000, title: "Root" }));
    sessions.set(`${workspaceRoot}\0child-session`, createStoredSession({ sessionId: "child-session", rootSessionId: "root-session", parentSessionId: "root-session", createdAt: 2_000, title: "Child" }));

    const res = await app.request(`/api/projects/${project.slug}/sessions`);
    const body = (await res.json()) as SessionSummaryBody;

    expect(res.status).toBe(200);
    expect(body.sessions).toEqual([
      {
        sessionId: "root-session",
        rootSessionId: "root-session",
        title: "Root",
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
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
    const rootSession = createStoredSession({ sessionId: "root-session-1", createdAt: 1000, title: "Root" });
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
    const childSession = createStoredSession({ sessionId: "child-session", rootSessionId: "root-session", parentSessionId: "root-session", createdAt: 1000, title: "Child" });
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

  test("DELETE returns stable 409 details while a Session family deletion is in progress", async () => {
    const { app, project } = await createTestApp("delete-in-progress");

    const res = await app.request(`/api/projects/${project.slug}/sessions/deleting-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "DELETE_CONFLICT",
        message: 'Session "deleting-session" cannot start or resume while Session family "root-session" is being deleted',
        details: {
          sessionIds: ["deleting-session"],
          scopeCode: "SESSION_DELETE_IN_PROGRESS",
          rootSessionId: "root-session",
        },
      },
    });
  });

  test("DELETE returns stable 409 details while the Session family is stopping", async () => {
    const { app, project } = await createTestApp("family-stop-in-progress");

    const res = await app.request(`/api/projects/${project.slug}/sessions/stopping-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "DELETE_CONFLICT",
        message: 'Session "stopping-session" cannot start or transition while Session family "root-session" is stopping',
        details: {
          sessionIds: ["stopping-session"],
          scopeCode: "SESSION_FAMILY_STOP_IN_PROGRESS",
          rootSessionId: "root-session",
        },
      },
    });
  });

  test("DELETE returns stable 409 owner details for Todo-managed Sessions", async () => {
    const { app, project } = await createTestApp("delete-owner-conflict");

    const res = await app.request(`/api/projects/${project.slug}/sessions/owned-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "DELETE_CONFLICT",
        message: "Unable to delete owned Session subtree: owned-session",
        details: {
          sessionIds: ["owned-session"],
          scopeCode: "SESSION_DELETE_OWNER_CONFLICT",
          owners: [
            { sessionId: "owned-session", ownerType: "project_todo", ownerId: "11111111-1111-4111-8111-111111111111" },
          ],
        },
      },
    });
  });

  test("DELETE identifies the owning Project Todo", async () => {
    const { app, project } = await createTestApp("delete-project-todo-owner-conflict");

    const res = await app.request(`/api/projects/${project.slug}/sessions/todo-owned-session`, {
      method: "DELETE",
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: {
        code: "DELETE_CONFLICT",
        details: {
          scopeCode: "SESSION_DELETE_OWNER_CONFLICT",
          owners: [{
            sessionId: "todo-owned-session",
            ownerType: "project_todo",
            ownerId: "11111111-1111-4111-8111-111111111111",
          }],
        },
      },
    });
  });

  test("session routes expose tree contracts and delete conflict across persisted hierarchy", async () => {
    const { app, project, workspaceRoot, sessions } = await createTestApp("hierarchy-contracts");
    sessions.set(`${workspaceRoot}\0root`, createStoredSession({ sessionId: "root", createdAt: 1_000, title: "Root" }));
    sessions.set(`${workspaceRoot}\0child`, createStoredSession({ sessionId: "child", rootSessionId: "root", parentSessionId: "root", createdAt: 2_000, title: "Child" }));
    sessions.set(`${workspaceRoot}\0grandchild`, createStoredSession({ sessionId: "grandchild", rootSessionId: "root", parentSessionId: "child", createdAt: 3_000, title: "Grandchild" }));

    const treeRes = await app.request(`/api/projects/${project.slug}/sessions/root/tree`);
    const treeBody = await treeRes.json();
    const childTreeRes = await app.request(`/api/projects/${project.slug}/sessions/child/tree`);
    const conflictRes = await app.request(`/api/projects/${project.slug}/sessions/conflict-session`, { method: "DELETE" });

    expect(treeRes.status).toBe(200);
    expect(treeBody.root.children[0]).toMatchObject({
      session: { sessionId: "child", rootSessionId: "root", parentSessionId: "root" },
      children: [{ session: { sessionId: "grandchild", rootSessionId: "root", parentSessionId: "child" } }],
    });
    expect(childTreeRes.status).toBe(400);
    expect(conflictRes.status).toBe(409);
  });
});
