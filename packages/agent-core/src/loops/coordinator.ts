import { LoopCoordinatorConfigSchema, type LoopCoordinatorConfig, type LoopJobStatus } from "./state";
import { isTerminalStatus, LoopJobQueue, type LoopJobQueueClock, type LoopJobRecord } from "./job-queue";

export interface LoopJobCoordinatorOptions {
  readonly queue: LoopJobQueue;
  readonly config?: Partial<LoopCoordinatorConfig>;
  readonly clock?: LoopJobQueueClock;
  readonly leaseTtlMs?: number;
}

export interface LoopJobFinishInput {
  readonly status: Exclude<LoopJobStatus, "pending" | "queued" | "running">;
  readonly summary?: string;
  readonly blockedReason?: string;
}

const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000;

export class LoopJobCoordinator {
  readonly #queue: LoopJobQueue;
  readonly #config: LoopCoordinatorConfig;
  readonly #clock: LoopJobQueueClock;
  readonly #leaseTtlMs: number;

  constructor(options: LoopJobCoordinatorOptions) {
    this.#queue = options.queue;
    this.#config = LoopCoordinatorConfigSchema.parse(options.config);
    this.#clock = options.clock ?? options.queue.clock;
    this.#leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  get maxConcurrent(): number {
    return this.#config.maxConcurrent;
  }

  async start(): Promise<LoopJobRecord[]> {
    return await this.recoverStaleRunning();
  }

  async recoverStaleRunning(): Promise<LoopJobRecord[]> {
    return await this.#queue.recoverStaleRunning(this.#clock.now());
  }

  async dispatchReady(): Promise<LoopJobRecord[]> {
    await this.recoverStaleRunning();

    const jobs = await this.#queue.list();
    const running = jobs.filter((job) => job.status === "running");
    let remainingSlots = Math.max(0, this.#config.maxConcurrent - running.length);
    if (remainingSlots === 0) return [];

    const runningBranchKeys = new Set(running.map((job) => job.branchKey).filter((key): key is string => key !== undefined));
    const runningCollisionKeys = new Set(running.map((job) => job.collisionKey).filter((key): key is string => key !== undefined));
    const candidates = jobs
      .filter((job) => job.status === "pending" || job.status === "queued")
      .sort(priorityFifoCompare);

    const started: LoopJobRecord[] = [];
    for (const candidate of candidates) {
      if (remainingSlots === 0) break;
      if (candidate.branchKey !== undefined && runningBranchKeys.has(candidate.branchKey)) continue;
      if (candidate.collisionKey !== undefined && runningCollisionKeys.has(candidate.collisionKey)) continue;

      const now = this.#clock.now();
      const startedJob = await this.#queue.update(candidate.jobId, {
        status: "running",
        startedAt: now,
        endedAt: undefined,
        leaseExpiresAt: now + this.#leaseTtlMs,
        attempts: candidate.attempts + 1,
        updatedAt: now,
      });
      started.push(startedJob);
      remainingSlots -= 1;
      if (startedJob.branchKey !== undefined) runningBranchKeys.add(startedJob.branchKey);
      if (startedJob.collisionKey !== undefined) runningCollisionKeys.add(startedJob.collisionKey);
    }

    return started;
  }

  async finish(jobId: string, input: LoopJobFinishInput): Promise<LoopJobRecord> {
    const existing = await this.#queue.read(jobId);
    const finished = await this.#queue.update(jobId, {
      status: input.status,
      blockedReason: input.blockedReason,
      endedAt: this.#clock.now(),
      leaseExpiresAt: undefined,
      updatedAt: this.#clock.now(),
      rerunAfterCurrent: input.status === "blocked" || input.status === "needs_user" ? existing.rerunAfterCurrent : undefined,
    });

    if (existing.rerunAfterCurrent === true && isTerminalStatus(input.status)) {
      await this.#queue.enqueue({
        loopId: existing.loopId,
        triggerKind: existing.triggerKind,
        subjectKey: existing.subjectKey,
        priority: existing.priority,
        branchKey: existing.branchKey,
        collisionKey: existing.collisionKey,
        collisionTarget: existing.collisionTarget,
        worktreePath: existing.worktreePath,
        baseSha: existing.baseSha,
        resolvedHeadSha: existing.resolvedHeadSha,
        missedCount: existing.missedCount,
        eventSummary: {
          summary: input.summary ?? "Queued rerun requested while previous job was running",
          source: "loop-coordinator",
        },
      });
    }

    return finished;
  }
}

function priorityFifoCompare(left: LoopJobRecord, right: LoopJobRecord): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.queuedAt !== right.queuedAt) return left.queuedAt - right.queuedAt;
  return left.jobId.localeCompare(right.jobId);
}
