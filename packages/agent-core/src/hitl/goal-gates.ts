import type { DoneResult, GoalReviewOutcome } from "@archcode/protocol";

import type { GoalArtifactManager } from "../goals/artifacts";
import { writeGoalApprovalArtifactEvent } from "../goals/artifact-lifecycle";
import type { GoalStateManager } from "../goals/state";
import type { HitlKind, HitlPayload, HitlResponse, HitlTrigger } from "./types";

export type ApprovalOutcome = {
  approved: boolean;
  decision?: string;
  comment?: string;
};

export type ReviewArtifact = {
  path: string;
  description: string;
};

export type ReviewOutcome = {
  outcome: GoalReviewOutcome;
  comment?: string;
};

type GoalHitlGateway = {
  request(sessionId: string, kind: HitlKind, payload: HitlPayload, trigger: HitlTrigger): Promise<HitlResponse>;
};

export interface GoalApprovalGateOptions {
  hitlService: GoalHitlGateway;
  goalStateManager: GoalStateManager;
  goalArtifacts?: GoalArtifactManager;
}

export class GoalApprovalGate {
  readonly #hitlService: GoalHitlGateway;
  readonly #goalStateManager: GoalStateManager;
  readonly #goalArtifacts?: GoalArtifactManager;

  constructor(options: GoalApprovalGateOptions) {
    this.#hitlService = options.hitlService;
    this.#goalStateManager = options.goalStateManager;
    this.#goalArtifacts = options.goalArtifacts;
  }

  async requestApproval(
    goalId: string,
    sessionId: string,
    approvalPoint: "after_plan" | "before_complete",
    goalTitle: string,
    projectSlug: string,
  ): Promise<ApprovalOutcome> {
    await this.#recordApprovalArtifact(goalId, {
      approvalPoint,
      sessionId,
      status: "requested",
    });
    const response = await this.#hitlService.request(
      sessionId,
      "approval",
      {
        kind: "approval",
        title: approvalPoint === "after_plan" ? "Approve goal plan" : "Approve goal completion",
        message: approvalPoint === "after_plan"
          ? `Approve moving goal "${goalTitle}" from plan to build?`
          : `Approve completing goal "${goalTitle}"?`,
        action: `goal.approval.${approvalPoint}`,
        context: { goalId, projectSlug, approvalPoint, goalTitle },
        options: [
          { id: "approved", label: "Approve" },
          { id: "denied", label: "Deny" },
        ],
        recommendedOptionId: "approved",
      },
      { goalId, projectSlug, source: `goal.approval.${approvalPoint}`, approvalPoint },
    );

    const outcome = approvalOutcomeFromResponse(response);
    await this.#recordApprovalOutcome(goalId, approvalPoint, response, outcome);
    await this.#recordApprovalArtifact(goalId, {
      approvalPoint,
      sessionId,
      status: approvalArtifactStatus(response, outcome),
      decision: outcome.decision,
      comment: outcome.comment ?? (response.status === "resolved" ? undefined : response.reason),
    });
    return outcome;
  }

  async requestReview(
    goalId: string,
    sessionId: string,
    artifacts: ReviewArtifact[],
    projectSlug: string,
  ): Promise<ReviewOutcome> {
    const response = await this.#hitlService.request(
      sessionId,
      "review",
      {
        kind: "review",
        title: "Review goal artifacts",
        message: "Review the artifacts produced for this goal.",
        artifacts,
      },
      { goalId, projectSlug, source: "goal.review", approvalPoint: "review" },
    );

    const outcome = reviewOutcomeFromResponse(response);
    await this.#recordReviewOutcome(goalId, outcome);
    return outcome;
  }

  async #recordApprovalOutcome(
    goalId: string,
    approvalPoint: "after_plan" | "before_complete",
    response: HitlResponse,
    outcome: ApprovalOutcome,
  ): Promise<void> {
    const label = response.status === "resolved"
      ? (outcome.decision ?? (outcome.approved ? "approved" : "denied"))
      : response.status;
    const detail = outcome.comment ?? (response.status === "resolved" ? undefined : response.reason);
    const message = detail
      ? `Approval ${approvalPoint} ${label}: ${detail}`
      : `Approval ${approvalPoint} ${label}`;
    await this.#goalStateManager.updateLastError(goalId, message);
  }

  async #recordReviewOutcome(goalId: string, outcome: ReviewOutcome): Promise<void> {
    const result: DoneResult = {
      conditionId: "reviewer_approval",
      passed: outcome.outcome === "DONE",
      evidence: outcome.comment ?? `Review outcome: ${outcome.outcome}`,
      checkedAt: new Date().toISOString(),
    };
    await this.#goalStateManager.recordDoneResult(goalId, "reviewer_approval", result);
  }

  async #recordApprovalArtifact(goalId: string, event: {
    approvalPoint: string;
    sessionId: string;
    status: "requested" | "approved" | "denied" | "cancelled" | "timeout";
    decision?: string;
    comment?: string;
  }): Promise<void> {
    const goalArtifacts = this.#goalArtifacts;
    if (goalArtifacts === undefined) return;
    const goal = await this.#goalStateManager.read(goalId);
    await writeGoalApprovalArtifactEvent(goalArtifacts, goal, event);
  }
}

function approvalOutcomeFromResponse(response: HitlResponse): ApprovalOutcome {
  if (response.status !== "resolved") return { approved: false };

  const decision = response.response.decision
    ?? (typeof response.response.data?.approved === "boolean"
      ? (response.response.data.approved ? "approved" : "denied")
      : undefined);
  const approved = decision === "approved" || response.response.outcome === "DONE";
  return withoutUndefined({ approved, decision, comment: response.response.comment });
}

function reviewOutcomeFromResponse(response: HitlResponse): ReviewOutcome {
  if (response.status !== "resolved") {
    return { outcome: "NOT_DONE", comment: response.reason };
  }

  return withoutUndefined({
    outcome: response.response.outcome ?? (response.response.decision === "approved" ? "DONE" : "NOT_DONE"),
    comment: response.response.comment,
  });
}

function approvalArtifactStatus(response: HitlResponse, outcome: ApprovalOutcome): "approved" | "denied" | "cancelled" | "timeout" {
  if (response.status === "cancelled" || response.status === "timeout") return response.status;
  return outcome.approved ? "approved" : "denied";
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
