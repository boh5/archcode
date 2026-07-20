import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type ChildResult, type DelegationContract, type SessionGoalReviewReceipt } from "@archcode/protocol";
import { hashDelegationContract } from "../delegation/contract";
import { silentLogger } from "../logger";
import { SessionFileSchema } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { SessionGoalService, SessionGoalServiceError } from "./service";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
const manager = new SessionStoreManager({ logger: silentLogger });
const service = new SessionGoalService(manager);
const user = { kind: "user_control" } as const;
const agent = { kind: "agent" } as const;
const runtime = { kind: "runtime" } as const;

afterEach(async () => {
  manager.clearAll();
  await rm(TMP_DIR, { recursive: true, force: true });
});

async function rootSession(): Promise<string> {
  await mkdir(TMP_DIR, { recursive: true });
  const sessionId = crypto.randomUUID();
  await manager.createSessionFile(TMP_DIR, { agentName: "engineer" }, sessionId);
  return sessionId;
}

function reviewContract(objective: string): DelegationContract {
  return {
    agent_type: "reviewer",
    title: "Verify Session Goal",
    objective,
    owned_scope: [],
    non_goals: [],
    acceptance_criteria: [{
      id: "runtime-objective",
      condition: objective,
      requiredEvidence: "Direct evidence for every clause",
    }],
    evidence: [],
    verification: [],
    depends_on: [],
    skills: [],
    background: false,
  };
}

function acceptedResult(): ChildResult {
  return {
    status: "completed",
    summary: "All clauses verified",
    deliverables: [],
    evidence: [{ claim: "Objective satisfied", ref: "file:result" }],
    criteria: [{ id: "runtime-objective", status: "passed", evidenceRefs: ["file:result"] }],
    verification: [{ check: "targeted tests", status: "passed", outputRef: "test:1" }],
    unresolved: [],
  };
}

function rejectedResult(): ChildResult {
  return {
    status: "failed",
    summary: "Objective is not yet satisfied",
    deliverables: [],
    evidence: [],
    criteria: [{ id: "runtime-objective", status: "failed", evidenceRefs: [] }],
    verification: [{ check: "independent review", status: "failed" }],
    unresolved: [{ issue: "Remediation remains", blocking: true, nextOwner: "parent" }],
  };
}

