import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, DoneResult } from "@archcode/protocol";

import type { HitlResponse } from "../hitl/types";
import { GoalArtifactManager } from "./artifacts";
import { GoalRunner, GoalRunnerError } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-runner");

const condition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

const reviewerDoneConditions: DoneCondition[] = [
  { id: "AC-001", kind: "file_exists", params: { path: "packages/agent-core/src/goals/runner.ts" } },
  { id: "AC-002", kind: "typecheck_pass", params: { command: "bun run typecheck" } },
  { id: "AC-003", kind: "tests_pass", params: { command: "bun test packages/agent-core/src/goals/runner.test.ts" } },
];

let workspaceRoot = "";
let manager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function approvedResponse(): HitlResponse {
  return { hitlId: crypto.randomUUID(), kind: "approval", status: "resolved", response: { decision: "approved" } };
}

function deniedResponse(): HitlResponse {
  return { hitlId: crypto.randomUUID(), kind: "approval", status: "resolved", response: { decision: "denied" } };
}

function passingResult(conditionId = condition.id): DoneResult {
  return { conditionId, passed: true, evidence: "goal_check_done passed", checkedAt: new Date().toISOString() };
}

function failingResult(conditionId = condition.id): DoneResult {
  return { conditionId, passed: false, evidence: "goal_check_done failed", checkedAt: new Date().toISOString() };
}

function customFailingResult(conditionId: string, evidence: string): DoneResult {
  return { conditionId, passed: false, evidence, checkedAt: new Date().toISOString() };
}

async function expectGoalRunnerError(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(GoalRunnerError);
    return;
  }
  throw new Error("Expected GoalRunnerError");
}

function createRunner(options: {
  approval?: HitlResponse;
  sessionIds?: string[];
  pendingHitlGoalIds?: string[];
  activeSessionIds?: string[];
} = {}): GoalRunner {
  const sessionIds = [...(options.sessionIds ?? ["main-session-1", "main-session-2", "main-session-3"])] as string[];
  const pendingHitlGoalIds = new Set(options.pendingHitlGoalIds ?? []);
  const activeSessionIds = new Set(options.activeSessionIds ?? []);

    return new GoalRunner({
      goalStateManager: manager,
      goalArtifacts: new GoalArtifactManager(workspaceRoot),
      workspaceRoot,
    hitlService: {
      request: mock(async () => options.approval ?? approvedResponse()),
      listPending: mock((_projectSlug?: string, goalId?: string) => pendingHitlGoalIds.has(goalId ?? "") ? [{
        hitlId: crypto.randomUUID(),
        sessionId: "pending-session",
        kind: "approval",
        payload: { title: "Approval", message: "Approve?" },
        trigger: { goalId, projectSlug: _projectSlug },
        createdAt: Date.now(),
      }] : []),
    },
    createSession: mock(async () => sessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async (sessionId: string) => activeSessionIds.has(sessionId)),
  });
}

async function lockedGoal(approvalPoints: Array<"after_plan" | "before_complete"> = []) {
  return lockedGoalWithConditions([condition], approvalPoints);
}

async function lockedGoalWithConditions(
  doneConditions: DoneCondition[],
  approvalPoints: Array<"after_plan" | "before_complete"> = [],
) {
  const goal = await manager.create(
    "project-a",
    "Ship goal runner",
    "architect",
    doneConditions,
    { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
    approvalPoints,
  );
  return manager.lock(goal.id, "architect");
}

async function runToReview(goalId: string, runner: GoalRunner): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
}

