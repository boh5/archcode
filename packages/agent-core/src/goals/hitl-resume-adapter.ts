import type { ApprovalPoint, DoneResult, GoalHitlCheckpoint, HitlRecord, HitlResponse } from "@archcode/protocol";

import { GoalApprovalGate, approvalOutcomeFromResponse, reviewOutcomeFromResponse } from "../hitl/goal-gates";
import type { GoalHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import type { HitlService } from "../hitl/service";
import type { GoalArtifactManager } from "./artifacts";
import type { ReviewerReviewOptions } from "./runner";
import { GoalRunner } from "./runner";
import type { GoalStateManager } from "./state";

export interface GoalHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly goalStateManager: GoalStateManager;
  readonly goalArtifacts: GoalArtifactManager;
  readonly hitlService: HitlService;
  readonly createRunner: () => GoalRunner;
}

export class GoalHitlResumeAdapter implements ResumeAdapterContract {
  readonly #approvalGate: GoalApprovalGate;

  constructor(private readonly options: GoalHitlResumeAdapterOptions) {
    this.#approvalGate = new GoalApprovalGate({
      hitlService: options.hitlService,
      goalStateManager: options.goalStateManager,
      goalArtifacts: options.goalArtifacts,
    });
  }

  async resume(record: HitlRecord, response: HitlResponse): Promise<void> {
    if (record.owner.ownerType !== "goal") throw new Error(`Goal adapter cannot resume ${record.owner.ownerType} HITL`);
    const goal = await this.options.goalStateManager.read(record.owner.ownerId);
    const checkpoint = goal.resumeCheckpoint;
    if (checkpoint === undefined || checkpoint.hitlId !== record.hitlId) {
      return;
    }

    switch (checkpoint.kind) {
      case "goal_approval":
        await this.#resumeApproval(checkpoint, response);
        return;
      case "goal_review":
        await this.#resumeReview(checkpoint, response);
        return;
      case "goal_budget":
      case "goal_question":
        await this.#pauseUnsupportedCheckpoint(checkpoint, response);
        return;
    }
  }

  async #resumeApproval(checkpoint: Extract<GoalHitlCheckpoint, { kind: "goal_approval" }>, response: HitlResponse): Promise<void> {
    const goalId = await this.#goalIdForCheckpoint(checkpoint.hitlId);
    const latest = await this.options.goalStateManager.read(goalId);
    await this.#approvalGate.recordApprovalResponse(goalId, checkpoint.approvalPoint, latest.mainSessionId ?? "goal", response);
    await this.options.goalStateManager.clearHitlBlocker(goalId, checkpoint.hitlId);

    const outcome = approvalOutcomeFromResponse(response);
    if (!outcome.approved) {
      const reason = checkpoint.action === "complete"
        ? "Goal completion approval denied or cancelled"
        : "Goal after-plan approval denied or cancelled";
      await this.options.goalStateManager.updateLastError(goalId, approvalPauseReason(reason, response));
      const current = await this.options.goalStateManager.read(goalId);
      if (current.status !== "paused") await this.options.goalStateManager.transitionStatus(goalId, "paused");
      return;
    }

    const runner = this.options.createRunner();
    if (checkpoint.action === "advancePhase") {
      const current = await this.options.goalStateManager.read(goalId);
      if (current.status !== "paused" || current.phase !== "plan") return;
      await this.options.goalStateManager.resumeStatusAfterHitl(goalId, "running");
      await runner.advancePhase(goalId, "build", { skipApproval: true });
      return;
    }

    const current = await this.options.goalStateManager.read(goalId);
    if (current.status !== "paused" || current.phase !== "review") return;
    await this.options.goalStateManager.resumeStatusAfterHitl(goalId, "reviewed");
    await runner.complete(goalId, { skipApproval: true });
  }

  async #resumeReview(checkpoint: Extract<GoalHitlCheckpoint, { kind: "goal_review" }>, response: HitlResponse): Promise<void> {
    const goalId = await this.#goalIdForCheckpoint(checkpoint.hitlId);
    const outcome = reviewOutcomeFromResponse(response);
    await this.options.goalStateManager.clearHitlBlocker(goalId, checkpoint.hitlId);
    await this.options.goalStateManager.recordDoneResult(goalId, "reviewer_approval", reviewDoneResult(outcome));
    const current = await this.options.goalStateManager.read(goalId);
    if (current.status === "paused") await this.options.goalStateManager.resumeStatusAfterHitl(goalId, "verifying");
    const runner = this.options.createRunner();
    const options: ReviewerReviewOptions = response.type === "review_outcome" && response.report !== undefined
      ? { reviewerAgent: response.report.reviewerAgent, summary: response.report.summary }
      : { summary: outcome.comment };
    await runner.finalizeReviewerReview(goalId, outcome.outcome, options);
  }

  async #pauseUnsupportedCheckpoint(checkpoint: GoalHitlCheckpoint, response: HitlResponse): Promise<void> {
    const goalId = await this.#goalIdForCheckpoint(checkpoint.hitlId);
    await this.options.goalStateManager.clearHitlBlocker(goalId, checkpoint.hitlId);
    const reason = response.type === "cancel" ? response.reason : `Goal HITL ${checkpoint.kind} resolved`;
    await this.options.goalStateManager.updateLastError(goalId, reason);
    const current = await this.options.goalStateManager.read(goalId);
    if (current.status !== "paused") await this.options.goalStateManager.transitionStatus(goalId, "paused");
  }

  async #goalIdForCheckpoint(hitlId: string): Promise<string> {
    const found = await this.options.hitlService.lookup(hitlId);
    if (found.status !== "found" || found.record.owner.ownerType !== "goal") throw new Error(`Missing Goal HITL ${hitlId}`);
    return found.record.owner.ownerId;
  }
}

function approvalPauseReason(prefix: string, response: HitlResponse): string {
  if (response.type === "cancel") return `${prefix}: ${response.reason}`;
  return response.type === "approval_decision" && response.comment !== undefined ? `${prefix}: ${response.comment}` : prefix;
}

function reviewDoneResult(outcome: ReturnType<typeof reviewOutcomeFromResponse>): DoneResult {
  return {
    conditionId: "reviewer_approval",
    passed: outcome.outcome === "DONE",
    evidence: outcome.comment ?? `Review outcome: ${outcome.outcome}`,
    checkedAt: new Date().toISOString(),
  };
}
