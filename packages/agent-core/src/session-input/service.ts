import { createHash } from "node:crypto";
import type {
  SessionCommandInputReceipt,
  SessionInputReceipt,
  SessionMessageInputReceipt,
  PendingSessionMessage,
  SessionMessage,
  SessionMessageSource,
  ExecutionModelBindingSummary,
  MessageModelAudit,
  RequestedModelSelection,
  SessionExecutionOrigin,
} from "@archcode/protocol";
import type { SessionStoreState } from "../store/types";

export interface SessionInputDurableMutation<T> {
  readonly result: T;
  readonly patch?: Partial<SessionStoreState>;
  readonly events?: readonly import("@archcode/protocol").SessionEventPayload[];
}

export interface SessionInputStorePort {
  getSessionFile(
    workspaceRoot: string,
    sessionId: string,
  ): Promise<Pick<SessionStoreState, "pendingMessages" | "inputRequestReceipts" | "modelSelection">>;
  commitDurableSessionMutation<T>(
    sessionId: string,
    workspaceRoot: string,
    mutate: (state: Readonly<SessionStoreState>) => SessionInputDurableMutation<T>,
  ): Promise<T>;
}

export type SessionInputConflictReason =
  | "not_root"
  | "not_found"
  | "revision"
  | "state"
  | "idempotency"
  | "empty_queue"
  | "identity_collision"
  | "corrupt_receipt";

export interface SessionInputConflictCurrent {
  readonly messageId: string;
  readonly clientRequestId: string;
  readonly status: "queued" | "steering" | "canonical" | "deleted";
  readonly revision?: number;
  readonly content?: string;
  readonly executionId?: string;
}

export class SessionInputConflictError extends Error {
  constructor(
    public readonly reason: SessionInputConflictReason,
    message: string,
    public readonly current?: SessionInputConflictCurrent,
  ) {
    super(message);
    this.name = "SessionInputConflictError";
  }
}

export interface MessageAcceptance {
  readonly clientRequestId: string;
  readonly messageId: string;
  readonly status: SessionMessageInputReceipt["status"];
  readonly message?: PendingSessionMessage;
}

export type CommandRequestReplay =
  | {
      readonly kind: "command";
      readonly clientRequestId: string;
      readonly status: "executing" | "completed";
    }
  | { readonly kind: "message"; readonly acceptance: MessageAcceptance }
  | {
      readonly kind: "error";
      readonly clientRequestId: string;
      readonly status: "failed" | "indeterminate";
      readonly error: string;
    };

export type CommandRequestClaim =
  | { readonly kind: "claimed" }
  | CommandRequestReplay;

export interface BeginSessionInputResult {
  readonly pendingMessages: PendingSessionMessage[];
  readonly messages: SessionMessage[];
}

/** Exact durable pending revision paired with its already-resolved per-message audit. */
export interface ResolvedSessionInputSnapshot {
  readonly pending: PendingSessionMessage;
  readonly modelAudit: MessageModelAudit;
}

export class SessionInputService {
  readonly #store: SessionInputStorePort;

  constructor(store: SessionInputStorePort) {
    this.#store = store;
  }

  async getPendingMessages(sessionId: string, workspaceRoot: string): Promise<PendingSessionMessage[]> {
    const state = await this.#store.getSessionFile(workspaceRoot, sessionId);
    return state.pendingMessages.map(copyPendingMessage);
  }

