import type { WorkflowStage, WorkflowType } from "./state";
import {
  getStagePrerequisitesForType,
  getTransitionsForType,
  isValidTransitionForType,
} from "./workflow-types";

export type { ArtifactKind } from "./workflow-types";

export interface TransitionInput {
  workflowId: string;
  workflowType: WorkflowType;
  currentStage: WorkflowStage;
  targetStage: WorkflowStage;
  retryCount: number;
  maxRetries: number;
  hasArtifact: (kind: string) => boolean;
  hasUserApproval: boolean;
}

export interface TransitionResult {
  allowed: boolean;
  error?: string;
  errorName?: string;
}

export class WorkflowTransitionError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentStage: WorkflowStage,
    public readonly targetStage: WorkflowStage,
    message?: string,
  ) {
    super(message ?? `Illegal workflow transition for ${workflowId}: ${currentStage} -> ${targetStage}`);
    this.name = "WorkflowTransitionError";
  }
}

export class WorkflowRetryLimitError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentStage: WorkflowStage,
    public readonly targetStage: WorkflowStage,
    public readonly retryCount: number,
    public readonly maxRetries: number,
  ) {
    super(
      `Workflow ${workflowId} cannot enter ${targetStage}: retry limit reached (${retryCount}/${maxRetries})`,
    );
    this.name = "WorkflowRetryLimitError";
  }
}

const CRITIC_REVIEW_STAGES = new Set<WorkflowStage>([
  "critic_prd_review",
  "critic_spec_review",
]);

export function validateTransition(input: TransitionInput): TransitionResult {
  if (!isValidTransitionForType(input.workflowType, input.currentStage, input.targetStage)) {
    const legalTargets = getTransitionsForType(input.workflowType, input.currentStage);
    return denied(
      new WorkflowTransitionError(
        input.workflowId,
        input.currentStage,
        input.targetStage,
        `Illegal ${input.workflowType} workflow transition for ${input.workflowId}: ${input.currentStage} -> ${input.targetStage}. Allowed: ${legalTargets.join(", ") || "none"}`,
      ),
    );
  }

  if (CRITIC_REVIEW_STAGES.has(input.targetStage) && input.retryCount >= input.maxRetries) {
    return denied(
      new WorkflowRetryLimitError(
        input.workflowId,
        input.currentStage,
        input.targetStage,
        input.retryCount,
        input.maxRetries,
      ),
    );
  }

  const missingArtifacts = getStagePrerequisitesForType(input.workflowType, input.targetStage).filter(
    (kind) => !input.hasArtifact(kind),
  );
  if (missingArtifacts.length > 0) {
    return denied(
      new WorkflowTransitionError(
        input.workflowId,
        input.currentStage,
        input.targetStage,
        `Workflow ${input.workflowId} cannot enter ${input.targetStage}: missing required artifact(s): ${missingArtifacts.join(", ")}`,
      ),
    );
  }

  if (input.targetStage === "foreman_executing" && !input.hasUserApproval) {
    return denied(
      new WorkflowTransitionError(
        input.workflowId,
        input.currentStage,
        input.targetStage,
        `Workflow ${input.workflowId} cannot enter foreman_executing without user approval`,
      ),
    );
  }

  return { allowed: true };
}

function denied(error: Error): TransitionResult {
  return {
    allowed: false,
    error: error.message,
    errorName: error.name,
  };
}
