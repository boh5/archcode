import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalStateManager } from "../goals/state";
import { GoalApprovalGate, approvalOutcomeFromResponse, reviewOutcomeFromResponse } from "./goal-gates";

const TMP_ROOT = join(import.meta.dir, "__test_tmp__", "goal-gates", crypto.randomUUID());

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
  const summary = comment ?? `Review outcome: ${outcome}`;
  return {
    type: "review_outcome",
    outcome,
    ...(comment === undefined ? {} : { comment }),
    receipt: {
      reviewGeneration: 1,
      verdict: outcome,
      summary,
      evidenceRefs: outcome === "DONE" ? [{ kind: "hitl", ref: "review", summary }] : [],
      reviewerSessionId: "reviewer-session",
      decidedAt: "2026-07-14T00:00:00.000Z",
    },
  };
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
  return await goalStateManager.commit({
    id: crypto.randomUUID(),
    projectId: "project-a",
    createdFromSessionId: crypto.randomUUID(),
    objective: "Integrate HITL gates with simplified Goal state.",
    acceptanceCriteria: "HITL requests block Goals through pending ids and blockers only.",
    mainSessionId: "main-session-1",
  });
}

describe("GoalApprovalGate", () => {
  it("attaches the Goal blocker and durable marker in one state mutation", async () => {
    const goal = await createRunningGoal();
    const createdAt = new Date().toISOString();
    const record: HitlRecord = {
      hitlId: crypto.randomUUID(),
      owner: { projectSlug: goal.projectId, ownerType: "goal", ownerId: goal.id },
      blockingKey: `goal:${goal.id}:approval:after_plan`,
      source: { type: "goal_approval", goalId: goal.id, approvalPoint: "after_plan" },
      status: "pending",
      displayPayload: { title: "Approve Goal continuation", redacted: true },
      createdAt,
      updatedAt: createdAt,
    };
    const attachHitlBlocker = mock(async () => goal);
    const publishRequest = mock(async () => {});
    const gate = new GoalApprovalGate({
      hitlService: { create: mock(async () => record), publishRequest },
      goalStateManager: { attachHitlBlocker } as unknown as GoalStateManager,
    });

    await gate.requestApproval({
      goalId: goal.id,
      projectSlug: goal.projectId,
      approvalPoint: "after_plan",
      summary: "Approve continuing the Goal.",
    });

    expect(attachHitlBlocker).toHaveBeenCalledTimes(1);
    expect(attachHitlBlocker).toHaveBeenCalledWith(goal.id, {
      blocker: {
        kind: "approval",
        summary: "Approve continuing the Goal.",
        hitlId: record.hitlId,
        source: "after_plan",
      },
      approvalRef: record.hitlId,
    });
    expect(publishRequest).toHaveBeenCalledWith(record);
  });

  it("creates Goal-owned approval records while preserving lifecycle status", async () => {
    const goal = await createRunningGoal();
    const { gate, create, publishRequest } = createGate();

    const record = await gate.requestApproval({
      goalId: goal.id,
      projectSlug: goal.projectId,
      approvalPoint: "after_plan",
      summary: "Approve continuing the Goal.",
    });

    expect(record.owner).toEqual({ projectSlug: "project-a", ownerType: "goal", ownerId: goal.id });
    expect(record.source).toEqual({
      type: "goal_approval",
      goalId: goal.id,
      approvalPoint: "after_plan",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(publishRequest).toHaveBeenCalledWith(record);
    expect(await goalStateManager.read(goal.id)).toMatchObject({
      status: "running",
      pendingHitlIds: [record.hitlId],
      approvalRefs: [record.hitlId],
      appliedHitlIds: [],
      blocker: {
        kind: "approval",
        hitlId: record.hitlId,
        source: "after_plan",
      },
    });
  });

  it("creates review HITL records while preserving reviewing lifecycle", async () => {
    const running = await createRunningGoal();
    const goal = await goalStateManager.beginReview(running.id);
    const { gate } = createGate();

    const record = await gate.requestReview({
      goalId: goal.id,
      projectSlug: goal.projectId,
      reviewGeneration: goal.reviewGeneration,
      reviewerSessionId: "reviewer-session",
    });

    expect(record.source).toEqual({
      type: "goal_review",
      goalId: goal.id,
      reviewGeneration: goal.reviewGeneration,
      reviewerSessionId: "reviewer-session",
    });
    expect(await goalStateManager.read(goal.id)).toMatchObject({
      status: "reviewing",
      pendingHitlIds: [record.hitlId],
      blocker: { kind: "approval", hitlId: record.hitlId },
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
    const response = reviewResponse("DONE", "Evidence looks correct");
    if (response.type !== "review_outcome") throw new Error("Expected review outcome fixture");
    expect(reviewOutcomeFromResponse(response)).toEqual({
      outcome: "DONE",
      comment: "Evidence looks correct",
      receipt: response.receipt,
    });
    expect(() => reviewOutcomeFromResponse(terminalResponse())).toThrow("Goal review requires review_outcome");
  });
});
