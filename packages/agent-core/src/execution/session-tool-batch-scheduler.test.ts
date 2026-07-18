import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";

import { HitlBoundaryCodec } from "../hitl/boundary-codec";
import { silentLogger } from "../logger";
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
import {
  SessionToolBatchScheduler,
  applySessionToolBatchResponse,
  cancelSessionToolBatch,
  validateSessionToolBatchResponse,
  type SessionToolBatchQueue,
} from "./session-tool-batch-scheduler";

const TMP_DIR = join("/tmp", "archcode-session-tool-batch", crypto.randomUUID());

beforeEach(async () => { await mkdir(TMP_DIR, { recursive: true }); });
afterEach(async () => { await rm(TMP_DIR, { recursive: true, force: true }); });

async function createHarness() {
  const storeManager = new SessionStoreManager({ logger: silentLogger });
  const sessionId = crypto.randomUUID();
  const store = storeManager.create(sessionId, TMP_DIR, { agentName: "engineer" });
  const projectContext = createTestProjectContext(TMP_DIR, storeManager);
  const redactionPolicy = new SecretRedactionPolicy([]);
  const artifactStore = new ToolOutputArtifactStore({ rootDir: join(TMP_DIR, "outputs") });
  await artifactStore.ready();
  const registry = new ToolRegistry({
    finalizer: new ToolOutputFinalizer({ artifactStore, redactionPolicy }),
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
  registry.register(defineTool({
    name: "permission_tool",
    description: "permission",
    inputSchema: z.object({}).strict(),
    traits: { readOnly: false, destructive: false, concurrencySafe: false },
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
    execute: async () => createTextToolResult("effect"),
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
    abort: new AbortController().signal,
    startedAt: Date.now(),
    allowedTools: new Set(["read_tool", "effect_tool", "cwd_tool", "permission_tool", "ask_user"]),
    projectContext,
    cwd: TMP_DIR,
  });
  const scheduler = new SessionToolBatchScheduler({
    store,
    storeManager,
    workspaceRoot: TMP_DIR,
    registry,
    hitlQueue,
    agentName: "engineer",
    allowedTools: ["read_tool", "effect_tool", "cwd_tool", "permission_tool", "ask_user"],
    agentSkills: [],
    createContext,
  });
  return { storeManager, sessionId, store, registry, scheduler, hitlQueue, createContext, artifactStore, permissionExecutions: () => permissionExecutions };
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
  await harness.storeManager.updateToolBatches(harness.sessionId, TMP_DIR, (batches) => batches.map((candidate) => candidate.batchId !== batch.batchId ? candidate : {
    ...candidate,
    calls: candidate.calls.map((item) => item.toolCallId === call.toolCallId ? { ...item, state: "running", attempt } : item),
  }));
}

describe("SessionToolBatchScheduler hard-cut output ownership", () => {
  test("persists and appends only nested FinalizedToolResult", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: { value: "hello" } }], 0);
    expect(await harness.scheduler.advance()).toMatchObject({ status: "ready_for_continuation" });
    const call = harness.scheduler.activeBatch()!.calls[0]!;
    expect(call.result?.output.preview).toBe("hello");
    expect(eventResults(harness)[0]?.payload).toMatchObject({
      type: "tool-result",
      result: { isError: false, output: { preview: "hello" } },
    });
  });

  test("blocked calls emit zero tool results, then answers resume the same descriptor", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], 0);
    const waiting = await harness.scheduler.advance();
    expect(waiting.status).toBe("waiting_for_human");
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

  test("requires the exact HITL id and requestKey pair", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{
      toolCallId: "ask-1",
      toolName: "ask_user",
      input: { questions: [{ question: "Continue?", header: "Continue", options: [], custom: true }] },
    }], 0);
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
    }], 0);
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
    await harness.scheduler.createBatch([{ toolCallId: "permission-1", toolName: "permission_tool", input: {} }], 0);
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

  test("retries a read-only running call once after restart", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], 0);
    await markRunning(harness, batch.calls[0]!, 1);
    expect(await harness.scheduler.recoverInterruptedBatch()).toMatchObject({ status: "ready_for_continuation" });
    expect(harness.scheduler.activeBatch()!.calls[0]).toMatchObject({ state: "completed", attempt: 2 });
  });

  test("finalizes an exhausted read-only recovery through the Registry system lane", async () => {
    const harness = await createHarness();
    const batch = await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], 0);
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
    const batch = await harness.scheduler.createBatch([{ toolCallId: "effect-1", toolName: "effect_tool", input: {} }], 0);
    await markRunning(harness, batch.calls[0]!, 1);
    expect(await harness.scheduler.recoverInterruptedBatch()).toEqual({
      status: "manual_inspection_required",
      reason: { kind: "effectful_outcome_unknown", toolCallId: "effect-1", toolName: "effect_tool" },
    });
    expect(harness.store.getState().toolBatches[0]).toMatchObject({
      manualInspectionReason: { kind: "effectful_outcome_unknown" },
      calls: [{ state: "manual_inspection_required", recoveryFailure: { kind: "effectful_outcome_unknown" } }],
    });
    expect(eventResults(harness)).toHaveLength(0);
  });

  test("control-boundary skipped calls are finalized through the system lane", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([
      { toolCallId: "cwd-1", toolName: "cwd_tool", input: {} },
      { toolCallId: "read-2", toolName: "read_tool", input: {} },
    ], 0);
    expect(await harness.scheduler.advance()).toMatchObject({ sessionCwdChanged: true });
    expect(harness.scheduler.activeBatch()!.calls.map((call) => call.state)).toEqual(["completed", "failed"]);
    expect(eventResults(harness)).toHaveLength(2);
  });

  test("external cancellation uses an injected Registry system lane", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], 0);
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

  test("settleQueuedCall rejects non-text system drafts via the bounded system lane", async () => {
    const harness = await createHarness();
    await harness.scheduler.createBatch([{ toolCallId: "read-1", toolName: "read_tool", input: {} }], 0);
    await harness.scheduler.settleQueuedCall("read-1", {
      ...createToolErrorResult({ kind: "execution", message: "bad" }),
      draft: { kind: "source", text: "bad" },
    });
    expect(harness.scheduler.activeBatch()!.calls[0]!.result?.output.preview).toContain("TOOL_OUTPUT_POLICY_VIOLATION");
  });
});
