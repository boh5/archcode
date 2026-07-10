import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectRegistry, silentLogger } from "@archcode/agent-core";
import type { ActiveSessionExecution, SlashCommandResult, AgentRuntime } from "@archcode/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "commands-routes");

function makeExecution(sessionId: string, workspaceRoot: string): ActiveSessionExecution {
  return {
    sessionId,
    workspaceRoot,
    agentName: "orchestrator",
    origin: "user_message",
    abortController: new AbortController(),
    promise: new Promise(() => undefined),
    executionToken: Symbol("test-execution"),
    startedAt: Date.now(),
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry): AgentRuntime {
  const running = new Set<string>();
  const dispatch = mock(async (_workspaceRoot: string, sessionId: string, name: string, _args?: string): Promise<SlashCommandResult | null> => {
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
    startSessionExecution: mock((input) => {
      running.add(input.sessionId);
      return makeExecution(input.sessionId, input.workspaceRoot);
    }),
    startSessionMessageExecution: mock(async (input) => {
      running.add(input.sessionId);
      return makeExecution(input.sessionId, input.workspaceRoot);
    }),
    abortSessionExecution: mock((_workspaceRoot: string, sessionId: string) => running.delete(sessionId)),
    abortSessionExecutionAndWait: mock(async (_workspaceRoot: string, sessionId: string) => {
      running.delete(sessionId);
    }),
    abortAllSessionExecutions: mock(async () => running.clear()),
    isSessionExecutionRunning: mock((_workspaceRoot: string, sessionId: string) => running.has(sessionId)),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async (_workspaceRoot: string, sessionId: string) => {
      running.delete(sessionId);
    }),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: dispatch,
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
