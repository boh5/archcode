import type {
  HitlOwnerKey,
  HitlRecord,
  SessionHitlCheckpoint,
} from "@archcode/protocol";
import type { StoreApi } from "zustand";

import type { HitlService } from "../hitl/service";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import {
  deleteSessionHitlCheckpoint,
  readSessionHitlCheckpointFile,
  replaceSessionHitlCheckpoint,
  sessionHitlJournalPhase,
  transitionSessionHitlJournalPhase,
  type SessionHitlCheckpointRecord,
  type SessionHitlJournalPhase,
  writeSessionHitlCheckpoint,
} from "./session-hitl-checkpoint";

export interface SessionHitlJournalRecoverySummary {
  readonly scanned: number;
  readonly prepared: number;
  readonly manualUnknown: number;
  readonly terminalCleaned: number;
}

export class SessionHitlJournalBlockedError extends Error {
  readonly code = "SESSION_HITL_JOURNAL_BLOCKED";

  constructor(
    public readonly sessionId: string,
    public readonly hitlIds: string[],
    public readonly phases: SessionHitlJournalPhase[],
  ) {
    super(`Session ${sessionId} has unresolved durable HITL journal entries: ${hitlIds.join(", ")}`);
    this.name = "SessionHitlJournalBlockedError";
  }
}

export class SessionHitlContinuationOutcomeUnknownError extends Error {
  constructor(public readonly hitlId: string) {
    super(`Session HITL ${hitlId} stopped during LLM continuation; its outcome is unknown and requires manual inspection`);
    this.name = "SessionHitlContinuationOutcomeUnknownError";
  }
}

export async function assertSessionHitlJournalAllowsExecution(
  workspaceRoot: string,
  sessionId: string,
): Promise<void> {
  const entries = (await readSessionHitlCheckpointFile(workspaceRoot, sessionId)).checkpoints;
  if (entries.length === 0) return;
  throw new SessionHitlJournalBlockedError(
    sessionId,
    entries.map((entry) => entry.hitlId).sort(),
    entries.map(sessionHitlJournalPhase),
  );
}

/**
 * Establishes the Session-owned write-ahead record before publishing a visible
 * owner request. Every later failure therefore leaves either no journal or a
 * fail-closed entry that cold repair can finish idempotently.
 */
export async function prepareSessionHitlPause(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly store: StoreApi<SessionStoreState>;
  readonly sessions: SessionStoreManager;
  readonly hitl: HitlService;
  readonly checkpoint: SessionHitlCheckpointRecord;
}): Promise<{ readonly record: HitlRecord; readonly checkpoint: SessionHitlCheckpointRecord }> {
  if (sessionHitlJournalPhase(input.checkpoint) !== "preparing") {
    throw new Error(`Session HITL ${input.checkpoint.hitlId} must start from a complete preparing journal entry`);
  }
  assertSessionRequestOwner(input.checkpoint.request.owner, input.sessionId);

  await writeSessionHitlCheckpoint(input.checkpoint, input.workspaceRoot, input.sessionId);
  await input.sessions.setHitlBlocker(
    input.sessionId,
    input.workspaceRoot,
    sessionHitlBlockerFromJournal(input.checkpoint),
  );

  const created = await input.hitl.createWithResult({
    owner: input.checkpoint.request.owner,
    hitlId: input.checkpoint.hitlId,
    blockingKey: input.checkpoint.blockingKey,
    source: input.checkpoint.source,
    displayPayload: input.checkpoint.request.displayPayload,
    createdAt: input.checkpoint.request.createdAt,
  });
  const converged = await convergePreparedRecord({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    sessions: input.sessions,
    checkpoint: input.checkpoint,
    record: created.record,
  });
  const paused = await transitionSessionHitlJournalPhase(
    input.workspaceRoot,
    input.sessionId,
    converged.hitlId,
    "paused",
  );
  input.store.getState().append({ type: "hitl.request", request: created.record });
  await input.sessions.flushSession(input.sessionId, input.workspaceRoot);
  // HitlService delivery is deliberately best-effort after all durable state.
  await input.hitl.publishRequest(created.record);
  return { record: created.record, checkpoint: paused };
}

