import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { HitlOwnerKey, HitlSource } from "@archcode/protocol";
import { GoalStateManager } from "../goals/state";
import type { SessionAgentManager } from "../agents/session-agent-manager";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import {
  readSessionHitlCheckpoint,
  readSessionHitlCheckpointFile,
  sessionHitlJournalPhase,
  type SessionHitlCheckpointRecord,
  writeSessionHitlCheckpoint,
} from "./session-hitl-checkpoint";
import {
  assertSessionHitlJournalAllowsExecution,
  recoverSessionHitlJournals,
} from "./session-hitl-journal";
import { SessionExecutionManager } from "./session-execution-manager";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "session-hitl-journal");

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
    const checkpoint = preparingCheckpoint(fixture);
    await writeSessionHitlCheckpoint(checkpoint, fixture.workspaceRoot, fixture.sessionId);

    await expect(assertSessionHitlJournalAllowsExecution(fixture.workspaceRoot, fixture.sessionId)).rejects.toMatchObject({
      name: "SessionHitlJournalBlockedError",
      hitlIds: [checkpoint.hitlId],
    });

    const summary = await recoverSessionHitlJournals({
      workspaceRoot: fixture.workspaceRoot,
      projectSlug: "archcode",
      sessions: fixture.sessions,
      hitl: fixture.hitl,
    });

    expect(summary).toMatchObject({ prepared: 1, manualUnknown: 0 });
    const repaired = await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, checkpoint.hitlId);
    expect(repaired === undefined ? undefined : sessionHitlJournalPhase(repaired)).toBe("paused");
    const ownerFile = await (await fixture.hitl.ownerStore(fixture.owner)).read();
    expect(ownerFile.pending).toHaveLength(1);
    expect(ownerFile.pending[0]).toMatchObject({ hitlId: checkpoint.hitlId, blockingKey: checkpoint.blockingKey });

    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().blockedByHitlIds).toEqual([checkpoint.hitlId]);
    expect(coldStore.getState().blockedHitl).toMatchObject({ hitlId: checkpoint.hitlId });
  });

  test("cold user-message entry fails closed on a prepared journal even before the Session blocker snapshot", async () => {
    const fixture = await createFixture();
    const checkpoint = preparingCheckpoint(fixture);
    await writeSessionHitlCheckpoint(checkpoint, fixture.workspaceRoot, fixture.sessionId);
    const manager = new SessionExecutionManager({
      sessionAgentManager: {} as SessionAgentManager,
      createSessionStore: (sessionId, workspaceRoot, options) => fixture.sessions.create(sessionId, workspaceRoot, options),
      flushSessionStore: (sessionId, workspaceRoot) => fixture.sessions.flushSession(sessionId, workspaceRoot),
      getSessionStore: (sessionId, workspaceRoot) => fixture.sessions.get(sessionId, workspaceRoot),
      loadSessionStore: (sessionId, workspaceRoot) => fixture.sessions.getOrLoad(sessionId, workspaceRoot),
      deleteSessionStore: (sessionId, workspaceRoot, options) => fixture.sessions.delete(sessionId, workspaceRoot, options),
      resolveRootSessionId: (sessionId, workspaceRoot) => fixture.sessions.resolveRootSessionId(sessionId, workspaceRoot),
      buildSessionTree: (workspaceRoot, rootSessionId) => fixture.sessions.buildSessionTree(workspaceRoot, rootSessionId),
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
      hitlIds: [checkpoint.hitlId],
    });
    expect(manager.isRunning(fixture.workspaceRoot, fixture.sessionId)).toBe(false);
  });

  test("cold recovery completes the owner-created boundary without duplicating the visible request", async () => {
    const fixture = await createFixture();
    const checkpoint = preparingCheckpoint(fixture);
    await writeSessionHitlCheckpoint(checkpoint, fixture.workspaceRoot, fixture.sessionId);
    await fixture.hitl.create({
      owner: fixture.owner,
      hitlId: checkpoint.hitlId,
      blockingKey: checkpoint.blockingKey,
      source: checkpoint.source,
      displayPayload: checkpoint.request!.displayPayload,
      createdAt: checkpoint.request!.createdAt,
    });

    await recoverSessionHitlJournals({
      workspaceRoot: fixture.workspaceRoot,
      projectSlug: "archcode",
      sessions: fixture.sessions,
      hitl: fixture.hitl,
    });

    const ownerFile = await (await fixture.hitl.ownerStore(fixture.owner)).read();
    expect(ownerFile.pending).toHaveLength(1);
    expect(ownerFile.pending[0]?.hitlId).toBe(checkpoint.hitlId);
    const repaired = await readSessionHitlCheckpoint(fixture.workspaceRoot, fixture.sessionId, checkpoint.hitlId);
    expect(repaired === undefined ? undefined : sessionHitlJournalPhase(repaired)).toBe("paused");
  });

  test("repair rekeys a prepared journal onto a reused blocking-key record without cancelling it", async () => {
    const fixture = await createFixture();
    const checkpoint = preparingCheckpoint(fixture);
    const existing = await fixture.hitl.create({
      owner: fixture.owner,
      blockingKey: checkpoint.blockingKey,
      source: checkpoint.source,
      displayPayload: checkpoint.request!.displayPayload,
    });
    expect(existing.hitlId).not.toBe(checkpoint.hitlId);
    await writeSessionHitlCheckpoint(checkpoint, fixture.workspaceRoot, fixture.sessionId);

    await recoverSessionHitlJournals({
      workspaceRoot: fixture.workspaceRoot,
      projectSlug: "archcode",
      sessions: fixture.sessions,
      hitl: fixture.hitl,
    });

    const file = await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId);
    expect(file.checkpoints).toHaveLength(1);
    expect(file.checkpoints[0]?.hitlId).toBe(existing.hitlId);
    expect(sessionHitlJournalPhase(file.checkpoints[0]!)).toBe("paused");
    const ownerFile = await (await fixture.hitl.ownerStore(fixture.owner)).read();
    expect(ownerFile.pending).toHaveLength(1);
    expect(ownerFile.pending[0]).toMatchObject({ hitlId: existing.hitlId, status: "pending" });
    expect(ownerFile.recentTerminal).toEqual([]);

    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldStore = await coldSessions.getOrLoad(fixture.sessionId, fixture.workspaceRoot);
    expect(coldStore.getState().blockedByHitlIds).toEqual([existing.hitlId]);
  });

  test("serializes checkpoint reads with concurrent journal mutations", async () => {
    const fixture = await createFixture();
    const checkpoints = Array.from({ length: 24 }, (_, index) => indexedCheckpoint(fixture, index));
    for (const checkpoint of checkpoints.slice(0, 12)) {
      await writeSessionHitlCheckpoint(checkpoint, fixture.workspaceRoot, fixture.sessionId);
    }

    await Promise.all([
      ...checkpoints.slice(12).map((checkpoint) => (
        writeSessionHitlCheckpoint(checkpoint, fixture.workspaceRoot, fixture.sessionId)
      )),
      ...Array.from({ length: 96 }, () => (
        readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId)
      )),
    ]);

    const file = await readSessionHitlCheckpointFile(fixture.workspaceRoot, fixture.sessionId);
    expect(file.checkpoints.map((checkpoint) => checkpoint.hitlId).sort()).toEqual(
      checkpoints.map((checkpoint) => checkpoint.hitlId).sort(),
    );
  });
});

