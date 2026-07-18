import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { GoalState } from "@archcode/protocol";
import { hashDelegationContract } from "../delegation/contract";

import type {
  AcquireSessionFamilyStopInput,
  SessionFamilyController,
  SessionFamilyStopLease,
} from "../execution/session-family-control";
import { SessionFamilyStopConflictError } from "../execution/session-family-control";
import { silentLogger } from "../logger";
import { SessionStoreManager } from "../store/session-store-manager";
import { testReviewExecutionFields } from "./test-review-fixture";
import {
  GoalCancellationCleanupError,
  GoalCancellationError,
  GoalCancellationService,
} from "./cancellation";
import { GoalCancellationInProgressError, withGoalExecutionClaimLock } from "./execution-claim";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-cancellation", crypto.randomUUID());

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

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

async function createFixture() {
  const goalState = new GoalStateManager(TMP_ROOT, silentLogger);
  const sessions = new SessionStoreManager({ logger: silentLogger });
  const families = new FakeFamilyController();
  const cancelSessionToolBatch = mock(async (_sessionId: string, _workspaceRoot: string, _reason: string) => undefined);
  const cancelGoalBudgetHitl = mock(async (_hitlId: string, _reason: string) => undefined);
  const service = new GoalCancellationService({
    workspaceRoot: TMP_ROOT,
    goalStateManager: goalState,
    sessionStoreManager: sessions,
    sessionFamilyController: families,
    cancelSessionToolBatch,
    cancelGoalBudgetHitl,
  });
  return {
    goalState,
    sessions,
    families,
    cancelSessionToolBatch,
    cancelGoalBudgetHitl,
    service,
  };
}

async function createRunningGoal(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  mainSessionId = crypto.randomUUID(),
): Promise<GoalState> {
  const goal = await fixture.goalState.commit({
    id: crypto.randomUUID(),
    projectSlug: "project-a",
    createdFromSessionId: crypto.randomUUID(),
    objective: "Cancel every durable execution owner safely.",
    acceptanceCriteria: "All Session families stop before cleanup.",
    mainSessionId,
  });
  fixture.sessions.create(mainSessionId, TMP_ROOT, {
    goalId: goal.id,
    sessionRole: "main",
    agentName: "goal_lead",
  });
  await fixture.sessions.flushSession(mainSessionId, TMP_ROOT);
  return goal;
}

