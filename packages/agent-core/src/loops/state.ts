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
  LoopCollisionSnapshot as ProtocolLoopCollisionSnapshot,
  LoopLimits as ProtocolLoopLimits,
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
  LoopTemplateId as ProtocolLoopTemplateId,
  LoopTriggerHealth as ProtocolLoopTriggerHealth,
  LoopTriggerSpec as ProtocolLoopTriggerSpec,
  LoopWorktreeArtifact as ProtocolLoopWorktreeArtifact,
} from "@archcode/protocol";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";

const LoopTitleSchema = z.string().trim().min(1).max(200);
const LoopNullableTitleSchema = LoopTitleSchema.nullable();
const LoopTextSchema = z.string().trim().min(1).max(10_000);
const LoopIdentifierSchema = z.string().trim().min(1).max(200);
const TimestampMsSchema = z.number().int().nonnegative();
const ShaSchema = z.string().trim().min(1).max(128);
const TriggerCadenceMsSchema = z.number().int().min(30_000);
const CronExpressionSchema = z.string().trim()
  .refine((value) => value.split(/\s+/).length === 5, {
    message: "Cron expressions must use exactly 5 UTC fields",
  })
  .refine((value) => {
    try {
      return Bun.cron.parse(value, new Date(0)) !== null;
    } catch {
      return false;
    }
  }, { message: "Cron expression must have a valid future UTC occurrence" });