async function createFixture() {
  const workspaceRoot = TMP_ROOT;
  const sessionId = crypto.randomUUID();
  const sessions = new SessionStoreManager({ logger: silentLogger });
  sessions.create(sessionId, workspaceRoot);
  await sessions.flushSession(sessionId, workspaceRoot);
  const goalState = new GoalStateManager(workspaceRoot, silentLogger);
  const loopState = new LoopStateManager(workspaceRoot, silentLogger);
  const hitl = new HitlService({
    workspaceRoot,
    project: { slug: "archcode", name: "ArchCode" },
    sessions,
    goalState,
    loopState,
  });
  await hitl.load(workspaceRoot);
  const owner: HitlOwnerKey = { projectSlug: "archcode", ownerType: "session", ownerId: sessionId };
  return { workspaceRoot, sessionId, sessions, hitl, owner };
}

function preparingCheckpoint(fixture: Awaited<ReturnType<typeof createFixture>>): SessionHitlCheckpointRecord {
  const hitlId = crypto.randomUUID();
  const source: HitlSource = {
    type: "tool_permission",
    sessionId: fixture.sessionId,
    toolCallId: "journal-tool-call",
    toolName: "file_write",
  };
  const createdAt = new Date().toISOString();
  return {
    version: 1,
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
    toolCalls: [{ toolCallId: "journal-tool-call", toolName: "file_write", input: { path: "README.md", content: "changed" } }],
    completedToolResults: [],
    pendingToolCalls: [{ toolCallId: "journal-tool-call", toolName: "file_write", input: { path: "README.md", content: "changed" } }],
    blockedToolIndex: 0,
    createdAt,
    kind: "permission",
    permission: { description: "Write README" },
  };
}

function indexedCheckpoint(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  index: number,
): SessionHitlCheckpointRecord {
  const checkpoint = preparingCheckpoint(fixture);
  const toolCallId = `journal-tool-call-${index}`;
  return {
    ...checkpoint,
    hitlId: `journal-hitl-${index}`,
    blockingKey: `session:${fixture.sessionId}:tool:${toolCallId}`,
    source: { type: "tool_permission", sessionId: fixture.sessionId, toolCallId, toolName: "file_write" },
    toolCallId,
    toolCalls: [{ toolCallId, toolName: "file_write", input: checkpoint.rawToolInput }],
    pendingToolCalls: [{ toolCallId, toolName: "file_write", input: checkpoint.rawToolInput }],
  };
}
