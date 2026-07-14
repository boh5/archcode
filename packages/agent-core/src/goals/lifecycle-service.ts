import { resolve } from "node:path";

import type { GoalEvidenceRef, GoalReviewVerdict, GoalState } from "@archcode/protocol";

import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { SessionFile } from "../store/helpers";
import type { CreateSessionOptions } from "../store/session-store-manager";
import type { WorktreeService } from "../worktrees";
import { withGoalExecutionClaimLock } from "./execution-claim";
import { buildGoalContinuationPrompt } from "./goal-lead-continuation";
import type {
  GoalFinalizeReviewInput,
  GoalReviewerAuthorization,
  GoalStateManager,
} from "./state";
import { GoalWorkspaceService } from "./workspace";

export interface GoalLifecycleCreateInput {
  readonly projectSlug: string;
  readonly createdFromSessionId: string;
  readonly objective: string;
  readonly acceptanceCriteria: string;
  readonly useWorktree?: boolean;
}

export interface GoalLifecycleServiceOptions {
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
  /** Creation-only side effect such as scheduling title generation. */
  readonly onCreated?: (goal: GoalState) => void | Promise<void>;
  readonly worktreeService?: Pick<WorktreeService, "create" | "findManaged" | "validateManagedClaim" | "remove">;
}

export interface GoalLifecycleFinalizeInput {
  readonly expectedReviewGeneration: number;
  readonly verdict: GoalReviewVerdict;
  readonly summary: string;
  readonly evidenceRefs?: readonly GoalEvidenceRef[];
  readonly unresolvedItems?: readonly string[];
  readonly finalSummary?: string;
  readonly authorization: GoalReviewerAuthorization;
}

export type GoalActivationOutcome = "started" | "already_started" | "busy" | "capacity" | "pending" | "failed" | "ineligible";

export class GoalLifecycleServiceError extends Error {
  constructor(
    public readonly goalId: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoalLifecycleServiceError";
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

export class GoalLifecycleService {
  readonly #goalStateManager: GoalStateManager;
  readonly #workspaceRoot: string;
  readonly #workspaceService: GoalWorkspaceService;

  constructor(private readonly options: GoalLifecycleServiceOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#workspaceService = new GoalWorkspaceService({
      canonicalRoot: this.#workspaceRoot,
      goalStateManager: options.goalStateManager,
      ...(options.worktreeService === undefined ? {} : { worktreeService: options.worktreeService }),
    });
  }

  async create(input: GoalLifecycleCreateInput): Promise<GoalState> {
    const source = await this.options.readSourceSession(this.#workspaceRoot, input.createdFromSessionId);
    assertCreationSource(source, input.createdFromSessionId);

    const goalId = crypto.randomUUID();
    const mainSessionId = crypto.randomUUID();
    const committed = await this.#goalStateManager.commit({
      id: goalId,
      projectSlug: input.projectSlug,
      createdFromSessionId: input.createdFromSessionId,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      mainSessionId,
      ...(input.useWorktree === undefined ? {} : { useWorktree: input.useWorktree }),
    });
    try {
      await this.options.onCreated?.(committed);
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
          slug: goal.projectSlug,
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

  async beginReview(goalId: string, assertReady?: () => Promise<void>): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, async () => {
      await assertReady?.();
      return await this.#goalStateManager.beginReview(goalId);
    });
  }

  async finalizeReview(goalId: string, input: GoalLifecycleFinalizeInput): Promise<GoalState> {
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
    throw new GoalLifecycleServiceError(goal.id, `Goal main Session identity conflict: ${goal.mainSessionId}`);
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
    "GoalLifecycleServiceError",
    "GoalWorkspaceError",
    "SessionFileIdentityConflictError",
    "WorktreeServiceError",
  ].includes(error.name);
}
