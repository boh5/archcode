import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { silentLogger } from "../logger";
import { sessionFileInternals } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionToolBatchCall } from "../store/types";
import { ToolOutputArtifactStore } from "../tool-output/artifact-store";
import { ToolOutputFinalizer } from "../tool-output/finalizer";
import { askUserTool } from "../tools/builtins/ask-user";
import { defineTool } from "../tools/define-tool";
import { createToolErrorResult } from "../tools/errors";
import { ToolRegistry } from "../tools/registry";
import { createTextToolResult } from "../tools/results";
import { SecretRedactionPolicy } from "../security";
import { createTestProjectContext } from "../tools/test-project-context";
import type { ToolCallLike, ToolExecutionContext } from "../tools/types";
import { testExecutionStart } from "../testing/test-execution-fixtures";
import {
  SessionToolBatchScheduler,
  applySessionToolBatchChildOutcome,
  applySessionToolBatchResponse,
  cancelSessionToolBatch,
  hasRunnableSessionToolBatch,
  repairSessionToolBatchHitlIds,
  validateSessionToolBatchResponse,
  type SessionToolBatchQueue,
} from "./session-tool-batch-scheduler";

const TMP_DIR = join("/tmp", "archcode-session-tool-batch", crypto.randomUUID());

beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }); });

async function createHarness() {
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, TMP_DIR, { source: { kind: "direct" }, agentName: "lead" });
  store.getState().append(testExecutionStart("test-execution", "tool_call"));
  store.getState().append({ type: "step-start", stepId: "step-0", step: 0 });
  await storeManager.flushSession(sessionId, TMP_DIR);
  const projectContext = createTestProjectContext(TMP_DIR, storeManager);
  const redactionPolicy = new SecretRedactionPolicy([]);
  const artifactStore = new ToolOutputArtifactStore({ rootDir: join(TMP_DIR, "outputs") });
  await artifactStore.ready();
  const registry = new ToolRegistry({
    finalizer: new ToolOutputFinalizer({ artifactStore }),
    hitlCodec: new HitlBoundaryCodec(redactionPolicy),
    logger: silentLogger,
  });
  registry.register(defineTool({
    name: "read_tool",
    description: "read",
    inputSchema: z.object({ value: z.string().optional() }).strict(),
    traits: { readOnly: true, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async (input) => createTextToolResult(input.value ?? "ok"),
  }));
  let permissionExecutions = 0;
  let effectExecutions = 0;
  registry.register(defineTool({
    name: "permission_tool",
    description: "permission",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: true },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    permissions: [async () => ({ outcome: "ask", reason: "Approve effect" })],
    execute: async () => {
      permissionExecutions += 1;
      return createTextToolResult("approved");
    },
  }));
  registry.register(defineTool({
    name: "effect_tool",
    description: "effect",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async () => {
      effectExecutions += 1;
      return createTextToolResult("effect");
    },
  }));
  registry.register(defineTool({
    name: "completion_tool",
    description: "complete execution",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async () => createTextToolResult("completed", { sidecar: { executionCompleted: true } }),
  }));
  registry.register(defineTool({
    name: "cwd_tool",
    description: "cwd",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async () => createTextToolResult("changed", { sidecar: { sessionCwdChanged: true } }),
  }));
  registry.register(askUserTool);
  let scheduler!: SessionToolBatchScheduler;
  registry.register(defineTool({
    name: "delegate",
    description: "synchronous child",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
    outputPolicy: { kind: "inline", previewDirection: "head" },
    execute: async (_input, ctx) => {
      const dependency = {
        parentExecutionId: ctx.executionId,
        runOrdinal: ctx.runOrdinal,
        toolBatchId: ctx.toolBatchId,
        toolCallId: ctx.toolCallId,
        childSessionId: "child-session",
        childExecutionId: "child-execution",
      };
      await scheduler.prepareChildLaunch({
        parentExecutionId: dependency.parentExecutionId,
        parentRunOrdinal: dependency.runOrdinal,
        parentToolBatchId: dependency.toolBatchId,
        parentToolCallId: dependency.toolCallId,
        childSessionId: dependency.childSessionId,
        childExecutionId: dependency.childExecutionId,
      });
      return { kind: "child_deferred" as const, dependency };
    },
    resumeChildDependency: async (_input, _dependency, outcome) => (
      outcome.executionStatus === "completed"
        ? createTextToolResult(outcome.output ?? "child complete")
        : createToolErrorResult({
            kind: "execution",
            code: "CHILD_EXECUTION_FAILED",
            message: `Child ended ${outcome.executionStatus}`,
          })
    ),
  }));

  const queueRecords = new Map<string, string>();
  const hitlQueue: SessionToolBatchQueue = {
    async create(input) {
      const hitlId = queueRecords.get(input.requestKey) ?? crypto.randomUUID();
      queueRecords.set(input.requestKey, hitlId);
      return { record: { hitlId } };
    },
    async cancel() { return undefined; },
    async resolve() { return undefined; },
  };
  const createContext = async (call: ToolCallLike, step: number): Promise<ToolExecutionContext> => ({
    store,
    storeManager,
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input,
    step,
    executionId: "test-execution",
    runOrdinal: 0,
    toolBatchId: store.getState().toolBatches.find((batch) => batch.archivedAt === undefined)!.batchId,
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["read_tool", "effect_tool", "completion_tool", "cwd_tool", "permission_tool", "ask_user", "delegate"]),
    projectContext,
    cwd: TMP_DIR,
  });
  scheduler = new SessionToolBatchScheduler({
    executionId: "test-execution",
    runOrdinal: 0,
    store,
    storeManager,
    workspaceRoot: TMP_DIR,
    registry,
    hitlQueue,
    agentName: "lead",
    allowedTools: ["read_tool", "effect_tool", "completion_tool", "cwd_tool", "permission_tool", "ask_user", "delegate"],
    agentSkills: [],
    createContext,
  });
  return {
    storeManager,
    sessionId,
    store,
    registry,
    scheduler,
    hitlQueue,
    createContext,
    artifactStore,
    permissionExecutions: () => permissionExecutions,
    effectExecutions: () => effectExecutions,
  };
}

