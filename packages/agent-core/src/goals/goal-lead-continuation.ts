import type { GoalState, SessionFamilyActivity } from "@archcode/protocol";

import { AgentRunningError } from "../agents/errors";
import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { ProjectContextResolver } from "../projects/context-resolver";
import type { SessionFile } from "../store/helpers";
import type { Logger } from "../logger";
import { withGoalExecutionClaimLock } from "./execution-claim";

export type GoalLeadContinuationTrigger = "family_idle" | "startup" | "kick";
export type GoalLeadContinuationOutcome = "started" | "ineligible" | "busy" | "capacity" | "backoff" | "shutdown" | "deduplicated";

export interface GoalLeadContinuationSessionRuntime {
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  getSessionFamilyActivity(workspaceRoot: string, rootSessionId: string): SessionFamilyActivity;
  listSessionFamilyToolBatchHitlIds(workspaceRoot: string, rootSessionId: string): Promise<string[]>;
  startCheckedExecutionWithinGoalClaim(input: StartSessionExecutionInput): Promise<ActiveSessionExecution>;
}

export interface GoalLeadContinuationOptions {
  readonly projectContextResolver: Pick<ProjectContextResolver, "resolve">;
  readonly sessionRuntime: GoalLeadContinuationSessionRuntime;
  readonly logger: Logger;
  readonly retryBaseDelayMs?: number;
}

export interface GoalLeadContinuationCoordinator {
  kick(workspaceRoot: string, goalId: string): Promise<GoalLeadContinuationOutcome>;
  reconcileWorkspace(workspaceRoot: string): Promise<void>;
  onFamilyIdle(workspaceRoot: string, rootSessionId: string): Promise<void>;
  releaseWorkspace(workspaceRoot: string): void;
  shutdown(): void;
}

/** Thin idle-to-next-turn bridge for direct Goal Lead Sessions. */
export class GoalLeadContinuationService implements GoalLeadContinuationCoordinator {
  readonly #inFlight = new Set<string>();
  readonly #capacityWaiters: string[] = [];
  readonly #failureBackoff = new Map<string, { executionId: string; attempt: number; dueAt: number; timer?: ReturnType<typeof setTimeout> }>();
  readonly #reconcileBackoff = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>();
  #shuttingDown = false;

  constructor(private readonly options: GoalLeadContinuationOptions) {}

  async kick(workspaceRoot: string, goalId: string): Promise<GoalLeadContinuationOutcome> {
    return await this.#evaluate(workspaceRoot, goalId, "kick");
  }

  async reconcileWorkspace(workspaceRoot: string): Promise<void> {
    await this.#reconcile(workspaceRoot, "startup");
  }

