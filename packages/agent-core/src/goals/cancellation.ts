import type { GoalState, HitlOwnerKey } from "@archcode/protocol";

import type { SessionFamilyController, SessionFamilyStopLease } from "../execution/session-family-control";
import { deleteSessionHitlCheckpointFile } from "../execution/session-hitl-checkpoint";
import type { HitlService } from "../hitl/service";
import type { SessionStoreManager } from "../store/session-store-manager";
import {
  abortGoalCancellationIntent,
  beginGoalCancellationIntent,
  commitGoalCancellationIntent,
  completeGoalCancellationIntent,
  type GoalCancellationIntent,
} from "./execution-claim";
import type { GoalStateManager } from "./state";
import { collectSessionTreeIds } from "../execution/session-tree";

export type GoalCancellationSource = "http" | "agent" | "hitl";

export interface GoalCancellationRequest {
  readonly reason?: string;
  readonly source: GoalCancellationSource;
  readonly selfSessionId?: string;
  readonly hitlId?: string;
}

export interface GoalCancellationCapability {
  cancel(goalId: string, request: GoalCancellationRequest): Promise<GoalState>;
}

export interface GoalCancellationServiceOptions {
  readonly workspaceRoot: string;
  readonly goalStateManager: GoalStateManager;
  readonly hitlService: HitlService;
  readonly sessionStoreManager: SessionStoreManager;
  readonly sessionFamilyController: SessionFamilyController;
  readonly cleanupOperations?: GoalCancellationCleanupOperations;
}

export interface GoalCancellationCleanupOperations {
  cancelOwner(owner: HitlOwnerKey, reason: string): Promise<unknown>;
  deleteSessionCheckpoint(workspaceRoot: string, sessionId: string): Promise<void>;
  clearSessionHitlBlockers(sessionId: string, workspaceRoot: string): Promise<void>;
}

interface PreparedGoalCancellation {
  readonly goal: GoalState;
  readonly stopLeases: readonly SessionFamilyStopLease[];
}

export class GoalCancellationError extends Error {
  readonly code: string = "GOAL_CANCELLATION_FAILED";

  constructor(
    public readonly goalId: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoalCancellationError";
  }
}

export class GoalCancellationCleanupError extends GoalCancellationError {
  readonly code = "GOAL_CANCELLATION_CLEANUP_FAILED";

  constructor(
    goalId: string,
    public readonly goal: GoalState,
    cause: unknown,
  ) {
    super(
      goalId,
      `Goal ${goalId} is durably cancelled but its owner cleanup is incomplete: ${errorMessage(cause)}`,
      cause,
    );
    this.name = "GoalCancellationCleanupError";
  }
}

/** Stop proof, durable cancelled tombstone, then idempotent owner cleanup. */
export class GoalCancellationService implements GoalCancellationCapability {
  readonly #workspaceRoot: string;
  readonly #goalStateManager: GoalStateManager;
  readonly #hitlService: HitlService;
  readonly #sessionStoreManager: SessionStoreManager;
  readonly #sessionFamilyController: SessionFamilyController;
  readonly #cleanup: GoalCancellationCleanupOperations;

