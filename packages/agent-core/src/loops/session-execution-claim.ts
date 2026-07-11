import { resolve } from "node:path";

import type {
  SessionLoopExecutionClaimDecision,
  SessionLoopExecutionClaimInput,
  SessionLoopExecutionClaimResolver,
} from "../execution/session-execution-scope-validator";
import { LoopJobQueue, type LoopJobRecord } from "./job-queue";
import type { LoopRunReport } from "./state";
import { LoopWorktreeManager } from "./worktree-manager";

export interface LoopSessionExecutionClaimResolverOptions {
  readonly jobQueueFactory?: (
    projectRoot: string,
  ) => Pick<LoopJobQueue, "read">;
  readonly worktreeManagerFactory?: (
    projectRoot: string,
  ) => Pick<LoopWorktreeManager, "reuse">;
}

/** Resolves a Loop Session back to the one durable run/job claim that owns it. */
export class LoopSessionExecutionClaimResolver implements SessionLoopExecutionClaimResolver {
  readonly #jobQueueFactory: (projectRoot: string) => Pick<LoopJobQueue, "read">;
  readonly #worktreeManagerFactory: (projectRoot: string) => Pick<LoopWorktreeManager, "reuse">;

  constructor(options: LoopSessionExecutionClaimResolverOptions = {}) {
    this.#jobQueueFactory = options.jobQueueFactory
      ?? ((projectRoot) => new LoopJobQueue({ workspaceRoot: projectRoot }));
    this.#worktreeManagerFactory = options.worktreeManagerFactory
      ?? ((projectRoot) => new LoopWorktreeManager({ canonicalRoot: projectRoot }));
  }

  async resolve(input: SessionLoopExecutionClaimInput): Promise<SessionLoopExecutionClaimDecision> {
    const runId = input.origin.runId;
    if (runId === undefined) {
      return deny("LOOP_RUN_ID_REQUIRED", "Loop execution origin is missing its durable run id");
    }

    const report = executableReport(input, runId);
    if ("outcome" in report) return report;
    if (
      report.loopId !== input.loop.loopId
      || report.trigger !== input.origin.trigger
      || input.origin.approvalPolicy !== input.loop.config.approvalPolicy
    ) {
      return deny(
        "LOOP_RUN_METADATA_MISMATCH",
        `Loop run ${runId}'s persisted metadata does not match its execution origin`,
        {
          reportLoopId: report.loopId,
          originLoopId: input.origin.loopId,
          reportTrigger: report.trigger,
          originTrigger: input.origin.trigger,
          configuredApprovalPolicy: input.loop.config.approvalPolicy,
          originApprovalPolicy: input.origin.approvalPolicy,
        },
      );
    }
    if (report.sessionId === undefined || report.sessionId !== input.subject.rootSessionId) {
      return deny(
        "LOOP_SESSION_OWNER_MISMATCH",
        `Session ${input.subject.sessionId} is not part of Loop run ${runId}`,
        { reportSessionId: report.sessionId, rootSessionId: input.subject.rootSessionId },
      );
    }
    if (report.goalId !== input.subject.goalId) {
      return deny(
        "LOOP_GOAL_OWNER_MISMATCH",
        `Session ${input.subject.sessionId} does not match Loop run ${runId}'s Goal owner`,
        { reportGoalId: report.goalId, sessionGoalId: input.subject.goalId },
      );
    }

    const jobResult = await this.#resolveJob(input, report);
    if ("outcome" in jobResult) return jobResult;
    const job = jobResult.job;

    if (input.loop.config.useWorktree !== true) {
      if (resolve(input.subject.cwd) !== resolve(input.projectRoot)) {
        return deny(
          "LOOP_CANONICAL_CWD_MISMATCH",
          `Loop run ${runId} must execute in the canonical project checkout`,
          { expectedCwd: resolve(input.projectRoot), cwd: resolve(input.subject.cwd) },
        );
      }
      if (report.worktreePath !== undefined || job?.worktreePath !== undefined) {
        return deny(
          "LOOP_UNEXPECTED_WORKTREE_CLAIM",
          `Loop run ${runId} retained a worktree claim while worktree isolation is disabled`,
          { reportWorktreePath: report.worktreePath, jobWorktreePath: job?.worktreePath },
        );
      }
      return { outcome: "allow" };
    }

    if (job === undefined || report.jobId === undefined) {
      return deny("LOOP_JOB_CLAIM_REQUIRED", `Loop run ${runId} is missing its durable job claim`);
    }
    const worktreePath = exactSharedField("worktreePath", report.worktreePath, job.worktreePath);
    if ("outcome" in worktreePath) return worktreePath;
    const baseSha = exactSharedField("baseSha", report.baseSha, job.baseSha);
    if ("outcome" in baseSha) return baseSha;
    const resolvedHeadSha = exactSharedField("resolvedHeadSha", report.resolvedHeadSha, job.resolvedHeadSha);
    if ("outcome" in resolvedHeadSha) return resolvedHeadSha;
    if (resolve(input.subject.cwd) !== resolve(worktreePath.value)) {
      return deny(
        "LOOP_WORKTREE_CWD_MISMATCH",
        `Session ${input.subject.sessionId} does not use Loop run ${runId}'s worktree`,
        { expectedCwd: resolve(worktreePath.value), cwd: resolve(input.subject.cwd) },
      );
    }

    try {
      const claim = await this.#worktreeManagerFactory(input.projectRoot).reuse({
        loopSlug: `loop-${input.loop.loopId.slice(0, 8)}`,
        subjectSlug: job.subjectKey,
        jobId: job.jobId,
        baseSha: baseSha.value,
        worktreePath: worktreePath.value,
      });
      if (
        resolve(claim.worktreePath) !== resolve(worktreePath.value)
        || claim.baseSha !== baseSha.value
      ) {
        return deny(
          "LOOP_WORKTREE_CLAIM_MISMATCH",
          `Loop run ${runId}'s validated worktree no longer matches its persisted job claim`,
          {
            expectedPath: worktreePath.value,
            actualPath: claim.worktreePath,
            expectedBaseSha: baseSha.value,
            actualBaseSha: claim.baseSha,
          },
        );
      }
    } catch (error) {
      return deny(
        "LOOP_WORKTREE_CLAIM_INVALID",
        `Loop run ${runId}'s managed worktree claim is no longer valid`,
        { worktreePath: worktreePath.value, baseSha: baseSha.value, cause: errorMessage(error) },
      );
    }
    return { outcome: "allow" };
  }

  async #resolveJob(
    input: SessionLoopExecutionClaimInput,
    report: LoopRunReport,
  ): Promise<{ readonly job?: LoopJobRecord } | SessionLoopExecutionClaimDecision> {
    if (report.jobId === undefined) return {};
    let job: LoopJobRecord;
    try {
      job = await this.#jobQueueFactory(input.projectRoot).read(report.jobId);
    } catch (error) {
      return deny(
        "LOOP_JOB_NOT_FOUND",
        `Loop run ${report.runId}'s durable job ${report.jobId} cannot be loaded`,
        { jobId: report.jobId, cause: errorMessage(error) },
      );
    }
    if (job.loopId !== input.loop.loopId) {
      return deny(
        "LOOP_JOB_OWNER_MISMATCH",
        `Loop job ${job.jobId} belongs to another Loop`,
        { jobLoopId: job.loopId, loopId: input.loop.loopId },
      );
    }
    const allowedStatuses = report.status === "running"
      ? new Set(["running"])
      : new Set(["running", "needs_user"]);
    if (!allowedStatuses.has(job.status)) {
      return deny(
        "LOOP_JOB_NOT_EXECUTABLE",
        `Loop job ${job.jobId} cannot resume from status ${job.status}`,
        { jobId: job.jobId, jobStatus: job.status, reportStatus: report.status },
      );
    }
    return { job };
  }
}

