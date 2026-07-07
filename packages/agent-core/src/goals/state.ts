import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { z } from "zod/v4";
import type {
  ApprovalPoint as ProtocolApprovalPoint,
  DoneCondition as ProtocolDoneCondition,
  DoneResult as ProtocolDoneResult,
  GoalArtifactFile as ProtocolGoalArtifactFile,
  GoalPhase as ProtocolGoalPhase,
  GoalReviewReport as ProtocolGoalReviewReport,
  GoalState as ProtocolGoalState,
  GoalStatus as ProtocolGoalStatus,
  GoalTokenBudgetState as ProtocolGoalTokenBudgetState,
  GoalRetryState as ProtocolGoalRetryState,
  GoalRepairContext as ProtocolGoalRepairContext,
  RetryPolicy as ProtocolRetryPolicy,
} from "@archcode/protocol";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";

export const GoalStatusSchema = z.enum([
  "draft",
  "locked",
  "running",
  "verifying",
  "reviewed",
  "completed",
  "failed",
  "escalated",
  "paused",
]);

export const GoalPhaseSchema = z.enum(["plan", "build", "review"]);

export const GoalUuidSchema = z.uuid();
export const GoalTitleSchema = z.string().trim().min(1).max(200);
const ConditionIdSchema = z.string().trim().min(1).max(80);
const ConditionTextSchema = z.string().trim().min(1).max(500);
const ConditionCommandSchema = z.string().trim().min(1).max(500);
const ConditionPathSchema = z.string().trim().min(1).max(500);
export const MAX_DONE_COMMAND_TIMEOUT_MS = 600_000;

export const RetryPolicySchema = z.strictObject({
  maxRetries: z.number().int().nonnegative(),
  backoffMs: z.number().int().nonnegative(),
  escalateOnFailure: z.boolean(),
}) satisfies z.ZodType<ProtocolRetryPolicy>;

export const ApprovalPointSchema = z.enum(["after_plan", "before_complete"]);

const DoneConditionBaseSchema = z.strictObject({
  id: ConditionIdSchema,
  required: z.boolean().default(true),
});

export const TestsPassDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("tests_pass"),
  params: z.strictObject({ command: ConditionCommandSchema.optional() }),
});

export const TypecheckPassDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("typecheck_pass"),
  params: z.strictObject({ command: ConditionCommandSchema.optional() }),
});

export const LspCleanDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("lsp_clean"),
  params: z.strictObject({
    paths: z.array(ConditionPathSchema).max(20).optional(),
    severity: z.enum(["error", "warning"]).optional(),
  }),
});

export const FileExistsDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("file_exists"),
  params: z.strictObject({ path: ConditionPathSchema }),
});

export const GrepContainsDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("grep_contains"),
  params: z.strictObject({
    pattern: ConditionTextSchema,
    path: ConditionPathSchema.optional(),
    minMatches: z.number().int().positive().optional(),
  }),
});

export const GrepEmptyDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("grep_empty"),
  params: z.strictObject({
    pattern: ConditionTextSchema,
    path: ConditionPathSchema.optional(),
  }),
});

export const CommandSucceedsDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("command_succeeds"),
  params: z.strictObject({
    command: ConditionCommandSchema,
    timeoutMs: z.number().int().positive().max(MAX_DONE_COMMAND_TIMEOUT_MS).optional(),
  }),
});

export const UserConfirmedDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("user_confirmed"),
  params: z.strictObject({ prompt: ConditionTextSchema }),
});

export const SpecComplianceDoneConditionSchema = DoneConditionBaseSchema.extend({
  kind: z.literal("spec_compliance"),
  params: z.strictObject({
    specPath: ConditionPathSchema,
    focusAreas: z.array(ConditionTextSchema).max(20).optional(),
  }),
});

export const DoneConditionSchema = z.discriminatedUnion("kind", [
  TestsPassDoneConditionSchema,
  TypecheckPassDoneConditionSchema,
  LspCleanDoneConditionSchema,
  FileExistsDoneConditionSchema,
  GrepContainsDoneConditionSchema,
  GrepEmptyDoneConditionSchema,
  CommandSucceedsDoneConditionSchema,
  UserConfirmedDoneConditionSchema,
  SpecComplianceDoneConditionSchema,
]) satisfies z.ZodType<ProtocolDoneCondition>;

