import { LoopCoordinatorConfigSchema, type LoopCleanupState, type LoopCoordinatorConfig, type LoopJobStatus, type LoopWorktreeArtifact } from "./state";
import { LoopJobQueue, type ClaimNeedsUserLoopJobResult, type LoopJobExecutionLease, type LoopJobQueueClock, type LoopJobRecord, type LoopJobUpdateInput } from "./job-queue";

export interface LoopJobCoordinatorOptions {
  readonly queue: LoopJobQueue;
  readonly config?: Partial<LoopCoordinatorConfig>;
  readonly clock?: LoopJobQueueClock;
  readonly leaseTtlMs?: number;
  readonly incarnationId?: string;
}

export interface LoopWorktreeCheckpointInput {
  readonly worktreePath: string;
  readonly worktreeBranchName: string;
  readonly baseSha: string;
  readonly resolvedHeadSha: string;
}

export interface LoopSessionAttemptCheckpointInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly sessionExecutionId: string;
}

export interface LoopJobFinishInput {
  readonly status: Exclude<LoopJobStatus, "pending" | "queued" | "running">;
  readonly summary?: string;
  readonly blockedReason?: string;
  readonly blockedByHitlIds?: string[];
  readonly attentionStatus?: "clear" | "waiting_for_human";
  readonly resumeCheckpoint?: LoopJobRecord["resumeCheckpoint"];
  readonly worktreePath?: string;
  readonly worktreeBranchName?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly cleanupState?: LoopCleanupState;
  readonly cleanupWarning?: string;
  readonly observedArtifacts?: LoopWorktreeArtifact[];
}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

export class LoopJobExecutionLeaseError extends Error {
  constructor(
    public readonly jobId: string,
    public readonly expectedLease: LoopJobExecutionLease,
    public readonly actualJob: LoopJobRecord,
  ) {
    super(`Loop job ${jobId} is no longer owned by execution lease ${expectedLease.leaseToken}.`);
    this.name = "LoopJobExecutionLeaseError";
  }
}

export class LoopJobCoordinator {
  readonly #queue: LoopJobQueue;
  readonly #config: LoopCoordinatorConfig;
  readonly #clock: LoopJobQueueClock;
  readonly #leaseTtlMs: number;
  readonly #incarnationId: string;

  constructor(options: LoopJobCoordinatorOptions) {
    this.#queue = options.queue;
    this.#config = LoopCoordinatorConfigSchema.parse(options.config ?? { maxConcurrent: 2 });
    this.#clock = options.clock ?? options.queue.clock;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.#incarnationId = options.incarnationId ?? crypto.randomUUID();
  }

  get maxConcurrent(): number {
    return this.#config.maxConcurrent;
  }

  async start(): Promise<LoopJobRecord[]> {
    const recoveredFromPriorProcess = await this.#queue.recoverRunningFromPriorIncarnation(this.#incarnationId, this.#clock.now());
    const recoveredExpired = await this.recoverStaleRunning();
    return [...recoveredFromPriorProcess, ...recoveredExpired];
  }

  async recoverStaleRunning(): Promise<LoopJobRecord[]> {
    return await this.#queue.recoverStaleRunning(this.#clock.now());
  }

