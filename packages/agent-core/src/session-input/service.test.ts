import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AttachmentDescriptor } from "@archcode/protocol";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { silentLogger } from "../logger";
import { sessionFileInternals } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionInputConflictError, SessionInputService } from "./service";
import {
  testExecutionEnd,
  testExecutionLoadedToolRefs,
  testExecutionMemoryPolicy,
  testExecutionStart,
  testExecutionToolAuthorizationSnapshot,
} from "../testing/test-execution-fixtures";

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
const executionStart = (executionId: string, origin: "user_message" | "tool_call") => ({
  type: "execution-start" as const,
  executionId,
  binding: BINDING,
  memoryPolicy: testExecutionMemoryPolicy,
  origin,
  maxSteps: 50,
  executionSkills: [],
  toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
  loadedToolRefs: testExecutionLoadedToolRefs,
});
const ATTACHMENT_A: AttachmentDescriptor = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "alpha<&>.png",
  mediaType: "image/png",
  sizeBytes: 8,
  kind: "image",
};
const ATTACHMENT_B: AttachmentDescriptor = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "notes.txt",
  mediaType: "text/plain",
  sizeBytes: 12,
  kind: "file",
};

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
  const resolveDescriptors = mock(async (input: { attachmentIds: readonly string[] }) => (
    input.attachmentIds.map((id) => {
      const descriptor = [ATTACHMENT_A, ATTACHMENT_B].find((candidate) => candidate.id === id);
      if (descriptor === undefined) throw new Error(`Missing attachment ${id}`);
      return descriptor;
    })
  ));

  beforeEach(async () => {
    await mkdir(WORKSPACE, { recursive: true });
    manager = new SessionStoreManager({ logger: silentLogger });
    resolveDescriptors.mockClear();
    service = new SessionInputService(manager, { resolveDescriptors });
    await manager.createSessionFile(WORKSPACE, { source: { kind: "direct" }, agentName: "lead" }, ROOT_SESSION_ID);
  });

  afterEach(async () => {
    await rm(WORKSPACE, { recursive: true, force: true });
  });

  test("accepts FIFO input durably and retries by clientRequestId without duplication", async () => {
    const first = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "B",
      attachmentIds: [],
      clientRequestId: "request-b",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    const retry = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "B",
      attachmentIds: [],
      clientRequestId: "request-b",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "C",
      attachmentIds: [],
      clientRequestId: "request-c",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });

    expect(retry).toEqual(first);
    expect((await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID)).pendingMessages.map((message) => message.content))
      .toEqual(["B", "C"]);
  });

  test("owns the durable message receipt lookup used by composed commands", async () => {
    expect(await service.hasDurableMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      clientRequestId: "durable-message",
    })).toBe(false);
    await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "Persist this input",
      attachmentIds: [],
      clientRequestId: "durable-message",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    expect(await service.hasDurableMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      clientRequestId: "durable-message",
    })).toBe(true);
  });

  test("concurrent acceptMessage replay waits for and shares the first durable acceptance", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "durable concurrent message",
      attachmentIds: [],
      clientRequestId: "concurrent-message",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
      executionSkillNames: [],
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
      attachmentIds: [],
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

  test("persists ordered attachment-only input through edit, Steer rollback, and Queue commit", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "",
      attachmentIds: [ATTACHMENT_A.id, ATTACHMENT_B.id],
      clientRequestId: "attachment-only",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    const accepted = await service.acceptMessage(input);
    expect(accepted.message).toMatchObject({
      content: "",
      attachments: [ATTACHMENT_A, ATTACHMENT_B],
    });
    expect(await service.acceptMessage(input)).toEqual(accepted);
    expect(resolveDescriptors).toHaveBeenCalledTimes(1);

    await expect(service.acceptMessage({
      ...input,
      attachmentIds: [ATTACHMENT_B.id, ATTACHMENT_A.id],
    })).rejects.toMatchObject({ reason: "idempotency" });

    const edited = await service.editMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
      text: "",
    });
    expect(edited.attachments).toEqual([ATTACHMENT_A, ATTACHMENT_B]);
    const steering = await service.claimSteer({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 1,
      expectedExecutionId: "execution-a",
      runOrdinal: 0,
      modelAudit: MODEL_AUDIT,
    });
    expect(steering.attachments).toEqual([ATTACHMENT_A, ATTACHMENT_B]);
    const [rolledBack] = await service.rollbackSteers({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-a",
    });
    expect(rolledBack?.attachments).toEqual([ATTACHMENT_A, ATTACHMENT_B]);

    manager.get(ROOT_SESSION_ID, WORKSPACE)!.getState().append({
      type: "execution-start",
      executionId: "execution-attachments",
      binding: BINDING,
      memoryPolicy: testExecutionMemoryPolicy,
      origin: "user_message",
      maxSteps: 50,
      executionSkills: [],
      toolAuthorizationSnapshot: testExecutionToolAuthorizationSnapshot,
      loadedToolRefs: testExecutionLoadedToolRefs,
    });
    const batch = await service.beginQueueExecution({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "execution-attachments",
      runOrdinal: 0,
      snapshots: [{ pending: rolledBack!, modelAudit: MODEL_AUDIT }],
      binding: BINDING,
      origin: "user_message",
    });
    expect(batch.messages[0]?.parts).toEqual([
      expect.objectContaining({ type: "text", text: "" }),
      expect.objectContaining({ type: "attachment", attachment: ATTACHMENT_A }),
      expect.objectContaining({ type: "attachment", attachment: ATTACHMENT_B }),
    ]);

    manager.delete(ROOT_SESSION_ID, WORKSPACE);
    expect((await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID)).messages[0]?.parts)
      .toEqual(batch.messages[0]?.parts);
  });

  test("rejects editing a text-only queued message to empty with a domain conflict", async () => {
    const accepted = await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "required text",
      attachmentIds: [],
      clientRequestId: "text-only-edit",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });

    await expect(service.editMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      messageId: accepted.messageId,
      expectedRevision: 0,
      text: "",
    })).rejects.toMatchObject({
      reason: "state",
      current: { messageId: accepted.messageId, content: "required text" },
    });
  });

  test("rejects empty, duplicate, and oversized attachment reference lists before resolution", async () => {
    const base = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "",
      clientRequestId: "invalid-attachments",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };
    await expect(service.acceptMessage({ ...base, attachmentIds: [] })).rejects.toBeInstanceOf(TypeError);
    await expect(service.acceptMessage({
      ...base,
      attachmentIds: [ATTACHMENT_A.id, ATTACHMENT_A.id],
    })).rejects.toBeInstanceOf(TypeError);
    await expect(service.acceptMessage({
      ...base,
      attachmentIds: Array.from({ length: 11 }, (_, index) =>
        `${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
    })).rejects.toBeInstanceOf(TypeError);
    expect(resolveDescriptors).not.toHaveBeenCalled();
  });

  test("accepts exactly ten ordered attachment references in one durable message", async () => {
    const attachmentIds = Array.from(
      { length: 10 },
      (_, index) => `${index.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    );
    resolveDescriptors.mockImplementationOnce(async ({ attachmentIds: ids }) =>
      ids.map((id, index) => ({
        id,
        name: `attachment-${index}.bin`,
        mediaType: "application/octet-stream",
        sizeBytes: index,
        kind: "file" as const,
      })));

    await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "",
      attachmentIds,
      clientRequestId: "ten-attachments",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });

    expect((await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID)).pendingMessages[0]
      ?.attachments.map(({ id }) => id)).toEqual(attachmentIds);
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
      executionSkillNames: [],
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

  test("atomically accepts and exactly replays normalized Skill activation without an executing receipt", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/skill   use   test   inspect",
      clientRequestId: "atomic-skill-command",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
      activation: { skillName: "test", content: "inspect" },
    };
    const originalSave = sessionFileInternals.saveSessionTranscript;
    const persistedReceiptStates: Array<Array<{ kind: string; status: string }>> = [];
    sessionFileInternals.saveSessionTranscript = async (state, workspaceRoot) => {
      persistedReceiptStates.push(state.inputRequestReceipts.map(({ kind, status }) => ({ kind, status })));
      await originalSave(state, workspaceRoot);
    };

    try {
      const accepted = await service.acceptSkillCommandMessage(input);
      const normalizedReplay = { ...input, text: "/skill use test inspect" };
      expect(await service.getSkillCommandReplay(normalizedReplay)).toEqual({
        kind: "message",
        acceptance: accepted,
      });
      expect(await service.acceptSkillCommandMessage(normalizedReplay)).toEqual(accepted);
      expect(persistedReceiptStates).toEqual([[{ kind: "message", status: "pending" }]]);

      const file = await manager.getSessionFile(WORKSPACE, ROOT_SESSION_ID);
      expect(file.pendingMessages).toEqual([
        expect.objectContaining({
          id: accepted.messageId,
          content: "inspect",
          executionSkillNames: ["test"],
        }),
      ]);
      expect(file.inputRequestReceipts).toEqual([
        expect.objectContaining({
          kind: "message",
          clientRequestId: input.clientRequestId,
          messageId: accepted.messageId,
          status: "pending",
        }),
      ]);
      expect(file.inputRequestReceipts.some((receipt) => (
        receipt.kind === "command" && receipt.status === "executing"
      ))).toBeFalse();
    } finally {
      sessionFileInternals.saveSessionTranscript = originalSave;
    }
  });

  test("binds Skill command replay to the immutable normalized activation", async () => {
    const input = {
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "/skill use test inspect",
      clientRequestId: "skill-activation-fingerprint",
      source: "user" as const,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
      activation: { skillName: "test", content: "inspect" },
    };
    await service.acceptSkillCommandMessage(input);

    await expect(service.getSkillCommandReplay({
      ...input,
      activation: { ...input.activation, skillName: "other" },
    })).rejects.toMatchObject({ reason: "idempotency" });
    await expect(service.acceptSkillCommandMessage({
      ...input,
      activation: { ...input.activation, content: "different" },
    })).rejects.toMatchObject({ reason: "idempotency" });
  });

  test("rejects reuse of a clientRequestId for different input", async () => {
    await service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "B",
      attachmentIds: [],
      clientRequestId: "same-request",
      source: "user",
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });

    await expect(service.acceptMessage({
      sessionId: ROOT_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "different",
      attachmentIds: [],
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
      attachmentIds: [],
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
      attachmentIds: [],
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
    await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "B", attachmentIds: [], clientRequestId: "b", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "C", attachmentIds: [], clientRequestId: "c", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
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
    const acceptedB = await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "B", attachmentIds: [], clientRequestId: "b", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
    await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "C", attachmentIds: [], clientRequestId: "c", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
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
    const accepted = await service.acceptMessage({ sessionId: ROOT_SESSION_ID, workspaceRoot: WORKSPACE, text: "B", attachmentIds: [], clientRequestId: "b", source: "user", requestedModelSelection: REQUESTED_MODEL_SELECTION });
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
      attachmentIds: [],
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

  test("accepts a direct-parent message idempotently and preserves provenance in canonical history", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: ROOT_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
    }, CHILD_SESSION_ID);
    const provenance = {
      senderSessionId: ROOT_SESSION_ID,
      senderAgentName: "lead",
      senderExecutionId: "parent-execution",
      senderRunOrdinal: 2,
      senderToolBatchId: "parent-batch",
      senderToolCallId: "parent-call",
    };
    const input = {
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "inspect the failing branch",
      clientRequestId: "parent-message-1",
      expectedExecutionId: "child-execution",
      delivery: "queue" as const,
      provenance,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    };

    const accepted = await service.acceptParentAgentMessage(input);
    expect(await service.getParentAgentMessageReplay(input)).toEqual(accepted);
    const replay = await service.acceptParentAgentMessage(input);
    expect(replay).toEqual(accepted);
    const queued = await service.getPendingMessages(CHILD_SESSION_ID, WORKSPACE);
    expect(queued).toEqual([expect.objectContaining({
      source: "parent_agent",
      parentAgentProvenance: provenance,
    })]);

    await service.beginQueueExecution({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "child-execution-2",
      runOrdinal: 0,
      snapshots: [{ pending: queued[0]!, modelAudit: MODEL_AUDIT }],
      binding: BINDING,
      origin: "tool_call",
      executionStart: executionStart("child-execution-2", "tool_call"),
    });
    const file = await manager.getSessionFile(WORKSPACE, CHILD_SESSION_ID);
    expect(file.messages[0]).toMatchObject({
      inputSource: "parent_agent",
      parentAgentProvenance: provenance,
      executionId: "child-execution-2",
    });
    expect(await service.getParentAgentMessageReplay(input)).toMatchObject({
      clientRequestId: input.clientRequestId,
      messageId: accepted.messageId,
      status: "canonical",
    });
  });

  test("atomically commits preserved Queue input before one parent resume instruction and clears its barrier", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: ROOT_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
    }, CHILD_SESSION_ID);
    const provenance = {
      senderSessionId: ROOT_SESSION_ID,
      senderAgentName: "lead",
      senderExecutionId: "parent-execution",
      senderRunOrdinal: 0,
      senderToolBatchId: "resume-batch",
      senderToolCallId: "resume-call",
    };
    const accepted = await service.acceptParentAgentMessage({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "queued before cancellation",
      clientRequestId: "queued-before-resume",
      expectedExecutionId: "stopped-execution",
      delivery: "queue",
      provenance: { ...provenance, senderToolCallId: "send-call" },
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    await service.recordQueueDispatchBarrier({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      timestamp: Date.now() + 100,
    });
    const queued = await service.getPendingMessages(CHILD_SESSION_ID, WORKSPACE);

    const result = await service.beginChildResumeExecution({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "resumed-execution",
      runOrdinal: 0,
      snapshots: [{ pending: queued[0]!, modelAudit: MODEL_AUDIT }],
      binding: BINDING,
      instruction: "resume after the queued correction",
      clientRequestId: "resume-instruction",
      provenance,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
      modelAudit: MODEL_AUDIT,
      executionStart: executionStart("resumed-execution", "tool_call"),
    });

    expect(result.messages.map((message) => message.parts[0])).toMatchObject([
      { type: "text", text: "queued before cancellation" },
      { type: "text", text: "resume after the queued correction" },
    ]);
    expect(result.pendingMessages[0]?.id).toBe(accepted.messageId);
    const file = await manager.getSessionFile(WORKSPACE, CHILD_SESSION_ID);
    expect(file.pendingMessages).toEqual([]);
    expect(file.queueDispatchBarrierAt).toBeUndefined();
    expect(file.inputRequestReceipts.map((receipt) => receipt.status)).toEqual(["canonical", "canonical"]);
    expect(file.executions).toEqual([
      expect.objectContaining({ id: "resumed-execution", status: "running" }),
    ]);
    expect(file.messages.map((message) => message.executionId)).toEqual([
      "resumed-execution",
      "resumed-execution",
    ]);
  });

  test("persists either the old child state or the complete resume execution and input claim", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: ROOT_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      title: "Atomic resume child",
      activeSkillNames: [],
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Atomic resume child",
        objective: "Verify atomic child resume persistence.",
        skills: [],
        background: false,
      },
    }, CHILD_SESSION_ID);
    const provenance = {
      senderSessionId: ROOT_SESSION_ID,
      senderAgentName: "lead",
      senderExecutionId: "parent-execution",
      senderRunOrdinal: 0,
      senderToolBatchId: "resume-batch",
      senderToolCallId: "resume-call",
    };
    await service.acceptParentAgentMessage({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "preserved queue input",
      clientRequestId: "preserved-before-fault",
      expectedExecutionId: "old-execution",
      delivery: "queue",
      provenance: { ...provenance, senderToolCallId: "send-call" },
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    const queued = await service.getPendingMessages(CHILD_SESSION_ID, WORKSPACE);
    const controlledSave = controlNextSessionSave(new Error("resume checkpoint failed"));
    try {
      const starting = service.beginChildResumeExecution({
        sessionId: CHILD_SESSION_ID,
        workspaceRoot: WORKSPACE,
        executionId: "atomic-resume-execution",
        runOrdinal: 0,
        snapshots: [{ pending: queued[0]!, modelAudit: MODEL_AUDIT }],
        binding: BINDING,
        instruction: "resume atomically",
        clientRequestId: "atomic-resume-instruction",
        provenance,
        requestedModelSelection: REQUESTED_MODEL_SELECTION,
        modelAudit: MODEL_AUDIT,
        executionStart: executionStart("atomic-resume-execution", "tool_call"),
      });
      const startOutcome = starting.then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const first = await Promise.race([
        controlledSave.saveStarted.then(() => ({ kind: "saving" as const })),
        startOutcome,
      ]);
      if (first.kind !== "saving") throw first.kind === "failed" ? first.error : new Error("Resume save did not start");

      const warm = manager.get(CHILD_SESSION_ID, WORKSPACE)!.getState();
      expect(warm.executions.at(-1)).toMatchObject({ id: "atomic-resume-execution", status: "running" });
      expect(warm.pendingMessages).toEqual([]);
      expect(warm.messages).toHaveLength(2);

      const durableOld = await sessionFileInternals.readSessionFile(CHILD_SESSION_ID, WORKSPACE);
      expect(durableOld.executions).toEqual([]);
      expect(durableOld.pendingMessages).toHaveLength(1);
      expect(durableOld.messages).toEqual([]);

      controlledSave.release();
      expect(await startOutcome).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: "resume checkpoint failed" }),
      });
      const durableAfterFailure = await sessionFileInternals.readSessionFile(CHILD_SESSION_ID, WORKSPACE);
      expect(durableAfterFailure.executions).toEqual([]);
      expect(durableAfterFailure.pendingMessages).toHaveLength(1);
      expect(durableAfterFailure.messages).toEqual([]);
      expect(durableAfterFailure.inputRequestReceipts.some((receipt) => (
        receipt.clientRequestId === "atomic-resume-instruction"
      ))).toBe(false);
    } finally {
      controlledSave.restore();
    }
  });

  test("restarts a failed atomic child Queue claim from the old durable state exactly once", async () => {
    await manager.createSessionFile(WORKSPACE, {
      agentName: "explore",
      rootSessionId: ROOT_SESSION_ID,
      parentSessionId: ROOT_SESSION_ID,
      title: "Atomic Queue child",
      activeSkillNames: [],
      delegationRequest: {
        agent_type: "explore",
        profile: "fast",
        title: "Atomic Queue child",
        objective: "Verify atomic child Queue persistence.",
        skills: [],
        background: false,
      },
    }, CHILD_SESSION_ID);
    const child = manager.get(CHILD_SESSION_ID, WORKSPACE)!;
    child.getState().append(testExecutionStart("previous-child-execution"));
    const endedAt = Date.now() + 1;
    child.getState().append(testExecutionEnd("previous-child-execution", "completed", {
      endedAt,
      runEndedAt: endedAt,
      runSettlement: {
        key: `run:${CHILD_SESSION_ID}:previous-child-execution:0`,
        goalInstanceId: null,
      },
      terminalSettlement: {
        key: `terminal:${CHILD_SESSION_ID}:previous-child-execution`,
        goalInstanceId: null,
      },
    }));
    await manager.flushSession(CHILD_SESSION_ID, WORKSPACE);
    const provenance = {
      senderSessionId: ROOT_SESSION_ID,
      senderAgentName: "lead",
      senderExecutionId: "parent-execution",
      senderRunOrdinal: 0,
      senderToolBatchId: "queue-batch",
      senderToolCallId: "queue-call",
    };
    await service.acceptParentAgentMessage({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      text: "retry this Queue prefix",
      clientRequestId: "atomic-queue-message",
      expectedExecutionId: "previous-child-execution",
      delivery: "queue",
      provenance,
      requestedModelSelection: REQUESTED_MODEL_SELECTION,
    });
    const queued = await service.getPendingMessages(CHILD_SESSION_ID, WORKSPACE);
    const controlledSave = controlNextSessionSave(new Error("queue checkpoint failed"));
    try {
      const first = service.beginQueueExecution({
        sessionId: CHILD_SESSION_ID,
        workspaceRoot: WORKSPACE,
        executionId: "failed-queue-execution",
        runOrdinal: 0,
        snapshots: [{ pending: queued[0]!, modelAudit: MODEL_AUDIT }],
        binding: BINDING,
        origin: "tool_call",
        executionStart: executionStart("failed-queue-execution", "tool_call"),
      });
      const firstOutcome = first.then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      );
      const entered = await Promise.race([
        controlledSave.saveStarted.then(() => true),
        firstOutcome.then((outcome) => { throw outcome.kind === "failed" ? outcome.error : new Error("Queue save did not start"); }),
      ]);
      expect(entered).toBe(true);
      const durableOld = await sessionFileInternals.readSessionFile(CHILD_SESSION_ID, WORKSPACE);
      expect(durableOld.executions.map((execution) => execution.id)).toEqual(["previous-child-execution"]);
      expect(durableOld.pendingMessages).toHaveLength(1);
      expect(durableOld.messages).toEqual([]);

      controlledSave.release();
      expect(await firstOutcome).toMatchObject({
        kind: "failed",
        error: expect.objectContaining({ message: "queue checkpoint failed" }),
      });
    } finally {
      controlledSave.restore();
    }

    const restartedManager = new SessionStoreManager({ logger: silentLogger });
    const restartedService = new SessionInputService(restartedManager, { resolveDescriptors });
    const retryQueue = await restartedService.getPendingMessages(CHILD_SESSION_ID, WORKSPACE);
    await restartedService.beginQueueExecution({
      sessionId: CHILD_SESSION_ID,
      workspaceRoot: WORKSPACE,
      executionId: "retried-queue-execution",
      runOrdinal: 0,
      snapshots: [{ pending: retryQueue[0]!, modelAudit: MODEL_AUDIT }],
      binding: BINDING,
      origin: "tool_call",
      executionStart: executionStart("retried-queue-execution", "tool_call"),
    });
    const durableRetry = await restartedManager.getSessionFile(WORKSPACE, CHILD_SESSION_ID);
    expect(durableRetry.executions.map((execution) => execution.id)).toEqual([
      "previous-child-execution",
      "retried-queue-execution",
    ]);
    expect(durableRetry.messages.map((message) => message.executionId)).toEqual(["retried-queue-execution"]);
    expect(durableRetry.pendingMessages).toEqual([]);
  });
});
