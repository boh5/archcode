import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRunningError, ChildSessionCwdMismatchError, ProjectRegistry, SessionCwdTransitionInProgressError, SessionExecutionScopeConflictError, SessionFamilyActiveError, SessionFamilyStopInProgressError, SessionHitlBlockedError, SessionHitlJournalBlockedError, SessionHitlResumeInProgressError, silentLogger } from "@archcode/agent-core";
import type { ActiveSessionExecution, AgentRuntime } from "@archcode/agent-core";
import { createServerApp } from "../app";
import { globalEventBus } from "../events/global-event-bus";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "messages-routes");

function makeExecution(sessionId: string, workspaceRoot: string): ActiveSessionExecution {
  return {
    sessionId,
    rootSessionId: sessionId,
    workspaceRoot,
    agentName: "engineer",
    origin: "user_message",
    abortController: new AbortController(),
    promise: new Promise(() => undefined),
    executionToken: Symbol("test-execution"),
    startedAt: Date.now(),
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry): AgentRuntime {
  const running = new Set<string>();
  return {
    projectRegistry,
    warnings: [],
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    contextResolver: undefined,
    subscribeSessionRuntimeChanges: mock(() => () => undefined),
    createSession: mock(async () => ({ sessionId: crypto.randomUUID(), title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    listSessions: mock(async () => []),
    startSessionExecution: mock((input) => {
      if (running.has(input.sessionId)) throw new AgentRunningError();
      running.add(input.sessionId);
      return makeExecution(input.sessionId, input.workspaceRoot);
    }),
    startSessionMessageExecution: mock(async (input) => {
      if (running.has(input.sessionId)) throw new AgentRunningError();
      running.add(input.sessionId);
      return makeExecution(input.sessionId, input.workspaceRoot);
    }),
    stopSessionFamily: mock(async (_workspaceRoot: string, sessionId: string) => {
      running.delete(sessionId);
    }),
    abortAllSessionExecutions: mock(async () => running.clear()),
    getSessionFamilyActivity: mock((_workspaceRoot: string, sessionId: string) => running.has(sessionId) ? "running" : "idle"),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async (_workspaceRoot: string, sessionId: string) => {
      running.delete(sessionId);
    }),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    notifyRuntimeShutdown: mock(() => undefined),
  } as unknown as AgentRuntime;
}

async function createTestApp(testName: string) {
  const homeDir = join(tempRoot, "homes", testName);
  const workspaceRoot = join(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry);

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    runtime,
  };
}

describe("messages routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("POST message with valid text returns 202", async () => {
    const { app, project } = await createTestApp("valid-message");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-valid/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { ok: boolean };

    expect(res.status).toBe(202);
    expect(body).toEqual({ ok: true });
  });

  test("does not expose the removed per-execution abort route", async () => {
    const { app, project } = await createTestApp("removed-abort-route");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-valid/abort`, {
      method: "POST",
    });

    expect(res.status).toBe(404);
  });

  test("POST message rejects unknown body fields", async () => {
    const { app, project } = await createTestApp("message-unknown-field");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-valid/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello", unexpected: true }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
  });

  test("POST message wires runtime session events into global event bus", async () => {
    const { app, project, runtime } = await createTestApp("session-events");
    const received: unknown[] = [];
    const unsubscribe = globalEventBus.subscribe((event) => received.push(event));

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-events/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(202);
    expect(runtime.subscribeSessionEvents).toHaveBeenCalledWith({
      slug: project.slug,
      workspaceRoot: project.workspaceRoot,
      sessionId: "session-events",
      onEvent: expect.any(Function),
    });

    const subscribeMock = runtime.subscribeSessionEvents as unknown as {
      mock: { calls: Array<[{ onEvent: (event: { type: "shutdown"; reason: string }) => void }]> };
    };
    subscribeMock.mock.calls[0]?.[0]?.onEvent({ type: "shutdown", reason: "test" });
    unsubscribe();

    expect(received).toContainEqual({ type: "shutdown", reason: "test" });
  });

  test("POST message with missing text returns 400", async () => {
    const { app, project } = await createTestApp("missing-text");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-missing/messages`, {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: "text is required" },
    });
  });

  test("POST message for non-existent project returns 404", async () => {
    const { app } = await createTestApp("missing-project");

    const res = await app.request("/api/projects/missing/sessions/session-project/messages", {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found: missing" },
    });
  });

  test("POST message while agent running returns 409", async () => {
    const { app, project } = await createTestApp("running-conflict");
    const path = `/api/projects/${project.slug}/sessions/session-conflict/messages`;

    await app.request(path, {
      method: "POST",
      body: JSON.stringify({ text: "First" }),
      headers: { "content-type": "application/json" },
    });
    const res = await app.request(path, {
      method: "POST",
      body: JSON.stringify({ text: "Second" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: new AgentRunningError().message },
    });
  });

  test("POST message for a child blocked by a root cwd transition returns 409", async () => {
    const { app, project, runtime } = await createTestApp("cwd-transition-conflict");
    const conflict = new SessionCwdTransitionInProgressError("child-session", "root-session");
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(() => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/child-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Continue" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: conflict.message },
    });
  });

  test("POST message while Goal cancellation stops the Session family returns stable 409", async () => {
    const { app, project, runtime } = await createTestApp("family-stop-conflict");
    const conflict = new SessionFamilyStopInProgressError("child-session", "root-session");
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(() => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/child-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Do not race cancellation" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: conflict.message,
        details: {
          scopeCode: "SESSION_FAMILY_STOP_IN_PROGRESS",
          sessionId: "child-session",
          rootSessionId: "root-session",
        },
      },
    });
  });

  test("POST root message while a descendant is active returns the family conflict", async () => {
    const { app, project, runtime } = await createTestApp("family-active-conflict");
    const conflict = new SessionFamilyActiveError("root-session", "root-session", "running");
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(() => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Do not overlap the child" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: conflict.message,
        details: {
          scopeCode: "SESSION_FAMILY_ACTIVE",
          sessionId: "root-session",
          rootSessionId: "root-session",
          activity: "running",
        },
      },
    });
  });

  test("POST message during durable HITL continuation returns stable 409", async () => {
    const { app, project, runtime } = await createTestApp("hitl-resume-conflict");
    const conflict = new SessionHitlResumeInProgressError("root-session", "root-session");
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(async () => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Do not interleave" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: conflict.message },
    });
  });

  test("POST message while Session awaits HITL returns stable 409", async () => {
    const { app, project, runtime } = await createTestApp("hitl-blocked-conflict");
    const conflict = new SessionHitlBlockedError("root-session", ["hitl-1"]);
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(async () => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Do not reorder the transcript" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: conflict.message },
    });
  });

  test("POST message blocked only by the Session HITL journal returns safe stable 409 details", async () => {
    const { app, project, runtime } = await createTestApp("hitl-journal-blocked-conflict");
    const conflict = new SessionHitlJournalBlockedError(
      "root-session",
      ["hitl-prepared-1", "hitl-unknown-2"],
      ["preparing", "manual_unknown"],
    );
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(async () => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/root-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Do not overtake journal recovery" }),
      headers: { "content-type": "application/json" },
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: conflict.message,
        details: {
          scopeCode: "SESSION_HITL_JOURNAL_BLOCKED",
          sessionId: "root-session",
          hitlIds: ["hitl-prepared-1", "hitl-unknown-2"],
          phases: ["preparing", "manual_unknown"],
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain(project.workspaceRoot);
  });

  test("POST message for a stale-cwd child returns stable 409", async () => {
    const { app, project, runtime } = await createTestApp("child-cwd-conflict");
    const conflict = new ChildSessionCwdMismatchError(
      "child-session",
      "root-session",
      "/project.worktrees/new",
      "/project",
    );
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(async () => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/child-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Do not use stale cwd" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: { code: "BAD_REQUEST", message: conflict.message },
    });
  });

  test("POST message outside its persisted execution scope returns stable 409", async () => {
    const { app, project, runtime } = await createTestApp("execution-scope-conflict");
    const conflict = new SessionExecutionScopeConflictError(
      "SESSION_LOOP_EXECUTION_SCOPE_REQUIRED",
      "loop-session",
      "Loop Session loop-session can execute only inside its owner Loop",
      { loopId: "loop-1" },
    );
    const start = runtime.startSessionMessageExecution as unknown as ReturnType<typeof mock>;
    start.mockImplementation(async () => { throw conflict; });

    const res = await app.request(`/api/projects/${project.slug}/sessions/loop-session/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Run this outside the Loop" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: conflict.message,
        details: {
          scopeCode: "SESSION_LOOP_EXECUTION_SCOPE_REQUIRED",
          sessionId: "loop-session",
          loopId: "loop-1",
        },
      },
    });
  });

});
