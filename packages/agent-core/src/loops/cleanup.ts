import { lstat } from "node:fs/promises";

import type { CollisionLedger } from "./collision-ledger";
import type {
  SessionCwdReferenceMigrationInput,
  SessionCwdRemovalLifecycle,
  SessionCwdRemovalResult,
} from "../execution";
import { isTerminalStatus, type LoopJobQueue, type LoopJobRecord } from "./job-queue";
import { LoopWorktreeManager } from "./worktree-manager";
import type { LoopWorktreeCleanupResult, LoopWorktreeInspection, LoopWorktreeInspectionInput } from "./worktree-manager";
import type { LoopCleanupPolicy, LoopCleanupState, LoopIntegrationError, LoopJobStatus, LoopRunReport, LoopState, LoopWorktreeArtifact } from "./state";
import { LoopCleanupPolicySchema, LoopStateManager } from "./state";

export interface LoopCleanupClock {
  now(): number;
}

export interface LoopCleanupWorktreeManager {
  inspect(input: LoopWorktreeInspectionInput): Promise<LoopWorktreeInspection>;
  cleanup(input: {
    readonly inspection: LoopWorktreeInspection;
    readonly jobStatus?: LoopJobStatus;
    /** Must run after final safety validation and before the actual removal. */
    readonly beforeRemove?: () => Promise<void>;
    readonly onRemoveFailureBeforeDetach?: () => Promise<void>;
    readonly onRemoveDetached?: () => Promise<void>;
  }): Promise<LoopWorktreeCleanupResult>;
}

export interface LoopCleanupServiceOptions {
  readonly stateManager: LoopStateManager;
  readonly jobQueue: LoopJobQueue;
  readonly collisionLedger?: CollisionLedger;
  readonly worktreeManager?: LoopCleanupWorktreeManager;
  readonly workspaceRoot?: string;
  readonly clock?: LoopCleanupClock;
  /** Session-owned capability; Loop cleanup never scans or selects Session ids. */
  readonly migrateSessionCwdReferencesForRemoval?: <T extends SessionCwdRemovalResult>(
    input: SessionCwdReferenceMigrationInput,
    operation: (lifecycle: SessionCwdRemovalLifecycle) => Promise<T>,
  ) => Promise<T>;
}

export type LoopCleanupDecision = "disabled" | "no_action" | "cleanup_candidate" | "auto_paused" | "cleanup_failed";

export type LoopCleanupBlockerCode =
  | "open_job"
  | "pending_hitl"
  | "unreviewed_changed_worktree"
  | "integration_error"
  | "active_collision_lease"
  | "retention_threshold";

export interface LoopCleanupBlocker {
  readonly code: LoopCleanupBlockerCode;
  readonly message: string;
  readonly jobId?: string;
}

export interface NormalizedLoopCleanupPolicy {
  readonly enabled: boolean;
  readonly action: "mark" | "pause";
  readonly deleteUnchangedWorktrees: boolean;
  readonly preserveChangedArtifacts: true;
  readonly maxPreservedWorktrees?: number;
  readonly noFindingRuns: number;
  readonly quietDays: number;
  readonly requiresNoPendingQueue: boolean;
}

export interface LoopCleanupWorktreeResult {
  readonly jobId: string;
  readonly worktreePath: string;
  readonly cleanupState: LoopCleanupState;
  readonly removed: boolean;
  readonly reviewRequired: boolean;
  readonly reason: string;
  readonly cleanupWarning?: string;
}

export interface LoopCleanupScanResult {
  readonly loopId: string;
  readonly decision: LoopCleanupDecision;
  readonly blockers: LoopCleanupBlocker[];
  readonly worktrees: LoopCleanupWorktreeResult[];
}

const systemClock: LoopCleanupClock = { now: () => Date.now() };
const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_BLOCKED_REASONS = new Set(["review_required", "failed_with_changes", "expired_needs_review"]);
const OPEN_JOB_STATUSES = new Set<LoopJobStatus>(["pending", "queued", "running", "blocked", "needs_user"]);

