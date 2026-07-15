import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentRuntime, CompressionOriginalRangeResult } from "@archcode/agent-core";
import { ProjectRegistry, SessionFileNotFoundError, silentLogger } from "@archcode/agent-core";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "compression-routes");

function createSuccess(blockRef: string): Extract<CompressionOriginalRangeResult, { ok: true }> {
  return {
    ok: true,
    blockRef: blockRef as "b1",
    blockId: "block-id",
    status: "active",
    strategy: "dynamic-range",
    trigger: "model_tool_call",
    childBlockRefs: [],
    range: {
      startMessageId: "msg-1",
      endMessageId: "msg-2",
      startRef: "m0001",
      endRef: "m0002",
      startIndex: 0,
      endIndex: 1,
    },
    coveredRefs: ["m0001", "m0002"],
    coveredMessageIds: ["msg-1", "msg-2"],
    messages: [
      { ref: "m0001", message: { id: "msg-1", role: "user", parts: [{ type: "text", id: "t1", text: "hello", createdAt: 1, completedAt: 2 }], createdAt: 1, completedAt: 2 } },
      { ref: "m0002", message: { id: "msg-2", role: "assistant", parts: [{ type: "text", id: "t2", text: "world", createdAt: 3, completedAt: 4 }], createdAt: 3, completedAt: 4 } },
    ],
  };
}

function createUnsupported(blockRef: string): Extract<CompressionOriginalRangeResult, { ok: false; code: "unsupported" }> {
  return {
    ok: false,
    code: "unsupported",
    reason: "missing_hybrid_coverage",
    blockRef,
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry) {
  const calls: Array<{ workspaceRoot: string; sessionId: string; blockRef: string }> = [];
  let result: CompressionOriginalRangeResult = createSuccess("b1");

  const runtime = {
    projectRegistry,
    mcpManager: undefined,
    toolRegistry: undefined,
    skillService: undefined,
    providerRegistry: undefined,
    warnings: [],
    contextResolver: undefined,
    hitl: undefined,
    subscribeSessionRuntimeChanges: () => () => undefined,
    subscribeMcpStatusChanges: () => () => undefined,
    getMcpServerStatuses: () => new Map(),
    createSession: async () => { throw new Error("not implemented"); },
    getSessionFile: async () => { throw new Error("not implemented"); },
    resolveCompressionOriginalRange: mock(async (workspaceRoot: string, sessionId: string, blockRef: string) => {
      calls.push({ workspaceRoot, sessionId, blockRef });
      if (sessionId === "missing-session") throw new SessionFileNotFoundError(sessionId);
      return result;
    }),
    listSessions: async () => [],
    listSessionTree: async () => { throw new Error("not implemented"); },
    stopSessionFamily: async () => undefined,
    abortAllSessionExecutions: async () => undefined,
    getSessionFamilyActivity: () => "idle" as const,
    getSessionExecution: () => undefined,
    subscribeSessionEvents: () => () => undefined,
    deleteSession: async () => undefined,
    disposeSessionAgent: () => undefined,
    disposeAllSessionAgents: () => undefined,
    isSessionTombstoned: () => false,
    listAutomations: async () => [],
    readAutomation: async () => { throw new Error("not implemented"); },
    createAutomation: async () => { throw new Error("not implemented"); },
    updateAutomation: async () => { throw new Error("not implemented"); },
    deleteAutomation: async () => undefined,
    pauseAutomation: async () => { throw new Error("not implemented"); },
    resumeAutomation: async () => { throw new Error("not implemented"); },
    runAutomationNow: async () => { throw new Error("not implemented"); },
    listAutomationInvocations: async () => [],
    startAutomationSchedulers: async () => undefined,
    stopAutomationSchedulers: async () => undefined,
    notifyRuntimeShutdown: () => undefined,
  } as unknown as AgentRuntime;

  return {
    runtime,
    calls,
    setResult(next: CompressionOriginalRangeResult) {
      result = next;
    },
  };
}

async function createTestApp(testName: string) {
  const homeDir = resolve(tempRoot, "homes", testName);
  const workspaceRoot = resolve(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const runtimeFixture = createTestRuntime(projectRegistry);
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  return { app: createServerApp(runtimeFixture.runtime, { dev: true }).app, project, workspaceRoot, ...runtimeFixture };
}

describe("compression routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("GET original range returns covered ids and canonical messages", async () => {
    const { app, project, workspaceRoot, calls } = await createTestApp("success");

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-1/compression/b1/original`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      blockRef: "b1",
      strategy: "dynamic-range",
      coveredRefs: ["m0001", "m0002"],
      coveredMessageIds: ["msg-1", "msg-2"],
    });
    expect(body.messages[0].message.parts[0].text).toBe("hello");
    expect(calls).toEqual([{ workspaceRoot, sessionId: "session-1", blockRef: "b1" }]);
  });

  test("unknown block ref returns structured 404", async () => {
    const { app, project, setResult } = await createTestApp("missing-block");
    setResult({ ok: false, code: "not_found", reason: "compression_block_not_found", blockRef: "b9" });

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-1/compression/b9/original`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: {
        code: "SESSION_NOT_FOUND",
        message: "Compression block not found: b9",
        details: { blockRef: "b9", reason: "compression_block_not_found" },
      },
    });
  });

  test("missing dynamic compression coverage returns explicit unsupported response", async () => {
    const { app, project, setResult } = await createTestApp("missing-coverage");
    setResult(createUnsupported("b1"));

    const res = await app.request(`/api/projects/${project.slug}/sessions/session-1/compression/b1/original`);

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(createUnsupported("b1"));
  });

  test("missing session maps to session 404", async () => {
    const { app, project } = await createTestApp("missing-session");

    const res = await app.request(`/api/projects/${project.slug}/sessions/missing-session/compression/b1/original`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "SESSION_NOT_FOUND", message: "Session not found: missing-session" } });
  });
});
