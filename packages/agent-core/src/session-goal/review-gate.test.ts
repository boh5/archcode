import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildResult, SessionGoal } from "@archcode/protocol";
import { hashDelegationContract } from "../delegation/contract";
import {
  GoalReviewGate,
  RUNTIME_OBJECTIVE_CRITERION_ID,
  buildGoalReviewContract,
} from "./review-gate";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("GoalReviewGate", () => {
  test("preserves the complete objective as an immutable Runtime criterion", () => {
    const objective = "Migrate auth without any, preserve behavior, and pass every auth test.";
    const contract = buildGoalReviewContract(objective);
    expect(contract.agent_type).toBe("reviewer");
    expect(contract.objective).toContain(objective);
    expect(contract.acceptance_criteria).toEqual([expect.objectContaining({
      id: RUNTIME_OBJECTIVE_CRITERION_ID,
      condition: expect.stringContaining(objective),
    })]);
  });

  test("accepts only the current canonical receipt with criterion evidence", async () => {
    const cwd = await workspace("const answer = 42;\n");
    const gate = new GoalReviewGate();
    const objective = "Implement and verify the answer.";
    const basis = await gate.createBasis(cwd, { objective });
    const goal = goalWithReview(objective, basis);

    const decision = await gate.decide({
      cwd,
      goal,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      reviewerToolEvidence: successfulEvidence(),
      resultReceipt: {
        executionId: "reviewer-execution",
        delegationContractHash: basis.contractHash,
        submittedAt: Date.now(),
        result: completedResult(),
      },
    });

    expect(decision.verdict).toBe("accepted");
  });

  test("rejects a source mutation made after the immutable claim", async () => {
    const cwd = await workspace("before\n");
    const gate = new GoalReviewGate();
    const objective = "Keep the reviewed source stable.";
    const basis = await gate.createBasis(cwd, { objective });
    const goal = goalWithReview(objective, basis);
    await writeFile(join(cwd, "source.ts"), "after\n");

    const decision = await gate.decide({
      cwd,
      goal,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      reviewerToolEvidence: successfulEvidence(),
      resultReceipt: {
        executionId: "reviewer-execution",
        delegationContractHash: basis.contractHash,
        submittedAt: Date.now(),
        result: completedResult(),
      },
    });

    expect(decision).toMatchObject({ verdict: "rejected" });
    expect(decision.summary).toContain("changed");
  });

  test("rejects every persisted review fence when it no longer matches the claim", async () => {
    const cwd = await workspace("stable\n");
    const gate = new GoalReviewGate();
    const objective = "Preserve every review fence.";
    const basis = await gate.createBasis(cwd, { objective });
    const canonical = goalWithReview(objective, basis);
    const cases: Array<[string, (goal: SessionGoal) => void]> = [
      ["generation", (goal) => { (goal as { generation: number }).generation += 1; }],
      ["user input cursor", (goal) => { (goal as { userInputCursor: number }).userInputCursor += 1; }],
      ["source mutation epoch", (goal) => { (goal as { sourceMutationEpoch: number }).sourceMutationEpoch += 1; }],
      ["contract hash", (goal) => {
        const running = goal.review;
        if (running?.phase !== "review_running") throw new Error("Expected running review");
        (running.claim.reviewContract as { objective: string }).objective = "weakened contract";
      }],
    ];

    for (const [name, mutate] of cases) {
      const goal = structuredClone(canonical);
      mutate(goal);
      const decision = await gate.decide({
        cwd,
        goal,
        reviewerSessionId: "reviewer-session",
        reviewerExecutionId: "reviewer-execution",
        reviewerToolEvidence: successfulEvidence(),
        resultReceipt: {
          executionId: "reviewer-execution",
          delegationContractHash: basis.contractHash,
          submittedAt: Date.now(),
          result: completedResult(),
        },
      });
      expect(decision, name).toMatchObject({
        verdict: "rejected",
        summary: "The review basis was invalidated before completion",
      });
    }
  });

  test("rejects weakened or incomplete Runtime criterion evidence", async () => {
    const cwd = await workspace("stable\n");
    const gate = new GoalReviewGate();
    const objective = "Implement outcome A and constraint B.";
    const basis = await gate.createBasis(cwd, { objective });
    const result = completedResult({ criteria: [] });
    const goal = goalWithReview(objective, basis);

    const decision = await gate.decide({
      cwd,
      goal,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      reviewerToolEvidence: successfulEvidence(),
      resultReceipt: {
        executionId: "reviewer-execution",
        delegationContractHash: basis.contractHash,
        submittedAt: Date.now(),
        result,
      },
    });

    expect(decision.verdict).toBe("rejected");
    expect(decision.summary).toContain("criteria ids");
  });

  test("rejects phantom evidence refs and verification without locatable output", async () => {
    const cwd = await workspace("stable\n");
    const gate = new GoalReviewGate();
    const objective = "Implement and verify the complete result.";
    const basis = await gate.createBasis(cwd, { objective });
    const goal = goalWithReview(objective, basis);

    const phantom = await gate.decide({
      cwd,
      goal,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      reviewerToolEvidence: successfulEvidence(),
      resultReceipt: {
        executionId: "reviewer-execution",
        delegationContractHash: basis.contractHash,
        submittedAt: Date.now(),
        result: completedResult({
          evidence: [{ claim: "invented", ref: "made-up" }],
          criteria: [{ id: RUNTIME_OBJECTIVE_CRITERION_ID, status: "passed", evidenceRefs: ["made-up"] }],
          verification: [{ check: "invented", status: "passed", outputRef: "made-up" }],
        }),
      },
    });
    expect(phantom).toMatchObject({
      verdict: "rejected",
      summary: "Reviewer evidence ref is not a successful tool call from this review: made-up",
    });

    const noOutput = await gate.decide({
      cwd,
      goal,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      reviewerToolEvidence: successfulEvidence(),
      resultReceipt: {
        executionId: "reviewer-execution",
        delegationContractHash: basis.contractHash,
        submittedAt: Date.now(),
        result: completedResult({ verification: [{ check: "targeted verification", status: "passed" }] }),
      },
    });
    expect(noOutput.verdict).toBe("rejected");

    const submissionAsEvidence = await gate.decide({
      cwd,
      goal,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      reviewerToolEvidence: new Map([
        ["tool:self-submit", "submit_child_result"],
        ["tool:test", "bash"],
      ]),
      resultReceipt: {
        executionId: "reviewer-execution",
        delegationContractHash: basis.contractHash,
        submittedAt: Date.now(),
        result: completedResult({
          evidence: [{ claim: "self-referential submission", ref: "tool:self-submit" }],
          criteria: [{
            id: RUNTIME_OBJECTIVE_CRITERION_ID,
            status: "passed",
            evidenceRefs: ["tool:self-submit"],
          }],
        }),
      },
    });
    expect(submissionAsEvidence.verdict).toBe("rejected");
  });
});

