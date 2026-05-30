import { describe, expect, test } from "bun:test";

import type { WorkflowStage } from "./state";
import {
  ARTIFACT_PREREQUISITES,
  LEGAL_STAGE_TRANSITIONS,
  validateTransition,
  WorkflowRetryLimitError,
  WorkflowTransitionError,
  type ArtifactKind,
  type TransitionInput,
} from "./guards";

const ALL_STAGES = Object.keys(LEGAL_STAGE_TRANSITIONS) as WorkflowStage[];

function input(overrides: Partial<TransitionInput>): TransitionInput {
  const artifacts = new Set<ArtifactKind>(["PRD", "SPEC", "TASKS"]);
  return { workflowId: "wf-guards",
  currentStage: "idle",
  targetStage: "product_drafting",
  retryCount: 0,
  maxRetries: 3,
  hasArtifact: (kind: string) => artifacts.has(kind as ArtifactKind),
  hasUserApproval: true, ...overrides,  };
}

describe("workflow transition guards", () => {
  test("allows every legal transition from the transition table", () => {
    for (const currentStage of ALL_STAGES) {
      for (const targetStage of LEGAL_STAGE_TRANSITIONS[currentStage]) {
        const result = validateTransition(input({ currentStage, targetStage }));
        expect(result, `${currentStage} -> ${targetStage}`).toEqual({ allowed: true });
      }
    }
  });

  test("rejects transitions not present in the transition table", () => {
    const result = validateTransition(
      input({ currentStage: "idle", targetStage: "foreman_executing" }),
    );

    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("idle -> foreman_executing");
  });

  test("requires PRD before entering critic_prd_review", () => {
    const result = validateTransition(
      input({
        currentStage: "product_drafting",
        targetStage: "critic_prd_review",
        hasArtifact: () => false,
      }),
    );

    expect(ARTIFACT_PREREQUISITES.critic_prd_review).toEqual(["PRD"]);
    expect(result.allowed).toBe(false);
    expect(result.errorName).toBe("WorkflowTransitionError");
    expect(result.error).toContain("missing required artifact(s): PRD");
  });

  test("requires SPEC and valid TASKS before critic_spec_review approval path", () => {
    const onlySpec = validateTransition(
      input({
        currentStage: "spec_drafting",
        targetStage: "critic_spec_review",
        hasArtifact: (kind: string) => kind === "SPEC",
      }),
    );
    expect(ARTIFACT_PREREQUISITES.critic_spec_review).toEqual(["SPEC", "TASKS"]);
    expect(onlySpec.allowed).toBe(false);
    expect(onlySpec.error).toContain("TASKS");

    const approval = validateTransition(
      input({
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
        currentStage: "product_drafting",
        targetStage: "critic_prd_review",
        retryCount: 2,
        maxRetries: 3,
      }),
    );
    expect(belowLimit).toEqual({ allowed: true });

    const atLimit = validateTransition(
      input({
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

  test("allows any stage to transition to failed", () => {
    for (const currentStage of ALL_STAGES) {
      const result = validateTransition(
        input({
          currentStage,
          targetStage: "failed",
          retryCount: 99,
          maxRetries: 0,
          hasArtifact: () => false,
          hasUserApproval: false,
        }),
      );
      expect(result, `${currentStage} -> failed`).toEqual({ allowed: true });
    }
  });

  test("transition and retry errors expose typed fields and names", () => {
    const transitionError = new WorkflowTransitionError(
      "wf-errors",
      "idle",
      "complete",
    );
    expect(transitionError.name).toBe("WorkflowTransitionError");
    expect(transitionError.workflowId).toBe("wf-errors");
    expect(transitionError.currentStage).toBe("idle");
    expect(transitionError.targetStage).toBe("complete");

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