export function normalizeLoopCleanupPolicy(policy: LoopCleanupPolicy | undefined): NormalizedLoopCleanupPolicy {
  const parsed = policy === undefined ? undefined : LoopCleanupPolicySchema.parse(policy);
  const explicitlyConfigured = parsed !== undefined;
  return {
    enabled: parsed?.enabled ?? (explicitlyConfigured && parsed?.deleteUnchangedWorktrees === true),
    action: parsed?.action ?? "mark",
    deleteUnchangedWorktrees: parsed?.deleteUnchangedWorktrees ?? false,
    preserveChangedArtifacts: true,
    ...(parsed?.maxPreservedWorktrees === undefined ? {} : { maxPreservedWorktrees: parsed.maxPreservedWorktrees }),
    noFindingRuns: parsed?.noFindingRuns ?? 3,
    quietDays: parsed?.quietDays ?? 7,
    requiresNoPendingQueue: parsed?.requiresNoPendingQueue ?? true,
  };
}

export class LoopCleanupService {
  readonly #stateManager: LoopStateManager;
  readonly #jobQueue: LoopJobQueue;
  readonly #collisionLedger?: CollisionLedger;
  readonly #worktreeManager?: LoopCleanupWorktreeManager;
  readonly #workspaceRoot?: string;
  readonly #migrateSessionCwdReferencesForRemoval?: LoopCleanupServiceOptions["migrateSessionCwdReferencesForRemoval"];
  readonly #clock: LoopCleanupClock;

  constructor(options: LoopCleanupServiceOptions) {
    this.#stateManager = options.stateManager;
    this.#jobQueue = options.jobQueue;
    this.#collisionLedger = options.collisionLedger;
    this.#worktreeManager = options.worktreeManager ?? (options.workspaceRoot === undefined ? undefined : new LoopWorktreeManager({ canonicalRoot: options.workspaceRoot }));
    this.#workspaceRoot = options.workspaceRoot;
    this.#migrateSessionCwdReferencesForRemoval = options.migrateSessionCwdReferencesForRemoval;
    this.#clock = options.clock ?? systemClock;
  }

  async scanLoop(loopId: string): Promise<LoopCleanupScanResult> {
    const loop = await this.#stateManager.read(loopId);
    const policy = normalizeLoopCleanupPolicy(loop.config.cleanupPolicy);
    if (!policy.enabled) return { loopId, decision: "disabled", blockers: [], worktrees: [] };

    const jobs = await this.#jobQueue.list();
    const loopJobs = jobs.filter((job) => job.loopId === loopId);
    const reports = await this.#stateManager.readRunLog(loopId);
    const blockers: LoopCleanupBlocker[] = [];
    const worktrees: LoopCleanupWorktreeResult[] = [];

    for (const job of loopJobs) {
      if (isBlockedJob(job)) {
        blockers.push(...blockersForOpenJob(job));
        continue;
      }
      if (job.worktreePath === undefined || job.baseSha === undefined) continue;

      const result = await this.#cleanupTerminalWorktree(job, reports, policy);
      worktrees.push(result);
      if (result.cleanupState === "cleanup_failed") {
        await this.#stateManager.update(loopId, { cleanupState: "cleanup_failed" });
        return { loopId, decision: "cleanup_failed", blockers, worktrees };
      }
      if (result.reviewRequired) blockers.push(reviewBlocker(job, result.reason));
    }

    blockers.push(...await this.#stateBlockers(loop, loopJobs));

    const dedupedBlockers = dedupeBlockers(blockers);
    if (dedupedBlockers.length > 0 || !retentionThresholdsPassed(loop, reports, policy, this.#clock.now())) {
      if (dedupedBlockers.length === 0) {
        dedupedBlockers.push({ code: "retention_threshold", message: "Loop cleanup retention thresholds have not been reached." });
      }
      return { loopId, decision: "no_action", blockers: dedupedBlockers, worktrees };
    }

    if (policy.action === "pause") {
      await this.#stateManager.update(loopId, { status: "paused", nextRunAt: undefined, cleanupState: "auto_paused" });
      return { loopId, decision: "auto_paused", blockers: [], worktrees };
    }

    await this.#stateManager.update(loopId, { cleanupState: "cleanup_candidate" });
    return { loopId, decision: "cleanup_candidate", blockers: [], worktrees };
  }

  async scanAll(projectId?: string): Promise<LoopCleanupScanResult[]> {
    const loops = await this.#stateManager.list(projectId);
    const results: LoopCleanupScanResult[] = [];
    for (const loop of loops) results.push(await this.scanLoop(loop.loopId));
    return results;
  }

  /** Executes or resumes one durable cleanup intent. Safe to call on startup. */
  async cleanupJob(jobId: string): Promise<LoopCleanupWorktreeResult | undefined> {
    const job = await this.#jobQueue.read(jobId);
    if (job.cleanupState !== "in_progress" && job.cleanupState !== "not_started") return undefined;
    if (job.worktreePath === undefined || job.baseSha === undefined) {
      const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
        cleanupState: "cleanup_failed",
        cleanupWarning: "Cleanup intent is missing durable worktree path or base SHA.",
      });
      if (update.outcome === "condition_mismatch") return changedDuringCleanupResult(job, update.job);
      return {
        jobId,
        worktreePath: job.worktreePath ?? "<missing>",
        cleanupState: "cleanup_failed",
        removed: false,
        reviewRequired: true,
        reason: "Cleanup intent is missing durable worktree path or base SHA.",
      };
    }
    const loop = await this.#stateManager.read(job.loopId);
    const reports = await this.#stateManager.readRunLog(job.loopId);
    return await this.#cleanupTerminalWorktree(job, reports, normalizeLoopCleanupPolicy(loop.config.cleanupPolicy));
  }