  /** Persists the Queue cutoff for an explicit Stop that has no active root Execution record. */
  async recordQueueDispatchBarrier(input: {
    sessionId: string;
    workspaceRoot: string;
    timestamp: number;
  }): Promise<void> {
    await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      return {
        result: undefined,
        patch: {
          queueDispatchBarrierAt: Math.max(state.queueDispatchBarrierAt ?? 0, input.timestamp),
        },
      };
    });
  }

  async getCommandReplay(input: {
    sessionId: string;
    workspaceRoot: string;
    text: string;
    clientRequestId: string;
    source: SessionMessageSource;
    requestedModelSelection: RequestedModelSelection;
  }): Promise<CommandRequestReplay | undefined> {
    assertNonEmpty(input.text, "command text");
    assertNonEmpty(input.clientRequestId, "clientRequestId");
    const state = await this.#store.getSessionFile(input.workspaceRoot, input.sessionId);
    const receipt = state.inputRequestReceipts.find(
      (candidate) => candidate.clientRequestId === input.clientRequestId,
    );
    return receipt === undefined
      ? undefined
      : replayForReceipt(state, receipt, sessionInputFingerprint(input.source, input.text, input.requestedModelSelection));
  }

  async claimCommand(input: {
    sessionId: string;
    workspaceRoot: string;
    text: string;
    clientRequestId: string;
    source: SessionMessageSource;
    requestedModelSelection: RequestedModelSelection;
  }): Promise<CommandRequestClaim> {
    assertNonEmpty(input.text, "command text");
    assertNonEmpty(input.clientRequestId, "clientRequestId");
    const requestFingerprint = sessionInputFingerprint(input.source, input.text, input.requestedModelSelection);
    return await this.#store.commitDurableSessionMutation<CommandRequestClaim>(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      const existing = state.inputRequestReceipts.find(
        (receipt) => receipt.clientRequestId === input.clientRequestId,
      );
      if (existing !== undefined) {
        return { result: replayForReceipt(state, existing, requestFingerprint) };
      }
      const receipt: SessionCommandInputReceipt = {
        kind: "command",
        clientRequestId: input.clientRequestId,
        requestFingerprint,
        status: "executing",
        requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
      };
      return {
        result: { kind: "claimed" as const },
        patch: { inputRequestReceipts: [...state.inputRequestReceipts, receipt] },
      };
    });
  }

  async completeCommand(input: {
    sessionId: string;
    workspaceRoot: string;
    clientRequestId: string;
  }): Promise<void> {
    await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      return {
        result: undefined,
        patch: {
          inputRequestReceipts: replaceExecutingCommandReceipt(
            state.inputRequestReceipts,
            input.clientRequestId,
            (receipt) => ({ ...receipt, status: "completed" }),
          ),
        },
      };
    });
  }

  async completeCommandAsMessage(input: {
    sessionId: string;
    workspaceRoot: string;
    clientRequestId: string;
    text: string;
    source: SessionMessageSource;
    requestedModelSelection: RequestedModelSelection;
    messageId?: string;
  }): Promise<MessageAcceptance> {
    assertNonEmpty(input.text, "message text");
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      const commandReceipt = requireExecutingCommandReceipt(state.inputRequestReceipts, input.clientRequestId);
      if (!sameRequestedSelection(commandReceipt.requestedModelSelection, input.requestedModelSelection)) {
        throw new SessionInputConflictError("idempotency", `Command ${input.clientRequestId} model selection changed before completion`);
      }
      const messageId = input.messageId ?? crypto.randomUUID();
      assertMessageIdentityAvailable(state, messageId);
      const acceptedAt = nextSessionTimestamp(state);
      const message: PendingSessionMessage = {
        id: messageId,
        clientRequestId: input.clientRequestId,
        content: input.text,
        source: input.source,
        state: "queued",
        revision: 0,
        acceptedAt,
        updatedAt: acceptedAt,
        requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
      };
      const receipt: SessionMessageInputReceipt = {
        kind: "message",
        clientRequestId: input.clientRequestId,
        messageId,
        requestFingerprint: commandReceipt.requestFingerprint,
        status: "pending",
        requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
      };
      return {
        result: {
          clientRequestId: input.clientRequestId,
          messageId,
          status: "pending" as const,
          message: copyPendingMessage(message),
        },
        patch: {
          inputRequestReceipts: state.inputRequestReceipts.map((current) => (
            current.clientRequestId === input.clientRequestId ? receipt : current
          )),
        },
        events: [{ type: "session.message_accepted", message }],
      };
    });
  }

  async failCommand(input: {
    sessionId: string;
    workspaceRoot: string;
    clientRequestId: string;
    error: string;
  }): Promise<void> {
    assertNonEmpty(input.error, "command error");
    await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      return {
        result: undefined,
        patch: {
          inputRequestReceipts: replaceExecutingCommandReceipt(
            state.inputRequestReceipts,
            input.clientRequestId,
            (receipt) => ({ ...receipt, status: "failed", error: input.error }),
          ),
        },
      };
    });
  }

  async acceptMessage(input: {
    sessionId: string;
    workspaceRoot: string;
    text: string;
    clientRequestId: string;
    source: SessionMessageSource;
    messageId?: string;
    requestedModelSelection: RequestedModelSelection;
  }): Promise<MessageAcceptance> {
    assertNonEmpty(input.text, "message text");
    assertNonEmpty(input.clientRequestId, "clientRequestId");
    const requestFingerprint = sessionInputFingerprint(input.source, input.text, input.requestedModelSelection);

    return await this.#store.commitDurableSessionMutation(
      input.sessionId,
      input.workspaceRoot,
      (state) => {
        assertRootSession(state);
        const existingReceipt = state.inputRequestReceipts.find(
          (receipt) => receipt.clientRequestId === input.clientRequestId,
        );
        if (existingReceipt !== undefined) {
          if (existingReceipt.requestFingerprint !== requestFingerprint) {
            throw new SessionInputConflictError(
              "idempotency",
              `clientRequestId ${input.clientRequestId} was already used for different input`,
            );
          }
          if (existingReceipt.kind !== "message") {
            throw new SessionInputConflictError(
              "idempotency",
              `clientRequestId ${input.clientRequestId} belongs to a command`,
            );
          }
          return { result: acceptanceForMessageReceipt(state, existingReceipt) };
        }

        const messageId = input.messageId ?? crypto.randomUUID();
        assertMessageIdentityAvailable(state, messageId);
        const acceptedAt = nextSessionTimestamp(state);
        const message: PendingSessionMessage = {
          id: messageId,
          clientRequestId: input.clientRequestId,
          content: input.text,
          source: input.source,
          state: "queued",
          revision: 0,
          acceptedAt,
          updatedAt: acceptedAt,
          requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
        };
        const receipt: SessionInputReceipt = {
          kind: "message",
          clientRequestId: input.clientRequestId,
          messageId,
          requestFingerprint,
          status: "pending",
          requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
        };
        return {
          result: {
            clientRequestId: input.clientRequestId,
            messageId,
            status: "pending" as const,
            message: copyPendingMessage(message),
          },
          patch: { inputRequestReceipts: [...state.inputRequestReceipts, receipt] },
          events: [{ type: "session.message_accepted", message }],
        };
      },
    );
  }

  async editMessage(input: {
    sessionId: string;
    workspaceRoot: string;
    messageId: string;
    expectedRevision: number;
    text: string;
  }): Promise<PendingSessionMessage> {
    assertNonEmpty(input.text, "message text");
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      const current = requireQueuedMessage(state, input.messageId, input.expectedRevision);
      const updatedAt = nextSessionTimestamp(state);
      const message: PendingSessionMessage = {
        ...current,
        content: input.text,
        revision: current.revision + 1,
        updatedAt,
      };
      return {
        result: copyPendingMessage(message),
        events: [{ type: "session.message_edited", message }],
      };
    });
  }

  async deleteMessage(input: {
    sessionId: string;
    workspaceRoot: string;
    messageId: string;
    expectedRevision: number;
  }): Promise<{ messageId: string; clientRequestId: string; revision: number; deletedAt: number }> {
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      const current = requireQueuedMessage(state, input.messageId, input.expectedRevision);
      const deletedAt = nextSessionTimestamp(state);
      const revision = current.revision + 1;
      const result = {
        messageId: current.id,
        clientRequestId: current.clientRequestId,
        revision,
        deletedAt,
      };
      return {
        result,
        patch: {
          inputRequestReceipts: updateReceiptStatus(state.inputRequestReceipts, current.id, "deleted"),
        },
        events: [{ type: "session.message_deleted", ...result }],
      };
    });
  }

  async claimSteer(input: {
    sessionId: string;
    workspaceRoot: string;
    messageId: string;
    expectedRevision: number;
    expectedExecutionId: string;
  }): Promise<PendingSessionMessage> {
    assertNonEmpty(input.expectedExecutionId, "expectedExecutionId");
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      const current = requireQueuedMessage(state, input.messageId, input.expectedRevision);
      const message: PendingSessionMessage = {
        ...current,
        state: "steering",
        revision: current.revision + 1,
        updatedAt: nextSessionTimestamp(state),
        targetExecutionId: input.expectedExecutionId,
      };
      return {
        result: copyPendingMessage(message),
        events: [{ type: "session.message_steer_claimed", message }],
      };
    });
  }

  async beginQueueExecution(input: {
    sessionId: string;
    workspaceRoot: string;
    executionId: string;
    snapshots: readonly ResolvedSessionInputSnapshot[];
    binding: ExecutionModelBindingSummary;
    origin: SessionExecutionOrigin;
    signal?: AbortSignal;
  }): Promise<BeginSessionInputResult> {
    assertNonEmpty(input.executionId, "executionId");
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      input.signal?.throwIfAborted();
      assertRootSession(state);
      if (input.snapshots.length === 0) {
        throw new SessionInputConflictError("empty_queue", `Session ${state.sessionId} has no queued input`);
      }
      const queued = state.pendingMessages.filter((message) => message.state === "queued");
      const pendingMessages = input.snapshots.map((snapshot, index) => {
        const current = queued[index];
        validateResolvedSnapshot(current, snapshot, input.binding, "queued");
        return current!;
      });
      const committedAt = nextSessionTimestamp(state);
      const messages = pendingMessages.map((message, index) => toCanonicalMessage(
        message,
        input.executionId,
        committedAt,
        input.snapshots[index]!.modelAudit,
      ));
      return {
        result: {
          pendingMessages: pendingMessages.map(copyPendingMessage),
          messages: messages.map(copySessionMessage),
        },
        patch: {
          queueDispatchBarrierAt: undefined,
          inputRequestReceipts: updateReceiptStatuses(
            state.inputRequestReceipts,
            new Set(pendingMessages.map((message) => message.id)),
            "canonical",
          ),
        },
        events: [
          { type: "execution-start", executionId: input.executionId, binding: input.binding, origin: input.origin },
          { type: "session.messages_committed", executionId: input.executionId, messages },
        ],
      };
    });
  }

  async beginDirectExecution(input: {
    sessionId: string;
    workspaceRoot: string;
    executionId: string;
    text: string;
    source?: SessionMessageSource;
    messageId?: string;
    clientRequestId?: string;
    requestedModelSelection: RequestedModelSelection;
    modelAudit: MessageModelAudit;
    binding: ExecutionModelBindingSummary;
    origin: SessionExecutionOrigin;
    signal?: AbortSignal;
  }): Promise<SessionMessage> {
    assertNonEmpty(input.executionId, "executionId");
    assertNonEmpty(input.text, "message text");
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      input.signal?.throwIfAborted();
      const messageId = input.messageId ?? crypto.randomUUID();
      assertMessageIdentityAvailable(state, messageId);
      const createdAt = nextSessionTimestamp(state);
      const clientRequestId = input.clientRequestId;
      if (clientRequestId !== undefined) {
        assertNonEmpty(clientRequestId, "clientRequestId");
        const existing = state.inputRequestReceipts.find((receipt) => receipt.clientRequestId === clientRequestId);
        if (existing !== undefined) {
          throw new SessionInputConflictError("idempotency", `clientRequestId ${clientRequestId} already exists`);
        }
      }
      const pending: PendingSessionMessage = {
        id: messageId,
        clientRequestId: clientRequestId ?? `direct:${messageId}`,
        content: input.text,
        source: input.source ?? "user",
        state: "queued",
        revision: 0,
        acceptedAt: createdAt,
        updatedAt: createdAt,
        requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
      };
      validateAudit(pending, input.modelAudit, input.binding);
      const message = toCanonicalMessage(
        pending,
        input.executionId,
        createdAt,
        input.modelAudit,
        clientRequestId !== undefined,
      );
      const receipt: SessionMessageInputReceipt | undefined = clientRequestId === undefined ? undefined : {
        kind: "message",
        clientRequestId,
        messageId,
        requestFingerprint: sessionInputFingerprint(input.source ?? "user", input.text, input.requestedModelSelection),
        status: "canonical" as const,
        requestedModelSelection: copyRequestedSelection(input.requestedModelSelection),
      };
      return {
        result: copySessionMessage(message),
        patch: receipt === undefined
          ? undefined
          : { inputRequestReceipts: [...state.inputRequestReceipts, receipt] },
        events: [
          { type: "execution-start", executionId: input.executionId, binding: input.binding, origin: input.origin },
          { type: "session.messages_committed", executionId: input.executionId, messages: [message] },
        ],
      };
    });
  }

  async commitSteers(input: {
    sessionId: string;
    workspaceRoot: string;
    executionId: string;
    snapshots: readonly ResolvedSessionInputSnapshot[];
    binding: ExecutionModelBindingSummary;
    signal?: AbortSignal;
  }): Promise<SessionMessage[]> {
    if (input.snapshots.length === 0) return [];
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      input.signal?.throwIfAborted();
      assertRootSession(state);
      const committedAt = nextSessionTimestamp(state);
      const pendingMessages = input.snapshots.map((snapshot) => {
        const current = state.pendingMessages.find((message) => message.id === snapshot.pending.id);
        if (current === undefined) {
          throw new SessionInputConflictError("not_found", `Pending message ${snapshot.pending.id} no longer exists`);
        }
        if (current.state !== "steering" || current.targetExecutionId !== input.executionId) {
          throw new SessionInputConflictError(
            "state",
            `Message ${snapshot.pending.id} is not steering to ${input.executionId}`,
            pendingConflictProjection(current),
          );
        }
        validateResolvedSnapshot(current, snapshot, input.binding, "steering");
        return current;
      });
      const messages = pendingMessages.map((message, index) => toCanonicalMessage(
        message,
        input.executionId,
        committedAt,
        input.snapshots[index]!.modelAudit,
      ));
      return {
        result: messages.map(copySessionMessage),
        patch: {
          inputRequestReceipts: updateReceiptStatuses(
            state.inputRequestReceipts,
            new Set(pendingMessages.map((message) => message.id)),
            "canonical",
          ),
        },
        events: [{ type: "session.messages_committed", executionId: input.executionId, messages }],
      };
    });
  }

  async rollbackSteers(input: {
    sessionId: string;
    workspaceRoot: string;
    executionId?: string;
    messageIds?: readonly string[];
  }): Promise<PendingSessionMessage[]> {
    return await this.#store.commitDurableSessionMutation(input.sessionId, input.workspaceRoot, (state) => {
      assertRootSession(state);
      const requestedIds = input.messageIds === undefined ? undefined : new Set(input.messageIds);
      const matches = state.pendingMessages.filter((message) =>
        message.state === "steering"
          && (input.executionId === undefined || message.targetExecutionId === input.executionId)
          && (requestedIds === undefined || requestedIds.has(message.id))
      );
      let timestamp = nextSessionTimestamp(state);
      const messages = matches.map((message) => {
        const { targetExecutionId: _targetExecutionId, ...queued } = message;
        return {
          ...queued,
          state: "queued" as const,
          revision: message.revision + 1,
          updatedAt: timestamp++,
        };
      });
      return {
        result: messages.map(copyPendingMessage),
        events: messages.map((message) => ({
          type: "session.message_steer_rolled_back" as const,
          message,
        })),
      };
    });
  }

  async recoverOrphanedSteers(sessionId: string, workspaceRoot: string): Promise<PendingSessionMessage[]> {
    return await this.rollbackSteers({ sessionId, workspaceRoot });
  }
}

