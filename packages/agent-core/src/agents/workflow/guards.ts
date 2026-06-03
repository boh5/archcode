import type { WorkflowStage } from "./state";

export type ArtifactKind = "RESEARCH" | "PRD" | "SPEC" | "TASKS";

export interface TransitionInput {
  workflowId: string;
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

export const LEGAL_STAGE_TRANSITIONS = {
  idle: ["product_drafting", "researching", "quick_analysis"],
  researching: ["research_consolidation"],
  research_consolidation: [],
  quick_analysis: ["quick_patch"],
  quick_patch: ["quick_verify"],
  quick_verify: [],
  product_drafting: ["critic_prd_review"],
  critic_prd_review: ["product_drafting", "spec_drafting"],
  spec_drafting: ["critic_spec_review"],
  critic_spec_review: ["spec_drafting", "awaiting_user_approval"],
  awaiting_user_approval: ["foreman_executing"],
  foreman_executing: ["final_review"],
  final_review: [],
} as const satisfies Record<WorkflowStage, readonly WorkflowStage[]>;

export const ARTIFACT_PREREQUISITES = {
  idle: [],
  product_drafting: [],
  critic_prd_review: ["PRD"],
  spec_drafting: [],
  critic_spec_review: ["SPEC", "TASKS"],
  awaiting_user_approval: ["SPEC", "TASKS"],
  foreman_executing: ["SPEC", "TASKS"],
  final_review: [],
  researching: [],
  research_consolidation: ["RESEARCH"],
  quick_analysis: [],
  quick_patch: [],
  quick_verify: [],
} as const satisfies Record<WorkflowStage, readonly ArtifactKind[]>;

const CRITIC_REVIEW_STAGES = new Set<WorkflowStage>([
  "critic_prd_review",
  "critic_spec_review",
]);

export function validateTransition(input: TransitionInput): TransitionResult {
  const legalTargets: readonly WorkflowStage[] = LEGAL_STAGE_TRANSITIONS[input.currentStage];
  if (!legalTargets.includes(input.targetStage)) {
    return denied(
      new WorkflowTransitionError(input.workflowId, input.currentStage, input.targetStage),
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

  const missingArtifacts = ARTIFACT_PREREQUISITES[input.targetStage].filter(
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
