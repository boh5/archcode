import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalState } from "@archcode/protocol";

import type {
  AcquireSessionFamilyStopInput,
  SessionFamilyController,
  SessionFamilyStopLease,
} from "../execution/session-family-control";
import { SessionFamilyStopConflictError } from "../execution/session-family-control";
import {
  deleteSessionHitlCheckpointFile,
  getSessionHitlCheckpointPath,
  writeSessionHitlCheckpoint,
} from "../execution/session-hitl-checkpoint";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import type { SessionStoreState } from "../store/types";
import {
  GoalCancellationCleanupError,
  GoalCancellationError,
  GoalCancellationService,
  type GoalCancellationCleanupOperations,
} from "./cancellation";
import { GoalCancellationInProgressError, withGoalExecutionClaimLock } from "./execution-claim";
import { GoalHitlResumeAdapter } from "./hitl-resume-adapter";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-cancellation");

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class FakeFamilyController implements SessionFamilyController {
  readonly acquired: AcquireSessionFamilyStopInput[] = [];
  readonly stopped: string[] = [];
  readonly released: string[] = [];
  readonly stopByRoot = new Map<string, () => Promise<void>>();

  acquireStop(input: AcquireSessionFamilyStopInput): SessionFamilyStopLease {
    this.acquired.push(input);
    let released = false;
    return {
      rootSessionId: input.rootSessionId,
      stopAndWait: async () => {
        this.stopped.push(input.rootSessionId);
        await this.stopByRoot.get(input.rootSessionId)?.();
      },
      release: () => {
        if (released) return;
        released = true;
        this.released.push(input.rootSessionId);
      },
    };
  }
}

interface Fixture {
  readonly goalState: GoalStateManager;
  readonly sessions: SessionStoreManager;
  readonly hitl: HitlService;
  readonly families: FakeFamilyController;
  readonly service: GoalCancellationService;
}

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

async function createFixture(): Promise<Fixture> {
  const goalState = new GoalStateManager(TMP_ROOT, silentLogger);
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const hitl = new HitlService({
    workspaceRoot: TMP_ROOT,
    project: { slug: "project-a", name: "Project A" },
    sessions,
    goalState,
    loopState: new LoopStateManager(TMP_ROOT, silentLogger),
    logger: silentLogger,
  });
  const families = new FakeFamilyController();
  const service = new GoalCancellationService({
    workspaceRoot: TMP_ROOT,
    goalStateManager: goalState,
    hitlService: hitl,
    sessionStoreManager: sessions,
    sessionFamilyController: families,
  });
  return { goalState, sessions, hitl, families, service };
}

async function createRunningGoal(
  fixture: Fixture,
  mainSessionId = crypto.randomUUID(),
): Promise<GoalState> {
  const goal = await fixture.goalState.create({
    projectId: "project-a",
    objective: "Cancel every durable execution owner safely.",
    acceptanceCriteria: "All Session families stop and durable blockers are cleared.",
    mainSessionId,
  });
  fixture.sessions.create(mainSessionId, TMP_ROOT, {
    goalId: goal.id,
    sessionRole: "main",
    agentName: "orchestrator",
  });
  await fixture.sessions.flushSession(mainSessionId, TMP_ROOT);
  return await fixture.goalState.start(goal.id, { mainSessionId });
}

function hitlInput(ownerId: string, ownerType: "session" | "goal", hitlId: string) {
  return {
    hitlId,
    owner: { projectSlug: "project-a", ownerType, ownerId },
    blockingKey: `${ownerType}:${ownerId}:${hitlId}`,
    source: ownerType === "session"
      ? { type: "ask_user" as const, sessionId: ownerId, toolCallId: "ask-1" }
      : { type: "goal_approval" as const, goalId: ownerId, approvalPoint: "cancel-test", resumeStatus: "running" as const },
    displayPayload: {
      title: "Pending approval",
      summary: "Wait for a human decision.",
      fields: [],
      redacted: true as const,
    },
  };
}