export async function recoverSessionHitlJournals(input: {
  readonly workspaceRoot: string;
  readonly sessions: SessionStoreManager;
  readonly hitl: HitlService;
}): Promise<SessionHitlJournalRecoverySummary> {
  let scanned = 0;
  let prepared = 0;
  let manualUnknown = 0;
  let terminalCleaned = 0;

  for (const session of await input.sessions.listAllSessionSummaries(input.workspaceRoot)) {
    const journal = await readSessionHitlCheckpointFile(input.workspaceRoot, session.sessionId);
    for (const original of journal.checkpoints) {
      scanned += 1;
      let checkpoint = original;
      let phase = sessionHitlJournalPhase(checkpoint);
      const store = await input.sessions.getOrLoad(session.sessionId, input.workspaceRoot);
      const owner = checkpoint.request.owner;
      assertSessionRequestOwner(owner, session.sessionId);
      const ownerLookup = await (await input.hitl.ownerStore(owner)).lookup(checkpoint.hitlId);

      if (ownerLookup.status === "found" && isTerminalRecord(ownerLookup.record)) {
        await resolveTerminalJournal({
          workspaceRoot: input.workspaceRoot,
          sessionId: session.sessionId,
          sessions: input.sessions,
          store,
          record: ownerLookup.record,
        });
        terminalCleaned += 1;
        continue;
      }

      await input.sessions.setHitlBlocker(
        session.sessionId,
        input.workspaceRoot,
        sessionHitlBlockerFromJournal(checkpoint),
      );

      if (ownerLookup.status === "missing") {
        checkpoint = await repairMissingOwner({
          workspaceRoot: input.workspaceRoot,
          sessionId: session.sessionId,
          sessions: input.sessions,
          hitl: input.hitl,
          checkpoint,
        });
        phase = sessionHitlJournalPhase(checkpoint);
      }

      if (phase === "preparing") {
        checkpoint = await transitionSessionHitlJournalPhase(
          input.workspaceRoot,
          session.sessionId,
          checkpoint.hitlId,
          "paused",
        );
        phase = "paused";
        prepared += 1;
      } else if (phase === "continuing") {
        await transitionSessionHitlJournalPhase(
          input.workspaceRoot,
          session.sessionId,
          checkpoint.hitlId,
          "manual_unknown",
        );
        phase = "manual_unknown";
        manualUnknown += 1;
      }

      const current = await (await input.hitl.ownerStore(checkpoint.request.owner)).lookup(checkpoint.hitlId);
      if (current.status === "found") {
        store.getState().append({ type: "hitl.request", request: current.record });
        await input.sessions.flushSession(session.sessionId, input.workspaceRoot);
        if (phase === "paused") await input.hitl.publishRequest(current.record);
      }
    }
  }

  return { scanned, prepared, manualUnknown, terminalCleaned };
}

/** Repairs only a preparing entry before an explicitly claimed replay. */
export async function repairSessionHitlJournalForReplay(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: SessionStoreManager;
  readonly hitl: HitlService;
  readonly checkpoint: SessionHitlCheckpointRecord;
}): Promise<SessionHitlCheckpointRecord> {
  const phase = sessionHitlJournalPhase(input.checkpoint);
  if (phase !== "preparing") return input.checkpoint;
  const repaired = await repairMissingOwner(input);
  await input.sessions.setHitlBlocker(
    input.sessionId,
    input.workspaceRoot,
    sessionHitlBlockerFromJournal(repaired),
    input.checkpoint.hitlId === repaired.hitlId ? undefined : input.checkpoint.hitlId,
  );
  return await transitionSessionHitlJournalPhase(
    input.workspaceRoot,
    input.sessionId,
    repaired.hitlId,
    "paused",
  );
}

export async function moveContinuingJournalToManualUnknown(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly checkpoint: SessionHitlCheckpointRecord;
}): Promise<never> {
  const phase = sessionHitlJournalPhase(input.checkpoint);
  if (phase === "continuing") {
    await transitionSessionHitlJournalPhase(
      input.workspaceRoot,
      input.sessionId,
      input.checkpoint.hitlId,
      "manual_unknown",
    );
  }
  throw new SessionHitlContinuationOutcomeUnknownError(input.checkpoint.hitlId);
}

