import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoreApi } from "zustand";
import type { Agent, AgentResult, AgentRunOptions } from "../../agents/types";
import type { CommandResult } from "../../commands/types";
import type { SpecraRuntime } from "../../runtime";
import { ProjectRegistry } from "../../projects/registry";
import { createSessionStore } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import type { ToolConfirmationCallback } from "../../tools";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "commands-routes");

const createScopedSessionStore = createSessionStore as unknown as typeof createSessionStore & ((sessionId: string, workspaceRoot: string) => ReturnType<typeof createSessionStore>);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

class MockAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly runMock: RunMock;

  constructor(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string) {
    this.store = createScopedSessionStore(sessionId, workspaceRoot);
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

function deferred<T>(): Deferred<T> {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });

  return { promise, resolve: resolveValue, reject: rejectValue };
}

function createCommandAgent(sessionId: string, result: Promise<AgentResult>, workspaceRoot: string = tempRoot): MockAgent & { dispatchCommand: ReturnType<typeof mock<(name: string, args?: string) => Promise<CommandResult>>> } {
  const agent = new MockAgent(sessionId, result, workspaceRoot) as MockAgent & { dispatchCommand: ReturnType<typeof mock<(name: string, args?: string) => Promise<CommandResult>>> };
  agent.dispatchCommand = mock(async (name: string, _args?: string): Promise<CommandResult> => {
    if (name === "compact") {
      return { success: true, message: "Context compacted" };
    }

    return { success: false, message: `Unknown command: ${name}` };
  });
  return agent;
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
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    agentFor: async (_workspaceRoot: string, _sessionId: string) => agent,
    dispatchCommand: async (_workspaceRoot: string, requestedSessionId: string, name: string, args?: string) => {
      if (requestedSessionId !== sessionId) return null;
      const dispatchable = agent as Agent & { dispatchCommand?: (name: string, args?: string) => Promise<CommandResult> };
      return await dispatchable.dispatchCommand?.(name, args) ?? null;
    },
  } as unknown as SpecraRuntime;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

describe("commands routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("POST compact dispatches command and returns result", async () => {
    const run = deferred<AgentResult>();
    const agent = createCommandAgent("session-compact", run.promise);
    const { app, project } = await createTestApp("compact-command", agent);
    const jobRes = await app.request(`/api/projects/${project.slug}/sessions/session-compact/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Start" }),
      headers: { "content-type": "application/json" },
    });
    expect(jobRes.status).toBe(202);
    await flushMicrotasks();

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-compact/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "compact", args: "now" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, message: "Context compacted" });
    expect(agent.dispatchCommand).toHaveBeenCalledWith("compact", "now");

    run.resolve({ text: "Done", steps: 1 });
  });

  test("POST invalid request body returns 400", async () => {
    const run = deferred<AgentResult>();
    const agent = createCommandAgent("session-invalid", run.promise);
    const { app, project } = await createTestApp("invalid-command", agent);
    app.request(`/api/projects/${project.slug}/sessions/session-invalid/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Start" }),
      headers: { "content-type": "application/json" },
    });
    await flushMicrotasks();

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-invalid/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    run.resolve({ text: "Done", steps: 1 });
  });

  test("POST unknown session returns 404", async () => {
    const agent = createCommandAgent("session-idle", Promise.resolve({ text: "ok", steps: 1 }));
    const { app, project } = await createTestApp("unknown-session", agent);

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

  test("POST unknown command returns command failure result", async () => {
    const run = deferred<AgentResult>();
    const agent = createCommandAgent("session-unknown-command", run.promise);
    const { app, project } = await createTestApp("unknown-command", agent);
    app.request(`/api/projects/${project.slug}/sessions/session-unknown-command/messages`, {
      method: "POST",
      body: JSON.stringify({ text: "Start" }),
      headers: { "content-type": "application/json" },
    });
    await flushMicrotasks();

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-unknown-command/commands`, {
      method: "POST",
      body: JSON.stringify({ name: "unknown" }),
      headers: { "content-type": "application/json" },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: false, message: "Unknown command: unknown" });

    run.resolve({ text: "Done", steps: 1 });
  });
});
