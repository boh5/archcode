import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionToolBatchCall } from "../store/types";
import { defineTool } from "../tools/define-tool";
import { ToolRegistry } from "../tools/registry";
import {
  SessionToolBatchScheduler,
  applySessionToolBatchResponse,
  cancelSessionToolBatch,
  hasRunnableSessionToolBatch,
  validateSessionToolBatchResponse,
  type SessionToolBatchSchedulerOptions,
  type SessionToolBatchQueue,
} from "./session-tool-batch-scheduler";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "session-tool-batch", crypto.randomUUID());

beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }); });

function createHarness(options: {
  executeCall?: SessionToolBatchSchedulerOptions["executeCall"];
} = {}) {
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });
  const registry = new ToolRegistry(silentLogger);
  registry.register(defineTool({
    name: "read_tool",
    description: "read",
    inputSchema: z.object({}),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    execute: async () => "ok",
  }));
  const records = new Map<string, string>();
  const cancelled = new Set<string>();
  const resolved = new Set<string>();
  let creates = 0;
  const hitlQueue: SessionToolBatchQueue = {
    async create(input) {
      creates += 1;
      const hitlId = records.get(input.requestKey) ?? crypto.randomUUID();
      records.set(input.requestKey, hitlId);
      return { record: { hitlId } };
    },
    async cancel(hitlId) {
      cancelled.add(hitlId);
      return undefined;
    },
    async resolve(hitlId, outcome) {
      if (outcome.type === "applied") resolved.add(hitlId);
      return undefined;
    },
  };
  const executeCall = options.executeCall ?? (async () => ({ output: "ok", isError: false }));
  const scheduler = new SessionToolBatchScheduler({
    store,
    storeManager,
    workspaceRoot: TMP_DIR,
    registry,
    hitlQueue,
    agentName: "engineer",
    allowedTools: ["read_tool"],
    agentSkills: [],
    executeCall,
  });
  return { sessionId, store, storeManager, registry, hitlQueue, executeCall, scheduler, records, cancelled, resolved, creates: () => creates };
}

function blockedCall(call: SessionToolBatchCall): SessionToolBatchCall {
  return {
    ...call,
    state: "blocked",
    blocker: {
      requestKey: `request:${call.toolCallId}`,
      source: { type: "ask_user", toolCallId: call.toolCallId },
      displayPayload: { title: "Question", redacted: true },
    },
  };
}

