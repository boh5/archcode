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
} from "@archcode/protocol";
import { z } from "zod/v4";

import type { Logger } from "../logger";
import { silentLogger } from "../logger";

export const GoalStatusSchema = z.enum([
  "draft",
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
  resumeStatus: z.enum(["running", "reviewing"]).optional(),
  createdAt: z.string().trim().min(1),
}) satisfies z.ZodType<ProtocolGoalBlocker>;

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

export const GoalStateSchema = z.strictObject({
  id: GoalUuidSchema,
  projectId: z.string().trim().min(1),
  title: GoalTitleSchema,
  objective: GoalNaturalLanguageSchema,
  acceptanceCriteria: GoalNaturalLanguageSchema,
  status: GoalStatusSchema,
  blocker: GoalBlockerSchema.optional(),
  attempt: z.number().int().nonnegative(),
  lastFailureSummary: GoalReviewSummarySchema.optional(),
  budget: GoalBudgetSummarySchema.optional(),
  pendingHitlIds: z.array(z.string().trim().min(1)).max(100),
  approvalRefs: z.array(z.string().trim().min(1)).max(100),
  mainSessionId: z.string().trim().min(1).optional(),
  childSessionIds: z.array(z.string().trim().min(1)).max(500),
  loopId: z.uuid().optional(),
  review: GoalReviewReceiptSchema.optional(),
  finalSummary: GoalFinalSummarySchema.optional(),
  createdAt: z.string().trim().min(1),
  updatedAt: z.string().trim().min(1),
  startedAt: z.string().trim().min(1).optional(),
  completedAt: z.string().trim().min(1).optional(),
  cancelledAt: z.string().trim().min(1).optional(),
  lastError: GoalLastErrorSchema.optional(),
}) satisfies z.ZodType<ProtocolGoalState>;

export type GoalStatus = ProtocolGoalStatus;
export type GoalState = ProtocolGoalState;
export type GoalEvidenceRef = ProtocolGoalEvidenceRef;
export type GoalReviewReceipt = ProtocolGoalReviewReceipt;
export type GoalBlocker = ProtocolGoalBlocker;
export type GoalBudgetSummary = ProtocolGoalBudgetSummary;

export interface GoalCreateInput {
  readonly projectId: string;
  readonly title: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly mainSessionId?: string;
  readonly loopId?: string;
}

export type GoalDraftPatch = Partial<Pick<GoalState, "title" | "objective" | "acceptanceCriteria" | "mainSessionId" | "loopId">>;

export interface GoalReviewerAuthorization {
  readonly agentName?: string;
  readonly sessionRole?: string;
  readonly sessionGoalId?: string;
  readonly reviewerSessionId?: string;
}

export interface GoalFinalizeReviewInput {
  readonly verdict: GoalReviewVerdict;
  readonly summary: string;
  readonly evidenceRefs?: readonly GoalEvidenceRef[];
  readonly unresolvedItems?: readonly string[];
  readonly finalSummary?: string;
  readonly authorization: GoalReviewerAuthorization;
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
  draft: ["running", "cancelled"],
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

  constructor(
    private readonly workspaceRoot: string,
    logger: Logger = silentLogger,
  ) {
    this.#logger = logger.child({ module: "goals.state" });
  }

  async create(input: GoalCreateInput): Promise<GoalState> {
    const now = new Date().toISOString();
    const state = GoalStateSchema.parse({
      id: crypto.randomUUID(),
      projectId: input.projectId,
      title: input.title,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      status: "draft",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      ...(input.mainSessionId === undefined ? {} : { mainSessionId: input.mainSessionId }),
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
      createdAt: now,
      updatedAt: now,
    });

    await this.write(state);
    return state;
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

  async patchDraft(goalId: string, updates: GoalDraftPatch): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertMutableDraft(state);
    return this.update(state, updates);
  }