  shutdown(): void {
    this.#shuttingDown = true;
    for (const state of this.#failureBackoff.values()) if (state.timer !== undefined) clearTimeout(state.timer);
    this.#failureBackoff.clear();
    for (const state of this.#reconcileBackoff.values()) if (state.timer !== undefined) clearTimeout(state.timer);
    this.#reconcileBackoff.clear();
    this.#capacityWaiters.splice(0);
  }

  releaseWorkspace(workspaceRoot: string): void {
    const prefix = `${workspaceRoot}\0`;
    for (const [key, state] of this.#failureBackoff) {
      if (!key.startsWith(prefix)) continue;
      if (state.timer !== undefined) clearTimeout(state.timer);
      this.#failureBackoff.delete(key);
    }
    for (const [key, state] of this.#reconcileBackoff) {
      if (!key.startsWith(prefix)) continue;
      if (state.timer !== undefined) clearTimeout(state.timer);
      this.#reconcileBackoff.delete(key);
    }
    for (let index = this.#capacityWaiters.length - 1; index >= 0; index -= 1) {
      if (this.#capacityWaiters[index]!.startsWith(prefix)) this.#capacityWaiters.splice(index, 1);
    }
  }

  async #reconcile(workspaceRoot: string, trigger: GoalLeadContinuationTrigger, idleRootSessionId?: string): Promise<void> {
    if (this.#shuttingDown) return;
    const context = await this.options.projectContextResolver.resolve(workspaceRoot);
    const goals = (await context.goalState.listGoals(context.project.slug)).sort((left, right) => {
      const leftWaiter = this.#capacityWaiters.indexOf(goalKey(workspaceRoot, left.id));
      const rightWaiter = this.#capacityWaiters.indexOf(goalKey(workspaceRoot, right.id));
      if (leftWaiter >= 0 || rightWaiter >= 0) {
        if (leftWaiter < 0) return 1;
        if (rightWaiter < 0) return -1;
        return leftWaiter - rightWaiter;
      }
      return Number(right.mainSessionId === idleRootSessionId) - Number(left.mainSessionId === idleRootSessionId);
    });
    for (const goal of goals) {
      try {
        await this.#evaluate(workspaceRoot, goal.id, trigger);
        this.#clearReconcileBackoff(goalKey(workspaceRoot, goal.id));
      } catch (error) {
        this.#scheduleReconcileRetry(workspaceRoot, goal.id, trigger);
        this.options.logger.warn("goal.continuation.reconcile.failed", {
          error,
          context: { goalId: goal.id, trigger },
          meta: { workspaceRoot },
        });
      }
    }
  }

  async onFamilyIdle(workspaceRoot: string, rootSessionId: string): Promise<void> {
    await this.#reconcile(workspaceRoot, "family_idle", rootSessionId);
  }

  async #evaluate(
    workspaceRoot: string,
    goalId: string,
    trigger: GoalLeadContinuationTrigger,
  ): Promise<GoalLeadContinuationOutcome> {
    const key = goalKey(workspaceRoot, goalId);
    if (this.#shuttingDown) return "shutdown";
    if (this.#inFlight.has(key)) return "deduplicated";
    this.#inFlight.add(key);
    try {
      return await withGoalExecutionClaimLock(goalId, async () => {
        const context = await this.options.projectContextResolver.resolve(workspaceRoot);
        const goal = await context.goalState.read(goalId);
        const candidate = await this.#eligibleSession(workspaceRoot, goal);
        if (candidate === undefined) {
          this.#clearFailureBackoff(key);
          this.#removeCapacityWaiter(key);
          return "ineligible";
        }
        if (this.#shuttingDown) return "shutdown";
        const outcomeGate = this.#executionOutcomeGate(workspaceRoot, goalId, candidate.session, trigger);
        if (outcomeGate !== undefined) {
          this.#removeCapacityWaiter(key);
          return outcomeGate;
        }
        if (this.options.sessionRuntime.getSessionFamilyActivity(workspaceRoot, candidate.sessionId) !== "idle") {
          this.#removeCapacityWaiter(key);
          return "busy";
        }
        if ((await this.options.sessionRuntime.listSessionFamilyToolBatchHitlIds(workspaceRoot, candidate.sessionId)).length > 0) {
          this.#removeCapacityWaiter(key);
          return "ineligible";
        }
        if (this.#shuttingDown) {
          this.#removeCapacityWaiter(key);
          return "shutdown";
        }
        await this.options.sessionRuntime.startCheckedExecutionWithinGoalClaim({
          slug: candidate.projectSlug,
          workspaceRoot,
          sessionId: candidate.sessionId,
          userMessage: buildGoalContinuationPrompt(candidate.goal),
        });
        this.#removeCapacityWaiter(key);
        return "started";
      }).catch((error: unknown) => {
        if (error instanceof AgentRunningError || isFamilyBusyError(error)) {
          this.#removeCapacityWaiter(key);
          return "busy";
        }
        if (isCapacityError(error)) {
          this.#enqueueCapacityWaiter(key);
          return "capacity";
        }
        if (isToolBatchBlockedError(error)) {
          this.#removeCapacityWaiter(key);
          return "ineligible";
        }
        throw error;
      });
    } finally {
      this.#inFlight.delete(key);
    }
  }

  async #eligibleSession(
    workspaceRoot: string,
    goal: GoalState,
  ): Promise<{ readonly sessionId: string; readonly projectSlug: string; readonly goal: GoalState; readonly session: SessionFile } | undefined> {
    if (
      !isContinuableStatus(goal.status)
      || goal.budgetApproval !== undefined
      || goal.budget?.status === "blocked"
      || goal.mainSessionId === undefined
    ) return undefined;

    const session = await this.options.sessionRuntime.getSessionFile(workspaceRoot, goal.mainSessionId);
    if (
      session.sessionId !== goal.mainSessionId
      || session.rootSessionId !== goal.mainSessionId
      || session.parentSessionId !== undefined
      || session.goalId !== goal.id
      || session.sessionRole !== "main"
      || session.agentName !== "goal_lead"
    ) return undefined;
    return { sessionId: session.sessionId, projectSlug: goal.projectSlug, goal, session };
  }

  #executionOutcomeGate(
    workspaceRoot: string,
    goalId: string,
    session: SessionFile,
    trigger: GoalLeadContinuationTrigger,
  ): GoalLeadContinuationOutcome | undefined {
    if (trigger === "kick") return undefined;
    const execution = session.executions.at(-1);
    if (execution === undefined) return undefined;
    if (trigger === "family_idle" && ["aborted", "cancelled", "interrupted"].includes(execution.status)) {
      return "ineligible";
    }
    const key = `${workspaceRoot}\0${goalId}`;
    const current = this.#failureBackoff.get(key);
    if (execution.status !== "failed" && execution.status !== "timed_out") {
      this.#clearFailureBackoff(key);
      return undefined;
    }
    if (current?.executionId === execution.id && Date.now() >= current.dueAt) return undefined;
    if (current?.executionId === execution.id) return "backoff";
    if (current?.timer !== undefined) clearTimeout(current.timer);
    const attempt = (current?.attempt ?? 0) + 1;
    const delay = Math.min((this.options.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1), 30_000);
    const state: { executionId: string; attempt: number; dueAt: number; timer?: ReturnType<typeof setTimeout> } = {
      executionId: execution.id,
      attempt,
      dueAt: Date.now() + delay,
    };
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.#shuttingDown) return;
      void this.#reconcile(workspaceRoot, "family_idle").catch((error) => {
        this.options.logger.warn("goal.continuation.backoff.failed", { error, context: { goalId }, meta: { workspaceRoot } });
      });
    }, delay);
    this.#failureBackoff.set(key, state);
    return "backoff";
  }

  #clearFailureBackoff(key: string): void {
    const state = this.#failureBackoff.get(key);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    this.#failureBackoff.delete(key);
  }

  #scheduleReconcileRetry(
    workspaceRoot: string,
    goalId: string,
    trigger: GoalLeadContinuationTrigger,
  ): void {
    const key = goalKey(workspaceRoot, goalId);
    const current = this.#reconcileBackoff.get(key);
    if (current?.timer !== undefined || this.#shuttingDown) return;
    const attempt = (current?.attempt ?? 0) + 1;
    const delay = Math.min((this.options.retryBaseDelayMs ?? 1000) * 2 ** (attempt - 1), 30_000);
    const state: { attempt: number; timer?: ReturnType<typeof setTimeout> } = { attempt };
    state.timer = setTimeout(() => {
      state.timer = undefined;
      if (this.#shuttingDown) return;
      void this.#evaluate(workspaceRoot, goalId, trigger).then(
        () => this.#clearReconcileBackoff(key),
        (error) => {
          this.#scheduleReconcileRetry(workspaceRoot, goalId, trigger);
          this.options.logger.warn("goal.continuation.retry.failed", {
            error,
            context: { goalId, trigger },
            meta: { workspaceRoot, attempt },
          });
        },
      );
    }, delay);
    state.timer.unref?.();
    this.#reconcileBackoff.set(key, state);
  }

  #clearReconcileBackoff(key: string): void {
    const state = this.#reconcileBackoff.get(key);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    this.#reconcileBackoff.delete(key);
  }

  #enqueueCapacityWaiter(key: string): void {
    if (!this.#capacityWaiters.includes(key)) this.#capacityWaiters.push(key);
  }

  #removeCapacityWaiter(key: string): void {
    const index = this.#capacityWaiters.indexOf(key);
    if (index >= 0) this.#capacityWaiters.splice(index, 1);
  }
}

