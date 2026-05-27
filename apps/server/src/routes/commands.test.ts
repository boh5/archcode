import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectRegistry, silentLogger } from "@specra/agent-core";
import type { CommandResult, RunningJob, SpecraRuntime } from "@specra/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "commands-routes");

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
  const dispatch = mock(async (_workspaceRoot: string, sessionId: string, name: string, _args?: string): Promise<CommandResult | null> => {
    if (!running.has(sessionId)) return null;
    if (name === "compact") return { success: true, message: "Context compacted" };
    return { success: false, message: `Unknown command: ${name}` };
  });
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
    dispatchCommand: dispatch,
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
    runtime,
  };
}

describe("commands routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("POST compact dispatches command and returns result", async () => {
    const { app, project, runtime } = await createTestApp("compact-command");
    const jobRes = await app.request(`/api/projects/${project.slug}/sessions/session-compact/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Start" }),
      headers: { "content-type": "application/json" },
    });
    expect(jobRes.status).toBe(202);

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-compact/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "compact", args: "now" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: "Context compacted" });
    expect(runtime.dispatchCommand).toHaveBeenCalledWith(project.workspaceRoot, "session-compact", "compact", "now");
  });

  test("POST invalid request body returns 400", async () => {
    const { app, project } = await createTestApp("invalid-command");
    await app.request(`/api/projects/${project.slug}/sessions/session-invalid/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Start" }),
      headers: { "content-type": "application/json" },
    });

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-invalid/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  test("POST unknown session returns 404", async () => {
    const { app, project } = await createTestApp("unknown-session");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "compact" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing" },
    });
  });

  test("POST command before message start returns 404", async () => {
    const { app, project } = await createTestApp("idle-command");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-idle/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "compact" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(404);
  });
});
