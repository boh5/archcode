import type { DoneResult, GoalPhase, GoalState } from "@archcode/protocol";

import { GoalApprovalGate } from "../hitl/goal-gates";
import type { HitlKind, HitlPayload, HitlResponse, HitlTrigger } from "../hitl/types";
import type { GoalStateManager } from "./state";

type HitlGateway = {
  request(sessionId: string, kind: HitlKind, payload: HitlPayload, trigger: HitlTrigger): Promise<HitlResponse>;
  listPending(projectSlug?: string, goalId?: string, loopId?: string): unknown[];
};

export interface GoalRunnerOptions {
  goalStateManager: GoalStateManager;
  hitlService: HitlGateway;
  workspaceRoot: string;
  createSession: () => Promise<string>;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
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

const PHASE_ORDER: GoalPhase[] = ["plan", "build", "review"];
const goalClaimLocks = new Map<string, Promise<void>>();

export class GoalRunner {
  readonly #goalStateManager: GoalStateManager;
  readonly #hitlService: HitlGateway;
  readonly #approvalGate: GoalApprovalGate;
  readonly #workspaceRoot: string;
  readonly #createSession: () => Promise<string>;
  readonly #isSessionActive: (sessionId: string) => Promise<boolean>;

  constructor(options: GoalRunnerOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#hitlService = options.hitlService;
    this.#approvalGate = new GoalApprovalGate({
      hitlService: options.hitlService,
      goalStateManager: options.goalStateManager,
    });
    this.#workspaceRoot = options.workspaceRoot;
    this.#createSession = options.createSession;
    this.#isSessionActive = options.isSessionActive ?? (async () => false);
  }

  async start(goalId: string): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    const sessionId = current.mainSessionId ?? await this.#createSession();
    return this.claimStart(goalId, sessionId);
  }

  async claimStart(goalId: string, mainSessionId: string): Promise<GoalState> {
    return withGoalClaimLock(goalId, async () => this.#claimStartUnlocked(goalId, mainSessionId));
  }

  async #claimStartUnlocked(goalId: string, mainSessionId: string): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    if (current.status === "running") {
      if (current.mainSessionId === mainSessionId) return current;
      throw new GoalRunnerError(goalId, `Goal is already running in session ${current.mainSessionId ?? "unknown"}`);
    }
    if (current.status !== "locked" && current.status !== "paused") {
      throw new GoalRunnerError(goalId, `Cannot start goal from status ${current.status}`);
    }
    if (current.doneConditions.length === 0) {
      throw new GoalRunnerError(goalId, "Cannot start goal without done conditions");
    }
    if (current.mainSessionId !== undefined && current.mainSessionId !== mainSessionId) {
      throw new GoalRunnerError(goalId, `Goal is reserved for session ${current.mainSessionId}`);
    }

    const running = await this.#goalStateManager.transitionStatus(goalId, "running");
    const phaseReset = running.phase === "plan" ? running : await this.#goalStateManager.updatePhase(goalId, "plan");
    return this.#goalStateManager.updateSessionIds(phaseReset.id, mainSessionId, phaseReset.childSessionIds);
  }

  async advancePhase(goalId: string, nextPhase: GoalPhase): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    this.#assertRunning(current);
    this.#assertNextPhase(current, nextPhase);

    if (current.phase === "plan" && nextPhase === "build" && current.approvalPoints.includes("after_plan")) {
      if (!current.mainSessionId) {
        throw new GoalRunnerError(goalId, "Cannot request after_plan approval without a main session");
      }
      const outcome = await this.#approvalGate.requestApproval(current.id, current.mainSessionId, "after_plan", current.title, current.projectId);
      if (!outcome.approved) return this.#goalStateManager.transitionStatus(goalId, "paused");
    }

    return this.#goalStateManager.updatePhase(goalId, nextPhase);
  }

  async recordReviewerDoneResult(goalId: string, conditionId: string, result: DoneResult): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    this.#assertRunning(current);
    if (current.phase !== "review") {
      throw new GoalRunnerError(goalId, `Reviewer evidence can only be recorded in review phase, got ${current.phase}`);
    }

    await this.#goalStateManager.recordDoneResult(goalId, conditionId, result);
    return this.#goalStateManager.transitionStatus(goalId, "verifying");
  }

  async review(goalId: string): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    if (current.status !== "verifying") {
      throw new GoalRunnerError(goalId, `Cannot review goal from status ${current.status}`);
    }
    this.#assertReviewerEvidence(current);
    return this.#goalStateManager.transitionStatus(goalId, "reviewed");
  }

  async complete(goalId: string): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    if (current.status !== "reviewed") {
      throw new GoalRunnerError(goalId, `Cannot complete goal from status ${current.status}`);
    }
    if (current.phase !== "review") {
      throw new GoalRunnerError(goalId, `Cannot complete goal from phase ${current.phase}`);
    }
    this.#assertReviewerEvidence(current);

    if (current.approvalPoints.includes("before_complete")) {
      if (!current.mainSessionId) {
        throw new GoalRunnerError(goalId, "Cannot request before_complete approval without a main session");
      }
      const outcome = await this.#approvalGate.requestApproval(current.id, current.mainSessionId, "before_complete", current.title, current.projectId);
      if (!outcome.approved) return this.#goalStateManager.transitionStatus(goalId, "paused");
    }

    return this.#goalStateManager.transitionStatus(goalId, "completed");
  }

  async handleFailedVerification(goalId: string, error: string): Promise<GoalState> {
    let current = await this.#goalStateManager.updateLastError(goalId, error);
    if (current.status !== "failed") {
      if (current.status !== "running" && current.status !== "verifying") {
        throw new GoalRunnerError(goalId, `Cannot fail verification from status ${current.status}`);
      }
      current = await this.#goalStateManager.transitionStatus(goalId, "failed");
    }

    if (current.retryCount >= current.retryPolicy.maxRetries) {
      return this.#goalStateManager.transitionStatus(goalId, "escalated");
    }

    const freshSessionId = await this.#createSession();
    current = await this.#goalStateManager.incrementRetryCount(goalId);
    current = await this.#goalStateManager.updatePhase(goalId, "plan");
    current = await this.#goalStateManager.updateSessionIds(goalId, freshSessionId, []);
    return this.#goalStateManager.transitionStatus(current.id, "running");
  }

  async recoverInterruptedGoals(workspaceRoot = this.#workspaceRoot): Promise<GoalState[]> {
    if (workspaceRoot !== this.#workspaceRoot) {
      throw new GoalRunnerError("recovery", `Runner is scoped to ${this.#workspaceRoot}, not ${workspaceRoot}`);
    }

    const recovered: GoalState[] = [];
    const goals = await this.#goalStateManager.listGoals();

    for (const goal of goals) {
      if (goal.status !== "running" && goal.status !== "verifying") continue;

      if (this.#hitlService.listPending(goal.projectId, goal.id).length > 0) {
        recovered.push(await this.#goalStateManager.transitionStatus(goal.id, "paused"));
        continue;
      }

      if (!goal.mainSessionId || !(await this.#isSessionActive(goal.mainSessionId))) {
        await this.#goalStateManager.updateLastError(goal.id, "Interrupted goal recovered without an active main session");
        recovered.push(await this.#goalStateManager.transitionStatus(goal.id, "failed"));
      }
    }

    return recovered;
  }

  #assertRunning(goal: GoalState): void {
    if (goal.status !== "running") {
      throw new GoalRunnerError(goal.id, `Goal must be running, got ${goal.status}`);
    }
  }

  #assertNextPhase(goal: GoalState, nextPhase: GoalPhase): void {
    const currentIndex = PHASE_ORDER.indexOf(goal.phase);
    const nextIndex = PHASE_ORDER.indexOf(nextPhase);
    if (nextIndex !== currentIndex + 1) {
      throw new GoalRunnerError(goal.id, `Invalid phase transition ${goal.phase} → ${nextPhase}`);
    }
  }

  #assertReviewerEvidence(goal: GoalState): void {
    const missingOrFailing = goal.doneConditions
      .filter((condition) => condition.required !== false)
      .filter((condition) => goal.doneResults[condition.id]?.passed !== true);

    if (missingOrFailing.length > 0) {
      throw new GoalRunnerError(goal.id, `Reviewer evidence is missing or failing: ${missingOrFailing.map((condition) => condition.id).join(", ")}`);
    }
  }
}

async function withGoalClaimLock<T>(goalId: string, action: () => Promise<T>): Promise<T> {
  const previous = goalClaimLocks.get(goalId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  goalClaimLocks.set(goalId, previous.then(() => current, () => current));

  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (goalClaimLocks.get(goalId) === current) {
      goalClaimLocks.delete(goalId);
    }
  }
}
