import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { GoalApprovalGate, approvalOutcomeFromResponse, reviewOutcomeFromResponse } from "./goal-gates";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-gates");

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
  const publishRequest = mock(async (_record: HitlRecord) => {});
  const gate = new GoalApprovalGate({
    hitlService: { create, publishRequest },
    goalStateManager,
  });
  return { gate, create, publishRequest };
}

async function createRunningGoal() {
  const goal = await goalStateManager.create({
    projectId: "project-a",
    objective: "Integrate HITL gates with simplified Goal state.",
    acceptanceCriteria: "HITL requests block Goals through pending ids and blockers only.",
    mainSessionId: "main-session-1",
  });
  return await goalStateManager.start(goal.id, { mainSessionId: "main-session-1" });
}

describe("GoalApprovalGate", () => {
  it("creates Goal-owned approval records and blocks with pending HITL refs", async () => {
    const goal = await createRunningGoal();
    const { gate, create, publishRequest } = createGate();

    const record = await gate.requestApproval({
      goalId: goal.id,
      projectSlug: goal.projectId,
      approvalPoint: "after_plan",
      summary: "Approve continuing the Goal.",
      resumeStatus: "running",
    });

    expect(record.owner).toEqual({ projectSlug: "project-a", ownerType: "goal", ownerId: goal.id });
    expect(record.source).toEqual({ type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(publishRequest).toHaveBeenCalledWith(record);
    expect(await goalStateManager.read(goal.id)).toMatchObject({
      status: "blocked",
      pendingHitlIds: [record.hitlId],
      approvalRefs: [record.hitlId],
      blocker: {
        kind: "approval",
        hitlId: record.hitlId,
        source: "after_plan",
        resumeStatus: "running",
      },
    });
  });

  it("creates review HITL records that resume to reviewing", async () => {
    const goal = await createRunningGoal();
    const { gate } = createGate();

    const record = await gate.requestReview({ goalId: goal.id, projectSlug: goal.projectId });

    expect(record.source).toEqual({ type: "goal_review", goalId: goal.id });
    expect(await goalStateManager.read(goal.id)).toMatchObject({
      status: "blocked",
      pendingHitlIds: [record.hitlId],
      blocker: { kind: "approval", hitlId: record.hitlId, resumeStatus: "reviewing" },
    });
  });

  it("records approval responses on goal state without approval artifacts", async () => {
    const goal = await createRunningGoal();
    const { gate } = createGate();

    const outcome = await gate.recordApprovalResponse(goal.id, "after_plan", approvalResponse("approved", "Looks good"));

    expect(outcome).toEqual({ approved: true, decision: "approved", comment: "Looks good" });
    expect((await goalStateManager.read(goal.id)).lastError?.message).toContain("Approval after_plan approved: Looks good");
    expect(await Bun.file(join(workspaceRoot, ".archcode", "goals", goal.id, "approvals.md")).exists()).toBe(false);
  });

  it("maps approval and cancelled responses", () => {
    expect(approvalOutcomeFromResponse(approvalResponse("denied", "Needs changes"))).toEqual({ approved: false, decision: "denied", comment: "Needs changes" });
    expect(approvalOutcomeFromResponse(terminalResponse())).toEqual({ approved: false, comment: "Cancelled" });
  });

  it("maps review responses", () => {
    expect(reviewOutcomeFromResponse(reviewResponse("DONE", "Evidence looks correct"))).toEqual({ outcome: "DONE", comment: "Evidence looks correct" });
    expect(reviewOutcomeFromResponse(terminalResponse())).toEqual({ outcome: "NOT_DONE", comment: "Cancelled" });
  });
});
