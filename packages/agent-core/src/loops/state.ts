import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";

import { z } from "zod/v4";
import type {
  LoopApprovalPolicy as ProtocolLoopApprovalPolicy,
  LoopBudgetConfig as ProtocolLoopBudgetConfig,
  LoopBudgetSnapshot as ProtocolLoopBudgetSnapshot,
  LoopBudgetUsage as ProtocolLoopBudgetUsage,
  CollisionConflict as ProtocolCollisionConflict,
  CollisionLease as ProtocolCollisionLease,
  CollisionTarget as ProtocolCollisionTarget,
  LoopConfig as ProtocolLoopConfig,
  LoopCleanupPolicy as ProtocolLoopCleanupPolicy,
  LoopCleanupState as ProtocolLoopCleanupState,
  LoopCoordinatorConfig as ProtocolLoopCoordinatorConfig,
  LoopGoalTemplate as ProtocolLoopGoalTemplate,
  LoopIntegrationError as ProtocolLoopIntegrationError,
  LoopIntegrationSnapshot as ProtocolLoopIntegrationSnapshot,
  LoopJobStatus as ProtocolLoopJobStatus,
  LoopJobSummary as ProtocolLoopJobSummary,
  LoopCollisionSnapshot as ProtocolLoopCollisionSnapshot,
  LoopLimits as ProtocolLoopLimits,
  LoopMode as ProtocolLoopMode,
  LoopProjectConfig as ProtocolLoopProjectConfig,
  LoopPullRequestScope as ProtocolLoopPullRequestScope,
  LoopRunKind as ProtocolLoopRunKind,
  LoopRunReason as ProtocolLoopRunReason,
  LoopRunReport as ProtocolLoopRunReport,
  LoopRunReportStatus as ProtocolLoopRunReportStatus,
  LoopRunTrigger as ProtocolLoopRunTrigger,
  LoopScheduleSpec as ProtocolLoopScheduleSpec,
  LoopState as ProtocolLoopState,
  LoopStatus as ProtocolLoopStatus,
  LoopToolProfileId as ProtocolLoopToolProfileId,
  LoopTriggerHealth as ProtocolLoopTriggerHealth,
  LoopTriggerSpec as ProtocolLoopTriggerSpec,
  LoopWorktreeArtifact as ProtocolLoopWorktreeArtifact,
} from "@archcode/protocol";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";

const LoopTitleSchema = z.string().trim().min(1).max(200);
const LoopTextSchema = z.string().trim().min(1).max(10_000);
const LoopIdentifierSchema = z.string().trim().min(1).max(200);
const TimestampMsSchema = z.number().int().nonnegative();
const ShaSchema = z.string().trim().min(1).max(128);
const TriggerCadenceMsSchema = z.number().int().min(30_000).default(60_000);
const CronExpressionSchema = z.string().trim().refine((value) => value.split(/\s+/).length === 5, {
  message: "Cron expressions must use exactly 5 UTC fields",
});

export const LoopUuidSchema = z.uuid();

export const LoopStatusSchema = z.enum(["active", "paused", "disabled", "error"]);

export const LoopScheduleSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({ kind: z.literal("interval"), everyMs: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("cron"), expression: CronExpressionSchema }),
]) satisfies z.ZodType<ProtocolLoopScheduleSpec>;

export const LoopPullRequestScopeSchema = z.enum(["open", "authored", "assigned", "review_requested"]) satisfies z.ZodType<ProtocolLoopPullRequestScope>;

export const LoopTriggerSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("on_commit"),
    branch: LoopIdentifierSchema.optional(),
    cadenceMs: TriggerCadenceMsSchema,
  }),
  z.strictObject({
    kind: z.literal("on_pr"),
    branch: LoopIdentifierSchema.optional(),
    baseBranch: LoopIdentifierSchema.optional(),
    prScope: LoopPullRequestScopeSchema.optional(),
    cadenceMs: TriggerCadenceMsSchema,
  }),
  z.strictObject({
    kind: z.literal("on_ci_fail"),
    branch: LoopIdentifierSchema.optional(),
    baseBranch: LoopIdentifierSchema.optional(),
    checkName: LoopIdentifierSchema.optional(),
    workflowName: LoopIdentifierSchema.optional(),
    cadenceMs: TriggerCadenceMsSchema,
  }),
]) satisfies z.ZodType<ProtocolLoopTriggerSpec>;

export const LoopCoordinatorConfigSchema = z.preprocess((value) => {
  if (value === undefined) return { maxConcurrent: 2 };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return { ...record, maxConcurrent: record.maxConcurrent ?? 2 };
}, z.strictObject({
  maxConcurrent: z.number().int().positive().default(2),
})) satisfies z.ZodType<ProtocolLoopCoordinatorConfig>;

export const LoopProjectConfigSchema = z.preprocess((value) => {
  if (value === undefined) return { coordinator: { maxConcurrent: 2 } };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return { ...record, coordinator: record.coordinator ?? { maxConcurrent: 2 } };
}, z.strictObject({
  coordinator: LoopCoordinatorConfigSchema,
})) satisfies z.ZodType<ProtocolLoopProjectConfig>;

