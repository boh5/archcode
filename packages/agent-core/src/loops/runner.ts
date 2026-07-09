import type { SessionFile } from "../store/helpers";
import type { AgentName } from "../agents/factory-types";
import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { GoalState } from "../goals/state";
import type { ToolExecutionOrigin } from "../tools/types";
import type { LoopSchedulerRunInput, LoopSchedulerRunResult, LoopSchedulerRunner } from "./scheduler";
import type { LoopCleanupState, LoopGoalTemplate, LoopJobStatus, LoopRunReport, LoopRunReportStatus, LoopRunTrigger, LoopState, LoopWorktreeArtifact } from "./state";
import { LoopConfigSchema, LoopGoalTemplateSchema, LoopStateManager } from "./state";
import { getLoopTemplate } from "./templates";
import { normalizeLoopCleanupPolicy } from "./cleanup";
import { LoopBudgetLedger } from "./budget-ledger";
import { CollisionLedger } from "./collision-ledger";
import { LoopWorktreeManagerError, type LoopWorktreeCreateResult, type LoopWorktreeInspection } from "./worktree-manager";
import { createProcessRunner } from "../process/runner";

export interface LoopRunnerSessionRuntime {
  createSession(workspaceRoot: string, options?: LoopRunnerCreateSessionOptions): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution;
  prepareSessionWorkspace?(workspaceRoot: string, canonicalWorkspaceRoot: string): Promise<void>;
  releaseSessionWorkspace?(workspaceRoot: string, sessionId?: string): void;
}

export interface LoopRunnerGoalStateManager {
  create(input: { projectId: string; title: string; objective: string; acceptanceCriteria: string; loopId?: string }): Promise<GoalState>;
}

export interface LoopRunnerGoalRuntime {
  start(goalId: string, options?: LoopRunnerGoalStartOptions): Promise<GoalState>;
}

export interface LoopRunnerGoalStartOptions {
  readonly loopId?: string;
  readonly sessionTitle?: string;
  readonly workspaceRoot?: string;
}

export interface LoopRunnerCreateSessionOptions {
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: "main";
  readonly agentName?: AgentName;
  readonly title?: string;
}

export interface LoopRunnerOptions {
  readonly stateManager: LoopStateManager;
  readonly runtime: LoopRunnerSessionRuntime;
  readonly goalStateManager?: LoopRunnerGoalStateManager;
  readonly goalRunner?: LoopRunnerGoalRuntime;
  readonly workspaceRoot: string;
  readonly projectSlug?: string;
  readonly now?: () => number;
  readonly collisionLedger?: CollisionLedger;
  readonly worktreeManager?: LoopRunnerWorktreeManager;
}

export interface LoopRunnerWorktreeManager {
  create(input: {
    readonly loopSlug: string;
    readonly subjectSlug: string;
    readonly jobId: string;
    readonly baseSha: string;
    readonly jobClass?: "local" | "remote";
  }): Promise<LoopWorktreeCreateResult>;
  inspect(input: {
    readonly worktreePath: string;
    readonly branchName: string;
    readonly baseSha: string;
    readonly evidencePaths?: readonly string[];
  }): Promise<LoopWorktreeInspection>;
  cleanup(input: {
    readonly inspection: LoopWorktreeInspection;
    readonly jobStatus?: LoopJobStatus;
  }): Promise<{
    readonly cleanupState: LoopCleanupState;
    readonly removed: boolean;
    readonly reviewRequired: boolean;
    readonly reason: string;
    readonly worktreePath: string;
  }>;
}

type LoopRunnerFinishedResult = Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult;

interface LoopExecutionScope {
  readonly workspaceRoot: string;
  readonly worktree?: LoopWorktreeScope;
}

interface LoopWorktreeScope {
  readonly worktreePath: string;
  readonly branchName: string;
  readonly baseSha: string;
  readonly resolvedHeadSha: string;
}

export class LoopActiveConflictError extends Error {
  readonly code = "LOOP_ACTIVE_CONFLICT";

  constructor(
    public readonly loopId: string,
    public readonly trigger: LoopRunTrigger,
    public readonly activeRunId?: string,
    public readonly sessionId?: string,
  ) {
    super(`Loop ${loopId} already has an active run${activeRunId ? ` (${activeRunId})` : ""}; cannot start ${trigger} trigger.`);
    this.name = "LoopActiveConflictError";
  }
}

export class LoopRunner {
  readonly #stateManager: LoopStateManager;
  readonly #runtime: LoopRunnerSessionRuntime;
  readonly #goalStateManager?: LoopRunnerGoalStateManager;
  readonly #goalRunner?: LoopRunnerGoalRuntime;
  readonly #workspaceRoot: string;
  readonly #projectSlug: string;
  readonly #now: () => number;
  readonly #budgetLedger: LoopBudgetLedger;
  readonly #collisionLedger: CollisionLedger;
  readonly #worktreeManager?: LoopRunnerWorktreeManager;
  readonly #activeLoops = new Map<string, { runId: string; sessionId?: string }>();