function refineWorktreeCheckpoint(
  value: {
    readonly worktreePath?: string;
    readonly worktreeBranchName?: string;
    readonly baseSha?: string;
    readonly resolvedHeadSha?: string;
  },
  context: { addIssue(issue: { code: "custom"; path: string[]; message: string }): void },
): void {
  if (value.worktreePath === undefined) {
    if (value.worktreeBranchName !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["worktreeBranchName"],
        message: "worktreeBranchName requires worktreePath",
      });
    }
    if (value.resolvedHeadSha !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["resolvedHeadSha"],
        message: "resolvedHeadSha requires worktreePath",
      });
    }
    return;
  }
  for (const field of ["worktreeBranchName", "baseSha", "resolvedHeadSha"] as const) {
    if (value[field] === undefined) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is required when worktreePath is present`,
      });
    }
  }
}

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

export const LoopCoordinatorConfigSchema = z.strictObject({
  maxConcurrent: z.number().int().positive(),
}) satisfies z.ZodType<ProtocolLoopCoordinatorConfig>;

export const LoopProjectConfigSchema = z.strictObject({
  coordinator: LoopCoordinatorConfigSchema,
}) satisfies z.ZodType<ProtocolLoopProjectConfig>;

export const LoopRunKindSchema = z.enum(["session", "goal"]);
export const LoopTemplateIdSchema = z.enum(["watch_report", "maintain_fix", "pr_babysitter", "goal_runner"]);
export const LoopApprovalPolicySchema = z.enum(["interactive", "explicit_per_run"]);

const BudgetThresholdRatioSchema = z.number().min(0).max(1);

export const LoopBudgetConfigSchema = z.strictObject({
  maxIterationsPerRun: z.number().int().positive(),
  maxTokensPerRun: z.number().int().positive().optional(),
  maxEstimatedUsdPerRun: z.number().positive().optional(),
  maxWallClockMsPerRun: z.number().int().positive().optional(),
  maxRunsPerDay: z.number().int().positive().optional(),
  softThresholdRatio: BudgetThresholdRatioSchema,
  hardThresholdRatio: BudgetThresholdRatioSchema,
}) satisfies z.ZodType<ProtocolLoopBudgetConfig>;

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
  budget: LoopBudgetConfigSchema,
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
  title: LoopNullableTitleSchema,
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
  enabled: z.boolean(),
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
  worktreeBranchName: LoopIdentifierSchema.optional(),
  baseSha: ShaSchema.optional(),
  resolvedHeadSha: ShaSchema.optional(),
  intendedContinuation: z.enum(["rerun_job", "resume_run"]),
}).superRefine(refineWorktreeCheckpoint);

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
  templateId: LoopTemplateIdSchema,
  title: LoopNullableTitleSchema,
  schedule: LoopScheduleSpecSchema,
  approvalPolicy: LoopApprovalPolicySchema,
  limits: LoopLimitsSchema,
  collisionTargets: z.array(CollisionTargetSchema).max(100).optional(),
  taskPrompt: LoopTextSchema.optional(),
  goalTemplate: LoopGoalTemplateSchema.optional(),
  triggers: z.array(LoopTriggerSpecSchema).max(50).optional(),
  useWorktree: z.boolean(),
  cleanupPolicy: LoopCleanupPolicySchema.optional(),
});

const LoopRunReportBaseSchema = z.strictObject({
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
  sessionId: LoopIdentifierSchema.optional(),
  goalId: LoopIdentifierSchema.optional(),
  summary: LoopTextSchema.optional(),
  error: z.string().max(20_000).optional(),
  skippedReason: LoopTextSchema.optional(),
  jobId: LoopIdentifierSchema.optional(),
  subjectKey: LoopIdentifierSchema.optional(),
  dedupeKey: LoopIdentifierSchema.optional(),
  branchKey: LoopIdentifierSchema.optional(),
  worktreePath: LoopTextSchema.optional(),
  worktreeBranchName: LoopIdentifierSchema.optional(),
  baseSha: ShaSchema.optional(),
  resolvedHeadSha: ShaSchema.optional(),
  missedCount: z.number().int().nonnegative().optional(),
  blockedReason: LoopTextSchema.optional(),
  blockedByHitlIds: z.array(LoopIdentifierSchema).optional(),
  attentionStatus: z.enum(["clear", "waiting_for_human"]).optional(),
  resumeCheckpoint: LoopHitlCheckpointSchema.optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
  cleanupWarning: LoopTextSchema.optional(),
  observedArtifacts: z.array(LoopWorktreeArtifactSchema).max(100).optional(),
});

export const LoopRunReportSchema = LoopRunReportBaseSchema.superRefine((report, context) => {
  refineWorktreeCheckpoint(report, context);

  if (report.status === "running") {
    if (report.endedAt !== undefined) {
      context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt is not valid for a running Loop report" });
    }
  } else if (report.endedAt === undefined) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt is required for a finished Loop report" });
  }

  if (report.status !== "needs_user") return;
  if (report.blockedReason === undefined) {
    context.addIssue({ code: "custom", path: ["blockedReason"], message: "blockedReason is required for a needs_user Loop report" });
  }
  if (report.blockedByHitlIds === undefined || report.blockedByHitlIds.length === 0) {
    context.addIssue({ code: "custom", path: ["blockedByHitlIds"], message: "blockedByHitlIds is required for a needs_user Loop report" });
  }
  if (report.attentionStatus !== "waiting_for_human") {
    context.addIssue({ code: "custom", path: ["attentionStatus"], message: "attentionStatus must be waiting_for_human for a needs_user Loop report" });
  }
  if (report.resumeCheckpoint === undefined) {
    context.addIssue({ code: "custom", path: ["resumeCheckpoint"], message: "resumeCheckpoint is required for a needs_user Loop report" });
  }
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
  latestBudget: LoopBudgetSnapshotSchema.optional(),
  latestCollisions: LoopCollisionSnapshotSchema.optional(),
  latestIntegrations: LoopIntegrationSnapshotSchema.optional(),
  blockedByHitlIds: z.array(LoopIdentifierSchema).optional(),
  attentionStatus: z.enum(["clear", "waiting_for_human"]).optional(),
  resumeCheckpoint: LoopHitlCheckpointSchema.optional(),
  triggerHealth: z.array(LoopTriggerHealthSchema).max(50).optional(),
  cleanupState: LoopCleanupStateSchema.optional(),
}) satisfies z.ZodType<ProtocolLoopState>;

const LoopStateFileSchema = z.strictObject({
  version: z.literal(1),
  state: LoopStateSchema,
});

const LoopRunLogEntrySchema = z.strictObject({
  version: z.literal(1),
  report: LoopRunReportSchema,
});

export type LoopStatus = ProtocolLoopStatus;
export type LoopScheduleSpec = ProtocolLoopScheduleSpec;
export type LoopPullRequestScope = ProtocolLoopPullRequestScope;
export type LoopTriggerSpec = ProtocolLoopTriggerSpec;
export type LoopCoordinatorConfig = ProtocolLoopCoordinatorConfig;
export type LoopProjectConfig = ProtocolLoopProjectConfig;
export type LoopRunKind = ProtocolLoopRunKind;
export type LoopTemplateId = ProtocolLoopTemplateId;
export type LoopApprovalPolicy = ProtocolLoopApprovalPolicy;
export type LoopBudgetConfig = ProtocolLoopBudgetConfig;
export type LoopBudgetUsage = ProtocolLoopBudgetUsage;
export type LoopRunReason = ProtocolLoopRunReason;
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
export type LoopTriggerHealth = ProtocolLoopTriggerHealth;
export type LoopWorktreeArtifact = ProtocolLoopWorktreeArtifact;
export type LoopCleanupState = ProtocolLoopCleanupState;
export type LoopCleanupPolicy = ProtocolLoopCleanupPolicy;
export type LoopRunReport = ProtocolLoopRunReport;

export interface LoopRunBlockedConditionalResult {
  readonly outcome: "recorded" | "terminal" | "not_current";
  readonly state: LoopState;
}
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
  readonly #mutationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "loops.state" });
  }

  async create(projectId: string, config: LoopConfig): Promise<LoopState> {
    const now = Date.now();
    const parsedConfig = LoopConfigSchema.parse({ ...config, title: null });
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
        throw error;
      }
    }

    return states.sort((left, right) => left.loopId.localeCompare(right.loopId));
  }

  async update(loopId: string, updates: LoopUpdateInput): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const config = updates.config === undefined
        ? state.config
        : mergeLoopConfigForUpdate(state.config, updates.config);
      const updated = this.nextState({
        ...state,
        ...updates,
        config,
      });

      await this.write(updated);
      return updated;
    });
  }

  async setTitleIfEmpty(loopId: string, title: string): Promise<LoopState | undefined> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      if (state.config.title !== null) return undefined;
      const updated = this.nextState({
        ...state,
        config: LoopConfigSchema.parse({ ...state.config, title }),
      });
      await this.write(updated);
      return updated;
    });
  }

  async pause(loopId: string): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const updated = this.nextState({
        ...state,
        status: "paused",
        nextRunAt: undefined,
      });

      await this.write(updated);
      return updated;
    });
  }

  async resume(loopId: string, now: number = Date.now()): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const updated = this.nextState({
        ...state,
        status: "active",
        nextRunAt: nextRunAtFrom(state.config.schedule, now),
      }, now);

      await this.write(updated);
      return updated;
    });
  }

  async recordRunStart(loopId: string, reportStart: LoopRunReport): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const report = this.parseRunReport(loopId, reportStart);
      const updated = this.nextState({
        ...state,
        currentRun: report,
      }, report.startedAt);

      await this.write(updated);
      return updated;
    });
  }

  async recordRunFinish(loopId: string, reportFinish: LoopRunReport): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
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
    });
  }

  /**
   * Projects an already-durable terminal JSONL outcome into state.json. This is
   * intentionally independent from worktree cleanup so non-worktree and HITL
   * runs recover from the same report-first crash window.
   */
  async recoverRunProjection(loopId: string, durableReport: LoopRunReport): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const report = this.parseRunReport(loopId, durableReport);
      if (report.status === "running") throw new LoopRunLogError(loopId, "Cannot recover a running report as a terminal projection");

      const currentMatches = state.currentRun?.runId === report.runId;
      const lastMatches = state.lastRun?.runId === report.runId && state.lastRun.status !== "running";
      if (!currentMatches && !lastMatches) return state;
      const finishedAt = report.endedAt ?? Date.now();
      const blocked = report.status === "needs_user";
      const lastRunAlreadyCounted = lastMatches && state.lastRun?.status !== "needs_user";
      const clearsOwnedBlocker = currentMatches
        || state.resumeCheckpoint?.runId === report.runId
        || (lastMatches && state.currentRun === undefined);
      const updated = this.nextState({
        ...state,
        lastRun: report,
        currentRun: blocked ? report : currentMatches ? undefined : state.currentRun,
        ...(blocked ? {
          blockedByHitlIds: report.blockedByHitlIds,
          attentionStatus: "waiting_for_human" as const,
          resumeCheckpoint: report.resumeCheckpoint,
        } : {
          blockedByHitlIds: clearsOwnedBlocker ? undefined : state.blockedByHitlIds,
          attentionStatus: clearsOwnedBlocker ? "clear" as const : state.attentionStatus,
          resumeCheckpoint: clearsOwnedBlocker ? undefined : state.resumeCheckpoint,
          nextRunAt: state.status === "active" ? nextRunAtFrom(state.config.schedule, finishedAt) : undefined,
          runCount: lastRunAlreadyCounted ? state.runCount : state.runCount + 1,
          latestIntegrations: report.integrationErrors === undefined ? state.latestIntegrations : LoopIntegrationSnapshotSchema.parse({
            errors: report.integrationErrors,
            updatedAt: finishedAt,
          }),
        }),
        ...(report.cleanupState === undefined ? {} : { cleanupState: report.cleanupState }),
      }, finishedAt);
      await this.write(updated);
      return updated;
    });
  }

  /**
   * Appends the durable completion step of the worktree-cleanup saga without
   * counting the already-terminal execution as another run.
   */
  async recordRunCleanupCompletion(
    loopId: string,
    runId: string,
    updates: Pick<LoopRunReport, "cleanupState" | "cleanupWarning" | "observedArtifacts">,
  ): Promise<LoopRunReport> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const stateReport = state.lastRun?.runId === runId
        ? state.lastRun
        : state.currentRun?.runId === runId
          ? state.currentRun
          : undefined;
      const loggedReport = (await this.readRunLog(loopId)).find((report) => report.runId === runId);
      // The terminal report is the write-ahead record. Prefer it over a stale
      // running currentRun left by a crash between JSONL append and state write.
      const existing = loggedReport !== undefined && loggedReport.status !== "running"
        ? loggedReport
        : stateReport ?? loggedReport;
      if (existing === undefined) {
        throw new LoopRunLogError(loopId, `Cannot complete cleanup for unknown run ${runId}`);
      }
      const report = this.parseRunReport(loopId, { ...existing, ...updates });
      const currentMatches = state.currentRun?.runId === runId;
      const lastMatches = state.lastRun?.runId === runId;
      const staleRunningCurrent = currentMatches
        && state.currentRun?.status === "running"
        && report.status !== "running";
      const recoversMissingTerminalState = staleRunningCurrent && !lastMatches;
      const recoversBlockedState = recoversMissingTerminalState && report.status === "needs_user";
      const recoversFinishedState = recoversMissingTerminalState && report.status !== "needs_user";
      const finishedAt = report.endedAt ?? Date.now();
      const updated = this.nextState({
        ...state,
        ...(lastMatches || recoversMissingTerminalState ? { lastRun: report } : {}),
        ...(currentMatches
          ? { currentRun: staleRunningCurrent && report.status !== "needs_user" ? undefined : report }
          : {}),
        ...(recoversFinishedState ? {
          nextRunAt: state.status === "active" ? nextRunAtFrom(state.config.schedule, finishedAt) : undefined,
          runCount: state.runCount + 1,
          latestIntegrations: report.integrationErrors === undefined ? state.latestIntegrations : LoopIntegrationSnapshotSchema.parse({
            errors: report.integrationErrors,
            updatedAt: finishedAt,
          }),
        } : {}),
        ...(recoversBlockedState ? {
          blockedByHitlIds: report.blockedByHitlIds,
          attentionStatus: "waiting_for_human" as const,
          resumeCheckpoint: report.resumeCheckpoint,
        } : {}),
        ...(lastMatches || currentMatches ? { cleanupState: report.cleanupState } : {}),
      }, staleRunningCurrent ? finishedAt : undefined);
      await this.appendRunReport(loopId, report);
      await this.write(updated);
      return report;
    });
  }

  async recordRunBlocked(loopId: string, reportBlocked: LoopRunReport): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
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
      }, blockedAt);

      await this.appendRunReport(loopId, report);
      await this.write(updated);
      return updated;
    });
  }

  /**
   * Records a continuation rollback only while the same run still owns the
   * current projection. A late abort must never overwrite an already-terminal
   * state written by cancellation or restart recovery.
   */
  async recordRunBlockedIfCurrent(
    loopId: string,
    reportBlocked: LoopRunReport,
  ): Promise<LoopRunBlockedConditionalResult> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const report = this.parseRunReport(loopId, reportBlocked);
      if (report.status !== "needs_user") {
        throw new LoopRunLogError(loopId, "Blocked Loop run reports must use needs_user status");
      }
      if (
        state.lastRun?.runId === report.runId
        && state.lastRun.status !== "running"
        && state.lastRun.status !== "needs_user"
      ) {
        return { outcome: "terminal", state };
      }
      if (state.currentRun?.runId !== report.runId) {
        return { outcome: "not_current", state };
      }

      const blockedAt = report.endedAt ?? Date.now();
      const updated = this.nextState({
        ...state,
        lastRun: report,
        currentRun: report,
        blockedByHitlIds: report.blockedByHitlIds,
        attentionStatus: "waiting_for_human",
        resumeCheckpoint: report.resumeCheckpoint,
      }, blockedAt);
      await this.appendRunReport(loopId, report);
      await this.write(updated);
      return { outcome: "recorded", state: updated };
    });
  }

  async clearHitlBlocker(loopId: string, hitlId: string): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const blockedByHitlIds = state.blockedByHitlIds?.filter((id) => id !== hitlId);
      const currentRun = state.currentRun?.resumeCheckpoint?.hitlId === hitlId
        ? undefined
        : clearReportHitlId(state.currentRun, hitlId);
      const updated = this.nextState({
        ...state,
        currentRun,
        blockedByHitlIds: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? undefined : blockedByHitlIds,
        attentionStatus: blockedByHitlIds === undefined || blockedByHitlIds.length === 0 ? "clear" : state.attentionStatus,
        resumeCheckpoint: state.resumeCheckpoint?.hitlId === hitlId ? undefined : state.resumeCheckpoint,
      });
      await this.write(updated);
      return updated;
    });
  }

  async updateBudgetSnapshot(loopId: string, snapshot: LoopBudgetSnapshot): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const parsed = LoopBudgetSnapshotSchema.parse(snapshot);
      const updated = this.nextState({
        ...state,
        latestBudget: parsed,
      }, parsed.updatedAt);

      await this.write(updated);
      return updated;
    });
  }

  async updateCollisionSnapshot(loopId: string, snapshot: LoopCollisionSnapshot): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const parsed = LoopCollisionSnapshotSchema.parse(snapshot);
      const updated = this.nextState({
        ...state,
        latestCollisions: parsed,
      }, parsed.updatedAt);

      await this.write(updated);
      return updated;
    });
  }

  async updateIntegrationSnapshot(loopId: string, snapshot: LoopIntegrationSnapshot): Promise<LoopState> {
    return await this.withLoopMutation(loopId, async () => {
      const state = await this.read(loopId);
      const parsed = LoopIntegrationSnapshotSchema.parse(snapshot);
      const updated = this.nextState({
        ...state,
        latestIntegrations: parsed,
      }, parsed.updatedAt);

      await this.write(updated);
      return updated;
    });
  }

  async appendRunReport(loopId: string, report: LoopRunReport): Promise<LoopRunReport> {
    this.assertLoopId(loopId);
    const parsed = this.parseRunReport(loopId, report);
    const filePath = await this.runLogPath(loopId);
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify({ version: 1, report: parsed })}\n`, "utf8");
    return parsed;
  }

  async readRunLog(loopId: string, limit?: number): Promise<LoopRunReport[]> {
    this.assertLoopId(loopId);
    const filePath = await this.runLogPath(loopId);
    if (!existsSync(filePath)) return [];

    const content = await Bun.file(filePath).text();
    const lines = content.split("\n").filter((line) => line.trim().length > 0);
    const reports = lines.map((line, index) => this.parseRunLogLine(loopId, line, index));
    const seenRunIds = new Set<string>();
    const newestFirst = reports.reverse().filter((report) => {
      if (seenRunIds.has(report.runId)) return false;
      seenRunIds.add(report.runId);
      return true;
    });

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
    await atomicWrite(filePath, `${JSON.stringify({ version: 1, state: parsed }, null, 2)}\n`);
    await this.writeGeneratedStateMarkdown(parsed);
  }

  private nextState(state: LoopState, updatedAt: number = Date.now()): LoopState {
    return LoopStateSchema.parse({
      ...state,
      updatedAt,
      stateVersion: state.stateVersion + 1,
    });
  }

  private async withLoopMutation<T>(loopId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#mutationLocks.get(loopId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const chained = previous.then(() => current, () => current);
    this.#mutationLocks.set(loopId, chained);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#mutationLocks.get(loopId) === chained) this.#mutationLocks.delete(loopId);
    }
  }

  private parseLoopState(loopId: string, content: string): LoopState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new LoopStateError(loopId, error);
    }

    const result = LoopStateFileSchema.safeParse(parsed);
    if (!result.success) throw new LoopStateError(loopId, result.error);
    if (result.data.state.loopId !== loopId) {
      throw new LoopStateError(loopId, `Loop state belongs to ${result.data.state.loopId}`);
    }
    return result.data.state;
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
    const result = LoopRunLogEntrySchema.safeParse(parsed);
    if (!result.success) throw new LoopRunLogError(loopId, { index, error: result.error });
    return this.parseRunReport(loopId, result.data.report);
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