export const LoopRunKindSchema = z.enum(["session", "goal"]);
export const LoopModeSchema = z.enum(["report", "act"]);
export const LoopApprovalPolicySchema = z.enum(["interactive", "explicit_per_run"]);

const BudgetThresholdRatioSchema = z.number().min(0).max(1);

export const LoopBudgetConfigSchema = z.preprocess((value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    softThresholdRatio: record.softThresholdRatio ?? 0.8,
    hardThresholdRatio: record.hardThresholdRatio ?? 1.0,
  };
}, z.strictObject({
  maxIterationsPerRun: z.number().int().positive(),
  maxTokensPerRun: z.number().int().positive().optional(),
  maxEstimatedUsdPerRun: z.number().positive().optional(),
  maxWallClockMsPerRun: z.number().int().positive().optional(),
  maxRunsPerDay: z.number().int().positive().optional(),
  softThresholdRatio: BudgetThresholdRatioSchema,
  hardThresholdRatio: BudgetThresholdRatioSchema,
})) satisfies z.ZodType<ProtocolLoopBudgetConfig>;

export const LoopLimitsSchema = LoopBudgetConfigSchema satisfies z.ZodType<ProtocolLoopLimits>;

export const LoopBudgetUsageSchema = z.strictObject({
  iterations: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  estimatedUsd: z.number().nonnegative().optional(),
  wallClockMs: z.number().int().nonnegative(),
  runsToday: z.number().int().nonnegative(),
  resetDateUtc: z.iso.date(),
  pricingUnavailable: z.boolean().optional(),
}) satisfies z.ZodType<ProtocolLoopBudgetUsage>;

export const LoopRunReasonSchema = z.enum([
  "completed",
  "soft_budget_blocked",
  "hard_budget_exceeded",
  "collision_conflict",
  "cancelled_by_user",
  "global_kill_active",
  "loop_paused",
  "integration_auth_missing",
  "integration_rate_limited",
  "execution_failed",
  "max_steps_reached",
  "scheduler_overlap",
]) satisfies z.ZodType<ProtocolLoopRunReason>;

export const LoopToolProfileIdSchema = z.enum([
  "loop_local_report",
  "loop_local_maintenance",
  "loop_github_pr_watch",
  "loop_ci_watch",
  "loop_goal_action",
]) satisfies z.ZodType<ProtocolLoopToolProfileId>;

export const CollisionTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pr"), owner: LoopIdentifierSchema, repo: LoopIdentifierSchema, number: z.number().int().positive() }),
  z.strictObject({ type: z.literal("issue"), owner: LoopIdentifierSchema, repo: LoopIdentifierSchema, number: z.number().int().positive() }),
  z.strictObject({ type: z.literal("branch"), owner: LoopIdentifierSchema, repo: LoopIdentifierSchema, branch: LoopIdentifierSchema }),
  z.strictObject({ type: z.literal("file"), path: LoopTextSchema }),
]) satisfies z.ZodType<ProtocolCollisionTarget>;

export const CollisionLeaseSchema = z.strictObject({
  targetKey: LoopIdentifierSchema,
  target: CollisionTargetSchema,
  loopId: LoopUuidSchema,
  runId: LoopIdentifierSchema,
  actionId: LoopIdentifierSchema.optional(),
  toolCallId: LoopIdentifierSchema.optional(),
  priority: z.number().int(),
  createdAt: TimestampMsSchema,
  expiresAt: TimestampMsSchema,
}) satisfies z.ZodType<ProtocolCollisionLease>;

export const CollisionConflictSchema = z.strictObject({
  targetKey: LoopIdentifierSchema,
  target: CollisionTargetSchema,
  conflictingLease: CollisionLeaseSchema,
  detectedAt: TimestampMsSchema,
}) satisfies z.ZodType<ProtocolCollisionConflict>;

export const LoopIntegrationErrorSchema = z.strictObject({
  integrationId: z.enum(["github", "github_actions"]),
  reason: z.enum(["integration_auth_missing", "integration_rate_limited"]),
  message: z.string().trim().min(1).max(20_000),
  retryAfterMs: z.number().int().positive().optional(),
  occurredAt: TimestampMsSchema,
}) satisfies z.ZodType<ProtocolLoopIntegrationError>;

export const LoopBudgetSnapshotSchema = z.strictObject({
  budget: LoopBudgetConfigSchema.optional(),
  usage: LoopBudgetUsageSchema,
  updatedAt: TimestampMsSchema,
}) satisfies z.ZodType<ProtocolLoopBudgetSnapshot>;

export const LoopCollisionSnapshotSchema = z.strictObject({
  targets: z.array(CollisionTargetSchema).max(100),
  activeLeases: z.array(CollisionLeaseSchema).max(100),
  conflicts: z.array(CollisionConflictSchema).max(100),
  updatedAt: TimestampMsSchema,
}) satisfies z.ZodType<ProtocolLoopCollisionSnapshot>;