export const DoneResultSchema = z.strictObject({
  conditionId: z.string().trim().min(1),
  passed: z.boolean(),
  evidence: z.string(),
  checkedAt: z.string(),
  specCompliance: z.lazy(() => GoalSpecComplianceEvidenceSchema).optional(),
  review: z.lazy(() => GoalReviewReportSchema).optional(),
}) satisfies z.ZodType<ProtocolDoneResult>;

export const GoalArtifactNameSchema = z.enum([
  "plan.md",
  "build.md",
  "review.md",
  "spec-compliance.md",
  "approvals.md",
  "budget.md",
  "retry-log.md",
  "final-report.md",
]);

export const GoalArtifactFileSchema = z.strictObject({
  name: GoalArtifactNameSchema,
  path: z.string().trim().min(1),
  mediaType: z.literal("text/markdown"),
  updatedAt: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().optional(),
}) satisfies z.ZodType<ProtocolGoalArtifactFile>;

export const GoalSpecComplianceCriterionEvidenceSchema = z.strictObject({
  criterionId: z.string().trim().min(1),
  criterion: z.string().trim().min(1),
  compliant: z.boolean(),
  status: z.enum(["satisfied", "failed"]).optional(),
  evidence: z.array(z.string()),
  artifactNames: z.array(GoalArtifactNameSchema).optional(),
  commandRefs: z.array(z.string().trim().min(1)).optional(),
  resultRefs: z.array(z.string().trim().min(1)).optional(),
  fileRefs: z.array(z.string().trim().min(1)).optional(),
  repairGuidance: z.string().trim().min(1).optional(),
});

export const GoalSpecComplianceEvidenceSchema = z.strictObject({
  checkedAt: z.string(),
  specPath: z.string().trim().min(1).optional(),
  summary: z.string(),
  criteria: z.array(GoalSpecComplianceCriterionEvidenceSchema),
});

export const GoalReviewReportSchema = z.strictObject({
  reviewerAgent: z.string().trim().min(1),
  outcome: z.enum(["DONE", "NOT_DONE"]),
  reviewedAt: z.string(),
  summary: z.string(),
  criteria: z.array(GoalSpecComplianceCriterionEvidenceSchema),
}) satisfies z.ZodType<ProtocolGoalReviewReport>;

export const GoalRepairIssueSchema = z.strictObject({
  conditionId: z.string().trim().min(1),
  evidenceSummary: z.string(),
  repairGuidance: z.string().trim().min(1),
  repairTarget: z.string().trim().min(1).optional(),
  implicatedFiles: z.array(z.string().trim().min(1)).optional(),
  failingCommands: z.array(z.string().trim().min(1)).optional(),
  resultSummaries: z.array(z.string().trim().min(1)).optional(),
});

export const GoalRepairContextSchema = z.strictObject({
  generatedAt: z.string(),
  summary: z.string(),
  issues: z.array(GoalRepairIssueSchema),
}) satisfies z.ZodType<ProtocolGoalRepairContext>;

