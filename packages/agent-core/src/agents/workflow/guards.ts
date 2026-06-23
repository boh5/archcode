import type { WorkflowInteraction, WorkflowStage, WorkflowState, WorkflowStatus, WorkflowType } from "./state";
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
  hasUnresolvedBlockingInteractions?: (stage: WorkflowStage) => boolean;
  hasResolvedBlockingDecisionInteractions?: (stage: WorkflowStage) => boolean;
  hasNoRequiredInteractionsReason?: (stage: WorkflowStage) => boolean;
  hasUserApproval: boolean;
}

export interface TransitionContext {
  hasArtifact: (kind: string) => boolean;
  hasStageCompletion: (stage: WorkflowStage) => boolean;
  hasUnresolvedBlockingInteractions?: (stage: WorkflowStage) => boolean;
  hasResolvedBlockingDecisionInteractions?: (stage: WorkflowStage) => boolean;
  hasNoRequiredInteractionsReason?: (stage: WorkflowStage) => boolean;
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

export class WorkflowUnresolvedInteractionsError extends Error {
  constructor(
    public readonly workflowId: string,
    public readonly currentStage: WorkflowStage,
    public readonly targetStage: WorkflowStage,
  ) {
    super(
      `Workflow ${workflowId} cannot advance from ${currentStage} to ${targetStage}: unresolved blocking interaction(s) remain in ${currentStage}`,
    );
    this.name = "WorkflowUnresolvedInteractionsError";
  }
}

const CRITIC_REVIEW_STAGES = new Set<WorkflowStage>([
  "critic_prd_review",
  "critic_spec_review",
]);

const INTERACTION_CLEARANCE_STAGES = new Set<WorkflowStage>([
  "requirements_interview",
  "product_drafting",
  "critic_prd_review",
  "spec_drafting",
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
          `Workflow ${input.workflowId} cannot enter ${input.targetStage}: record completion for ${missingStage} with workflow_record_completion before advancing`,
        ),
      );
    }
  }

  if (input.hasUnresolvedBlockingInteractions?.(input.currentStage)) {
    return denied(
      new WorkflowUnresolvedInteractionsError(
        input.workflowId,
        input.currentStage,
        input.targetStage,
      ),
    );
  }

  if (
    INTERACTION_CLEARANCE_STAGES.has(input.currentStage) &&
    !isBackwardTransition(input.workflowType, input.currentStage, input.targetStage) &&
    !input.hasResolvedBlockingDecisionInteractions?.(input.currentStage) &&
    !input.hasNoRequiredInteractionsReason?.(input.currentStage)
  ) {
    return denied(
      new WorkflowTransitionError(
        input.workflowId,
        input.currentStage,
        input.targetStage,
        `Workflow ${input.workflowId} cannot advance from ${input.currentStage} to ${input.targetStage}: stage requires either resolved blocking decisions or a recorded no-question reason`,
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
    hasUnresolvedBlockingInteractions: context.hasUnresolvedBlockingInteractions,
    hasResolvedBlockingDecisionInteractions: context.hasResolvedBlockingDecisionInteractions,
    hasNoRequiredInteractionsReason: context.hasNoRequiredInteractionsReason,
    hasUserApproval: context.hasUserApproval,
  });
}

export function hasUnresolvedBlockingInteractions(
  workflow: Pick<WorkflowState, "requiredInteractions" | "resolvedInteractions">,
  stage: WorkflowStage,
): boolean {
  const interactionsById = new Map<string, WorkflowInteraction>();
  for (const interaction of [...workflow.requiredInteractions, ...workflow.resolvedInteractions]) {
    interactionsById.set(interaction.id, interaction);
  }

  return workflow.requiredInteractions.some((interaction) => {
    if (interaction.stage !== stage || !interaction.blocking) return false;
    if (interaction.status === "proposed" || interaction.status === "requested" || interaction.status === "cancelled") {
      return true;
    }
    if (interaction.status === "superseded") {
      return !isResolvedInteraction(interaction, interactionsById, new Set<string>());
    }
    return false;
  });
}

export function hasResolvedBlockingDecisionInteractions(
  workflow: Pick<WorkflowState, "requiredInteractions" | "resolvedInteractions">,
  stage: WorkflowStage,
): boolean {
  return [...workflow.requiredInteractions, ...workflow.resolvedInteractions].some((interaction) => (
    interaction.stage === stage &&
    interaction.kind === "decision" &&
    interaction.blocking &&
    interaction.status === "resolved"
  ));
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

function isBackwardTransition(
  workflowType: WorkflowType,
  currentStage: WorkflowStage,
  targetStage: WorkflowStage,
): boolean {
  const stages = getStagesForType(workflowType);
  const currentIndex = stages.indexOf(currentStage);
  const targetIndex = stages.indexOf(targetStage);
  // Only recognize backward when both stages exist in the ordered list and
  // the target comes before the current. Unknown stages (-1) are NOT treated
  // as backward — they fall through to the normal completion check.
  return currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex;
}

function missingStageCompletionPrerequisite(
  workflowType: WorkflowType,
  currentStage: WorkflowStage,
  targetStage: WorkflowStage,
  hasStageCompletion: (stage: WorkflowStage) => boolean,
): WorkflowStage | undefined {
  const canAdvanceFromCurrent = getTransitionsForType(workflowType, currentStage).includes(targetStage);
  if (!canAdvanceFromCurrent || currentStage === "idle") return undefined;
  // Backward transitions (critic retries) don't require current-stage completion —
  // the whole point of going back is that the current stage wasn't satisfactorily completed.
  if (isBackwardTransition(workflowType, currentStage, targetStage)) return undefined;
  if (
    workflowType === "full_feature" &&
    targetStage === "critic_prd_review" &&
    !hasStageCompletion("requirements_interview")
  ) {
    return "requirements_interview";
  }
  if (!hasStageCompletion(currentStage)) return currentStage;
  return undefined;
}

function isResolvedInteraction(
  interaction: WorkflowInteraction,
  interactionsById: Map<string, WorkflowInteraction>,
  visited: Set<string>,
): boolean {
  if (interaction.status === "resolved") return true;
  if (interaction.status !== "superseded" || !interaction.supersededBy) return false;
  if (visited.has(interaction.id)) return false;
  visited.add(interaction.id);

  const supersedingInteraction = interactionsById.get(interaction.supersededBy);
  if (!supersedingInteraction) return false;
  return isResolvedInteraction(supersedingInteraction, interactionsById, visited);
}

function denied(error: Error): TransitionResult {
  return {
    allowed: false,
    error: error.message,
    errorName: error.name,
  };
}
