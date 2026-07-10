import { resolve } from "node:path";

import type { GoalState, GoalWorktree } from "@archcode/protocol";

import { managedWorktreeNames, WorktreeService, WorktreeServiceError } from "../worktrees";

export interface GoalWorkspaceStateManager {
  read(goalId: string): Promise<GoalState>;
  setWorktree(goalId: string, worktree: GoalWorktree): Promise<GoalState>;
}

export interface GoalWorkspaceServiceOptions {
  readonly canonicalRoot: string;
  readonly goalStateManager: GoalWorkspaceStateManager;
  readonly worktreeService?: Pick<WorktreeService, "create" | "findManaged" | "validateManagedClaim" | "remove">;
}

export interface PreparedGoalWorkspace {
  readonly cwd: string;
  readonly goal: GoalState;
}

export class GoalWorkspaceError extends Error {
  constructor(
    public readonly goalId: string,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GoalWorkspaceError";
  }
}

const goalWorkspaceClaimLocks = new Map<string, Promise<void>>();

export class GoalWorkspaceService {
  readonly #canonicalRoot: string;
  readonly #goalStateManager: GoalWorkspaceStateManager;
  readonly #worktrees: Pick<WorktreeService, "create" | "findManaged" | "validateManagedClaim" | "remove">;

  constructor(options: GoalWorkspaceServiceOptions) {
    this.#canonicalRoot = resolve(options.canonicalRoot);
    this.#goalStateManager = options.goalStateManager;
    this.#worktrees = options.worktreeService ?? new WorktreeService({ canonicalRoot: this.#canonicalRoot });
  }

  async prepare(goalId: string): Promise<PreparedGoalWorkspace> {
    return await withGoalWorkspaceClaimLock(`${this.#canonicalRoot}\0${goalId}`, async () => await this.#prepareLocked(goalId));
  }

  async #prepareLocked(goalId: string): Promise<PreparedGoalWorkspace> {
    const goal = await this.#goalStateManager.read(goalId);
    if (goal.useWorktree !== true) return { cwd: this.#canonicalRoot, goal };
    const owner = { type: "goal" as const, id: goal.id };
    const expectedBranch = managedWorktreeNames({ owner }).branchName;

    if (goal.worktree !== undefined) {
      return await this.#validatePersisted(goal, expectedBranch);
    }

    const recoverable = await this.#adoptManaged(goal, owner, expectedBranch);
    if (recoverable !== undefined) return recoverable;

    let created: Awaited<ReturnType<WorktreeService["create"]>>;
    try {
      created = await this.#worktrees.create({
        owner,
        label: goal.title ?? undefined,
        requireCleanCanonical: true,
      });
    } catch (error) {
      if (error instanceof WorktreeServiceError && error.code === "WORKTREE_PATH_EXISTS") {
        const concurrent = await this.#recoverConcurrentClaim(goalId, owner, expectedBranch);
        if (concurrent !== undefined) return concurrent;
      }
      throw error;
    }
    const worktree: GoalWorktree = {
      path: created.worktreePath,
      branchName: created.branchName,
      baseSha: created.baseSha,
      createdAt: new Date().toISOString(),
    };

    try {
      const updated = await this.#goalStateManager.setWorktree(goal.id, worktree);
      return { cwd: created.worktreePath, goal: updated };
    } catch (error) {
      let rollbackError: unknown;
      try {
        const rollback = await this.#worktrees.remove({
          path: created.worktreePath,
          branchName: created.branchName,
          baseSha: created.baseSha,
        });
        if (!rollback.branchDeleted) {
          rollbackError = new WorktreeServiceError(
            "GIT_COMMAND_FAILED",
            "Goal worktree rollback detached the worktree but could not delete its branch",
            {
              branchName: created.branchName,
              warning: rollback.warning,
            },
          );
        }
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }
      throw new GoalWorkspaceError(
        goalId,
        rollbackError === undefined
          ? "Failed to persist the Goal worktree"
          : "Failed to persist the Goal worktree and fully roll back its Git resources",
        rollbackError === undefined ? error : new AggregateError([error, rollbackError]),
      );
    }
  }

  async #recoverConcurrentClaim(
    goalId: string,
    owner: { readonly type: "goal"; readonly id: string },
    expectedBranch: string,
  ): Promise<PreparedGoalWorkspace | undefined> {
    const latest = await this.#goalStateManager.read(goalId);
    if (latest.useWorktree !== true) return { cwd: this.#canonicalRoot, goal: latest };
    if (latest.worktree !== undefined) return await this.#validatePersisted(latest, expectedBranch);
    return await this.#adoptManaged(latest, owner, expectedBranch);
  }

  async #validatePersisted(goal: GoalState, expectedBranch: string): Promise<PreparedGoalWorkspace> {
    if (goal.worktree === undefined) throw new GoalWorkspaceError(goal.id, "Goal worktree metadata is missing");
    const claim = await this.#worktrees.validateManagedClaim({
      path: goal.worktree.path,
      branchName: expectedBranch,
      mode: "persisted",
      baseSha: goal.worktree.baseSha,
    });
    const existing = claim.worktree;
    if (
      !existing.isManaged
      || existing.path !== goal.worktree.path
      || existing.branchName !== expectedBranch
      || goal.worktree.branchName !== expectedBranch
    ) {
      throw new GoalWorkspaceError(goal.id, "Persisted Goal worktree no longer matches its managed branch");
    }
    return { cwd: existing.path, goal };
  }

  async #adoptManaged(
    goal: GoalState,
    owner: { readonly type: "goal"; readonly id: string },
    expectedBranch: string,
  ): Promise<PreparedGoalWorkspace | undefined> {
    const recoverable = await this.#worktrees.findManaged({ owner });
    if (recoverable === undefined) return undefined;
    if (!recoverable.isManaged || recoverable.branchName !== expectedBranch) {
      throw new GoalWorkspaceError(goal.id, "Recoverable Goal worktree is missing its expected branch or HEAD");
    }
    const claim = await this.#worktrees.validateManagedClaim({
      path: recoverable.path,
      branchName: expectedBranch,
      mode: "orphan",
    });
    const worktree: GoalWorktree = {
      path: claim.worktree.path,
      branchName: expectedBranch,
      baseSha: claim.baseSha,
      createdAt: new Date().toISOString(),
    };
    try {
      const updated = await this.#goalStateManager.setWorktree(goal.id, worktree);
      return { cwd: claim.worktree.path, goal: updated };
    } catch (error) {
      throw new GoalWorkspaceError(goal.id, "Failed to adopt the existing Goal worktree", error);
    }
  }
}

async function withGoalWorkspaceClaimLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = goalWorkspaceClaimLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const chained = previous.then(() => current, () => current);
  goalWorkspaceClaimLocks.set(key, chained);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (goalWorkspaceClaimLocks.get(key) === chained) goalWorkspaceClaimLocks.delete(key);
  }
}

export function isGoalWorkspaceError(error: unknown): error is GoalWorkspaceError | WorktreeServiceError {
  return error instanceof GoalWorkspaceError || error instanceof WorktreeServiceError;
}