function mergeLoopConfigForUpdate(current: LoopConfig, incoming: LoopConfig): LoopConfig {
  const parsed = LoopConfigSchema.parse(incoming);
  if (parsed.title !== null || current.title === null) return parsed;
  return LoopConfigSchema.parse({ ...parsed, title: current.title });
}

function nextRunAtFrom(schedule: LoopScheduleSpec, now: number): number | undefined {
  if (schedule.kind === "cron") {
    const next = Bun.cron.parse(schedule.expression, new Date(now));
    if (next === null) throw new Error(`Cron expression has no future UTC occurrence: ${schedule.expression}`);
    return next.getTime();
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

function generateStateSummary(config: LoopConfig): string {
  const schedule = scheduleSummary(config.schedule);
  return `${config.templateId} loop scheduled ${schedule}.`;
}

function renderGeneratedStateMarkdown(state: LoopState): string {
  const schedule = scheduleSummary(state.config.schedule);
  const lines = [
    "<!-- Generated by ArchCode. Do not edit; state.json is the source of truth. -->",
    `# Loop ${state.loopId}`,
    "",
    `- Loop ID: ${state.loopId}`,
    `- Project ID: ${state.projectId}`,
    `- Status: ${state.status}`,
    `- Schedule: ${schedule}`,
    `- Template: ${state.config.templateId}`,
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