  async #cleanupTerminalWorktree(job: LoopJobRecord, reports: readonly LoopRunReport[], policy: NormalizedLoopCleanupPolicy): Promise<LoopCleanupWorktreeResult> {
    if (job.status === "blocked" || job.status === "needs_user") {
      const reason = job.blockedReason ?? job.status;
      const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
        cleanupState: "preserved",
        observedArtifacts: mergeArtifacts(job.observedArtifacts, [{ path: "cleanup:preserved", status: "observed" }]),
      });
      if (update.outcome === "condition_mismatch") return changedDuringCleanupResult(job, update.job);
      return preservedWorktreeResult(update.updated, reason);
    }

    if (job.status === "expired") {
      const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
        cleanupState: "expired_needs_review",
        blockedReason: "expired_needs_review",
        observedArtifacts: mergeArtifacts(job.observedArtifacts, [{ path: "cleanup:expired_needs_review", status: "observed" }]),
      });
      if (update.outcome === "condition_mismatch") return changedDuringCleanupResult(job, update.job);
      const updated = update.updated;
      return {
        jobId: job.jobId,
        worktreePath: job.worktreePath!,
        cleanupState: updated.cleanupState ?? "expired_needs_review",
        removed: false,
        reviewRequired: true,
        reason: "expired_needs_review",
      };
    }

    const manager = this.#worktreeManager;
    if (manager === undefined) return preservedWorktreeResult(job, "worktree manager unavailable");

    const report = reportForJob(reports, job.jobId);
    const branchName = job.worktreeBranchName
      ?? report?.worktreeBranchName
      ?? branchNameFromArtifacts(job.observedArtifacts ?? report?.observedArtifacts);
    if (branchName === undefined) return preservedWorktreeResult(job, "missing loop branch metadata");

    try {
      if (!await pathExists(job.worktreePath!)) {
        return await this.#completeAlreadyDetached(job, branchName);
      }
      const inspection = await manager.inspect({
        worktreePath: job.worktreePath!,
        branchName,
        baseSha: job.baseSha!,
        evidencePaths: evidencePaths(job.observedArtifacts),
      });
      if ((!policy.enabled || !policy.deleteUnchangedWorktrees) && !inspection.hasChanges && job.status !== "failed") {
        const cleanupState: LoopCleanupState = "preserved";
        const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
          cleanupState,
          observedArtifacts: observedArtifactsFromInspection(inspection, cleanupState),
        });
        if (update.outcome === "condition_mismatch") return changedDuringCleanupResult(job, update.job);
        return {
          jobId: job.jobId,
          worktreePath: inspection.worktreePath,
          cleanupState,
          removed: false,
          reviewRequired: false,
          reason: "unchanged worktree deletion disabled",
        };
      }
      const removalCandidate = !inspection.hasChanges
        && job.status !== "failed";
      let cleanup: LoopWorktreeCleanupResult;
      const migrate = this.#migrateSessionCwdReferencesForRemoval;
      const projectRoot = this.#workspaceRoot;
      if (migrate !== undefined && projectRoot !== undefined) {
        cleanup = await migrate({
          projectRoot,
          fromCwd: inspection.worktreePath,
          toCwd: projectRoot,
        }, async (lifecycle) => await manager.cleanup({
          inspection,
          jobStatus: job.status,
          ...lifecycle,
        }));
      } else {
        if (removalCandidate) {
          throw new Error(`Session cwd reference migration capability is required before removing Loop worktree ${inspection.worktreePath}.`);
        }
        cleanup = await manager.cleanup({ inspection, jobStatus: job.status });
      }
      const cleanupState = cleanup.cleanupState;
      const warning = cleanup.warning?.message;
      const artifacts = mergeArtifacts(
        observedArtifactsFromInspection(inspection, cleanupState),
        warning === undefined ? [] : [{ path: `cleanup:orphan-branch:${cleanup.warning!.branchName}`, status: "observed" }],
      );
      const reviewRequired = cleanup.reviewRequired;
      const blockedReason = reviewRequired ? blockedReasonForReview(job.status, cleanup.reason) : job.blockedReason;
      const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
        cleanupState,
        ...(warning === undefined ? { cleanupWarning: undefined } : { cleanupWarning: warning }),
        ...(blockedReason === undefined ? {} : { blockedReason }),
        observedArtifacts: artifacts,
      });
      if (update.outcome === "condition_mismatch") {
        return {
          ...changedDuringCleanupResult(job, update.job),
          cleanupState,
          removed: cleanup.removed,
          reviewRequired: true,
          reason: "Worktree cleanup completed, but the Loop job changed before its cleanup checkpoint could be recorded.",
        };
      }
      return {
        jobId: job.jobId,
        worktreePath: cleanup.worktreePath,
        cleanupState,
        removed: cleanup.removed,
        reviewRequired,
        reason: cleanup.reason,
        ...(warning === undefined ? {} : { cleanupWarning: warning }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
        cleanupState: "cleanup_failed",
        blockedReason: "cleanup_failed",
      });
      if (update.outcome === "condition_mismatch") return changedDuringCleanupResult(job, update.job, message);
      return {
        jobId: job.jobId,
        worktreePath: job.worktreePath!,
        cleanupState: "cleanup_failed",
        removed: false,
        reviewRequired: true,
        reason: message,
      };
    }
  }

  async #completeAlreadyDetached(job: LoopJobRecord, branchName: string): Promise<LoopCleanupWorktreeResult> {
    const migrate = this.#migrateSessionCwdReferencesForRemoval;
    const projectRoot = this.#workspaceRoot;
    if (migrate === undefined || projectRoot === undefined) {
      throw new Error(`Session cwd reference migration capability is required to reconcile detached Loop worktree ${job.worktreePath}.`);
    }
    await migrate({
      projectRoot,
      fromCwd: job.worktreePath!,
      toCwd: projectRoot,
    }, async (lifecycle) => {
      await lifecycle.beforeRemove();
      await lifecycle.onRemoveDetached();
      return { removed: true };
    });
    const warning = `Worktree path was already detached; orphan branch ${branchName} requires reconciliation.`;
    const update = await this.#jobQueue.updateIfCurrent(job.jobId, job, {
      cleanupState: "cleaned",
      cleanupWarning: warning,
      observedArtifacts: mergeArtifacts(job.observedArtifacts, [
        { path: "cleanup:cleaned", status: "observed" },
        { path: `cleanup:orphan-branch:${branchName}`, status: "observed" },
      ]),
    });
    if (update.outcome === "condition_mismatch") return changedDuringCleanupResult(job, update.job, warning);
    return {
      jobId: job.jobId,
      worktreePath: job.worktreePath!,
      cleanupState: "cleaned",
      removed: true,
      reviewRequired: false,
      reason: warning,
      cleanupWarning: warning,
    };
  }

  async #stateBlockers(loop: LoopState, jobs: readonly LoopJobRecord[]): Promise<LoopCleanupBlocker[]> {
    const blockers: LoopCleanupBlocker[] = [];
    if (loop.currentRun?.status === "running") {
      blockers.push({ code: "open_job", message: "Loop has a running current run.", jobId: loop.currentRun.jobId });
    }
    for (const job of jobs) {
      if (isBlockedJob(job)) blockers.push(...blockersForOpenJob(job));
      if (job.cleanupState === "preserved" || job.cleanupState === "expired_needs_review" || REVIEW_BLOCKED_REASONS.has(job.blockedReason ?? "")) {
        blockers.push(reviewBlocker(job, job.blockedReason ?? job.cleanupState ?? "review required"));
      }
    }
    for (const error of loop.latestIntegrations?.errors ?? []) {
      if (integrationNeedsAttention(error)) blockers.push({ code: "integration_error", message: error.reason });
    }
    for (const lease of await this.#collisionLedger?.readActiveLeases() ?? []) {
      if (lease.loopId === loop.loopId) blockers.push({ code: "active_collision_lease", message: `Active collision lease: ${lease.targetKey}` });
    }
    return blockers;
  }
}

