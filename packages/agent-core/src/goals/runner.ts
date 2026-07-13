import { resolve } from "node:path";

import type { GoalBudgetSummary, GoalEvidenceRef, GoalReviewVerdict, GoalState } from "@archcode/protocol";

import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { SessionFile } from "../store/helpers";
import type { CreateSessionOptions } from "../store/session-store-manager";
import type { WorktreeService } from "../worktrees";
import { withGoalExecutionClaimLock } from "./execution-claim";
import { buildGoalContinuationPrompt } from "./goal-lead-continuation";
import type {
  GoalFinalizeReviewInput,
  GoalManualBlockerInput,
  GoalReviewerAuthorization,
  GoalStateManager,
} from "./state";
import { GoalWorkspaceService } from "./workspace";

export interface GoalRunnerCreateInput {
  readonly projectId: string;
  readonly createdFromSessionId: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly useWorktree?: boolean;
}

export interface GoalRunnerOptions {
  readonly goalStateManager: GoalStateManager;
  readonly workspaceRoot: string;
  readonly readSourceSession: (workspaceRoot: string, sessionId: string) => Promise<SessionFile>;
  readonly ensureSessionFile: (
    workspaceRoot: string,
    sessionId: string,
    options: CreateSessionOptions,
  ) => Promise<SessionFile>;
  readonly startCheckedExecutionWithinGoalClaim: (
    input: StartSessionExecutionInput,
  ) => Promise<ActiveSessionExecution>;
  readonly onGoalCommitted?: (goal: GoalState) => void | Promise<void>;
  readonly worktreeService?: Pick<WorktreeService, "create" | "findManaged" | "validateManagedClaim" | "remove">;
}

export interface GoalRunnerFinalizeInput {
  readonly expectedReviewGeneration: number;
  readonly verdict: GoalReviewVerdict;
  readonly summary: string;
  readonly evidenceRefs?: readonly GoalEvidenceRef[];
  readonly unresolvedItems?: readonly string[];
  readonly finalSummary?: string;
  readonly authorization: GoalReviewerAuthorization;
}

export type GoalActivationOutcome = "started" | "already_started" | "busy" | "capacity" | "pending" | "failed" | "ineligible";

export class GoalRunnerError extends Error {
  constructor(
    public readonly goalId: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoalRunnerError";
  }
}

export class GoalSourceSessionError extends Error {
  constructor(
    public readonly sourceSessionId: string,
    message: string,
  ) {
    super(message);
    this.name = "GoalSourceSessionError";
  }
}

export class GoalRunner {
  readonly #goalStateManager: GoalStateManager;
  readonly #workspaceRoot: string;
  readonly #workspaceService: GoalWorkspaceService;

