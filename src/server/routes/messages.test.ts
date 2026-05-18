import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { StoreApi } from "zustand";
import { AgentRunningError } from "../../agents/errors";
import type { Agent, AgentResult, AgentRunOptions } from "../../agents/types";
import type { SpecraRuntime } from "../../main";
import { ProjectRegistry } from "../../projects/registry";
import { createSessionStore } from "../../store/store";
import type { SessionStoreState } from "../../store/types";
import type { ToolConfirmationCallback } from "../../tools";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "messages-routes");

type RunMock = ReturnType<typeof mock<(message: string, options?: AgentRunOptions | AbortSignal) => Promise<AgentResult>>>;

class MockAgent implements Agent {
  readonly store: StoreApi<SessionStoreState>;
  readonly runMock: RunMock;

  constructor(sessionId: string, result: Promise<AgentResult>) {
    this.store = createSessionStore(sessionId);
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
}

function createMockAgent(sessionId: string, result: Promise<AgentResult>): MockAgent {
  return new MockAgent(sessionId, result);
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
  return {
    projectRegistry,
    agent: undefined,
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    agentFor: async () => agent,
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
    app: createServerApp(runtime, { dev: true }),
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