async function attachBudgetApproval(fixture: Awaited<ReturnType<typeof createFixture>>, goalId: string, hitlId: string): Promise<void> {
  await fixture.goalState.updateBudgetSummary(goalId, {
    status: "warning",
    usedTokens: 90,
    maxTokens: 100,
    updatedAt: new Date().toISOString(),
  });
  await fixture.goalState.attachBudgetApproval(goalId, {
    hitlId,
    approvalPoint: "warning-1",
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for cancellation state");
    await Bun.sleep(1);
  }
}

describe("GoalCancellationService", () => {
  test("drains every owned family, settles the captured budget HITL, commits cancellation, then cleans Session batches", async () => {
    const fixture = await createFixture();
    const mainId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    const independentRootId = crypto.randomUUID();
    let goal = await createRunningGoal(fixture, mainId);
    const childContract = {
      agent_type: "build" as const,
      title: "Build child",
      objective: "Build the delegated scope",
      owned_scope: [{ kind: "tree" as const, path: "src" }],
      non_goals: [],
      acceptance_criteria: [{ id: "acceptance", condition: "Scope is complete", requiredEvidence: "Tests" }],
      evidence: [],
      verification: [],
      depends_on: [],
      skills: [],
      background: false,
    };
    fixture.sessions.create(childId, TMP_ROOT, {
      rootSessionId: mainId,
      parentSessionId: mainId,
      goalId: goal.id,
      sessionRole: "build",
      agentName: "build",
      delegationContract: childContract,
      delegationContractHash: hashDelegationContract(childContract),
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
    const budgetHitlId = crypto.randomUUID();
    await attachBudgetApproval(fixture, goal.id, budgetHitlId);

    fixture.cancelSessionToolBatch.mockImplementation(async () => {
      expect((await fixture.goalState.read(goal.id)).status).toBe("cancelled");
    });
    fixture.cancelGoalBudgetHitl.mockImplementation(async () => {
      expect((await fixture.goalState.read(goal.id)).status).toBe("running");
    });

    const cancelled = await fixture.service.cancel(goal.id, { source: "http", reason: "user cancelled" });

    expect(cancelled).toMatchObject({ status: "cancelled", lastFailureSummary: "user cancelled" });
    expect(cancelled.budgetApproval).toBeUndefined();
    expect(fixture.families.acquired.map((input) => input.rootSessionId)).toEqual([mainId, independentRootId].sort());
    expect([...fixture.families.stopped].sort()).toEqual([mainId, independentRootId].sort());
    expect([...fixture.families.released].sort()).toEqual([mainId, independentRootId].sort());
    expect(fixture.cancelSessionToolBatch.mock.calls).toEqual(
      [mainId, childId, independentRootId].sort().map((sessionId) => [sessionId, TMP_ROOT, "goal_cancelled"]),
    );
    expect(fixture.cancelGoalBudgetHitl).toHaveBeenCalledTimes(1);
    expect(fixture.cancelGoalBudgetHitl).toHaveBeenCalledWith(budgetHitlId, "goal_cancelled");
  });

  test("does not scan or cancel Goal HITL when no pre-cancel budget approval exists", async () => {
    const fixture = await createFixture();
    const goal = await createRunningGoal(fixture);

    await fixture.service.cancel(goal.id, { source: "http" });

    expect(fixture.cancelSessionToolBatch).toHaveBeenCalledTimes(1);
    expect(fixture.cancelGoalBudgetHitl).not.toHaveBeenCalled();
  });

  test("does not commit or clean up when a family cannot stop", async () => {
    const fixture = await createFixture();
    const goal = await createRunningGoal(fixture);
    const mainId = goal.mainSessionId;
    fixture.families.stopByRoot.set(mainId, async () => {
      throw new SessionFamilyStopConflictError(mainId, ["stuck-child"]);
    });

    await expect(fixture.service.cancel(goal.id, { source: "agent", selfSessionId: mainId }))
      .rejects.toBeInstanceOf(SessionFamilyStopConflictError);

    expect(fixture.families.acquired).toEqual([{
      workspaceRoot: TMP_ROOT,
      rootSessionId: mainId,
      exemptSessionId: mainId,
    }]);
    expect((await fixture.goalState.read(goal.id)).status).toBe("running");
    expect(fixture.cancelSessionToolBatch).not.toHaveBeenCalled();
    expect(fixture.cancelGoalBudgetHitl).not.toHaveBeenCalled();
  });

  test("holds every stop lease until all families settle", async () => {
    const fixture = await createFixture();
    const firstRootId = crypto.randomUUID();
    const secondRootId = crypto.randomUUID();
    let goal = await createRunningGoal(fixture, firstRootId);
    fixture.sessions.create(secondRootId, TMP_ROOT, { goalId: goal.id, sessionRole: "build", agentName: "build" });
    await fixture.sessions.flushSession(secondRootId, TMP_ROOT);
    goal = await fixture.goalState.addChildSession(goal.id, secondRootId);
    const orderedRoots = [firstRootId, secondRootId].sort();
    const slowStop = deferred<void>();
    fixture.families.stopByRoot.set(orderedRoots[0]!, async () => {
      throw new SessionFamilyStopConflictError(orderedRoots[0]!, [orderedRoots[0]!]);
    });
    fixture.families.stopByRoot.set(orderedRoots[1]!, async () => await slowStop.promise);

    let settled = false;
    const cancellation = fixture.service.cancel(goal.id, { source: "http" }).finally(() => { settled = true; });
    void cancellation.catch(() => undefined);
    await waitFor(() => fixture.families.stopped.length === 2);
    expect(settled).toBe(false);
    expect(fixture.families.released).toHaveLength(0);

    slowStop.resolve(undefined);
    await expect(cancellation).rejects.toBeInstanceOf(SessionFamilyStopConflictError);
    expect([...fixture.families.released].sort()).toEqual(orderedRoots);
    expect((await fixture.goalState.read(goal.id)).status).toBe("running");
  });

  test("keeps the cancelled tombstone when idempotent batch cleanup fails", async () => {
    const fixture = await createFixture();
    const goal = await createRunningGoal(fixture);
    let failed = false;
    fixture.cancelSessionToolBatch.mockImplementation(async () => {
      if (!failed) {
        failed = true;
        throw new Error("injected batch cleanup failure");
      }
    });

    await expect(fixture.service.cancel(goal.id, { source: "http" }))
      .rejects.toBeInstanceOf(GoalCancellationCleanupError);
    expect((await fixture.goalState.read(goal.id)).status).toBe("cancelled");

    await expect(fixture.service.cancel(goal.id, { source: "agent" })).resolves.toMatchObject({ status: "cancelled" });
    expect(fixture.cancelSessionToolBatch).toHaveBeenCalledTimes(2);
  });

  test("cancellation intent wins atomically over Reviewer finalization", async () => {
    const fixture = await createFixture();
    let goal = await createRunningGoal(fixture);
    goal = await fixture.goalState.beginReview(goal.id);
    const stopGate = deferred<void>();
    fixture.families.stopByRoot.set(goal.mainSessionId, async () => await stopGate.promise);

    const cancellation = fixture.service.cancel(goal.id, { source: "http" });
    await waitFor(() => fixture.families.stopped.length === 1);

    await expect(withGoalExecutionClaimLock(goal.id, () => fixture.goalState.finalizeReview(goal.id, {
      expectedReviewGeneration: goal.reviewGeneration,
      verdict: "DONE",
      ...testReviewExecutionFields("DONE"),
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
    expect((await cancellation).status).toBe("cancelled");
  });

  test("a completed Goal cannot trigger cleanup", async () => {
    const fixture = await createFixture();
    let goal = await createRunningGoal(fixture);
    goal = await fixture.goalState.beginReview(goal.id);
    await fixture.goalState.finalizeReview(goal.id, {
      expectedReviewGeneration: goal.reviewGeneration,
      verdict: "DONE",
      ...testReviewExecutionFields("DONE"),
      summary: "Complete",
      evidenceRefs: [{ kind: "test_output", ref: "tests", summary: "Tests passed" }],
      authorization: {
        agentName: "reviewer",
        sessionRole: "review",
        sessionGoalId: goal.id,
        reviewerSessionId: "review-session",
      },
    });

    await expect(fixture.service.cancel(goal.id, { source: "http" })).rejects.toBeInstanceOf(GoalCancellationError);
    expect(fixture.families.acquired).toHaveLength(0);
    expect(fixture.cancelSessionToolBatch).not.toHaveBeenCalled();
  });
});