function executableReport(
  input: SessionLoopExecutionClaimInput,
  runId: string,
): LoopRunReport | SessionLoopExecutionClaimDecision {
  const current = input.loop.currentRun;
  if (current !== undefined) {
    if (current.runId !== runId) {
      return deny(
        "LOOP_RUN_SUPERSEDED",
        `Loop run ${runId} is no longer the current execution claim`,
        { currentRunId: current.runId },
      );
    }
    if (current.status !== "running" && current.status !== "needs_user") {
      return deny(
        "LOOP_RUN_NOT_EXECUTABLE",
        `Loop run ${runId} cannot execute from status ${current.status}`,
        { status: current.status },
      );
    }
    return current;
  }

  const blocked = input.loop.lastRun;
  if (blocked?.runId === runId && blocked.status === "needs_user") return blocked;
  return deny(
    "LOOP_RUN_NOT_ACTIVE",
    `Loop run ${runId} is not the current or last blocked run`,
    { lastRunId: blocked?.runId, lastRunStatus: blocked?.status },
  );
}

function exactSharedField(
  field: "worktreePath" | "baseSha" | "resolvedHeadSha",
  reportValue: string | undefined,
  jobValue: string | undefined,
): { readonly value: string } | SessionLoopExecutionClaimDecision {
  if (reportValue === undefined || jobValue === undefined || reportValue !== jobValue) {
    return deny(
      "LOOP_JOB_WORKTREE_CHECKPOINT_MISMATCH",
      `Loop run and job ${field} checkpoints do not match`,
      { field, reportValue, jobValue },
    );
  }
  return { value: reportValue };
}

function deny(
  code: string,
  message: string,
  details?: Readonly<Record<string, unknown>>,
): SessionLoopExecutionClaimDecision {
  return { outcome: "deny", code, message, ...(details === undefined ? {} : { details }) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