export function nextSessionTimestamp(
  state: Pick<SessionStoreState, "updatedAt" | "pendingMessages" | "messages" | "executions" | "queueDispatchBarrierAt">,
  now = Date.now(),
): number {
  let latest = Math.max(state.updatedAt, state.queueDispatchBarrierAt ?? 0);
  for (const message of state.pendingMessages) {
    latest = Math.max(latest, message.acceptedAt, message.updatedAt);
  }
  for (const message of state.messages) {
    latest = Math.max(latest, message.createdAt, message.completedAt ?? 0);
  }
  for (const execution of state.executions) {
    latest = Math.max(
      latest,
      execution.startedAt,
      execution.endedAt ?? 0,
      execution.stopRequestedAt ?? 0,
    );
  }
  return Math.max(now, latest + 1);
}

function assertRootSession(state: Pick<SessionStoreState, "sessionId" | "rootSessionId">): void {
  if (state.sessionId !== state.rootSessionId) {
    throw new SessionInputConflictError("not_root", `Session ${state.sessionId} is not a root Session`);
  }
}

function assertMessageIdentityAvailable(
  state: Pick<SessionStoreState, "pendingMessages" | "messages">,
  messageId: string,
): void {
  if (state.pendingMessages.some((message) => message.id === messageId)
    || state.messages.some((message) => message.id === messageId)) {
    throw new SessionInputConflictError("identity_collision", `Message id ${messageId} already exists`);
  }
}