export const LoopIntegrationSnapshotSchema = z.strictObject({
  errors: z.array(LoopIntegrationErrorSchema).max(100),
  updatedAt: TimestampMsSchema,
}) satisfies z.ZodType<ProtocolLoopIntegrationSnapshot>;

export const LoopGoalTemplateSchema = z.strictObject({
  title: LoopTitleSchema,
  objective: LoopTextSchema,
  acceptanceCriteria: LoopTextSchema,
}) satisfies z.ZodType<ProtocolLoopGoalTemplate>;

export const LoopCleanupStateSchema = z.enum([
  "not_started",
  "in_progress",
  "cleaned",
  "preserved",
  "failed",
  "skipped",
  "cleanup_candidate",
  "auto_paused",
  "cleanup_failed",
  "expired_needs_review",
]) satisfies z.ZodType<ProtocolLoopCleanupState>;

export const LoopCleanupPolicySchema = z.strictObject({
  enabled: z.boolean().optional(),
  action: z.enum(["mark", "pause"]).optional(),
  deleteUnchangedWorktrees: z.boolean().optional(),
  preserveChangedArtifacts: z.literal(true).optional(),
  maxPreservedWorktrees: z.number().int().nonnegative().optional(),
  noFindingRuns: z.number().int().nonnegative().optional(),
  quietDays: z.number().nonnegative().optional(),
  requiresNoPendingQueue: z.boolean().optional(),
}) satisfies z.ZodType<ProtocolLoopCleanupPolicy>;

export const LoopWorktreeArtifactSchema = z.strictObject({
  path: LoopTextSchema,
  status: z.enum(["observed", "unchanged", "created", "modified", "deleted"]),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha: ShaSchema.optional(),
}) satisfies z.ZodType<ProtocolLoopWorktreeArtifact>;

export const LoopRunReportStatusSchema = z.enum(["running", "succeeded", "failed", "skipped", "cancelled", "budget_exceeded", "needs_user"]);
export const LoopRunTriggerSchema = z.enum(["manual", "interval", "cron", "on_commit", "on_pr", "on_ci_fail"]);

export const LoopHitlCheckpointSchema = z.strictObject({
  version: z.literal(1),
  hitlId: LoopIdentifierSchema,
  loopId: LoopUuidSchema,
  runId: LoopIdentifierSchema,
  jobId: LoopIdentifierSchema.optional(),
  trigger: LoopRunTriggerSchema,
  subjectKey: LoopIdentifierSchema.optional(),
  worktreePath: LoopTextSchema.optional(),
  baseSha: ShaSchema.optional(),
  resolvedHeadSha: ShaSchema.optional(),
  intendedContinuation: z.enum(["rerun_job", "resume_run"]),
});

export const LoopJobStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "blocked",
  "needs_user",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
  "expired",
]) satisfies z.ZodType<ProtocolLoopJobStatus>;

export const LoopJobSummarySchema = z.strictObject({
  jobId: LoopIdentifierSchema,
  loopId: LoopIdentifierSchema,
  status: LoopJobStatusSchema,
  triggerKind: z.enum(["manual", "interval", "cron", "on_commit", "on_pr", "on_ci_fail"]),
  subjectKey: LoopIdentifierSchema,
  dedupeKey: LoopIdentifierSchema,
  branchKey: LoopIdentifierSchema.optional(),
  queuedAt: TimestampMsSchema,
  startedAt: TimestampMsSchema.optional(),
  endedAt: TimestampMsSchema.optional(),
  attempts: z.number().int().nonnegative(),
  rerunAfterCurrent: z.boolean().optional(),
  blockedReason: LoopTextSchema.optional(),
  blockedByHitlIds: z.array(LoopIdentifierSchema).optional(),
  attentionStatus: z.enum(["clear", "waiting_for_human"]).optional(),
  resumeCheckpoint: LoopHitlCheckpointSchema.optional(),
  worktreePath: LoopTextSchema.optional(),
  baseSha: ShaSchema.optional(),
  resolvedHeadSha: ShaSchema.optional(),
  missedCount: z.number().int().nonnegative().optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
  observedArtifacts: z.array(LoopWorktreeArtifactSchema).max(100).optional(),
}) satisfies z.ZodType<ProtocolLoopJobSummary>;

export const LoopTriggerHealthSchema = z.strictObject({
  triggerKind: z.enum(["manual", "interval", "cron", "on_commit", "on_pr", "on_ci_fail"]),
  status: z.enum(["healthy", "degraded", "blocked", "disabled"]),
  cadenceMs: TriggerCadenceMsSchema.optional(),
  lastCheckedAt: TimestampMsSchema.optional(),
  lastSuccessAt: TimestampMsSchema.optional(),
  lastError: z.string().max(20_000).optional(),
  retryAfterMs: z.number().int().positive().optional(),
  missedCount: z.number().int().nonnegative().optional(),
}) satisfies z.ZodType<ProtocolLoopTriggerHealth>;

