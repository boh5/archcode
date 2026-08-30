import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats } from "@archcode/protocol";
import { silentLogger } from "../logger";
import { InvalidExecutionTransitionError } from "./types";
import { SessionStoreManager } from "./session-store-manager";
import {
  testExecutionLoadedToolRefs,
  testExecutionMemoryPolicy,
  testExecutionToolAuthorizationSnapshot,
} from "../testing/test-execution-fixtures";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "logical-execution", crypto.randomUUID());
const binding = {
  selection: { model: "test:model" },
  providerId: "test",
  modelId: "model",
  providerDisplayName: "Test",
  modelDisplayName: "Model",
  resolution: "profile_default" as const,
  modelRuntimeRevision: "runtime-1",
};
const usage = createEmptySessionStats().usage;

beforeEach(async () => {
  await mkdir(TMP_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

describe("Session Store logical Execution hard cut", () => {
  test("rejects invalid transitions and drops exact duplicate lifecycle events", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, TMP_DIR, { source: { kind: "direct" }, agentName: "lead" });
    const start = {
      type: "execution-start" as const,
      executionId: "execution-1",
      origin: "user_message" as const,
      maxSteps: 50,
      binding,
      executionSkills: [],
      memoryPolicy: testExecutionMemoryPolicy,
      toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
      loadedToolRefs: testExecutionLoadedToolRefs,
    };

    store.getState().append(start);
    const eventCount = store.getState().events.length;
    store.getState().append(start);
    expect(store.getState().events).toHaveLength(eventCount);

    expect(() => store.getState().append({ ...start, maxSteps: 10 }))
      .toThrow(InvalidExecutionTransitionError);
    expect(store.getState().events).toHaveLength(eventCount);
    await manager.flushSession(sessionId, TMP_DIR);
  });

  test("reloads suspended live fields without terminal cleanup or lifecycle repair", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, TMP_DIR, { source: { kind: "direct" }, agentName: "lead" });
    store.getState().append({
      type: "execution-start",
      executionId: "execution-2",
      origin: "user_message",
      maxSteps: 50,
      binding,
      executionSkills: [],
      memoryPolicy: testExecutionMemoryPolicy,
      toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
      loadedToolRefs: testExecutionLoadedToolRefs,
    });
    store.getState().append({ type: "step-start", stepId: "step-0", step: 0 });
    store.getState().append({
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "ask_user",
      input: {},
    });
    const assistantMessageId = store.getState().currentAssistantMessageId!;
    await manager.updateToolBatches(sessionId, TMP_DIR, () => [{
      batchId: "batch-1",
      executionId: "execution-2",
      assistantMessageId,
      stepId: "step-0",
      step: 0,
      runOrdinal: 0,
      agentName: "lead",
      allowedTools: ["ask_user"],
      agentSkills: [],
      partitions: [{ type: "serial", callIds: ["call-1"] }],
      calls: [{
        ordinal: 0,
        partitionIndex: 0,
        toolCallId: "call-1",
        toolName: "ask_user",
        input: {},
        traits: { readOnly: true, destructive: false, concurrencySafe: false },
        state: "blocked",
        attempt: 1,
        checkpointAt: Date.parse("2026-07-28T00:00:00.000Z"),
        blocker: {
          requestKey: "request-1",
          hitlId: "hitl-1",
          source: { type: "ask_user", toolCallId: "call-1" },
          displayPayload: { title: "Question", redacted: true },
        },
      }],
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    }]);
    const run = store.getState().executions[0]!.runs[0]!;
    const runEndedAt = Math.max(Date.now(), run.startedAt);
    store.getState().append({
      type: "execution-suspended",
      executionId: "execution-2",
      suspension: { kind: "hitl", toolBatchId: "batch-1", blockerIds: ["hitl-1"] },
      runEndedAt,
      runUsageDelta: usage,
      runSettlement: {
        key: `run:${sessionId}:execution-2:0`,
        goalInstanceId: null,
      },
    });
    await manager.flushSession(sessionId, TMP_DIR);

    const restarted = new SessionStoreManager({ logger: silentLogger });
    const snapshot = await restarted.getSessionReadSnapshot(TMP_DIR, sessionId);
    expect(snapshot.liveState).toEqual({
      executionCount: 1,
      isRunning: false,
      isStreamingModel: false,
      currentExecutionId: "execution-2",
      currentAssistantMessageId: assistantMessageId,
    });
    expect(snapshot.file.executions[0]).toMatchObject({
      status: "suspended",
      suspension: { kind: "hitl", blockerIds: ["hitl-1"] },
    });
    expect(snapshot.file.messages[0]).toMatchObject({
      id: assistantMessageId,
      parts: [{ type: "tool", state: "running", toolCallId: "call-1" }],
    });
    expect(snapshot.file.messages[0]?.completedAt).toBeUndefined();
  });

  test("lists and idempotently marks run and terminal settlements", async () => {
    const manager = new SessionStoreManager({ logger: silentLogger });
    const sessionId = crypto.randomUUID();
    const store = manager.create(sessionId, TMP_DIR, { source: { kind: "direct" }, agentName: "lead" });
    store.getState().append({
      type: "execution-start",
      executionId: "execution-3",
      origin: "user_message",
      maxSteps: 50,
      binding,
      executionSkills: [],
      memoryPolicy: testExecutionMemoryPolicy,
      toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
      loadedToolRefs: testExecutionLoadedToolRefs,
    });
    const run = store.getState().executions[0]!.runs[0]!;
    const runEndedAt = Math.max(Date.now(), run.startedAt);
    store.getState().append({
      type: "execution-suspended",
      executionId: "execution-3",
      suspension: {
        kind: "child_dependency",
        toolBatchId: "batch-3",
        toolCallId: "call-3",
        childSessionId: "child-3",
        childExecutionId: "child-execution-3",
      },
      runEndedAt,
      runUsageDelta: usage,
      runSettlement: { key: `run:${sessionId}:execution-3:0`, goalInstanceId: null },
    });
    store.getState().append({
      type: "execution-end",
      executionId: "execution-3",
      terminalStatus: "cancelled",
      endedAt: runEndedAt + 1,
      terminalSettlement: { key: `terminal:${sessionId}:execution-3`, goalInstanceId: null },
    });
    await manager.flushSession(sessionId, TMP_DIR);

    expect(await manager.listUnappliedExecutionSettlements(TMP_DIR)).toHaveLength(2);
    await manager.markExecutionSettlementApplied(sessionId, TMP_DIR, {
      executionId: "execution-3",
      runOrdinal: 0,
      expectedKey: `run:${sessionId}:execution-3:0`,
    });
    await manager.markExecutionSettlementApplied(sessionId, TMP_DIR, {
      executionId: "execution-3",
      runOrdinal: 0,
      expectedKey: `run:${sessionId}:execution-3:0`,
    });
    await manager.markExecutionSettlementApplied(sessionId, TMP_DIR, {
      executionId: "execution-3",
      terminal: true,
      expectedKey: `terminal:${sessionId}:execution-3`,
    });
    expect(await manager.listUnappliedExecutionSettlements(TMP_DIR)).toEqual([]);
  });
});
