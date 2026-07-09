import type { HitlRecord, HitlResponse, LoopHitlCheckpoint, LoopRunReport } from "@archcode/protocol";

import type { LoopHitlResumeAdapter as ResumeAdapterContract } from "../hitl/resume-coordinator";
import { LoopJobNotFoundError, LoopJobQueue } from "./job-queue";
import { LoopStateManager } from "./state";

export interface LoopHitlResumeAdapterOptions {
  readonly workspaceRoot: string;
  readonly stateManager: LoopStateManager;
  readonly jobQueue?: LoopJobQueue;
  readonly now?: () => number;
  readonly onContinuationQueued?: (checkpoint: LoopHitlCheckpoint) => void | Promise<void>;
}

export class LoopHitlResumeAdapter implements ResumeAdapterContract {
  readonly #stateManager: LoopStateManager;
  readonly #jobQueue?: LoopJobQueue;
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
    const checkpoint = state.resumeCheckpoint ?? state.currentRun?.resumeCheckpoint;
    if (checkpoint === undefined) throw new Error(`Missing Loop HITL checkpoint for ${record.hitlId}`);
    if (checkpoint.loopId !== record.owner.ownerId) throw new Error(`Loop HITL checkpoint ${record.hitlId} belongs to ${checkpoint.loopId}`);
    return checkpoint;
  }

  async #resumeApproved(checkpoint: LoopHitlCheckpoint, hitlId: string): Promise<void> {
    if (checkpoint.jobId !== undefined && this.#jobQueue !== undefined) {
      const job = await this.#jobQueue.read(checkpoint.jobId).catch((error) => {
        if (error instanceof LoopJobNotFoundError) return undefined;
        throw error;
      });
      if (job !== undefined && (job.status === "needs_user" || job.status === "blocked") && job.resumeCheckpoint?.hitlId === hitlId) {
        await this.#jobQueue.update(job.jobId, {
          status: "pending",
          blockedReason: undefined,
          blockedByHitlIds: undefined,
          attentionStatus: "clear",
          resumeCheckpoint: undefined,
          startedAt: undefined,
          endedAt: undefined,
          leaseExpiresAt: undefined,
          updatedAt: this.#now(),
        });
        await this.#onContinuationQueued?.(checkpoint);
      }
    }
    await this.#stateManager.clearHitlBlocker(checkpoint.loopId, hitlId);
  }

  async #finishTerminal(checkpoint: LoopHitlCheckpoint, hitlId: string, reason: string, status: "cancelled" | "skipped"): Promise<void> {
    if (checkpoint.jobId !== undefined && this.#jobQueue !== undefined) {
      const job = await this.#jobQueue.read(checkpoint.jobId).catch((error) => {
        if (error instanceof LoopJobNotFoundError) return undefined;
        throw error;
      });
      if (job !== undefined && !isJobTerminal(job.status)) {
        await this.#jobQueue.update(job.jobId, {
          status,
          blockedReason: reason,
          blockedByHitlIds: undefined,
          attentionStatus: "clear",
          resumeCheckpoint: undefined,
          leaseExpiresAt: undefined,
          endedAt: this.#now(),
          updatedAt: this.#now(),
        });
      }
    }

    const state = await this.#stateManager.read(checkpoint.loopId);
    const current = state.currentRun?.runId === checkpoint.runId ? state.currentRun : state.lastRun;
    const report: LoopRunReport = {
      ...(current ?? {
        runId: checkpoint.runId,
        loopId: checkpoint.loopId,
        trigger: checkpoint.trigger,
        startedAt: this.#now(),
      }),
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

function isJobTerminal(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped" || status === "expired";
}
