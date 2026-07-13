import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { PROJECT_STATE_DIR_NAME } from "@archcode/protocol";
import type {
  GoalBlocker as ProtocolGoalBlocker,
  GoalBudgetSummary as ProtocolGoalBudgetSummary,
  GoalEvidenceRef as ProtocolGoalEvidenceRef,
  GoalReviewReceipt as ProtocolGoalReviewReceipt,
  GoalReviewVerdict,
  GoalState as ProtocolGoalState,
  GoalStatus as ProtocolGoalStatus,
  GoalWorktree as ProtocolGoalWorktree,
} from "@archcode/protocol";
import { z } from "zod/v4";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";

export const GoalStatusSchema = z.enum([
  "running",
  "blocked",
  "reviewing",
  "done",
  "not_done",
  "failed",
  "cancelled",
]);

export const GoalUuidSchema = z.uuid();
export const GoalTitleSchema = z.string().trim().min(1).max(160);
export const GoalNullableTitleSchema = GoalTitleSchema.nullable();
export const GoalNaturalLanguageSchema = z.string().trim().min(1).max(8000);
export const GoalEvidenceSummarySchema = z.string().trim().min(1).max(1000);
export const GoalReviewSummarySchema = z.string().trim().min(1).max(4000);
export const GoalFinalSummarySchema = z.string().trim().min(1).max(4000);

export const GoalEvidenceRefSchema = z.strictObject({
  kind: z.enum(["session", "message", "tool_call", "diff", "test_output", "file", "url", "hitl"]),
  ref: z.string().trim().min(1),
  summary: GoalEvidenceSummarySchema,
  sessionId: z.string().trim().min(1).optional(),
  messageId: z.string().trim().min(1).optional(),
  toolCallId: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  url: z.url().optional(),
  createdAt: z.string().trim().min(1).optional(),
}) satisfies z.ZodType<ProtocolGoalEvidenceRef>;

export const GoalReviewReceiptSchema = z.strictObject({
  reviewGeneration: z.number().int().nonnegative(),
  verdict: z.enum(["DONE", "NOT_DONE"]),
  summary: GoalReviewSummarySchema,
  evidenceRefs: z.array(GoalEvidenceRefSchema).max(20),
  unresolvedItems: z.array(z.string().trim().min(1).max(1000)).max(20).optional(),
  reviewerSessionId: z.string().trim().min(1),
  decidedAt: z.string().trim().min(1),
}) satisfies z.ZodType<ProtocolGoalReviewReceipt>;

export const GoalBlockerSchema = z.strictObject({
  kind: z.enum(["approval", "question", "budget", "permission", "tool_error"]),
  summary: GoalEvidenceSummarySchema,
  hitlId: z.string().trim().min(1).optional(),
  source: z.string().trim().min(1).optional(),
  resumeStatus: z.enum(["running", "reviewing"]),
  createdAt: z.string().trim().min(1),
}) satisfies z.ZodType<ProtocolGoalBlocker>;

const GoalManualBlockerSchema = GoalBlockerSchema.omit({ hitlId: true });

export const GoalBudgetSummarySchema = z.strictObject({
  status: z.enum(["ok", "warning", "blocked"]),
  usedTokens: z.number().int().nonnegative().optional(),
  maxTokens: z.number().int().positive().optional(),
  reason: z.string().trim().min(1).max(1000).optional(),
  updatedAt: z.string().trim().min(1),
}) satisfies z.ZodType<ProtocolGoalBudgetSummary>;

export const GoalLastErrorSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(4000),
  at: z.string().trim().min(1),
});

export const GoalWorktreeSchema = z.strictObject({
  path: z.string().trim().min(1),
  branchName: z.string().trim().min(1),
  baseSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
  createdAt: z.string().trim().min(1),
}) satisfies z.ZodType<ProtocolGoalWorktree>;