  constructor(options: LoopRunnerOptions) {
    this.#stateManager = options.stateManager;
    this.#runtime = options.runtime;
    this.#goalStateManager = options.goalStateManager;
    this.#goalRunner = options.goalRunner;
    this.#workspaceRoot = options.workspaceRoot;
    this.#projectSlug = options.projectSlug ?? "";
    this.#now = options.now ?? (() => Date.now());
    this.#budgetLedger = new LoopBudgetLedger({
      stateManager: options.stateManager,
      workspaceRoot: options.workspaceRoot,
      clock: { now: this.#now },
    });
    this.#collisionLedger = options.collisionLedger ?? new CollisionLedger({
      stateManager: options.stateManager,
      workspaceRoot: options.workspaceRoot,
      clock: { now: this.#now },
    });
    this.#worktreeManager = options.worktreeManager;
  }

  async runSessionLoop(loopState: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport> {
    this.#assertSessionLoop(loopState);
    const existing = this.#activeLoops.get(loopState.loopId);
    if (existing !== undefined) {
      throw new LoopActiveConflictError(loopState.loopId, trigger, existing.runId, existing.sessionId);
    }

    const current = await this.#stateManager.read(loopState.loopId);
    if (current.currentRun?.status === "running") {
      throw new LoopActiveConflictError(current.loopId, trigger, current.currentRun.runId, current.currentRun.sessionId);
    }

    const startedAt = this.#now();
    const runId = crypto.randomUUID();
    const preRunBlocked = await this.#budgetLedger.assertCanStartRun(current, runId, trigger);
    if (preRunBlocked !== undefined) return preRunBlocked;
    const collisionBlocked = await this.#acquireStaticCollisionTargets(current, runId, trigger);
    if (collisionBlocked !== undefined) return collisionBlocked;
    const runningReport: LoopRunReport = {
      runId,
      loopId: current.loopId,
      status: "running",
      trigger,
      startedAt,
      ...(current.config.collisionTargets === undefined ? {} : { collisionTargets: current.config.collisionTargets }),
    };

    this.#activeLoops.set(current.loopId, { runId });
    let startedState = await this.#stateManager.recordRunStart(current.loopId, runningReport);
    await this.#budgetLedger.recordRunStart(current.loopId, runId);
    let currentReport = runningReport;
    try {
      const session = await this.#createLoopSession(startedState);
      this.#activeLoops.set(current.loopId, { runId, sessionId: session.sessionId });
      currentReport = { ...runningReport, sessionId: session.sessionId };
      startedState = await this.#stateManager.recordRunStart(current.loopId, currentReport);
      const result = await this.#executeLoopSession({ loop: startedState, trigger, runId, startedAt }, session.sessionId);
      return await this.#finishRun(startedState, currentReport, result);
    } catch (error) {
      const budgetExceeded = await this.#budgetExceededResult(startedState, runId, currentReport.sessionId);
      if (budgetExceeded !== undefined) return await this.#finishRun(startedState, currentReport, budgetExceeded);
      return await this.#finishRun(startedState, currentReport, {
        status: "failed",
        sessionId: currentReport.sessionId,
        error: errorToMessage(error),
      });
    } finally {
      await this.#releaseCollisionLeases(current.loopId, runId);
      this.#activeLoops.delete(current.loopId);
    }
  }

  createSchedulerRunner(): LoopSchedulerRunner {
    return async (input) => loopRunOptions(input.loop).runType === "goal"
      ? this.runScheduledGoalLoop(input)
      : this.runScheduledSessionLoop(input);
  }

  async runGoalLoop(loopState: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport> {
    this.#assertGoalLoop(loopState);
    const existing = this.#activeLoops.get(loopState.loopId);
    if (existing !== undefined) {
      throw new LoopActiveConflictError(loopState.loopId, trigger, existing.runId, existing.sessionId);
    }

    const current = await this.#stateManager.read(loopState.loopId);
    this.#assertGoalLoop(current);
    if (current.currentRun?.status === "running") {
      throw new LoopActiveConflictError(current.loopId, trigger, current.currentRun.runId, current.currentRun.sessionId);
    }

    const startedAt = this.#now();
    const runId = crypto.randomUUID();
    const preRunBlocked = await this.#budgetLedger.assertCanStartRun(current, runId, trigger);
    if (preRunBlocked !== undefined) return preRunBlocked;
    const collisionBlocked = await this.#acquireStaticCollisionTargets(current, runId, trigger);
    if (collisionBlocked !== undefined) return collisionBlocked;
    const runningReport: LoopRunReport = {
      runId,
      loopId: current.loopId,
      status: "running",
      trigger,
      startedAt,
      ...(current.config.collisionTargets === undefined ? {} : { collisionTargets: current.config.collisionTargets }),
    };

    this.#activeLoops.set(current.loopId, { runId });
    let startedState = await this.#stateManager.recordRunStart(current.loopId, runningReport);
    await this.#budgetLedger.recordRunStart(current.loopId, runId);
    try {
      const result = await this.#runGoal({ loop: startedState, trigger, runId, startedAt });
      return await this.#finishRun(startedState, runningReport, result);
    } catch (error) {
      const budgetExceeded = await this.#budgetExceededResult(startedState, runId, runningReport.sessionId);
      if (budgetExceeded !== undefined) return await this.#finishRun(startedState, runningReport, budgetExceeded);
      return await this.#finishRun(startedState, runningReport, {
        status: "failed",
        error: errorToMessage(error),
      });
    } finally {
      await this.#releaseCollisionLeases(current.loopId, runId);
      this.#activeLoops.delete(current.loopId);
    }
  }

  async runScheduledSessionLoop(input: LoopSchedulerRunInput): Promise<LoopSchedulerRunResult> {
    this.#assertSessionLoop(input.loop);
    const skipped = this.#skippedIfSuperseded(input);
    if (skipped !== undefined) return skipped;
    const existing = this.#activeLoops.get(input.loop.loopId);
    if (existing !== undefined) {
      throw new LoopActiveConflictError(input.loop.loopId, input.trigger, existing.runId, existing.sessionId);
    }

    this.#activeLoops.set(input.loop.loopId, { runId: input.runId });
    try {
      return await this.#runSession(input);
    } finally {
      this.#activeLoops.delete(input.loop.loopId);
    }
  }

  async runScheduledGoalLoop(input: LoopSchedulerRunInput): Promise<LoopSchedulerRunResult> {
    this.#assertGoalLoop(input.loop);
    const skipped = this.#skippedIfSuperseded(input);
    if (skipped !== undefined) return skipped;
    const existing = this.#activeLoops.get(input.loop.loopId);
    if (existing !== undefined) {
      throw new LoopActiveConflictError(input.loop.loopId, input.trigger, existing.runId, existing.sessionId);
    }

    this.#activeLoops.set(input.loop.loopId, { runId: input.runId });
    try {
      return await this.#runGoal(input);
    } finally {
      this.#activeLoops.delete(input.loop.loopId);
    }
  }

  async #runGoal(input: LoopSchedulerRunInput): Promise<LoopRunnerFinishedResult> {
    const goalStateManager = this.#requireGoalStateManager(input.loop.loopId);
    const goalRunner = this.#requireGoalRunner(input.loop.loopId);
    const template = snapshotGoalTemplate(input.loop);
    let goalId: string | undefined;
    const scopeResult = await this.#prepareExecutionScope(input);
    if ("status" in scopeResult) return scopeResult;
    const scope = scopeResult;
    let executionStarted = false;

    try {
      const draft = await goalStateManager.create({
        projectId: input.loop.projectId,
        title: template.title,
        objective: template.objective,
        acceptanceCriteria: template.acceptanceCriteria,
        loopId: input.loop.loopId,
      });
      goalId = draft.id;
      const started = await goalRunner.start(draft.id, {
        loopId: input.loop.loopId,
        sessionTitle: `Loop Goal: ${input.loop.config.title}`,
        workspaceRoot: scope.workspaceRoot,
      });
      executionStarted = true;
      const result = await this.#executeGoalSession(input, started, scope);
      return await this.#finalizeWorktreeResult(input.loop, scope, result);
    } catch (error) {
      const budgetExceeded = await this.#budgetExceededResult(input.loop, input.runId, undefined);
      const result = budgetExceeded ?? {
        status: "failed",
        goalId,
        error: errorToMessage(error),
      };
      if (!executionStarted) this.#releaseExecutionScope(scope, result.sessionId);
      return await this.#finalizeWorktreeResult(input.loop, scope, result);
    }
  }

  async #executeGoalSession(
    input: LoopSchedulerRunInput,
    goal: GoalState,
    scope: LoopExecutionScope,
  ): Promise<LoopRunnerFinishedResult> {
    const sessionId = goal.mainSessionId;
    if (sessionId === undefined) {
      this.#releaseExecutionScope(scope, undefined);
      return {
        status: "failed",
        goalId: goal.id,
        error: `Goal ${goal.id} started without a main session.`,
      };
    }

    await this.#recordScheduledSessionLink(input, sessionId, goal.id);
    const stopped = await this.#terminalResultIfRunStopped(input, sessionId, goal.id);
    if (stopped !== undefined) {
      this.#releaseExecutionScope(scope, sessionId);
      return stopped;
    }

    try {
      const execution = this.#runtime.startSessionExecution({
        slug: this.#projectSlug,
        workspaceRoot: scope.workspaceRoot,
        sessionId,
        userMessage: buildGoalLoopPrompt(input.loop, goal),
        maxSteps: input.loop.config.limits.maxIterationsPerRun,
        agentName: loopRunOptions(input.loop).agentName,
        extraTools: loopRunOptions(input.loop).extraTools,
        origin: loopOrigin(input.loop, input.trigger, input.runId),
      });
      await execution.promise;
      const result = await this.#sessionResultFromFinalState(input.loop, sessionId, scope.workspaceRoot);
      return {
        ...result,
        goalId: goal.id,
        summary: result.status === "succeeded"
          ? `Goal ${goal.id} session ${sessionId} completed for loop "${input.loop.config.title}".`
          : result.summary,
      };
    } catch (error) {
      const budgetExceeded = await this.#budgetExceededResult(input.loop, input.runId, sessionId);
      if (budgetExceeded !== undefined) return budgetExceeded;
      return {
        status: "failed",
        goalId: goal.id,
        sessionId,
        error: errorToMessage(error),
      };
    } finally {
      this.#releaseExecutionScope(scope, sessionId);
    }
  }

  async #runSession(input: LoopSchedulerRunInput): Promise<LoopRunnerFinishedResult> {
    const alreadyStopped = await this.#terminalResultIfRunStopped(input);
    if (alreadyStopped !== undefined) return alreadyStopped;
    const scopeResult = await this.#prepareExecutionScope(input);
    if ("status" in scopeResult) return scopeResult;
    const scope = scopeResult;
    let executionStarted = false;

    try {
      const session = await this.#createLoopSession(input.loop, scope.workspaceRoot);
      const active = this.#activeLoops.get(input.loop.loopId);
      if (active !== undefined) this.#activeLoops.set(input.loop.loopId, { ...active, sessionId: session.sessionId });
      await this.#recordScheduledSessionLink(input, session.sessionId);
      executionStarted = true;
      const result = await this.#executeLoopSession(input, session.sessionId, scope);
      return await this.#finalizeWorktreeResult(input.loop, scope, result);
    } catch (error) {
      const budgetExceeded = await this.#budgetExceededResult(input.loop, input.runId, undefined);
      const result = budgetExceeded ?? {
        status: "failed",
        error: errorToMessage(error),
      };
      if (!executionStarted) this.#releaseExecutionScope(scope, result.sessionId);
      return await this.#finalizeWorktreeResult(input.loop, scope, result);
    }
  }

  async #createLoopSession(loop: LoopState, workspaceRoot = this.#workspaceRoot): Promise<SessionFile> {
    return await this.#runtime.createSession(workspaceRoot, {
      loopId: loop.loopId,
      sessionRole: "main",
      agentName: loopRunOptions(loop).agentName,
      title: `Loop: ${loop.config.title}`,
    });
  }

  async #executeLoopSession(
    input: LoopSchedulerRunInput,
    sessionId: string,
    scope: LoopExecutionScope = { workspaceRoot: this.#workspaceRoot },
  ): Promise<LoopRunnerFinishedResult> {
    const stopped = await this.#terminalResultIfRunStopped(input, sessionId);
    if (stopped !== undefined) {
      this.#releaseExecutionScope(scope, sessionId);
      return stopped;
    }

    try {
      const execution = this.#runtime.startSessionExecution({
        slug: this.#projectSlug,
        workspaceRoot: scope.workspaceRoot,
        sessionId,
        userMessage: buildSessionLoopPrompt(input.loop),
        maxSteps: input.loop.config.limits.maxIterationsPerRun,
        agentName: loopRunOptions(input.loop).agentName,
        extraTools: loopRunOptions(input.loop).extraTools,
        origin: loopOrigin(input.loop, input.trigger, input.runId),
      });
      await execution.promise;
      return await this.#sessionResultFromFinalState(input.loop, sessionId, scope.workspaceRoot);
    } catch (error) {
      const budgetExceeded = await this.#budgetExceededResult(input.loop, input.runId, sessionId);
      if (budgetExceeded !== undefined) return budgetExceeded;
      return {
        status: "failed",
        sessionId,
        error: errorToMessage(error),
      };
    } finally {
      this.#releaseExecutionScope(scope, sessionId);
    }
  }

  async #sessionResultFromFinalState(
    loop: LoopState,
    sessionId: string,
    workspaceRoot = this.#workspaceRoot,
  ): Promise<LoopRunnerFinishedResult> {
    const session = await this.#runtime.getSessionFile(workspaceRoot, sessionId);
    const budgetExceeded = await this.#budgetExceededResult(loop, loop.currentRun?.runId, sessionId);
    if (budgetExceeded !== undefined) return budgetExceeded;
    const pendingUserInteraction = pendingUserInteractionFromSession(session);
    if (pendingUserInteraction !== undefined) {
      return {
        status: "needs_user",
        sessionId,
        blockedReason: "needs_user",
        blockedByHitlIds: pendingUserInteraction.blockedByHitlIds,
        attentionStatus: "waiting_for_human",
        skippedReason: `Session ${sessionId} is waiting for user input for loop "${loop.config.title}".`,
        summary: `Session ${sessionId} is blocked waiting for user input.`,
      };
    }
    const execution = session.executions.at(-1);
    if (execution?.status === "completed" || execution?.status === "max_steps") {
      return {
        status: "succeeded",
        sessionId,
        summary: `Session ${sessionId} completed for loop "${loop.config.title}".`,
      };
    }

    return {
      status: "failed",
      sessionId,
      error: executionFailureMessage(execution?.status, execution?.error),
    };
  }

  async #finishRun(
    loop: LoopState,
    runningReport: LoopRunReport,
    result: Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult,
  ): Promise<LoopRunReport> {
    const report: LoopRunReport = {
      ...runningReport,
      status: result.status,
      endedAt: this.#now(),
      sessionId: result.sessionId,
      goalId: result.goalId,
      summary: result.summary,
      error: result.error,
      reason: result.reason,
      skippedReason: result.skippedReason,
      budgetUsage: result.budgetUsage,
      collisionTargets: result.collisionTargets ?? runningReport.collisionTargets,
      collisionConflicts: result.collisionConflicts,
      integrationErrors: result.integrationErrors,
      blockedReason: result.blockedReason,
      worktreePath: result.worktreePath ?? runningReport.worktreePath,
      baseSha: result.baseSha ?? runningReport.baseSha,
      resolvedHeadSha: result.resolvedHeadSha ?? runningReport.resolvedHeadSha,
      cleanupState: result.cleanupState ?? runningReport.cleanupState,
      observedArtifacts: result.observedArtifacts ?? runningReport.observedArtifacts,
    };
    await this.#stateManager.recordRunFinish(loop.loopId, report);
    await this.#releaseCollisionLeases(loop.loopId, runningReport.runId);
    return report;
  }

  async #prepareExecutionScope(input: LoopSchedulerRunInput): Promise<LoopExecutionScope | LoopRunnerFinishedResult> {
    const job = input.job;
    if (job === undefined) return { workspaceRoot: this.#workspaceRoot };
    const superseded = this.#skippedIfSuperseded(input);
    if (superseded !== undefined) return superseded;
    const worktreeManager = this.#worktreeManager;
    const useWorktree = input.loop.config.useWorktree === true;
    if (worktreeManager === undefined) return { workspaceRoot: this.#workspaceRoot };
    if (!useWorktree) return { workspaceRoot: this.#workspaceRoot };

    try {
      const baseSha = await this.#baseShaForJob(job);
      const created = await worktreeManager.create({
        loopSlug: input.loop.config.title,
        subjectSlug: job.subjectKey,
        jobId: job.jobId,
        baseSha,
        jobClass: jobClassForTrigger(job.triggerKind),
      });
      await this.#runtime.prepareSessionWorkspace?.(created.worktreePath, this.#workspaceRoot);
      return {
        workspaceRoot: created.worktreePath,
        worktree: {
          worktreePath: created.worktreePath,
          branchName: created.branchName,
          baseSha: created.baseSha,
          resolvedHeadSha: created.resolvedHeadSha,
        },
      };
    } catch (error) {
      if (error instanceof LoopWorktreeManagerError && error.code === "CANONICAL_DIRTY") {
        return {
          status: "skipped",
          blockedReason: "dirty-canonical",
          skippedReason: "Canonical checkout has uncommitted changes; blocked local loop job before creating a worktree.",
          summary: "Loop job blocked because the canonical checkout is dirty.",
          error: error.message,
        };
      }
      throw error;
    }
  }

  async #baseShaForJob(job: NonNullable<LoopSchedulerRunInput["job"]>): Promise<string> {
    if (job.baseSha !== undefined) return job.baseSha;
    if (job.resolvedHeadSha !== undefined) return job.resolvedHeadSha;
    return await resolveCanonicalHeadSha(this.#workspaceRoot);
  }

  async #finalizeWorktreeResult(loop: LoopState, scope: LoopExecutionScope, result: LoopRunnerFinishedResult): Promise<LoopRunnerFinishedResult> {
    const worktree = scope.worktree;
    if (worktree === undefined || this.#worktreeManager === undefined) return result;
    const inspection = await this.#worktreeManager.inspect({
      worktreePath: worktree.worktreePath,
      branchName: worktree.branchName,
      baseSha: worktree.baseSha,
      evidencePaths: evidencePathsForLoopRun(result),
    });
    const jobStatus = jobStatusForCleanup(result);
    const cleanup = await this.#cleanupWorktreeAfterRun(loop, inspection, jobStatus);
    const blockedReason = result.status === "failed" && inspection.hasChanges
      ? "failed_with_changes"
      : result.blockedReason;

    return {
      ...result,
      ...(blockedReason === undefined ? {} : { blockedReason }),
      worktreePath: inspection.worktreePath,
      baseSha: inspection.baseSha,
      resolvedHeadSha: inspection.headSha,
      cleanupState: cleanup.cleanupState,
      observedArtifacts: observedArtifactsFromInspection(inspection, cleanup.cleanupState),
    };
  }

  async #cleanupWorktreeAfterRun(
    loop: LoopState,
    inspection: LoopWorktreeInspection,
    jobStatus: LoopJobStatus,
  ): ReturnType<LoopRunnerWorktreeManager["cleanup"]> {
    const latest = await this.#stateManager.read(loop.loopId);
    const policy = normalizeLoopCleanupPolicy(latest.config.cleanupPolicy);
    const deleteUnchangedWorktree = policy.enabled && policy.deleteUnchangedWorktrees;
    if (!deleteUnchangedWorktree && !inspection.hasChanges && jobStatus !== "failed") {
      return {
        cleanupState: "preserved",
        removed: false,
        reviewRequired: false,
        reason: "unchanged worktree deletion disabled",
        worktreePath: inspection.worktreePath,
      };
    }
    if (this.#worktreeManager === undefined) {
      return {
        cleanupState: "preserved",
        removed: false,
        reviewRequired: false,
        reason: "worktree manager unavailable",
        worktreePath: inspection.worktreePath,
      };
    }
    return await this.#worktreeManager.cleanup({ inspection, jobStatus });
  }

  #releaseExecutionScope(scope: LoopExecutionScope, sessionId?: string): void {
    if (scope.worktree === undefined) return;
    this.#runtime.releaseSessionWorkspace?.(scope.workspaceRoot, sessionId);
  }

  #skippedIfSuperseded(input: LoopSchedulerRunInput): LoopRunnerFinishedResult | undefined {
    if (input.job?.blockedReason !== "superseded") return undefined;
    return {
      status: "skipped",
      blockedReason: "superseded",
      skippedReason: `Loop job ${input.job.jobId} for ${input.job.subjectKey} was superseded before execution.`,
      summary: "Loop job skipped because its trigger subject was superseded.",
    };
  }

  async #acquireStaticCollisionTargets(loop: LoopState, runId: string, trigger: LoopRunTrigger): Promise<LoopRunReport | undefined> {
    if ((loop.config.collisionTargets ?? []).length === 0) return undefined;

    const results = await this.#collisionLedger.acquireStaticTargets({
      loop,
      runId,
      priority: 0,
      actionId: `loop:${trigger}`,
    });
    const conflicts = results
      .map((result) => result.conflict)
      .filter((conflict): conflict is NonNullable<typeof conflict> => conflict !== undefined);
    if (conflicts.length === 0) return undefined;

    await this.#releaseCollisionLeases(loop.loopId, runId);
    const now = this.#now();
    const report: LoopRunReport = {
      runId,
      loopId: loop.loopId,
      status: "skipped",
      trigger,
      startedAt: now,
      endedAt: now,
      reason: "collision_conflict",
      skippedReason: "Loop static collision targets conflict with an active run; skipped trigger.",
      collisionTargets: loop.config.collisionTargets,
      collisionConflicts: conflicts,
    };
    await this.#stateManager.appendRunReport(loop.loopId, report);
    return report;
  }

  async #releaseCollisionLeases(loopId: string, runId: string): Promise<void> {
    await this.#collisionLedger.releaseRun(loopId, runId);
    await this.#collisionLedger.cleanupStale();
  }

  async #recordScheduledSessionLink(input: LoopSchedulerRunInput, sessionId: string, goalId?: string): Promise<void> {
    const latest = await this.#stateManager.read(input.loop.loopId);
    if (latest.currentRun?.runId !== input.runId || latest.currentRun.status !== "running") return;
    await this.#stateManager.recordRunStart(input.loop.loopId, {
      ...latest.currentRun,
      sessionId,
      ...(goalId === undefined ? {} : { goalId }),
    });
  }

  async #terminalResultIfRunStopped(
    input: LoopSchedulerRunInput,
    sessionId?: string,
    goalId?: string,
  ): Promise<(Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult) | undefined> {
    const latest = await this.#stateManager.read(input.loop.loopId);
    const lastRun = latest.lastRun;
    if (lastRun?.runId !== input.runId || !isSchedulerTerminalStatus(lastRun.status)) return undefined;
    return {
      status: lastRun.status,
      sessionId: lastRun.sessionId ?? sessionId,
      goalId: lastRun.goalId ?? goalId,
      reason: lastRun.reason,
      budgetUsage: lastRun.budgetUsage,
      summary: lastRun.summary,
      error: lastRun.error,
    };
  }

  async #budgetExceededResult(
    loop: LoopState,
    runId: string | undefined,
    sessionId: string | undefined,
  ): Promise<(Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult) | undefined> {
    if (runId === undefined) return undefined;
    const latest = await this.#stateManager.read(loop.loopId);
    if (latest.lastRun?.runId !== runId || latest.lastRun.status !== "budget_exceeded") return undefined;
    return {
      status: "budget_exceeded",
      sessionId: latest.lastRun.sessionId ?? sessionId,
      goalId: latest.lastRun.goalId,
      reason: latest.lastRun.reason,
      budgetUsage: latest.lastRun.budgetUsage,
      summary: latest.lastRun.summary,
      error: latest.lastRun.error,
    };
  }

  #assertSessionLoop(loop: LoopState): void {
    const config = LoopConfigSchema.parse(loop.config);
    if (loopRunOptions(loop).runType !== "session") {
      throw new Error(`Loop ${loop.loopId} is configured for ${config.templateId} runs; session runner only handles session loops.`);
    }
  }

  #assertGoalLoop(loop: LoopState): void {
    const config = LoopConfigSchema.parse(loop.config);
    if (loopRunOptions(loop).runType !== "goal") {
      throw new Error(`Loop ${loop.loopId} is configured for ${config.templateId} runs; goal runner only handles goal loops.`);
    }
    if (config.goalTemplate === undefined) {
      throw new Error(`Goal loop ${loop.loopId} requires an inline goalTemplate.`);
    }
  }

  #requireGoalStateManager(loopId: string): LoopRunnerGoalStateManager {
    if (this.#goalStateManager === undefined) throw new Error(`Goal loop ${loopId} requires a GoalStateManager.`);
    return this.#goalStateManager;
  }

  #requireGoalRunner(loopId: string): LoopRunnerGoalRuntime {
    if (this.#goalRunner === undefined) throw new Error(`Goal loop ${loopId} requires a GoalRunner.`);
    return this.#goalRunner;
  }
}