  constructor(private readonly options: GoalRunnerOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#workspaceService = new GoalWorkspaceService({
      canonicalRoot: this.#workspaceRoot,
      goalStateManager: options.goalStateManager,
      ...(options.worktreeService === undefined ? {} : { worktreeService: options.worktreeService }),
    });
  }

  async create(input: GoalRunnerCreateInput): Promise<GoalState> {
    const source = await this.options.readSourceSession(this.#workspaceRoot, input.createdFromSessionId);
    assertCreationSource(source, input.createdFromSessionId);

    const goalId = crypto.randomUUID();
    const mainSessionId = crypto.randomUUID();
    const committed = await this.#goalStateManager.commit({
      id: goalId,
      projectId: input.projectId,
      createdFromSessionId: input.createdFromSessionId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      mainSessionId,
      ...(input.useWorktree === undefined ? {} : { useWorktree: input.useWorktree }),
    });
    try {
      await this.options.onGoalCommitted?.(committed);
    } finally {
      await this.activate(goalId);
    }
    return await this.#goalStateManager.read(goalId);
  }

  async activate(goalId: string): Promise<GoalActivationOutcome> {
    return await withGoalExecutionClaimLock(goalId, async () => {
      const goal = await this.#goalStateManager.read(goalId);
      if (goal.status !== "running") return "ineligible";
      try {
        const prepared = await this.#workspaceService.prepare(goal.id);
        const session = await this.options.ensureSessionFile(this.#workspaceRoot, goal.mainSessionId, {
          agentName: "goal_lead",
          rootSessionId: goal.mainSessionId,
          goalId: goal.id,
          sessionRole: "main",
          cwd: prepared.cwd,
        });
        assertGoalMainSession(goal, session, prepared.cwd);

        const executionId = initialExecutionId(goal.id);
        if (session.executions.some((execution) => execution.id === executionId)) return "already_started";
        await this.options.startCheckedExecutionWithinGoalClaim({
          slug: goal.projectId,
          workspaceRoot: this.#workspaceRoot,
          sessionId: goal.mainSessionId,
          userMessage: buildGoalContinuationPrompt(goal),
          executionId,
        });
        return "started";
      } catch (error) {
        if (isBusyError(error)) return "busy";
        if (isCapacityError(error)) return "capacity";
        if (!isPermanentActivationError(error)) return "pending";
        await this.#goalStateManager.fail(goal.id, error instanceof Error ? error : String(error));
        return "failed";
      }
    });
  }

  async reconcile(): Promise<void> {
    const goals = await this.#goalStateManager.listGoals();
    for (const goal of goals) {
      if (goal.status === "running") await this.activate(goal.id);
    }
  }

  async block(goalId: string, blocker: GoalManualBlockerInput): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.block(goalId, blocker));
  }

  async clearBlocker(goalId: string, hitlId?: string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.clearBlocker(goalId, hitlId));
  }

  async beginReview(goalId: string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.beginReview(goalId));
  }

  async finalizeReview(goalId: string, input: GoalRunnerFinalizeInput): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => (
      this.#goalStateManager.finalizeReview(goalId, input satisfies GoalFinalizeReviewInput)
    ));
  }

  async retry(goalId: string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, async () => {
      const current = await this.#goalStateManager.read(goalId);
      const prepared = await this.#workspaceService.prepare(goalId);
      const session = await this.options.ensureSessionFile(this.#workspaceRoot, current.mainSessionId, {
        agentName: "goal_lead",
        rootSessionId: current.mainSessionId,
        goalId: current.id,
        sessionRole: "main",
        cwd: prepared.cwd,
      });
      assertGoalMainSession(current, session, prepared.cwd);
      return await this.#goalStateManager.retry(goalId);
    });
  }

  async fail(goalId: string, error: Error | string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.fail(goalId, error));
  }

  async cancel(goalId: string, reason?: string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.cancel(goalId, reason));
  }

  async addChildSession(goalId: string, sessionId: string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.addChildSession(goalId, sessionId));
  }

  async updateBudgetSummary(goalId: string, budget: GoalBudgetSummary): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.updateBudgetSummary(goalId, budget));
  }
}

function assertCreationSource(session: SessionFile, sourceSessionId: string): void {
  const valid = session.sessionId === sourceSessionId
    && session.rootSessionId === sourceSessionId
    && session.parentSessionId === undefined
    && session.goalId === undefined
    && session.agentName === "engineer"
    && (session.sessionRole === undefined || session.sessionRole === "standalone");
  if (!valid) {
    throw new GoalSourceSessionError(
      sourceSessionId,
      `Goal creation requires a same-project ordinary Engineer root Session: ${sourceSessionId}`,
    );
  }
}

function assertGoalMainSession(goal: GoalState, session: SessionFile, expectedCwd: string): void {
  if (
    session.sessionId !== goal.mainSessionId
    || session.rootSessionId !== goal.mainSessionId
    || session.parentSessionId !== undefined
    || session.goalId !== goal.id
    || session.agentName !== "goal_lead"
    || session.sessionRole !== "main"
    || resolve(session.cwd) !== resolve(expectedCwd)
  ) {
    throw new GoalRunnerError(goal.id, `Goal main Session identity conflict: ${goal.mainSessionId}`);
  }
}

function initialExecutionId(goalId: string): string {
  return `goal-initial:${goalId}`;
}

function isBusyError(error: unknown): boolean {
  return error instanceof Error && ["AgentRunningError", "SessionFamilyActiveError"].includes(error.name);
}

function isCapacityError(error: unknown): boolean {
  return error instanceof Error && ["ConcurrentLimitError", "ConcurrentSessionLimitError"].includes(error.name);
}

function isPermanentActivationError(error: unknown): boolean {
  return error instanceof Error && [
    "GoalRunnerError",
    "GoalWorkspaceError",
    "SessionFileIdentityConflictError",
    "WorktreeServiceError",
  ].includes(error.name);
}