  constructor(options: GoalCancellationServiceOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#goalStateManager = options.goalStateManager;
    this.#hitlService = options.hitlService;
    this.#sessionStoreManager = options.sessionStoreManager;
    this.#sessionFamilyController = options.sessionFamilyController;
    this.#cleanup = options.cleanupOperations ?? {
      cancelOwner: (owner, reason) => this.#hitlService.cancelOwner(owner, reason),
      deleteSessionCheckpoint: deleteSessionHitlCheckpointFile,
      clearSessionHitlBlockers: (sessionId, workspaceRoot) => (
        this.#sessionStoreManager.clearHitlBlockers(sessionId, workspaceRoot)
      ),
    };
  }

  async cancel(goalId: string, request: GoalCancellationRequest): Promise<GoalState> {
    let intent: GoalCancellationIntent<PreparedGoalCancellation> | undefined;
    let committedGoal: GoalState | undefined;
    try {
      intent = await beginGoalCancellationIntent(goalId, async () => {
        const goal = await this.#goalStateManager.read(goalId);
        this.#assertCanCancel(goal, request.source);
        const stopLeases = await this.#acquireFamilyStops(goal, request.selfSessionId);
        return { goal, stopLeases };
      });

      const stopResults = await Promise.allSettled(intent.value.stopLeases.map((lease) => lease.stopAndWait()));
      const stopFailures = stopResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (stopFailures.length === 1) throw stopFailures[0];
      if (stopFailures.length > 1) {
        throw new GoalCancellationError(
          goalId,
          `Goal ${goalId} cannot stop every Session family: ${stopFailures.map(errorMessage).join("; ")}`,
          new AggregateError(stopFailures),
        );
      }
      const sessionIds = await this.#sessionIds(intent.value.goal, intent.value.stopLeases.map((lease) => lease.rootSessionId));
      committedGoal = intent.value.goal.status === "cancelled"
        ? intent.value.goal
        : await commitGoalCancellationIntent(intent, () => (
          this.#goalStateManager.cancel(goalId, request.reason, request.hitlId)
        ));

      await this.#cleanupDurableOwners(committedGoal, sessionIds);
      return await completeGoalCancellationIntent(intent, async () => committedGoal!);
    } catch (error) {
      if (intent !== undefined) await abortGoalCancellationIntent(intent);
      if (committedGoal !== undefined && !(error instanceof GoalCancellationCleanupError)) {
        throw new GoalCancellationCleanupError(goalId, committedGoal, error);
      }
      throw error;
    } finally {
      for (const lease of [...(intent?.value.stopLeases ?? [])].reverse()) lease.release();
    }
  }

  #assertCanCancel(goal: GoalState, _source: GoalCancellationSource): void {
    if (goal.status === "cancelled") return;
    if (goal.status === "done") {
      throw new GoalCancellationError(goal.id, `Goal ${goal.id} cannot cancel from ${goal.status}`);
    }
  }

  async #acquireFamilyStops(goal: GoalState, selfSessionId: string | undefined): Promise<SessionFamilyStopLease[]> {
    const persistedGoalRootIds = (await this.#sessionStoreManager.listSessionSummaries(this.#workspaceRoot))
      .filter((session) => session.goalId === goal.id)
      .map((session) => session.rootSessionId);
    const declaredSessionIds = [...new Set([
      ...(goal.mainSessionId === undefined ? [] : [goal.mainSessionId]),
      ...goal.childSessionIds,
      ...persistedGoalRootIds,
      ...(selfSessionId === undefined ? [] : [selfSessionId]),
    ])].sort();
    const files = await Promise.all(declaredSessionIds.map((sessionId) => (
      this.#sessionStoreManager.getSessionFile(this.#workspaceRoot, sessionId)
    )));
    const selfRootSessionId = selfSessionId === undefined
      ? undefined
      : files.find((file) => file.sessionId === selfSessionId)?.rootSessionId;
    if (selfSessionId !== undefined && selfRootSessionId === undefined) {
      throw new GoalCancellationError(goal.id, `Cannot resolve self-cancelling Session ${selfSessionId}`);
    }
    const rootSessionIds = [...new Set(files.map((file) => file.rootSessionId))].sort();
    const leases: SessionFamilyStopLease[] = [];
    try {
      for (const rootSessionId of rootSessionIds) {
        leases.push(this.#sessionFamilyController.acquireStop({
          workspaceRoot: this.#workspaceRoot,
          rootSessionId,
          ...(selfSessionId !== undefined && selfRootSessionId === rootSessionId ? { exemptSessionId: selfSessionId } : {}),
        }));
      }
      return leases;
    } catch (error) {
      for (const lease of leases.reverse()) lease.release();
      throw error;
    }
  }

  async #sessionIds(goal: GoalState, rootSessionIds: readonly string[]): Promise<string[]> {
    const sessionIds = new Set(goal.childSessionIds);
    if (goal.mainSessionId !== undefined) sessionIds.add(goal.mainSessionId);
    for (const rootSessionId of rootSessionIds) {
      try {
        const tree = await this.#sessionStoreManager.buildSessionTree(this.#workspaceRoot, rootSessionId);
        collectSessionTreeIds(tree.root).forEach((sessionId) => sessionIds.add(sessionId));
      } catch (error) {
        throw new GoalCancellationError(
          goal.id,
          `Goal ${goal.id} cannot verify its Session family before cancellation`,
          error,
        );
      }
    }
    const sorted = [...sessionIds].sort();
    try {
      await Promise.all(sorted.map((sessionId) => (
        this.#sessionStoreManager.getSessionFile(this.#workspaceRoot, sessionId)
      )));
    } catch (error) {
      throw new GoalCancellationError(goal.id, `Goal ${goal.id} cannot load every owned Session before cancellation`, error);
    }
    return sorted;
  }

  async #cleanupDurableOwners(goal: GoalState, sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await this.#cleanup.cancelOwner({
        projectSlug: goal.projectId,
        ownerType: "session",
        ownerId: sessionId,
      }, "goal_cancelled");
      await this.#cleanup.deleteSessionCheckpoint(this.#workspaceRoot, sessionId);
      await this.#cleanup.clearSessionHitlBlockers(sessionId, this.#workspaceRoot);
    }
    await this.#cleanup.cancelOwner({
      projectSlug: goal.projectId,
      ownerType: "goal",
      ownerId: goal.id,
    }, "goal_cancelled");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