function requireQueuedMessage(
  state: Pick<SessionStoreState, "pendingMessages" | "inputRequestReceipts" | "messages">,
  messageId: string,
  expectedRevision: number,
): PendingSessionMessage {
  const current = state.pendingMessages.find((message) => message.id === messageId);
  if (current === undefined) {
    const receipt = state.inputRequestReceipts.find(
      (candidate): candidate is SessionMessageInputReceipt => (
        candidate.kind === "message" && candidate.messageId === messageId
      ),
    );
    if (receipt === undefined) {
      throw new SessionInputConflictError("not_found", `Pending message ${messageId} does not exist`);
    }
    if (receipt.status === "pending") {
      throw new SessionInputConflictError(
        "corrupt_receipt",
        `Pending receipt ${receipt.clientRequestId} has no pending message`,
      );
    }
    const projection = receipt.status === "canonical"
      ? canonicalConflictProjection(state, receipt)
      : {
        messageId: receipt.messageId,
        clientRequestId: receipt.clientRequestId,
        status: receipt.status,
      } satisfies SessionInputConflictCurrent;
    throw new SessionInputConflictError(
      "state",
      `Message ${messageId} is ${projection.status}`,
      projection,
    );
  }
  if (current.revision !== expectedRevision) {
    throw new SessionInputConflictError(
      "revision",
      `Message ${messageId} revision is ${current.revision}, expected ${expectedRevision}`,
      pendingConflictProjection(current),
    );
  }
  if (current.state !== "queued") {
    throw new SessionInputConflictError(
      "state",
      `Message ${messageId} is ${current.state}`,
      pendingConflictProjection(current),
    );
  }
  return current;
}

