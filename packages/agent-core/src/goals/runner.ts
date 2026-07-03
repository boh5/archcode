import type {
  DoneCondition,
  DoneResult,
  GoalPhase,
  GoalRepairContext,
  GoalReviewOutcome,
  GoalReviewReport,
  GoalSpecComplianceCriterionEvidence,
  GoalState,
} from "@archcode/protocol";

import { GoalApprovalGate } from "../hitl/goal-gates";
import type { HitlKind, HitlPayload, HitlResponse, HitlTrigger } from "../hitl/types";
import type { SessionRole } from "../store/types";
import type { GoalArtifactManager } from "./artifacts";
import {
  writeGoalBuildArtifactIfMissing,
  writeGoalFinalReport,
  writeGoalRetryArtifact,
  writeGoalReviewArtifacts,
} from "./artifact-lifecycle";
import type { GoalStateManager } from "./state";

type HitlGateway = {
  request(sessionId: string, kind: HitlKind, payload: HitlPayload, trigger: HitlTrigger): Promise<HitlResponse>;
  listPending(projectSlug?: string, goalId?: string, loopId?: string): unknown[];
};

export interface GoalRunnerOptions {
  goalStateManager: GoalStateManager;
  goalArtifacts: GoalArtifactManager;
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

export interface GoalReviewerDoneAuthorization {
  readonly agentName?: string;
  readonly sessionRole?: SessionRole;
  readonly sessionGoalId?: string;
}

export interface ReviewerReviewOptions {
  readonly reviewerAgent?: string;
  readonly summary?: string;
}

export class GoalReviewerAuthorizationError extends Error {
  readonly code = "GOAL_REVIEWER_REQUIRED";

  constructor(
    public readonly goalId: string,
    message: string,
  ) {
    super(message);
    this.name = "GoalReviewerAuthorizationError";
  }
}

const PHASE_ORDER: GoalPhase[] = ["plan", "build", "review"];
const goalClaimLocks = new Map<string, Promise<void>>();

export class GoalRunner {
  readonly #goalStateManager: GoalStateManager;
  readonly #goalArtifacts: GoalArtifactManager;
  readonly #hitlService: HitlGateway;
  readonly #approvalGate: GoalApprovalGate;
  readonly #workspaceRoot: string;
  readonly #createSession: () => Promise<string>;
  readonly #isSessionActive: (sessionId: string) => Promise<boolean>;

  constructor(options: GoalRunnerOptions) {
    this.#goalStateManager = options.goalStateManager;
    this.#goalArtifacts = options.goalArtifacts;
    this.#hitlService = options.hitlService;
    this.#approvalGate = new GoalApprovalGate({
      hitlService: options.hitlService,
      goalStateManager: options.goalStateManager,
      goalArtifacts: options.goalArtifacts,
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

    if (current.phase === "build" && nextPhase === "review") {
      await writeGoalBuildArtifactIfMissing(this.#goalArtifacts, current, "advance_to_review");
    }

    return this.#goalStateManager.updatePhase(goalId, nextPhase);
  }

  async recordReviewerDoneResult(goalId: string, conditionId: string, result: DoneResult): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    assertGoalReviewEvidencePhaseStatus(current);
    return persistReviewerDoneResult(this.#goalStateManager, current, conditionId, result);
  }

  async review(goalId: string): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    if (current.status !== "verifying") {
      throw new GoalRunnerError(goalId, `Cannot review goal from status ${current.status}`);
    }
    this.#assertReviewerEvidence(current);
    return this.#goalStateManager.transitionStatus(goalId, "reviewed");
  }

