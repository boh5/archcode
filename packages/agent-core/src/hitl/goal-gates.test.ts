import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { DoneCondition } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { GoalApprovalGate } from "./goal-gates";
import type { HitlResponse } from "./types";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-gates");

const condition: DoneCondition = {
  id: "artifact-exists",
  kind: "file_exists",
  params: { path: "dist/output.txt" },
};

let workspaceRoot = "";
let goalStateManager: GoalStateManager;

beforeEach(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  await mkdir(TMP_ROOT, { recursive: true });
  workspaceRoot = await mkdtemp(join(TMP_ROOT, "workspace-"));
  goalStateManager = new GoalStateManager(workspaceRoot);
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

function approvalResponse(decision: string, comment?: string): HitlResponse {
  return {
    hitlId: crypto.randomUUID(),
    kind: "approval",
    status: "resolved",
    response: { decision, comment },
  };
}

function reviewResponse(outcome: "DONE" | "NOT_DONE", comment?: string): HitlResponse {
  return {
    hitlId: crypto.randomUUID(),
    kind: "review",
    status: "resolved",
    response: { outcome, comment },
  };
}

function terminalResponse(status: "cancelled" | "timeout"): HitlResponse {
  return {
    hitlId: crypto.randomUUID(),
    kind: "approval",
    status,
    reason: status === "cancelled" ? "Cancelled" : "Timed out",
  };
}

function createGate(response: HitlResponse) {
  const request = mock(async () => response);
  const gate = new GoalApprovalGate({
    hitlService: { request },
    goalStateManager,
  });
  return { gate, request };
}

async function createGoal() {
  const goal = await goalStateManager.create(
    "project-a",
    "Ship HITL gates",
    "architect",
    [condition],
    { maxRetries: 1, backoffMs: 0, escalateOnFailure: true },
    ["after_plan", "before_complete"],
  );
  await goalStateManager.lock(goal.id, "architect");
  return goalStateManager.updateSessionIds(goal.id, "main-session-1", []);
}

describe("GoalApprovalGate", () => {
  it("maps approved approval responses and records the decision on goal state", async () => {
    const goal = await createGoal();
    const { gate, request } = createGate(approvalResponse("approved", "Looks good"));

    const outcome = await gate.requestApproval(goal.id, goal.mainSessionId!, "after_plan", goal.title, goal.projectId);

    expect(outcome).toEqual({ approved: true, decision: "approved", comment: "Looks good" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toMatchObject([
      "main-session-1",
      "approval",
      {
        kind: "approval",
        action: "goal.approval.after_plan",
        context: { goalId: goal.id, projectSlug: "project-a", approvalPoint: "after_plan", goalTitle: goal.title },
      },
      { goalId: goal.id, projectSlug: "project-a", source: "goal.approval.after_plan" },
    ]);
    expect((await goalStateManager.read(goal.id)).lastError).toContain("Approval after_plan approved: Looks good");
  });

  it("maps denied approval responses and records the decision on goal state", async () => {
    const goal = await createGoal();
    const { gate } = createGate(approvalResponse("denied", "Needs changes"));

    const outcome = await gate.requestApproval(goal.id, goal.mainSessionId!, "before_complete", goal.title, goal.projectId);

    expect(outcome).toEqual({ approved: false, decision: "denied", comment: "Needs changes" });
    expect((await goalStateManager.read(goal.id)).lastError).toContain("Approval before_complete denied: Needs changes");
  });

  it("maps cancelled approval responses without hanging execution", async () => {
    const goal = await createGoal();
    const { gate } = createGate(terminalResponse("cancelled"));

    const outcome = await gate.requestApproval(goal.id, goal.mainSessionId!, "after_plan", goal.title, goal.projectId);

    expect(outcome).toEqual({ approved: false });
    expect((await goalStateManager.read(goal.id)).lastError).toContain("Approval after_plan cancelled: Cancelled");
  });

  it("maps timeout approval responses without hanging execution", async () => {
    const goal = await createGoal();
    const { gate } = createGate(terminalResponse("timeout"));

    const outcome = await gate.requestApproval(goal.id, goal.mainSessionId!, "after_plan", goal.title, goal.projectId);
    expect(outcome).toEqual({ approved: false });
    expect((await goalStateManager.read(goal.id)).lastError).toContain("Approval after_plan timeout: Timed out");
  });

  it("maps approve review responses and persists reviewer approval evidence", async () => {
    const goal = await createGoal();
    const { gate, request } = createGate(reviewResponse("DONE", "Artifacts look correct"));

    const outcome = await gate.requestReview(goal.id, goal.mainSessionId!, [
      { path: "dist/output.txt", description: "Build output" },
    ], goal.projectId);

    expect(outcome).toEqual({ outcome: "DONE", comment: "Artifacts look correct" });
    expect(request.mock.calls[0]).toMatchObject([
      "main-session-1",
      "review",
      { kind: "review", artifacts: [{ path: "dist/output.txt", description: "Build output" }] },
      { goalId: goal.id, projectSlug: "project-a", source: "goal.review" },
    ]);
    const persisted = await goalStateManager.read(goal.id);
    expect(persisted.doneResults.reviewer_approval).toMatchObject({
      conditionId: "reviewer_approval",
      passed: true,
      evidence: "Artifacts look correct",
    });
  });

  it("maps NOT_DONE review responses and persists failing review evidence", async () => {
    const goal = await createGoal();
    const { gate } = createGate(reviewResponse("NOT_DONE", "Broken output"));

    const outcome = await gate.requestReview(goal.id, goal.mainSessionId!, [], goal.projectId);

    expect(outcome).toEqual({ outcome: "NOT_DONE", comment: "Broken output" });
    expect((await goalStateManager.read(goal.id)).doneResults.reviewer_approval).toMatchObject({
      passed: false,
      evidence: "Broken output",
    });
  });

  it("maps terminal review responses to NOT_DONE and persists failing review evidence", async () => {
    const goal = await createGoal();
    const { gate } = createGate(reviewResponse("NOT_DONE", "Please add tests"));

    const outcome = await gate.requestReview(goal.id, goal.mainSessionId!, [], goal.projectId);

    expect(outcome).toEqual({ outcome: "NOT_DONE", comment: "Please add tests" });
    expect((await goalStateManager.read(goal.id)).doneResults.reviewer_approval).toMatchObject({
      passed: false,
      evidence: "Please add tests",
    });
  });
});
