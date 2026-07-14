import type {
  HitlOwnerKey,
  HitlRecord,
  SessionHitlBlocker,
} from "@archcode/protocol";
import type { StoreApi } from "zustand";

import type { HitlService } from "../hitl/service";
import type { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import {
  deleteSessionHitlJournalEntry,
  readSessionHitlJournalFile,
  replaceSessionHitlJournalEntry,
  sessionHitlJournalPhase,
  transitionSessionHitlJournalPhase,
  type SessionHitlJournalEntry,
  type SessionHitlJournalPhase,
  writeSessionHitlJournalEntry,
} from "./session-hitl-journal-store";

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
  readonly retryable = false;

  constructor(public readonly hitlId: string) {
    super(`Session HITL ${hitlId} stopped during LLM continuation; its outcome is unknown and requires manual inspection`);
    this.name = "SessionHitlContinuationOutcomeUnknownError";
  }
}

export async function assertSessionHitlJournalAllowsExecution(
  workspaceRoot: string,
  sessionId: string,
): Promise<void> {
  const entries = (await readSessionHitlJournalFile(workspaceRoot, sessionId)).entries;
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
  readonly entry: SessionHitlJournalEntry;
}): Promise<{ readonly record: HitlRecord; readonly entry: SessionHitlJournalEntry }> {
  if (sessionHitlJournalPhase(input.entry) !== "preparing") {
    throw new Error(`Session HITL ${input.entry.hitlId} must start from a complete preparing journal entry`);
  }
  assertSessionRequestOwner(input.entry.request.owner, input.sessionId);

  await writeSessionHitlJournalEntry(input.entry, input.workspaceRoot, input.sessionId);
  await input.sessions.setHitlBlocker(
    input.sessionId,
    input.workspaceRoot,
    sessionHitlBlockerFromJournal(input.entry),
  );

  const created = await input.hitl.createWithResult({
    owner: input.entry.request.owner,
    sessionRootId: input.store.getState().rootSessionId,
    hitlId: input.entry.hitlId,
    blockingKey: input.entry.blockingKey,
    source: input.entry.source,
    displayPayload: input.entry.request.displayPayload,
    createdAt: input.entry.request.createdAt,
  });
  const converged = await convergePreparedRecord({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    sessions: input.sessions,
    entry: input.entry,
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
  return { record: created.record, entry: paused };
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
    const journal = await readSessionHitlJournalFile(input.workspaceRoot, session.sessionId);
    for (const original of journal.entries) {
      scanned += 1;
      let entry = original;
      let phase = sessionHitlJournalPhase(entry);
      const store = await input.sessions.getOrLoad(session.sessionId, input.workspaceRoot);
      const owner = entry.request.owner;
      assertSessionRequestOwner(owner, session.sessionId);
      const ownerLookup = await (await input.hitl.ownerStore(owner)).lookup(entry.hitlId);

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
        sessionHitlBlockerFromJournal(entry),
      );

      if (ownerLookup.status === "missing") {
        entry = await repairMissingOwner({
          workspaceRoot: input.workspaceRoot,
          sessionId: session.sessionId,
          sessions: input.sessions,
          hitl: input.hitl,
          entry,
        });
        phase = sessionHitlJournalPhase(entry);
      }

      if (phase === "preparing") {
        entry = await transitionSessionHitlJournalPhase(
          input.workspaceRoot,
          session.sessionId,
          entry.hitlId,
          "paused",
        );
        phase = "paused";
        prepared += 1;
      } else if (phase === "continuing") {
        await transitionSessionHitlJournalPhase(
          input.workspaceRoot,
          session.sessionId,
          entry.hitlId,
          "manual_unknown",
        );
        phase = "manual_unknown";
        manualUnknown += 1;
      }

      const current = await (await input.hitl.ownerStore(entry.request.owner)).lookup(entry.hitlId);
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
  readonly entry: SessionHitlJournalEntry;
}): Promise<SessionHitlJournalEntry> {
  const phase = sessionHitlJournalPhase(input.entry);
  if (phase !== "preparing") return input.entry;
  const repaired = await repairMissingOwner(input);
  await input.sessions.setHitlBlocker(
    input.sessionId,
    input.workspaceRoot,
    sessionHitlBlockerFromJournal(repaired),
    input.entry.hitlId === repaired.hitlId ? undefined : input.entry.hitlId,
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
  readonly entry: SessionHitlJournalEntry;
}): Promise<never> {
  const phase = sessionHitlJournalPhase(input.entry);
  if (phase === "continuing") {
    await transitionSessionHitlJournalPhase(
      input.workspaceRoot,
      input.sessionId,
      input.entry.hitlId,
      "manual_unknown",
    );
  }
  throw new SessionHitlContinuationOutcomeUnknownError(input.entry.hitlId);
}

export function sessionHitlBlockerFromJournal(entry: SessionHitlJournalEntry): SessionHitlBlocker {
  return {
    hitlId: entry.hitlId,
    blockingKey: entry.blockingKey,
    source: entry.source,
    toolCallId: entry.toolCallId,
    toolName: entry.toolName,
    step: entry.step,
    ...(entry.assistantMessageId === undefined ? {} : { assistantMessageId: entry.assistantMessageId }),
    displayInput: entry.displayInput,
    blockedAt: entry.createdAt,
    reason: entry.request.displayPayload.title,
  };
}

export async function finalizeResolvedSessionHitlJournal(
  workspaceRoot: string,
  record: HitlRecord,
): Promise<void> {
  if (record.owner.ownerType !== "session" || !isTerminalRecord(record)) return;
  await deleteSessionHitlJournalEntry(workspaceRoot, record.owner.ownerId, record.hitlId);
}

async function repairMissingOwner(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: SessionStoreManager;
  readonly hitl: HitlService;
  readonly entry: SessionHitlJournalEntry;
}): Promise<SessionHitlJournalEntry> {
  const request = input.entry.request;
  assertSessionRequestOwner(request.owner, input.sessionId);
  const sessionRootId = (await input.sessions.getOrLoad(input.sessionId, input.workspaceRoot)).getState().rootSessionId;
  const result = await input.hitl.createWithResult({
    owner: request.owner,
    sessionRootId,
    hitlId: input.entry.hitlId,
    blockingKey: input.entry.blockingKey,
    source: input.entry.source,
    displayPayload: request.displayPayload,
    createdAt: request.createdAt,
  });
  return await convergePreparedRecord({
    workspaceRoot: input.workspaceRoot,
    sessionId: input.sessionId,
    sessions: input.sessions,
    entry: input.entry,
    record: result.record,
  });
}

