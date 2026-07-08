import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { GOAL_HITL_ACTION_ADVANCE_PHASE, GOAL_HITL_ACTION_FINALIZE_REVIEW, type DoneCondition, type HitlRecord, type HitlResponse } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { GoalApprovalGate, approvalOutcomeFromResponse, reviewOutcomeFromResponse } from "./goal-gates";

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

function approvalResponse(decision: "approved" | "denied", comment?: string): HitlResponse {
  return { type: "approval_decision", decision, ...(comment === undefined ? {} : { comment }) };
}

function reviewResponse(outcome: "DONE" | "NOT_DONE", comment?: string): HitlResponse {
  return { type: "review_outcome", outcome, ...(comment === undefined ? {} : { comment }) };
}

function terminalResponse(): HitlResponse {
  return { type: "cancel", reason: "Cancelled" };
}

function createGate() {
  const create = mock(async (input: {
    owner: HitlRecord["owner"];
    blockingKey: string;
    source: HitlRecord["source"];
    displayPayload: HitlRecord["displayPayload"];
  }): Promise<HitlRecord> => ({
    hitlId: crypto.randomUUID(),
    owner: input.owner,
    blockingKey: input.blockingKey,
    source: input.source,
    status: "pending",
    displayPayload: input.displayPayload,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const gate = new GoalApprovalGate({
    hitlService: { create },
    goalStateManager,
  });
  return { gate, create };
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
  it("creates Goal-owned after_plan approval records and checkpoints", async () => {
    const goal = await createGoal();
    const { gate, create } = createGate();

    const record = await gate.requestApproval(goal.id, goal.mainSessionId!, "after_plan", goal.title, goal.projectId);

    expect(record.owner).toEqual({ projectSlug: "project-a", ownerType: "goal", ownerId: goal.id });
    expect(record.source).toEqual({ type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan" });
    expect(create).toHaveBeenCalledTimes(1);
    expect((await goalStateManager.read(goal.id)).resumeCheckpoint).toMatchObject({
      kind: "goal_approval",
      action: GOAL_HITL_ACTION_ADVANCE_PHASE,
      approvalPoint: "after_plan",
      hitlId: record.hitlId,
    });
  });

  it("creates Goal-owned before_complete approval records and checkpoints", async () => {
    const goal = await createGoal();
    const { gate } = createGate();

    const record = await gate.requestApproval(goal.id, goal.mainSessionId!, "before_complete", goal.title, goal.projectId);

    expect(record.source).toEqual({ type: "goal_approval", goalId: goal.id, approvalPoint: "before_complete" });
    expect((await goalStateManager.read(goal.id)).resumeCheckpoint).toMatchObject({
      kind: "goal_approval",
      action: "complete",
      approvalPoint: "before_complete",
      hitlId: record.hitlId,
    });
  });

  it("records approval responses on goal state", async () => {
    const goal = await createGoal();
    const { gate } = createGate();

    const outcome = await gate.recordApprovalResponse(goal.id, "after_plan", goal.mainSessionId!, approvalResponse("approved", "Looks good"));

    expect(outcome).toEqual({ approved: true, decision: "approved", comment: "Looks good" });
    expect((await goalStateManager.read(goal.id)).lastError).toContain("Approval after_plan approved: Looks good");
  });

  it("maps approval and cancelled responses", () => {
    expect(approvalOutcomeFromResponse(approvalResponse("denied", "Needs changes"))).toEqual({ approved: false, decision: "denied", comment: "Needs changes" });
    expect(approvalOutcomeFromResponse(terminalResponse())).toEqual({ approved: false, comment: "Cancelled" });
  });

  it("creates review checkpoints without persisting Session tool results", async () => {
    const goal = await createGoal();
    const { gate } = createGate();

    const record = await gate.requestReview(goal.id, [{ path: "dist/output.txt", description: "Build output" }], goal.projectId);

    expect(record.source).toEqual({ type: "goal_review", goalId: goal.id });
    const persisted = await goalStateManager.read(goal.id);
    expect(persisted.resumeCheckpoint).toMatchObject({ kind: "goal_review", action: GOAL_HITL_ACTION_FINALIZE_REVIEW, hitlId: record.hitlId });
    expect(persisted.doneResults.reviewer_approval).toBeUndefined();
  });

  it("maps review responses", () => {
    expect(reviewOutcomeFromResponse(reviewResponse("DONE", "Artifacts look correct"))).toEqual({ outcome: "DONE", comment: "Artifacts look correct" });
    expect(reviewOutcomeFromResponse(terminalResponse())).toEqual({ outcome: "NOT_DONE", comment: "Cancelled" });
  });
});