function eventResults(harness: Awaited<ReturnType<typeof createHarness>>) {
  return harness.store.getState().events.filter((event) => event.payload.type === "tool-result");
}

async function markRunning(
  harness: Awaited<ReturnType<typeof createHarness>>,
  call: SessionToolBatchCall,
  attempt: number,
) {
  const batch = harness.scheduler.activeBatch()!;
  const checkpointAt = Date.now();
  await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
    ...candidate,
    calls: candidate.calls.map((item) => item.toolCallId === call.toolCallId
      ? { ...item, state: "running", attempt, checkpointAt }
      : item),
  }));
}

describe("SessionToolBatchScheduler output ownership", () => {
  test("persists and appends only nested FinalizedToolResult", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([
      { toolCallId: "read-1", toolName: "read_tool", input: { value: "hello" } },
    ], "step-0", 0);
    const queuedCheckpointAt = batch.calls[0]!.checkpointAt;
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    const call = harness.scheduler.activeBatch()!.calls[0]!;
    expect(call.result?.output.preview).toBe("hello");
    expect(call.checkpointAt).toBeGreaterThanOrEqual(queuedCheckpointAt);
    expect(eventResults(harness)[0]?.payload).toMatchObject({
      type: "tool-result",
      result: { isError: false, output: { preview: "hello" } },
    });
  });

  test("does not append or publish a tool result when its durable checkpoint fails", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "read-checkpoint-failure",
      toolName: "read_tool",
      input: { value: "must-not-publish" },
    }], "step-0", 0);

    const published: string[] = [];
    const unsubscribe = harness.storeManager.subscribeToSessionEvents(({ envelope }) => {
      published.push(envelope.payload.type);
    });
    const originalSave = sessionFileInternals.saveSessionTranscript;
    const failure = new Error("simulated tool result checkpoint failure");
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      const checkpointed = state.toolBatches.some((batch) =>
        batch.calls.some((call) => call.toolCallId === "read-checkpoint-failure" && call.result !== undefined)
      );
      if (checkpointed) throw failure;
      await originalSave(state, workspaceRoot);
    };

    try {
      await expect(harness.scheduler.advance()).rejects.toBe(failure);
      expect(eventResults(harness)).toEqual([]);
      expect(published).not.toContain("tool-result");
    } finally {
      unsubscribe();
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("blocked calls emit zero tool results, then answers resume the same descriptor", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], "step-0", 0);
    const waiting = await harness.scheduler.advance();
    expect(waiting.status).toBe("suspended_hitl");
    expect(eventResults(harness)).toHaveLength(0);
    const blocked = harness.scheduler.activeBatch()!.calls[0]!;
    const hitlId = blocked.blocker!.hitlId!;
    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId,
      requestKey: blocked.blocker!.requestKey,
      response: { type: "question_answer", answers: ["Yes"] },
    });
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    expect(harness.scheduler.activeBatch()!.calls[0]!.result?.details?.presentations?.[0]).toMatchObject({ kind: "ask_user" });
    expect(eventResults(harness)).toHaveLength(1);
  });

  test("missing HITL link repair preserves the blocked call checkpoint", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{
      toolCallId: "ask-repair",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], "step-0", 0);
    const queuedCheckpointAt = batch.calls[0]!.checkpointAt;
    await harness.scheduler.advance();
    const blocked = harness.scheduler.activeBatch()!.calls[0]!;
    expect(blocked.checkpointAt).toBeGreaterThanOrEqual(queuedCheckpointAt);
    await harness.storeManager.updateToolBatches(
      harness.sessionId,
      TMP_DIR,
      (batches) => batches.map((candidate) => ({
        ...candidate,
        calls: candidate.calls.map((call) => {
          if (call.toolCallId !== blocked.toolCallId || call.blocker === undefined) return call;
          const { hitlId: _hitlId, ...blocker } = call.blocker;
          return { ...call, blocker };
        }),
      })),
    );

    await repairSessionToolBatchHitlIds({
      store: harness.store,
      storeManager: harness.storeManager,
      workspaceRoot: TMP_DIR,
      hitlQueue: harness.hitlQueue,
      batchId: batch.batchId,
    });

    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({
      state: "blocked",
      checkpointAt: blocked.checkpointAt,
      blocker: { hitlId: expect.any(String) },
    });
  });

  test("accepted HITL redelivery stays idempotent after its batch is archived", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-archived",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], "step-0", 0);
    await harness.scheduler.advance();
    const blocker = harness.scheduler.activeBatch()!.calls[0]!.blocker!;
    const response = { type: "question_answer" as const, answers: ["Yes"] };
    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocker.hitlId!,
      requestKey: blocker.requestKey,
      response,
    });
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    await harness.scheduler.completeContinuation();

    await expect(validateSessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocker.hitlId!,
      requestKey: blocker.requestKey,
      response,
    })).resolves.toMatchObject({ toolCallId: "ask-archived" });
    await expect(applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocker.hitlId!,
      requestKey: blocker.requestKey,
      response,
    })).resolves.toMatchObject({ toolCallId: "ask-archived" });
    expect(harness.scheduler.activeBatch()).toBeUndefined();
    expect(eventResults(harness)).toHaveLength(1);
  });

  test("redelivery recovers an answered read-only call left running without duplicating its result", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-recovery",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], "step-0", 0);
    await harness.scheduler.advance();
    const blocked = harness.scheduler.activeBatch()!.calls[0]!;
    const response = { type: "question_answer" as const, answers: ["Yes"] };
    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocked.blocker!.hitlId!,
      requestKey: blocked.blocker!.requestKey,
      response,
    });
    await markRunning(harness, harness.scheduler.activeBatch()!.calls[0]!, 1);

    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocked.blocker!.hitlId!,
      requestKey: blocked.blocker!.requestKey,
      response,
    });
    expect(await harness.scheduler.recoverInterruptedBatch()).toMatchObject({
      status: "ready_for_continuation",
    });
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({
      state: "completed",
      attempt: 2,
    });
    expect(eventResults(harness)).toHaveLength(1);
  });

  test("defers approved parallel permission until the final blocker resumes the same Execution", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([
      {
        toolCallId: "permission-1",
        toolName: "permission_tool",
        input: {},
      },
      {
        toolCallId: "permission-2",
        toolName: "permission_tool",
        input: {},
      },
    ], "step-0", 0);
    expect(await harness.scheduler.advance()).toMatchObject({
      status: "suspended_hitl",
      hitlIds: expect.any(Array),
    });
    const [first, second] = harness.scheduler.activeBatch()!.calls;
    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: first!.blocker!.hitlId!,
      requestKey: first!.blocker!.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
    });

    expect(harness.scheduler.activeBatch()!.calls.map((call) => call.state))
      .toEqual(["queued", "blocked"]);
    expect(harness.permissionExecutions()).toBe(0);
    expect(eventResults(harness)).toHaveLength(0);

    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: second!.blocker!.hitlId!,
      requestKey: second!.blocker!.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
    });
    expect(await harness.scheduler.advance()).toMatchObject({
      status: "ready_for_continuation",
    });
    expect(harness.permissionExecutions()).toBe(2);
    expect(eventResults(harness)).toHaveLength(2);
  });

  test("accepts reverse-order HITL answers exactly once before resuming the batch", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([
      { toolCallId: "permission-first", toolName: "permission_tool", input: {} },
      { toolCallId: "permission-second", toolName: "permission_tool", input: {} },
    ], "step-0", 0);
    expect(await harness.scheduler.advance()).toMatchObject({ status: "suspended_hitl" });

    const batch = harness.scheduler.activeBatch()!;
    const [first, second] = batch.calls;
    const secondIdentity = {
      executionId: batch.executionId,
      batchId: batch.batchId,
      toolCallId: second!.toolCallId,
      requestKey: second!.blocker!.requestKey,
      hitlId: second!.blocker!.hitlId!,
    };
    const approved = { type: "permission_decision" as const, decision: "approve_once" as const };

    await expect(applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: secondIdentity.hitlId,
      requestKey: secondIdentity.requestKey,
      response: approved,
    })).resolves.toEqual({ batchId: secondIdentity.batchId, toolCallId: secondIdentity.toolCallId });
    expect(await harness.scheduler.advance()).toMatchObject({ status: "suspended_hitl" });
    expect(harness.permissionExecutions()).toBe(0);
    expect(eventResults(harness)).toHaveLength(0);

    await expect(applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: secondIdentity.hitlId,
      requestKey: secondIdentity.requestKey,
      response: approved,
    })).resolves.toEqual({ batchId: secondIdentity.batchId, toolCallId: secondIdentity.toolCallId });
    await expect(applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: secondIdentity.hitlId,
      requestKey: secondIdentity.requestKey,
      response: { type: "permission_decision", decision: "deny" },
    })).rejects.toThrow("conflicts with the accepted response");

    const secondAfterRedelivery = harness.scheduler.activeBatch()!.calls[1]!;
    expect({
      executionId: harness.scheduler.activeBatch()!.executionId,
      batchId: harness.scheduler.activeBatch()!.batchId,
      toolCallId: secondAfterRedelivery.toolCallId,
      requestKey: secondAfterRedelivery.blocker!.requestKey,
      hitlId: secondAfterRedelivery.blocker!.hitlId,
    }).toEqual(secondIdentity);
    expect(secondAfterRedelivery.blocker!.response).toEqual(approved);
    expect(secondAfterRedelivery.result).toBeUndefined();

    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: first!.blocker!.hitlId!,
      requestKey: first!.blocker!.requestKey,
      response: approved,
    });
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    expect(harness.permissionExecutions()).toBe(2);
    expect(eventResults(harness)).toHaveLength(2);
  });

  test("requires the exact HITL id and requestKey pair", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], "step-0", 0);
    await harness.scheduler.advance();
    const blocker = harness.scheduler.activeBatch()!.calls[0]!.blocker!;
    await expect(validateSessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocker.hitlId!,
      requestKey: "tool:wrong",
      response: { type: "question_answer", answers: ["Yes"] },
    })).rejects.toThrow("do not match");
  });

  test("cancel is finalized only by Registry.resumeBlocked", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], "step-0", 0);
    await harness.scheduler.advance();
    const blocker = harness.scheduler.activeBatch()!.calls[0]!.blocker!;
    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocker.hitlId!,
      requestKey: blocker.requestKey,
      response: { type: "cancel", reason: "No" },
    });
    await harness.scheduler.advance();
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({ state: "failed", result: { isError: true } });
    expect(eventResults(harness)).toHaveLength(1);
  });

  test("permission approval resumes the exact call and performs the effect once", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "permission-1", toolName: "permission_tool", input: {} }], "step-0", 0);
    await harness.scheduler.advance();
    expect(harness.permissionExecutions()).toBe(0);
    expect(eventResults(harness)).toHaveLength(0);
    const blocker = harness.scheduler.activeBatch()!.calls[0]!.blocker!;
    await applySessionToolBatchResponse({
      registry: harness.registry,
      storeManager: harness.storeManager,
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      hitlId: blocker.hitlId!,
      requestKey: blocker.requestKey,
      response: { type: "permission_decision", decision: "approve_once" },
    });
    await harness.scheduler.advance();
    expect(harness.permissionExecutions()).toBe(1);
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({ state: "completed", attempt: 2 });
  });

  for (const executionStatus of ["completed", "failed"] as const) {
    test(`settles a ${executionStatus} child dependency once and clears correlation from the terminal call`, async () => {
      const harness = await createHarness();
      const batch = await harness.scheduler.createBatch([{
        toolCallId: "child-1",
        toolName: "delegate",
        input: {},
      }], "step-0", 0);

      expect(await harness.scheduler.advance()).toMatchObject({
        status: "waiting_for_child",
        toolBatchId: batch.batchId,
        toolCallId: "child-1",
        childSessionId: "child-session",
        childExecutionId: "child-execution",
      });
      expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({
        state: "child_dependency",
        childDependency: {
          kind: "child_dependency",
          childSessionId: "child-session",
          childExecutionId: "child-execution",
        },
      });

      await applySessionToolBatchChildOutcome({
        storeManager: harness.storeManager,
        sessionId: harness.sessionId,
        workspaceRoot: TMP_DIR,
        batchId: batch.batchId,
        toolCallId: "child-1",
        childSessionId: "child-session",
        childExecutionId: "child-execution",
        outcome: {
          outcome: "terminal",
          executionId: "child-execution",
          executionStatus,
          ...(executionStatus === "completed" ? { output: "child output" } : {}),
        },
      });
      expect(await harness.scheduler.advance()).toMatchObject({
        status: "ready_for_continuation",
      });
      const terminalCall = harness.scheduler.activeBatch()!.calls[0]!;
      expect(terminalCall.state).toBe(executionStatus === "completed" ? "completed" : "failed");
      expect(terminalCall.childDependency).toBeUndefined();
      expect(eventResults(harness)).toHaveLength(1);
    });
  }

  test("retries a read-only running call once after restart", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], "step-0", 0);
    await markRunning(harness, batch.calls[0]!, 1);
    expect(await harness.scheduler.recoverInterruptedBatch()).toMatchObject({ status: "ready_for_continuation" });
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({ state: "completed", attempt: 2 });
  });

  test("finalizes an exhausted read-only recovery through the Registry system lane", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], "step-0", 0);
    await markRunning(harness, batch.calls[0]!, 2);
    await harness.scheduler.recoverInterruptedBatch();
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({
      state: "failed",
      recoveryFailure: { kind: "read_retry_exhausted" },
      result: { isError: true },
    });
    expect(eventResults(harness)).toHaveLength(1);
  });

  test("effectful running recovery becomes strict manual inspection without a fabricated result", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "effect-1", toolName: "effect_tool", input: {} }], "step-0", 0);
    await markRunning(harness, batch.calls[0]!, 1);
    const runningCheckpointAt = harness.scheduler.activeBatch()!.calls[0]!.checkpointAt;
    expect(await harness.scheduler.recoverInterruptedBatch()).toEqual({
      status: "manual_inspection_required",
      reason: { kind: "effectful_outcome_unknown", toolCallId: "effect-1", toolName: "effect_tool" },
    });
    expect(harness.store.getState().toolBatches[0]).toMatchObject({
      manualInspectionReason: { kind: "effectful_outcome_unknown" },
      calls: [{
        state: "manual_inspection_required",
        checkpointAt: runningCheckpointAt,
        recoveryFailure: { kind: "effectful_outcome_unknown" },
      }],
    });
    expect(eventResults(harness)).toHaveLength(0);
  });

  test("control-boundary skipped calls are finalized through the system lane", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([
      { toolCallId: "cwd-1", toolName: "cwd_tool", input: {} },
      { toolCallId: "read-2", toolName: "read_tool", input: {} },
    ], "step-0", 0);
    expect(await harness.scheduler.advance()).toMatchObject({ sessionCwdChanged: true });
    expect(harness.scheduler.activeBatch()!.calls.map((call) => call.state)).toEqual(["completed", "failed"]);
    expect(eventResults(harness)).toHaveLength(2);
  });

  test("execution completion archives the batch and rejects every later call", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([
      { toolCallId: "complete-1", toolName: "completion_tool", input: {} },
      { toolCallId: "effect-2", toolName: "effect_tool", input: {} },
    ], "step-0", 0);

    expect(await harness.scheduler.advance()).toEqual({
      status: "execution_completed",
      sessionCwdChanged: false,
    });
    expect(harness.effectExecutions()).toBe(0);
    expect(harness.scheduler.activeBatch()).toBeUndefined();
    expect(harness.store.getState().toolBatches[0]).toMatchObject({
      archivedAt: expect.any(String),
      calls: [
        { state: "completed", executionCompleted: true },
        { state: "failed", result: { isError: true } },
      ],
    });
    expect(eventResults(harness)).toHaveLength(2);
  });

  test("external cancellation uses an injected Registry system lane", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], "step-0", 0);
    const result = await cancelSessionToolBatch({
      storeManager: harness.storeManager,
      hitlQueue: harness.hitlQueue,
      prepareHitlCancellation: async () => undefined,
      settleSystem: async (call, step, raw) => {
        const outcome = await harness.registry.settleSystem(call, await harness.createContext(call, step), raw);
        if (outcome.kind !== "settled") throw new Error("unexpected block");
        return outcome;
      },
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      reason: "Session stopped",
    });
    expect(result.manualInspectionRequired).toBe(false);
    expect(harness.store.getState().toolBatches[0]).toMatchObject({ archivedAt: expect.any(String), calls: [{ state: "failed" }] });
    expect(eventResults(harness)).toHaveLength(1);
  });

  test("external cancellation settles an attempted effectful call as an unknown result", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "effect-1", toolName: "effect_tool", input: {} }], "step-0", 0);
    await markRunning(harness, batch.calls[0]!, 1);

    const result = await cancelSessionToolBatch({
      storeManager: harness.storeManager,
      hitlQueue: harness.hitlQueue,
      prepareHitlCancellation: async () => undefined,
      settleSystem: async (call, step, raw) => {
        const outcome = await harness.registry.settleSystem(call, await harness.createContext(call, step), raw);
        if (outcome.kind !== "settled") throw new Error("unexpected block");
        return outcome;
      },
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      reason: "Execution interrupted",
    });

    expect(result.manualInspectionRequired).toBe(true);
    expect(harness.store.getState().toolBatches[0]).toMatchObject({
      archivedAt: expect.any(String),
      manualInspectionReason: {
        kind: "effectful_cancelled_unknown",
        toolCallId: "effect-1",
        toolName: "effect_tool",
      },
      calls: [{
        state: "failed",
        recoveryFailure: { kind: "effectful_cancelled_unknown" },
        result: { isError: true, details: { unknownResult: true } },
      }],
    });
    expect(eventResults(harness)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          result: expect.objectContaining({
            isError: true,
            details: expect.objectContaining({ unknownResult: true }),
          }),
        }),
      }),
    ]);
  });

  test("external cancellation clears child dependency correlation from the failed call", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "child-1", toolName: "delegate", input: {} }], "step-0", 0);
    expect(await harness.scheduler.advance()).toMatchObject({ status: "waiting_for_child" });

    await cancelSessionToolBatch({
      storeManager: harness.storeManager,
      hitlQueue: harness.hitlQueue,
      prepareHitlCancellation: async () => undefined,
      settleSystem: async (call, step, raw) => {
        const outcome = await harness.registry.settleSystem(call, await harness.createContext(call, step), raw);
        if (outcome.kind !== "settled") throw new Error("unexpected block");
        return outcome;
      },
      sessionId: harness.sessionId,
      workspaceRoot: TMP_DIR,
      reason: "Session stopped",
    });

    const terminalCall = harness.store.getState().toolBatches[0]!.calls[0]!;
    expect(terminalCall).toMatchObject({ state: "failed", result: { isError: true } });
    expect(terminalCall.childDependency).toBeUndefined();
    const reloaded = await new SessionStoreManager({ logger: silentLogger }).getOrLoad(harness.sessionId, TMP_DIR);
    expect(reloaded.getState().toolBatches[0]!.calls[0]!.childDependency).toBeUndefined();
  });

  test("settleQueuedCall rejects non-text system drafts via the bounded system lane", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], "step-0", 0);
    await harness.scheduler.settleQueuedCall("read-1", {
      ...createToolErrorResult({ kind: "execution", message: "bad" }),
      draft: { kind: "source", text: "bad" },
    });
    expect(harness.scheduler.activeBatch()!.calls[0]!.result?.output.preview).toContain("TOOL_OUTPUT_POLICY_VIOLATION");
  });
});
