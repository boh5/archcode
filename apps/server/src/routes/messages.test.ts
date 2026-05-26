import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRunningError } from "@specra/agent-core";
import type { Agent, AgentResult, AgentRunOptions } from "@specra/agent-core";
import type { SpecraRuntime } from "@specra/agent-core";
import { ProjectRegistry } from "@specra/agent-core";
import type { ToolConfirmationCallback } from "@specra/agent-core";
import { SessionStoreManager } from "../../../../packages/agent-core/src/store/session-store-manager";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "messages-routes");
const manager = new SessionStoreManager();
type TestSessionStore = ReturnType<typeof manager.create>;

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

class MockAgent implements Agent {
  readonly store: TestSessionStore;
  readonly runMock: RunMock;

  constructor(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string) {
    this.store = manager.create(sessionId, workspaceRoot);
    this.runMock = mock(async (_message: string, options?: AgentRunOptions | AbortSignal) => {
      const signal = options instanceof AbortSignal ? options : options?.abort;
      return await withAbort(result, signal);
    });
  }

  run(
    userMessage: string,
    abort?: AbortSignal,
    confirmPermission?: ToolConfirmationCallback,
  ): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions): Promise<AgentResult>;
  run(userMessage: string, options?: AgentRunOptions | AbortSignal): Promise<AgentResult> {
    return this.runMock(userMessage, options);
  }

  dispose(): void {}
}

function createMockAgent(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string = tempRoot): MockAgent {
  return new MockAgent(sessionId, result, workspaceRoot);
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return await promise;
  }

  signal.throwIfAborted();
  return await Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    }),
  ]);
}

function createTestRuntime(projectRegistry: ProjectRegistry, agent: Agent): SpecraRuntime {
  const sessionId = agent.store.getState().sessionId;
  return {
    sessionAgentManager: {
      get: (_workspaceRoot: string, requestedSessionId: string) => (requestedSessionId === sessionId ? agent : undefined),
      getOrCreate: async () => agent,
      dispose: () => undefined,
      disposeAll: () => undefined,
      getByWorkspace: () => [],
      isTombstoned: () => false,
      acquireSlot: () => undefined,
      releaseSlot: () => undefined,
      abortAndDispose: async () => undefined,
    },
    storeManager: manager,
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    acquireSessionSlot: () => undefined,
    releaseSessionSlot: () => undefined,
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    requestPermission: async () => "timeout",
    respondPermission: () => false,
    requestQuestion: async () => ({ isError: true, reason: "Cancelled" }),
    respondQuestion: () => false,
    cleanupDeferredSession: () => undefined,
    notifyRuntimeShutdown: () => undefined,
    agentFor: async (_workspaceRoot: string, _sessionId: string) => agent,
  } as unknown as SpecraRuntime;
}

async function createTestApp(testName: string, agent: Agent) {
  const homeDir = join(tempRoot, "homes", testName);
  const workspaceRoot = join(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry, agent);

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
  };
}

describe("messages routes", () => {
  beforeEach(async () => {
    manager.clearAll();
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("POST message with valid text returns 202 and jobId", async () => {
    const agent = createMockAgent("session-valid", Promise.resolve({ text: "ok", steps: 1 }));
    const { app, project } = await createTestApp("valid-message", agent);

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
    const agent = createMockAgent("session-missing", Promise.resolve({ text: "ok", steps: 1 }));
    const { app, project } = await createTestApp("missing-text", agent);

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
    const agent = createMockAgent("session-project", Promise.resolve({ text: "ok", steps: 1 }));
    const { app } = await createTestApp("missing-project", agent);

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
    const agent = createMockAgent("session-conflict", new Promise(() => undefined));
    const { app, project } = await createTestApp("running-conflict", agent);
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
    const agent = createMockAgent("session-abort", new Promise(() => undefined));
    const { app, project } = await createTestApp("abort-running", agent);

    await app.request(`/api/projects/${project.slug}/sessions/session-abort/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Hello" }),
      headers: { "content-type": "application/json" },
    });
    const res = await app.request(`/api/projects/${project.slug}/sessions/session-abort/abort`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aborted: true });
  });

  test("POST abort for non-running session returns ok true and aborted false", async () => {
    const agent = createMockAgent("session-idle", Promise.resolve({ text: "ok", steps: 1 }));
    const { app, project } = await createTestApp("abort-idle", agent);

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-idle/abort`, {
      method: "POST",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, aborted: false });
  });
});