export const LoopConfigSchema: z.ZodType<ProtocolLoopConfig> = z.strictObject({
  title: LoopTitleSchema,
  description: LoopTextSchema.optional(),
  schedule: LoopScheduleSpecSchema,
  runKind: LoopRunKindSchema,
  mode: LoopModeSchema,
  approvalPolicy: LoopApprovalPolicySchema,
  limits: LoopLimitsSchema,
  budget: LoopBudgetConfigSchema.optional(),
  toolProfileId: LoopToolProfileIdSchema.optional(),
  collisionTargets: z.array(CollisionTargetSchema).max(100).optional(),
  taskPrompt: LoopTextSchema.optional(),
  instructions: LoopTextSchema.optional(),
  goalTemplate: LoopGoalTemplateSchema.optional(),
  sourcePreset: LoopIdentifierSchema.optional(),
  triggers: z.array(LoopTriggerSpecSchema).max(50).optional(),
  cleanupPolicy: LoopCleanupPolicySchema.optional(),
});

export const LoopRunReportSchema = z.strictObject({
  runId: LoopIdentifierSchema,
  loopId: LoopUuidSchema,
  status: LoopRunReportStatusSchema,
  trigger: LoopRunTriggerSchema,
  startedAt: TimestampMsSchema,
  endedAt: TimestampMsSchema.optional(),
  reason: LoopRunReasonSchema.optional(),
  budgetUsage: LoopBudgetUsageSchema.optional(),
  collisionTargets: z.array(CollisionTargetSchema).max(100).optional(),
  collisionConflicts: z.array(CollisionConflictSchema).max(100).optional(),
  integrationErrors: z.array(LoopIntegrationErrorSchema).max(100).optional(),
  toolProfileId: LoopToolProfileIdSchema.optional(),
  sessionId: LoopIdentifierSchema.optional(),
  goalId: LoopIdentifierSchema.optional(),
  summary: LoopTextSchema.optional(),
  error: z.string().max(20_000).optional(),
  skippedReason: LoopTextSchema.optional(),
  jobId: LoopIdentifierSchema.optional(),
  triggerKind: LoopRunTriggerSchema.optional(),
  subjectKey: LoopIdentifierSchema.optional(),
  dedupeKey: LoopIdentifierSchema.optional(),
  branchKey: LoopIdentifierSchema.optional(),
  worktreePath: LoopTextSchema.optional(),
  baseSha: ShaSchema.optional(),
  resolvedHeadSha: ShaSchema.optional(),
  missedCount: z.number().int().nonnegative().optional(),
  blockedReason: LoopTextSchema.optional(),
  blockedByHitlIds: z.array(LoopIdentifierSchema).optional(),
  attentionStatus: z.enum(["clear", "waiting_for_human"]).optional(),
  resumeCheckpoint: LoopHitlCheckpointSchema.optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
  observedArtifacts: z.array(LoopWorktreeArtifactSchema).max(100).optional(),
}) satisfies z.ZodType<ProtocolLoopRunReport>;

export const LoopStateSchema = z.strictObject({
  loopId: LoopUuidSchema,
  projectId: LoopIdentifierSchema,
  config: LoopConfigSchema,
  status: LoopStatusSchema,
  createdAt: TimestampMsSchema,
  updatedAt: TimestampMsSchema,
  lastRun: LoopRunReportSchema.optional(),
  currentRun: LoopRunReportSchema.optional(),
  nextRunAt: TimestampMsSchema.optional(),
  lastScheduledAt: TimestampMsSchema.optional(),
  nextScheduledAt: TimestampMsSchema.optional(),
  lastEnqueuedAt: TimestampMsSchema.optional(),
  missedCount: z.number().int().nonnegative().optional(),
  runCount: z.number().int().nonnegative(),
  stateVersion: z.number().int().positive(),
  generatedStateSummary: z.string().max(20_000).optional(),
  readinessScore: z.null().optional(),
  latestBudget: LoopBudgetSnapshotSchema.optional(),
  latestCollisions: LoopCollisionSnapshotSchema.optional(),
  latestIntegrations: LoopIntegrationSnapshotSchema.optional(),
  currentJob: LoopJobSummarySchema.optional(),
  queuedJobs: z.array(LoopJobSummarySchema).max(100).optional(),
  blockedByHitlIds: z.array(LoopIdentifierSchema).optional(),
  attentionStatus: z.enum(["clear", "waiting_for_human"]).optional(),
  resumeCheckpoint: LoopHitlCheckpointSchema.optional(),
  triggerHealth: z.array(LoopTriggerHealthSchema).max(50).optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
}) satisfies z.ZodType<ProtocolLoopState>;