export const GoalStateSchema = z.strictObject({
  version: z.literal(3),
  id: GoalUuidSchema,
  projectId: z.string().trim().min(1),
  createdFromSessionId: z.string().trim().min(1),
  title: GoalNullableTitleSchema,
  objective: GoalNaturalLanguageSchema,
  acceptanceCriteria: GoalNaturalLanguageSchema,
  useWorktree: z.boolean(),
  worktree: GoalWorktreeSchema.optional(),
  status: GoalStatusSchema,
  blocker: GoalBlockerSchema.optional(),
  attempt: z.number().int().nonnegative(),
  reviewGeneration: z.number().int().nonnegative(),
  lastFailureSummary: GoalReviewSummarySchema.optional(),
  budget: GoalBudgetSummarySchema.optional(),
  pendingHitlIds: z.array(z.string().trim().min(1)).max(100),
  approvalRefs: z.array(z.string().trim().min(1)).max(100),
  appliedHitlIds: z.array(z.string().trim().min(1)).max(100),
  mainSessionId: z.string().trim().min(1),
  childSessionIds: z.array(z.string().trim().min(1)).max(500),
  review: GoalReviewReceiptSchema.optional(),
  finalSummary: GoalFinalSummarySchema.optional(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  startedAt: z.string().trim().min(1),
  completedAt: z.string().trim().min(1).optional(),
  cancelledAt: z.string().trim().min(1).optional(),
  lastError: GoalLastErrorSchema.optional(),
}).superRefine((state, ctx) => {
  addUniqueArrayIssues(state.pendingHitlIds, "pendingHitlIds", ctx);
  addUniqueArrayIssues(state.approvalRefs, "approvalRefs", ctx);
  addUniqueArrayIssues(state.appliedHitlIds, "appliedHitlIds", ctx);

  for (const hitlId of state.pendingHitlIds) {
    if (!state.approvalRefs.includes(hitlId)) {
      ctx.addIssue({
        code: "custom",
        path: ["pendingHitlIds"],
        message: `Pending HITL ${hitlId} requires a durable attachment marker`,
      });
    }
    if (state.appliedHitlIds.includes(hitlId)) {
      ctx.addIssue({
        code: "custom",
        path: ["appliedHitlIds"],
        message: `Applied HITL ${hitlId} cannot remain pending`,
      });
    }
  }

  for (const hitlId of state.appliedHitlIds) {
    if (!state.approvalRefs.includes(hitlId)) {
      ctx.addIssue({
        code: "custom",
        path: ["appliedHitlIds"],
        message: `Applied HITL ${hitlId} requires a durable attachment marker`,
      });
    }
  }

  if (state.blocker?.hitlId !== undefined && !state.pendingHitlIds.includes(state.blocker.hitlId)) {
    ctx.addIssue({
      code: "custom",
      path: ["blocker", "hitlId"],
      message: `Goal blocker HITL ${state.blocker.hitlId} must remain pending`,
    });
  }

  if (state.worktree !== undefined && state.useWorktree !== true) {
    ctx.addIssue({
      code: "custom",
      path: ["worktree"],
      message: "A persisted Goal worktree requires worktree isolation",
    });
  }

  if (state.status === "blocked" && state.blocker === undefined) {
    ctx.addIssue({ code: "custom", path: ["blocker"], message: "A blocked Goal requires blocker metadata" });
  }

  if (state.review !== undefined && state.review.reviewGeneration !== state.reviewGeneration) {
    ctx.addIssue({
      code: "custom",
      path: ["review", "reviewGeneration"],
      message: "Goal review receipt generation must match the current review generation",
    });
  }

  if (state.status === "done") {
    if (state.review?.verdict !== "DONE" || state.review.evidenceRefs.length === 0) {
      ctx.addIssue({ code: "custom", path: ["review"], message: "A done Goal requires a DONE review with evidence" });
    }
    if (state.finalSummary === undefined) {
      ctx.addIssue({ code: "custom", path: ["finalSummary"], message: "A done Goal requires a final summary" });
    }
    if (state.completedAt === undefined) {
      ctx.addIssue({ code: "custom", path: ["completedAt"], message: "A done Goal requires a completion timestamp" });
    }
  }

  if (state.status === "not_done") {
    if (state.review?.verdict !== "NOT_DONE") {
      ctx.addIssue({ code: "custom", path: ["review"], message: "A not_done Goal requires a NOT_DONE review" });
    }
    if (state.lastFailureSummary === undefined) {
      ctx.addIssue({ code: "custom", path: ["lastFailureSummary"], message: "A not_done Goal requires a failure summary" });
    }
    if (state.completedAt === undefined) {
      ctx.addIssue({ code: "custom", path: ["completedAt"], message: "A not_done Goal requires a completion timestamp" });
    }
  }
}) satisfies z.ZodType<ProtocolGoalState>;

export type GoalStatus = ProtocolGoalStatus;
export type GoalState = ProtocolGoalState;
export type GoalEvidenceRef = ProtocolGoalEvidenceRef;
export type GoalReviewReceipt = ProtocolGoalReviewReceipt;
export type GoalBlocker = ProtocolGoalBlocker;
export type GoalBudgetSummary = ProtocolGoalBudgetSummary;
export type GoalWorktree = ProtocolGoalWorktree;

export interface GoalCommitInput {
  readonly id: string;
  readonly projectId: string;
  readonly createdFromSessionId: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly mainSessionId: string;
  readonly useWorktree?: boolean;
  readonly startedAt?: string;
}

export interface GoalReviewerAuthorization {
  readonly agentName?: string;
  readonly sessionRole?: string;
  readonly sessionGoalId?: string;
  readonly reviewerSessionId?: string;
}

export interface GoalFinalizeReviewInput {
  readonly expectedReviewGeneration: number;
  readonly verdict: GoalReviewVerdict;
  readonly summary: string;
  readonly evidenceRefs?: readonly GoalEvidenceRef[];
  readonly unresolvedItems?: readonly string[];
  readonly finalSummary?: string;
  readonly authorization: GoalReviewerAuthorization;
}

export type GoalManualBlockerInput = Omit<GoalBlocker, "createdAt" | "hitlId"> & {
  readonly createdAt?: string;
  readonly hitlId?: never;
};

export interface GoalHitlBlockerAttachmentInput {
  readonly blocker: Omit<GoalBlocker, "createdAt" | "hitlId"> & {
    readonly hitlId: string;
    readonly createdAt?: string;
  };
  readonly approvalRef?: string;
}

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
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoalStateError";
  }
}

