import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import { z } from "zod/v4";

import { containsSecretPattern } from "../security/patterns";
import { atomicWrite, isContained } from "../utils/safe-file";
import { canonicalTargetKey } from "./collision-ledger";
import {
  CollisionTargetSchema,
  LoopCleanupStateSchema,
  LoopHitlCheckpointSchema,
  LoopJobStatusSchema,
  LoopRunTriggerSchema,
  LoopWorktreeArtifactSchema,
  type CollisionTarget,
  type LoopJobStatus,
  type LoopRunTrigger,
  type LoopWorktreeArtifact,
} from "./state";

export interface LoopJobQueueClock {
  now(): number;
}

export interface LoopJobEventSummaryInput {
  readonly summary: string;
  readonly receivedAt?: number;
  readonly source?: string;
  readonly payloadSha?: string;
}

export interface LoopJobEventSummary {
  readonly summary: string;
  readonly receivedAt: number;
  readonly source?: string;
  readonly payloadSha?: string;
}

export interface EnqueueLoopJobInput {
  readonly loopId: string;
  readonly triggerKind: LoopRunTrigger;
  readonly subjectKey: string;
  readonly priority?: number;
  readonly branchKey?: string;
  readonly repoId?: string;
  readonly branch?: string;
  readonly collisionTarget?: CollisionTarget;
  readonly collisionKey?: string;
  readonly queuedAt?: number;
  readonly eventSummary?: LoopJobEventSummaryInput;
  readonly worktreePath?: string;
  readonly worktreeBranchName?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly missedCount?: number;
}

export interface LoopJobQueueOptions {
  readonly workspaceRoot: string;
  readonly clock?: LoopJobQueueClock;
  readonly maxJobs?: number;
  readonly maxTerminalJobs?: number;
  readonly maxFileBytes?: number;
}

export interface LoopJobRerunInput {
  readonly priority: number;
  readonly branchKey?: string;
  readonly collisionKey?: string;
  readonly collisionTarget?: CollisionTarget;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly missedCount?: number;
}

export interface LoopJobExecutionLease {
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
}

export type LoopJobClaimedUpdateResult =
  | { readonly outcome: "updated"; readonly previous: LoopJobRecord; readonly updated: LoopJobRecord }
  | { readonly outcome: "lease_mismatch"; readonly job: LoopJobRecord };

export type LoopJobClaimedFinishResult =
  | {
    readonly outcome: "updated";
    readonly previous: LoopJobRecord;
    readonly updated: LoopJobRecord;
    readonly rerun?: LoopJobRecord;
  }
  | { readonly outcome: "lease_mismatch"; readonly job: LoopJobRecord };

export type LoopJobConditionalUpdateResult =
  | { readonly outcome: "updated"; readonly previous: LoopJobRecord; readonly updated: LoopJobRecord }
  | { readonly outcome: "condition_mismatch"; readonly job: LoopJobRecord };

export type LoopJobConditionalFinishResult =
  | {
    readonly outcome: "updated";
    readonly previous: LoopJobRecord;
    readonly updated: LoopJobRecord;
    readonly rerun?: LoopJobRecord;
  }
  | { readonly outcome: "condition_mismatch"; readonly job: LoopJobRecord };

export type LoopJobUpdateExpectation = Pick<
  LoopJobRecord,
  "status" | "revision" | "leaseOwnerId" | "leaseToken" | "resumeCheckpoint"
>;

export interface ClaimNextLoopJobInput {
  readonly maxConcurrent: number;
  readonly leaseOwnerId: string;
  readonly leaseToken: string;
  readonly startedAt: number;
  readonly leaseExpiresAt: number;
}

export interface ClaimNeedsUserLoopJobInput extends ClaimNextLoopJobInput {
  readonly jobId: string;
  readonly hitlId: string;
  readonly resumeCheckpoint: LoopJobRecord["resumeCheckpoint"];
}

export type ClaimNeedsUserLoopJobResult =
  | { readonly outcome: "claimed"; readonly previous: LoopJobRecord; readonly job: LoopJobRecord }
  | {
    readonly outcome: "unavailable";
    readonly reason: "condition_mismatch" | "capacity" | "branch_conflict" | "collision_conflict";
    readonly job: LoopJobRecord;
  };

