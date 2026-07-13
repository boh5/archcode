import type { GoalReviewReceipt, HitlRecord, HitlResponse } from "@archcode/protocol";

import type { GoalStateManager } from "../goals/state";
import { withGoalExecutionClaimLock } from "../goals/execution-claim";
import type { CreateHitlRecordInput } from "./service";

export type ApprovalOutcome = {
  approved: boolean;
  decision?: string;
  comment?: string;
};

export type ReviewOutcome = {
  outcome: "DONE" | "NOT_DONE";
  comment?: string;
  receipt?: GoalReviewReceipt;
};

export type GoalHitlGateway = {
  create(input: CreateHitlRecordInput): Promise<HitlRecord>;
  publishRequest?(record: HitlRecord): Promise<void>;
};

export interface GoalApprovalGateOptions {
  hitlService: GoalHitlGateway;
  goalStateManager: GoalStateManager;
}

export class GoalApprovalGate {
  readonly #hitlService: GoalHitlGateway;
  readonly #goalStateManager: GoalStateManager;

  constructor(options: GoalApprovalGateOptions) {
    this.#hitlService = options.hitlService;
    this.#goalStateManager = options.goalStateManager;
  }

  async requestApproval(input: {
    goalId: string;
    projectSlug: string;
    approvalPoint: string;
    summary: string;
  }): Promise<HitlRecord> {
    return await withGoalExecutionClaimLock(input.goalId, async () => {
      const record = await this.#hitlService.create({
        owner: { projectSlug: input.projectSlug, ownerType: "goal", ownerId: input.goalId },
        blockingKey: `goal:${input.goalId}:approval:${input.approvalPoint}`,
        source: {
          type: "goal_approval",
          goalId: input.goalId,
          approvalPoint: input.approvalPoint,
        },
        displayPayload: {
          title: "Approve Goal continuation",
          summary: input.summary,
          fields: [
            { label: "Goal ID", value: input.goalId },
            { label: "Approval point", value: input.approvalPoint },
            { label: "Recommended option", value: "approved" },
          ],
          redacted: true,
        },
      });

      await this.#goalStateManager.attachHitlBlocker(input.goalId, {
        blocker: {
          kind: "approval",
          summary: input.summary,
          hitlId: record.hitlId,
          source: input.approvalPoint,
        },
        approvalRef: record.hitlId,
      });
      await this.#hitlService.publishRequest?.(record);
      return record;
    });
  }

  async requestReview(input: {
    goalId: string;
    projectSlug: string;
    summary?: string;
  }): Promise<HitlRecord> {
    return await withGoalExecutionClaimLock(input.goalId, async () => {
      const summary = input.summary ?? `Reviewer outcome required for Goal ${input.goalId}.`;
      const record = await this.#hitlService.create({
        owner: { projectSlug: input.projectSlug, ownerType: "goal", ownerId: input.goalId },
        blockingKey: `goal:${input.goalId}:review`,
        source: { type: "goal_review", goalId: input.goalId },
        displayPayload: {
          title: "Review Goal outcome",
          summary,
          fields: [{ label: "Goal ID", value: input.goalId }],
          redacted: true,
        },
      });
      await this.#goalStateManager.attachHitlBlocker(input.goalId, {
        blocker: {
          kind: "approval",
          summary,
          hitlId: record.hitlId,
          source: "goal_review",
        },
        approvalRef: record.hitlId,
      });
      await this.#hitlService.publishRequest?.(record);
      return record;
    });
  }

  async recordApprovalResponse(goalId: string, approvalPoint: string, response: HitlResponse): Promise<ApprovalOutcome> {
    const outcome = approvalOutcomeFromResponse(response);
    const label = response.type === "approval_decision" ? outcome.decision : response.type;
    const detail = outcome.comment ?? (response.type === "cancel" ? response.reason : undefined);
    await this.#goalStateManager.updateLastError(goalId, detail === undefined
      ? `Approval ${approvalPoint} ${label}`
      : `Approval ${approvalPoint} ${label}: ${detail}`);
    return outcome;
  }
}

export function approvalOutcomeFromResponse(response: HitlResponse): ApprovalOutcome {
  if (response.type !== "approval_decision") {
    return withoutUndefined({ approved: false, comment: response.type === "cancel" ? response.reason : undefined });
  }
  return withoutUndefined({ approved: response.decision === "approved", decision: response.decision, comment: response.comment });
}

export function reviewOutcomeFromResponse(response: HitlResponse): ReviewOutcome {
  if (response.type !== "review_outcome") {
    return { outcome: "NOT_DONE", comment: response.type === "cancel" ? response.reason : undefined };
  }
  return withoutUndefined({ outcome: response.outcome, comment: response.comment, receipt: response.receipt });
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
