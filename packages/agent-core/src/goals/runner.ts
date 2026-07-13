import type {
  GoalBudgetSummary,
  GoalEvidenceRef,
  GoalReviewVerdict,
  GoalState,
} from "@archcode/protocol";
import { resolve } from "node:path";

import type {
  GoalCreateInput,
  GoalDraftPatch,
  GoalFinalizeReviewInput,
  GoalManualBlockerInput,
  GoalReviewerAuthorization,
  GoalStateManager,
} from "./state";
import type { SessionRole } from "../store/types";
import { withGoalExecutionClaimLock } from "./execution-claim";
import { goalExecutionStatusEligibility } from "./execution-policy";
import { GoalWorkspaceService } from "./workspace";
import type { WorktreeService } from "../worktrees";

export interface GoalRunnerCreateSessionOptions {
  readonly cwd?: string;
  readonly goalId?: string;
  readonly sessionRole?: SessionRole;
  readonly title?: string;
}

export interface GoalRunnerStartInput {
  readonly mainSessionId?: string;
  readonly sessionTitle?: string;
}

export interface GoalRunnerOptions {
  readonly goalStateManager: GoalStateManager;
  readonly createSession: (options?: GoalRunnerCreateSessionOptions) => Promise<string>;
  readonly getSessionCwd: (sessionId: string) => Promise<string | undefined>;
  readonly isSessionActive: (sessionId: string) => Promise<boolean>;
  readonly workspaceRoot: string;
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

export class GoalRunnerError extends Error {
  constructor(
    public readonly goalId: string,
    message: string,
  ) {
    super(message);
    this.name = "GoalRunnerError";
  }
}

export class GoalRunner {
  readonly #goalStateManager: GoalStateManager;
  readonly #createSession: (options?: GoalRunnerCreateSessionOptions) => Promise<string>;
  readonly #getSessionCwd: (sessionId: string) => Promise<string | undefined>;
  readonly #isSessionActive: (sessionId: string) => Promise<boolean>;
  readonly #workspaceRoot: string;
  readonly #workspaceService: GoalWorkspaceService;

  constructor(options: GoalRunnerOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#createSession = options.createSession;
    this.#getSessionCwd = options.getSessionCwd;
    this.#isSessionActive = options.isSessionActive;
    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#workspaceService = new GoalWorkspaceService({
      canonicalRoot: this.#workspaceRoot,
      goalStateManager: options.goalStateManager,
      ...(options.worktreeService === undefined ? {} : { worktreeService: options.worktreeService }),
    });
  }

  async create(input: GoalCreateInput): Promise<GoalState> {
    return this.#goalStateManager.create(input);
  }

  async patchDraft(goalId: string, updates: GoalDraftPatch): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.patchDraft(goalId, updates));
  }

  async start(goalId: string, input: GoalRunnerStartInput = {}): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, async () => {
      const current = await this.#goalStateManager.read(goalId);
      const eligibility = goalExecutionStatusEligibility("start", current.status);
      if (eligibility === "reject") {
        throw new GoalRunnerError(goalId, `Goal ${goalId} cannot start from ${current.status}`);
      }
      const requestedSessionId = input.mainSessionId ?? current.mainSessionId;
      if (eligibility === "running_claim" && (
        requestedSessionId === undefined
        || current.mainSessionId !== requestedSessionId
      )) {
        throw new GoalRunnerError(goalId, `Running Goal ${goalId} is claimed by ${current.mainSessionId ?? "no main Session"}`);
      }
      const cwd = await this.resolveExecutionCwd(current);
      if (requestedSessionId !== undefined) await this.assertSessionCwd(goalId, requestedSessionId, cwd);
      if (eligibility === "running_claim") return current;
      const mainSessionId = requestedSessionId ?? await this.createMainSession(goalId, { ...input, cwd });
      return this.#goalStateManager.start(goalId, { mainSessionId });
    });
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
      const eligibility = goalExecutionStatusEligibility("retry", current.status);
      if (eligibility === "reject") {
        throw new GoalRunnerError(goalId, `Goal ${goalId} cannot retry from ${current.status}`);
      }
      if (eligibility === "running_claim") {
        const runningSessionId = current.mainSessionId;
        if (
          runningSessionId === undefined
          || !(await this.#isSessionActive(runningSessionId))
        ) {
          throw new GoalRunnerError(goalId, `Running Goal ${goalId} can retry only through its active main Session`);
        }
        const cwd = await this.resolveExecutionCwd(current);
        await this.assertSessionCwd(goalId, runningSessionId, cwd);
        return current;
      }
      const mainSessionId = current.mainSessionId;
      if (mainSessionId === undefined) {
        throw new GoalRunnerError(goalId, `Goal ${goalId} cannot retry without its original main Session`);
      }
      const cwd = await this.resolveExecutionCwd(current);
      await this.assertSessionCwd(goalId, mainSessionId, cwd);
      return this.#goalStateManager.retry(goalId);
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

  async setMainSession(goalId: string, sessionId: string): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.setMainSession(goalId, sessionId));
  }

  async updateBudgetSummary(goalId: string, budget: GoalBudgetSummary): Promise<GoalState> {
    return withGoalExecutionClaimLock(goalId, () => this.#goalStateManager.updateBudgetSummary(goalId, budget));
  }

  private async createMainSession(
    goalId: string,
    input: {
      readonly sessionTitle?: string;
      readonly cwd?: string;
    },
  ): Promise<string> {
    return this.#createSession({
      goalId,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      sessionRole: "main",
      ...(input.sessionTitle === undefined ? {} : { title: input.sessionTitle }),
    });
  }

  private async resolveExecutionCwd(goal: GoalState): Promise<string> {
    const prepared = await this.#workspaceService.prepare(goal.id);
    return prepared.cwd;
  }

  private async assertSessionCwd(
    goalId: string,
    sessionId: string,
    expectedCwd: string,
  ): Promise<void> {
    const actualCwd = await this.#getSessionCwd(sessionId);
    if (actualCwd !== expectedCwd) {
      throw new GoalRunnerError(goalId, `Session ${sessionId} cwd ${actualCwd ?? "unknown"} does not match Goal cwd ${expectedCwd}`);
    }
  }
}