describe("SessionGoalService", () => {
  test("creates and edits the single strict root Session Goal", async () => {
    const sessionId = await rootSession();
    const created = await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "  Finish the migration and make all targeted tests pass.  ",
      tokenBudget: 10_000,
    });

    expect(created.objective).toBe("Finish the migration and make all targeted tests pass.");
    expect(created.generation).toBe(1);
    const afterCreate = await manager.getSessionFile(TMP_DIR, sessionId);
    expect(afterCreate.goal).toEqual(created);
    expect(afterCreate.events?.at(-1)?.payload).toMatchObject({
      type: "session.goal_changed", action: "created", goal: created,
    });

    const edited = await service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: 1,
      objective: "Finish the migration, preserve behavior, and pass all targeted tests.",
    });
    expect(edited.generation).toBe(2);
    await expect(service.edit({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      expectedGeneration: 1,
      objective: "Stale edit",
    })).rejects.toMatchObject({ code: "GENERATION_CONFLICT" });

    await service.clear({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    const afterClear = await manager.getSessionFile(TMP_DIR, sessionId);
    expect(afterClear.goal).toBeUndefined();
    expect(afterClear.events?.at(-1)?.payload).toMatchObject({
      type: "session.goal_changed", action: "cleared", goal: null,
    });

    const raw = JSON.parse(await Bun.file(join(TMP_DIR, ".archcode", "sessions", sessionId, "session.json")).text());
    expect(SessionFileSchema.safeParse({ ...raw, goalId: crypto.randomUUID() }).success).toBe(false);
    expect(SessionFileSchema.safeParse({ ...raw, sessionRole: "main" }).success).toBe(false);
  });

  test("rejects non-user creation and non-root Engineer ownership", async () => {
    const sessionId = await rootSession();
    await expect(service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      objective: "Finish the migration.",
    })).rejects.toBeInstanceOf(SessionGoalServiceError);

    const planId = crypto.randomUUID();
    await manager.createSessionFile(TMP_DIR, { agentName: "plan" }, planId);
    await expect(service.create({
      workspaceRoot: TMP_DIR,
      sessionId: planId,
      authority: user,
      objective: "Finish the migration.",
    })).rejects.toMatchObject({ code: "NOT_ROOT_ENGINEER" });
  });

  test("counts blocked evidence once per distinct consecutive Execution", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });

    const first = await service.recordBlockedTurn({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Missing credential", executionId: "execution-1" });
    const duplicate = await service.recordBlockedTurn({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Missing credential", executionId: "execution-1" });
    const second = await service.recordBlockedTurn({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Missing credential", executionId: "execution-2" });
    const third = await service.recordBlockedTurn({ workspaceRoot: TMP_DIR, sessionId, authority: agent, reason: "Missing credential", executionId: "execution-3" });

    expect(first.blockerCandidate?.consecutiveTurns).toBe(1);
    expect(duplicate.blockerCandidate?.consecutiveTurns).toBe(1);
    expect(second.status).toBe("active");
    expect(third.status).toBe("blocked");
    expect(third.blockedReason).toBe("Missing credential");
  });

  test("uses bounded retry state and blocks after three failed model Executions", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens: 0, cachedInputTokens: 0 };

    const first = await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage, executionTimeMs: 10, outcome: "failed" });
    const second = await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage, executionTimeMs: 10, outcome: "timed_out" });
    const third = await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage, executionTimeMs: 10, outcome: "max_steps" });

    expect(first).toMatchObject({ status: "active", failureCount: 1 });
    expect(first.nextRetryAt).toBeGreaterThan(first.updatedAt);
    expect(second).toMatchObject({ status: "active", failureCount: 2 });
    expect(third).toMatchObject({ status: "blocked", failureCount: 3, blockedReason: "Execution failed repeatedly" });
    expect(third.nextRetryAt).toBeUndefined();
  });

  test("resume starts fresh consecutive failure and no-progress windows", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, reasoningTokens: 0, cachedInputTokens: 0 };

    await service.recordEvaluatorDecision({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      decision: "continue",
      reason: "No measurable progress",
      madeProgress: false,
    });
    await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage, executionTimeMs: 1, outcome: "failed" });
    await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage, executionTimeMs: 1, outcome: "failed" });
    await service.recordUsage({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, usage, executionTimeMs: 1, outcome: "failed" });

    const resumed = await service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(resumed).toMatchObject({
      status: "active",
      failureCount: 0,
      noProgressCount: 0,
    });
    expect(resumed.nextRetryAt).toBeUndefined();
    expect(resumed.blockerCandidate).toBeUndefined();

    const nextFailure = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage,
      executionTimeMs: 1,
      outcome: "failed",
    });
    expect(nextFailure).toMatchObject({ status: "active", failureCount: 1 });
  });

  test("aggregates family, evaluator, and Reviewer usage before enforcing the token budget", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Ship the verified result.",
      tokenBudget: 7,
    });
    const usage = (totalTokens: number) => ({
      inputTokens: totalTokens,
      outputTokens: 0,
      totalTokens,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    });

    const child = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: usage(2),
      executionTimeMs: 10,
      outcome: "completed",
    });
    const evaluator = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: usage(3),
      executionTimeMs: 20,
    });
    const reviewer = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: usage(2),
      executionTimeMs: 30,
      outcome: "completed",
    });

    expect(child).toMatchObject({ status: "active", usage: { tokens: { totalTokens: 2 }, executionCount: 1 } });
    expect(evaluator).toMatchObject({ status: "active", usage: { tokens: { totalTokens: 5 }, executionCount: 2 } });
    expect(reviewer).toMatchObject({
      status: "budget_limited",
      usage: { tokens: { totalTokens: 7 }, executionTimeMs: 60, executionCount: 3 },
    });
  });

  test("applies a lowered budget immediately and resumes only after it is raised or removed", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Finish within the selected budget." });
    await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10, reasoningTokens: 0, cachedInputTokens: 0 },
      executionTimeMs: 1,
    });

    const lowered = await service.setTokenBudget({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      tokenBudget: 10,
    });
    expect(lowered).toMatchObject({ status: "budget_limited", tokenBudget: 10 });

    const raised = await service.setTokenBudget({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      tokenBudget: 11,
    });
    expect(raised).toMatchObject({ status: "active", tokenBudget: 11 });

    await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 10 });
    const removed = await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(removed.status).toBe("active");
    expect(removed.tokenBudget).toBeUndefined();
  });

  test("a Stop racing after budget settlement preserves budget visibility and later pause intent", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Finish within the selected budget." });
    await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10, reasoningTokens: 0, cachedInputTokens: 0 },
      executionTimeMs: 1,
    });
    await service.setTokenBudget({ workspaceRoot: TMP_DIR, sessionId, authority: user, tokenBudget: 10 });

    const limited = await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(limited.status).toBe("budget_limited");
    expect(limited.pausedAt).toBeNumber();

    const raised = await service.setTokenBudget({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      tokenBudget: 11,
    });
    expect(raised).toMatchObject({ status: "paused", pausedAt: limited.pausedAt });
  });

  test("settled usage gives an exhausted budget priority over Stop while preserving the pause intent", async () => {
    const sessionId = await rootSession();
    await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Finish within the selected budget.",
      tokenBudget: 10,
    });

    const paused = await service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    const limited = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage: { inputTokens: 6, outputTokens: 4, totalTokens: 10, reasoningTokens: 0, cachedInputTokens: 0 },
      executionTimeMs: 1,
      outcome: "interrupted",
    });

    expect(limited).toMatchObject({ status: "budget_limited", pausedAt: paused.pausedAt });
    await expect(service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user }))
      .rejects.toThrow("Increase the token budget before resuming");

    const raised = await service.setTokenBudget({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      tokenBudget: 11,
    });
    expect(raised).toMatchObject({ status: "paused", pausedAt: paused.pausedAt });

    const resumed = await service.resume({ workspaceRoot: TMP_DIR, sessionId, authority: user });
    expect(resumed.status).toBe("active");
    expect(resumed.pausedAt).toBeUndefined();
  });

  test("counts consecutive no-progress decisions despite changing reason wording", async () => {
    const sessionId = await rootSession();
    await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Finish without idle looping." });

    const reasons = ["tests still fail", "remaining test failures", "the test suite is not green yet"];
    for (const [index, reason] of reasons.entries()) {
      const goal = await service.recordEvaluatorDecision({
        workspaceRoot: TMP_DIR,
        sessionId,
        authority: runtime,
        decision: "continue",
        madeProgress: false,
        reason,
      });
      expect(goal.noProgressCount).toBe(index + 1);
    }

    const reset = await service.recordEvaluatorDecision({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      decision: "continue",
      madeProgress: true,
      reason: "a failing test was fixed",
    });
    expect(reset.noProgressCount).toBe(0);
  });

  test("only an accepted current Reviewer receipt completes the Goal", async () => {
    const sessionId = await rootSession();
    const created = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });
    const contract = reviewContract(created.objective);
    const requested = await service.requestReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      requestedBy: "engineer",
      reason: "Implementation and tests are ready",
      reviewContract: contract,
      reviewContractHash: hashDelegationContract(contract),
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: "a".repeat(64),
    });
    const claimId = requested.review!.claim.claimId;
    const running = await service.markReviewRunning({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
    });
    const receipt: SessionGoalReviewReceipt = {
      claimId,
      attempt: running.review!.attempt,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
      verdict: "accepted",
      summary: "Independent review passed",
      result: acceptedResult(),
      decidedAt: Date.now(),
    };
    const completed = await service.completeReview({ workspaceRoot: TMP_DIR, sessionId, authority: runtime, claimId, receipt });

    expect(completed.status).toBe("complete");
    expect(completed.lastReviewReceipt).toEqual(receipt);
    await service.advanceUserInputCursor({ workspaceRoot: TMP_DIR, sessionId, authority: runtime });
    await service.recordSourceMutation({ workspaceRoot: TMP_DIR, sessionId, authority: runtime });
    expect(await service.get({ workspaceRoot: TMP_DIR, sessionId })).toEqual(completed);
    await expect(service.pause({ workspaceRoot: TMP_DIR, sessionId, authority: user }))
      .rejects.toMatchObject({ code: "GOAL_TERMINAL" });
    const replacement = await service.create({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: user,
      objective: "Ship the next independently verified result.",
    });
    expect(replacement).toMatchObject({ generation: 1, status: "active" });
    expect(replacement.instanceId).not.toBe(completed.instanceId);
  });

  test("atomically rebinds remediation HITL and preserves one bounded failure count per attempt", async () => {
    const sessionId = await rootSession();
    const created = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });
    const contract = reviewContract(created.objective);
    const requested = await service.requestReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      requestedBy: "engineer",
      reason: "ready",
      reviewContract: contract,
      reviewContractHash: hashDelegationContract(contract),
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: "a".repeat(64),
    });
    const claimId = requested.review!.claim.claimId;
    const running = await service.markReviewRunning({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      reviewerSessionId: "reviewer-session",
      reviewerExecutionId: "reviewer-execution",
    });
    await service.rejectReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      receipt: {
        claimId,
        attempt: running.review!.attempt,
        reviewerSessionId: "reviewer-session",
        reviewerExecutionId: "reviewer-execution",
        verdict: "rejected",
        summary: "Remediate the failed criterion",
        result: rejectedResult(),
        decidedAt: Date.now(),
      },
    });
    await service.markRemediationRunning({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      executionId: "remediation-1",
    });

    const rebound = await service.continueRemediationExecution({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      previousExecutionId: "remediation-1",
      executionId: "remediation-2",
    });
    expect(rebound.review).toMatchObject({ phase: "remediation_running", remediationExecutionId: "remediation-2" });
    await expect(service.continueRemediationExecution({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      previousExecutionId: "remediation-1",
      executionId: "forked-remediation",
    })).rejects.toMatchObject({ code: "REVIEW_BASIS_MISMATCH" });

    const usage = createEmptySessionStats().usage;
    const failedUsage = await service.recordUsage({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      usage,
      executionTimeMs: 1,
      outcome: "failed",
    });
    const retry = await service.requestRemediationRetry({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      executionId: "remediation-2",
      reason: "Remediation Execution ended as failed",
    });
    expect(retry).toMatchObject({
      status: "active",
      failureCount: 1,
      nextRetryAt: failedUsage.nextRetryAt,
      review: { phase: "remediation_required" },
    });
  });

  test("invalidates review state and advances distinct user-input and source-mutation fences", async () => {
    const sessionId = await rootSession();
    const created = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });
    const contract = reviewContract(created.objective);
    await service.requestReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      requestedBy: "engineer",
      reason: "ready",
      reviewContract: contract,
      reviewContractHash: hashDelegationContract(contract),
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: "a".repeat(64),
    });

    const afterUserInput = await service.advanceUserInputCursor({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
    });
    expect(afterUserInput).toMatchObject({ userInputCursor: 1, sourceMutationEpoch: 0 });
    expect(afterUserInput?.review).toBeUndefined();

    await service.requestReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      requestedBy: "engineer",
      reason: "ready again",
      reviewContract: contract,
      reviewContractHash: hashDelegationContract(contract),
      userInputCursor: 1,
      sourceMutationEpoch: 0,
      sourceFingerprint: "b".repeat(64),
    });
    const afterSourceWrite = await service.recordSourceMutation({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
    });
    expect(afterSourceWrite).toMatchObject({ userInputCursor: 1, sourceMutationEpoch: 1 });
    expect(afterSourceWrite?.review).toBeUndefined();
  });

  test("rejects a late receipt from a replaced Reviewer attempt", async () => {
    const sessionId = await rootSession();
    const created = await service.create({ workspaceRoot: TMP_DIR, sessionId, authority: user, objective: "Ship the verified result." });
    const contract = reviewContract(created.objective);
    const requested = await service.requestReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: agent,
      requestedBy: "engineer",
      reason: "ready",
      reviewContract: contract,
      reviewContractHash: hashDelegationContract(contract),
      userInputCursor: 0,
      sourceMutationEpoch: 0,
      sourceFingerprint: "a".repeat(64),
    });
    const claimId = requested.review!.claim.claimId;
    await service.markReviewRunning({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      reviewerSessionId: "reviewer-old",
      reviewerExecutionId: "execution-old",
    });
    const restarted = await service.restartReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      reviewerSessionId: "reviewer-new",
      reviewerExecutionId: "execution-new",
    });
    expect(restarted.review).toMatchObject({ attempt: 2, reviewerSessionId: "reviewer-new", reviewerExecutionId: "execution-new" });

    const lateReceipt: SessionGoalReviewReceipt = {
      claimId,
      attempt: 1,
      reviewerSessionId: "reviewer-old",
      reviewerExecutionId: "execution-old",
      verdict: "accepted",
      summary: "late old acceptance",
      result: acceptedResult(),
      decidedAt: Date.now(),
    };
    await expect(service.completeReview({
      workspaceRoot: TMP_DIR,
      sessionId,
      authority: runtime,
      claimId,
      receipt: lateReceipt,
    })).rejects.toMatchObject({ code: "REVIEW_BASIS_MISMATCH" });
    expect((await service.get({ workspaceRoot: TMP_DIR, sessionId }))?.status).toBe("active");
  });
});
