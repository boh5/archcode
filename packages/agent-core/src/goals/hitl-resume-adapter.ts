import type { GoalReviewReceipt, GoalReviewVerdict, HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalApprovalGate, approvalOutcomeFromResponse, reviewOutcomeFromResponse } from "../hitl/goal-gates";
import type { GoalHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import type { HitlService } from "../hitl/service";
import type { GoalFinalizeReviewInput } from "./state";
import type { GoalStateManager } from "./state";

export interface GoalHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly goalStateManager: GoalStateManager;
  readonly hitlService: HitlService;
}

export class GoalHitlResumeAdapter implements ResumeAdapterContract {
  readonly #approvalGate: GoalApprovalGate;

  constructor(private readonly options: GoalHitlResumeAdapterOptions) {
    this.#approvalGate = new GoalApprovalGate({
      hitlService: options.hitlService,
      goalStateManager: options.goalStateManager,
    });
  }

  async resume(record: HitlRecord, response: HitlResponse): Promise<void> {
    void this.options.workspaceRoot;
    if (record.owner.ownerType !== "goal") throw new Error(`Goal adapter cannot resume ${record.owner.ownerType} HITL`);
    const goalId = record.owner.ownerId;
    const goal = await this.options.goalStateManager.read(goalId);
    if (!goal.pendingHitlIds.includes(record.hitlId)) return;

    switch (record.source.type) {
      case "goal_approval":
      case "goal_budget":
      case "goal_question":
        await this.#resumeApprovalLike(record, response);
        return;
      case "goal_review":
        await this.#resumeReview(record, response);
        return;
      default:
        await this.#failUnrecoverable(record, response, `Unsupported Goal HITL source: ${record.source.type}`);
    }
  }

  async #resumeApprovalLike(record: HitlRecord, response: HitlResponse): Promise<void> {
    const goalId = record.owner.ownerId;
    if (record.source.type === "goal_approval") {
      await this.#approvalGate.recordApprovalResponse(goalId, record.source.approvalPoint ?? "approval", response);
    }

    if (response.type === "cancel") {
      await this.options.goalStateManager.cancel(goalId, response.reason);
      return;
    }

    const outcome = approvalOutcomeFromResponse(response);
    if (!outcome.approved) {
      await this.options.goalStateManager.fail(goalId, outcome.comment ?? "Goal HITL denied");
      return;
    }

    await this.options.goalStateManager.clearBlocker(goalId, record.hitlId);
  }

  async #resumeReview(record: HitlRecord, response: HitlResponse): Promise<void> {
    const goalId = record.owner.ownerId;
    if (response.type === "cancel") {
      await this.options.goalStateManager.cancel(goalId, response.reason);
      return;
    }

    const outcome = reviewOutcomeFromResponse(response);
    await this.options.goalStateManager.clearBlocker(goalId, record.hitlId);
    await this.options.goalStateManager.finalizeReview(goalId, reviewInputFromResponse(goalId, response, outcome.outcome, outcome.comment));
  }

  async #failUnrecoverable(record: HitlRecord, response: HitlResponse, fallback: string): Promise<void> {
    const goalId = record.owner.ownerId;
    if (response.type === "cancel") {
      await this.options.goalStateManager.cancel(goalId, response.reason);
      return;
    }
    await this.options.goalStateManager.fail(goalId, fallback);
  }
}

function reviewInputFromResponse(
  goalId: string,
  response: HitlResponse,
  verdict: GoalReviewVerdict,
  comment: string | undefined,
): GoalFinalizeReviewInput {
  const receipt = reviewReceiptFromResponse(response, verdict, comment);
  return {
    verdict: receipt.verdict,
    summary: receipt.summary,
    evidenceRefs: receipt.evidenceRefs,
    unresolvedItems: receipt.unresolvedItems,
    authorization: {
      agentName: "reviewer",
      sessionRole: "review",
      sessionGoalId: goalId,
      reviewerSessionId: receipt.reviewerSessionId,
    },
  };
}

function reviewReceiptFromResponse(response: HitlResponse, verdict: GoalReviewVerdict, comment: string | undefined): GoalReviewReceipt {
  if (response.type === "review_outcome" && response.receipt !== undefined) return response.receipt;
  const summary = comment ?? `Review outcome: ${verdict}`;
  return {
    verdict,
    summary,
    evidenceRefs: verdict === "DONE" ? [{ kind: "hitl", ref: "review_outcome", summary }] : [],
    reviewerSessionId: response.type === "review_outcome" ? response.reviewedBy ?? "hitl-reviewer" : "hitl-reviewer",
    decidedAt: new Date().toISOString(),
  };
}
