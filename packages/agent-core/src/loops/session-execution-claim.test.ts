import { describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

import type { LoopState } from "@archcode/protocol";

import type { SessionLoopExecutionClaimInput } from "../execution/session-execution-scope-validator";
import type { LoopJobRecord } from "./job-queue";
import { LoopSessionExecutionClaimResolver } from "./session-execution-claim";

const PROJECT_ROOT = join(import.meta.dir, "__test_tmp__", "loop-session-claim-project");

describe("LoopSessionExecutionClaimResolver", () => {
  test("binds a canonical Session to the active run id and root Session", async () => {
    const loop = loopState({ currentRun: report({ runId: "run-1", sessionId: "loop-main" }) });
    const resolver = new LoopSessionExecutionClaimResolver();

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-1",
      sessionId: "loop-main",
    }))).resolves.toEqual({ outcome: "allow" });

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-1",
      sessionId: "child",
      rootSessionId: "other-main",
    }))).resolves.toMatchObject({
      outcome: "deny",
      code: "LOOP_SESSION_OWNER_MISMATCH",
    });
    await expect(resolver.resolve({
      ...claimInput(loop, { runId: "run-1", sessionId: "loop-main" }),
      origin: {
        kind: "loop",
        loopId: loop.loopId,
        trigger: "manual",
        approvalPolicy: "interactive",
      },
    })).resolves.toMatchObject({ outcome: "deny", code: "LOOP_RUN_ID_REQUIRED" });
  });

  test("rejects an old blocked checkpoint once a newer current run exists", async () => {
    const loop = loopState({
      currentRun: report({ runId: "run-new", sessionId: "new-main" }),
      lastRun: report({ runId: "run-old", sessionId: "old-main", status: "needs_user" }),
    });
    const resolver = new LoopSessionExecutionClaimResolver();

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-old",
      sessionId: "old-main",
    }))).resolves.toMatchObject({ outcome: "deny", code: "LOOP_RUN_SUPERSEDED" });
  });

  test("idempotently accepts the last blocked run when currentRun was cleared", async () => {
    const loop = loopState({
      lastRun: report({ runId: "run-blocked", sessionId: "loop-main", status: "needs_user" }),
    });
    const resolver = new LoopSessionExecutionClaimResolver();

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-blocked",
      sessionId: "loop-main",
    }))).resolves.toEqual({ outcome: "allow" });
  });

  test("binds a worktree Loop Session to its job checkpoint and deterministic managed claim", async () => {
    const loopId = crypto.randomUUID();
    const job = jobRecord({ loopId });
    const blocked = report({
      runId: "run-worktree",
      sessionId: "loop-main",
      status: "needs_user",
      jobId: job.jobId,
      worktreePath: job.worktreePath,
      baseSha: job.baseSha,
      resolvedHeadSha: job.resolvedHeadSha,
    });
    const loop = loopState({ loopId, useWorktree: true, currentRun: blocked, lastRun: blocked });
    const read = mock(async () => job);
    const reuse = mock(async (input: {
      loopSlug: string;
      subjectSlug: string;
      jobId: string;
      baseSha: string;
      worktreePath: string;
    }) => ({
      canonicalRoot: PROJECT_ROOT,
      managedRoot: join(PROJECT_ROOT, ".worktrees"),
      worktreePath: input.worktreePath,
      worktreeName: "worktree",
      branchName: "archcode/loop/loop/job",
      baseSha: input.baseSha,
      resolvedHeadSha: job.resolvedHeadSha!,
      canonicalStatus: { dirty: false, entries: [] },
    }));
    const resolver = new LoopSessionExecutionClaimResolver({
      jobQueueFactory: () => ({ read }),
      worktreeManagerFactory: () => ({ reuse }),
    });

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-worktree",
      sessionId: "loop-main",
      cwd: job.worktreePath,
    }))).resolves.toEqual({ outcome: "allow" });
    expect(reuse).toHaveBeenCalledWith({
      loopSlug: `loop-${loopId.slice(0, 8)}`,
      subjectSlug: job.subjectKey,
      jobId: job.jobId,
      baseSha: job.baseSha,
      worktreePath: job.worktreePath,
    });

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-worktree",
      sessionId: "loop-main",
      cwd: join(PROJECT_ROOT, "other-worktree"),
    }))).resolves.toMatchObject({ outcome: "deny", code: "LOOP_WORKTREE_CWD_MISMATCH" });
  });

  test("rejects one-sided resolved HEAD checkpoints", async () => {
    const loopId = crypto.randomUUID();
    const completeJob = jobRecord({ loopId });
    const completeReport = report({
      runId: "run-one-sided-head",
      sessionId: "loop-main",
      status: "needs_user",
      jobId: completeJob.jobId,
      worktreePath: completeJob.worktreePath,
      baseSha: completeJob.baseSha,
      resolvedHeadSha: completeJob.resolvedHeadSha,
    });
    const input = claimInput(loopState({
      loopId,
      useWorktree: true,
      currentRun: completeReport,
    }), {
      runId: completeReport.runId,
      sessionId: "loop-main",
      cwd: completeJob.worktreePath,
    });

    const missingJobHead = { ...completeJob, resolvedHeadSha: undefined };
    await expect(new LoopSessionExecutionClaimResolver({
      jobQueueFactory: () => ({ read: async () => missingJobHead }),
    }).resolve(input)).resolves.toMatchObject({
      outcome: "deny",
      code: "LOOP_JOB_WORKTREE_CHECKPOINT_MISMATCH",
      details: { field: "resolvedHeadSha", jobValue: undefined },
    });

    const reportMissingHead = { ...input.loop.currentRun!, resolvedHeadSha: undefined };
    await expect(new LoopSessionExecutionClaimResolver({
      jobQueueFactory: () => ({ read: async () => completeJob }),
    }).resolve({ ...input, loop: { ...input.loop, currentRun: reportMissingHead } })).resolves.toMatchObject({
      outcome: "deny",
      code: "LOOP_JOB_WORKTREE_CHECKPOINT_MISMATCH",
      details: { field: "resolvedHeadSha", reportValue: undefined },
    });
  });

  test("rejects a terminal job and mismatched Goal association", async () => {
    const loopId = crypto.randomUUID();
    const terminalJob = jobRecord({ loopId, status: "succeeded" });
    const active = report({
      runId: "run-goal",
      sessionId: "goal-main",
      goalId: "goal-1",
      status: "needs_user",
      jobId: terminalJob.jobId,
      worktreePath: terminalJob.worktreePath,
      baseSha: terminalJob.baseSha,
    });
    const loop = loopState({ loopId, useWorktree: true, currentRun: active });
    const resolver = new LoopSessionExecutionClaimResolver({
      jobQueueFactory: () => ({ read: async () => terminalJob }),
    });

    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-goal",
      sessionId: "goal-main",
      goalId: "other-goal",
      cwd: terminalJob.worktreePath,
    }))).resolves.toMatchObject({ outcome: "deny", code: "LOOP_GOAL_OWNER_MISMATCH" });
    await expect(resolver.resolve(claimInput(loop, {
      runId: "run-goal",
      sessionId: "goal-main",
      goalId: "goal-1",
      cwd: terminalJob.worktreePath,
    }))).resolves.toMatchObject({ outcome: "deny", code: "LOOP_JOB_NOT_EXECUTABLE" });
  });
});

