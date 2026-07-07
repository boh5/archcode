import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition, DoneResult, GoalTokenBudgetState, HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalApprovalGate } from "../hitl/goal-gates";
import { writeGoalBudgetArtifact } from "./artifact-lifecycle";
import { GoalArtifactManager } from "./artifacts";
import { GoalRunner } from "./runner";
import { GoalStateManager, type GoalState } from "./state";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-artifact-lifecycle");

const specCondition: DoneCondition = {
  id: "spec-check",
  kind: "spec_compliance",
  params: { specPath: "SPEC.md" },
};

const testCondition: DoneCondition = {
  id: "AC-003",
  kind: "tests_pass",
  params: { command: "bun test packages/agent-core/src/goals/artifact-lifecycle.test.ts" },
};

let workspaceRoot = "";
let manager: GoalStateManager;
let artifacts: GoalArtifactManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  manager = new GoalStateManager(workspaceRoot);
  artifacts = new GoalArtifactManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("Goal artifact lifecycle", () => {
  test("NOT_DONE with failed AC-002 and exhausted retry writes review, spec, retry, and final artifacts", async () => {
    const goal = await lockedGoal([specCondition], 0);
    const runner = createRunner();
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, "spec-check", specComplianceFailureResult());

    const escalated = await runner.finalizeReviewerReview(goal.id, "NOT_DONE", {
      summary: "Reviewer NOT_DONE after AC-002 failure",
    });

    expect(escalated.status).toBe("escalated");
    const review = await artifacts.readArtifact(goal.id, "review.md");
    const spec = await artifacts.readArtifact(goal.id, "spec-compliance.md");
    const retry = await artifacts.readArtifact(goal.id, "retry-log.md");
    const final = await artifacts.readArtifact(goal.id, "final-report.md");
    expect(review).toContain("# Review Report");
    expect(review).toContain("NOT_DONE");
    expect(review).toContain("AC-002");
    expect(review).toContain("Operator Repair Context");
    expect(review).toContain("Repair AC-002 and rerun verification");
    expect(spec).toContain("# Spec Compliance");
    expect(spec).toContain("AC-002");
    expect(spec).toContain("failed");
    expect(retry).toContain("# Retry Log");
    expect(retry).toContain("retry budget exhausted");
    expect(final).toContain("# Final Report");
    expect(final).toContain("Final status | escalated");
    expect(final).toContain("Review outcome | NOT_DONE");
    expect(final).toContain("AC-002");
    expect(final).toContain("Reviewer NOT_DONE: required Done Conditions need repair (AC-002).");
  });

  test("DONE path writes current review, optional spec-compliance, build, and final report artifacts", async () => {
    const goal = await lockedGoal([specCondition], 1);
    const runner = createRunner();
    await runner.start(goal.id);
    await runner.advancePhase(goal.id, "build");
    await runner.advancePhase(goal.id, "review");
    await runner.recordReviewerDoneResult(goal.id, "spec-check", specCompliancePassingResult());

    const completed = await runner.finalizeReviewerReview(goal.id, "DONE", { summary: "Reviewer verified completion." });

    expect(completed.status).toBe("completed");
    expect(await artifacts.readArtifact(goal.id, "build.md")).toContain("# Build Record");
    expect(await artifacts.readArtifact(goal.id, "review.md")).toContain("DONE");
    expect(await artifacts.readArtifact(goal.id, "spec-compliance.md")).toContain("AC-001");
    const final = await artifacts.readArtifact(goal.id, "final-report.md");
    expect(final).toContain("Final status | completed");
    expect(final).toContain("Review outcome | DONE");
    expect(final).toContain("Reviewer verified completion.");
  });

  test("budget warning and hard stop update the current budget artifact", async () => {
    const goal = await lockedGoal([testCondition], 1);
    const warningBudget = tokenBudget({ totalTokens: 890, warningThresholdTokens: 900, maxTokens: 1000, status: "warning" });
    await writeGoalBudgetArtifact(artifacts, goal, warningBudget, {
      event: "warning_pending",
      source: "before_model_call",
      reason: "Budget warning approval is pending",
      estimatedNextCallTokens: 50,
    });

    const warning = await artifacts.readArtifact(goal.id, "budget.md");
    expect(warning).toContain("Event | warning_pending");
    expect(warning).toContain("Estimated next call token count | 50");

    const hardBudget = tokenBudget({ totalTokens: 1005, warningThresholdTokens: 900, maxTokens: 1000, status: "paused" });
    await writeGoalBudgetArtifact(artifacts, goal, hardBudget, {
      event: "hard_stop",
      source: "after_step_usage_update",
      reason: "Goal paused because the hard limit was reached or exceeded.",
    });

    const hardStop = await artifacts.readArtifact(goal.id, "budget.md");
    expect(hardStop).toContain("Event | hard_stop");
    expect(hardStop).toContain("Source | after_step_usage_update");
    expect(hardStop).toContain("Total token count | 1005");
    expect(hardStop).not.toContain("warning_pending");
  });

  test("retry attempt writes retry-log with attempt number, failure summary, and fresh session", async () => {
    const goal = await lockedGoal([testCondition], 2);
    const runner = createRunner({ sessionIds: ["main-session-1", "fresh-session-2"] });
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, "AC-003", failingResult("AC-003"));

    const retry = await runner.handleFailedVerification(goal.id, "Tests failed on AC-003");

    expect(retry.status).toBe("running");
    const retryLog = await artifacts.readArtifact(goal.id, "retry-log.md");
    expect(retryLog).toContain("# Retry Log");
    expect(retryLog).toContain("| 1 | running | Tests failed on AC-003 | fresh-session-2 | not scheduled | not exhausted |");
  });

  test("approval gates append request and resolution history to approvals artifact", async () => {
    const goal = await lockedGoal([testCondition], 1, ["after_plan"]);
    await manager.updateSessionIds(goal.id, "main-session-approval", []);
    const gate = new GoalApprovalGate({
      goalStateManager: manager,
      goalArtifacts: artifacts,
      hitlService: { create: mock(async (input) => createHitlRecord(input)) },
    });

    const record = await gate.requestApproval(goal.id, "main-session-approval", "after_plan", goal.title, goal.projectId);
    const outcome = await gate.recordApprovalResponse(goal.id, "after_plan", "main-session-approval", approvalResponse("denied", "Needs more evidence"));

    expect(outcome.approved).toBe(false);
    expect(record.source).toMatchObject({ type: "goal_approval", approvalPoint: "after_plan" });
    const approvals = await artifacts.readArtifact(goal.id, "approvals.md");
    expect(approvals).toContain("# Approval History");
    expect(approvals).toContain("after_plan | requested");
    expect(approvals).toContain("after_plan | denied | denied | Needs more evidence | main-session-approval");
  });

  test("artifact lifecycle creates only canonical current markdown files without version-like names", async () => {
    const goal = await lockedGoal([specCondition], 0);
    const runner = createRunner();
    await runToReview(goal.id, runner);
    await runner.recordReviewerDoneResult(goal.id, "spec-check", specComplianceFailureResult());
    await runner.finalizeReviewerReview(goal.id, "NOT_DONE", { summary: "AC-002 still failing" });

    const artifactDir = join(workspaceRoot, ".archcode", "goals", goal.id, "artifacts");
    const names = (await readdir(artifactDir)).sort();
    expect(names.every((name) => name.endsWith(".md"))).toBe(true);
    expect(names).toEqual(["build.md", "final-report.md", "retry-log.md", "review.md", "spec-compliance.md"].sort());
    expect(names.some((name) => /(?:v\d+|-v\d+|revision|latest)/i.test(name))).toBe(false);
    expect(existsSync(join(artifactDir, "versions"))).toBe(false);
    expect(existsSync(join(artifactDir, "revisions"))).toBe(false);
    expect(existsSync(join(artifactDir, "latest"))).toBe(false);
  });
});