async function convergePreparedRecord(input: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly sessions: SessionStoreManager;
  readonly entry: SessionHitlJournalEntry;
  readonly record: HitlRecord;
}): Promise<SessionHitlJournalEntry> {
  const canonicalRootId = (await input.sessions.getOrLoad(input.sessionId, input.workspaceRoot)).getState().rootSessionId;
  if (input.record.sessionRootId !== canonicalRootId) {
    throw new Error(
      `Session HITL ${input.record.hitlId} root ${input.record.sessionRootId ?? "missing"} does not match canonical root ${canonicalRootId}`,
    );
  }
  if (input.record.hitlId === input.entry.hitlId) return input.entry;
  if (input.record.blockingKey !== input.entry.blockingKey) {
    throw new Error(`Session HITL ${input.entry.hitlId} cannot converge onto unrelated owner record ${input.record.hitlId}`);
  }
  const replacement: SessionHitlJournalEntry = {
    ...input.entry,
    hitlId: input.record.hitlId,
    blockingKey: input.record.blockingKey,
    source: sessionHitlSource(input.record),
    request: {
      owner: input.record.owner,
      displayPayload: input.record.displayPayload,
      createdAt: input.record.createdAt,
    },
    phase: "preparing",
    phaseUpdatedAt: new Date().toISOString(),
  };
  const replaced = await replaceSessionHitlJournalEntry(
    input.workspaceRoot,
    input.sessionId,
    input.entry.hitlId,
    replacement,
  );
  await input.sessions.setHitlBlocker(
    input.sessionId,
    input.workspaceRoot,
    sessionHitlBlockerFromJournal(replaced),
    input.entry.hitlId,
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
  await deleteSessionHitlJournalEntry(input.workspaceRoot, input.sessionId, input.record.hitlId);
}

function assertSessionRequestOwner(owner: HitlOwnerKey, sessionId: string): void {
  if (owner.ownerType !== "session" || owner.ownerId !== sessionId) {
    throw new Error(`Session HITL journal owner does not match Session ${sessionId}`);
  }
}

function isTerminalRecord(record: HitlRecord): record is HitlRecord & { status: "resolved" | "cancelled" } {
  return record.status === "resolved" || record.status === "cancelled";
}

function sessionHitlSource(record: HitlRecord): SessionHitlJournalEntry["source"] {
  if (record.source.type !== "ask_user" && record.source.type !== "tool_permission") {
    throw new Error(`Session HITL ${record.hitlId} has non-Session source ${record.source.type}`);
  }
  return record.source;
}