export const GoalTokenBudgetStateSchema = z.strictObject({
  status: z.enum(["ok", "warning", "exceeded", "paused"]),
  maxTokens: z.number().int().nonnegative().optional(),
  warningThresholdTokens: z.number().int().nonnegative().optional(),
  warningApprovalPoint: z.string().trim().min(1).optional(),
  warningApprovalThresholdTokens: z.number().int().nonnegative().optional(),
  warningApprovedAt: z.string().optional(),
  warningApprovedTotalTokens: z.number().int().nonnegative().optional(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative(),
  updatedAt: z.string(),
}) satisfies z.ZodType<ProtocolGoalTokenBudgetState>;

export const GoalRetryFailureMetadataSchema = z.strictObject({
  failedAt: z.string(),
  errorKind: z.string().trim().min(1),
  message: z.string(),
  phase: GoalPhaseSchema.optional(),
});

export const GoalRetryAttemptMetadataSchema = z.strictObject({
  attempt: z.number().int().nonnegative(),
  status: z.enum(["scheduled", "running", "failed", "succeeded", "escalated"]),
  scheduledAt: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  nextRetryAt: z.string().optional(),
  failure: GoalRetryFailureMetadataSchema.optional(),
});

export const GoalRetryStateSchema = z.strictObject({
  retryCount: z.number().int().nonnegative(),
  nextRetryAt: z.string().optional(),
  lastFailure: GoalRetryFailureMetadataSchema.optional(),
  lastAttempt: GoalRetryAttemptMetadataSchema.optional(),
}) satisfies z.ZodType<ProtocolGoalRetryState>;

export const GoalStateSchema = z.strictObject({
  id: GoalUuidSchema,
  projectId: z.string().trim().min(1),
  title: GoalTitleSchema,
  status: GoalStatusSchema,
  phase: GoalPhaseSchema,
  doneConditions: z.array(DoneConditionSchema).max(50),
  doneResults: z.record(z.string(), DoneResultSchema),
  reviewerAgent: z.string().trim().min(1),
  retryPolicy: RetryPolicySchema,
  retryCount: z.number().int().nonnegative().default(0),
  retryState: GoalRetryStateSchema.optional(),
  tokenBudget: GoalTokenBudgetStateSchema.optional(),
  artifacts: z.array(GoalArtifactFileSchema).optional(),
  reviewReport: GoalReviewReportSchema.optional(),
  repairContext: GoalRepairContextSchema.optional(),
  approvalPoints: z.array(ApprovalPointSchema),
  author: z.string().trim().min(1),
  lockedBy: z.string().trim().min(1).optional(),
  mainSessionId: z.string().trim().min(1).optional(),
  childSessionIds: z.array(z.string().trim().min(1)),
  lockedAt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastError: z.string().optional(),
}) satisfies z.ZodType<ProtocolGoalState>;

export type GoalStatus = ProtocolGoalStatus;
export type GoalPhase = ProtocolGoalPhase;
export type DoneCondition = ProtocolDoneCondition;
export type DoneResult = ProtocolDoneResult;
export type RetryPolicy = ProtocolRetryPolicy;
export type ApprovalPoint = ProtocolApprovalPoint;
export type GoalState = ProtocolGoalState;
export type GoalTokenBudgetState = ProtocolGoalTokenBudgetState;
export type GoalRepairContext = ProtocolGoalRepairContext;
export type GoalRetryState = ProtocolGoalRetryState;

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  backoffMs: 1000,
  escalateOnFailure: true,
};

const TERMINAL_STATUSES = new Set<GoalStatus>(["completed", "escalated"]);

export class GoalPathError extends Error {
  constructor(public readonly goalId: string) {
    super(`Invalid goal path for id: ${goalId}`);
    this.name = "GoalPathError";
  }
}

export class GoalInvalidIdError extends Error {
  constructor(public readonly goalId: string) {
    super(`Invalid goal id format: ${goalId}`);
    this.name = "GoalInvalidIdError";
  }
}

export class GoalStateError extends Error {
  constructor(
    public readonly goalId: string,
    public readonly cause: unknown,
  ) {
    super(`Invalid goal state for ${goalId}`);
    this.name = "GoalStateError";
  }
}

export class GoalLockedError extends Error {
  constructor(
    public readonly goalId: string,
    public readonly status: GoalStatus,
  ) {
    super(`Goal ${goalId} is ${status}; generic patch is only allowed while draft`);
    this.name = "GoalLockedError";
  }
}