function loopState(input: {
  readonly loopId?: string;
  readonly useWorktree?: boolean;
  readonly currentRun?: LoopState["currentRun"];
  readonly lastRun?: LoopState["lastRun"];
}): LoopState {
  const loopId = input.loopId ?? crypto.randomUUID();
  return {
    loopId,
    projectId: "test-project",
    config: {
      templateId: "watch_report",
      title: null,
      schedule: { kind: "manual" },
      approvalPolicy: "interactive",
      limits: { maxIterationsPerRun: 8, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
      useWorktree: input.useWorktree ?? false,
    },
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    runCount: 0,
    stateVersion: 1,
    ...(input.currentRun === undefined ? {} : { currentRun: { ...input.currentRun, loopId } }),
    ...(input.lastRun === undefined ? {} : { lastRun: { ...input.lastRun, loopId } }),
  };
}

function report(input: {
  readonly runId: string;
  readonly sessionId: string;
  readonly status?: "running" | "needs_user";
  readonly goalId?: string;
  readonly jobId?: string;
  readonly worktreePath?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
}): NonNullable<LoopState["currentRun"]> {
  return {
    runId: input.runId,
    loopId: "placeholder",
    status: input.status ?? "running",
    trigger: "manual",
    startedAt: 1,
    sessionId: input.sessionId,
    ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
    ...(input.jobId === undefined ? {} : { jobId: input.jobId }),
    ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
    ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
    ...(input.resolvedHeadSha === undefined ? {} : { resolvedHeadSha: input.resolvedHeadSha }),
  };
}

function claimInput(
  loop: LoopState,
  input: {
    readonly runId: string;
    readonly sessionId: string;
    readonly rootSessionId?: string;
    readonly goalId?: string;
    readonly cwd?: string;
  },
): SessionLoopExecutionClaimInput {
  return {
    projectRoot: PROJECT_ROOT,
    loop,
    subject: {
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId ?? input.sessionId,
      cwd: input.cwd ?? PROJECT_ROOT,
      loopId: loop.loopId,
      ...(input.goalId === undefined ? {} : { goalId: input.goalId }),
      sessionRole: "main",
    },
    origin: {
      kind: "loop",
      loopId: loop.loopId,
      runId: input.runId,
      trigger: "manual",
      approvalPolicy: "interactive",
    },
  };
}

function jobRecord(input: {
  readonly loopId: string;
  readonly status?: LoopJobRecord["status"];
}): LoopJobRecord {
  return {
    jobId: crypto.randomUUID(),
    loopId: input.loopId,
    status: input.status ?? "needs_user",
    triggerKind: "manual",
    subjectKey: "subject-1",
    dedupeKey: "manual:subject-1",
    priority: 0,
    queuedAt: 1,
    updatedAt: 1,
    revision: 1,
    attempts: 1,
    worktreePath: join(PROJECT_ROOT, "managed-loop-worktree"),
    worktreeBranchName: "archcode/loop/test/job",
    baseSha: "a".repeat(40),
    resolvedHeadSha: "a".repeat(40),
    eventSummaries: [],
  };
}
