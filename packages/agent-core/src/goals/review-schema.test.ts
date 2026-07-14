import { describe, expect, test } from "bun:test";

import { GoalReviewReceiptSchema } from "./review-schema";

function receipt() {
  return {
    reviewGeneration: 2,
    verdict: "DONE" as const,
    summary: "All acceptance criteria passed.",
    evidenceRefs: [{ kind: "test_output" as const, ref: "test-1", summary: "Full suite passed." }],
    reviewerSessionId: crypto.randomUUID(),
    decidedAt: "2026-07-14T00:00:00.000Z",
  };
}

describe("Goal review schemas", () => {
  test("accepts one strict canonical receipt", () => {
    const valid = receipt();
    expect(GoalReviewReceiptSchema.parse(valid)).toEqual(valid);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, legacy: true }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, decidedAt: "not-a-date" }).success).toBe(false);
    expect(GoalReviewReceiptSchema.safeParse({ ...valid, evidenceRefs: [{ ...valid.evidenceRefs[0], url: "not-a-url" }] }).success).toBe(false);
  });
});
