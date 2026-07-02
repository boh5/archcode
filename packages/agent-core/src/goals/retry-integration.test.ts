import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, DoneResult, GoalState } from "@archcode/protocol";

import { GoalApprovalGate, type ReviewOutcome } from "../hitl/goal-gates";
import type { HitlResponse } from "../hitl/types";
import { setLlmAdapterForTest } from "../llm";
import { GoalRunner, GoalRunnerError } from "./runner";
import { GoalStateManager } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-retry-integration");

const condition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "artifact.txt" },
};

let workspaceRoot = "";
let manager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  setLlmAdapterForTest({});
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function reviewResponse(verdict: ReviewOutcome["verdict"], comment: string): HitlResponse {
  return {
    hitlId: crypto.randomUUID(),
    kind: "review",
    status: "resolved",
    response: { verdict, comment },
  };
}

function passingResult(conditionId = condition.id): DoneResult {
  return { conditionId, passed: true, evidence: "goal_check_done passed", checkedAt: new Date().toISOString() };
}

function failingResult(conditionId = condition.id): DoneResult {
  return { conditionId, passed: false, evidence: "goal_check_done failed", checkedAt: new Date().toISOString() };
}

function createRunner(options: { sessionIds?: string[] } = {}): GoalRunner {
  const sessionIds = [...(options.sessionIds ?? ["main-session-1", "fresh-session-2", "fresh-session-3"])] as string[];

  return new GoalRunner({
    goalStateManager: manager,
    workspaceRoot,
    hitlService: {
      request: mock(async () => reviewResponse("approve", "Approved")),
      listPending: mock(() => []),
    },
    createSession: mock(async () => sessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => false),
  });
}

function createReviewGate(verdict: ReviewOutcome["verdict"], comment: string): GoalApprovalGate {
  return new GoalApprovalGate({
    goalStateManager: manager,
    hitlService: { request: mock(async () => reviewResponse(verdict, comment)) },
  });
}

async function lockedGoal(maxRetries: number): Promise<GoalState> {
  const goal = await manager.create(
    "project-a",
    "Retry integration goal",
    "architect",
    [condition],
    { maxRetries, backoffMs: 0, escalateOnFailure: true },
    [],
  );
  return manager.lock(goal.id, "architect");
}

async function runToReview(goalId: string, runner: GoalRunner): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
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

describe("Goal retry integration", () => {
  test("reviewer rejection prevents completion", async () => {
    const goal = await lockedGoal(1);
    const runner = createRunner({ sessionIds: ["main-session-1", "fresh-session-2"] });
    const reviewGate = createReviewGate("reject", "Output is broken");
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, passingResult());

    const outcome = await reviewGate.requestReview(goal.id, "main-session-1", [], goal.projectId);
    const retry = await runner.handleFailedVerification(goal.id, outcome.comment ?? "Reviewer rejected");

    expect(outcome).toEqual({ verdict: "reject", comment: "Output is broken" });
    await expectGoalRunnerError(() => runner.complete(goal.id));
    expect(retry.status).toBe("running");
    expect(retry.phase).toBe("plan");
    expect(retry.retryCount).toBe(1);
    expect(retry.mainSessionId).toBe("fresh-session-2");
    expect(retry.status).not.toBe("completed");
    expect(retry.doneResults.reviewer_approval).toMatchObject({ passed: false, evidence: "Output is broken" });
  });

  test("failed done condition triggers retry with fresh context and preserves session audit chain", async () => {
    const goal = await lockedGoal(2);
    const runner = createRunner({ sessionIds: ["main-session-1", "fresh-session-2"] });
    await runToReview(goal.id, runner);
    await manager.updateSessionIds(goal.id, "main-session-1", ["child-session-1", "child-session-2"]);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const retry = await runner.handleFailedVerification(goal.id, "Done Condition failed");

    expect(retry.status).toBe("running");
    expect(retry.phase).toBe("plan");
    expect(retry.retryCount).toBe(1);
    expect(retry.mainSessionId).toBe("fresh-session-2");
    expect(retry.mainSessionId).not.toBe("main-session-1");
    expect(retry.childSessionIds).toEqual([]);
    expect(retry.lastError).toBe("Done Condition failed");
    const sessionAuditChain = ["main-session-1", "child-session-1", "child-session-2", retry.mainSessionId];
    expect(sessionAuditChain).toContain("main-session-1");
    expect(sessionAuditChain).toContain("child-session-1");
    expect(sessionAuditChain).toContain("child-session-2");
    expect(sessionAuditChain.at(-1)).toBe("fresh-session-2");
  });

  test("retry exhaustion transitions to escalated", async () => {
    const goal = await lockedGoal(1);
    const runner = createRunner({ sessionIds: ["main-session-1", "fresh-session-2"] });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());

    const retry = await runner.handleFailedVerification(goal.id, "First verification failure");
    expect(retry.status).toBe("running");
    expect(retry.retryCount).toBe(1);
    expect(retry.phase).toBe("plan");
    expect(retry.mainSessionId).toBe("fresh-session-2");

    await runner.advancePhase(goal.id, "build");
    await runner.advancePhase(goal.id, "review");
    await runner.recordReviewerDoneResult(goal.id, condition.id, failingResult());
    const escalated = await runner.handleFailedVerification(goal.id, "Still failing after retry");

    expect(escalated.status).toBe("escalated");
    expect(escalated.retryCount).toBe(1);
    expect(escalated.mainSessionId).toBe("fresh-session-2");
    expect(escalated.lastError).toBe("Still failing after retry");
  });
});