export type LoopStatus = ProtocolLoopStatus;
export type LoopScheduleSpec = ProtocolLoopScheduleSpec;
export type LoopPullRequestScope = ProtocolLoopPullRequestScope;
export type LoopTriggerSpec = ProtocolLoopTriggerSpec;
export type LoopCoordinatorConfig = ProtocolLoopCoordinatorConfig;
export type LoopProjectConfig = ProtocolLoopProjectConfig;
export type LoopRunKind = ProtocolLoopRunKind;
export type LoopMode = ProtocolLoopMode;
export type LoopApprovalPolicy = ProtocolLoopApprovalPolicy;
export type LoopBudgetConfig = ProtocolLoopBudgetConfig;
export type LoopBudgetUsage = ProtocolLoopBudgetUsage;
export type LoopRunReason = ProtocolLoopRunReason;
export type LoopToolProfileId = ProtocolLoopToolProfileId;
export type CollisionTarget = ProtocolCollisionTarget;
export type CollisionLease = ProtocolCollisionLease;
export type CollisionConflict = ProtocolCollisionConflict;
export type LoopIntegrationError = ProtocolLoopIntegrationError;
export type LoopBudgetSnapshot = ProtocolLoopBudgetSnapshot;
export type LoopCollisionSnapshot = ProtocolLoopCollisionSnapshot;
export type LoopIntegrationSnapshot = ProtocolLoopIntegrationSnapshot;
export type LoopLimits = ProtocolLoopLimits;
export type LoopGoalTemplate = ProtocolLoopGoalTemplate;
export type LoopConfig = ProtocolLoopConfig;
export type LoopRunReportStatus = ProtocolLoopRunReportStatus;
export type LoopRunTrigger = ProtocolLoopRunTrigger;
export type LoopJobStatus = ProtocolLoopJobStatus;
export type LoopJobSummary = ProtocolLoopJobSummary;
export type LoopTriggerHealth = ProtocolLoopTriggerHealth;
export type LoopWorktreeArtifact = ProtocolLoopWorktreeArtifact;
export type LoopCleanupState = ProtocolLoopCleanupState;
export type LoopCleanupPolicy = ProtocolLoopCleanupPolicy;
export type LoopRunReport = ProtocolLoopRunReport;
export type LoopState = ProtocolLoopState;

export type LoopUpdateInput = Partial<Pick<LoopState,
  | "config"
  | "status"
  | "nextRunAt"
  | "lastScheduledAt"
  | "nextScheduledAt"
  | "lastEnqueuedAt"
  | "missedCount"
  | "triggerHealth"
  | "cleanupState"
  | "generatedStateSummary"
>>;

export class LoopPathError extends Error {
  constructor(public readonly loopId: string) {
    super(`Invalid loop path for id: ${loopId}`);
    this.name = "LoopPathError";
  }
}

export class LoopInvalidIdError extends Error {
  constructor(public readonly loopId: string) {
    super(`Invalid loop id format: ${loopId}`);
    this.name = "LoopInvalidIdError";
  }
}

export class LoopStateError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid loop state for ${loopId}`);
    this.name = "LoopStateError";
  }
}

export class LoopNotFoundError extends Error {
  constructor(public readonly loopId: string) {
    super(`Loop not found: ${loopId}`);
    this.name = "LoopNotFoundError";
  }
}

export class LoopRunLogError extends Error {
  constructor(
    public readonly loopId: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid loop run log for ${loopId}`);
    this.name = "LoopRunLogError";
  }
}

export class LoopStateManager {
  readonly #logger: Logger;