export interface LoopJobRecord {
  readonly jobId: string;
  readonly loopId: string;
  readonly status: LoopJobStatus;
  readonly triggerKind: LoopRunTrigger;
  readonly subjectKey: string;
  readonly dedupeKey: string;
  readonly branchKey?: string;
  readonly collisionKey?: string;
  readonly collisionTarget?: CollisionTarget;
  readonly priority: number;
  readonly queuedAt: number;
  readonly updatedAt: number;
  /** Monotonic per-record CAS revision. */
  readonly revision: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly attempts: number;
  readonly rerunAfterCurrent?: boolean;
  readonly rerunInput?: LoopJobRerunInput;
  readonly blockedReason?: string;
  readonly blockedByHitlIds?: string[];
  readonly attentionStatus?: "clear" | "waiting_for_human";
  readonly resumeCheckpoint?: z.infer<typeof LoopHitlCheckpointSchema>;
  /** Durable execution-attempt identity, checkpointed before Agent execution. */
  readonly runId?: string;
  readonly sessionId?: string;
  readonly sessionExecutionId?: string;
  readonly worktreePath?: string;
  readonly worktreeBranchName?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly missedCount?: number;
  readonly cleanupState?: z.infer<typeof LoopCleanupStateSchema>;
  readonly cleanupWarning?: string;
  readonly observedArtifacts?: LoopWorktreeArtifact[];
  readonly eventSummaries: LoopJobEventSummary[];
  readonly leaseExpiresAt?: number;
  readonly leaseOwnerId?: string;
  readonly leaseToken?: string;
}

export interface LoopJobQueueFile {
  readonly version: 1;
  readonly jobs: LoopJobRecord[];
  readonly updatedAt: number;
}

export interface EnqueueLoopJobResult {
  readonly job: LoopJobRecord;
  readonly created: boolean;
  readonly coalesced: boolean;
  readonly rerunAfterCurrent: boolean;
}

export type LoopJobUpdateInput = Partial<Omit<LoopJobRecord, "jobId" | "dedupeKey" | "queuedAt" | "revision">>;

export type LoopJobFinishUpdateInput = Omit<LoopJobUpdateInput, "status"> & {
  readonly status: Exclude<LoopJobStatus, "pending" | "queued" | "running">;
};

export interface LoopJobUpdateResult {
  readonly previous: LoopJobRecord;
  readonly updated: LoopJobRecord;
}

const MAX_EVENT_SUMMARIES = 100;
const DEFAULT_MAX_JOBS = 10_000;
const DEFAULT_MAX_TERMINAL_JOBS = 2_000;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;

const LoopIdentifierSchema = z.string().trim().min(1).max(500);
const TimestampMsSchema = z.number().int().nonnegative();

export const LoopJobEventSummarySchema = z.strictObject({
  summary: z.string().trim().min(1).max(20_000),
  receivedAt: TimestampMsSchema,
  source: z.string().trim().min(1).max(200).optional(),
  payloadSha: z.string().trim().min(1).max(128).optional(),
}) satisfies z.ZodType<LoopJobEventSummary>;

export const LoopJobRerunInputSchema = z.strictObject({
  priority: z.number().int(),
  branchKey: LoopIdentifierSchema.optional(),
  collisionKey: LoopIdentifierSchema.optional(),
  collisionTarget: CollisionTargetSchema.optional(),
  baseSha: z.string().trim().min(1).max(128).optional(),
  resolvedHeadSha: z.string().trim().min(1).max(128).optional(),
  missedCount: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<LoopJobRerunInput>;

export const LoopJobRecordSchema = z.strictObject({
  jobId: LoopIdentifierSchema,
  loopId: LoopIdentifierSchema,
  status: LoopJobStatusSchema,
  triggerKind: LoopRunTriggerSchema,
  subjectKey: LoopIdentifierSchema,
  dedupeKey: LoopIdentifierSchema,
  branchKey: LoopIdentifierSchema.optional(),
  collisionKey: LoopIdentifierSchema.optional(),
  collisionTarget: CollisionTargetSchema.optional(),
  priority: z.number().int(),
  queuedAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
  revision: z.number().int().nonnegative().default(0),
  startedAt: TimestampMsSchema.optional(),
  endedAt: TimestampMsSchema.optional(),
  attempts: z.number().int().nonnegative(),
  rerunAfterCurrent: z.boolean().optional(),
  rerunInput: LoopJobRerunInputSchema.optional(),
  blockedReason: z.string().trim().min(1).max(20_000).optional(),
  blockedByHitlIds: z.array(LoopIdentifierSchema).optional(),
  attentionStatus: z.enum(["clear", "waiting_for_human"]).optional(),
  resumeCheckpoint: LoopHitlCheckpointSchema.optional(),
  runId: LoopIdentifierSchema.optional(),
  sessionId: LoopIdentifierSchema.optional(),
  sessionExecutionId: LoopIdentifierSchema.optional(),
  worktreePath: z.string().trim().min(1).max(10_000).optional(),
  worktreeBranchName: LoopIdentifierSchema.optional(),
  baseSha: z.string().trim().min(1).max(128).optional(),
  resolvedHeadSha: z.string().trim().min(1).max(128).optional(),
  missedCount: z.number().int().nonnegative().optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
  cleanupWarning: z.string().trim().min(1).max(20_000).optional(),
  observedArtifacts: z.array(LoopWorktreeArtifactSchema).max(100).optional(),
  eventSummaries: z.array(LoopJobEventSummarySchema).max(MAX_EVENT_SUMMARIES),
  leaseExpiresAt: TimestampMsSchema.optional(),
  leaseOwnerId: LoopIdentifierSchema.optional(),
  leaseToken: LoopIdentifierSchema.optional(),
}) satisfies z.ZodType<LoopJobRecord>;

export const LoopJobQueueFileSchema = z.strictObject({
  version: z.literal(1),
  jobs: z.array(LoopJobRecordSchema),
  updatedAt: TimestampMsSchema,
}) satisfies z.ZodType<LoopJobQueueFile>;

const systemClock: LoopJobQueueClock = {
  now: () => Date.now(),
};

const waitingStatuses = new Set<LoopJobStatus>(["pending", "queued"]);

export class LoopJobQueueParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid loop job queue file: ${filePath}`);
    this.name = "LoopJobQueueParseError";
  }
}

export class LoopJobNotFoundError extends Error {
  constructor(public readonly jobId: string) {
    super(`Loop job not found: ${jobId}`);
    this.name = "LoopJobNotFoundError";
  }
}

export class LoopJobQueueLimitError extends Error {
  constructor(
    public readonly limit: string,
    public readonly value: number,
  ) {
    super(`Loop job queue limit exceeded: ${limit} (${value})`);
    this.name = "LoopJobQueueLimitError";
  }
}

export class LoopJobQueueSecurityError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Loop job queue rejected ${field}: ${reason}`);
    this.name = "LoopJobQueueSecurityError";
  }
}