  async dispatchReady(): Promise<LoopJobRecord[]> {
    const started: LoopJobRecord[] = [];
    while (true) {
      const now = this.#clock.now();
      const leaseToken = crypto.randomUUID();
      const startedJob = await this.#queue.claimNextReady({
        maxConcurrent: this.#config.maxConcurrent,
        leaseOwnerId: this.#incarnationId,
        leaseToken,
        startedAt: now,
        leaseExpiresAt: now + this.#leaseTtlMs,
      });
      if (startedJob === undefined) break;
      started.push(startedJob);
    }

    return started;
  }

  async resumeNeedsUser(
    jobId: string,
    hitlId: string,
    resumeCheckpoint: LoopJobRecord["resumeCheckpoint"],
  ): Promise<ClaimNeedsUserLoopJobResult> {
    const now = this.#clock.now();
    return await this.#queue.claimNeedsUserById({
      jobId,
      hitlId,
      resumeCheckpoint,
      maxConcurrent: this.#config.maxConcurrent,
      leaseOwnerId: this.#incarnationId,
      leaseToken: crypto.randomUUID(),
      startedAt: now,
      leaseExpiresAt: now + this.#leaseTtlMs,
    });
  }

  async finish(jobId: string, lease: LoopJobExecutionLease, input: LoopJobFinishInput): Promise<LoopJobRecord> {
    const now = this.#clock.now();
    const result = await this.#queue.finishClaimedRunning(jobId, lease, {
      status: input.status,
      blockedReason: input.blockedReason,
      blockedByHitlIds: input.blockedByHitlIds,
      attentionStatus: input.attentionStatus,
      resumeCheckpoint: input.resumeCheckpoint,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.worktreeBranchName === undefined ? {} : { worktreeBranchName: input.worktreeBranchName }),
      ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
      ...(input.resolvedHeadSha === undefined ? {} : { resolvedHeadSha: input.resolvedHeadSha }),
      ...(input.cleanupState === undefined ? {} : { cleanupState: input.cleanupState }),
      ...(input.cleanupWarning === undefined ? {} : { cleanupWarning: input.cleanupWarning }),
      ...(input.observedArtifacts === undefined ? {} : { observedArtifacts: input.observedArtifacts }),
      endedAt: now,
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
      updatedAt: now,
    }, {
      summary: input.summary ?? "Queued rerun requested while previous job was running",
      source: "loop-coordinator",
    }, now);
    if (result.outcome === "lease_mismatch") throw new LoopJobExecutionLeaseError(jobId, lease, result.job);
    return result.updated;
  }

  /** Reconciles a report-first crash against the exact durable queue revision and lease. */
  async reconcileReportedFinish(job: LoopJobRecord, input: LoopJobFinishInput): Promise<LoopJobRecord> {
    const now = this.#clock.now();
    const result = await this.#queue.finishNonTerminalIfCurrent(job.jobId, job, {
      status: input.status,
      blockedReason: input.blockedReason,
      blockedByHitlIds: input.blockedByHitlIds,
      attentionStatus: input.attentionStatus,
      resumeCheckpoint: input.resumeCheckpoint,
      ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      ...(input.worktreeBranchName === undefined ? {} : { worktreeBranchName: input.worktreeBranchName }),
      ...(input.baseSha === undefined ? {} : { baseSha: input.baseSha }),
      ...(input.resolvedHeadSha === undefined ? {} : { resolvedHeadSha: input.resolvedHeadSha }),
      ...(input.cleanupState === undefined ? {} : { cleanupState: input.cleanupState }),
      ...(input.cleanupWarning === undefined ? {} : { cleanupWarning: input.cleanupWarning }),
      ...(input.observedArtifacts === undefined ? {} : { observedArtifacts: input.observedArtifacts }),
      endedAt: now,
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
      updatedAt: now,
    }, {
      summary: input.summary ?? "Recovered queued rerun after terminal report",
      source: "loop-coordinator",
    }, now);
    if (result.outcome === "condition_mismatch") return result.job;
    return result.updated;
  }

  async checkpointWorktree(jobId: string, lease: LoopJobExecutionLease, input: LoopWorktreeCheckpointInput): Promise<LoopJobRecord> {
    return (await this.#updateClaimedRunning(jobId, lease, input)).updated;
  }

  async checkpointSessionAttempt(jobId: string, lease: LoopJobExecutionLease, input: LoopSessionAttemptCheckpointInput): Promise<LoopJobRecord> {
    return (await this.#updateClaimedRunning(jobId, lease, input)).updated;
  }

  async checkpointBaseSha(jobId: string, lease: LoopJobExecutionLease, baseSha: string): Promise<LoopJobRecord> {
    return (await this.#updateClaimedRunning(jobId, lease, { baseSha })).updated;
  }

  async requeueWorktreePreparationFailure(jobId: string, lease: LoopJobExecutionLease): Promise<LoopJobRecord> {
    return (await this.#updateClaimedRunning(jobId, lease, {
      status: "pending",
      startedAt: undefined,
      endedAt: undefined,
      leaseExpiresAt: undefined,
      leaseOwnerId: undefined,
      leaseToken: undefined,
    })).updated;
  }

  async #updateClaimedRunning(jobId: string, lease: LoopJobExecutionLease, updates: LoopJobUpdateInput): Promise<{
    readonly previous: LoopJobRecord;
    readonly updated: LoopJobRecord;
  }> {
    const result = await this.#queue.updateClaimedRunning(jobId, lease, updates, this.#clock.now());
    if (result.outcome === "lease_mismatch") throw new LoopJobExecutionLeaseError(jobId, lease, result.job);
    return result;
  }
}