export class GoalNotFoundError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal not found: ${goalId}`);
    this.name = "GoalNotFoundError";
  }
}

export class GoalAlreadyExistsError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal already exists: ${goalId}`);
    this.name = "GoalAlreadyExistsError";
  }
}

export class GoalTransitionError extends Error {
  constructor(
    public readonly goalId: string,
    public readonly from: GoalStatus,
    public readonly to: GoalStatus,
  ) {
    super(`Invalid goal transition ${from} -> ${to} for ${goalId}`);
    this.name = "GoalTransitionError";
  }
}

export class GoalReviewerAuthorizationError extends Error {
  readonly code = "GOAL_REVIEWER_REQUIRED";

  constructor(public readonly goalId: string, message: string) {
    super(message);
    this.name = "GoalReviewerAuthorizationError";
  }
}

export class GoalReviewFinalizationError extends Error {
  constructor(public readonly goalId: string, message: string) {
    super(message);
    this.name = "GoalReviewFinalizationError";
  }
}

const TERMINAL_STATUSES = new Set<GoalStatus>(["done", "cancelled"]);
const ALLOWED_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  running: ["blocked", "reviewing", "failed", "cancelled"],
  blocked: ["running", "reviewing", "failed", "cancelled"],
  reviewing: ["blocked", "done", "not_done", "failed", "cancelled"],
  not_done: ["running", "cancelled"],
  failed: ["running", "cancelled"],
  done: [],
  cancelled: [],
};
export class GoalStateManager {
  readonly #logger: Logger;
  readonly #mutationLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "goals.state" });
  }

  async commit(input: GoalCommitInput): Promise<GoalState> {
    return await this.withGoalMutation(input.id, async () => {
      const now = input.startedAt ?? new Date().toISOString();
    const state = GoalStateSchema.parse({
      version: 3,
      id: input.id,
      projectId: input.projectId,
      createdFromSessionId: input.createdFromSessionId,
      title: null,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      useWorktree: input.useWorktree ?? false,
      status: "running",
      attempt: 1,
      reviewGeneration: 0,
      pendingHitlIds: [],
      approvalRefs: [],
      appliedHitlIds: [],
      childSessionIds: [],
      mainSessionId: input.mainSessionId,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
    });

      await this.writeNew(state);
    return state;
    });
  }

  async read(goalId: string): Promise<GoalState> {
    if (!GoalUuidSchema.safeParse(goalId).success) throw new GoalInvalidIdError(goalId);
    const filePath = await this.goalStatePath(goalId);
    if (!existsSync(filePath)) throw new GoalNotFoundError(goalId);
    return this.parseGoalState(goalId, await Bun.file(filePath).text());
  }

  async listGoals(projectId?: string): Promise<GoalState[]> {
    const entries = await readdir(this.goalsRoot(), { withFileTypes: true }).catch((error: unknown) => {
      if (this.isMissingDirectoryError(error)) return [];
      this.#logger.warn("goals.list.failed", { error: logError(error) });
      throw error;
    });
    const states: GoalState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const goalId = entry.name;
      if (!GoalUuidSchema.safeParse(goalId).success) throw new GoalInvalidIdError(goalId);
      try {
        const state = await this.read(goalId);
        if (projectId === undefined || state.projectId === projectId) states.push(state);
      } catch (error) {
        if (error instanceof GoalNotFoundError) continue;
        throw error;
      }
    }

    return states.sort((left, right) => left.id.localeCompare(right.id));
  }

  async setTitleIfEmpty(goalId: string, title: string): Promise<GoalState | undefined> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      if (state.title !== null) return undefined;
      return this.update(state, { title });
    });
  }

  async block(goalId: string, blocker: GoalManualBlockerInput): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertTransition(state, "blocked");
      const parsed = GoalManualBlockerSchema.parse({ ...blocker, createdAt: blocker.createdAt ?? new Date().toISOString() });
      return this.update(state, {
        status: "blocked",
        blocker: parsed,
      });
    });
  }

  async attachHitlBlocker(goalId: string, input: GoalHitlBlockerAttachmentInput): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      const hitlId = input.blocker.hitlId;
      if (state.appliedHitlIds.includes(hitlId)) return state;
      if (state.approvalRefs.includes(hitlId)) {
        if (
          state.status === "blocked"
          && state.blocker?.hitlId === hitlId
          && state.pendingHitlIds.includes(hitlId)
        ) return state;
        throw new GoalStateError(goalId, `Goal ${goalId} HITL ${hitlId} has an attachment marker without a pending blocker`);
      }
      if (state.pendingHitlIds.includes(hitlId)) {
        throw new GoalStateError(goalId, `Goal ${goalId} HITL ${hitlId} is pending without a durable attachment marker`);
      }

      this.assertTransition(state, "blocked");
      const parsed = GoalBlockerSchema.parse({
        ...input.blocker,
        createdAt: input.blocker.createdAt ?? new Date().toISOString(),
      });
      const approvalRefs = uniqueAppend(state.approvalRefs, hitlId);
      return this.update(state, {
        status: "blocked",
        blocker: parsed,
        pendingHitlIds: uniqueAppend(state.pendingHitlIds, hitlId),
        approvalRefs: input.approvalRef === undefined
          ? approvalRefs
          : uniqueAppend(approvalRefs, input.approvalRef),
      });
    });
  }

  async clearBlocker(goalId: string, hitlId?: string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      if (state.status !== "blocked") throw new GoalTransitionError(goalId, state.status, "running");
      if (state.blocker === undefined) throw new GoalStateError(goalId, `Blocked Goal ${goalId} has no blocker`);
      const resolvedHitlId = hitlId ?? state.blocker?.hitlId;
      if (resolvedHitlId !== undefined) this.assertPendingHitlBlocker(state, resolvedHitlId);
      const nextStatus = state.blocker.resumeStatus;
      this.assertTransition(state, nextStatus);
      return this.update(state, {
        status: nextStatus,
        blocker: undefined,
        pendingHitlIds: resolvedHitlId === undefined
          ? state.pendingHitlIds
          : state.pendingHitlIds.filter((id) => id !== resolvedHitlId),
        appliedHitlIds: resolvedHitlId === undefined
          ? state.appliedHitlIds
          : uniqueAppend(state.appliedHitlIds, resolvedHitlId),
      });
    });
  }

  async beginReview(goalId: string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertTransition(state, "reviewing");
      return this.update(state, {
        status: "reviewing",
        blocker: undefined,
        reviewGeneration: state.reviewGeneration + 1,
      });
    });
  }

  async finalizeReview(goalId: string, input: GoalFinalizeReviewInput): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      return await this.commitReview(state, input);
    });
  }

  async finalizeHitlReview(goalId: string, hitlId: string, input: GoalFinalizeReviewInput): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertPendingHitlBlocker(state, hitlId);
      if (state.blocker?.resumeStatus !== "reviewing") {
        throw new GoalReviewFinalizationError(goalId, `Goal HITL ${hitlId} does not resume a review`);
      }
      return await this.commitReview(state, input, hitlId);
    });
  }

  async retry(goalId: string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      if (state.status !== "not_done" && state.status !== "failed") {
        throw new GoalTransitionError(state.id, state.status, "running");
      }
      const now = new Date().toISOString();
      return this.update(state, {
        status: "running",
        attempt: state.attempt + 1,
        review: undefined,
        finalSummary: undefined,
        blocker: undefined,
        completedAt: undefined,
        cancelledAt: undefined,
        startedAt: now,
      });
    });
  }

  async fail(goalId: string, error: Error | string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertTransition(state, "failed");
      const normalized: NonNullable<GoalState["lastError"]> = normalizeError(error);
      return this.update(state, {
        status: "failed",
        lastFailureSummary: normalized.message,
        lastError: normalized,
        completedAt: normalized.at,
      });
    });
  }

  async failHitl(goalId: string, hitlId: string, error: Error | string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertPendingHitlBlocker(state, hitlId);
      this.assertTransition(state, "failed");
      const normalized: NonNullable<GoalState["lastError"]> = normalizeError(error);
      return this.update(state, {
        status: "failed",
        blocker: undefined,
        pendingHitlIds: state.pendingHitlIds.filter((id) => id !== hitlId),
        appliedHitlIds: uniqueAppend(state.appliedHitlIds, hitlId),
        lastFailureSummary: normalized.message,
        lastError: normalized,
        completedAt: normalized.at,
      });
    });
  }

  async cancel(goalId: string, reason?: string, hitlId?: string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertTransition(state, "cancelled");
      const now = new Date().toISOString();
      const approvalRefs = hitlId === undefined ? state.approvalRefs : uniqueAppend(state.approvalRefs, hitlId);
      return this.update(state, {
        status: "cancelled",
        cancelledAt: now,
        pendingHitlIds: [],
        approvalRefs,
        appliedHitlIds: hitlId === undefined ? state.appliedHitlIds : uniqueAppend(state.appliedHitlIds, hitlId),
        blocker: undefined,
        ...(reason === undefined ? {} : { lastFailureSummary: reason }),
      });
    });
  }

  async addChildSession(goalId: string, sessionId: string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertNotTerminal(state);
      return this.update(state, { childSessionIds: uniqueAppend(state.childSessionIds, sessionId) });
    });
  }

  async setWorktree(goalId: string, worktree: GoalWorktree): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      if (state.status === "done" || state.status === "cancelled") {
        throw new GoalStateError(goalId, `Goal ${goalId} is terminal: ${state.status}`);
      }
      if (state.useWorktree !== true) {
        throw new GoalStateError(goalId, `Goal ${goalId} does not have worktree isolation enabled`);
      }
      const parsed = GoalWorktreeSchema.parse(worktree);
      if (state.worktree !== undefined) {
        if (sameGoalWorktree(state.worktree, parsed)) return state;
        throw new GoalStateError(goalId, `Goal ${goalId} worktree resource is already claimed`);
      }
      return this.update(state, { worktree: parsed });
    });
  }

  async updateBudgetSummary(goalId: string, budget: GoalBudgetSummary): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      this.assertNotTerminal(state);
      return this.update(state, { budget: GoalBudgetSummarySchema.parse(budget) });
    });
  }

  async updateLastError(goalId: string, error: Error | string): Promise<GoalState> {
    return await this.withGoalMutation(goalId, async () => {
      const state = await this.read(goalId);
      return this.update(state, { lastError: normalizeError(error) });
    });
  }

  async goalHitlPath(goalId: string): Promise<string> {
    if (!GoalUuidSchema.safeParse(goalId).success) throw new GoalInvalidIdError(goalId);
    try {
      return await resolveContainedPath(join(goalId, "hitl"), this.goalsRoot());
    } catch (error) {
      if (error instanceof SafeGoalPathError) throw new GoalPathError(goalId);
      throw error;
    }
  }

  async resolveContainedPathForTest(relative: string): Promise<string> {
    try {
      return await resolveContainedPath(relative, this.goalsRoot());
    } catch (error) {
      if (error instanceof SafeGoalPathError) throw new GoalPathError(relative);
      throw error;
    }
  }

  private async update(state: GoalState, updates: Partial<GoalState>): Promise<GoalState> {
    const updated = GoalStateSchema.parse({
      ...state,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
    await this.write(updated);
    return updated;
  }

  private async write(state: GoalState): Promise<void> {
    await atomicWrite(await this.goalStatePath(state.id), `${JSON.stringify(GoalStateSchema.parse(state), null, 2)}\n`);
  }

  private async writeNew(state: GoalState): Promise<void> {
    const filePath = await this.goalStatePath(state.id);
    if (existsSync(filePath) || existsSync(dirname(filePath))) throw new GoalAlreadyExistsError(state.id);
    const root = this.goalsRoot();
    await mkdir(root, { recursive: true });
    const temporaryDir = join(root, `.tmp-${state.id}-${crypto.randomUUID()}`);
    try {
      await mkdir(temporaryDir);
      await Bun.write(join(temporaryDir, "goal.json"), `${JSON.stringify(GoalStateSchema.parse(state), null, 2)}\n`);
      await rename(temporaryDir, dirname(filePath));
    } catch (error) {
      await rm(temporaryDir, { recursive: true, force: true }).catch(() => {});
      if (existsSync(dirname(filePath))) throw new GoalAlreadyExistsError(state.id);
      throw error;
    }
  }

  private async withGoalMutation<T>(goalId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#mutationLocks.get(goalId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    const chained = previous.then(() => current, () => current);
    this.#mutationLocks.set(goalId, chained);

    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.#mutationLocks.get(goalId) === chained) this.#mutationLocks.delete(goalId);
    }
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
    return resolve(this.workspaceRoot, PROJECT_STATE_DIR_NAME, "goals");
  }

  private parseGoalState(goalId: string, content: string): GoalState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new GoalStateError(goalId, `Invalid goal JSON for ${goalId}`, error);
    }

    const result = GoalStateSchema.safeParse(parsed);
    if (!result.success) throw new GoalStateError(goalId, `Goal state validation failed for ${goalId}`, result.error);
    return result.data;
  }

  private assertTransition(state: GoalState, next: GoalStatus): void {
    if (!ALLOWED_TRANSITIONS[state.status].includes(next)) throw new GoalTransitionError(state.id, state.status, next);
  }

  private assertNotTerminal(state: GoalState): void {
    if (TERMINAL_STATUSES.has(state.status)) throw new GoalStateError(state.id, `Goal ${state.id} is terminal: ${state.status}`);
  }

  private assertPendingHitlBlocker(state: GoalState, hitlId: string): void {
    if (!state.approvalRefs.includes(hitlId)) {
      throw new GoalStateError(state.id, `Goal ${state.id} HITL ${hitlId} is missing its durable attachment marker`);
    }
    if (!state.pendingHitlIds.includes(hitlId)) {
      throw new GoalStateError(state.id, `Goal ${state.id} HITL ${hitlId} is not pending`);
    }
    if (state.status !== "blocked" || state.blocker?.hitlId !== hitlId) {
      throw new GoalStateError(state.id, `Goal ${state.id} HITL ${hitlId} is not the active blocker`);
    }
  }

  private async commitReview(
    state: GoalState,
    input: GoalFinalizeReviewInput,
    hitlId?: string,
  ): Promise<GoalState> {
    this.assertReviewerAuthorized(state, input.authorization);
    if (input.expectedReviewGeneration !== state.reviewGeneration) {
      throw new GoalReviewFinalizationError(
        state.id,
        `Stale review generation ${input.expectedReviewGeneration}; current generation is ${state.reviewGeneration}`,
      );
    }
    if (hitlId === undefined) {
      if (state.status !== "reviewing") {
        throw new GoalReviewFinalizationError(state.id, `Goal must be reviewing, got ${state.status}`);
      }
    } else if (state.status !== "blocked") {
      throw new GoalReviewFinalizationError(state.id, `Goal HITL review must be blocked, got ${state.status}`);
    }
    if (state.review !== undefined) throw new GoalReviewFinalizationError(state.id, "Goal review is already finalized");

    const evidenceRefs = [...(input.evidenceRefs ?? [])];
    if (input.verdict === "DONE" && evidenceRefs.length === 0) {
      throw new GoalReviewFinalizationError(state.id, "DONE review requires at least one evidence ref");
    }
    if (input.verdict === "NOT_DONE" && input.summary.trim().length === 0) {
      throw new GoalReviewFinalizationError(state.id, "NOT_DONE review requires a non-empty summary");
    }

    const now = new Date().toISOString();
    const review = GoalReviewReceiptSchema.parse({
      reviewGeneration: state.reviewGeneration,
      verdict: input.verdict,
      summary: input.summary,
      evidenceRefs,
      unresolvedItems: input.unresolvedItems,
      reviewerSessionId: input.authorization.reviewerSessionId,
      decidedAt: now,
    });
    const status = input.verdict === "DONE" ? "done" : "not_done";
    if (hitlId === undefined) this.assertTransition(state, status);
    return await this.update(state, {
      status,
      review,
      blocker: hitlId === undefined ? state.blocker : undefined,
      pendingHitlIds: hitlId === undefined
        ? state.pendingHitlIds
        : state.pendingHitlIds.filter((id) => id !== hitlId),
      appliedHitlIds: hitlId === undefined
        ? state.appliedHitlIds
        : uniqueAppend(state.appliedHitlIds, hitlId),
      ...(input.verdict === "DONE"
        ? { finalSummary: input.finalSummary ?? input.summary }
        : { lastFailureSummary: input.summary }),
      completedAt: now,
    });
  }

  private assertReviewerAuthorized(state: GoalState, authorization: GoalReviewerAuthorization): void {
    if (authorization.agentName !== "reviewer") {
      throw new GoalReviewerAuthorizationError(state.id, `Review finalization requires reviewer agent, got ${authorization.agentName ?? "unknown"}`);
    }
    if (authorization.sessionRole !== "review") {
      throw new GoalReviewerAuthorizationError(state.id, `Review finalization requires review session, got ${authorization.sessionRole ?? "unknown"}`);
    }
    if (authorization.sessionGoalId !== state.id) {
      throw new GoalReviewerAuthorizationError(state.id, `Review finalization requires matching goal ${state.id}`);
    }
    if (authorization.reviewerSessionId === undefined || authorization.reviewerSessionId.trim().length === 0) {
      throw new GoalReviewerAuthorizationError(state.id, "Review finalization requires reviewer session id");
    }
  }

  private isMissingDirectoryError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}

