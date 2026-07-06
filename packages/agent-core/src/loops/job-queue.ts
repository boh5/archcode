import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod/v4";

import { containsSecretPattern } from "../security/patterns";
import { atomicWrite, isContained } from "../utils/safe-file";
import { canonicalTargetKey } from "./collision-ledger";
import {
  CollisionTargetSchema,
  LoopCleanupStateSchema,
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
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly attempts: number;
  readonly rerunAfterCurrent?: boolean;
  readonly blockedReason?: string;
  readonly worktreePath?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly missedCount?: number;
  readonly cleanupState?: z.infer<typeof LoopCleanupStateSchema>;
  readonly observedArtifacts?: LoopWorktreeArtifact[];
  readonly eventSummaries: LoopJobEventSummary[];
  readonly leaseExpiresAt?: number;
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

export type LoopJobUpdateInput = Partial<Omit<LoopJobRecord, "jobId" | "dedupeKey" | "queuedAt">>;

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
  startedAt: TimestampMsSchema.optional(),
  endedAt: TimestampMsSchema.optional(),
  attempts: z.number().int().nonnegative(),
  rerunAfterCurrent: z.boolean().optional(),
  blockedReason: z.string().trim().min(1).max(20_000).optional(),
  worktreePath: z.string().trim().min(1).max(10_000).optional(),
  baseSha: z.string().trim().min(1).max(128).optional(),
  resolvedHeadSha: z.string().trim().min(1).max(128).optional(),
  missedCount: z.number().int().nonnegative().optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
  observedArtifacts: z.array(LoopWorktreeArtifactSchema).max(100).optional(),
  eventSummaries: z.array(LoopJobEventSummarySchema).max(MAX_EVENT_SUMMARIES),
  leaseExpiresAt: TimestampMsSchema.optional(),
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

      if (duplicate !== undefined && waitingStatuses.has(duplicate.status)) {
        const updated = LoopJobRecordSchema.parse({
          ...duplicate,
          priority: Math.max(duplicate.priority, input.priority ?? duplicate.priority),
          branchKey: branchKeyFor(input) ?? duplicate.branchKey,
          collisionKey: collisionKeyFor(input) ?? duplicate.collisionKey,
          collisionTarget: input.collisionTarget ?? duplicate.collisionTarget,
          worktreePath: input.worktreePath ?? duplicate.worktreePath,
          baseSha: input.baseSha ?? duplicate.baseSha,
          resolvedHeadSha: input.resolvedHeadSha ?? duplicate.resolvedHeadSha,
          missedCount: input.missedCount ?? duplicate.missedCount,
          updatedAt: now,
          eventSummaries: appendEventSummary(duplicate.eventSummaries, eventSummary),
        });
        await this.replaceJobUnlocked(file, updated);
        return { job: updated, created: false, coalesced: true, rerunAfterCurrent: false };
      }

      if (duplicate !== undefined && duplicate.status === "running") {
        const updated = LoopJobRecordSchema.parse({
          ...duplicate,
          rerunAfterCurrent: true,
          branchKey: branchKeyFor(input) ?? duplicate.branchKey,
          collisionKey: collisionKeyFor(input) ?? duplicate.collisionKey,
          collisionTarget: input.collisionTarget ?? duplicate.collisionTarget,
          worktreePath: input.worktreePath ?? duplicate.worktreePath,
          baseSha: input.baseSha ?? duplicate.baseSha,
          resolvedHeadSha: input.resolvedHeadSha ?? duplicate.resolvedHeadSha,
          missedCount: input.missedCount ?? duplicate.missedCount,
          updatedAt: now,
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
      });
      await this.replaceJobUnlocked(file, updated);
      return updated;
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
        const recoveredJob = LoopJobRecordSchema.parse({
          ...job,
          status: "pending",
          startedAt: undefined,
          leaseExpiresAt: undefined,
          rerunAfterCurrent: undefined,
          updatedAt: now,
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

function appendEventSummary(existing: readonly LoopJobEventSummary[], next: LoopJobEventSummary | undefined): LoopJobEventSummary[] {
  if (next === undefined) return [...existing];
  return [...existing, next].slice(-MAX_EVENT_SUMMARIES);
}

const queueLocks = new Map<string, Promise<void>>();

async function withQueueLock<T>(filePath: string, callback: () => Promise<T>): Promise<T> {
  const previous = queueLocks.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queueLocks.set(filePath, previous.then(() => current, () => current));

  await previous.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (queueLocks.get(filePath) === current) queueLocks.delete(filePath);
  }
}

async function safeQueuePath(workspaceRoot: string): Promise<string> {
  const loopsRoot = resolve(workspaceRoot, ".archcode", "loops");
  await assertSafeLoopRoot(workspaceRoot, loopsRoot);
  await mkdir(loopsRoot, { recursive: true });
  const filePath = resolve(loopsRoot, "job-queue.json");
  if (!isContained(filePath, loopsRoot)) throw new LoopJobQueueSecurityError("path", "Path escapes the loops directory");
  return filePath;
}

async function assertSafeLoopRoot(workspaceRoot: string, loopsRoot: string): Promise<void> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  await assertExistingPathContained(resolve(workspaceRoot, ".archcode"), realWorkspaceRoot);
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