describe("SessionToolBatchScheduler recovery", () => {
  test("canonicalizes an undefined call input before persisting the batch", async () => {
    const harness = createHarness();

    const batch = await harness.scheduler.createBatch([{
      toolCallId: "call-undefined",
      toolName: "read_tool",
      input: undefined,
    }], 0);

    expect(batch.calls[0]?.input).toBeNull();
    await expect(harness.storeManager.flushSession(harness.sessionId, TMP_DIR)).resolves.toBeUndefined();
    const restarted = new SessionStoreManager({ logger: silentLogger });
    await expect(restarted.getOrLoad(harness.sessionId, TMP_DIR)).resolves.toBeDefined();
  });

  test("repairs a crash before queue creation from the durable requestKey", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([{
      toolCallId: "call-1",
      toolName: "read_tool",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }] },
    }], 0);
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId === batch.batchId
      ? { ...candidate, calls: candidate.calls.map(blockedCall) }
      : candidate));

    expect(hasRunnableSessionToolBatch(harness.store.getState())).toBe(true);

    const result = await harness.scheduler.recoverInterruptedBatch();

    expect(result?.status).toBe("waiting_for_human");
    expect(harness.scheduler.activeBatch()?.calls[0]?.blocker?.hitlId).toBeString();
    expect(harness.creates()).toBe(1);
  });

  test("repairs a crash after queue creation by idempotently reusing requestKey", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "call-1", toolName: "read_tool", input: {} }], 0);
    const requestKey = "request:call-1";
    const existingId = crypto.randomUUID();
    harness.records.set(requestKey, existingId);
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId === batch.batchId
      ? { ...candidate, calls: candidate.calls.map(blockedCall) }
      : candidate));

    await harness.scheduler.recoverInterruptedBatch();

    expect(harness.scheduler.activeBatch()?.calls[0]?.blocker?.hitlId).toBe(existingId);
    expect(harness.creates()).toBe(1);
  });

  test("stop repair creates a missing queue record before archiving the batch", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "call-1", toolName: "read_tool", input: {} }], 0);
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId === batch.batchId
      ? { ...candidate, calls: candidate.calls.map(blockedCall) }
      : candidate));

    const result = await cancelSessionToolBatch({
      storeManager: harness.storeManager,
      hitlQueue: {
        async create(input) {
          const hitlId = harness.records.get(input.requestKey) ?? crypto.randomUUID();
          harness.records.set(input.requestKey, hitlId);
          return { record: { hitlId } };
        },
      },
      prepareHitlCancellation: async () => undefined,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      reason: "Session stopped",
    });

    expect(result.hitlIds).toHaveLength(1);
    expect(harness.store.getState().toolBatches[0]?.archivedAt).toBeString();
    expect(harness.store.getState().toolBatches[0]?.calls[0]).toMatchObject({
      state: "failed",
      blocker: { hitlId: result.hitlIds[0] },
    });
  });

  test("accepted response application is idempotent after its Session checkpoint", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([{
      toolCallId: "call-1",
      toolName: "read_tool",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }] },
    }], 0);
    const hitlId = crypto.randomUUID();
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId === batch.batchId
      ? { ...candidate, calls: candidate.calls.map((call) => ({ ...blockedCall(call), blocker: { ...blockedCall(call).blocker!, hitlId } })) }
      : candidate));
    const response = { type: "question_answer" as const, answers: ["yes"] };

    const first = await applySessionToolBatchResponse({ storeManager: harness.storeManager, sessionId: harness.sessionId, workspaceRoot: TMP_DIR, hitlId, requestKey: "request:call-1", response });
    const eventCount = harness.store.getState().events.length;
    const second = await applySessionToolBatchResponse({ storeManager: harness.storeManager, sessionId: harness.sessionId, workspaceRoot: TMP_DIR, hitlId, requestKey: "request:call-1", response });

    expect(second).toEqual(first);
    expect(harness.store.getState().events.length).toBe(eventCount);
  });

  test("rejects malformed ask_user answers before the queue makes them immutable", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([{
      toolCallId: "question-call",
      toolName: "ask_user",
      input: {
        questions: [
          { question: "First?", header: "First", custom: true },
          { question: "Second?", header: "Second", custom: true },
        ],
      },
    }], 0);
    const hitlId = crypto.randomUUID();
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
      ...candidate,
      calls: candidate.calls.map((call) => ({
        ...blockedCall(call),
        blocker: { ...blockedCall(call).blocker!, hitlId },
      })),
    }));

    await expect(validateSessionToolBatchResponse({
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId,
      requestKey: "request:question-call",
      response: { type: "question_answer", answers: ["only one"] },
    })).rejects.toThrow("received 1 answers but expected 2");
  });

  test("recognizes an applied response in an archived batch after a queue-resolution crash", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "call-1", toolName: "read_tool", input: {} }], 0);
    const hitlId = crypto.randomUUID();
    const now = new Date().toISOString();
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
      ...candidate,
      archivedAt: now,
      calls: candidate.calls.map((call) => ({
        ...blockedCall(call),
        state: "failed" as const,
        blocker: { ...blockedCall(call).blocker!, hitlId, responseAppliedAt: now },
      })),
    }));

    await expect(applySessionToolBatchResponse({
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId,
      requestKey: "request:call-1",
      response: { type: "cancel", reason: "stopped" },
    })).resolves.toEqual({ batchId: batch.batchId, toolCallId: "call-1" });
  });

  test("cold startup does not replay completed or failed tool calls", async () => {
    const executeCall = mock(async (call: { toolCallId: string }) => ({
      output: call.toolCallId === "failed" ? "failed once" : "completed once",
      isError: call.toolCallId === "failed",
    }));
    const harness = createHarness({ executeCall });
    for (const toolCallId of ["completed", "failed"]) {
      harness.store.getState().append({ type: "tool-call", toolCallId, toolName: "read_tool", input: {} });
    }
    await harness.scheduler.createBatch([
      { toolCallId: "completed", toolName: "read_tool", input: {} },
      { toolCallId: "failed", toolName: "read_tool", input: {} },
    ], 0);
    expect((await harness.scheduler.advance()).status).toBe("ready_for_continuation");
    expect(executeCall).toHaveBeenCalledTimes(2);
    await harness.storeManager.flushSession(harness.sessionId, TMP_DIR);

    harness.storeManager.clearAll();
    const reloaded = await harness.storeManager.getOrLoad(harness.sessionId, TMP_DIR);
    const settledBefore = reloaded.getState().messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && (part.state === "completed" || part.state === "error"));
    const replay = mock(async () => ({ output: "must not replay", isError: false }));
    const recovered = new SessionToolBatchScheduler({
      store: reloaded,
      storeManager: harness.storeManager,
      workspaceRoot: TMP_DIR,
      registry: harness.registry,
      hitlQueue: harness.hitlQueue,
      agentName: "engineer",
      allowedTools: ["read_tool"],
      agentSkills: [],
      executeCall: replay,
    });

    expect((await recovered.recoverInterruptedBatch())?.status).toBe("ready_for_continuation");
    const settledAfter = reloaded.getState().messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "tool" && (part.state === "completed" || part.state === "error"));
    expect(replay).not.toHaveBeenCalled();
    expect(settledAfter).toHaveLength(settledBefore.length);
    expect(recovered.activeBatch()?.calls.map((call) => [call.toolCallId, call.state])).toEqual([
      ["completed", "completed"],
      ["failed", "failed"],
    ]);
  });

  test("read-only recovery retries once and then records a deterministic failure", async () => {
    const executeCall = mock(async () => { throw new Error("simulated crash during recovery"); });
    const harness = createHarness({ executeCall });
    const batch = await harness.scheduler.createBatch([{ toolCallId: "read-crash", toolName: "read_tool", input: {} }], 0);
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
      ...candidate,
      calls: candidate.calls.map((call) => ({ ...call, state: "running", attempt: 1 })),
    }));

    await expect(harness.scheduler.recoverInterruptedBatch()).rejects.toThrow("simulated crash during recovery");
    expect(harness.scheduler.activeBatch()?.calls[0]).toMatchObject({ state: "running", attempt: 2 });

    expect((await harness.scheduler.recoverInterruptedBatch())?.status).toBe("ready_for_continuation");
    expect(executeCall).toHaveBeenCalledTimes(1);
    expect(harness.scheduler.activeBatch()?.calls[0]).toMatchObject({
      state: "failed",
      attempt: 2,
      result: { isError: true },
    });
    expect(harness.scheduler.activeBatch()?.calls[0]?.result?.output).toContain("TOOL_RECOVERY_FAILED");
  });

  test("manual inspection archives and terminalizes sibling blockers", async () => {
    const harness = createHarness();
    const batch = await harness.scheduler.createBatch([
      { toolCallId: "unknown-effect", toolName: "read_tool", input: {} },
      { toolCallId: "blocked-sibling", toolName: "read_tool", input: {} },
    ], 0);
    const hitlId = crypto.randomUUID();
    await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
      ...candidate,
      calls: candidate.calls.map((call) => call.toolCallId === "unknown-effect"
        ? { ...call, state: "running" as const, attempt: 1, traits: { ...call.traits, readOnly: false } }
        : { ...blockedCall(call), blocker: { ...blockedCall(call).blocker!, hitlId } }),
    }));

    const result = await harness.scheduler.recoverInterruptedBatch();
    const archived = harness.store.getState().toolBatches[0]!;

    expect(result?.status).toBe("manual_inspection_required");
    expect(archived.archivedAt).toBeString();
    expect(archived.calls).toMatchObject([
      { toolCallId: "unknown-effect", state: "manual_inspection_required" },
      { toolCallId: "blocked-sibling", state: "failed", blocker: { hitlId, responseAppliedAt: expect.any(String) } },
    ]);
    expect(harness.cancelled).toContain(hitlId);
    expect(harness.resolved).toContain(hitlId);
  });
});

