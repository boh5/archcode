import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { silentLogger } from "../logger";
import { sessionFileInternals } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionInputConflictError, SessionInputService } from "./service";

const WORKSPACE = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const ROOT_SESSION_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_SESSION_ID = "00000000-0000-4000-8000-000000000002";
const REQUESTED_MODEL_SELECTION = { mode: "profile_default" as const, selection: { model: "test:model" } };
const BINDING = {
  selection: { model: "test:model" }, providerId: "test", modelId: "model",
  providerDisplayName: "Test", modelDisplayName: "Model",
  resolution: "profile_default" as const, modelRuntimeRevision: "runtime-1",
};
const MODEL_AUDIT = { requested: REQUESTED_MODEL_SELECTION, actual: BINDING.selection };

function controlNextSessionSave(failure?: Error) {
  const originalSave = sessionFileInternals.saveSessionTranscript;
  let releaseSave!: () => void;
  const saveReleased = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  let markSaveStarted!: () => void;
  const saveStarted = new Promise<void>((resolve) => {
    markSaveStarted = resolve;
  });
  let saveCount = 0;
  const persistedUpdatedAts: number[] = [];
  sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
    saveCount += 1;
    persistedUpdatedAts.push(state.updatedAt);
    markSaveStarted();
    await saveReleased;
    if (failure !== undefined) throw failure;
    await originalSave(state, workspaceRoot);
  };
  return {
    saveStarted,
    persistedUpdatedAts,
    get saveCount() {
      return saveCount;
    },
    release() {
      releaseSave();
    },
    restore() {
      releaseSave();
      sessionFileInternals.saveSessionTranscript = originalSave;
    },
  };
}

async function observeConcurrentReplay<T>(
  manager: SessionStoreManager,
  invoke: () => Promise<T>,
  failure?: Error,
): Promise<PromiseSettledResult<T>[]> {
  const beforeUpdatedAt = manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().updatedAt;
  const controlledSave = controlNextSessionSave(failure);
  try {
    const first = invoke();
    await controlledSave.saveStarted;
    const advancedUpdatedAt = manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().updatedAt;
    let replaySettled = false;
    const replay = invoke().finally(() => {
      replaySettled = true;
    });
    await Promise.resolve();

    expect(replaySettled).toBe(false);
    expect(advancedUpdatedAt).toBeGreaterThan(beforeUpdatedAt);
    controlledSave.release();
    const results = await Promise.allSettled([first, replay]);

    expect(controlledSave.saveCount).toBe(1);
    expect(controlledSave.persistedUpdatedAts).toEqual([advancedUpdatedAt]);
    expect(manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().updatedAt).toBe(advancedUpdatedAt);
    expect(manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().inputRequestReceipts)
      .toHaveLength(1);
    return results;
  } finally {
    controlledSave.restore();
  }
}