function isBlockedJob(job: LoopJobRecord): boolean {
  return OPEN_JOB_STATUSES.has(job.status);
}

function blockersForOpenJob(job: LoopJobRecord): LoopCleanupBlocker[] {
  const blockers: LoopCleanupBlocker[] = [{ code: "open_job", message: `Loop job ${job.jobId} is ${job.status}.`, jobId: job.jobId }];
  if (job.status === "blocked" || job.status === "needs_user" || job.blockedReason === "needs_user") {
    blockers.push({ code: "pending_hitl", message: `Loop job ${job.jobId} is waiting for human input.`, jobId: job.jobId });
  }
  return blockers;
}

function reviewBlocker(job: LoopJobRecord, reason: string): LoopCleanupBlocker {
  return { code: "unreviewed_changed_worktree", message: reason, jobId: job.jobId };
}

function integrationNeedsAttention(error: LoopIntegrationError): boolean {
  return error.reason === "integration_auth_missing" || error.reason === "integration_rate_limited";
}

function retentionThresholdsPassed(
  loop: LoopState,
  reports: readonly LoopRunReport[],
  policy: NormalizedLoopCleanupPolicy,
  now: number,
): boolean {
  if (policy.requiresNoPendingQueue && loop.currentRun?.status === "running") return false;
  if (policy.noFindingRuns > 0 && successfulQuietReports(reports) < policy.noFindingRuns) return false;
  if (policy.quietDays > 0) {
    const lastEndedAt = reports[0]?.endedAt ?? loop.updatedAt;
    if (now - lastEndedAt < policy.quietDays * DAY_MS) return false;
  }
  return true;
}