describe("SessionToolBatchScheduler partition barriers", () => {
  test("F1 to F2 to F1 creates three distinct answerable permission HITLs", async () => {
    const firstFingerprint = "1".repeat(64);
    const secondFingerprint = "2".repeat(64);
    let execution = 0;
    const harness = createHarness({
      executeCall: async (call) => {
        execution += 1;
        if (execution === 4) return { output: "approved", isError: false };
        const permissionFingerprint = execution === 2 ? secondFingerprint : firstFingerprint;
        return {
          output: "",
          isError: false,
          blocked: {
            source: { type: "tool_permission", toolCallId: call.toolCallId, toolName: call.toolName },
            displayPayload: { title: `Approve generation ${execution}`, redacted: true },
            permissionFingerprint,
            persistentApprovalEligible: true,
          },
        };
      },
    });
    await harness.scheduler.createBatch([{ toolCallId: "oscillating", toolName: "read_tool", input: {} }], 0);
    const hitlIds: string[] = [];
    const requestKeys: string[] = [];

    for (let generation = 1; generation <= 3; generation += 1) {
      const waiting = await harness.scheduler.advance();
      if (waiting.status !== "waiting_for_human") throw new Error(`Expected blocker generation ${generation}`);
      const blocker = harness.scheduler.activeBatch()!.calls[0]!.blocker!;
      hitlIds.push(waiting.hitlIds[0]!);
      requestKeys.push(blocker.requestKey);
      await validateSessionToolBatchResponse({
        storeManager: harness.storeManager,
        sessionId: harness.sessionId,
        workspaceRoot: TMP_DIR,
        hitlId: waiting.hitlIds[0]!,
        requestKey: blocker.requestKey,
        response: { type: "permission_decision", decision: "approve_once" },
      });
      await applySessionToolBatchResponse({
        storeManager: harness.storeManager,
        sessionId: harness.sessionId,
        workspaceRoot: TMP_DIR,
        hitlId: waiting.hitlIds[0]!,
        requestKey: blocker.requestKey,
        response: { type: "permission_decision", decision: "approve_once" },
      });
    }

    expect(new Set(hitlIds).size).toBe(3);
    expect(new Set(requestKeys).size).toBe(3);
    expect(requestKeys).toEqual([
      expect.stringContaining(":attempt:1:permission:"),
      expect.stringContaining(":attempt:2:permission:"),
      expect.stringContaining(":attempt:3:permission:"),
    ]);
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({
      state: "completed",
      attempt: 4,
      result: { output: "approved", isError: false },
    });
  });

  test("changed permission fingerprint reblocks with a new HITL instead of consuming the old answer", async () => {
    const firstFingerprint = "a".repeat(64);
    const secondFingerprint = "b".repeat(64);
    const harness = createHarness({
      executeCall: async (call, context) => ({
        output: "",
        isError: false,
        blocked: {
          source: { type: "tool_permission", toolCallId: call.toolCallId, toolName: call.toolName },
          displayPayload: { title: "Approve changed scope", redacted: true },
          permissionFingerprint: context.deferredPermissionResponse === undefined ? firstFingerprint : secondFingerprint,
          persistentApprovalEligible: true,
        },
      }),
    });
    await harness.scheduler.createBatch([{ toolCallId: "changed", toolName: "read_tool", input: {} }], 0);
    const initial = await harness.scheduler.advance();
    if (initial.status !== "waiting_for_human") throw new Error("Expected initial blocker");
    const oldHitlId = initial.hitlIds[0]!;
    const blocker = harness.scheduler.activeBatch()!.calls[0]!.blocker!;

    await applySessionToolBatchResponse({
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: oldHitlId,
      requestKey: blocker.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
    });
    const resumed = await harness.scheduler.advance();

    expect(resumed.status).toBe("waiting_for_human");
    if (resumed.status !== "waiting_for_human") throw new Error("Expected changed scope blocker");
    expect(resumed.hitlIds[0]).not.toBe(oldHitlId);
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({
      state: "blocked",
      blocker: { permissionFingerprint: secondFingerprint, persistentApprovalEligible: true },
    });
    expect(harness.creates()).toBe(2);
  });

  test("answering one of two parallel blockers resumes only that call", async () => {
    const executions: string[] = [];
    const harness = createHarness({
      executeCall: async (call, context) => {
        executions.push(`${call.toolCallId}:${context.deferredPermissionResponse?.decision ?? "blocked"}`);
        if (context.deferredPermissionResponse !== undefined) return { output: `${call.toolCallId} approved`, isError: false };
        return {
          output: "",
          isError: false,
          blocked: {
            source: { type: "tool_permission", toolCallId: call.toolCallId, toolName: call.toolName },
            displayPayload: { title: `Approve ${call.toolCallId}`, redacted: true },
            permissionFingerprint: "a".repeat(64),
            persistentApprovalEligible: true,
          },
        };
      },
    });
    await harness.scheduler.createBatch([
      { toolCallId: "first", toolName: "read_tool", input: {} },
      { toolCallId: "second", toolName: "read_tool", input: {} },
    ], 0);

    const blocked = await harness.scheduler.advance();
    expect(blocked).toMatchObject({ status: "waiting_for_human" });
    if (blocked.status !== "waiting_for_human") throw new Error("Expected two blockers");
    expect(blocked.hitlIds).toHaveLength(2);
    const first = harness.scheduler.activeBatch()!.calls.find((call) => call.toolCallId === "first")!;
    await applySessionToolBatchResponse({
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: first.blocker!.hitlId!,
      requestKey: first.blocker!.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
    });

    const afterOneAnswer = await harness.scheduler.advance();
    expect(afterOneAnswer).toEqual({
      status: "waiting_for_human",
      hitlIds: [harness.scheduler.activeBatch()!.calls.find((call) => call.toolCallId === "second")!.blocker!.hitlId!],
      sessionCwdChanged: false,
    });
    expect(harness.scheduler.activeBatch()?.calls.map((call) => [call.toolCallId, call.state])).toEqual([
      ["first", "completed"],
      ["second", "blocked"],
    ]);
    expect(executions).toEqual([
      "first:blocked",
      "second:blocked",
      "first:approve_once",
    ]);
  });

  test("parallel siblings finish while a blocker keeps the next serial partition queued", async () => {
    const harness = createHarness();
    const registry = new ToolRegistry(silentLogger);
    registry.register(defineTool({
      name: "read_tool",
      description: "read",
      inputSchema: z.object({}),
      traits: { readOnly: true, destructive: false, concurrencySafe: true },
      execute: async () => "ok",
    }));
    registry.register(defineTool({
      name: "write_tool",
      description: "write",
      inputSchema: z.object({}),
      traits: { readOnly: false, destructive: true, concurrencySafe: false },
      permissions: [async () => ({ outcome: "allow" })],
      execute: async () => "written",
    }));
    const executed: string[] = [];
    const scheduler = new SessionToolBatchScheduler({
      store: harness.store,
      storeManager: harness.storeManager,
      workspaceRoot: TMP_DIR,
      registry,
      hitlQueue: {
        async create(input) { return { record: { hitlId: `hitl:${input.source.type}:${input.source.toolCallId}` } }; },
        async cancel() { return undefined; },
        async resolve() { return undefined; },
      },
      agentName: "engineer",
      allowedTools: ["read_tool", "write_tool"],
      agentSkills: [],
      executeCall: async (call) => {
        executed.push(call.toolCallId);
        if (call.toolCallId === "blocked") {
          return {
            output: "",
            isError: false,
            blocked: {
              source: { type: "ask_user", toolCallId: call.toolCallId },
              displayPayload: { title: "Question", redacted: true },
            },
          };
        }
        return { output: "ok", isError: false };
      },
    });
    await scheduler.createBatch([
      { toolCallId: "blocked", toolName: "read_tool", input: {} },
      { toolCallId: "sibling", toolName: "read_tool", input: {} },
      { toolCallId: "after-barrier", toolName: "write_tool", input: {} },
    ], 0);

    const result = await scheduler.advance();
    const calls = scheduler.activeBatch()!.calls;

    expect(result.status).toBe("waiting_for_human");
    expect(calls.map((call) => [call.toolCallId, call.state])).toEqual([
      ["blocked", "blocked"],
      ["sibling", "completed"],
      ["after-barrier", "queued"],
    ]);
    expect(executed.sort()).toEqual(["blocked", "sibling"]);
    expect(hasRunnableSessionToolBatch(harness.store.getState())).toBe(false);
  });
});
