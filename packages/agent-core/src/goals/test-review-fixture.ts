import type { ChildResult } from "@archcode/protocol";

export function testReviewExecutionFields(
  verdict: "DONE" | "NOT_DONE",
  summary = verdict === "DONE" ? "All criteria verified." : "More work remains.",
): {
  readonly executionId: string;
  readonly delegationContractHash: string;
  readonly result: ChildResult;
} {
  const completed = verdict === "DONE";
  return {
    executionId: "review-execution-" + verdict.toLowerCase(),
    delegationContractHash: completed ? "a".repeat(64) : "b".repeat(64),
    result: {
      status: completed ? "completed" : "failed",
      summary,
      criteria: [{
        id: "acceptance",
        status: completed ? "passed" : "failed",
        evidenceRefs: completed ? ["test-evidence"] : [],
      }],
      deliverables: [],
      evidence: completed ? [{ claim: "Acceptance criteria verified", ref: "test-evidence" }] : [],
      verification: [],
      unresolved: completed ? [] : [{
        issue: summary,
        blocking: true,
        nextOwner: "parent",
      }],
    },
  };
}
