import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { HitlOwnerKey } from "@archcode/protocol";
import { GoalStateManager } from "../goals/state";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import {
  getSessionHitlJournalPath,
  readSessionHitlJournalEntry,
  readSessionHitlJournalFile,
  sessionHitlJournalPhase,
  type SessionHitlJournalEntry,
  writeSessionHitlJournalEntry,
} from "./session-hitl-journal-store";
import {
  assertSessionHitlJournalAllowsExecution,
  recoverSessionHitlJournals,
} from "./session-hitl-journal";
import { SessionExecutionManager } from "./session-execution-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-hitl-journal", crypto.randomUUID());

describe("Session HITL journal", () => {
  beforeEach(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
    await mkdir(TMP_ROOT, { recursive: true });
  });

  afterAll(async () => {
    await rm(TMP_ROOT, { recursive: true, force: true });
  });

  test("cold recovery completes a prepared journal written before the Session blocker and owner record", async () => {
    const fixture = await createFixture();
    const entry = preparingEntry(fixture);
    await writeSessionHitlJournalEntry(entry, fixture.workspaceRoot, fixture.sessionId);

    await expect(assertSessionHitlJournalAllowsExecution(fixture.workspaceRoot, fixture.sessionId)).rejects.toMatchObject({
      name: "SessionHitlJournalBlockedError",
      hitlIds: [entry.hitlId],
    });

    const summary = await recoverSessionHitlJournals({
      workspaceRoot: fixture.workspaceRoot,
      sessions: fixture.sessions,
      hitl: fixture.hitl,
    });

    expect(summary).toMatchObject({ prepared: 1, manualUnknown: 0 });
    const repaired = await readSessionHitlJournalEntry(fixture.workspaceRoot, fixture.sessionId, entry.hitlId);
    expect(repaired === undefined ? undefined : sessionHitlJournalPhase(repaired)).toBe("paused");
    const ownerFile = await (await fixture.hitl.ownerStore(fixture.owner)).read();
    expect(ownerFile.pending).toHaveLength(1);
    expect(ownerFile.pending[0]).toMatchObject({ hitlId: entry.hitlId, blockingKey: entry.blockingKey });

    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().blockedByHitlIds).toEqual([entry.hitlId]);
    expect(coldStore.getState().blockedHitl).toMatchObject({ hitlId: entry.hitlId });
  });

  test("rejects the removed version field and incomplete entry records", async () => {
    const fixture = await createFixture();
    const entry = preparingEntry(fixture);
    const { phase: _phase, ...missingPhase } = entry;
    const { phaseUpdatedAt: _phaseUpdatedAt, ...missingPhaseUpdatedAt } = entry;
    const { request: _request, ...missingRequest } = entry;
    const { agentName: _agentName, ...missingAgentName } = entry;

    await expect(writeSessionHitlJournalEntry(
      missingPhase as unknown as SessionHitlJournalEntry,
      fixture.workspaceRoot,
      fixture.sessionId,
    )).rejects.toThrow();
    await expect(writeSessionHitlJournalEntry(
      missingPhaseUpdatedAt as unknown as SessionHitlJournalEntry,
      fixture.workspaceRoot,
      fixture.sessionId,
    )).rejects.toThrow();
    await expect(writeSessionHitlJournalEntry(
      missingRequest as unknown as SessionHitlJournalEntry,
      fixture.workspaceRoot,
      fixture.sessionId,
    )).rejects.toThrow();
    await expect(writeSessionHitlJournalEntry(
      missingAgentName as unknown as SessionHitlJournalEntry,
      fixture.workspaceRoot,
      fixture.sessionId,
    )).rejects.toThrow();

    await Bun.write(getSessionHitlJournalPath(fixture.workspaceRoot, fixture.sessionId), `${JSON.stringify({
      version: 1,
      entries: [],
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();
  });

  test("rejects duplicate entry identities in one durable file", async () => {
    const fixture = await createFixture();
    const first = preparingEntry(fixture);
    const second = indexedEntry(fixture, 2);

    await writeRawEntryFile(fixture, [first, { ...second, hitlId: first.hitlId }]);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();

    await writeRawEntryFile(fixture, [first, { ...second, blockingKey: first.blockingKey }]);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();
  });

  test("rejects entry owner source kind and permission mismatches", async () => {
    const fixture = await createFixture();
    const entry = preparingEntry(fixture);

    await writeRawEntryFile(fixture, [{
      ...entry,
      request: { ...entry.request, owner: { ...fixture.owner, ownerId: crypto.randomUUID() } },
    }]);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();

    await writeRawEntryFile(fixture, [{
      ...entry,
      source: { ...entry.source, sessionId: crypto.randomUUID() },
    }]);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();

    const { permission: _permission, ...withoutPermission } = entry;
    await writeRawEntryFile(fixture, [withoutPermission]);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();

    await writeRawEntryFile(fixture, [{ ...entry, kind: "ask_user" }]);
    await expect(readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)).rejects.toThrow();

    await expect(writeSessionHitlJournalEntry(
      { ...entry, request: { ...entry.request, owner: { ...fixture.owner, ownerId: crypto.randomUUID() } } },
      fixture.workspaceRoot,
      fixture.sessionId,
    )).rejects.toThrow();
  });

  test("cold user-message entry fails closed on a prepared journal even before the Session blocker snapshot", async () => {
    const fixture = await createFixture();
    const entry = preparingEntry(fixture);
    await writeSessionHitlJournalEntry(entry, fixture.workspaceRoot, fixture.sessionId);
    const manager = new SessionExecutionManager({
      sessionAgentManager: {} as SessionAgentManager,
      createSessionStore: (sessionId, workspaceRoot, options) => fixture.sessions.create(sessionId, workspaceRoot, options),
      flushSessionStore: (sessionId, workspaceRoot) => fixture.sessions.flushSession(sessionId, workspaceRoot),
      getSessionStore: (sessionId, workspaceRoot) => fixture.sessions.get(sessionId, workspaceRoot),
      loadSessionStore: (sessionId, workspaceRoot) => fixture.sessions.getOrLoad(sessionId, workspaceRoot),
      deleteSessionStore: (sessionId, workspaceRoot, options) => fixture.sessions.delete(sessionId, workspaceRoot, options),
      resolveRootSessionId: (sessionId, workspaceRoot) => fixture.sessions.resolveRootSessionId(sessionId, workspaceRoot),
      buildSessionTree: (workspaceRoot, rootSessionId) => fixture.sessions.buildSessionTree(workspaceRoot, rootSessionId),
      listSessionFamilyBlockedHitlIds: (workspaceRoot, rootSessionId) => fixture.sessions.listSessionFamilyBlockedHitlIds(workspaceRoot, rootSessionId),
      trackSession: () => undefined,
      untrackSession: () => undefined,
      executionScopeValidator: { validate: async () => undefined },
      sessionHitlExecutionGate: {
        assertAllowed: assertSessionHitlJournalAllowsExecution,
      },
      logger: silentLogger,
    });

    await expect(manager.startCheckedExecution({
      slug: "archcode",
      workspaceRoot: fixture.workspaceRoot,
      sessionId: fixture.sessionId,
      userMessage: "must not pass the prepared HITL journal",
    })).rejects.toMatchObject({
      name: "SessionHitlJournalBlockedError",
      hitlIds: [entry.hitlId],
    });
    expect(manager.getSessionFamilyActivity(fixture.workspaceRoot, fixture.sessionId)).toBe("idle");
  });

  test("cold recovery completes the owner-created boundary without duplicating the visible request", async () => {
    const fixture = await createFixture();
    const entry = preparingEntry(fixture);
    await writeSessionHitlJournalEntry(entry, fixture.workspaceRoot, fixture.sessionId);
    await fixture.hitl.create({
      owner: fixture.owner,
      sessionRootId: fixture.sessionId,
      hitlId: entry.hitlId,
      blockingKey: entry.blockingKey,
      source: entry.source,
      displayPayload: entry.request!.displayPayload,
      createdAt: entry.request!.createdAt,
    });

    await recoverSessionHitlJournals({
      workspaceRoot: fixture.workspaceRoot,
      sessions: fixture.sessions,
      hitl: fixture.hitl,
    });

    const ownerFile = await (await fixture.hitl.ownerStore(fixture.owner)).read();
    expect(ownerFile.pending).toHaveLength(1);
    expect(ownerFile.pending[0]?.hitlId).toBe(entry.hitlId);
    const repaired = await readSessionHitlJournalEntry(fixture.workspaceRoot, fixture.sessionId, entry.hitlId);
    expect(repaired === undefined ? undefined : sessionHitlJournalPhase(repaired)).toBe("paused");
  });

  test("repair rekeys a prepared journal onto a reused blocking-key record without cancelling it", async () => {
    const fixture = await createFixture();
    const entry = preparingEntry(fixture);
    const existing = await fixture.hitl.create({
      owner: fixture.owner,
      sessionRootId: fixture.sessionId,
      blockingKey: entry.blockingKey,
      source: entry.source,
      displayPayload: entry.request!.displayPayload,
    });
    expect(existing.hitlId).not.toBe(entry.hitlId);
    await writeSessionHitlJournalEntry(entry, fixture.workspaceRoot, fixture.sessionId);

    await recoverSessionHitlJournals({
      workspaceRoot: fixture.workspaceRoot,
      sessions: fixture.sessions,
      hitl: fixture.hitl,
    });

    const file = await readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId);
    expect(file.entries).toHaveLength(1);
    expect(file.entries[0]?.hitlId).toBe(existing.hitlId);
    expect(sessionHitlJournalPhase(file.entries[0]!)).toBe("paused");
    const ownerFile = await (await fixture.hitl.ownerStore(fixture.owner)).read();
    expect(ownerFile.pending).toHaveLength(1);
    expect(ownerFile.pending[0]).toMatchObject({ hitlId: existing.hitlId, status: "pending" });
    expect(ownerFile.recentTerminal).toEqual([]);

    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().blockedByHitlIds).toEqual([existing.hitlId]);
  });

  test("serializes entry reads with concurrent journal mutations", async () => {
    const fixture = await createFixture();
    const entries = Array.from({ length: 24 }, (_, index) => indexedEntry(fixture, index));
    for (const entry of entries.slice(0, 12)) {
      await writeSessionHitlJournalEntry(entry, fixture.workspaceRoot, fixture.sessionId);
    }

    await Promise.all([
      ...entries.slice(12).map((entry) => (
        writeSessionHitlJournalEntry(entry, fixture.workspaceRoot, fixture.sessionId)
      )),
      ...Array.from({ length: 96 }, () => (
        readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId)
      )),
    ]);

    const file = await readSessionHitlJournalFile(fixture.workspaceRoot, fixture.sessionId);
    expect(file.entries.map((entry) => entry.hitlId).sort()).toEqual(
      entries.map((entry) => entry.hitlId).sort(),
    );
  });
});

async function createFixture() {
  const workspaceRoot = TMP_ROOT;
  const sessionId = crypto.randomUUID();
  const sessions = new SessionStoreManager({ logger: silentLogger });
  sessions.create(sessionId, workspaceRoot, { agentName: "engineer" });
  await sessions.flushSession(sessionId, workspaceRoot);
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const hitl = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
  });
  const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
  return { workspaceRoot, sessionId, sessions, hitl, owner };
}

function preparingEntry(fixture: Awaited<ReturnType<typeof createFixture>>): SessionHitlJournalEntry {
  const hitlId = crypto.randomUUID();
  const source: SessionHitlJournalEntry["source"] = {
    type: "tool_permission",
    sessionId: fixture.sessionId,
    toolCallId: "journal-tool-call",
    toolName: "file_write",
  };
  const createdAt = new Date().toISOString();
  return {
    phase: "preparing",
    phaseUpdatedAt: createdAt,
    hitlId,
    blockingKey: `session:${fixture.sessionId}:tool:journal-tool-call`,
    source,
    request: {
      owner: fixture.owner,
      displayPayload: { title: "Approve file_write", summary: "Review the write", redacted: true },
      createdAt,
    },
    toolCallId: "journal-tool-call",
    toolName: "file_write",
    step: 0,
    rawToolInput: { path: "README.md", content: "changed" },
    displayInput: { path: "README.md", content: "[REDACTED]" },
    allowedTools: ["file_write"],
    agentSkills: [],
    agentName: "engineer",
    toolCalls: [{ toolCallId: "journal-tool-call", toolName: "file_write", input: { path: "README.md", content: "changed" } }],
    completedToolResults: [],
    pendingToolCalls: [{ toolCallId: "journal-tool-call", toolName: "file_write", input: { path: "README.md", content: "changed" } }],
    blockedToolIndex: 0,
    createdAt,
    permission: { description: "Write README" },
  };
}

function indexedEntry(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  index: number,
): SessionHitlJournalEntry {
  const entry = preparingEntry(fixture);
  const toolCallId = `journal-tool-call-${index}`;
  return {
    ...entry,
    hitlId: `journal-hitl-${index}`,
    blockingKey: `session:${fixture.sessionId}:tool:${toolCallId}`,
    source: { type: "tool_permission", sessionId: fixture.sessionId, toolCallId, toolName: "file_write" },
    toolCallId,
    toolCalls: [{ toolCallId, toolName: "file_write", input: entry.rawToolInput }],
    pendingToolCalls: [{ toolCallId, toolName: "file_write", input: entry.rawToolInput }],
  };
}

async function writeRawEntryFile(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  entries: readonly unknown[],
): Promise<void> {
  await Bun.write(getSessionHitlJournalPath(fixture.workspaceRoot, fixture.sessionId), `${JSON.stringify({
    entries,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}
