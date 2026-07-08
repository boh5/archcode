import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, GoalDoneResult, GoalState } from "@archcode/protocol";

import { GoalApprovalGate, type ReviewOutcome } from "../hitl/goal-gates";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { HitlService } from "../hitl/service";
import { silentLogger } from "../logger";
import { setLlmAdapterForTest } from "../llm";
import { LoopStateManager } from "../loops/state";
import { SessionStoreManager } from "../store/session-store-manager";
import { GoalArtifactManager } from "./artifacts";
import { GoalHitlResumeAdapter } from "./hitl-resume-adapter";
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
let artifacts: GoalArtifactManager;
let sessions: SessionStoreManager;
let loops: LoopStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  artifacts = new GoalArtifactManager(workspaceRoot);
  sessions = new SessionStoreManager({ logger: silentLogger });
  loops = new LoopStateManager(workspaceRoot);
  setLlmAdapterForTest({});
});

afterAll(async () => {
  setLlmAdapterForTest(undefined);
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function passingResult(conditionId = condition.id): GoalDoneResult {
  return { conditionId, passed: true, evidence: "condition passed", checkedAt: new Date().toISOString() };
}

function failingResult(conditionId = condition.id): GoalDoneResult {
  return { conditionId, passed: false, evidence: "condition failed", checkedAt: new Date().toISOString() };
}

function createHitlService(): HitlService {
  return new HitlService({
    workspaceRoot,
    project: { slug: "project-a", name: "Project A" },
    sessions,
    goalState: manager,
    loopState: loops,
  });
}

function createRunner(hitlService: HitlService, options: { sessionIds?: string[] } = {}): GoalRunner {
  const sessionIds = [...(options.sessionIds ?? ["main-session-1", "fresh-session-2", "fresh-session-3"])] as string[];

  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: artifacts,
    workspaceRoot,
    hitlService,
    createSession: mock(async () => sessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => false),
  });
}

function createReviewGate(hitlService: HitlService): GoalApprovalGate {
  return new GoalApprovalGate({
    goalStateManager: manager,
    goalArtifacts: artifacts,
    hitlService,
  });
}

function createCoordinator(hitlService: HitlService): ResumeCoordinator {
  return new ResumeCoordinator({
    hitl: hitlService,
    adapters: {
      goal: new GoalHitlResumeAdapter({
        workspaceRoot,
        goalStateManager: manager,
        goalArtifacts: artifacts,
        hitlService,
        createRunner: () => createRunner(hitlService, { sessionIds: ["fresh-session-2"] }),
      }),
    },
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
    const hitlService = createHitlService();
    const runner = createRunner(hitlService, { sessionIds: ["main-session-1"] });
    const reviewGate = createReviewGate(hitlService);
    const coordinator = createCoordinator(hitlService);
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, condition.id, passingResult());

    const record = await reviewGate.requestReview(goal.id, [], goal.projectId);
    await coordinator.respond(record.hitlId, { type: "review_outcome", outcome: "NOT_DONE", comment: "Output is broken" });
    const retry = await waitForGoal(goal.id, (state) => state.status === "running" && state.retryCount === 1);

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
    const runner = createRunner(createHitlService(), { sessionIds: ["main-session-1", "fresh-session-2"] });
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
    const runner = createRunner(createHitlService(), { sessionIds: ["main-session-1", "fresh-session-2"] });
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

async function waitForGoal(goalId: string, predicate: (goal: GoalState) => boolean): Promise<GoalState> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const goal = await manager.read(goalId);
    if (predicate(goal)) return goal;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for Goal state");
}
