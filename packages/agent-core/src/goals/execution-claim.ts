const goalExecutionClaimLocks = new Map<string, Promise<void>>();
const goalCancellationIntents = new Map<string, symbol>();

export class GoalCancellationInProgressError extends Error {
  readonly code = "GOAL_CANCELLATION_IN_PROGRESS";

  constructor(public readonly goalId: string) {
    super(`Goal ${goalId} is being cancelled`);
    this.name = "GoalCancellationInProgressError";
  }
}

export interface GoalCancellationIntent<T> {
  readonly goalId: string;
  readonly token: symbol;
  readonly value: T;
}

/**
 * Serializes the complete Goal execution claim across every in-process entry
 * point: workspace preparation, Session reservation, and lifecycle transition.
 * Goal ids are UUIDs, so they form one stable key even when callers reach the
 * same project through different service instances.
 */
export async function withGoalExecutionClaimLock<T>(goalId: string, action: () => Promise<T>): Promise<T> {
  return await withRawGoalExecutionClaimLock(goalId, async () => {
    if (goalCancellationIntents.has(goalId)) throw new GoalCancellationInProgressError(goalId);
    return await action();
  });
}

export async function beginGoalCancellationIntent<T>(
  goalId: string,
  prepare: () => Promise<T>,
): Promise<GoalCancellationIntent<T>> {
  return await withRawGoalExecutionClaimLock(goalId, async () => {
    if (goalCancellationIntents.has(goalId)) throw new GoalCancellationInProgressError(goalId);
    const value = await prepare();
    const token = Symbol(`goal-cancellation:${goalId}`);
    goalCancellationIntents.set(goalId, token);
    return { goalId, token, value };
  });
}

export async function completeGoalCancellationIntent<T>(
  intent: Pick<GoalCancellationIntent<unknown>, "goalId" | "token">,
  commit: () => Promise<T>,
): Promise<T> {
  return await withRawGoalExecutionClaimLock(intent.goalId, async () => {
    if (goalCancellationIntents.get(intent.goalId) !== intent.token) {
      throw new GoalCancellationInProgressError(intent.goalId);
    }
    try {
      return await commit();
    } finally {
      if (goalCancellationIntents.get(intent.goalId) === intent.token) goalCancellationIntents.delete(intent.goalId);
    }
  });
}

/** Persists the cancellation tombstone while retaining the mutation intent for cleanup. */
export async function commitGoalCancellationIntent<T>(
  intent: Pick<GoalCancellationIntent<unknown>, "goalId" | "token">,
  commit: () => Promise<T>,
): Promise<T> {
  return await withRawGoalExecutionClaimLock(intent.goalId, async () => {
    if (goalCancellationIntents.get(intent.goalId) !== intent.token) {
      throw new GoalCancellationInProgressError(intent.goalId);
    }
    return await commit();
  });
}

export async function abortGoalCancellationIntent(
  intent: Pick<GoalCancellationIntent<unknown>, "goalId" | "token">,
): Promise<void> {
  await withRawGoalExecutionClaimLock(intent.goalId, async () => {
    if (goalCancellationIntents.get(intent.goalId) === intent.token) goalCancellationIntents.delete(intent.goalId);
  });
}

async function withRawGoalExecutionClaimLock<T>(goalId: string, action: () => Promise<T>): Promise<T> {
  const previous = goalExecutionClaimLocks.get(goalId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  const chained = previous.then(() => current, () => current);
  goalExecutionClaimLocks.set(goalId, chained);

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (goalExecutionClaimLocks.get(goalId) === chained) goalExecutionClaimLocks.delete(goalId);
  }
}