describe("SessionInputService", () => {
  let manager: SessionStoreManager;
  let service: SessionInputService;

  beforeEach(async () => {
    await mkdir(WORKSPACE, { recursive: true });
    manager = new SessionStoreManager({ logger: silentLogger });
    service = new SessionInputService(manager);
    await manager.createSessionFile(WORKSPACE, { agentName: "lead" }, ROOT_SESSION_ID);
  });

  afterEach(async () => {
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test("accepts FIFO input durably and retries by clientRequestId without duplication", async () => {
    const first = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "B",
      clientRequestId: "request-b",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    const retry = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "B",
      clientRequestId: "request-b",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "C",
      clientRequestId: "request-c",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });

    expect(retry).toEqual(first);
    expect((await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID)).pendingMessages.map((message) => message.content))
      .toEqual(["B", "C"]);
  });

  test("concurrent acceptMessage replay waits for and shares the first durable acceptance", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "durable concurrent message",
      clientRequestId: "concurrent-message",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    const results = await observeConcurrentReplay(manager, () => service.acceptMessage(input));

    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toEqual(results[0]);
  });

  test("concurrent acceptMessage replay shares an observed first-save failure", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "failing concurrent message",
      clientRequestId: "failing-message",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    const failure = new Error("simulated message persistence failure");
    expect(await observeConcurrentReplay(manager, () => service.acceptMessage(input), failure))
      .toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
  });

  test("claims command requests before side effects and replays the durable result", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/compact",
      clientRequestId: "command-request",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };

    expect(await service.getCommandReplay(input)).toBeUndefined();
    expect(await service.claimCommand(input)).toEqual({ kind: "claimed" });
    expect(await service.claimCommand(input)).toEqual({
      kind: "command",
      clientRequestId: "command-request",
      status: "executing",
    });
    await service.completeCommand(input);
    expect(await service.getCommandReplay(input)).toEqual({
      kind: "command",
      clientRequestId: "command-request",
      status: "completed",
    });
    expect((await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID)).inputRequestReceipts)
      .toEqual([expect.objectContaining({
        kind: "command",
        clientRequestId: "command-request",
        status: "completed",
      })]);
  });

  test("concurrent claimCommand replay waits for the first durable ownership receipt", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/compact",
      clientRequestId: "concurrent-command",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    expect(await observeConcurrentReplay(manager, () => service.claimCommand(input))).toEqual([
      { status: "fulfilled", value: { kind: "claimed" } },
      {
        status: "fulfilled",
        value: {
          kind: "command",
          clientRequestId: "concurrent-command",
          status: "executing",
        },
      },
    ]);
    expect(await service.getCommandReplay(input)).toEqual({
      kind: "command",
      clientRequestId: "concurrent-command",
      status: "executing",
    });
  });

  test("concurrent claimCommand replay shares an observed first-save failure", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/compact",
      clientRequestId: "failing-command",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    const failure = new Error("simulated command persistence failure");
    expect(await observeConcurrentReplay(manager, () => service.claimCommand(input), failure))
      .toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
  });

  test("repeating the same Queue dispatch barrier is a durable no-op", async () => {
    const originalSave = sessionFileInternals.saveSessionTranscript;
    let saveCount = 0;
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      saveCount += 1;
      await originalSave(state, workspaceRoot);
    };

    try {
      await service.recordQueueDispatchBarrier({
        sessionId: ROOT_SESSION_ID,
        workspaceRoot: WORKSPACE,
        timestamp: 1234,
      });
      const afterFirst = manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().updatedAt;
      await service.recordQueueDispatchBarrier({
        sessionId: ROOT_SESSION_ID,
        workspaceRoot: WORKSPACE,
        timestamp: 1234,
      });

      expect(saveCount).toBe(1);
      expect(manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().updatedAt).toBe(afterFirst);
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("converts a command continuation into one pending message receipt atomically", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/skill use test inspect",
      clientRequestId: "skill-command-request",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    await service.claimCommand(input);
    const accepted = await service.completeCommandAsMessage({
      ...input,
      text: "Use Skill test and inspect",
    });

    expect(await service.getCommandReplay(input)).toEqual({
      kind: "message",
      acceptance: accepted,
    });
    const file = await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID);
    expect(file.pendingMessages).toEqual([
      expect.objectContaining({ id: accepted.messageId, content: "Use Skill test and inspect" }),
    ]);
    expect(file.inputRequestReceipts).toEqual([
      expect.objectContaining({
        kind: "message",
        clientRequestId: "skill-command-request",
        messageId: accepted.messageId,
        status: "pending",
      }),
    ]);
  });

  test("rejects reuse of a clientRequestId for different input", async () => {
    await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "B",
      clientRequestId: "same-request",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });

    await expect(service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "different",
      clientRequestId: "same-request",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    })).rejects.toMatchObject({ reason: "idempotency" });
  });

  test("stores only a fixed-size digest for idempotency after message deletion", async () => {
    const content = "private queue body that must not survive in a receipt";
    const accepted = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: content,
      clientRequestId: "digest-only-request",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    const acceptedFile = await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID);
    const acceptedReceipt = acceptedFile.inputRequestReceipts[0];

    expect(acceptedReceipt?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(acceptedReceipt)).not.toContain(content);

    await service.deleteMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
    });
    const deletedFile = await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID);
    expect(deletedFile.pendingMessages).toEqual([]);
    expect(JSON.stringify(deletedFile.inputRequestReceipts)).not.toContain(content);
  });

  test("uses revision CAS for edit and delete", async () => {
    const accepted = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "before",
      clientRequestId: "request-edit",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    const edited = await service.editMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
      text: "after",
    });
    expect(edited).toMatchObject({ content: "after", revision: 1 });

    await expect(service.deleteMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
    })).rejects.toMatchObject({
      reason: "revision",
      current: {
        messageId: accepted.messageId,
        clientRequestId: "request-edit",
        status: "queued",
        revision: 1,
        content: "after",
      },
    });

    await service.deleteMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 1,
    });
    const file = await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID);
    expect(file.pendingMessages).toEqual([]);
    expect(file.inputRequestReceipts).toEqual([
      expect.objectContaining({ clientRequestId: "request-edit", status: "deleted" }),
    ]);
    await expect(service.deleteMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 1,
    })).rejects.toMatchObject({
      reason: "state",
      current: {
        messageId: accepted.messageId,
        clientRequestId: "request-edit",
        status: "deleted",
      },
    });
  });

  test("moves all queued messages in one cutoff into one execution without joining bodies", async () => {
    await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "B", clientRequestId: "b", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "C", clientRequestId: "c", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    const pending = await service.getPendingMessages(ROOT_SESSION_ID, WORKSPACE);

    const batch = await service.beginQueueExecution({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-bc",
      runOrdinal: 0,
      snapshots: pending.map((message) => ({ pending: message, modelAudit: MODEL_AUDIT })),
      binding: BINDING,
      origin: "user_message",
    });

    expect(batch.messages).toHaveLength(2);
    expect(batch.messages.map((message) => message.executionId)).toEqual(["execution-bc", "execution-bc"]);
    expect(batch.messages.map((message) => message.parts[0])).toMatchObject([
      { type: "text", text: "B" },
      { type: "text", text: "C" },
    ]);
    const file = await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID);
    expect(file.pendingMessages).toEqual([]);
    expect(file.messages.map((message) => message.clientRequestId)).toEqual(["b", "c"]);
    expect(file.executions).toEqual([]);

    await expect(service.editMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: batch.messages[0]!.id,
      expectedRevision: 0,
      text: "too late",
    })).rejects.toMatchObject({
      reason: "state",
      current: {
        messageId: batch.messages[0]!.id,
        clientRequestId: "b",
        status: "canonical",
        content: "B",
        executionId: "execution-bc",
      },
    });
  });

  test("commits a claimed Steer from its full snapshot and leaves other Queue input untouched", async () => {
    const acceptedB = await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "B", clientRequestId: "b", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "C", clientRequestId: "c", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    const claimed = await service.claimSteer({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: acceptedB.messageId,
      expectedRevision: 0,
      expectedExecutionId: "execution-a",
      runOrdinal: 0,
      modelAudit: MODEL_AUDIT,
    });

    const committed = await service.commitSteers({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-a",
      runOrdinal: 0,
      snapshots: [{ pending: claimed, modelAudit: MODEL_AUDIT }],
      binding: BINDING,
    });

    expect(committed).toEqual([expect.objectContaining({ id: acceptedB.messageId, executionId: "execution-a" })]);
    expect((await service.getPendingMessages(ROOT_SESSION_ID, WORKSPACE)).map((message) => message.content)).toEqual(["C"]);
  });

  test("does not expose a synthetic clientRequestId for direct child input", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: ROOT_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
    }, CHILD_SESSION_ID);

    const message = await service.beginDirectExecution({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-child",
      runOrdinal: 0,
      text: "direct child input",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
      modelAudit: MODEL_AUDIT,
      binding: BINDING,
      origin: "tool_call",
    });

    expect(message.clientRequestId).toBeUndefined();
    const file = await manager.getSessionFile(WORKSPACE, CHILD_SESSION_ID);
    expect(file.messages[0]?.clientRequestId).toBeUndefined();
    expect(file.inputRequestReceipts).toEqual([]);
  });

  test("rolls an exact steering claim back to queued with a new revision", async () => {
    const accepted = await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "B", clientRequestId: "b", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    await service.claimSteer({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
      expectedExecutionId: "execution-a",
      runOrdinal: 0,
      modelAudit: MODEL_AUDIT,
    });

    const recovered = await service.rollbackSteers({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-a",
      messageIds: [accepted.messageId],
    });
    expect(recovered).toEqual([expect.objectContaining({ state: "queued", revision: 2 })]);
    expect(recovered[0]!.targetExecutionId).toBeUndefined();
  });

  test("rejects public Queue admission on a child Session", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: ROOT_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
    }, CHILD_SESSION_ID);

    try {
      await service.acceptMessage({
        sessionId: CHILD_SESSION_ID,
        workspaceRoot: WORKSPACE,
        text: "not allowed",
        clientRequestId: "child-request",
        source: "user",
        requestedModelSelection: REQUESTED_MODEL_SELECTION,
      });
      throw new Error("Expected acceptMessage to reject child Queue admission");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionInputConflictError);
      expect(error).toMatchObject({ reason: "not_root" });
    }
  });
});
