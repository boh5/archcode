import { describe, expect, test } from "bun:test";

import {
  canCompleteWorkflow,
  canTransitionTo,
  hasUnresolvedInteractions,
  validateTransition,
  WorkflowRetryLimitError,
  WorkflowTransitionError,
  type TransitionInput,
} from "./guards";
import type { WorkflowInteraction, WorkflowStage, WorkflowState, WorkflowType } from "./state";
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
  return {
    workflowId: "550e8400-e29b-41d4-a716-446655440000",
    workflowType: "full_feature",
    currentStage: "idle",
    targetStage: "product_drafting",
    retryCount: 0,
    maxRetries: 3,
    hasArtifact: (kind: string) => artifacts.has(kind as ArtifactKind),
    hasUserApproval: true,
    ...overrides,
  };
}

function workflowState(overrides: Partial<WorkflowState>): WorkflowState {
  const now = new Date().toISOString();
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    title: "test",
    type: "full_feature",
    stage: "idle",
    status: "active",
    artifacts: {},
    stageCompletions: {},
    requiredInteractions: [],
    resolvedInteractions: [],
    derivedWorkflows: [],
    sessionIds: {},
    createdAt: now,
    updatedAt: now,
    retryCount: 0,
    maxRetries: 3,
    ...overrides,
  };
}

function workflowInteraction(overrides: Partial<WorkflowInteraction>): WorkflowInteraction {
  return {
    id: "decision-1",
    decisionKey: "product.scope",
    stage: "product_drafting",
    sourceAgent: "product",
    kind: "decision",
    question: "Which scope should we pursue?",
    options: ["minimal", "complete"],
    recommendedOption: "minimal",
    rationale: "Scope needs a user decision before the workflow can advance.",
    status: "proposed",
    revision: 1,
    ...overrides,
  };
}