async function workspace(content: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "archcode-goal-review-"));
  temporaryDirectories.push(cwd);
  await writeFile(join(cwd, "source.ts"), content);
  return cwd;
}

function completedResult(overrides: Partial<ChildResult> = {}): ChildResult {
  return {
    status: "completed",
    summary: "The complete objective is satisfied",
    deliverables: [],
    evidence: [{ claim: "source verified", ref: "tool:file-read" }],
    criteria: [{ id: RUNTIME_OBJECTIVE_CRITERION_ID, status: "passed", evidenceRefs: ["tool:file-read"] }],
    verification: [{ check: "targeted verification", status: "passed", outputRef: "tool:test" }],
    unresolved: [],
    ...overrides,
  };
}

function successfulEvidence(): ReadonlyMap<string, string> {
  return new Map([
    ["tool:file-read", "file_read"],
    ["tool:test", "bash"],
  ]);
}

function goalWithReview(
  objective: string,
  basis: Awaited<ReturnType<GoalReviewGate["createBasis"]>>,
): SessionGoal {
  const claimId = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  return {
    instanceId,
    generation: 1,
    objective,
    status: "active",
    usage: {
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 },
      executionTimeMs: 0,
      executionCount: 0,
    },
    evaluatorCount: 0,
    noProgressCount: 0,
    failureCount: 0,
    userInputCursor: 0,
    sourceMutationEpoch: 0,
    review: {
      phase: "review_running",
      claim: {
        claimId,
        instanceId,
        generation: 1,
        objective,
        requestedBy: "engineer",
        reason: "ready",
        reviewContract: basis.contract,
        reviewContractHash: hashDelegationContract(basis.contract),
        userInputCursor: 0,
        sourceMutationEpoch: 0,
        sourceFingerprint: basis.sourceFingerprint,
        createdAt: 1,
      },
      attempt: 1,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
    },
    createdAt: 1,
    activatedAt: 1,
    updatedAt: 1,
  };
}
