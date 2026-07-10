import type { HitlRecord, HitlResponse, LoopHitlCheckpoint, LoopRunReport } from "@archcode/protocol";

import type { LoopHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import type { LoopJobConditionalUpdateResult, LoopJobRecord, LoopJobUpdateExpectation, LoopJobUpdateInput } from "./job-queue";
import { LoopStateManager } from "./state";

export interface LoopHitlJobStore {
  read(jobId: string): Promise<LoopJobRecord>;
  list(): Promise<LoopJobRecord[]>;
  updateIfCurrent(
    jobId: string,
    expected: LoopJobUpdateExpectation,
    updates: LoopJobUpdateInput,
  ): Promise<LoopJobConditionalUpdateResult>;
}

export class LoopHitlResumeConflictError extends Error {
  constructor(
    public readonly hitlId: string,
    public readonly reason: "job_queue_missing" | "job_id_missing" | "job_not_found" | "job_unexpected" | "cas_diverged" | "state_unexpected" | "checkpoint_ambiguous",
    message: string,
  ) {
    super(message);
    this.name = "LoopHitlResumeConflictError";
  }
}

export interface LoopHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly stateManager: LoopStateManager;
  readonly jobQueue?: LoopHitlJobStore;
  readonly now?: () => number;
  readonly onContinuationQueued?: (checkpoint: LoopHitlCheckpoint) => void | Promise<void>;
}

export class LoopHitlResumeAdapter implements ResumeAdapterContract {
  readonly #stateManager: LoopStateManager;
  readonly #jobQueue?: LoopHitlJobStore;
  readonly #now: () => number;
  readonly #onContinuationQueued?: (checkpoint: LoopHitlCheckpoint) => void | Promise<void>;

  constructor(options: LoopHitlResumeAdapterOptions) {
    this.#stateManager = options.stateManager;
    this.#jobQueue = options.jobQueue;
    this.#now = options.now ?? (() => Date.now());
    this.#onContinuationQueued = options.onContinuationQueued;
  }

  async resume(record: HitlRecord, response: HitlResponse): Promise<void> {
    if (record.owner.ownerType !== "loop") throw new Error(`Loop adapter cannot resume ${record.owner.ownerType} HITL`);
    const checkpoint = await this.#checkpoint(record);
    if (checkpoint.hitlId !== record.hitlId) throw new Error(`Loop HITL checkpoint mismatch for ${record.hitlId}`);

    if (isApproval(response)) {
      await this.#resumeApproved(checkpoint, record.hitlId);
      return;
    }

    await this.#finishTerminal(checkpoint, record.hitlId, terminalReason(response), response.type === "approval_decision" && response.decision === "denied" ? "skipped" : "cancelled");
  }