function pendingConflictProjection(message: PendingSessionMessage): SessionInputConflictCurrent {
  return {
    messageId: message.id,
    clientRequestId: message.clientRequestId,
    status: message.state,
    revision: message.revision,
    content: message.content,
  };
}

function canonicalConflictProjection(
  state: Pick<SessionStoreState, "messages">,
  receipt: SessionMessageInputReceipt,
): SessionInputConflictCurrent {
  const message = state.messages.find((candidate) => candidate.id === receipt.messageId);
  if (message === undefined) {
    throw new SessionInputConflictError(
      "corrupt_receipt",
      `Canonical receipt ${receipt.clientRequestId} has no canonical message`,
    );
  }
  return {
    messageId: receipt.messageId,
    clientRequestId: receipt.clientRequestId,
    status: "canonical",
    content: message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
    ...(message.executionId === undefined ? {} : { executionId: message.executionId }),
  };
}

function toCanonicalMessage(
  pending: PendingSessionMessage,
  executionId: string,
  completedAt: number,
  modelAudit: MessageModelAudit,
  includeClientRequestId = true,
): SessionMessage {
  return {
    id: pending.id,
    role: "user",
    parts: [{
      type: "text",
      id: `${pending.id}:text`,
      text: pending.content,
      createdAt: pending.acceptedAt,
      completedAt,
    }],
    createdAt: pending.acceptedAt,
    completedAt,
    executionId,
    modelAudit: copyModelAudit(modelAudit),
    ...(includeClientRequestId ? { clientRequestId: pending.clientRequestId } : {}),
  };
}

