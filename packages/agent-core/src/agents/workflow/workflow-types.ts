import type { WorkflowStage, WorkflowType } from "./state";

export type ArtifactKind =
  | "RESEARCH"
  | "PRD"
  | "SPEC"
  | "TASKS"
  | "HANDOFF_SUMMARY"
  | "INTERACTIONS"
  | "CRITIC_REPORT"
  | "EVIDENCE"
  | "FINAL_REPORT";

export interface WorkflowTypeDefinition {
  type: WorkflowType;
  label: string;
  stages: readonly WorkflowStage[];
  initialStage: WorkflowStage;
  transitions: Record<WorkflowStage, readonly WorkflowStage[]>;
  stagePrerequisites: Record<WorkflowStage, readonly ArtifactKind[]>;
  completionPolicy: {
    requiredStage: WorkflowStage;
    requiredArtifacts?: readonly ArtifactKind[];
  };
}

const NO_TRANSITIONS: readonly WorkflowStage[] = [];
const NO_PREREQUISITES: readonly ArtifactKind[] = [];

function emptyTransitions(): Record<WorkflowStage, readonly WorkflowStage[]> {
  return {
    idle: NO_TRANSITIONS,
    researching: NO_TRANSITIONS,
    research_consolidation: NO_TRANSITIONS,
    quick_analysis: NO_TRANSITIONS,
    quick_patch: NO_TRANSITIONS,
    quick_verify: NO_TRANSITIONS,
    product_drafting: NO_TRANSITIONS,
    critic_prd_review: NO_TRANSITIONS,
    spec_drafting: NO_TRANSITIONS,
    critic_spec_review: NO_TRANSITIONS,
    awaiting_user_approval: NO_TRANSITIONS,
    foreman_executing: NO_TRANSITIONS,
    final_review: NO_TRANSITIONS,
  };
}

function emptyPrerequisites(): Record<WorkflowStage, readonly ArtifactKind[]> {
  return {
    idle: NO_PREREQUISITES,
    researching: NO_PREREQUISITES,
    research_consolidation: NO_PREREQUISITES,
    quick_analysis: NO_PREREQUISITES,
    quick_patch: NO_PREREQUISITES,
    quick_verify: NO_PREREQUISITES,
    product_drafting: NO_PREREQUISITES,
    critic_prd_review: NO_PREREQUISITES,
    spec_drafting: NO_PREREQUISITES,
    critic_spec_review: NO_PREREQUISITES,
    awaiting_user_approval: NO_PREREQUISITES,
    foreman_executing: NO_PREREQUISITES,
    final_review: NO_PREREQUISITES,
  };
}

export const WORKFLOW_TYPE_REGISTRY = {
  research_only: {
    type: "research_only",
    label: "Research only",
    stages: ["idle", "researching", "research_consolidation"],
    initialStage: "idle",
    transitions: {
      ...emptyTransitions(),
      idle: ["researching"],
      researching: ["research_consolidation"],
      research_consolidation: [],
    },
    stagePrerequisites: {
      ...emptyPrerequisites(),
      researching: [],
      research_consolidation: ["RESEARCH"],
    },
    completionPolicy: {
      requiredStage: "research_consolidation",
    },
  },
  quick_fix: {
    type: "quick_fix",
    label: "Quick fix",
    stages: ["idle", "quick_analysis", "quick_patch", "quick_verify"],
    initialStage: "idle",
    transitions: {
      ...emptyTransitions(),
      idle: ["quick_analysis"],
      quick_analysis: ["quick_patch"],
      quick_patch: ["quick_verify"],
      quick_verify: [],
    },
    stagePrerequisites: {
      ...emptyPrerequisites(),
      quick_analysis: [],
      quick_patch: [],
      quick_verify: [],
    },
    completionPolicy: {
      requiredStage: "quick_verify",
    },
  },
  full_feature: {
    type: "full_feature",
    label: "Full feature",
    stages: [
      "idle",
      "product_drafting",
      "critic_prd_review",
      "spec_drafting",
      "critic_spec_review",
      "awaiting_user_approval",
      "foreman_executing",
      "final_review",
    ],
    initialStage: "idle",
    transitions: {
      ...emptyTransitions(),
      idle: ["product_drafting"],
      product_drafting: ["critic_prd_review"],
      critic_prd_review: ["product_drafting", "spec_drafting"],
      spec_drafting: ["critic_spec_review"],
      critic_spec_review: ["spec_drafting", "awaiting_user_approval"],
      awaiting_user_approval: ["foreman_executing"],
      foreman_executing: ["final_review"],
      final_review: [],
    },
    stagePrerequisites: {
      ...emptyPrerequisites(),
      critic_prd_review: ["PRD"],
      critic_spec_review: ["SPEC", "TASKS"],
      awaiting_user_approval: ["SPEC", "TASKS"],
      foreman_executing: ["SPEC", "TASKS"],
    },
    completionPolicy: {
      requiredStage: "final_review",
    },
  },
} as const satisfies Record<WorkflowType, WorkflowTypeDefinition>;

export function getWorkflowTypeDefinition(type: WorkflowType): WorkflowTypeDefinition {
  return WORKFLOW_TYPE_REGISTRY[type];
}

export function getStagesForType(type: WorkflowType): readonly WorkflowStage[] {
  return getWorkflowTypeDefinition(type).stages;
}

export function getTransitionsForType(type: WorkflowType, stage: WorkflowStage): readonly WorkflowStage[] {
  return getWorkflowTypeDefinition(type).transitions[stage];
}

export function getStagePrerequisitesForType(type: WorkflowType, stage: WorkflowStage): readonly ArtifactKind[] {
  return getWorkflowTypeDefinition(type).stagePrerequisites[stage];
}

export function getCompletionPolicyForType(type: WorkflowType): WorkflowTypeDefinition["completionPolicy"] {
  return getWorkflowTypeDefinition(type).completionPolicy;
}

export function isValidTransitionForType(
  type: WorkflowType,
  from: WorkflowStage,
  to: WorkflowStage,
): boolean {
  return getTransitionsForType(type, from).includes(to);
}