function sameGoalWorktree(left: GoalWorktree, right: GoalWorktree): boolean {
  return left.path === right.path
    && left.branchName === right.branchName
    && left.baseSha === right.baseSha;
}

function normalizeError(error: Error | string): NonNullable<GoalState["lastError"]> {
  return {
    name: error instanceof Error ? error.name || "Error" : "Error",
    message: error instanceof Error ? error.message : error,
    at: new Date().toISOString(),
  };
}

function uniqueAppend(values: readonly string[], value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new GoalStateError("unknown", "Session and HITL refs must be non-empty");
  return values.includes(trimmed) ? [...values] : [...values, trimmed];
}

function addUniqueArrayIssues(
  values: readonly string[],
  field: "pendingHitlIds" | "approvalRefs" | "appliedHitlIds",
  ctx: z.RefinementCtx,
): void {
  if (new Set(values).size === values.length) return;
  ctx.addIssue({ code: "custom", path: [field], message: `${field} must not contain duplicate values` });
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
  if (!isContained(normalized, root)) throw new SafeGoalPathError(relative, "Path escapes the goals directory");
  try {
    const realPath = await realpath(normalized);
    const realRoot = await realpath(root);
    if (!isContained(realPath, realRoot)) throw new SafeGoalPathError(normalized, "Symlink resolves outside the goals directory");
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
  if (error instanceof Error) return { name: error.name || "Error", message: error.message };
  return { name: typeof error, message: String(error) };
}
