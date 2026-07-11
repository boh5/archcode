import type { GoalBlocker, GoalReviewReceipt, GoalReviewVerdict, GoalState, HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalApprovalGate, approvalOutcomeFromResponse, reviewOutcomeFromResponse } from "../hitl/goal-gates";
import type { GoalHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import type { HitlService } from "../hitl/service";
import { GoalStateError, type GoalFinalizeReviewInput, type GoalStateManager } from "./state";
import { GoalCancellationError, type GoalCancellationCapability } from "./cancellation";
import { withGoalExecutionClaimLock } from "./execution-claim";

export interface GoalHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly goalStateManager: GoalStateManager;
  readonly hitlService: HitlService;
  readonly goalCancellation: GoalCancellationCapability;
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
    if (response.type === "cancel") {
      await this.options.goalCancellation.cancel(goalId, {
        source: "hitl",
        reason: response.reason,
        hitlId: record.hitlId,
      });
      return;
    }

    await withGoalExecutionClaimLock(goalId, async () => {
      const goal = await this.options.goalStateManager.read(goalId);
      if (goal.status === "cancelled") {
        throw new GoalCancellationError(goalId, `Goal ${goalId} is cancelled and cannot resume HITL ${record.hitlId}`);
      }
      if (goal.appliedHitlIds.includes(record.hitlId)) return;
      await this.#ensureAttached(goal, record);

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
          await this.#failUnrecoverable(record, `Unsupported Goal HITL source: ${record.source.type}`);
      }
    });
  }

  async #ensureAttached(goal: GoalState, record: HitlRecord): Promise<void> {
    const hitlId = record.hitlId;
    const attached = goal.approvalRefs.includes(hitlId);
    const pending = goal.pendingHitlIds.includes(hitlId);
    if (pending) {
      if (!attached) {
        throw new GoalStateError(goal.id, `Goal ${goal.id} HITL ${hitlId} is pending without a durable attachment marker`);
      }
      if (goal.status !== "blocked" || goal.blocker?.hitlId !== hitlId) {
        throw new GoalStateError(goal.id, `Goal ${goal.id} HITL ${hitlId} is pending but is not the active blocker`);
      }
      return;
    }
    if (attached) {
      throw new GoalStateError(goal.id, `Goal ${goal.id} HITL ${hitlId} was attached but is neither pending nor applied`);
    }

    await this.options.goalStateManager.attachHitlBlocker(goal.id, {
      blocker: blockerFromOwnerRecord(record),
      approvalRef: hitlId,
    });
  }

  async #resumeApprovalLike(record: HitlRecord, response: HitlResponse): Promise<void> {
    const goalId = record.owner.ownerId;
    if (record.source.type === "goal_approval") {
      await this.#approvalGate.recordApprovalResponse(goalId, record.source.approvalPoint ?? "approval", response);
    }

    const outcome = approvalOutcomeFromResponse(response);
    if (!outcome.approved) {
      await this.options.goalStateManager.failHitl(goalId, record.hitlId, outcome.comment ?? "Goal HITL denied");
      return;
    }

    await this.options.goalStateManager.clearBlocker(goalId, record.hitlId);
  }

  async #resumeReview(record: HitlRecord, response: HitlResponse): Promise<void> {
    const goalId = record.owner.ownerId;
    const outcome = reviewOutcomeFromResponse(response);
    await this.options.goalStateManager.finalizeHitlReview(
      goalId,
      record.hitlId,
      reviewInputFromResponse(goalId, response, outcome.outcome, outcome.comment),
    );
  }

  async #failUnrecoverable(record: HitlRecord, fallback: string): Promise<void> {
    const goalId = record.owner.ownerId;
    await this.options.goalStateManager.failHitl(goalId, record.hitlId, fallback);
  }
}

function blockerFromOwnerRecord(record: HitlRecord): Omit<GoalBlocker, "createdAt" | "hitlId"> & { hitlId: string } {
  const summary = record.displayPayload.summary ?? record.displayPayload.title;
  switch (record.source.type) {
    case "goal_approval":
      return {
        kind: "approval",
        summary,
        hitlId: record.hitlId,
        source: record.source.approvalPoint ?? record.source.type,
        resumeStatus: record.source.resumeStatus,
      };
    case "goal_budget":
      return {
        kind: "budget",
        summary,
        hitlId: record.hitlId,
        source: record.source.approvalPoint ?? record.source.type,
        resumeStatus: record.source.resumeStatus,
      };
    case "goal_question":
      return {
        kind: "question",
        summary,
        hitlId: record.hitlId,
        source: record.source.questionKey,
        resumeStatus: record.source.resumeStatus,
      };
    case "goal_review":
      return {
        kind: "approval",
        summary,
        hitlId: record.hitlId,
        source: "goal_review",
        resumeStatus: record.source.resumeStatus,
      };
    default:
      throw new GoalStateError(record.owner.ownerId, `Unsupported Goal HITL source: ${record.source.type}`);
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
