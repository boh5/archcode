import type {
  GoalBlocker,
  GoalBudgetSummary,
  GoalEvidenceRef,
  GoalReviewVerdict,
  GoalState,
} from "@archcode/protocol";

import type {
  GoalCreateInput,
  GoalDraftPatch,
  GoalFinalizeReviewInput,
  GoalReviewerAuthorization,
  GoalStateManager,
} from "./state";
import type { SessionRole } from "../store/types";

export interface GoalRunnerCreateSessionOptions {
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: SessionRole;
  readonly title?: string;
}

export interface GoalRunnerOptions {
  readonly goalStateManager: GoalStateManager;
  readonly createSession?: (options?: GoalRunnerCreateSessionOptions) => Promise<string>;
  readonly isSessionActive?: (sessionId: string) => Promise<boolean>;
  readonly workspaceRoot?: string;
  readonly hitlService?: unknown;
}

export interface GoalRunnerFinalizeInput {
  readonly verdict: GoalReviewVerdict;
  readonly summary: string;
  readonly evidenceRefs?: readonly GoalEvidenceRef[];
  readonly unresolvedItems?: readonly string[];
  readonly finalSummary?: string;
  readonly authorization: GoalReviewerAuthorization;
}

export class GoalRunnerError extends Error {
  constructor(
    public readonly goalId: string,
    message: string,
  ) {
    super(message);
    this.name = "GoalRunnerError";
  }
}

const goalClaimLocks = new Map<string, Promise<void>>();

export class GoalRunner {
  readonly #goalStateManager: GoalStateManager;
  readonly #createSession?: (options?: GoalRunnerCreateSessionOptions) => Promise<string>;

  constructor(options: GoalRunnerOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#createSession = options.createSession;
  }

  async create(input: GoalCreateInput): Promise<GoalState> {
    return this.#goalStateManager.create(input);
  }

  async patchDraft(goalId: string, updates: GoalDraftPatch): Promise<GoalState> {
    return this.#goalStateManager.patchDraft(goalId, updates);
  }

  async start(goalId: string, input: { readonly mainSessionId?: string; readonly loopId?: string; readonly sessionTitle?: string } = {}): Promise<GoalState> {
    return withGoalClaimLock(goalId, async () => {
      const current = await this.#goalStateManager.read(goalId);
      const mainSessionId = input.mainSessionId ?? current.mainSessionId ?? await this.createMainSession(goalId, current.title, input);
      if (current.status === "running" && current.mainSessionId === mainSessionId) return current;
      return this.#goalStateManager.start(goalId, { mainSessionId, loopId: input.loopId });
    });
  }

  async block(goalId: string, blocker: Omit<GoalBlocker, "createdAt"> & { readonly createdAt?: string }): Promise<GoalState> {
    return this.#goalStateManager.block(goalId, blocker);
  }

  async clearBlocker(goalId: string, hitlId?: string): Promise<GoalState> {
    return this.#goalStateManager.clearBlocker(goalId, hitlId);
  }

  async beginReview(goalId: string): Promise<GoalState> {
    return this.#goalStateManager.beginReview(goalId);
  }

  async finalizeReview(goalId: string, input: GoalRunnerFinalizeInput): Promise<GoalState> {
    return this.#goalStateManager.finalizeReview(goalId, input satisfies GoalFinalizeReviewInput);
  }

  async retry(goalId: string, input: { readonly mainSessionId?: string; readonly sessionTitle?: string } = {}): Promise<GoalState> {
    return withGoalClaimLock(goalId, async () => {
      const current = await this.#goalStateManager.read(goalId);
      const mainSessionId = input.mainSessionId ?? await this.createMainSession(goalId, current.title, input);
      return this.#goalStateManager.retry(goalId, { mainSessionId });
    });
  }

  async fail(goalId: string, error: Error | string): Promise<GoalState> {
    return this.#goalStateManager.fail(goalId, error);
  }

  async cancel(goalId: string, reason?: string): Promise<GoalState> {
    return this.#goalStateManager.cancel(goalId, reason);
  }

  async addChildSession(goalId: string, sessionId: string): Promise<GoalState> {
    return this.#goalStateManager.addChildSession(goalId, sessionId);
  }

  async setMainSession(goalId: string, sessionId: string): Promise<GoalState> {
    return this.#goalStateManager.setMainSession(goalId, sessionId);
  }

  async updateBudgetSummary(goalId: string, budget: GoalBudgetSummary): Promise<GoalState> {
    return this.#goalStateManager.updateBudgetSummary(goalId, budget);
  }

  async recordHitlRef(goalId: string, input: { readonly hitlId: string; readonly approvalRef?: string }): Promise<GoalState> {
    return this.#goalStateManager.recordHitlRef(goalId, input);
  }

  private async createMainSession(
    goalId: string,
    title: string,
    input: { readonly loopId?: string; readonly sessionTitle?: string },
  ): Promise<string> {
    if (this.#createSession === undefined) throw new GoalRunnerError(goalId, "Goal runner cannot create a main session");
    return this.#createSession({
      goalId,
      loopId: input.loopId,
      sessionRole: "main",
      title: input.sessionTitle ?? `Goal: ${title}`,
    });
  }
}

async function withGoalClaimLock<T>(goalId: string, action: () => Promise<T>): Promise<T> {
  const previous = goalClaimLocks.get(goalId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolveRelease) => {
    release = resolveRelease;
  });
  goalClaimLocks.set(goalId, previous.then(() => current, () => current));

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (goalClaimLocks.get(goalId) === current) goalClaimLocks.delete(goalId);
  }
}