function transitionWithInteractions(workflow: WorkflowState, targetStage: WorkflowStage) {
  return validateTransition(
    input({
      workflowType: workflow.type,
      currentStage: workflow.stage,
      targetStage,
      hasStageCompletion: (stage) => Boolean(workflow.stageCompletions[stage]),
      hasUnresolvedInteractions: (stage) => hasUnresolvedInteractions(workflow, stage),
      hasUserApproval: true,
    }),
  );
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
        id: "550e8400-e29b-41d4-a716-446655440001",
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
          id: "550e8400-e29b-41d4-a716-446655440002",
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
        id: "550e8400-e29b-41d4-a716-446655440005",
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
        id: "550e8400-e29b-41d4-a716-446655440003",
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

  test("proposed interaction in product_drafting denies transition to critic_prd_review", () => {
    const workflow = workflowState({
      stage: "product_drafting",
      stageCompletions: {
        product_drafting: { stage: "product_drafting", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [workflowInteraction({ status: "proposed" })],
    });

    const result = transitionWithInteractions(workflow, "critic_prd_review");

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowUnresolvedInteractionsError");
    expect(result.error).toContain("unresolved interaction");
    expect(result.error).toContain("product_drafting");
  });

  test("requested interaction denies progression out of its stage", () => {
    const workflow = workflowState({
      stage: "product_drafting",
      stageCompletions: {
        product_drafting: { stage: "product_drafting", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [
        workflowInteraction({ id: "decision-2", stage: "product_drafting", status: "requested" }),
      ],
    });

    const result = transitionWithInteractions(workflow, "critic_prd_review");

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowUnresolvedInteractionsError");
  });

  test("resolved interaction with an answer allows progression", () => {
    const workflow = workflowState({
      stage: "product_drafting",
      stageCompletions: {
        product_drafting: { stage: "product_drafting", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [
        workflowInteraction({
          id: "decision-3",
          stage: "product_drafting",
          status: "resolved",
          answer: "minimal",
          resolvedAt: new Date().toISOString(),
        }),
      ],
    });

    expect(transitionWithInteractions(workflow, "critic_prd_review")).toEqual({ allowed: true });
  });

  test("cancelled interaction remains unresolved and blocks", () => {
    const workflow = workflowState({
      stage: "spec_drafting",
      stageCompletions: {
        spec_drafting: { stage: "spec_drafting", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [
        workflowInteraction({
          id: "decision-4",
          stage: "spec_drafting",
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        }),
      ],
    });

    const result = transitionWithInteractions(workflow, "critic_spec_review");

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowUnresolvedInteractionsError");
  });

  test("superseded interaction does not block when superseding decision is resolved", () => {
    const workflow = workflowState({
      stage: "critic_prd_review",
      stageCompletions: {
        critic_prd_review: { stage: "critic_prd_review", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [
        workflowInteraction({
          id: "decision-5",
          stage: "critic_prd_review",
          status: "superseded",
          supersededBy: "decision-6",
        }),
        workflowInteraction({
          id: "decision-6",
          stage: "critic_prd_review",
          status: "resolved",
          answer: "minimal",
          resolvedAt: new Date().toISOString(),
        }),
      ],
    });

    expect(transitionWithInteractions(workflow, "spec_drafting")).toEqual({ allowed: true });
  });

  test("superseded interaction blocks when the superseding decision is unresolved", () => {
    const workflow = workflowState({
      stage: "critic_spec_review",
      stageCompletions: {
        critic_spec_review: { stage: "critic_spec_review", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [
        workflowInteraction({
          id: "decision-7",
          stage: "critic_spec_review",
          status: "superseded",
          supersededBy: "decision-8",
        }),
        workflowInteraction({ id: "decision-8", stage: "critic_spec_review", status: "requested" }),
      ],
    });

    const result = transitionWithInteractions(workflow, "awaiting_user_approval");

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowUnresolvedInteractionsError");
  });

  test("unresolved preference interactions block progression", () => {
    const workflow = workflowState({
      stage: "product_drafting",
      stageCompletions: {
        product_drafting: { stage: "product_drafting", completedAt: new Date().toISOString() },
      },
      requiredInteractions: [workflowInteraction({ id: "decision-9", kind: "preference", status: "requested" })],
    });

    const result = transitionWithInteractions(workflow, "critic_prd_review");

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowUnresolvedInteractionsError");
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
      "550e8400-e29b-41d4-a716-446655440004",
      "idle",
      "final_review",
    );
    expect(transitionError.name).toBe("WorkflowTransitionError");
    expect(transitionError.workflowId).toBe("550e8400-e29b-41d4-a716-446655440004");
    expect(transitionError.currentStage).toBe("idle");
    expect(transitionError.targetStage).toBe("final_review");

    const retryError = new WorkflowRetryLimitError(
      "550e8400-e29b-41d4-a716-446655440004",
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

describe("workflow type matrix preservation", () => {
  test("WORKFLOW_TYPE_REGISTRY contains exactly three types", () => {
    const types = Object.keys(WORKFLOW_TYPE_REGISTRY);
    expect(types).toEqual(["research_only", "quick_fix", "full_feature"]);
    expect(types).toHaveLength(3);
  });

  test("each type has unique stage lists", () => {
    const stagesByType = {
      research_only: ["idle", "researching", "research_consolidation"],
      quick_fix: ["idle", "quick_analysis", "quick_patch", "quick_verify"],
      full_feature: [
        "idle",
        "product_drafting",
        "critic_prd_review",
        "spec_drafting",
        "critic_spec_review",
        "awaiting_user_approval",
        "foreman_executing",
        "final_review",
      ],
    } as const;

    for (const [type, expectedStages] of Object.entries(stagesByType)) {
      const definition = WORKFLOW_TYPE_REGISTRY[type as WorkflowType];
      expect(definition.stages, `${type} stages mismatch`).toEqual(expectedStages);
    }
  });

  test("each type has distinct transition graphs", () => {
    // research_only: idle -> researching -> research_consolidation
    const researchTransitions = WORKFLOW_TYPE_REGISTRY.research_only.transitions;
    expect(researchTransitions.idle).toEqual(["researching"]);
    expect(researchTransitions.researching).toEqual(["research_consolidation"]);
    expect(researchTransitions.research_consolidation).toEqual([]);
    // research_only should have no quick_fix or full_feature transitions
    expect(researchTransitions.quick_analysis).toEqual([]);
    expect(researchTransitions.product_drafting).toEqual([]);

    // quick_fix: idle -> quick_analysis -> quick_patch -> quick_verify
    const quickFixTransitions = WORKFLOW_TYPE_REGISTRY.quick_fix.transitions;
    expect(quickFixTransitions.idle).toEqual(["quick_analysis"]);
    expect(quickFixTransitions.quick_analysis).toEqual(["quick_patch"]);
    expect(quickFixTransitions.quick_patch).toEqual(["quick_verify"]);
    expect(quickFixTransitions.quick_verify).toEqual([]);
    // quick_fix should have no research_only or full_feature transitions
    expect(quickFixTransitions.researching).toEqual([]);
    expect(quickFixTransitions.product_drafting).toEqual([]);

    // full_feature: 8-stage pipeline with critic retry loops
    const fullFeatureTransitions = WORKFLOW_TYPE_REGISTRY.full_feature.transitions;
    expect(fullFeatureTransitions.idle).toEqual(["product_drafting"]);
    expect(fullFeatureTransitions.product_drafting).toEqual(["critic_prd_review"]);
    expect(fullFeatureTransitions.critic_prd_review).toEqual(["product_drafting", "spec_drafting"]);
    expect(fullFeatureTransitions.spec_drafting).toEqual(["critic_spec_review"]);
    expect(fullFeatureTransitions.critic_spec_review).toEqual(["spec_drafting", "awaiting_user_approval"]);
    expect(fullFeatureTransitions.awaiting_user_approval).toEqual(["foreman_executing"]);
    expect(fullFeatureTransitions.foreman_executing).toEqual(["final_review"]);
    expect(fullFeatureTransitions.final_review).toEqual([]);
    // full_feature should have no research_only or quick_fix transitions
    expect(fullFeatureTransitions.researching).toEqual([]);
    expect(fullFeatureTransitions.quick_analysis).toEqual([]);
  });

  test("type-specific prerequisites are enforced", () => {
    // research_only requires RESEARCH before research_consolidation
    expect(getStagePrerequisitesForType("research_only", "researching")).toEqual([]);
    expect(getStagePrerequisitesForType("research_only", "research_consolidation")).toEqual(["RESEARCH"]);

    // quick_fix has no stage prerequisites
    expect(getStagePrerequisitesForType("quick_fix", "quick_analysis")).toEqual([]);
    expect(getStagePrerequisitesForType("quick_fix", "quick_patch")).toEqual([]);
    expect(getStagePrerequisitesForType("quick_fix", "quick_verify")).toEqual([]);

    // full_feature has escalating prerequisites
    expect(getStagePrerequisitesForType("full_feature", "product_drafting")).toEqual([]);
    expect(getStagePrerequisitesForType("full_feature", "critic_prd_review")).toEqual(["PRD"]);
    expect(getStagePrerequisitesForType("full_feature", "critic_spec_review")).toEqual(["SPEC", "TASKS"]);
    expect(getStagePrerequisitesForType("full_feature", "awaiting_user_approval")).toEqual(["SPEC", "TASKS"]);
    expect(getStagePrerequisitesForType("full_feature", "foreman_executing")).toEqual(["SPEC", "TASKS"]);
  });

  test("user approval gate before foreman_executing is enforced for full_feature", () => {
    // full_feature requires user approval
    const withoutApproval = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "awaiting_user_approval",
        targetStage: "foreman_executing",
        hasUserApproval: false,
      }),
    );
    expect(withoutApproval.allowed).toBe(false);
    expect(withoutApproval.error).toContain("without user approval");

    const withApproval = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "awaiting_user_approval",
        targetStage: "foreman_executing",
        hasUserApproval: true,
      }),
    );
    expect(withApproval).toEqual({ allowed: true });

    // research_only and quick_fix have no path to foreman_executing at all
    expect(getTransitionsForType("research_only", "research_consolidation")).not.toContain("foreman_executing");
    expect(getTransitionsForType("quick_fix", "quick_verify")).not.toContain("foreman_executing");

    // Attempting to reach foreman_executing from research_only or quick_fix is denied by transition graph
    const researchToExec = validateTransition(
      input({ workflowType: "research_only", currentStage: "research_consolidation", targetStage: "foreman_executing" }),
    );
    expect(researchToExec.allowed).toBe(false);
    expect(researchToExec.errorName).toBe("WorkflowTransitionError");

    const quickFixToExec = validateTransition(
      input({ workflowType: "quick_fix", currentStage: "quick_verify", targetStage: "foreman_executing" }),
    );
    expect(quickFixToExec.allowed).toBe(false);
    expect(quickFixToExec.errorName).toBe("WorkflowTransitionError");
  });

  test("unresolved interactions block stage transitions for all types", () => {
    // research_only
    const researchOnlyResult = validateTransition(
      input({
        workflowType: "research_only",
        currentStage: "researching",
        targetStage: "research_consolidation",
        hasUnresolvedInteractions: () => true,
      }),
    );
    expect(researchOnlyResult.allowed).toBe(false);
    expect(researchOnlyResult.errorName).toBe("WorkflowUnresolvedInteractionsError");

    // quick_fix
    const quickFixResult = validateTransition(
      input({
        workflowType: "quick_fix",
        currentStage: "quick_analysis",
        targetStage: "quick_patch",
        hasUnresolvedInteractions: () => true,
      }),
    );
    expect(quickFixResult.allowed).toBe(false);
    expect(quickFixResult.errorName).toBe("WorkflowUnresolvedInteractionsError");

    // full_feature
    const fullFeatureResult = validateTransition(
      input({
        workflowType: "full_feature",
        currentStage: "product_drafting",
        targetStage: "critic_prd_review",
        hasUnresolvedInteractions: () => true,
      }),
    );
    expect(fullFeatureResult.allowed).toBe(false);
    expect(fullFeatureResult.errorName).toBe("WorkflowUnresolvedInteractionsError");
  });

  test("completion policies are type-specific", () => {
    expect(getCompletionPolicyForType("research_only")).toEqual({ requiredStage: "research_consolidation" });
    expect(getCompletionPolicyForType("quick_fix")).toEqual({ requiredStage: "quick_verify" });
    expect(getCompletionPolicyForType("full_feature")).toEqual({ requiredStage: "final_review" });

    // verify each type must reach its required stage before completion
    // research_only can't complete before research_consolidation
    const researchEarly = canCompleteWorkflow(
      workflowState({ type: "research_only", stage: "researching" }),
      () => false,
    );
    expect(researchEarly.allowed).toBe(false);
    expect(researchEarly.error).toContain("research_consolidation");

    // quick_fix can't complete before quick_verify
    const quickFixEarly = canCompleteWorkflow(
      workflowState({ type: "quick_fix", stage: "quick_patch" }),
      () => false,
    );
    expect(quickFixEarly.allowed).toBe(false);
    expect(quickFixEarly.error).toContain("quick_verify");

    // full_feature can't complete before final_review
    const fullFeatureEarly = canCompleteWorkflow(
      workflowState({ type: "full_feature", stage: "foreman_executing" }),
      () => false,
    );
    expect(fullFeatureEarly.allowed).toBe(false);
    expect(fullFeatureEarly.error).toContain("final_review");
  });

  test("each type completes successfully at its required stage", () => {
    // research_only completes at research_consolidation
    const researchComplete = canCompleteWorkflow(
      workflowState({
        type: "research_only",
        stage: "research_consolidation",
        stageCompletions: {
          research_consolidation: { stage: "research_consolidation", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );
    expect(researchComplete).toEqual({ allowed: true });

    // quick_fix completes at quick_verify
    const quickFixComplete = canCompleteWorkflow(
      workflowState({
        type: "quick_fix",
        stage: "quick_verify",
        stageCompletions: {
          quick_verify: { stage: "quick_verify", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );
    expect(quickFixComplete).toEqual({ allowed: true });

    // full_feature completes at final_review
    const fullFeatureComplete = canCompleteWorkflow(
      workflowState({
        type: "full_feature",
        stage: "final_review",
        stageCompletions: {
          final_review: { stage: "final_review", completedAt: new Date().toISOString() },
        },
      }),
      () => true,
    );
    expect(fullFeatureComplete).toEqual({ allowed: true });

    // Each type fails completion at its required stage without the completion record
    for (const [type, stage] of [
      ["research_only", "research_consolidation"],
      ["quick_fix", "quick_verify"],
      ["full_feature", "final_review"],
    ] as Array<[WorkflowType, WorkflowStage]>) {
      const result = canCompleteWorkflow(
        workflowState({ type, stage, stageCompletions: {} }),
        () => true,
      );
      expect(result.allowed, `${type}: missing completion record`).toBe(false);
      expect(result.error, `${type}: should mention missing record`).toContain("no completion record");
    }
  });
});