describe("GoalRunner", () => {
  it("runs the happy path with approval gates, reviewer evidence, and completion", async () => {
    const goal = await lockedGoal(["after_plan", "before_complete"]);
    const runner = createRunner({ approval: approvedResponse() });

    const running = await runner.start(goal.id);
    expect(running.status).toBe("running");
    expect(running.phase).toBe("plan");
    expect(running.mainSessionId).toBe("main-session-1");

    const build = await runner.advancePhase(goal.id, "build");
    expect(build.phase).toBe("build");

    const review = await runner.advancePhase(goal.id, "review");
    expect(review.phase).toBe("review");

    const verifying = await runner.recordReviewerDoneResult(goal.id, condition.id, passingResult());
    expect(verifying.status).toBe("verifying");

    const reviewed = await runner.review(goal.id);
    expect(reviewed.status).toBe("reviewed");

    const completed = await runner.complete(goal.id);
    expect(completed.status).toBe("completed");
  });

  it("claimStart is idempotent for the same main session", async () => {
    const goal = await lockedGoal();
    const runner = createRunner();

    const first = await runner.claimStart(goal.id, "reserved-session");
    const second = await runner.claimStart(goal.id, "reserved-session");

    expect(first.status).toBe("running");
    expect(second).toMatchObject({ status: "running", mainSessionId: "reserved-session" });
  });

  it("claimStart rejects a different reserved session", async () => {
    const goal = await lockedGoal();
    const runner = createRunner();
    await manager.updateSessionIds(goal.id, "reserved-session");

    await expectGoalRunnerError(() => runner.claimStart(goal.id, "other-session"));
    expect(await manager.read(goal.id)).toMatchObject({ status: "locked", mainSessionId: "reserved-session" });
  });

  it("claimStart rejects a different session after running", async () => {
    const goal = await lockedGoal();
    const runner = createRunner();
    await runner.claimStart(goal.id, "main-session");

    await expectGoalRunnerError(() => runner.claimStart(goal.id, "other-session"));
    expect(await manager.read(goal.id)).toMatchObject({ status: "running", mainSessionId: "main-session" });
  });

  it("pauses when after_plan approval is denied", async () => {
    const goal = await lockedGoal(["after_plan"]);
    const runner = createRunner({ approval: deniedResponse() });
    await runner.start(goal.id);

    const paused = await runner.advancePhase(goal.id, "build");

    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("plan");
    expect(paused.lastError).toBe("Approval after_plan denied");
  });

  it("pauses when before_complete approval is denied", async () => {
    const goal = await lockedGoal(["before_complete"]);
    const runner = createRunner({ approval: deniedResponse() });
    await runner.start(goal.id);
    await runner.advancePhase(goal.id, "build");
    await runner.advancePhase(goal.id, "review");
    await runner.recordReviewerDoneResult(goal.id, condition.id, passingResult());
    await runner.review(goal.id);

    const paused = await runner.complete(goal.id);

    expect(paused.status).toBe("paused");
    expect(paused.phase).toBe("review");
    expect(paused.lastError).toBe("Approval before_complete denied");
  });

  it("does not complete without reviewer done evidence", async () => {
    const goal = await lockedGoal();
    const runner = createRunner();
    await runner.start(goal.id);
    await runner.advancePhase(goal.id, "build");
    await runner.advancePhase(goal.id, "review");

    await expectGoalRunnerError(() => runner.complete(goal.id));
    expect((await manager.read(goal.id)).status).toBe("running");
  });

  describe("reviewer done not done", () => {
    it("records three condition results before final DONE and follows the completed path", async () => {
      const goal = await lockedGoalWithConditions(reviewerDoneConditions);
      const runner = createRunner();
      await runToReview(goal.id, runner);

      for (const doneCondition of reviewerDoneConditions) {
        const state = await runner.recordReviewerDoneResult(goal.id, doneCondition.id, passingResult(doneCondition.id));
        expect(state.doneResults[doneCondition.id]?.passed).toBe(true);
      }

      const beforeOutcome = await manager.read(goal.id);
      expect(beforeOutcome.status).toBe("verifying");
      expect(Object.keys(beforeOutcome.doneResults).sort()).toEqual(["AC-001", "AC-002", "AC-003"]);

      const completed = await runner.finalizeReviewerReview(goal.id, "DONE", { summary: "Reviewer verified all Done Conditions." });

      expect(completed.status).toBe("completed");
      const persisted = await manager.read(goal.id);
      expect(persisted.reviewReport).toMatchObject({ outcome: "DONE", summary: "Reviewer verified all Done Conditions." });
      expect(persisted.reviewReport?.criteria).toHaveLength(3);
      expect(persisted.repairContext).toBeUndefined();
    });

    it("preserves before_complete approval behavior for final DONE", async () => {
      const goal = await lockedGoalWithConditions(reviewerDoneConditions, ["before_complete"]);
      const runner = createRunner({ approval: deniedResponse() });
      await runToReview(goal.id, runner);
      for (const doneCondition of reviewerDoneConditions) {
        await runner.recordReviewerDoneResult(goal.id, doneCondition.id, passingResult(doneCondition.id));
      }

      const paused = await runner.finalizeReviewerReview(goal.id, "DONE");

      expect(paused.status).toBe("paused");
      expect(paused.phase).toBe("review");
      expect(paused.reviewReport?.outcome).toBe("DONE");
      expect(paused.lastError).toBe("Approval before_complete denied");
    });

    it("returns NOT_DONE with structured repair context for missing required evidence", async () => {
      const goal = await lockedGoalWithConditions(reviewerDoneConditions);
      const runner = createRunner();
      await runToReview(goal.id, runner);
      await runner.recordReviewerDoneResult(goal.id, "AC-001", passingResult("AC-001"));

      const failed = await runner.finalizeReviewerReview(goal.id, "NOT_DONE");

      expect(failed.status).toBe("failed");
      expect(failed.reviewReport).toMatchObject({ outcome: "NOT_DONE" });
      expect(failed.repairContext?.issues.map((issue) => issue.conditionId).sort()).toEqual(["AC-002", "AC-003"]);
      expect(failed.repairContext?.issues[0]?.evidenceSummary).toBe("Required evidence missing");
      expect(failed.repairContext?.issues[0]?.repairGuidance).toContain("goal_check_done");
      expect(failed.lastError).toContain("Reviewer NOT_DONE");
    });

    it("returns NOT_DONE with failed condition id, evidence summary, guidance, and repair target", async () => {
      const goal = await lockedGoalWithConditions(reviewerDoneConditions);
      const runner = createRunner();
      await runToReview(goal.id, runner);
      await runner.recordReviewerDoneResult(goal.id, "AC-001", passingResult("AC-001"));
      await runner.recordReviewerDoneResult(goal.id, "AC-002", customFailingResult("AC-002", "typecheck failed"));
      await runner.recordReviewerDoneResult(goal.id, "AC-003", passingResult("AC-003"));

      const failed = await runner.finalizeReviewerReview(goal.id, "NOT_DONE");

      expect(failed.status).toBe("failed");
      expect(failed.reviewReport?.criteria.find((criterion) => criterion.criterionId === "AC-002")).toMatchObject({
        compliant: false,
        evidence: ["typecheck failed"],
      });
      expect(failed.repairContext?.issues).toHaveLength(1);
      expect(failed.repairContext?.issues[0]).toMatchObject({
        conditionId: "AC-002",
        evidenceSummary: "typecheck failed",
        repairTarget: "bun run typecheck",
      });
      expect(failed.repairContext?.issues[0]?.repairGuidance).toContain("AC-002");
      expect(failed.lastError).toContain("AC-002");
    });
  });

  it("retries failed verification with a fresh session, plan phase reset, and incremented retryCount", async () => {
    const goal = await lockedGoal();
    const runner = createRunner({ sessionIds: ["main-session-1", "fresh-session-2"] });
    await runner.start(goal.id);
    await runner.advancePhase(goal.id, "build");
    await runner.advancePhase(goal.id, "review");
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const retry = await runner.handleFailedVerification(goal.id, "verification failed");

    expect(retry.status).toBe("running");
    expect(retry.phase).toBe("plan");
    expect(retry.retryCount).toBe(1);
    expect(retry.mainSessionId).toBe("fresh-session-2");
    expect(retry.lastError).toBe("verification failed");
  });

  it("escalates when retry budget is exhausted", async () => {
    const goal = await manager.create(
      "project-a",
      "No retries",
      "architect",
      [condition],
      { maxRetries: 0, backoffMs: 0, escalateOnFailure: true },
      [],
    );
    await manager.lock(goal.id, "architect");
    const runner = createRunner();
    await runner.start(goal.id);

    const escalated = await runner.handleFailedVerification(goal.id, "still failing");

    expect(escalated.status).toBe("escalated");
    expect(escalated.lastError).toBe("still failing");
  });

  it("recovers interrupted active goals by failing missing sessions and pausing pending HITL", async () => {
    const noSession = await lockedGoal();
    const pending = await manager.create(
      "project-a",
      "Pending approval",
      "architect",
      [condition],
      { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
      ["after_plan"],
    );
    await manager.lock(pending.id, "architect");
    const runner = createRunner({
      activeSessionIds: ["pending-session"],
      pendingHitlGoalIds: [pending.id],
      sessionIds: ["missing-session", "pending-session"],
    });
    await runner.start(noSession.id);
    await runner.start(pending.id);

    const recovered = await runner.recoverInterruptedGoals(workspaceRoot);

    const recoveredMap = new Map(recovered.map((g) => [g.id, g.status]));
    expect(recoveredMap.get(noSession.id)).toBe("failed");
    expect(recoveredMap.get(pending.id)).toBe("paused");
    expect(recovered).toHaveLength(2);
    expect((await manager.read(noSession.id)).lastError).toContain("Interrupted");
  });

  it("rejects skipped or backwards phase transitions", async () => {
    const goal = await lockedGoal();
    const runner = createRunner();
    await runner.start(goal.id);

    await expectGoalRunnerError(() => runner.advancePhase(goal.id, "review"));
    await runner.advancePhase(goal.id, "build");
    await expectGoalRunnerError(() => runner.advancePhase(goal.id, "plan"));
  });
});