  constructor(
    private readonly workspaceRoot: string,
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "loops.state" });
  }

  async create(projectId: string, config: LoopConfig, author?: string): Promise<LoopState> {
    void author;
    const now = Date.now();
    const parsedConfig = LoopConfigSchema.parse(config);
    const state = LoopStateSchema.parse({
      loopId: crypto.randomUUID(),
      projectId,
      config: parsedConfig,
      status: "active",
      createdAt: now,
      updatedAt: now,
      nextRunAt: nextRunAtFrom(parsedConfig.schedule, now),
      runCount: 0,
      stateVersion: 1,
      generatedStateSummary: generateStateSummary(parsedConfig),
    });

    await this.write(state);
    return state;
  }

  async read(loopId: string): Promise<LoopState> {
    this.assertLoopId(loopId);
    const filePath = await this.loopStatePath(loopId);
    if (!existsSync(filePath)) throw new LoopNotFoundError(loopId);

    const content = await Bun.file(filePath).text();
    return this.parseLoopState(loopId, content);
  }

  async list(projectId?: string): Promise<LoopState[]> {
    const loopsRoot = this.loopsRoot();
    const entries = await readdir(loopsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (this.isMissingDirectoryError(error)) return [];
      this.#logger.warn("loops.list.readdir.failed", { error: logError(error) });
      throw error;
    });
    const states: LoopState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const loopId = entry.name;
      if (!LoopUuidSchema.safeParse(loopId).success) {
        throw new LoopInvalidIdError(loopId);
      }

      try {
        const state = await this.read(loopId);
        if (projectId && state.projectId !== projectId) continue;
        states.push(state);
      } catch (error) {
        if (error instanceof LoopNotFoundError && error.loopId === loopId) {
          this.#logger.debug("loops.list.missing.skipped", {
            context: { path: join(loopsRoot, loopId, "state.json") },
            error: logError(error),
          });
          continue;
        }
        if (error instanceof LoopStateError) {
          this.#logger.debug("loops.list.parse.skipped", {
            context: { path: join(loopsRoot, loopId, "state.json") },
            error: logError(error),
          });
          continue;
        }
        throw error;
      }
    }

    return states.sort((left, right) => left.loopId.localeCompare(right.loopId));
  }

  async update(loopId: string, updates: LoopUpdateInput): Promise<LoopState> {
    const state = await this.read(loopId);
    const updated = this.nextState({
      ...state,
      ...updates,
      config: updates.config ? LoopConfigSchema.parse(updates.config) : state.config,
    });

    await this.write(updated);
    return updated;
  }

  async pause(loopId: string): Promise<LoopState> {
    const state = await this.read(loopId);
    const updated = this.nextState({
      ...state,
      status: "paused",
      nextRunAt: undefined,
    });

    await this.write(updated);
    return updated;
  }

  async resume(loopId: string, now: number = Date.now()): Promise<LoopState> {
    const state = await this.read(loopId);
    const updated = this.nextState({
      ...state,
      status: "active",
      nextRunAt: nextRunAtFrom(state.config.schedule, now),
    }, now);

    await this.write(updated);
    return updated;
  }

  async recordRunStart(loopId: string, reportStart: LoopRunReport): Promise<LoopState> {
    const state = await this.read(loopId);
    const report = this.parseRunReport(loopId, reportStart);
    const updated = this.nextState({
      ...state,
      currentRun: report,
    }, report.startedAt);

    await this.write(updated);
    return updated;
  }

  async recordRunFinish(loopId: string, reportFinish: LoopRunReport): Promise<LoopState> {
    const state = await this.read(loopId);
    const report = this.parseRunReport(loopId, reportFinish);
    const finishedAt = report.endedAt ?? Date.now();
    const updated = this.nextState({
      ...state,
      lastRun: report,
      currentRun: state.currentRun?.runId === report.runId ? undefined : state.currentRun,
      nextRunAt: state.status === "active" ? nextRunAtFrom(state.config.schedule, finishedAt) : undefined,
      runCount: state.runCount + 1,
      latestIntegrations: report.integrationErrors === undefined ? state.latestIntegrations : LoopIntegrationSnapshotSchema.parse({
        errors: report.integrationErrors,
        updatedAt: finishedAt,
      }),
    }, finishedAt);

    await this.appendRunReport(loopId, report);
    await this.write(updated);
    return updated;
  }

  async recordRunBlocked(loopId: string, reportBlocked: LoopRunReport): Promise<LoopState> {
    const state = await this.read(loopId);
    const report = this.parseRunReport(loopId, reportBlocked);
    if (report.status !== "needs_user") {
      throw new LoopRunLogError(loopId, "Blocked Loop run reports must use needs_user status");
    }
    const blockedAt = report.endedAt ?? Date.now();
    const updated = this.nextState({
      ...state,
      lastRun: report,
      currentRun: report,
      blockedByHitlIds: report.blockedByHitlIds,
      attentionStatus: "waiting_for_human",
      resumeCheckpoint: report.resumeCheckpoint,
      currentJob: report.jobId !== undefined && state.currentJob?.jobId === report.jobId
        ? {
            ...state.currentJob,
            status: "needs_user",
            blockedReason: report.blockedReason,
            blockedByHitlIds: report.blockedByHitlIds,
            attentionStatus: "waiting_for_human",
            resumeCheckpoint: report.resumeCheckpoint,
          }
        : state.currentJob,
    }, blockedAt);

    await this.appendRunReport(loopId, report);
    await this.write(updated);
    return updated;
  }

  async clearHitlBlocker(loopId: string, hitlId: string): Promise<LoopState> {
    const state = await this.read(loopId);
    const blockedByHitlIds = state.blockedByHitlIds?.filter((id) => id !== hitlId);
    const currentRun = state.currentRun?.resumeCheckpoint?.hitlId === hitlId
      ? undefined
      : clearReportHitlId(state.currentRun, hitlId);
    const currentJob = state.currentJob?.resumeCheckpoint?.hitlId === hitlId
      ? undefined
      : clearJobHitlId(state.currentJob, hitlId);
    const updated = this.nextState({
      ...state,
      currentRun,
      currentJob,
      blockedByHitlIds: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? undefined : blockedByHitlIds,
      attentionStatus: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? "clear" : state.attentionStatus,
      resumeCheckpoint: state.resumeCheckpoint?.hitlId === hitlId ? undefined : state.resumeCheckpoint,
    });
    await this.write(updated);
    return updated;
  }

  async updateBudgetSnapshot(loopId: string, snapshot: LoopBudgetSnapshot): Promise<LoopState> {
    const state = await this.read(loopId);
    const parsed = LoopBudgetSnapshotSchema.parse(snapshot);
    const updated = this.nextState({
      ...state,
      latestBudget: parsed,
    }, parsed.updatedAt);

    await this.write(updated);
    return updated;
  }

  async updateCollisionSnapshot(loopId: string, snapshot: LoopCollisionSnapshot): Promise<LoopState> {
    const state = await this.read(loopId);
    const parsed = LoopCollisionSnapshotSchema.parse(snapshot);
    const updated = this.nextState({
      ...state,
      latestCollisions: parsed,
    }, parsed.updatedAt);

    await this.write(updated);
    return updated;
  }

  async updateIntegrationSnapshot(loopId: string, snapshot: LoopIntegrationSnapshot): Promise<LoopState> {
    const state = await this.read(loopId);
    const parsed = LoopIntegrationSnapshotSchema.parse(snapshot);
    const updated = this.nextState({
      ...state,
      latestIntegrations: parsed,
    }, parsed.updatedAt);

    await this.write(updated);
    return updated;
  }

  async appendRunReport(loopId: string, report: LoopRunReport): Promise<LoopRunReport> {
    this.assertLoopId(loopId);
    const parsed = this.parseRunReport(loopId, report);
    const filePath = await this.runLogPath(loopId);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
    return parsed;
  }

  async readRunLog(loopId: string, limit?: number): Promise<LoopRunReport[]> {
    this.assertLoopId(loopId);
    const filePath = await this.runLogPath(loopId);
    if (!existsSync(filePath)) return [];

    const content = await Bun.file(filePath).text();
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const reports = lines.map((line, index) => this.parseRunLogLine(loopId, line, index));
    const newestFirst = reports.reverse();

    if (limit === undefined) return newestFirst;
    if (!Number.isInteger(limit) || limit < 0) {
      throw new LoopRunLogError(loopId, `Invalid run log limit: ${limit}`);
    }
    return newestFirst.slice(0, limit);
  }

  async writeGeneratedStateMarkdown(loopState: LoopState): Promise<void> {
    const state = LoopStateSchema.parse(loopState);
    const filePath = await this.generatedStatePath(state.loopId);
    await atomicWrite(filePath, renderGeneratedStateMarkdown(state));
  }

  async readGeneratedStateMarkdown(loopId: string): Promise<string> {
    this.assertLoopId(loopId);
    const filePath = await this.generatedStatePath(loopId);
    if (!(await Bun.file(filePath).exists())) {
      await this.writeGeneratedStateMarkdown(await this.read(loopId));
    }
    return await Bun.file(filePath).text();
  }

  async resolveContainedPathForTest(relative: string): Promise<string> {
    try {
      return await resolveContainedPath(relative, this.loopsRoot());
    } catch (error) {
      if (error instanceof SafeLoopPathError) throw new LoopPathError(relative);
      throw error;
    }
  }

  async loopHitlPath(loopId: string): Promise<string> {
    this.assertLoopId(loopId);
    try {
      return await resolveContainedPath(join(loopId, "hitl.json"), this.loopsRoot());
    } catch (error) {
      if (error instanceof SafeLoopPathError) throw new LoopPathError(loopId);
      throw error;
    }
  }

  private async write(state: LoopState): Promise<void> {
    const parsed = LoopStateSchema.parse(state);
    const filePath = await this.loopStatePath(parsed.loopId);
    await atomicWrite(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    await this.writeGeneratedStateMarkdown(parsed);
  }

  private nextState(state: LoopState, updatedAt: number = Date.now()): LoopState {
    return LoopStateSchema.parse({
      ...state,
      updatedAt,
      stateVersion: state.stateVersion + 1,
    });
  }

  private parseLoopState(loopId: string, content: string): LoopState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new LoopStateError(loopId, error);
    }

    const result = LoopStateSchema.safeParse(parsed);
    if (!result.success) throw new LoopStateError(loopId, result.error);
    return result.data;
  }

  private parseRunReport(loopId: string, report: LoopRunReport): LoopRunReport {
    const result = LoopRunReportSchema.safeParse(report);
    if (!result.success) throw new LoopRunLogError(loopId, result.error);
    if (result.data.loopId !== loopId) {
      throw new LoopRunLogError(loopId, `Run report belongs to ${result.data.loopId}`);
    }
    return result.data;
  }

  private parseRunLogLine(loopId: string, line: string, index: number): LoopRunReport {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new LoopRunLogError(loopId, { index, error });
    }
    return this.parseRunReport(loopId, parsed as LoopRunReport);
  }

  private assertLoopId(loopId: string): void {
    if (!LoopUuidSchema.safeParse(loopId).success) {
      throw new LoopInvalidIdError(loopId);
    }
  }

  private async loopStatePath(loopId: string): Promise<string> {
    try {
      return await resolveContainedPath(join(loopId, "state.json"), this.loopsRoot());
    } catch (error) {
      if (error instanceof SafeLoopPathError) throw new LoopPathError(loopId);
      throw error;
    }
  }

  private async generatedStatePath(loopId: string): Promise<string> {
    try {
      return await resolveContainedPath(join(loopId, "state.md"), this.loopsRoot());
    } catch (error) {
      if (error instanceof SafeLoopPathError) throw new LoopPathError(loopId);
      throw error;
    }
  }

  private async runLogPath(loopId: string): Promise<string> {
    try {
      return await resolveContainedPath(join(loopId, "run-log.jsonl"), this.loopsRoot());
    } catch (error) {
      if (error instanceof SafeLoopPathError) throw new LoopPathError(loopId);
      throw error;
    }
  }

  private loopsRoot(): string {
    return resolve(this.workspaceRoot, PROJECT_STATE_DIR_NAME, "loops");
  }

  private isMissingDirectoryError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

class SafeLoopPathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Safe loop path error: ${reason} (path: "${path}")`);
    this.name = "SafeLoopPathError";
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.tmp-${crypto.randomUUID()}`);
  try {
    await Bun.write(tmpPath, content);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  try {
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function resolveContainedPath(relative: string, root: string): Promise<string> {
  if (resolve(relative) === relative && !relative.startsWith(".")) {
    throw new SafeLoopPathError(relative, "Absolute paths are not allowed");
  }

  const normalized = resolve(root, relative);
  if (!isContained(normalized, root)) {
    throw new SafeLoopPathError(relative, "Path escapes the loops directory");
  }

  try {
    const realPath = await realpath(normalized);
    const realRoot = await realpath(root);
    if (!isContained(realPath, realRoot)) {
      throw new SafeLoopPathError(normalized, "Symlink resolves outside the loops directory");
    }
    return realPath;
  } catch (error) {
    if (error instanceof SafeLoopPathError) throw error;
    return normalized;
  }
}

function isContained(resolvedPath: string, root: string): boolean {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(root);
  return normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}/`);
}

function nextRunAtFrom(schedule: LoopScheduleSpec, now: number): number | undefined {
  if (schedule.kind === "cron") {
    try {
      return Bun.cron.parse(schedule.expression, new Date(now))?.getTime();
    } catch {
      return undefined;
    }
  }
  if (schedule.kind !== "interval") return undefined;
  return now + schedule.everyMs;
}

function clearReportHitlId(report: LoopRunReport | undefined, hitlId: string): LoopRunReport | undefined {
  if (report === undefined) return undefined;
  const blockedByHitlIds = report.blockedByHitlIds?.filter((id) => id !== hitlId);
  return LoopRunReportSchema.parse({
    ...report,
    blockedByHitlIds: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? undefined : blockedByHitlIds,
    attentionStatus: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? "clear" : report.attentionStatus,
  });
}

function clearJobHitlId(job: LoopJobSummary | undefined, hitlId: string): LoopJobSummary | undefined {
  if (job === undefined) return undefined;
  const blockedByHitlIds = job.blockedByHitlIds?.filter((id) => id !== hitlId);
  return LoopJobSummarySchema.parse({
    ...job,
    blockedByHitlIds: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? undefined : blockedByHitlIds,
    attentionStatus: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? "clear" : job.attentionStatus,
  });
}

function generateStateSummary(config: LoopConfig): string {
  const schedule = scheduleSummary(config.schedule);
  return `${config.title} (${config.runKind}, ${config.mode}) scheduled ${schedule}.`;
}

function renderGeneratedStateMarkdown(state: LoopState): string {
  const schedule = scheduleSummary(state.config.schedule);
  const lines = [
    "<!-- Generated by ArchCode. Do not edit; state.json is the source of truth. -->",
    `# ${state.config.title}`,
    "",
    `- Loop ID: ${state.loopId}`,
    `- Project ID: ${state.projectId}`,
    `- Status: ${state.status}`,
    `- Schedule: ${schedule}`,
    `- Run kind: ${state.config.runKind}`,
    `- Mode: ${state.config.mode}`,
    `- Approval policy: ${state.config.approvalPolicy}`,
    `- Run count: ${state.runCount}`,
    `- State version: ${state.stateVersion}`,
    `- Created at: ${new Date(state.createdAt).toISOString()}`,
    `- Updated at: ${new Date(state.updatedAt).toISOString()}`,
  ];

  if (state.nextRunAt !== undefined) lines.push(`- Next run at: ${new Date(state.nextRunAt).toISOString()}`);
  if (state.currentRun) lines.push(`- Current run: ${state.currentRun.runId} (${state.currentRun.status})`);
  if (state.lastRun) lines.push(`- Last run: ${state.lastRun.runId} (${state.lastRun.status})`);
  if (state.generatedStateSummary) lines.push("", state.generatedStateSummary);

  return `${lines.join("\n")}\n`;
}

function scheduleSummary(schedule: LoopScheduleSpec): string {
  if (schedule.kind === "manual") return "manual";
  if (schedule.kind === "interval") return `interval every ${schedule.everyMs}ms`;
  return `cron ${schedule.expression}`;
}

function logError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }
  return { name: typeof error, message: String(error) };
}
