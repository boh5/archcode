import type { WorkflowStage, WorkflowState, WorkflowStatus, WorkflowType } from "./state";
import {
  getCompletionPolicyForType,
  getStagesForType,
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
  hasStageCompletion?: (stage: WorkflowStage) => boolean;
  hasUserApproval: boolean;
}

export interface TransitionContext {
  hasArtifact: (kind: string) => boolean;
  hasStageCompletion: (stage: WorkflowStage) => boolean;
  hasUserApproval: boolean;
}

export interface WorkflowTransitionState {
  id?: string;
  type: WorkflowType;
  status: WorkflowStatus;
  stage: WorkflowStage;
  retryCount: number;
  maxRetries: number;
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

  if (input.hasStageCompletion) {
    const missingStage = missingStageCompletionPrerequisite(
      input.workflowType,
      input.currentStage,
      input.targetStage,
      input.hasStageCompletion,
    );
    if (missingStage) {
      return denied(
        new WorkflowTransitionError(
          input.workflowId,
          input.currentStage,
          input.targetStage,
          `Workflow ${input.workflowId} cannot enter ${input.targetStage}: prerequisite stage ${missingStage} has no completion record`,
        ),
      );
    }
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

export function canTransitionTo(
  workflow: WorkflowTransitionState,
  targetStage: WorkflowStage,
  context: TransitionContext,
): TransitionResult {
  if (workflow.status !== "active") {
    return denied(
      new WorkflowTransitionError(
        workflow.id ?? "unknown",
        workflow.stage,
        targetStage,
        `Workflow is not active (status: ${workflow.status})`,
      ),
    );
  }

  return validateTransition({
    workflowId: workflow.id ?? "unknown",
    workflowType: workflow.type,
    currentStage: workflow.stage,
    targetStage,
    retryCount: workflow.retryCount,
    maxRetries: workflow.maxRetries,
    hasArtifact: context.hasArtifact,
    hasStageCompletion: context.hasStageCompletion,
    hasUserApproval: context.hasUserApproval,
  });
}

export function canCompleteWorkflow(
  workflow: WorkflowState,
  hasArtifact: (kind: string) => boolean,
): TransitionResult {
  if (workflow.status !== "active") {
    return denied(
      new WorkflowTransitionError(
        workflow.id,
        workflow.stage,
        "completed" as WorkflowStage,
        `Cannot complete workflow with status "${workflow.status}". Only active workflows can be completed.`,
      ),
    );
  }

  const policy = getCompletionPolicyForType(workflow.type);
  const stages = getStagesForType(workflow.type);
  const requiredStageIndex = stages.indexOf(policy.requiredStage);
  const currentStageIndex = stages.indexOf(workflow.stage);

  if (currentStageIndex < requiredStageIndex) {
    return denied(
      new WorkflowTransitionError(
        workflow.id,
        workflow.stage,
        policy.requiredStage,
        `Workflow has not reached required stage ${policy.requiredStage} (currently at ${workflow.stage})`,
      ),
    );
  }

  if (!workflow.stageCompletions[policy.requiredStage]) {
    return denied(
      new WorkflowTransitionError(
        workflow.id,
        workflow.stage,
        policy.requiredStage,
        `Required stage ${policy.requiredStage} has no completion record`,
      ),
    );
  }

  const missingArtifacts = (policy.requiredArtifacts ?? []).filter((kind) => !hasArtifact(kind));
  if (missingArtifacts.length > 0) {
    return denied(
      new WorkflowTransitionError(
        workflow.id,
        workflow.stage,
        policy.requiredStage,
        `Missing required artifact(s) for completion: ${missingArtifacts.join(", ")}`,
      ),
    );
  }

  return { allowed: true };
}

function missingStageCompletionPrerequisite(
  workflowType: WorkflowType,
  currentStage: WorkflowStage,
  targetStage: WorkflowStage,
  hasStageCompletion: (stage: WorkflowStage) => boolean,
): WorkflowStage | undefined {
  const canAdvanceFromCurrent = getTransitionsForType(workflowType, currentStage).includes(targetStage);
  if (!canAdvanceFromCurrent || currentStage === "idle") return undefined;
  if (!hasStageCompletion(currentStage)) return currentStage;
  return undefined;
}

function denied(error: Error): TransitionResult {
  return {
    allowed: false,
    error: error.message,
    errorName: error.name,
  };
}