function successfulQuietReports(reports: readonly LoopRunReport[]): number {
  let count = 0;
  for (const report of reports) {
    if (report.status !== "succeeded") break;
    if (hasChangedArtifact(report.observedArtifacts)) break;
    count += 1;
  }
  return count;
}

function hasChangedArtifact(artifacts: readonly LoopWorktreeArtifact[] | undefined): boolean {
  return (artifacts ?? []).some((artifact) => artifact.status === "created" || artifact.status === "modified" || artifact.status === "deleted");
}

function reportForJob(reports: readonly LoopRunReport[], jobId: string): LoopRunReport | undefined {
  return reports.find((report) => report.jobId === jobId);
}

function branchNameFromArtifacts(artifacts: readonly LoopWorktreeArtifact[] | undefined): string | undefined {
  const prefix = "git:branch:";
  return artifacts?.find((artifact) => artifact.path.startsWith(prefix))?.path.slice(prefix.length);
}

function evidencePaths(artifacts: readonly LoopWorktreeArtifact[] | undefined): string[] {
  return (artifacts ?? [])
    .map((artifact) => artifact.path)
    .filter((path) => !path.startsWith("git:") && !path.startsWith("cleanup:"));
}

function observedArtifactsFromInspection(inspection: LoopWorktreeInspection, cleanupState: LoopCleanupState): LoopWorktreeArtifact[] {
  const artifacts = new Map<string, LoopWorktreeArtifact>();
  for (const artifact of inspection.evidenceArtifacts) artifacts.set(artifact.path, artifact);
  for (const path of inspection.untrackedFiles) {
    if (!artifacts.has(path)) artifacts.set(path, { path, status: "created" });
  }
  if (inspection.diffStats.committed.trim().length > 0) artifacts.set("git:committed-diff", { path: "git:committed-diff", status: "observed" });
  if (inspection.diffStats.workingTree.trim().length > 0) artifacts.set("git:working-tree-diff", { path: "git:working-tree-diff", status: "observed" });
  if (inspection.localCommitsAhead > 0) artifacts.set(`git:local-commits-ahead:${inspection.localCommitsAhead}`, { path: `git:local-commits-ahead:${inspection.localCommitsAhead}`, status: "observed" });
  artifacts.set(`git:branch:${inspection.branchName}`, { path: `git:branch:${inspection.branchName}`, status: "observed" });
  artifacts.set(`cleanup:${cleanupState}`, { path: `cleanup:${cleanupState}`, status: "observed" });
  return [...artifacts.values()].slice(0, 100);
}