function updateReceiptStatus(
  receipts: readonly SessionInputReceipt[],
  messageId: string,
  status: SessionMessageInputReceipt["status"],
): SessionInputReceipt[] {
  let found = false;
  const updated = receipts.map((receipt) => {
    if (receipt.kind !== "message" || receipt.messageId !== messageId) return receipt;
    found = true;
    return { ...receipt, status };
  });
  if (!found) {
    throw new SessionInputConflictError("corrupt_receipt", `Message ${messageId} has no request receipt`);
  }
  return updated;
}

function updateReceiptStatuses(
  receipts: readonly SessionInputReceipt[],
  messageIds: ReadonlySet<string>,
  status: SessionMessageInputReceipt["status"],
): SessionInputReceipt[] {
  const found = new Set<string>();
  const updated = receipts.map((receipt) => {
    if (receipt.kind !== "message" || !messageIds.has(receipt.messageId)) return receipt;
    found.add(receipt.messageId);
    return { ...receipt, status };
  });
  if (found.size !== messageIds.size) {
    throw new SessionInputConflictError("corrupt_receipt", "One or more pending messages have no request receipt");
  }
  return updated;
}

function replayForReceipt(
  state: Pick<SessionStoreState, "pendingMessages">,
  receipt: SessionInputReceipt,
  requestFingerprint: string,
): CommandRequestReplay {
  if (receipt.requestFingerprint !== requestFingerprint) {
    throw new SessionInputConflictError(
      "idempotency",
      `clientRequestId ${receipt.clientRequestId} was already used for different input`,
    );
  }
  if (receipt.kind === "message") {
    return { kind: "message", acceptance: acceptanceForMessageReceipt(state, receipt) };
  }
  if (receipt.status === "failed" || receipt.status === "indeterminate") {
    return {
      kind: "error",
      clientRequestId: receipt.clientRequestId,
      status: receipt.status,
      error: receipt.error ?? "Command outcome is unavailable",
    };
  }
  return { kind: "command", clientRequestId: receipt.clientRequestId, status: receipt.status };
}