export function createLoopSchedulerRunner(options: LoopRunnerOptions): LoopSchedulerRunner {
  return new LoopRunner(options).createSchedulerRunner();
}

export async function runSessionLoop(options: LoopRunnerOptions, loopState: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport> {
  return await new LoopRunner(options).runSessionLoop(loopState, trigger);
}

export async function runGoalLoop(options: LoopRunnerOptions, loopState: LoopState, trigger: LoopRunTrigger): Promise<LoopRunReport> {
  return await new LoopRunner(options).runGoalLoop(loopState, trigger);
}

function snapshotGoalTemplate(loop: LoopState): LoopGoalTemplate {
  return LoopGoalTemplateSchema.parse(structuredClone(loop.config.goalTemplate));
}

function buildSessionLoopPrompt(loop: LoopState): string {
  const sections = [
    `Loop task: ${loop.config.title}`,
    loop.config.description ? `Description:\n${loop.config.description}` : undefined,
    loop.config.taskPrompt ? `Task prompt:\n${loop.config.taskPrompt}` : undefined,
    loop.config.instructions ? `Instructions:\n${loop.config.instructions}` : undefined,
  ].filter((section): section is string => section !== undefined);

  return sections.join("\n\n");
}

function buildGoalLoopPrompt(loop: LoopState, goal: GoalState): string {
  return [
    "Run this ArchCode Goal from a Loop.",
    `Goal ID: ${goal.id}`,
    `Goal title JSON: ${JSON.stringify(goal.title)}`,
    `Goal objective JSON: ${JSON.stringify(goal.objective)}`,
    `Goal acceptance criteria JSON: ${JSON.stringify(goal.acceptanceCriteria)}`,
    `Loop ID: ${loop.loopId}`,
    `Loop title JSON: ${JSON.stringify(loop.config.title)}`,
    "Runtime has already started and claimed this Goal for the current main session.",
    "Work against the natural-language objective and acceptance criteria, use available tools and delegation as needed, and have Reviewer finalize the review receipt through goal_manage.finalize_review.",
  ].join("\n");
}

function loopOrigin(loop: LoopState, trigger: LoopRunTrigger, runId: string): ToolExecutionOrigin {
  return {
    kind: "loop",
    loopId: loop.loopId,
    runId,
    trigger,
    approvalPolicy: loop.config.approvalPolicy,
  };
}

function loopRunOptions(loop: LoopState): { runType: "session" | "goal"; agentName: AgentName; extraTools: readonly string[] } {
  const template = getLoopTemplate(loop.config.templateId);
  return {
    runType: template.run.type,
    agentName: template.run.agent,
    extraTools: template.extraTools,
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isSchedulerTerminalStatus(status: LoopRunReportStatus): status is Exclude<LoopRunReportStatus, "running" | "skipped"> {
  return status !== "running" && status !== "skipped";
}

function executionFailureMessage(status: SessionFile["executions"][number]["status"] | undefined, error: string | undefined): string {
  if (error !== undefined && error.length > 0) return error;
  if (status === undefined) return "Session execution finished without an execution record.";
  return `Session execution finished with status ${status}.`;
}

async function resolveCanonicalHeadSha(workspaceRoot: string): Promise<string> {
  const result = await createProcessRunner().run({
    argv: ["git", "rev-parse", "--verify", "HEAD"],
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024,
  });
  if (result.kind !== "success") throw new Error("Unable to resolve canonical HEAD SHA for loop worktree job.");
  return result.output.stdout.trim();
}

function jobClassForTrigger(trigger: LoopRunTrigger): "local" | "remote" {
  return trigger === "manual" || trigger === "interval" || trigger === "cron" ? "local" : "remote";
}

function jobStatusForCleanup(result: LoopRunnerFinishedResult): LoopJobStatus {
  if (result.blockedReason === "needs_user") return "needs_user";
  if (result.blockedReason !== undefined && result.status === "skipped") return "blocked";
  if (result.status === "succeeded") return "succeeded";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "skipped") return "skipped";
  return "failed";
}

function evidencePathsForLoopRun(result: LoopRunnerFinishedResult): string[] {
  const paths = new Set<string>();
  if (result.observedArtifacts !== undefined) {
    for (const artifact of result.observedArtifacts) paths.add(artifact.path);
  }
  return [...paths];
}

function observedArtifactsFromInspection(inspection: LoopWorktreeInspection, cleanupState: LoopCleanupState): LoopWorktreeArtifact[] {
  const artifacts = new Map<string, LoopWorktreeArtifact>();
  for (const artifact of inspection.evidenceArtifacts) artifacts.set(artifact.path, artifact);
  for (const path of inspection.untrackedFiles) {
    if (!artifacts.has(path)) artifacts.set(path, { path, status: "created" });
  }
  if (inspection.diffStats.committed.trim().length > 0) {
    artifacts.set("git:committed-diff", { path: "git:committed-diff", status: "observed" });
  }
  if (inspection.diffStats.workingTree.trim().length > 0) {
    artifacts.set("git:working-tree-diff", { path: "git:working-tree-diff", status: "observed" });
  }
  if (inspection.localCommitsAhead > 0) {
    artifacts.set(`git:local-commits-ahead:${inspection.localCommitsAhead}`, { path: `git:local-commits-ahead:${inspection.localCommitsAhead}`, status: "observed" });
  }
  artifacts.set(`git:branch:${inspection.branchName}`, { path: `git:branch:${inspection.branchName}`, status: "observed" });
  artifacts.set(`cleanup:${cleanupState}`, { path: `cleanup:${cleanupState}`, status: "observed" });
  return [...artifacts.values()].slice(0, 100);
}

function pendingUserInteractionFromSession(session: SessionFile): { blockedByHitlIds?: string[] } | undefined {
  const directIds = session.blockedByHitlIds ?? (session.blockedHitl === undefined ? [] : [session.blockedHitl.hitlId]);
  if (directIds.length > 0) return { blockedByHitlIds: directIds };
  const pendingHitl = new Set<string>();
  const terminalHitlStatuses = new Map<string, unknown>();
  for (const envelope of session.events ?? []) {
    const payload = envelope.payload as Record<string, unknown> | undefined;
    if (payload?.type === "hitl.request") {
      const request = payload.request as Record<string, unknown> | undefined;
      if (typeof request?.hitlId === "string") pendingHitl.add(request.hitlId);
    }
    if (payload?.type === "hitl.resolved" && typeof payload.hitlId === "string") {
      pendingHitl.delete(payload.hitlId);
      terminalHitlStatuses.set(payload.hitlId, payload.status);
    }
  }
  if (pendingHitl.size > 0) return { blockedByHitlIds: [...pendingHitl] };
  return [...terminalHitlStatuses.values()].some((status) => status !== "resolved")
    ? {}
    : undefined;
}