export function sessionHitlBlockerFromJournal(checkpoint: SessionHitlCheckpointRecord): SessionHitlCheckpoint {
  return {
    version: 1,
    hitlId: checkpoint.hitlId,
    blockingKey: checkpoint.blockingKey,
    source: checkpoint.source,
    toolCallId: checkpoint.toolCallId,
    toolName: checkpoint.toolName,
    step: checkpoint.step,
    ...(checkpoint.assistantMessageId === undefined ? {} : { assistantMessageId: checkpoint.assistantMessageId }),
    displayInput: checkpoint.displayInput,
    blockedAt: checkpoint.createdAt,
    reason: checkpoint.request.displayPayload.title,
  };
}

export async function finalizeResolvedSessionHitlJournal(
  workspaceRoot: string,
  record: HitlRecord,
): Promise<void> {
  if (record.owner.ownerType !== "session" || !isTerminalRecord(record)) return;
  await deleteSessionHitlCheckpoint(workspaceRoot, record.owner.ownerId, record.hitlId);
}

async function repairMissingOwner(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: SessionStoreManager;
  readonly hitl: HitlService;
  readonly checkpoint: SessionHitlCheckpointRecord;
}): Promise<SessionHitlCheckpointRecord> {
  const request = input.checkpoint.request;
  assertSessionRequestOwner(request.owner, input.sessionId);
  const result = await input.hitl.createWithResult({
    owner: request.owner,
    hitlId: input.checkpoint.hitlId,
    blockingKey: input.checkpoint.blockingKey,
    source: input.checkpoint.source,
    displayPayload: request.displayPayload,
    createdAt: request.createdAt,
  });
  return await convergePreparedRecord({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    sessions: input.sessions,
    checkpoint: input.checkpoint,
    record: result.record,
  });
}

async function convergePreparedRecord(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: SessionStoreManager;
  readonly checkpoint: SessionHitlCheckpointRecord;
  readonly record: HitlRecord;
}): Promise<SessionHitlCheckpointRecord> {
  if (input.record.hitlId === input.checkpoint.hitlId) return input.checkpoint;
  if (input.record.blockingKey !== input.checkpoint.blockingKey) {
    throw new Error(`Session HITL ${input.checkpoint.hitlId} cannot converge onto unrelated owner record ${input.record.hitlId}`);
  }
  const replacement: SessionHitlCheckpointRecord = {
    ...input.checkpoint,
    hitlId: input.record.hitlId,
    blockingKey: input.record.blockingKey,
    source: input.record.source,
    request: {
      owner: input.record.owner,
      displayPayload: input.record.displayPayload,
      createdAt: input.record.createdAt,
    },
    phase: "preparing",
    phaseUpdatedAt: new Date().toISOString(),
  };
  const replaced = await replaceSessionHitlCheckpoint(
    input.workspaceRoot,
    input.sessionId,
    input.checkpoint.hitlId,
    replacement,
  );
  await input.sessions.setHitlBlocker(
    input.sessionId,
    input.workspaceRoot,
    sessionHitlBlockerFromJournal(replaced),
    input.checkpoint.hitlId,
  );
  return replaced;
}

async function resolveTerminalJournal(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: SessionStoreManager;
  readonly store: StoreApi<SessionStoreState>;
  readonly record: HitlRecord & { readonly status: "resolved" | "cancelled" };
}): Promise<void> {
  input.store.getState().append({
    type: "hitl.resolved",
    hitlId: input.record.hitlId,
    status: input.record.status,
    ...(input.record.response === undefined ? {} : { response: input.record.response }),
  });
  await input.sessions.flushSession(input.sessionId, input.workspaceRoot);
  await deleteSessionHitlCheckpoint(input.workspaceRoot, input.sessionId, input.record.hitlId);
}

function assertSessionRequestOwner(owner: HitlOwnerKey, sessionId: string): void {
  if (owner.ownerType !== "session" || owner.ownerId !== sessionId) {
    throw new Error(`Session HITL journal owner does not match Session ${sessionId}`);
  }
}

function isTerminalRecord(record: HitlRecord): record is HitlRecord & { status: "resolved" | "cancelled" } {
  return record.status === "resolved" || record.status === "cancelled";
}