function acceptanceForMessageReceipt(
  state: Pick<SessionStoreState, "pendingMessages">,
  receipt: SessionMessageInputReceipt,
): MessageAcceptance {
  const pending = state.pendingMessages.find((message) => message.id === receipt.messageId);
  if (receipt.status === "pending" && pending === undefined) {
    throw new SessionInputConflictError(
      "corrupt_receipt",
      `Pending receipt ${receipt.clientRequestId} has no pending message`,
    );
  }
  return {
    clientRequestId: receipt.clientRequestId,
    messageId: receipt.messageId,
    status: receipt.status,
    ...(pending === undefined ? {} : { message: copyPendingMessage(pending) }),
  };
}

function requireExecutingCommandReceipt(
  receipts: readonly SessionInputReceipt[],
  clientRequestId: string,
): SessionCommandInputReceipt {
  const receipt = receipts.find((candidate) => candidate.clientRequestId === clientRequestId);
  if (receipt === undefined || receipt.kind !== "command") {
    throw new SessionInputConflictError(
      "corrupt_receipt",
      `Command ${clientRequestId} has no command receipt`,
    );
  }
  if (receipt.status !== "executing") {
    throw new SessionInputConflictError(
      "state",
      `Command ${clientRequestId} is ${receipt.status}`,
    );
  }
  return receipt;
}