  async #checkpoint(record: HitlRecord): Promise<LoopHitlCheckpoint> {
    const state = await this.#stateManager.read(record.owner.ownerId);
    const candidates = [state.resumeCheckpoint, state.currentRun?.resumeCheckpoint, state.lastRun?.resumeCheckpoint]
      .filter((checkpoint): checkpoint is LoopHitlCheckpoint => checkpoint?.hitlId === record.hitlId);
    if (this.#jobQueue !== undefined) {
      for (const job of await this.#jobQueue.list()) {
        if (job.loopId === record.owner.ownerId && job.resumeCheckpoint?.hitlId === record.hitlId) {
          candidates.push(job.resumeCheckpoint);
        }
      }
    }
    if (candidates.length === 0) {
      for (const report of await this.#stateManager.readRunLog(record.owner.ownerId)) {
        if (report.resumeCheckpoint?.hitlId === record.hitlId) candidates.push(report.resumeCheckpoint);
      }
    }
    const unique = new Map(candidates.map((checkpoint) => [JSON.stringify(checkpoint), checkpoint]));
    if (unique.size > 1) {
      throw new LoopHitlResumeConflictError(record.hitlId, "checkpoint_ambiguous", `Ambiguous Loop HITL checkpoints for ${record.hitlId}`);
    }
    const checkpoint = unique.values().next().value as LoopHitlCheckpoint | undefined;
    if (checkpoint === undefined) throw new Error(`Missing Loop HITL checkpoint for ${record.hitlId}`);
    if (checkpoint.loopId !== record.owner.ownerId) throw new Error(`Loop HITL checkpoint ${record.hitlId} belongs to ${checkpoint.loopId}`);
    return checkpoint;
  }

  async #resumeApproved(checkpoint: LoopHitlCheckpoint, hitlId: string): Promise<void> {
    const { queue, job } = await this.#requiredJob(checkpoint, hitlId);
    const committed = isApprovedContinuationCommitted(job, checkpoint);
    if (!committed && !isBlockedForCheckpoint(job, checkpoint)) {
      throw unexpectedJob(hitlId, job);
    }

    if (!committed) {
      const update = await queue.updateIfCurrent(job.jobId, job, approvedJobUpdate(this.#now()));
      if (update.outcome === "condition_mismatch") {
        const reread = await this.#readRequiredJob(queue, job.jobId, hitlId);
        if (!isApprovedContinuationCommitted(reread, checkpoint)) {
          throw new LoopHitlResumeConflictError(hitlId, "cas_diverged", `Loop HITL ${hitlId} job CAS diverged to unexpected status ${reread.status}`);
        }
      }
    }

    // Queue commit precedes state clearing. The scheduler dispatch callback is
    // intentionally last, so this process cannot run the continuation while the
    // Loop still advertises needs_user. A crash is replayed from state/job/run-log.
    await this.#stateManager.clearHitlBlocker(checkpoint.loopId, hitlId);
    await this.#onContinuationQueued?.(checkpoint);
  }

  async #finishTerminal(checkpoint: LoopHitlCheckpoint, hitlId: string, reason: string, status: "cancelled" | "skipped"): Promise<void> {
    const { queue, job } = await this.#requiredJob(checkpoint, hitlId);
    const committed = isTerminalJobCommitted(job, checkpoint, status, reason);
    if (!committed && !isBlockedForCheckpoint(job, checkpoint)) throw unexpectedJob(hitlId, job);
    if (!committed) {
      const update = await queue.updateIfCurrent(job.jobId, job, terminalJobUpdate(status, reason, this.#now()));
      if (update.outcome === "condition_mismatch") {
        const reread = await this.#readRequiredJob(queue, job.jobId, hitlId);
        if (!isTerminalJobCommitted(reread, checkpoint, status, reason)) {
          throw new LoopHitlResumeConflictError(hitlId, "cas_diverged", `Loop HITL ${hitlId} terminal job CAS diverged to unexpected status ${reread.status}`);
        }
      }
    }

    const state = await this.#stateManager.read(checkpoint.loopId);
    if (isTerminalStateCommitted(state, checkpoint, status)) return;
    if (isTerminalRunCommitted(state, checkpoint, status)) {
      // recordRunFinish and clearHitlBlocker are two atomic-file commits. If the
      // process stopped between them, the terminal run is authoritative and the
      // retained top-level checkpoint is the recovery cursor for this cleanup.
      await this.#stateManager.clearHitlBlocker(checkpoint.loopId, hitlId);
      return;
    }
    const current = state.currentRun?.runId === checkpoint.runId ? state.currentRun : state.lastRun;
    if (current?.resumeCheckpoint?.hitlId !== hitlId || current.status !== "needs_user") {
      throw new LoopHitlResumeConflictError(hitlId, "state_unexpected", `Loop HITL ${hitlId} state is not the expected needs_user run ${checkpoint.runId}`);
    }
    const report: LoopRunReport = {
      ...current,
      status,
      endedAt: this.#now(),
      reason: status === "cancelled" ? "cancelled_by_user" : undefined,
      skippedReason: status === "skipped" ? reason : undefined,
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
      resumeCheckpoint: undefined,
      summary: reason,
      error: undefined,
    };
    await this.#stateManager.recordRunFinish(checkpoint.loopId, report);
    await this.#stateManager.clearHitlBlocker(checkpoint.loopId, hitlId);
  }

  async #requiredJob(checkpoint: LoopHitlCheckpoint, hitlId: string): Promise<{ queue: LoopHitlJobStore; job: LoopJobRecord }> {
    const queue = this.#jobQueue;
    if (queue === undefined) throw new LoopHitlResumeConflictError(hitlId, "job_queue_missing", `Loop HITL ${hitlId} has no durable job queue`);
    if (checkpoint.jobId === undefined) throw new LoopHitlResumeConflictError(hitlId, "job_id_missing", `Loop HITL ${hitlId} checkpoint has no job id`);
    return { queue, job: await this.#readRequiredJob(queue, checkpoint.jobId, hitlId) };
  }

  async #readRequiredJob(queue: LoopHitlJobStore, jobId: string, hitlId: string): Promise<LoopJobRecord> {
    try {
      return await queue.read(jobId);
    } catch (error) {
      throw new LoopHitlResumeConflictError(hitlId, "job_not_found", `Loop HITL ${hitlId} job ${jobId} was not found: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function isApproval(response: HitlResponse): boolean {
  if (response.type === "approval_decision") return response.decision === "approved";
  if (response.type === "question_answer") return true;
  return false;
}

function terminalReason(response: HitlResponse): string {
  if (response.type === "cancel") return response.reason;
  if (response.type === "approval_decision") return response.comment ?? `Loop HITL ${response.decision}`;
  return `Loop HITL response ${response.type} did not approve continuation`;
}

function isBlockedForCheckpoint(job: LoopJobRecord, checkpoint: LoopHitlCheckpoint): boolean {
  return job.jobId === checkpoint.jobId
    && job.loopId === checkpoint.loopId
    && (job.status === "needs_user" || job.status === "blocked")
    && job.blockedByHitlIds?.includes(checkpoint.hitlId) === true
    && sameCheckpoint(job.resumeCheckpoint, checkpoint);
}

function isApprovedContinuationCommitted(job: LoopJobRecord, checkpoint: LoopHitlCheckpoint): boolean {
  return job.jobId === checkpoint.jobId
    && job.loopId === checkpoint.loopId
    && job.status === "pending"
    && job.resumeCheckpoint === undefined
    && job.blockedByHitlIds === undefined
    && job.attentionStatus === "clear";
}

function isTerminalJobCommitted(job: LoopJobRecord, checkpoint: LoopHitlCheckpoint, status: "cancelled" | "skipped", reason: string): boolean {
  return job.jobId === checkpoint.jobId
    && job.loopId === checkpoint.loopId
    && job.status === status
    && job.blockedReason === reason
    && job.resumeCheckpoint === undefined
    && job.blockedByHitlIds === undefined
    && job.attentionStatus === "clear";
}

function isTerminalStateCommitted(state: Awaited<ReturnType<LoopStateManager["read"]>>, checkpoint: LoopHitlCheckpoint, status: "cancelled" | "skipped"): boolean {
  return isTerminalRunCommitted(state, checkpoint, status)
    && state.resumeCheckpoint?.hitlId !== checkpoint.hitlId
    && state.blockedByHitlIds?.includes(checkpoint.hitlId) !== true;
}

function isTerminalRunCommitted(state: Awaited<ReturnType<LoopStateManager["read"]>>, checkpoint: LoopHitlCheckpoint, status: "cancelled" | "skipped"): boolean {
  return state.lastRun?.runId === checkpoint.runId
    && state.lastRun.status === status
    && state.currentRun?.runId !== checkpoint.runId;
}

function sameCheckpoint(left: LoopHitlCheckpoint | undefined, right: LoopHitlCheckpoint): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function approvedJobUpdate(updatedAt: number): LoopJobUpdateInput {
  return {
    status: "pending",
    blockedReason: undefined,
    blockedByHitlIds: undefined,
    attentionStatus: "clear",
    resumeCheckpoint: undefined,
    startedAt: undefined,
    endedAt: undefined,
    leaseExpiresAt: undefined,
    leaseOwnerId: undefined,
    leaseToken: undefined,
    updatedAt,
  };
}

function terminalJobUpdate(status: "cancelled" | "skipped", reason: string, updatedAt: number): LoopJobUpdateInput {
  return {
    status,
    blockedReason: reason,
    blockedByHitlIds: undefined,
    attentionStatus: "clear",
    resumeCheckpoint: undefined,
    leaseExpiresAt: undefined,
    leaseOwnerId: undefined,
    leaseToken: undefined,
    endedAt: updatedAt,
    updatedAt,
  };
}

function unexpectedJob(hitlId: string, job: LoopJobRecord): LoopHitlResumeConflictError {
  return new LoopHitlResumeConflictError(hitlId, "job_unexpected", `Loop HITL ${hitlId} job ${job.jobId} is in unexpected status ${job.status}`);
}