  async start(goalId: string, input: { readonly mainSessionId?: string; readonly loopId?: string } = {}): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertTransition(state, "running");
    return this.update(state, {
      status: "running",
      blocker: undefined,
      review: undefined,
      finalSummary: undefined,
      completedAt: undefined,
      cancelledAt: undefined,
      startedAt: state.startedAt ?? new Date().toISOString(),
      ...(input.mainSessionId === undefined ? {} : { mainSessionId: input.mainSessionId }),
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
    });
  }

  async block(goalId: string, blocker: Omit<GoalBlocker, "createdAt"> & { readonly createdAt?: string }): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertTransition(state, "blocked");
    const parsed = GoalBlockerSchema.parse({ ...blocker, createdAt: blocker.createdAt ?? new Date().toISOString() });
    return this.update(state, {
      status: "blocked",
      blocker: parsed,
      pendingHitlIds: parsed.hitlId === undefined ? state.pendingHitlIds : uniqueAppend(state.pendingHitlIds, parsed.hitlId),
    });
  }

  async clearBlocker(goalId: string, hitlId?: string): Promise<GoalState> {
    const state = await this.read(goalId);
    if (state.status !== "blocked") throw new GoalTransitionError(goalId, state.status, "running");
    const nextStatus = state.blocker?.resumeStatus ?? "running";
    this.assertTransition(state, nextStatus);
    return this.update(state, {
      status: nextStatus,
      blocker: undefined,
      pendingHitlIds: hitlId === undefined ? state.pendingHitlIds : state.pendingHitlIds.filter((id) => id !== hitlId),
    });
  }

  async beginReview(goalId: string): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertTransition(state, "reviewing");
    return this.update(state, { status: "reviewing", blocker: undefined });
  }

  async finalizeReview(goalId: string, input: GoalFinalizeReviewInput): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertReviewerAuthorized(state, input.authorization);
    if (state.status !== "reviewing") throw new GoalReviewFinalizationError(goalId, `Goal must be reviewing, got ${state.status}`);
    if (state.review !== undefined) throw new GoalReviewFinalizationError(goalId, "Goal review is already finalized");

    const evidenceRefs = [...(input.evidenceRefs ?? [])];
    if (input.verdict === "DONE" && evidenceRefs.length === 0) {
      throw new GoalReviewFinalizationError(goalId, "DONE review requires at least one evidence ref");
    }
    if (input.verdict === "NOT_DONE" && input.summary.trim().length === 0) {
      throw new GoalReviewFinalizationError(goalId, "NOT_DONE review requires a non-empty summary");
    }

    const now = new Date().toISOString();
    const review = GoalReviewReceiptSchema.parse({
      verdict: input.verdict,
      summary: input.summary,
      evidenceRefs,
      unresolvedItems: input.unresolvedItems,
      reviewerSessionId: input.authorization.reviewerSessionId,
      decidedAt: now,
    });
    const status = input.verdict === "DONE" ? "done" : "not_done";
    this.assertTransition(state, status);
    return this.update(state, {
      status,
      review,
      ...(input.verdict === "DONE" ? { finalSummary: input.finalSummary ?? input.summary } : { lastFailureSummary: input.summary }),
      completedAt: now,
    });
  }

  async retry(goalId: string, input: { readonly mainSessionId?: string } = {}): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertTransition(state, "running");
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
      ...(input.mainSessionId === undefined ? {} : { mainSessionId: input.mainSessionId }),
    });
  }

  async fail(goalId: string, error: Error | string): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertTransition(state, "failed");
    const normalized: NonNullable<GoalState["lastError"]> = normalizeError(error);
    return this.update(state, {
      status: "failed",
      lastFailureSummary: normalized.message,
      lastError: normalized,
      completedAt: normalized.at,
    });
  }

  async cancel(goalId: string, reason?: string): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertTransition(state, "cancelled");
    const now = new Date().toISOString();
    return this.update(state, {
      status: "cancelled",
      cancelledAt: now,
      ...(reason === undefined ? {} : { lastFailureSummary: reason }),
    });
  }

  async addChildSession(goalId: string, sessionId: string): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertNotTerminal(state);
    return this.update(state, { childSessionIds: uniqueAppend(state.childSessionIds, sessionId) });
  }

  async setMainSession(goalId: string, sessionId: string): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertNotTerminal(state);
    return this.update(state, { mainSessionId: sessionId });
  }

  async updateBudgetSummary(goalId: string, budget: GoalBudgetSummary): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertNotTerminal(state);
    return this.update(state, { budget: GoalBudgetSummarySchema.parse(budget) });
  }

  async updateLastError(goalId: string, error: Error | string): Promise<GoalState> {
    const state = await this.read(goalId);
    return this.update(state, { lastError: normalizeError(error) });
  }

  async recordHitlRef(goalId: string, input: { readonly hitlId: string; readonly approvalRef?: string }): Promise<GoalState> {
    const state = await this.read(goalId);
    this.assertNotTerminal(state);
    return this.update(state, {
      pendingHitlIds: uniqueAppend(state.pendingHitlIds, input.hitlId),
      approvalRefs: input.approvalRef === undefined ? state.approvalRefs : uniqueAppend(state.approvalRefs, input.approvalRef),
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

  private assertMutableDraft(state: GoalState): void {
    if (state.status !== "draft") throw new GoalStateError(state.id, `Goal ${state.id} is ${state.status}; draft patch denied`);
  }

  private assertTransition(state: GoalState, next: GoalStatus): void {
    if (!ALLOWED_TRANSITIONS[state.status].includes(next)) throw new GoalTransitionError(state.id, state.status, next);
  }

  private assertNotTerminal(state: GoalState): void {
    if (TERMINAL_STATUSES.has(state.status)) throw new GoalStateError(state.id, `Goal ${state.id} is terminal: ${state.status}`);
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