function createRunner(options: { sessionIds?: string[] } = {}): GoalRunner {
  const sessionIds = [...(options.sessionIds ?? ["main-session-1", "fresh-session-2"])] as string[];
  return new GoalRunner({
    goalStateManager: manager,
    goalArtifacts: artifacts,
    workspaceRoot,
    hitlService: {
      create: mock(async (input) => createHitlRecord(input)),
      list: mock(async () => []),
    },
    createSession: mock(async () => sessionIds.shift() ?? `session-${crypto.randomUUID()}`),
    isSessionActive: mock(async () => false),
  });
}

async function lockedGoal(
  doneConditions: DoneCondition[],
  maxRetries: number,
  approvalPoints: Array<"after_plan" | "before_complete"> = [],
): Promise<GoalState> {
  const goal = await manager.create(
    "test-project",
    "Artifact lifecycle Goal",
    "architect",
    doneConditions,
    { maxRetries, backoffMs: 0, escalateOnFailure: true },
    approvalPoints,
  );
  return manager.lock(goal.id, "architect");
}

async function runToReview(goalId: string, runner: GoalRunner): Promise<void> {
  await runner.start(goalId);
  await runner.advancePhase(goalId, "build");
  await runner.advancePhase(goalId, "review");
}

function createHitlRecord(input: {
  owner: HitlRecord["owner"];
  blockingKey: string;
  source: HitlRecord["source"];
  displayPayload: HitlRecord["displayPayload"];
}): HitlRecord {
  return {
    hitlId: crypto.randomUUID(),
    owner: input.owner,
    blockingKey: input.blockingKey,
    source: input.source,
    status: "pending",
    displayPayload: input.displayPayload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function approvalResponse(decision: "approved" | "denied", comment?: string): HitlResponse {
  return { type: "approval_decision", decision, ...(comment === undefined ? {} : { comment }) };
}

function specComplianceFailureResult(): DoneResult {
  return {
    conditionId: "spec-check",
    passed: false,
    evidence: "Spec compliance failed for AC-002",
    checkedAt: new Date().toISOString(),
    specCompliance: {
      checkedAt: new Date().toISOString(),
      specPath: "SPEC.md",
      summary: "Acceptance criteria are partially satisfied.",
      criteria: [
        {
          criterionId: "AC-001",
          criterion: "Artifact lifecycle writes review evidence.",
          compliant: true,
          status: "satisfied",
          evidence: ["review.md contains structured evidence"],
          artifactNames: ["review.md"],
          fileRefs: ["packages/agent-core/src/goals/artifact-lifecycle.ts"],
        },
        {
          criterionId: "AC-002",
          criterion: "Failed criterion has operator repair guidance.",
          compliant: false,
          status: "failed",
          evidence: ["reviewer found missing AC-002 behavior"],
          commandRefs: ["bun test packages/agent-core/src/goals/artifact-lifecycle.test.ts"],
          resultRefs: ["artifact lifecycle focused test failed"],
          fileRefs: ["packages/agent-core/src/goals/runner.ts"],
          repairGuidance: "Repair AC-002 and rerun verification",
        },
      ],
    },
  };
}

function specCompliancePassingResult(): DoneResult {
  const failed = specComplianceFailureResult();
  return {
    ...failed,
    passed: true,
    evidence: "Spec compliance passed",
    specCompliance: {
      ...failed.specCompliance!,
      summary: "All acceptance criteria are satisfied.",
      criteria: failed.specCompliance!.criteria.map((criterion) => ({
        ...criterion,
        compliant: true,
        status: "satisfied",
        repairGuidance: undefined,
      })),
    },
  };
}

function failingResult(conditionId: string): DoneResult {
  return {
    conditionId,
    passed: false,
    evidence: "Tests failed on AC-003",
    checkedAt: new Date().toISOString(),
  };
}

function tokenBudget(input: {
  totalTokens: number;
  warningThresholdTokens: number;
  maxTokens: number;
  status: GoalTokenBudgetState["status"];
}): GoalTokenBudgetState {
  return {
    status: input.status,
    inputTokens: input.totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    totalTokens: input.totalTokens,
    warningThresholdTokens: input.warningThresholdTokens,
    maxTokens: input.maxTokens,
    updatedAt: new Date().toISOString(),
  };
}