export class GoalEmptyConditionsError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal ${goalId} cannot be locked without done conditions`);
    this.name = "GoalEmptyConditionsError";
  }
}

export class GoalNotFoundError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "GoalNotFoundError";
  }
}

export type GoalPatchInput = Partial<Pick<GoalState,
  | "title"
  | "doneConditions"
  | "retryPolicy"
  | "approvalPoints"
  | "reviewerAgent"
  | "author"
>>;

export class GoalStateManager {
  readonly #logger: Logger;

  constructor(
    private readonly workspaceRoot: string,
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "goals.state" });
  }

  async create(
    projectId: string,
    title: string,
    author: string,
    doneConditions: DoneCondition[] = [],
    retryPolicy: RetryPolicy = DEFAULT_RETRY_POLICY,
    approvalPoints: ApprovalPoint[] = [],
    reviewerAgent = "reviewer",
  ): Promise<GoalState> {
    const now = new Date().toISOString();
    const state = GoalStateSchema.parse({
      id: crypto.randomUUID(),
      projectId,
      title,
      status: "draft",
      phase: "plan",
      doneConditions,
      doneResults: {},
      reviewerAgent,
      retryPolicy,
      retryCount: 0,
      approvalPoints,
      author,
      childSessionIds: [],
      createdAt: now,
      updatedAt: now,
    });

    await this.write(state);
    return state;
  }

  async read(goalId: string): Promise<GoalState> {
    if (!GoalUuidSchema.safeParse(goalId).success) {
      throw new GoalInvalidIdError(goalId);
    }
    const filePath = await this.goalStatePath(goalId);
    if (!existsSync(filePath)) throw new GoalNotFoundError(goalId);

    const content = await Bun.file(filePath).text();
    return this.parseGoalState(goalId, content);
  }

  async listGoals(projectId?: string): Promise<GoalState[]> {
    const goalsRoot = resolve(this.workspaceRoot, ".archcode", "goals");
    const entries = await readdir(goalsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if (this.isMissingDirectoryError(error)) return [];
      this.#logger.warn("goals.list.readdir.failed", { error: logError(error) });
      throw error;
    });
    const states: GoalState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const goalId = entry.name;
      if (!GoalUuidSchema.safeParse(goalId).success) {
        throw new GoalInvalidIdError(goalId);
      }

      try {
        const state = await this.read(goalId);
        if (projectId && state.projectId !== projectId) continue;
        states.push(state);
      } catch (error) {
        if (error instanceof GoalNotFoundError && error.goalId === goalId) {
          this.#logger.debug("goals.list.missing.skipped", {
            context: { path: join(goalsRoot, goalId, "goal.json") },
            error: logError(error),
          });
          continue;
        }
        if (error instanceof GoalStateError) {
          this.#logger.debug("goals.list.parse.skipped", {
            context: { path: join(goalsRoot, goalId, "goal.json") },
            error: logError(error),
          });
          continue;
        }
        throw error;
      }
    }

    return states.sort((left, right) => left.id.localeCompare(right.id));
  }

  async patch(goalId: string, updates: GoalPatchInput): Promise<GoalState> {
    const state = await this.read(goalId);
    if (state.status !== "draft") {
      throw new GoalLockedError(goalId, state.status);
    }

    const updated = GoalStateSchema.parse({
      ...state,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async lock(goalId: string, lockedBy: string): Promise<GoalState> {
    const state = await this.read(goalId);
    if (state.status !== "draft") {
      throw new GoalStateError(goalId, `Cannot lock goal from status ${state.status}`);
    }
    if (state.doneConditions.length === 0) {
      throw new GoalEmptyConditionsError(goalId);
    }

    const now = new Date().toISOString();
    const updated = GoalStateSchema.parse({
      ...state,
      status: "locked",
      lockedBy,
      lockedAt: now,
      updatedAt: now,
    });
    await this.write(updated);
    return updated;
  }

  async transitionStatus(goalId: string, newStatus: GoalStatus): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertValidTransition(state, newStatus);

    const updated = GoalStateSchema.parse({
      ...state,
      status: newStatus,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async updatePhase(goalId: string, phase: GoalPhase): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      phase,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async recordDoneResult(goalId: string, conditionId: string, result: DoneResult): Promise<GoalState> {
    const state = await this.read(goalId);
    const parsedResult = DoneResultSchema.parse({ ...result, conditionId });
    const updated = GoalStateSchema.parse({
      ...state,
      doneResults: { ...state.doneResults, [conditionId]: parsedResult },
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async incrementRetryCount(goalId: string): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      retryCount: state.retryCount + 1,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async updateRetryState(goalId: string, retryState: GoalRetryState): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      retryState: GoalRetryStateSchema.parse(retryState),
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async startRetryAttempt(goalId: string, mainSessionId: string, retryState: GoalRetryState): Promise<GoalState> {
    const state = await this.read(goalId);
    if (state.status !== "failed") {
      throw new GoalStateError(goalId, `Cannot start retry attempt from status ${state.status}`);
    }
    this.assertValidTransition(state, "running");
    const retryCount = state.retryCount + 1;
    const parsedRetryState = GoalRetryStateSchema.parse({ ...retryState, retryCount });
    const updated = GoalStateSchema.parse({
      ...state,
      status: "running",
      phase: "plan",
      retryCount,
      retryState: parsedRetryState,
      mainSessionId,
      childSessionIds: [],
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async updateLastError(goalId: string, error: string): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      lastError: error,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async recordReviewOutcome(
    goalId: string,
    reviewReport: ProtocolGoalReviewReport,
    repairContext?: GoalRepairContext,
  ): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      reviewReport: GoalReviewReportSchema.parse(reviewReport),
      repairContext: repairContext ? GoalRepairContextSchema.parse(repairContext) : undefined,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async updateTokenBudget(goalId: string, budget: GoalTokenBudgetState): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      tokenBudget: GoalTokenBudgetStateSchema.parse(budget),
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async updateSessionIds(
    goalId: string,
    mainSessionId?: string,
    childSessionIds?: string[],
  ): Promise<GoalState> {
    const state = await this.read(goalId);
    const updated = GoalStateSchema.parse({
      ...state,
      mainSessionId: mainSessionId ?? state.mainSessionId,
      childSessionIds: childSessionIds ?? state.childSessionIds,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  async resolveContainedPathForTest(relative: string): Promise<string> {
    try {
      return await resolveContainedPath(relative, this.goalsRoot());
    } catch (error) {
      if (error instanceof SafeGoalPathError) throw new GoalPathError(relative);
      throw error;
    }
  }

  private async write(state: GoalState): Promise<void> {
    const filePath = await this.goalStatePath(state.id);
    await atomicWrite(filePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private async goalStatePath(goalId: string): Promise<string> {
    try {
      return await resolveContainedPath(join(goalId, "goal.json"), this.goalsRoot());
    } catch (error) {
      if (error instanceof SafeGoalPathError) throw new GoalPathError(goalId);
      throw error;
    }
  }

  private goalsRoot(): string {
    return resolve(this.workspaceRoot, ".archcode", "goals");
  }

  private parseGoalState(goalId: string, content: string): GoalState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new GoalStateError(goalId, error);
    }

    const result = GoalStateSchema.safeParse(parsed);
    if (!result.success) throw new GoalStateError(goalId, result.error);
    return result.data;
  }

  private assertValidTransition(state: GoalState, newStatus: GoalStatus): void {
    if (state.status === newStatus) return;
    if (newStatus === "locked") {
      throw new GoalStateError(state.id, "Use lock() for draft → locked transitions");
    }
    if (TERMINAL_STATUSES.has(state.status)) {
      throw new GoalStateError(state.id, `Cannot transition from terminal status ${state.status}`);
    }
    if (newStatus === "paused" && canPauseFrom(state.status)) return;
    if (state.status === "paused" && newStatus === "running") return;

    const allowed: Partial<Record<GoalStatus, readonly GoalStatus[]>> = {
      locked: ["running"],
      running: ["verifying", "failed"],
      verifying: ["reviewed", "failed"],
      reviewed: ["completed"],
      failed: ["running", "escalated"],
    };

    if (!allowed[state.status]?.includes(newStatus)) {
      throw new GoalStateError(state.id, `Invalid transition ${state.status} → ${newStatus}`);
    }

    if (state.status === "verifying" && newStatus === "reviewed" && !this.allRequiredDoneResultsPassed(state)) {
      throw new GoalStateError(state.id, "Cannot review goal until all required done conditions passed");
    }
  }

  private allRequiredDoneResultsPassed(state: GoalState): boolean {
    return state.doneConditions
      .filter((condition) => condition.required !== false)
      .every((condition) => state.doneResults[condition.id]?.passed === true);
  }

  private isMissingDirectoryError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function canPauseFrom(status: GoalStatus): boolean {
  return status === "locked" || status === "running" || status === "verifying" || status === "reviewed";
}

class SafeGoalPathError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Safe goal path error: ${reason} (path: "${path}")`);
    this.name = "SafeGoalPathError";
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
    throw new SafeGoalPathError(relative, "Absolute paths are not allowed");
  }

  const normalized = resolve(root, relative);
  if (!isContained(normalized, root)) {
    throw new SafeGoalPathError(relative, "Path escapes the goals directory");
  }

  try {
    const realPath = await realpath(normalized);
    const realRoot = await realpath(root);
    if (!isContained(realPath, realRoot)) {
      throw new SafeGoalPathError(normalized, "Symlink resolves outside the goals directory");
    }
    return realPath;
  } catch (error) {
    if (error instanceof SafeGoalPathError) throw error;
    return normalized;
  }
}

function isContained(resolvedPath: string, root: string): boolean {
  const normalizedResolved = resolve(resolvedPath);
  const normalizedRoot = resolve(root);
  return normalizedResolved === normalizedRoot || normalizedResolved.startsWith(`${normalizedRoot}/`);
}

function logError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name || "Error", message: error.message };
  }
  return { name: typeof error, message: String(error) };
}
