import {
  GOAL_HITL_ACTION_ADVANCE_PHASE,
  GOAL_HITL_ACTION_COMPLETE,
  GOAL_HITL_ACTION_FINALIZE_REVIEW,
} from "@archcode/protocol";
import type { ApprovalPoint, GoalHitlCheckpoint, GoalReviewOutcome, HitlRecord, HitlResponse } from "@archcode/protocol";

import type { GoalArtifactManager } from "../goals/artifacts";
import { writeGoalApprovalArtifactEvent } from "../goals/artifact-lifecycle";
import type { GoalStateManager } from "../goals/state";
import type { CreateHitlRecordInput } from "./service";

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

export type GoalHitlGateway = {
  create(input: CreateHitlRecordInput): Promise<HitlRecord>;
  publishRequest?(record: HitlRecord): Promise<void>;
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
    approvalPoint: ApprovalPoint,
    goalTitle: string,
    projectSlug: string,
  ): Promise<HitlRecord> {
    await this.#recordApprovalArtifact(goalId, {
      approvalPoint,
      sessionId,
      status: "requested",
    });
    const record = await this.#hitlService.create({
      owner: { projectSlug, ownerType: "goal", ownerId: goalId },
      blockingKey: `goal:${goalId}:approval:${approvalPoint}`,
      source: { type: "goal_approval", goalId, approvalPoint },
      displayPayload: {
        title: approvalPoint === "after_plan" ? "Approve goal plan" : "Approve goal completion",
        summary: approvalPoint === "after_plan"
          ? `Approve moving goal "${goalTitle}" from plan to build?`
          : `Approve completing goal "${goalTitle}"?`,
        fields: [
          { label: "Goal", value: goalTitle },
          { label: "Approval point", value: approvalPoint },
          { label: "Recommended option", value: "approved" },
        ],
        redacted: true,
      },
    });
    await this.#goalStateManager.blockOnHitl(goalId, approvalCheckpoint(record.hitlId, approvalPoint));
    await this.#goalStateManager.updateLastError(goalId, `Waiting for ${approvalPoint} approval`);
    await this.#hitlService.publishRequest?.(record);
    return record;
  }

  async requestReview(
    goalId: string,
    artifacts: ReviewArtifact[],
    projectSlug: string,
  ): Promise<HitlRecord> {
    const record = await this.#hitlService.create({
      owner: { projectSlug, ownerType: "goal", ownerId: goalId },
      blockingKey: `goal:${goalId}:review`,
      source: { type: "goal_review", goalId },
      displayPayload: {
        title: "Review goal artifacts",
        summary: "Review the artifacts produced for this goal.",
        fields: artifacts.map((artifact) => ({ label: artifact.path, value: artifact.description })),
        redacted: true,
      },
    });
    await this.#goalStateManager.blockOnHitl(goalId, {
      version: 1,
      hitlId: record.hitlId,
      blockedAt: new Date().toISOString(),
      kind: "goal_review",
      action: GOAL_HITL_ACTION_FINALIZE_REVIEW,
      reason: "Reviewer HITL outcome required",
    });
    await this.#goalStateManager.updateLastError(goalId, "Waiting for reviewer HITL outcome");
    const current = await this.#goalStateManager.read(goalId);
    if (current.status !== "paused") await this.#goalStateManager.transitionStatus(goalId, "paused");
    await this.#hitlService.publishRequest?.(record);
    return record;
  }

  async recordApprovalResponse(
    goalId: string,
    approvalPoint: ApprovalPoint,
    sessionId: string,
    response: HitlResponse,
  ): Promise<ApprovalOutcome> {
    const outcome = approvalOutcomeFromResponse(response);
    const label = response.type === "approval_decision" ? outcome.decision : response.type;
    const detail = outcome.comment ?? (response.type === "cancel" ? response.reason : undefined);
    const message = detail
      ? `Approval ${approvalPoint} ${label}: ${detail}`
      : `Approval ${approvalPoint} ${label}`;
    await this.#goalStateManager.updateLastError(goalId, message);
    await this.#recordApprovalArtifact(goalId, {
      approvalPoint,
      sessionId,
      status: approvalArtifactStatus(response, outcome),
      decision: outcome.decision,
      comment: detail,
    });
    return outcome;
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
  return withoutUndefined({ outcome: response.outcome, comment: response.comment });
}

function approvalArtifactStatus(response: HitlResponse, outcome: ApprovalOutcome): "approved" | "denied" | "cancelled" | "timeout" {
  if (response.type === "cancel") return "cancelled";
  return outcome.approved ? "approved" : "denied";
}

function approvalCheckpoint(hitlId: string, approvalPoint: ApprovalPoint): GoalHitlCheckpoint {
  const base = { version: 1 as const, hitlId, blockedAt: new Date().toISOString(), kind: "goal_approval" as const };
  return approvalPoint === "after_plan"
    ? { ...base, action: GOAL_HITL_ACTION_ADVANCE_PHASE, from: "plan", to: "build", approvalPoint, phase: "plan", reason: "After-plan approval required" }
    : { ...base, action: GOAL_HITL_ACTION_COMPLETE, approvalPoint, phase: "review", reason: "Before-complete approval required" };
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
