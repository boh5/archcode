import { describe, expect, test } from "bun:test";

import { GoalReviewReceiptSchema, projectGoalReviewReceipt } from "./review-schema";

function receipt() {
  return {
    executionId: "execution-review-2",
    delegationContractHash: "a".repeat(64),
    reviewGeneration: 2,
    verdict: "DONE" as const,
    summary: "All acceptance criteria passed.",
    evidenceRefs: [{ kind: "test_output" as const, ref: "test-1", summary: "Full suite passed." }],
    reviewerSessionId: crypto.randomUUID(),
    decidedAt: "2026-07-14T00:00:00.000Z",
    result: {
      status: "completed" as const,
      summary: "All acceptance criteria passed.",
      criteria: [{ id: "ac-1", status: "passed" as const, evidenceRefs: ["test-1"] }],
      deliverables: [],
      evidence: [{ claim: "Full suite passed.", ref: "test-1" }],
      verification: [{ check: "bun test", status: "passed" as const, outputRef: "test-1" }],
      unresolved: [],
    },
  };
}

describe("Goal review schemas", () => {
  test("accepts one strict canonical receipt", () => {
    const valid = receipt();
    expect(GoalReviewReceiptSchema.parse(valid)).toEqual(valid);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, legacy: true }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, executionId: undefined }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, delegationContractHash: undefined }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, result: undefined }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, decidedAt: "not-a-date" }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, evidenceRefs: [{ ...valid.evidenceRefs[0], url: "not-a-url" }] }).success).toBe(false);
  });

  test("rebuilds the non-authoritative Session result projection", () => {
    const valid = receipt();
    expect(projectGoalReviewReceipt(valid)).toEqual({
      executionId: valid.executionId,
      delegationContractHash: valid.delegationContractHash,
      submittedAt: Date.parse(valid.decidedAt),
      result: valid.result,
    });
  });
});
