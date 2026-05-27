import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRunningError, ProjectRegistry, silentLogger } from "@specra/agent-core";
import type { RunningJob, SpecraRuntime } from "@specra/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "messages-routes");

function makeJob(sessionId: string, workspaceRoot: string): RunningJob {
  return {
    jobId: crypto.randomUUID(),
    sessionId,
    workspaceRoot,
    abortController: new AbortController(),
    promise: new Promise(() => undefined),
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry): SpecraRuntime {
  const running = new Set<string>();
  return {
    projectRegistry,
    warnings: [],
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    contextResolver: undefined,
    createSession: mock(async () => ({ sessionId: crypto.randomUUID(), title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: Date.now(), messages: [], steps: [], todos: [], reminders: [] })),
    listSessions: mock(async () => []),
    submitAgentJob: mock((input) => {
      if (running.has(input.sessionId)) throw new AgentRunningError();
      running.add(input.sessionId);
      return makeJob(input.sessionId, input.workspaceRoot);
    }),
    abortAgentJob: mock((_workspaceRoot: string, sessionId: string) => running.delete(sessionId)),
    abortAgentJobAndWait: mock(async (_workspaceRoot: string, sessionId: string) => {
      running.delete(sessionId);
    }),
    abortAllAgentJobs: mock(async () => running.clear()),
    isAgentJobRunning: mock((_workspaceRoot: string, sessionId: string) => running.has(sessionId)),
    getAgentJob: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async (_workspaceRoot: string, sessionId: string) => {
      running.delete(sessionId);
    }),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    requestPermission: mock(async () => "timeout"),
    respondPermission: mock(() => false),
    requestQuestion: mock(async () => ({ isError: true, reason: "Cancelled" })),
    respondQuestion: mock(() => false),
    cleanupDeferredSession: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
  } as unknown as SpecraRuntime;
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

  test("POST message with valid text returns 202 and jobId", async () => {
    const { app, project } = await createTestApp("valid-message");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-valid/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
      headers: { "content-type": "application/json" },
    });
    const body = (await res.json()) as { jobId: string };

    expect(res.status).toBe(202);
    expect(typeof body.jobId).toBe("string");
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

  test("POST abort returns ok true and aborted true", async () => {
    const { app, project } = await createTestApp("abort-running");

    await app.request(`/api/projects/${project.slug}/sessions/session-abort/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
      headers: { "content-type": "application/json" },
    });
    const res = await app.request(`/api/projects/${project.slug}/sessions/session-abort/abort`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aborted: true });
  });

  test("POST abort for non-running session returns ok true and aborted false", async () => {
    const { app, project } = await createTestApp("abort-idle");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-idle/abort`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aborted: false });
  });
});