  async finalizeReviewerReview(
    goalId: string,
    outcome: GoalReviewOutcome,
    options: ReviewerReviewOptions = {},
  ): Promise<GoalState> {
    const current = await this.#goalStateManager.read(goalId);
    assertGoalReviewEvidencePhaseStatus(current);

    if (outcome === "DONE") {
      this.#assertReviewerEvidence(current);
      const reviewedWithReport = await this.#goalStateManager.recordReviewOutcome(
        goalId,
        buildReviewReport(current, "DONE", options),
      );
      await writeGoalReviewArtifacts(this.#goalArtifacts, reviewedWithReport);
      await this.review(goalId);
      return this.complete(goalId);
    }

    const repairContext = buildRepairContext(current);
    const failedWithReport = await this.#goalStateManager.recordReviewOutcome(
      goalId,
      buildReviewReport(current, "NOT_DONE", {
        ...options,
        summary: options.summary ?? repairContext.summary,
      }),
      repairContext,
    );
    await writeGoalReviewArtifacts(this.#goalArtifacts, failedWithReport);
    await this.#goalStateManager.updateLastError(goalId, repairContext.summary);
    const failed = await this.#goalStateManager.transitionStatus(goalId, "failed");
    if (failed.retryCount >= failed.retryPolicy.maxRetries) {
      await writeGoalFinalReport(this.#goalArtifacts, failed, repairContext.summary);
    }
    return failed;
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

    const completed = await this.#goalStateManager.transitionStatus(goalId, "completed");
    await writeGoalFinalReport(this.#goalArtifacts, completed, completed.reviewReport?.summary);
    return completed;
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
      const escalated = await this.#goalStateManager.transitionStatus(goalId, "escalated");
      await writeGoalRetryArtifact(this.#goalArtifacts, escalated, {
        attempt: escalated.retryCount + 1,
        status: "escalated",
        failureSummary: error,
        exhausted: true,
      });
      await writeGoalFinalReport(this.#goalArtifacts, escalated, error);
      return escalated;
    }

    const freshSessionId = await this.#createSession();
    current = await this.#goalStateManager.incrementRetryCount(goalId);
    current = await this.#goalStateManager.updatePhase(goalId, "plan");
    current = await this.#goalStateManager.updateSessionIds(goalId, freshSessionId, []);
    const running = await this.#goalStateManager.transitionStatus(current.id, "running");
    await writeGoalRetryArtifact(this.#goalArtifacts, running, {
      attempt: running.retryCount,
      status: "running",
      failureSummary: error,
      freshSessionId,
    });
    return running;
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

function buildReviewReport(
  goal: GoalState,
  outcome: GoalReviewOutcome,
  options: ReviewerReviewOptions,
): GoalReviewReport {
  return {
    reviewerAgent: options.reviewerAgent ?? goal.reviewerAgent,
    outcome,
    reviewedAt: new Date().toISOString(),
    summary: options.summary ?? (outcome === "DONE"
      ? "All required Done Conditions passed."
      : "One or more required Done Conditions are missing or failing."),
    criteria: goal.doneConditions
      .filter((condition) => condition.required !== false)
      .flatMap((condition) => reviewCriteriaForCondition(condition, goal.doneResults[condition.id])),
  };
}

function buildRepairContext(goal: GoalState): GoalRepairContext {
  const issues = goal.doneConditions
    .filter((condition) => condition.required !== false)
    .flatMap((condition) => repairIssuesForCondition(condition, goal.doneResults[condition.id]));

  const issueIds = issues.map((issue) => issue.conditionId).join(", ");
  return {
    generatedAt: new Date().toISOString(),
    summary: `Reviewer NOT_DONE: required Done Conditions need repair (${issueIds || "none"}).`,
    issues,
  };
}

function reviewCriteriaForCondition(
  condition: DoneCondition,
  result: DoneResult | undefined,
): GoalSpecComplianceCriterionEvidence[] {
  if (condition.kind === "spec_compliance" && result?.specCompliance) {
    return result.specCompliance.criteria;
  }
  const compliant = result?.passed === true;
  return [{
    criterionId: condition.id,
    criterion: describeCondition(condition),
    compliant,
    status: compliant ? "satisfied" : "failed",
    evidence: result ? [result.evidence] : ["Required evidence missing"],
  }];
}

function repairIssuesForCondition(condition: DoneCondition, result: DoneResult | undefined): GoalRepairContext["issues"] {
  if (result?.passed === true) return [];

  if (condition.kind === "spec_compliance" && result?.specCompliance) {
    const issues = result.specCompliance.criteria
      .filter((criterion) => criterion.status === "failed" || criterion.compliant === false)
      .map((criterion) => withoutUndefined({
        conditionId: criterion.criterionId,
        evidenceSummary: criterion.evidence.join("\n") || result.evidence,
        repairGuidance: criterion.repairGuidance ?? `Repair acceptance criterion ${criterion.criterionId}, then run goal_check_done again.`,
        repairTarget: criterion.fileRefs?.join(", ") ?? repairTargetForCondition(condition),
        implicatedFiles: criterion.fileRefs,
        failingCommands: criterion.commandRefs,
        resultSummaries: criterion.resultRefs,
      }));
    if (issues.length > 0) return issues;
  }

  return [withoutUndefined({
    conditionId: condition.id,
    evidenceSummary: result?.evidence ?? "Required evidence missing",
    repairGuidance: result
      ? `Repair the implementation so required Done Condition ${condition.id} passes, then run goal_check_done again.`
      : `Collect canonical Reviewer evidence by running goal_check_done for required Done Condition ${condition.id}.`,
    repairTarget: repairTargetForCondition(condition),
  })];
}

function describeCondition(condition: DoneCondition): string {
  return `${condition.id} (${condition.kind})`;
}

function repairTargetForCondition(condition: DoneCondition): string | undefined {
  switch (condition.kind) {
    case "file_exists":
      return condition.params.path;
    case "grep_contains":
    case "grep_empty":
      return condition.params.path ?? condition.params.pattern;
    case "lsp_clean":
      return condition.params.paths?.join(", ") ?? "LSP diagnostics";
    case "tests_pass":
    case "typecheck_pass":
      return condition.params.command ?? condition.kind;
    case "command_succeeds":
      return condition.params.command;
    case "user_confirmed":
      return condition.params.prompt;
    case "spec_compliance":
      return condition.params.specPath;
  }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function assertGoalReviewerDoneAuthorized(
  goal: GoalState,
  authorization: GoalReviewerDoneAuthorization,
): void {
  if (authorization.agentName !== goal.reviewerAgent) {
    throw new GoalReviewerAuthorizationError(
      goal.id,
      `goal_check_done requires reviewer agent ${goal.reviewerAgent}, got ${authorization.agentName ?? "unknown"}`,
    );
  }
  if (authorization.sessionRole !== "review") {
    throw new GoalReviewerAuthorizationError(
      goal.id,
      `goal_check_done requires a review session, got ${authorization.sessionRole ?? "unknown"}`,
    );
  }
  if (authorization.sessionGoalId !== goal.id) {
    throw new GoalReviewerAuthorizationError(
      goal.id,
      `goal_check_done requires matching session goal ${goal.id}, got ${authorization.sessionGoalId ?? "unknown"}`,
    );
  }
  assertGoalReviewEvidencePhaseStatus(goal);
}

export async function recordAuthorizedReviewerDoneResult(
  goalStateManager: GoalStateManager,
  goalId: string,
  conditionId: string,
  result: DoneResult,
  authorization: GoalReviewerDoneAuthorization,
): Promise<GoalState> {
  const current = await goalStateManager.read(goalId);
  assertGoalReviewerDoneAuthorized(current, authorization);
  return persistReviewerDoneResult(goalStateManager, current, conditionId, result);
}

function assertGoalReviewEvidencePhaseStatus(goal: GoalState): void {
  if (goal.phase !== "review") {
    throw new GoalRunnerError(goal.id, `Reviewer evidence can only be recorded in review phase, got ${goal.phase}`);
  }
  if (goal.status !== "running" && goal.status !== "verifying") {
    throw new GoalRunnerError(
      goal.id,
      `Reviewer evidence can only be recorded while goal is running or verifying, got ${goal.status}`,
    );
  }
}

async function persistReviewerDoneResult(
  goalStateManager: GoalStateManager,
  goal: GoalState,
  conditionId: string,
  result: DoneResult,
): Promise<GoalState> {
  await goalStateManager.recordDoneResult(goal.id, conditionId, result);
  if (goal.status === "running") return goalStateManager.transitionStatus(goal.id, "verifying");
  return goalStateManager.read(goal.id);
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