function goalKey(workspaceRoot: string, goalId: string): string {
  return `${workspaceRoot}\0${goalId}`;
}

export function buildGoalContinuationPrompt(goal: GoalState): string {
  const snapshot = {
    goalId: goal.id,
    objective: goal.objective,
    acceptanceCriteria: goal.acceptanceCriteria,
    status: goal.status,
    attempt: goal.attempt,
    reviewGeneration: goal.reviewGeneration,
    lastFailureSummary: goal.lastFailureSummary,
    review: goal.review === undefined ? undefined : {
      verdict: goal.review.verdict,
      summary: goal.review.summary,
      unresolvedItems: goal.review.unresolvedItems,
    },
    budgetApproval: goal.budgetApproval,
    budget: goal.budget,
  };
  return `Continue pursuing the bound Goal from this freshly loaded persisted snapshot:\n${JSON.stringify(snapshot, null, 2)}\n\nThis is a direct Goal continuation.\nKeep the original scope. If status is running, continue the work. If it is reviewing, coordinate a Reviewer and wait for reviewer evidence. If it is not_done, call goal_manage.retry before any Plan or Build delegation, then address the recorded unresolved items. Before stopping, audit whether the Goal is genuinely complete, blocked on HITL, or budget-limited, and persist the appropriate Goal transition.`;
}

function isContinuableStatus(status: GoalState["status"]): boolean {
  return status === "running" || status === "reviewing" || status === "not_done";
}

function isFamilyBusyError(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionFamilyActiveError";
}

function isCapacityError(error: unknown): boolean {
  return error instanceof Error && error.name === "ConcurrentSessionLimitError";
}

function isToolBatchBlockedError(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionToolBatchActiveError";
}