function blockedHitl(hitlId: string): NonNullable<SessionStoreState["blockedHitl"]> {
  return {
    version: 1,
    hitlId,
    blockingKey: `session:blocked:${hitlId}`,
    source: { type: "ask_user", sessionId: "main", toolCallId: "ask-1" },
    toolCallId: "ask-1",
    toolName: "ask_user",
    step: 1,
    displayInput: { question: "Continue?" },
    blockedAt: new Date().toISOString(),
    reason: "Waiting for user",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for cancellation state");
    await Bun.sleep(1);
  }
}

describe("GoalCancellationService", () => {
  test("stops all independent root families and durably clears Goal, Session, HITL, and checkpoint blockers", async () => {
    const fixture = await createFixture();
    const mainId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const independentRootId = crypto.randomUUID();
    let goal = await createRunningGoal(fixture, mainId);
    fixture.sessions.create(childId, TMP_ROOT, {
      rootSessionId: mainId,
      parentSessionId: mainId,
      goalId: goal.id,
      sessionRole: "build",
      agentName: "build",
    });
    fixture.sessions.create(independentRootId, TMP_ROOT, {
      goalId: goal.id,
      sessionRole: "build",
      agentName: "build",
    });
    await Promise.all([
      fixture.sessions.flushSession(childId, TMP_ROOT),
      fixture.sessions.flushSession(independentRootId, TMP_ROOT),
    ]);
    goal = await fixture.goalState.addChildSession(goal.id, childId);
    goal = await fixture.goalState.addChildSession(goal.id, independentRootId);

    const sessionHitlId = crypto.randomUUID();
    const goalHitlId = crypto.randomUUID();
    const sessionRecord = await fixture.hitl.create(hitlInput(mainId, "session", sessionHitlId));
    const goalRecord = await fixture.hitl.create(hitlInput(goal.id, "goal", goalHitlId));
    await fixture.goalState.attachHitlBlocker(goal.id, {
      blocker: {
        kind: "approval",
        summary: "Goal approval pending",
        hitlId: goalHitlId,
        resumeStatus: "running",
      },
      approvalRef: goalHitlId,
    });
    const mainStore = fixture.sessions.get(mainId, TMP_ROOT)!;
    mainStore.getState().append({
      type: "execution-end",
      status: "waiting_for_human",
      blockedByHitlIds: [sessionHitlId],
      blockedToolCallId: "ask-1",
      blockedHitl: blockedHitl(sessionHitlId),
    });
    await fixture.sessions.flushSession(mainId, TMP_ROOT);
    const checkpointCreatedAt = new Date().toISOString();
    await writeSessionHitlCheckpoint({
      version: 1,
      phase: "paused",
      phaseUpdatedAt: checkpointCreatedAt,
      hitlId: sessionHitlId,
      blockingKey: `session:${mainId}:ask-1`,
      source: { type: "ask_user", sessionId: mainId, toolCallId: "ask-1" },
      request: {
        owner: { projectSlug: "project-a", ownerType: "session", ownerId: mainId },
        displayPayload: { title: "Pending approval", summary: "Wait for a human decision.", fields: [], redacted: true },
        createdAt: checkpointCreatedAt,
      },
      toolCallId: "ask-1",
      toolName: "ask_user",
      step: 1,
      rawToolInput: {},
      displayInput: {},
      allowedTools: ["ask_user"],
      agentSkills: [],
      agentName: "orchestrator",
      toolCalls: [{ toolCallId: "ask-1", toolName: "ask_user", input: {} }],
      completedToolResults: [],
      pendingToolCalls: [{ toolCallId: "ask-1", toolName: "ask_user", input: {} }],
      blockedToolIndex: 0,
      createdAt: checkpointCreatedAt,
      kind: "ask_user",
    }, TMP_ROOT, mainId);

    const cancelled = await fixture.service.cancel(goal.id, { source: "http", reason: "user cancelled" });

    const expectedRoots = [mainId, independentRootId].sort();
    expect(fixture.families.acquired.map((input) => input.rootSessionId)).toEqual(expectedRoots);
    expect([...fixture.families.stopped].sort()).toEqual(expectedRoots);
    expect([...fixture.families.released].sort()).toEqual(expectedRoots);
    expect(cancelled).toMatchObject({ status: "cancelled", pendingHitlIds: [] });
    expect(cancelled.blocker).toBeUndefined();
    expect(await Bun.file(getSessionHitlCheckpointPath(TMP_ROOT, mainId)).exists()).toBe(false);

    const coldSessions = new SessionStoreManager({ logger: silentLogger });
    const coldMain = await coldSessions.getOrLoad(mainId, TMP_ROOT);
    expect(coldMain.getState().blockedByHitlIds).toBeUndefined();
    expect(coldMain.getState().blockedHitl).toBeUndefined();
    expect(await fixture.hitl.lookup({ owner: sessionRecord.owner, hitlId: sessionRecord.hitlId })).toMatchObject({
      status: "found",
      record: { status: "cancelled", response: { type: "cancel", reason: "goal_cancelled" } },
    });
    expect(await fixture.hitl.lookup({ owner: goalRecord.owner, hitlId: goalRecord.hitlId })).toMatchObject({
      status: "found",
      record: { status: "cancelled", response: { type: "cancel", reason: "goal_cancelled" } },
    });
  });

  test("does not commit cancellation when root self-cancel cannot stop a child", async () => {
    const fixture = await createFixture();
    const goal = await createRunningGoal(fixture);
    const mainId = goal.mainSessionId!;
    const childId = crypto.randomUUID();
    fixture.families.stopByRoot.set(mainId, async () => {
      throw new SessionFamilyStopConflictError(mainId, [childId]);
    });

    await expect(fixture.service.cancel(goal.id, {
      source: "agent",
      selfSessionId: mainId,
    })).rejects.toMatchObject({
      name: "SessionFamilyStopConflictError",
      rootSessionId: mainId,
      stuckSessionIds: [childId],
    });

    expect(fixture.families.acquired).toEqual([{
      workspaceRoot: TMP_ROOT,
      rootSessionId: mainId,
      exemptSessionId: mainId,
    }]);
    expect((await fixture.goalState.read(goal.id)).status).toBe("running");
  });

  test("keeps every root stop generation held until all families settle after one failure", async () => {
    const fixture = await createFixture();
    const firstRootId = crypto.randomUUID();
    const secondRootId = crypto.randomUUID();
    let goal = await createRunningGoal(fixture, firstRootId);
    fixture.sessions.create(secondRootId, TMP_ROOT, {
      goalId: goal.id,
      sessionRole: "build",
      agentName: "build",
    });
    await fixture.sessions.flushSession(secondRootId, TMP_ROOT);
    goal = await fixture.goalState.addChildSession(goal.id, secondRootId);
    const orderedRoots = [firstRootId, secondRootId].sort();
    const slowRootId = orderedRoots[1]!;
    const failedRootId = orderedRoots[0]!;
    const slowStop = deferred<void>();
    fixture.families.stopByRoot.set(failedRootId, async () => {
      throw new SessionFamilyStopConflictError(failedRootId, [failedRootId]);
    });
    fixture.families.stopByRoot.set(slowRootId, async () => await slowStop.promise);

    let settled = false;
    const cancellation = fixture.service.cancel(goal.id, { source: "http" }).finally(() => { settled = true; });
    void cancellation.catch(() => undefined);
    await waitFor(() => fixture.families.stopped.length === 2);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fixture.families.released).toHaveLength(0);

    slowStop.resolve(undefined);
    await expect(cancellation).rejects.toBeInstanceOf(SessionFamilyStopConflictError);
    expect([...fixture.families.released].sort()).toEqual(orderedRoots);
    expect((await fixture.goalState.read(goal.id)).status).toBe("running");
  });

  test("cancellation intent wins atomically over Reviewer finalization", async () => {
    const fixture = await createFixture();
    let goal = await createRunningGoal(fixture);
    goal = await fixture.goalState.beginReview(goal.id);
    const stopGate = deferred<void>();
    fixture.families.stopByRoot.set(goal.mainSessionId!, async () => await stopGate.promise);

    const cancellation = fixture.service.cancel(goal.id, { source: "http" });
    await waitFor(() => fixture.families.stopped.length === 1);

    await expect(withGoalExecutionClaimLock(goal.id, () => fixture.goalState.finalizeReview(goal.id, {
      verdict: "DONE",
      summary: "Reviewer attempted to finish during cancellation",
      evidenceRefs: [{ kind: "test_output", ref: "tests", summary: "Tests passed" }],
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: goal.id,
        reviewerSessionId: "review-session",
      },
    }))).rejects.toBeInstanceOf(GoalCancellationInProgressError);

    stopGate.resolve(undefined);
    const cancelled = await cancellation;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.review).toBeUndefined();
  });

  test("Reviewer finalization that owns the claim first prevents cleanup and cancellation", async () => {
    const fixture = await createFixture();
    let goal = await createRunningGoal(fixture);
    goal = await fixture.goalState.beginReview(goal.id);
    const hitlId = crypto.randomUUID();
    const hitlRecord = await fixture.hitl.create(hitlInput(goal.id, "goal", hitlId));
    const reviewEntered = deferred<void>();
    const releaseReview = deferred<void>();
    const finalize = withGoalExecutionClaimLock(goal.id, async () => {
      reviewEntered.resolve(undefined);
      await releaseReview.promise;
      return await fixture.goalState.finalizeReview(goal.id, {
        verdict: "DONE",
        summary: "Reviewer finished first",
        evidenceRefs: [{ kind: "test_output", ref: "tests", summary: "Tests passed" }],
        authorization: {
          agentName: "reviewer",
          sessionRole: "review",
          sessionGoalId: goal.id,
          reviewerSessionId: "review-session",
        },
      });
    });
    await reviewEntered.promise;
    const cancellation = fixture.service.cancel(goal.id, { source: "http" });
    releaseReview.resolve(undefined);

    expect((await finalize).status).toBe("done");
    await expect(cancellation).rejects.toBeInstanceOf(GoalCancellationError);
    expect(fixture.families.acquired).toHaveLength(0);
    expect(await fixture.hitl.lookup({ owner: hitlRecord.owner, hitlId: hitlRecord.hitlId })).toMatchObject({
      status: "found",
      record: { status: "pending" },
    });
  });

  for (const failurePhase of ["session_hitl", "checkpoint", "session_blocker", "goal_hitl"] as const) {
    test(`persists the cancelled tombstone before ${failurePhase} cleanup failure and reconciles idempotently`, async () => {
      const fixture = await createFixture();
      const goal = await createRunningGoal(fixture);
      const mainId = goal.mainSessionId!;
      const sessionHitlId = crypto.randomUUID();
      const goalHitlId = crypto.randomUUID();
      const sessionRecord = await fixture.hitl.create(hitlInput(mainId, "session", sessionHitlId));
      const goalRecord = await fixture.hitl.create(hitlInput(goal.id, "goal", goalHitlId));
      await fixture.goalState.attachHitlBlocker(goal.id, {
        blocker: {
          kind: "approval",
          summary: "Goal approval pending",
          hitlId: goalHitlId,
          resumeStatus: "running",
        },
        approvalRef: goalHitlId,
      });
      const mainStore = fixture.sessions.get(mainId, TMP_ROOT)!;
      mainStore.getState().append({
        type: "execution-end",
        status: "waiting_for_human",
        blockedByHitlIds: [sessionHitlId],
        blockedToolCallId: "ask-1",
        blockedHitl: blockedHitl(sessionHitlId),
      });
      await fixture.sessions.flushSession(mainId, TMP_ROOT);
      const checkpointCreatedAt = new Date().toISOString();
      await writeSessionHitlCheckpoint({
        version: 1,
        phase: "paused",
        phaseUpdatedAt: checkpointCreatedAt,
        hitlId: sessionHitlId,
        blockingKey: `session:${mainId}:ask-1`,
        source: { type: "ask_user", sessionId: mainId, toolCallId: "ask-1" },
        request: {
          owner: { projectSlug: "project-a", ownerType: "session", ownerId: mainId },
          displayPayload: { title: "Pending approval", summary: "Wait for a human decision.", fields: [], redacted: true },
          createdAt: checkpointCreatedAt,
        },
        toolCallId: "ask-1",
        toolName: "ask_user",
        step: 1,
        rawToolInput: {},
        displayInput: {},
        allowedTools: ["ask_user"],
        agentSkills: [],
        agentName: "orchestrator",
        toolCalls: [{ toolCallId: "ask-1", toolName: "ask_user", input: {} }],
        completedToolResults: [],
        pendingToolCalls: [{ toolCallId: "ask-1", toolName: "ask_user", input: {} }],
        blockedToolIndex: 0,
        createdAt: checkpointCreatedAt,
        kind: "ask_user",
      }, TMP_ROOT, mainId);

      let injected = false;
      const maybeFail = (phase: typeof failurePhase): void => {
        if (!injected && failurePhase === phase) {
          injected = true;
          throw new Error(`injected ${phase} cleanup failure`);
        }
      };
      const cleanupOperations: GoalCancellationCleanupOperations = {
        cancelOwner: async (owner, reason) => {
          maybeFail(owner.ownerType === "goal" ? "goal_hitl" : "session_hitl");
          return await fixture.hitl.cancelOwner(owner, reason);
        },
        deleteSessionCheckpoint: async (workspaceRoot, sessionId) => {
          maybeFail("checkpoint");
          await deleteSessionHitlCheckpointFile(workspaceRoot, sessionId);
        },
        clearSessionHitlBlockers: async (sessionId, workspaceRoot) => {
          maybeFail("session_blocker");
          await fixture.sessions.clearHitlBlockers(sessionId, workspaceRoot);
        },
      };
      const service = new GoalCancellationService({
        workspaceRoot: TMP_ROOT,
        goalStateManager: fixture.goalState,
        hitlService: fixture.hitl,
        sessionStoreManager: fixture.sessions,
        sessionFamilyController: fixture.families,
        cleanupOperations,
      });

      await expect(service.cancel(goal.id, { source: "http" }))
        .rejects.toBeInstanceOf(GoalCancellationCleanupError);
      const coldGoalState = new GoalStateManager(TMP_ROOT, silentLogger);
      const committed = await coldGoalState.read(goal.id);
      expect(committed).toMatchObject({ status: "cancelled", pendingHitlIds: [] });
      expect(committed.blocker).toBeUndefined();
      await expect(fixture.goalState.start(goal.id, { mainSessionId: mainId })).rejects.toThrow();
      await expect(fixture.goalState.retry(goal.id, { mainSessionId: mainId })).rejects.toThrow();
      await expect(new GoalHitlResumeAdapter({
        workspaceRoot: TMP_ROOT,
        goalStateManager: fixture.goalState,
        hitlService: fixture.hitl,
        goalCancellation: service,
      }).resume(goalRecord, {
        type: "approval_decision",
        decision: "approved",
      })).rejects.toBeInstanceOf(GoalCancellationError);

      expect((await service.cancel(goal.id, {
        source: "agent",
        selfSessionId: mainId,
      })).status).toBe("cancelled");
      expect((await service.cancel(goal.id, { source: "hitl" })).status).toBe("cancelled");
      expect((await service.cancel(goal.id, { source: "http" })).status).toBe("cancelled");

      const coldSessions = new SessionStoreManager({ logger: silentLogger });
      const coldMain = await coldSessions.getOrLoad(mainId, TMP_ROOT);
      expect(coldMain.getState().blockedByHitlIds).toBeUndefined();
      expect(coldMain.getState().blockedHitl).toBeUndefined();
      expect(await Bun.file(getSessionHitlCheckpointPath(TMP_ROOT, mainId)).exists()).toBe(false);
      expect(await fixture.hitl.lookup({ owner: sessionRecord.owner, hitlId: sessionRecord.hitlId })).toMatchObject({
        status: "found",
        record: { status: "cancelled" },
      });
      expect(await fixture.hitl.lookup({ owner: goalRecord.owner, hitlId: goalRecord.hitlId })).toMatchObject({
        status: "found",
        record: { status: "cancelled" },
      });
    });
  }
});