function replaceExecutingCommandReceipt(
  receipts: readonly SessionInputReceipt[],
  clientRequestId: string,
  replace: (receipt: SessionCommandInputReceipt) => SessionCommandInputReceipt,
): SessionInputReceipt[] {
  const current = requireExecutingCommandReceipt(receipts, clientRequestId);
  return receipts.map((receipt) => receipt === current ? replace(current) : receipt);
}

function sessionInputFingerprint(
  source: SessionMessageSource,
  text: string,
  requested: RequestedModelSelection,
): string {
  return createHash("sha256")
    .update(source)
    .update("\0")
    .update(text)
    .update("\0")
    .update(requested.mode)
    .update("\0")
    .update(requested.selection.model)
    .update("\0")
    .update(requested.selection.variant ?? "")
    .digest("hex");
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must not be empty`);
}

function copyPendingMessage(message: PendingSessionMessage): PendingSessionMessage {
  return { ...message, requestedModelSelection: copyRequestedSelection(message.requestedModelSelection) };
}

function copySessionMessage(message: SessionMessage): SessionMessage {
  return {
    ...message,
    parts: message.parts.map((part) => ({ ...part })),
    ...(message.modelAudit === undefined ? {} : { modelAudit: copyModelAudit(message.modelAudit) }),
  };
}

function copyRequestedSelection(requested: RequestedModelSelection): RequestedModelSelection {
  return { ...requested, selection: { ...requested.selection } };
}

function copyModelAudit(audit: MessageModelAudit): MessageModelAudit {
  return {
    ...audit,
    requested: copyRequestedSelection(audit.requested),
    actual: { ...audit.actual },
  };
}

function sameRequestedSelection(left: RequestedModelSelection, right: RequestedModelSelection): boolean {
  return left.mode === right.mode
    && left.selection.model === right.selection.model
    && left.selection.variant === right.selection.variant;
}

function sameSelection(
  left: ExecutionModelBindingSummary["selection"],
  right: ExecutionModelBindingSummary["selection"],
): boolean {
  return left.model === right.model && left.variant === right.variant;
}

function validateAudit(
  pending: PendingSessionMessage,
  audit: MessageModelAudit,
  binding: ExecutionModelBindingSummary,
): void {
  if (!sameRequestedSelection(pending.requestedModelSelection, audit.requested)
    || !sameSelection(audit.actual, binding.selection)) {
    throw new SessionInputConflictError(
      "revision",
      `Message ${pending.id} model selection changed after resolution`,
      pendingConflictProjection(pending),
    );
  }
}

function validateResolvedSnapshot(
  current: PendingSessionMessage | undefined,
  snapshot: ResolvedSessionInputSnapshot,
  binding: ExecutionModelBindingSummary,
  expectedState: PendingSessionMessage["state"],
): asserts current is PendingSessionMessage {
  if (current === undefined || current.id !== snapshot.pending.id) {
    throw new SessionInputConflictError(
      current === undefined ? "not_found" : "revision",
      `Resolved input prefix no longer begins with ${snapshot.pending.id}`,
      current === undefined ? undefined : pendingConflictProjection(current),
    );
  }
  if (current.state !== expectedState
    || current.revision !== snapshot.pending.revision
    || current.clientRequestId !== snapshot.pending.clientRequestId
    || current.content !== snapshot.pending.content
    || current.source !== snapshot.pending.source
    || current.targetExecutionId !== snapshot.pending.targetExecutionId
    || !sameRequestedSelection(current.requestedModelSelection, snapshot.pending.requestedModelSelection)) {
    throw new SessionInputConflictError(
      current.state !== expectedState ? "state" : "revision",
      `Message ${current.id} changed after model resolution`,
      pendingConflictProjection(current),
    );
  }
  validateAudit(current, snapshot.modelAudit, binding);
}
