import { describe, expect, test } from "bun:test";

import {
  canCompleteWorkflow,
  canTransitionTo,
  validateTransition,
  WorkflowRetryLimitError,
  WorkflowTransitionError,
  type TransitionInput,
} from "./guards";
import type { WorkflowStage, WorkflowState, WorkflowType } from "./state";
import {
  getCompletionPolicyForType,
  getStagePrerequisitesForType,
  getTransitionsForType,
  WORKFLOW_TYPE_REGISTRY,
  type ArtifactKind,
} from "./workflow-types";

function input(overrides: Partial<TransitionInput>): TransitionInput {
  const artifacts = new Set<ArtifactKind>([
    "RESEARCH",
    "PRD",
    "SPEC",
    "TASKS",
    "HANDOFF_SUMMARY",
    "INTERACTIONS",
    "CRITIC_REPORT",
    "EVIDENCE",
    "FINAL_REPORT",
  ]);
  return { workflowId: "wf-guards",
  workflowType: "full_feature",
  currentStage: "idle",
  targetStage: "product_drafting",
  retryCount: 0,
  maxRetries: 3,
  hasArtifact: (kind: string) => artifacts.has(kind as ArtifactKind),
  hasUserApproval: true, ...overrides,  };
}

function workflowState(overrides: Partial<WorkflowState>): WorkflowState {
  const now = new Date().toISOString();
  return {
    id: "wf-complete-guards",
    type: "full_feature",
    stage: "idle",
    status: "active",
    artifacts: {},
    stageCompletions: {},
    derivedWorkflows: [],
    sessionIds: {},
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

describe("workflow transition guards", () => {
  test("allows every legal transition from each workflow type graph", () => {
    for (const workflowType of Object.keys(WORKFLOW_TYPE_REGISTRY) as WorkflowType[]) {
      const definition = WORKFLOW_TYPE_REGISTRY[workflowType];
      for (const currentStage of definition.stages) {
        for (const targetStage of getTransitionsForType(workflowType, currentStage)) {
          const result = validateTransition(input({ workflowType, currentStage, targetStage }));
          expect(result, `${workflowType}: ${currentStage} -> ${targetStage}`).toEqual({ allowed: true });
        }
      }
    }
  });

  test("rejects transitions not present in the selected workflow type graph", () => {
    const result = validateTransition(
      input({ workflowType: "full_feature", currentStage: "idle", targetStage: "foreman_executing" }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("idle -> foreman_executing");
  });

  test("requires PRD before entering critic_prd_review", () => {
    const result = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "product_drafting",
        targetStage: "critic_prd_review",
        hasArtifact: () => false,
      }),
    );

    expect(getStagePrerequisitesForType("full_feature", "critic_prd_review")).toEqual(["PRD"]);
    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("missing required artifact(s): PRD");
  });

  test("requires SPEC and valid TASKS before critic_spec_review approval path", () => {
    const onlySpec = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "spec_drafting",
        targetStage: "critic_spec_review",
        hasArtifact: (kind: string) => kind === "SPEC",
      }),
    );
    expect(getStagePrerequisitesForType("full_feature", "critic_spec_review")).toEqual(["SPEC", "TASKS"]);
    expect(onlySpec.allowed).toBe(false);
    expect(onlySpec.error).toContain("TASKS");

    const approval = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "critic_spec_review",
        targetStage: "awaiting_user_approval",
        hasArtifact: (kind: string) => kind === "SPEC" || kind === "TASKS",
      }),
    );
    expect(approval).toEqual({ allowed: true });
  });

  test("requires user approval before entering foreman_executing", () => {
    const result = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "awaiting_user_approval",
        targetStage: "foreman_executing",
        hasUserApproval: false,
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("without user approval");
  });

  test("allows critic review retries below maxRetries and hard-fails at maxRetries", () => {
    const belowLimit = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "product_drafting",
        targetStage: "critic_prd_review",
        retryCount: 2,
        maxRetries: 3,
      }),
    );
    expect(belowLimit).toEqual({ allowed: true });

    const atLimit = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "product_drafting",
        targetStage: "critic_prd_review",
        retryCount: 3,
        maxRetries: 3,
      }),
    );
    expect(atLimit.allowed).toBe(false);
    expect(atLimit.errorName).toBe("WorkflowRetryLimitError");
    expect(atLimit.error).toContain("retry limit reached (3/3)");
  });

  test("denies forward transition when current stage has no completion record", () => {
    const result = canTransitionTo(
      {
        id: "wf-stage-gate",
        type: "full_feature",
        status: "active",
        stage: "product_drafting",
        retryCount: 0,
        maxRetries: 3,
      },
      "critic_prd_review",
      {
        hasArtifact: () => true,
        hasStageCompletion: () => false,
        hasUserApproval: true,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("record completion for product_drafting");
  });

  test("allows backward retry transition without current stage completion record", () => {
    const backwardTransitions: Array<[WorkflowType, WorkflowStage, WorkflowStage]> = [
      ["full_feature", "critic_prd_review", "product_drafting"],
      ["full_feature", "critic_spec_review", "spec_drafting"],
    ];

    for (const [workflowType, currentStage, targetStage] of backwardTransitions) {
      const result = canTransitionTo(
        {
          id: "wf-retry",
          type: workflowType,
          status: "active",
          stage: currentStage,
          retryCount: 0,
          maxRetries: 3,
        },
        targetStage,
        {
          hasArtifact: () => true,
          hasStageCompletion: () => false,
          hasUserApproval: true,
        },
      );

      expect(result.allowed, `${workflowType}: ${currentStage} -> ${targetStage}`).toBe(true);
    }
  });

  test("canTransitionTo allows transition when prerequisite completion record exists", () => {
    const completedStages = new Set<WorkflowStage>(["product_drafting"]);

    const result = canTransitionTo(
      {
        id: "wf-stage-gate",
        type: "full_feature",
        status: "active",
        stage: "product_drafting",
        retryCount: 0,
        maxRetries: 3,
      },
      "critic_prd_review",
      {
        hasArtifact: () => true,
        hasStageCompletion: (stage) => completedStages.has(stage),
        hasUserApproval: true,
      },
    );

    expect(result).toEqual({ allowed: true });
  });

  test("canTransitionTo denies inactive workflow transitions", () => {
    const result = canTransitionTo(
      {
        id: "wf-paused",
        type: "quick_fix",
        status: "paused",
        stage: "quick_analysis",
        retryCount: 0,
        maxRetries: 3,
      },
      "quick_patch",
      {
        hasArtifact: () => true,
        hasStageCompletion: () => true,
        hasUserApproval: true,
      },
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toContain("not active");
  });

  test("research_only cannot enter full_feature stages", () => {
    const result = validateTransition(
      input({ workflowType: "research_only", currentStage: "idle", targetStage: "product_drafting" }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("research_only");
    expect(getTransitionsForType("research_only", "idle")).toEqual(["researching"]);
  });

  test("quick_fix cannot enter full_feature stages", () => {
    const result = validateTransition(
      input({ workflowType: "quick_fix", currentStage: "idle", targetStage: "product_drafting" }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("quick_fix");
    expect(getTransitionsForType("quick_fix", "idle")).toEqual(["quick_analysis"]);
  });

  test("full_feature follows its approved graph", () => {
    const approvedPath: Array<[WorkflowStage, WorkflowStage]> = [
      ["idle", "product_drafting"],
      ["product_drafting", "critic_prd_review"],
      ["critic_prd_review", "spec_drafting"],
      ["spec_drafting", "critic_spec_review"],
      ["critic_spec_review", "awaiting_user_approval"],
      ["awaiting_user_approval", "foreman_executing"],
      ["foreman_executing", "final_review"],
    ];

    for (const [currentStage, targetStage] of approvedPath) {
      const result = validateTransition(input({ workflowType: "full_feature", currentStage, targetStage }));
      expect(result, `${currentStage} -> ${targetStage}`).toEqual({ allowed: true });
    }
  });

  test("each workflow type has the expected completion policy", () => {
    expect(getCompletionPolicyForType("research_only")).toEqual({ requiredStage: "research_consolidation" });
    expect(getCompletionPolicyForType("quick_fix")).toEqual({ requiredStage: "quick_verify" });
    expect(getCompletionPolicyForType("full_feature")).toEqual({ requiredStage: "final_review" });
  });

  test("canCompleteWorkflow denies when required stage has not been reached", () => {
    const result = canCompleteWorkflow(
      workflowState({
        type: "quick_fix",
        stage: "quick_patch",
        stageCompletions: {
          quick_patch: { stage: "quick_patch", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );

    expect(result.allowed).toBe(false);
    expect(result.error).toContain("has not reached required stage quick_verify");
  });

  test("canCompleteWorkflow denies failed workflows", () => {
    const result = canCompleteWorkflow(
      workflowState({
        type: "quick_fix",
        status: "failed",
        stage: "quick_verify",
        stageCompletions: {
          quick_verify: { stage: "quick_verify", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain('Cannot complete workflow with status "failed"');
  });

  test("canCompleteWorkflow denies paused workflows", () => {
    const result = canCompleteWorkflow(
      workflowState({
        type: "quick_fix",
        status: "paused",
        stage: "quick_verify",
        stageCompletions: {
          quick_verify: { stage: "quick_verify", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain('Cannot complete workflow with status "paused"');
  });

  test("canCompleteWorkflow denies already-completed workflows", () => {
    const result = canCompleteWorkflow(
      workflowState({
        type: "quick_fix",
        status: "completed",
        stage: "quick_verify",
        stageCompletions: {
          quick_verify: { stage: "quick_verify", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain('Cannot complete workflow with status "completed"');
  });

  test("canCompleteWorkflow allows quick_fix completion without critic report", () => {
    const result = canCompleteWorkflow(
      workflowState({
        type: "quick_fix",
        stage: "quick_verify",
        stageCompletions: {
          quick_verify: { stage: "quick_verify", completedAt: new Date().toISOString() },
        },
      }),
      () => false,
    );

    expect(result).toEqual({ allowed: true });
  });

  test("canCompleteWorkflow allows completion when policy conditions are met", () => {
    const result = canCompleteWorkflow(
      workflowState({
        type: "full_feature",
        stage: "final_review",
        stageCompletions: {
          final_review: { stage: "final_review", completedAt: new Date().toISOString(), criticPassed: false },
        },
      }),
      () => true,
    );

    expect(result).toEqual({ allowed: true });
  });

  test("cross-type transitions are denied", () => {
    const crossTypeTransitions: Array<[WorkflowType, WorkflowStage, WorkflowStage]> = [
      ["research_only", "researching", "quick_patch"],
      ["research_only", "research_consolidation", "final_review"],
      ["quick_fix", "quick_analysis", "spec_drafting"],
      ["quick_fix", "quick_verify", "research_consolidation"],
      ["full_feature", "product_drafting", "research_consolidation"],
      ["full_feature", "foreman_executing", "quick_verify"],
    ];

    for (const [workflowType, currentStage, targetStage] of crossTypeTransitions) {
      const result = validateTransition(input({ workflowType, currentStage, targetStage }));
      expect(result.allowed, `${workflowType}: ${currentStage} -> ${targetStage}`).toBe(false);
      expect(result.errorName).toBe("WorkflowTransitionError");
    }
  });

  test("does not expose complete or failed as legal business stages", () => {
    for (const definition of Object.values(WORKFLOW_TYPE_REGISTRY)) {
      expect(definition.stages).not.toContain("complete" as WorkflowStage);
      expect(definition.stages).not.toContain("failed" as WorkflowStage);
      expect(Object.values(definition.transitions).flat()).not.toContain("complete");
      expect(Object.values(definition.transitions).flat()).not.toContain("failed");
    }

    for (const targetStage of ["complete", "failed"] as const) {
      const result = validateTransition(
        input({ workflowType: "full_feature", targetStage: targetStage as WorkflowStage }),
      );
      expect(result.allowed).toBe(false);
      expect(result.errorName).toBe("WorkflowTransitionError");
    }
  });

  test("transition and retry errors expose typed fields and names", () => {
    const transitionError = new WorkflowTransitionError(
      "wf-errors",
      "idle",
      "final_review",
    );
    expect(transitionError.name).toBe("WorkflowTransitionError");
    expect(transitionError.workflowId).toBe("wf-errors");
    expect(transitionError.currentStage).toBe("idle");
    expect(transitionError.targetStage).toBe("final_review");

    const retryError = new WorkflowRetryLimitError(
      "wf-errors",
      "spec_drafting",
      "critic_spec_review",
      1,
      1,
    );
    expect(retryError.name).toBe("WorkflowRetryLimitError");
    expect(retryError.retryCount).toBe(1);
    expect(retryError.maxRetries).toBe(1);
  });
});