export class LoopJobQueue {
  readonly #workspaceRoot: string;
  readonly #clock: LoopJobQueueClock;
  readonly #maxJobs: number;
  readonly #maxTerminalJobs: number;
  readonly #maxFileBytes: number;

  constructor(options: LoopJobQueueOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#clock = options.clock ?? systemClock;
    this.#maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
    this.#maxTerminalJobs = options.maxTerminalJobs ?? DEFAULT_MAX_TERMINAL_JOBS;
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  get clock(): LoopJobQueueClock {
    return this.#clock;
  }

  async enqueue(input: EnqueueLoopJobInput): Promise<EnqueueLoopJobResult> {
    return await this.withMutation(async () => {
      const now = input.queuedAt ?? this.#clock.now();
      const dedupeKey = dedupeKeyFor(input.loopId, input.triggerKind, input.subjectKey);
      const eventSummary = this.eventSummaryFromInput(input.eventSummary, now);
      const file = await this.readFileUnlocked();
      const duplicate = file.jobs.find((job) => job.dedupeKey === dedupeKey && isOpenStatus(job.status));

      if (duplicate !== undefined && waitingStatuses.has(duplicate.status) && (duplicate.worktreePath !== undefined || duplicate.attempts > 0)) {
        const updated = LoopJobRecordSchema.parse({
          ...duplicate,
          rerunAfterCurrent: true,
          rerunInput: mergeRerunInput(duplicate, input),
          updatedAt: now,
          revision: nextRevision(duplicate),
          eventSummaries: appendEventSummary(duplicate.eventSummaries, eventSummary),
        });
        await this.replaceJobUnlocked(file, updated);
        return { job: updated, created: false, coalesced: true, rerunAfterCurrent: true };
      }

      if (duplicate !== undefined && waitingStatuses.has(duplicate.status)) {
        const updated = LoopJobRecordSchema.parse({
          ...duplicate,
          priority: Math.max(duplicate.priority, input.priority ?? duplicate.priority),
          branchKey: branchKeyFor(input) ?? duplicate.branchKey,
          collisionKey: collisionKeyFor(input) ?? duplicate.collisionKey,
          collisionTarget: input.collisionTarget ?? duplicate.collisionTarget,
          worktreePath: input.worktreePath ?? duplicate.worktreePath,
          worktreeBranchName: input.worktreeBranchName ?? duplicate.worktreeBranchName,
          baseSha: input.baseSha ?? duplicate.baseSha,
          resolvedHeadSha: input.resolvedHeadSha ?? duplicate.resolvedHeadSha,
          missedCount: input.missedCount ?? duplicate.missedCount,
          updatedAt: now,
          revision: nextRevision(duplicate),
          eventSummaries: appendEventSummary(duplicate.eventSummaries, eventSummary),
        });
        await this.replaceJobUnlocked(file, updated);
        return { job: updated, created: false, coalesced: true, rerunAfterCurrent: false };
      }

      if (duplicate !== undefined && duplicate.status === "running") {
        const updated = LoopJobRecordSchema.parse({
          ...duplicate,
          rerunAfterCurrent: true,
          rerunInput: mergeRerunInput(duplicate, input),
          updatedAt: now,
          revision: nextRevision(duplicate),
          eventSummaries: appendEventSummary(duplicate.eventSummaries, eventSummary),
        });
        await this.replaceJobUnlocked(file, updated);
        return { job: updated, created: false, coalesced: true, rerunAfterCurrent: true };
      }

      const job = LoopJobRecordSchema.parse({
        jobId: crypto.randomUUID(),
        loopId: input.loopId,
        status: "pending",
        triggerKind: input.triggerKind,
        subjectKey: input.subjectKey,
        dedupeKey,
        branchKey: branchKeyFor(input),
        collisionKey: collisionKeyFor(input),
        collisionTarget: input.collisionTarget,
        priority: input.priority ?? 0,
        queuedAt: now,
        updatedAt: now,
        attempts: 0,
        worktreePath: input.worktreePath,
        worktreeBranchName: input.worktreeBranchName,
        baseSha: input.baseSha,
        resolvedHeadSha: input.resolvedHeadSha,
        missedCount: input.missedCount,
        eventSummaries: appendEventSummary([], eventSummary),
      });
      await this.writeFileUnlocked({ ...file, jobs: [...file.jobs, job], updatedAt: now });
      return { job, created: true, coalesced: false, rerunAfterCurrent: false };
    });
  }

  async list(statuses?: readonly LoopJobStatus[]): Promise<LoopJobRecord[]> {
    const file = await this.readFile();
    if (statuses === undefined) return file.jobs;
    const allowed = new Set(statuses);
    return file.jobs.filter((job) => allowed.has(job.status));
  }

  async read(jobId: string): Promise<LoopJobRecord> {
    const job = (await this.readFile()).jobs.find((candidate) => candidate.jobId === jobId);
    if (job === undefined) throw new LoopJobNotFoundError(jobId);
    return job;
  }

  async update(jobId: string, updates: LoopJobUpdateInput): Promise<LoopJobRecord> {
    return (await this.updateWithPrevious(jobId, updates)).updated;
  }

  async updateWithPrevious(jobId: string, updates: LoopJobUpdateInput): Promise<LoopJobUpdateResult> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const existing = file.jobs.find((job) => job.jobId === jobId);
      if (existing === undefined) throw new LoopJobNotFoundError(jobId);

      this.assertSafeUpdates(updates);
      const status = updates.status ?? existing.status;
      const endedAt = updates.endedAt ?? (isTerminalStatus(status) && existing.endedAt === undefined ? this.#clock.now() : existing.endedAt);
      const updated = LoopJobRecordSchema.parse({
        ...existing,
        ...updates,
        status,
        endedAt,
        updatedAt: updates.updatedAt ?? this.#clock.now(),
        revision: nextRevision(existing),
      });
      await this.replaceJobUnlocked(file, updated);
      return { previous: existing, updated };
    });
  }

  /** Conditional control-plane update that cannot overwrite a newer dispatch. */
  async updateIfCurrent(
    jobId: string,
    expected: LoopJobUpdateExpectation,
    updates: LoopJobUpdateInput,
  ): Promise<LoopJobConditionalUpdateResult> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const existing = file.jobs.find((job) => job.jobId === jobId);
      if (existing === undefined) throw new LoopJobNotFoundError(jobId);
      if (
        existing.status !== expected.status
        || existing.revision !== expected.revision
        || existing.leaseOwnerId !== expected.leaseOwnerId
        || existing.leaseToken !== expected.leaseToken
        || existing.resumeCheckpoint?.hitlId !== expected.resumeCheckpoint?.hitlId
      ) {
        return { outcome: "condition_mismatch", job: existing };
      }

      this.assertSafeUpdates(updates);
      const status = updates.status ?? existing.status;
      const endedAt = updates.endedAt ?? (isTerminalStatus(status) && existing.endedAt === undefined ? this.#clock.now() : existing.endedAt);
      const updated = LoopJobRecordSchema.parse({
        ...existing,
        ...updates,
        status,
        endedAt,
        updatedAt: updates.updatedAt ?? this.#clock.now(),
        revision: nextRevision(existing),
      });
      await this.replaceJobUnlocked(file, updated);
      return { outcome: "updated", previous: existing, updated };
    });
  }

  async updateClaimedRunning(
    jobId: string,
    lease: LoopJobExecutionLease,
    updates: LoopJobUpdateInput,
    updatedAt: number = this.#clock.now(),
  ): Promise<LoopJobClaimedUpdateResult> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const existing = file.jobs.find((job) => job.jobId === jobId);
      if (existing === undefined) throw new LoopJobNotFoundError(jobId);
      if (
        existing.status !== "running"
        || existing.leaseOwnerId !== lease.leaseOwnerId
        || existing.leaseToken !== lease.leaseToken
      ) {
        return { outcome: "lease_mismatch", job: existing };
      }

      this.assertSafeUpdates(updates);
      const updated = LoopJobRecordSchema.parse({
        ...existing,
        ...updates,
        updatedAt,
        revision: nextRevision(existing),
      });
      await this.replaceJobUnlocked(file, updated);
      return { outcome: "updated", previous: existing, updated };
    });
  }

  /**
   * Commits the terminal/continuation state of an owned dispatch and, when a
   * trigger was coalesced during that dispatch, creates its pending rerun in
   * the same queue-file mutation. A stale lease can therefore do neither.
   */
  async finishClaimedRunning(
    jobId: string,
    lease: LoopJobExecutionLease,
    updates: LoopJobFinishUpdateInput,
    rerunEventSummary?: LoopJobEventSummaryInput,
    finishedAt: number = this.#clock.now(),
  ): Promise<LoopJobClaimedFinishResult> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const existing = file.jobs.find((job) => job.jobId === jobId);
      if (existing === undefined) throw new LoopJobNotFoundError(jobId);
      if (
        existing.status !== "running"
        || existing.leaseOwnerId !== lease.leaseOwnerId
        || existing.leaseToken !== lease.leaseToken
      ) {
        return { outcome: "lease_mismatch", job: existing };
      }

      this.assertSafeUpdates(updates);
      const updatedAt = updates.updatedAt ?? finishedAt;
      const terminal = isTerminalStatus(updates.status);
      const endedAt = updates.endedAt ?? (terminal ? finishedAt : existing.endedAt);
      const updated = LoopJobRecordSchema.parse({
        ...existing,
        ...updates,
        endedAt,
        updatedAt,
        ...(terminal ? { rerunAfterCurrent: undefined, rerunInput: undefined } : {}),
        revision: nextRevision(existing),
      });
      const shouldCreateRerun = existing.rerunAfterCurrent === true && terminal;
      const rerun = shouldCreateRerun
        ? createPendingRerun(
          existing,
          finishedAt,
          this.eventSummaryFromInput(
            rerunEventSummary ?? {
              summary: "Queued rerun requested while previous job was running",
              source: "loop-coordinator",
            },
            finishedAt,
          ),
        )
        : undefined;
      const jobs = file.jobs.map((job) => job.jobId === jobId ? updated : job);
      await this.writeFileUnlocked({
        ...file,
        jobs: rerun === undefined ? jobs : [...jobs, rerun],
        updatedAt,
      });
      return { outcome: "updated", previous: existing, updated, ...(rerun === undefined ? {} : { rerun }) };
    });
  }

  /** Report-first reconciliation for an exact non-terminal record, including legacy jobs without lease tokens. */
  async finishNonTerminalIfCurrent(
    jobId: string,
    expected: LoopJobUpdateExpectation,
    updates: LoopJobFinishUpdateInput,
    rerunEventSummary?: LoopJobEventSummaryInput,
    finishedAt: number = this.#clock.now(),
  ): Promise<LoopJobConditionalFinishResult> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const existing = file.jobs.find((job) => job.jobId === jobId);
      if (existing === undefined) throw new LoopJobNotFoundError(jobId);
      if (isTerminalStatus(existing.status) || !matchesExpectation(existing, expected)) {
        return { outcome: "condition_mismatch", job: existing };
      }

      this.assertSafeUpdates(updates);
      const updatedAt = updates.updatedAt ?? finishedAt;
      const terminal = isTerminalStatus(updates.status);
      const updated = LoopJobRecordSchema.parse({
        ...existing,
        ...updates,
        endedAt: updates.endedAt ?? (terminal ? finishedAt : existing.endedAt),
        updatedAt,
        ...(terminal ? { rerunAfterCurrent: undefined, rerunInput: undefined } : {}),
        revision: nextRevision(existing),
      });
      const rerun = existing.rerunAfterCurrent === true && terminal
        ? createPendingRerun(
          existing,
          finishedAt,
          this.eventSummaryFromInput(
            rerunEventSummary ?? { summary: "Queued rerun recovered after terminal report", source: "loop-coordinator" },
            finishedAt,
          ),
        )
        : undefined;
      const jobs = file.jobs.map((job) => job.jobId === jobId ? updated : job);
      await this.writeFileUnlocked({ ...file, jobs: rerun === undefined ? jobs : [...jobs, rerun], updatedAt });
      return { outcome: "updated", previous: existing, updated, ...(rerun === undefined ? {} : { rerun }) };
    });
  }

  /**
   * Claims the highest-priority runnable job while holding the queue mutation
   * lock. Capacity and serialization checks intentionally live in the same
   * critical section as the status/token transition so concurrent coordinators
   * cannot both dispatch the same job or violate branch/collision limits.
   */
  async claimNextReady(input: ClaimNextLoopJobInput): Promise<LoopJobRecord | undefined> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      // HITL-waiting jobs intentionally release scheduler keys. Their managed
      // worktree is job-id isolated; an approved continuation returns to
      // pending and must reacquire these keys against every running job.
      const running = file.jobs.filter((job) => job.status === "running");
      if (running.length >= input.maxConcurrent) return undefined;

      const runningBranchKeys = new Set(running.map((job) => job.branchKey).filter((key): key is string => key !== undefined));
      const runningCollisionKeys = new Set(running.map((job) => job.collisionKey).filter((key): key is string => key !== undefined));
      const candidate = file.jobs
        .filter((job) => waitingStatuses.has(job.status))
        .sort(priorityFifoCompare)
        .find((job) => (
          (job.branchKey === undefined || !runningBranchKeys.has(job.branchKey))
          && (job.collisionKey === undefined || !runningCollisionKeys.has(job.collisionKey))
        ));
      if (candidate === undefined) return undefined;

      const claimed = LoopJobRecordSchema.parse({
        ...candidate,
        status: "running",
        startedAt: input.startedAt,
        endedAt: undefined,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseOwnerId: input.leaseOwnerId,
        leaseToken: input.leaseToken,
        attempts: candidate.attempts + 1,
        updatedAt: input.startedAt,
        revision: nextRevision(candidate),
      });
      await this.replaceJobUnlocked(file, claimed);
      return claimed;
    });
  }

  /**
   * Reclaims one exact HITL-blocked job without allowing an arbitrary pending
   * job to consume the response path. Capacity and scheduler-key checks share
   * the queue mutation lock with the lease transition.
   */
  async claimNeedsUserById(input: ClaimNeedsUserLoopJobInput): Promise<ClaimNeedsUserLoopJobResult> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const candidate = file.jobs.find((job) => job.jobId === input.jobId);
      if (candidate === undefined) throw new LoopJobNotFoundError(input.jobId);
      if (
        candidate.status !== "needs_user"
        || candidate.blockedByHitlIds?.includes(input.hitlId) !== true
      ) {
        return { outcome: "unavailable", reason: "condition_mismatch", job: candidate };
      }

      const running = file.jobs.filter((job) => job.status === "running");
      if (running.length >= input.maxConcurrent) {
        return { outcome: "unavailable", reason: "capacity", job: candidate };
      }
      if (candidate.branchKey !== undefined && running.some((job) => job.branchKey === candidate.branchKey)) {
        return { outcome: "unavailable", reason: "branch_conflict", job: candidate };
      }
      if (candidate.collisionKey !== undefined && running.some((job) => job.collisionKey === candidate.collisionKey)) {
        return { outcome: "unavailable", reason: "collision_conflict", job: candidate };
      }

      const claimed = LoopJobRecordSchema.parse({
        ...candidate,
        status: "running",
        startedAt: input.startedAt,
        endedAt: undefined,
        leaseExpiresAt: input.leaseExpiresAt,
        leaseOwnerId: input.leaseOwnerId,
        leaseToken: input.leaseToken,
        attempts: candidate.attempts + 1,
        resumeCheckpoint: input.resumeCheckpoint,
        updatedAt: input.startedAt,
        revision: nextRevision(candidate),
      });
      await this.replaceJobUnlocked(file, claimed);
      return { outcome: "claimed", previous: candidate, job: claimed };
    });
  }

  async remove(jobId: string): Promise<LoopJobRecord | undefined> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const removed = file.jobs.find((job) => job.jobId === jobId);
      if (removed === undefined) return undefined;
      await this.writeFileUnlocked({ ...file, jobs: file.jobs.filter((job) => job.jobId !== jobId), updatedAt: this.#clock.now() });
      return removed;
    });
  }

  async recoverStaleRunning(now: number = this.#clock.now()): Promise<LoopJobRecord[]> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const recovered: LoopJobRecord[] = [];
      const jobs = file.jobs.map((job) => {
        if (job.status !== "running" || job.leaseExpiresAt === undefined || job.leaseExpiresAt > now) return job;
        const resumeRunWaiting = isResumeRunWaitingJob(job);
        const recoveredJob = LoopJobRecordSchema.parse({
          ...job,
          status: resumeRunWaiting ? "needs_user" : "pending",
          startedAt: undefined,
          leaseExpiresAt: undefined,
          leaseOwnerId: undefined,
          leaseToken: undefined,
          updatedAt: now,
          revision: nextRevision(job),
          eventSummaries: appendEventSummary(job.eventSummaries, {
            summary: "Recovered stale running job after expired lease",
            receivedAt: now,
            source: "loop-coordinator",
          }),
        });
        recovered.push(recoveredJob);
        return recoveredJob;
      });

      if (recovered.length > 0) await this.writeFileUnlocked({ ...file, jobs, updatedAt: now });
      return recovered;
    });
  }

  async recoverRunningFromPriorIncarnation(leaseOwnerId: string, now: number = this.#clock.now()): Promise<LoopJobRecord[]> {
    return await this.withMutation(async () => {
      const file = await this.readFileUnlocked();
      const recovered: LoopJobRecord[] = [];
      const jobs = file.jobs.map((job) => {
        if (job.status !== "running" || job.leaseOwnerId === leaseOwnerId) return job;
        const resumeRunWaiting = isResumeRunWaitingJob(job);
        const recoveredJob = LoopJobRecordSchema.parse({
          ...job,
          status: resumeRunWaiting ? "needs_user" : "pending",
          startedAt: undefined,
          leaseExpiresAt: undefined,
          leaseOwnerId: undefined,
          leaseToken: undefined,
          updatedAt: now,
          revision: nextRevision(job),
          eventSummaries: appendEventSummary(job.eventSummaries, {
            summary: "Recovered running job owned by a prior process incarnation",
            receivedAt: now,
            source: "loop-coordinator",
          }),
        });
        recovered.push(recoveredJob);
        return recoveredJob;
      });

      if (recovered.length > 0) await this.writeFileUnlocked({ ...file, jobs, updatedAt: now });
      return recovered;
    });
  }

  async readFile(): Promise<LoopJobQueueFile> {
    return await this.withQueueLock(async () => await this.readFileUnlocked());
  }

  async queuePath(): Promise<string> {
    return await safeQueuePath(this.#workspaceRoot);
  }

  private async readFileUnlocked(): Promise<LoopJobQueueFile> {
    const filePath = await this.queuePath();
    const file = Bun.file(filePath);
    if (!(await file.exists())) return { version: 1, jobs: [], updatedAt: this.#clock.now() };
    if (file.size > this.#maxFileBytes) throw new LoopJobQueueLimitError("maxFileBytes", file.size);

    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch (error) {
      throw new LoopJobQueueParseError(filePath, error);
    }

    const result = LoopJobQueueFileSchema.safeParse(parsed);
    if (!result.success) throw new LoopJobQueueParseError(filePath, result.error);
    return result.data;
  }

  private async replaceJobUnlocked(file: LoopJobQueueFile, updated: LoopJobRecord): Promise<void> {
    const found = file.jobs.some((job) => job.jobId === updated.jobId);
    if (!found) throw new LoopJobNotFoundError(updated.jobId);
    await this.writeFileUnlocked({
      ...file,
      jobs: file.jobs.map((job) => job.jobId === updated.jobId ? updated : job),
      updatedAt: this.#clock.now(),
    });
  }

  private async writeFileUnlocked(file: LoopJobQueueFile): Promise<void> {
    const parsed = this.applyLimits(LoopJobQueueFileSchema.parse(file));
    const filePath = await this.queuePath();
    await atomicWrite(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  }

  private eventSummaryFromInput(input: LoopJobEventSummaryInput | undefined, fallbackReceivedAt: number): LoopJobEventSummary | undefined {
    if (input === undefined) return undefined;
    this.assertNoSecret("eventSummary.summary", input.summary);
    return LoopJobEventSummarySchema.parse({ ...input, receivedAt: input.receivedAt ?? fallbackReceivedAt });
  }

  private assertSafeUpdates(updates: LoopJobUpdateInput): void {
    if (updates.blockedReason !== undefined) this.assertNoSecret("blockedReason", updates.blockedReason);
    if (updates.cleanupWarning !== undefined) this.assertNoSecret("cleanupWarning", updates.cleanupWarning);
    for (const summary of updates.eventSummaries ?? []) this.assertNoSecret("eventSummary.summary", summary.summary);
  }

  private assertNoSecret(field: string, content: string): void {
    const detection = containsSecretPattern(content);
    if (detection.found) throw new LoopJobQueueSecurityError(field, `secret pattern detected: ${detection.patterns.join(", ")}`);
  }

  private applyLimits(file: LoopJobQueueFile): LoopJobQueueFile {
    if (file.jobs.length > this.#maxJobs) throw new LoopJobQueueLimitError("maxJobs", file.jobs.length);

    const terminalJobs = file.jobs.filter((job) => isTerminalStatus(job.status));
    if (terminalJobs.length <= this.#maxTerminalJobs) return file;

    const terminalToDrop = new Set(
      [...terminalJobs]
        .sort((left, right) => (left.endedAt ?? left.updatedAt) - (right.endedAt ?? right.updatedAt))
        .slice(0, terminalJobs.length - this.#maxTerminalJobs)
        .map((job) => job.jobId),
    );
    return LoopJobQueueFileSchema.parse({
      ...file,
      jobs: file.jobs.filter((job) => !terminalToDrop.has(job.jobId)),
    });
  }

  private async withMutation<T>(callback: () => Promise<T>): Promise<T> {
    return await this.withQueueLock(callback);
  }

  private async withQueueLock<T>(callback: () => Promise<T>): Promise<T> {
    return await withQueueLock(await this.queuePath(), callback);
  }
}

export function dedupeKeyFor(loopId: string, triggerKind: LoopRunTrigger, subjectKey: string): string {
  return `${loopId}:${triggerKind}:${subjectKey}`;
}

export function branchKeyFor(input: { readonly branchKey?: string; readonly repoId?: string; readonly branch?: string }): string | undefined {
  if (input.branchKey !== undefined) return input.branchKey;
  if (input.repoId !== undefined && input.branch !== undefined) return `${input.repoId}:${input.branch}`;
  return undefined;
}

export function collisionKeyFor(input: { readonly collisionKey?: string; readonly collisionTarget?: CollisionTarget }): string | undefined {
  if (input.collisionKey !== undefined) return input.collisionKey;
  if (input.collisionTarget !== undefined) return canonicalTargetKey(input.collisionTarget);
  return undefined;
}

export function isTerminalStatus(status: LoopJobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "skipped" || status === "expired";
}

function isOpenStatus(status: LoopJobStatus): boolean {
  return !isTerminalStatus(status) && status !== "blocked" && status !== "needs_user";
}

function isResumeRunWaitingJob(job: LoopJobRecord): boolean {
  const checkpoint = job.resumeCheckpoint;
  return checkpoint?.intendedContinuation === "resume_run"
    && job.blockedByHitlIds?.includes(checkpoint.hitlId) === true;
}

function mergeRerunInput(job: LoopJobRecord, input: EnqueueLoopJobInput): LoopJobRerunInput {
  const previous = job.rerunInput;
  return {
    priority: Math.max(previous?.priority ?? job.priority, input.priority ?? job.priority),
    branchKey: branchKeyFor(input) ?? previous?.branchKey ?? job.branchKey,
    collisionKey: collisionKeyFor(input) ?? previous?.collisionKey ?? job.collisionKey,
    collisionTarget: input.collisionTarget ?? previous?.collisionTarget ?? job.collisionTarget,
    baseSha: input.baseSha ?? previous?.baseSha ?? job.baseSha,
    resolvedHeadSha: input.resolvedHeadSha ?? previous?.resolvedHeadSha ?? job.resolvedHeadSha,
    missedCount: input.missedCount ?? previous?.missedCount ?? job.missedCount,
  };
}

function appendEventSummary(existing: readonly LoopJobEventSummary[], next: LoopJobEventSummary | undefined): LoopJobEventSummary[] {
  if (next === undefined) return [...existing];
  return [...existing, next].slice(-MAX_EVENT_SUMMARIES);
}

function priorityFifoCompare(left: LoopJobRecord, right: LoopJobRecord): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.queuedAt !== right.queuedAt) return left.queuedAt - right.queuedAt;
  return left.jobId.localeCompare(right.jobId);
}

function nextRevision(job: LoopJobRecord): number {
  return job.revision + 1;
}

function matchesExpectation(job: LoopJobRecord, expected: LoopJobUpdateExpectation): boolean {
  return job.status === expected.status
    && job.revision === expected.revision
    && job.leaseOwnerId === expected.leaseOwnerId
    && job.leaseToken === expected.leaseToken
    && job.resumeCheckpoint?.hitlId === expected.resumeCheckpoint?.hitlId;
}

function createPendingRerun(
  previousExecution: LoopJobRecord,
  queuedAt: number,
  eventSummary: LoopJobEventSummary | undefined,
): LoopJobRecord {
  const input = previousExecution.rerunInput;
  return LoopJobRecordSchema.parse({
    jobId: crypto.randomUUID(),
    loopId: previousExecution.loopId,
    status: "pending",
    triggerKind: previousExecution.triggerKind,
    subjectKey: previousExecution.subjectKey,
    dedupeKey: previousExecution.dedupeKey,
    branchKey: input?.branchKey ?? previousExecution.branchKey,
    collisionKey: input?.collisionKey ?? previousExecution.collisionKey,
    collisionTarget: input?.collisionTarget ?? previousExecution.collisionTarget,
    priority: input?.priority ?? previousExecution.priority,
    queuedAt,
    updatedAt: queuedAt,
    attempts: 0,
    baseSha: input?.baseSha ?? previousExecution.baseSha,
    resolvedHeadSha: input?.resolvedHeadSha ?? previousExecution.resolvedHeadSha,
    missedCount: input?.missedCount ?? previousExecution.missedCount,
    eventSummaries: appendEventSummary([], eventSummary),
  });
}

const queueLocks = new Map<string, Promise<void>>();

async function withQueueLock<T>(filePath: string, callback: () => Promise<T>): Promise<T> {
  const previous = queueLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  queueLocks.set(filePath, tail);

  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (queueLocks.get(filePath) === tail) queueLocks.delete(filePath);
  }
}

export function __queueLockCountForTest(): number {
  return queueLocks.size;
}

async function safeQueuePath(workspaceRoot: string): Promise<string> {
  const loopsRoot = resolve(workspaceRoot, PROJECT_STATE_DIR_NAME, "loops");
  await assertSafeLoopRoot(workspaceRoot, loopsRoot);
  await mkdir(loopsRoot, { recursive: true });
  const filePath = resolve(loopsRoot, "job-queue.json");
  if (!isContained(filePath, loopsRoot)) throw new LoopJobQueueSecurityError("path", "Path escapes the loops directory");
  return filePath;
}

async function assertSafeLoopRoot(workspaceRoot: string, loopsRoot: string): Promise<void> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  await assertExistingPathContained(resolve(workspaceRoot, PROJECT_STATE_DIR_NAME), realWorkspaceRoot);
  await assertExistingPathContained(loopsRoot, realWorkspaceRoot);
}

async function assertExistingPathContained(path: string, realWorkspaceRoot: string): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  if (!stat.isSymbolicLink()) return;

  const realPath = await realpath(path);
  if (!isContained(realPath, realWorkspaceRoot)) {
    throw new LoopJobQueueSecurityError("path", "Symlink resolves outside the workspace");
  }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