function mergeArtifacts(existing: readonly LoopWorktreeArtifact[] | undefined, next: readonly LoopWorktreeArtifact[]): LoopWorktreeArtifact[] {
  const artifacts = new Map<string, LoopWorktreeArtifact>();
  for (const artifact of existing ?? []) artifacts.set(artifact.path, artifact);
  for (const artifact of next) artifacts.set(artifact.path, artifact);
  return [...artifacts.values()].slice(0, 100);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function blockedReasonForReview(status: LoopJobStatus, cleanupReason: string): string {
  if (status === "failed") return "failed_with_changes";
  if (status === "expired") return "expired_needs_review";
  return cleanupReason.includes("change") ? "review_required" : cleanupReason;
}

function preservedWorktreeResult(job: LoopJobRecord, reason: string): LoopCleanupWorktreeResult {
  return {
    jobId: job.jobId,
    worktreePath: job.worktreePath ?? "",
    cleanupState: job.cleanupState ?? "preserved",
    removed: false,
    reviewRequired: true,
    reason,
  };
}

function changedDuringCleanupResult(
  original: LoopJobRecord,
  current: LoopJobRecord,
  cause?: string,
): LoopCleanupWorktreeResult {
  const cleanupState = current.cleanupState ?? "preserved";
  return {
    jobId: current.jobId,
    worktreePath: current.worktreePath ?? original.worktreePath ?? "",
    cleanupState,
    removed: cleanupState === "cleaned",
    reviewRequired: cleanupState !== "cleaned",
    reason: `Loop job changed during cleanup; preserved the newer revision.${cause === undefined ? "" : ` Original cleanup error: ${cause}`}`,
  };
}

function dedupeBlockers(blockers: readonly LoopCleanupBlocker[]): LoopCleanupBlocker[] {
  const byKey = new Map<string, LoopCleanupBlocker>();
  for (const blocker of blockers) byKey.set(`${blocker.code}:${blocker.jobId ?? "loop"}:${blocker.message}`, blocker);
  return [...byKey.values()];
}

export function isLoopCleanupTerminalStatus(status: LoopJobStatus): boolean {
  return isTerminalStatus(status) || status === "blocked" || status === "needs_user";
}
