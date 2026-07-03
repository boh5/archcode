import type { SessionFile } from "../store/helpers";
import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { GoalState } from "../goals/state";
import type { ToolExecutionOrigin } from "../tools/types";
import type { LoopSchedulerRunInput, LoopSchedulerRunResult, LoopSchedulerRunner } from "./scheduler";
import type { LoopGoalTemplate, LoopRunReport, LoopRunTrigger, LoopState } from "./state";
import { LoopConfigSchema, LoopGoalTemplateSchema, LoopStateManager } from "./state";

export interface LoopRunnerSessionRuntime {
  createSession(workspaceRoot: string, options?: LoopRunnerCreateSessionOptions): Promise<SessionFile>;
  getSessionFile(workspaceRoot: string, sessionId: string): Promise<SessionFile>;
  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution;
}

export interface LoopRunnerGoalStateManager {
  create(
    projectId: string,
    title: string,
    author: string,
    doneConditions: GoalState["doneConditions"],
    retryPolicy: GoalState["retryPolicy"],
    approvalPoints: GoalState["approvalPoints"],
    reviewerAgent: string,
  ): Promise<GoalState>;
  lock(goalId: string, lockedBy: string): Promise<GoalState>;
}

export interface LoopRunnerGoalRuntime {
  start(goalId: string, options?: LoopRunnerGoalStartOptions): Promise<GoalState>;
}

export interface LoopRunnerGoalStartOptions {
  readonly loopId?: string;
  readonly sessionTitle?: string;
}

export interface LoopRunnerCreateSessionOptions {
  readonly goalId?: string;
  readonly loopId?: string;
  readonly sessionRole?: "main";
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
  readonly #activeLoops = new Map<string, { runId: string; sessionId?: string }>();

  constructor(options: LoopRunnerOptions) {
    this.#stateManager = options.stateManager;
    this.#runtime = options.runtime;
    this.#goalStateManager = options.goalStateManager;
    this.#goalRunner = options.goalRunner;
    this.#workspaceRoot = options.workspaceRoot;
    this.#projectSlug = options.projectSlug ?? "";
    this.#now = options.now ?? (() => Date.now());
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
    const runningReport: LoopRunReport = {
      runId,
      loopId: current.loopId,
      status: "running",
      trigger,
      startedAt,
    };

    this.#activeLoops.set(current.loopId, { runId });
    let startedState = await this.#stateManager.recordRunStart(current.loopId, runningReport);
    let currentReport = runningReport;
    try {
      const session = await this.#createLoopSession(startedState);
      this.#activeLoops.set(current.loopId, { runId, sessionId: session.sessionId });
      currentReport = { ...runningReport, sessionId: session.sessionId };
      startedState = await this.#stateManager.recordRunStart(current.loopId, currentReport);
      const result = await this.#executeLoopSession({ loop: startedState, trigger, runId, startedAt }, session.sessionId);
      return await this.#finishRun(startedState, currentReport, result);
    } catch (error) {
      return await this.#finishRun(startedState, currentReport, {
        status: "failed",
        sessionId: currentReport.sessionId,
        error: errorToMessage(error),
      });
    } finally {
      this.#activeLoops.delete(current.loopId);
    }
  }

  createSchedulerRunner(): LoopSchedulerRunner {
    return async (input) => input.loop.config.runKind === "goal"
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
    const runningReport: LoopRunReport = {
      runId,
      loopId: current.loopId,
      status: "running",
      trigger,
      startedAt,
    };

    this.#activeLoops.set(current.loopId, { runId });
    let startedState = await this.#stateManager.recordRunStart(current.loopId, runningReport);
    try {
      const result = await this.#runGoal({ loop: startedState, trigger, runId, startedAt });
      return await this.#finishRun(startedState, runningReport, result);
    } catch (error) {
      return await this.#finishRun(startedState, runningReport, {
        status: "failed",
        error: errorToMessage(error),
      });
    } finally {
      this.#activeLoops.delete(current.loopId);
    }
  }

  async runScheduledSessionLoop(input: LoopSchedulerRunInput): Promise<LoopSchedulerRunResult> {
    this.#assertSessionLoop(input.loop);
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

  async #runGoal(input: LoopSchedulerRunInput): Promise<Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult> {
    const goalStateManager = this.#requireGoalStateManager(input.loop.loopId);
    const goalRunner = this.#requireGoalRunner(input.loop.loopId);
    const template = snapshotGoalTemplate(input.loop);
    let goalId: string | undefined;

    try {
      const draft = await goalStateManager.create(
        input.loop.projectId,
        template.title,
        template.author,
        template.doneConditions,
        template.retryPolicy,
        template.approvalPoints,
        template.reviewerAgent,
      );
      goalId = draft.id;
      const locked = await goalStateManager.lock(draft.id, template.author);
      const started = await goalRunner.start(locked.id, {
        loopId: input.loop.loopId,
        sessionTitle: `Loop Goal: ${input.loop.config.title}`,
      });
      return await this.#executeGoalSession(input, started);
    } catch (error) {
      return {
        status: "failed",
        goalId,
        error: errorToMessage(error),
      };
    }
  }

  async #executeGoalSession(
    input: LoopSchedulerRunInput,
    goal: GoalState,
  ): Promise<Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult> {
    const sessionId = goal.mainSessionId;
    if (sessionId === undefined) {
      return {
        status: "failed",
        goalId: goal.id,
        error: `Goal ${goal.id} started without a main session.`,
      };
    }

    try {
      const execution = this.#runtime.startSessionExecution({
        slug: this.#projectSlug,
        workspaceRoot: this.#workspaceRoot,
        sessionId,
        userMessage: buildGoalLoopPrompt(input.loop, goal),
        maxSteps: input.loop.config.limits.maxIterationsPerRun,
        origin: loopOrigin(input.loop, input.trigger),
      });
      await execution.promise;
      const result = await this.#sessionResultFromFinalState(input.loop, sessionId);
      return {
        ...result,
        goalId: goal.id,
        summary: result.status === "succeeded"
          ? `Goal ${goal.id} session ${sessionId} completed for loop "${input.loop.config.title}".`
          : result.summary,
      };
    } catch (error) {
      return {
        status: "failed",
        goalId: goal.id,
        sessionId,
        error: errorToMessage(error),
      };
    }
  }

  async #runSession(input: LoopSchedulerRunInput): Promise<Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult> {
    const session = await this.#createLoopSession(input.loop);
    const active = this.#activeLoops.get(input.loop.loopId);
    if (active !== undefined) this.#activeLoops.set(input.loop.loopId, { ...active, sessionId: session.sessionId });
    return await this.#executeLoopSession(input, session.sessionId);
  }

  async #createLoopSession(loop: LoopState): Promise<SessionFile> {
    return await this.#runtime.createSession(this.#workspaceRoot, {
      loopId: loop.loopId,
      sessionRole: "main",
      title: `Loop: ${loop.config.title}`,
    });
  }

  async #executeLoopSession(
    input: LoopSchedulerRunInput,
    sessionId: string,
  ): Promise<Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult> {
    const execution = this.#runtime.startSessionExecution({
      slug: this.#projectSlug,
      workspaceRoot: this.#workspaceRoot,
      sessionId,
      userMessage: buildSessionLoopPrompt(input.loop),
      maxSteps: input.loop.config.limits.maxIterationsPerRun,
      origin: loopOrigin(input.loop, input.trigger),
    });

    try {
      await execution.promise;
      return await this.#sessionResultFromFinalState(input.loop, sessionId);
    } catch (error) {
      return {
        status: "failed",
        sessionId,
        error: errorToMessage(error),
      };
    }
  }

  async #sessionResultFromFinalState(
    loop: LoopState,
    sessionId: string,
  ): Promise<Required<Pick<LoopSchedulerRunResult, "status">> & LoopSchedulerRunResult> {
    const session = await this.#runtime.getSessionFile(this.#workspaceRoot, sessionId);
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
    };
    await this.#stateManager.recordRunFinish(loop.loopId, report);
    return report;
  }

  #assertSessionLoop(loop: LoopState): void {
    const config = LoopConfigSchema.parse(loop.config);
    if (loop.config.runKind !== "session") {
      throw new Error(`Loop ${loop.loopId} is configured for ${config.runKind} runs; session runner only handles session loops.`);
    }
  }

  #assertGoalLoop(loop: LoopState): void {
    const config = LoopConfigSchema.parse(loop.config);
    if (config.runKind !== "goal") {
      throw new Error(`Loop ${loop.loopId} is configured for ${config.runKind} runs; goal runner only handles goal loops.`);
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
    "Bootstrap an ArchCode Goal run.",
    `Goal ID: ${goal.id}`,
    `Goal title JSON: ${JSON.stringify(goal.title)}`,
    `Loop ID: ${loop.loopId}`,
    `Loop title JSON: ${JSON.stringify(loop.config.title)}`,
    "Your first action must be calling goal_run with this Goal ID. Do not edit files, delegate, advance phases, or record Done evidence until goal_run succeeds.",
    "After goal_run succeeds, load the Goal state, follow the Goal operating loop, keep Done Conditions locked, use Plan/Build/Reviewer delegation, record Reviewer evidence with goal_check_done, and report progress.",
  ].join("\n");
}

function loopOrigin(loop: LoopState, trigger: LoopRunTrigger): ToolExecutionOrigin {
  return {
    kind: "loop",
    loopId: loop.loopId,
    trigger,
    mode: loop.config.mode,
    approvalPolicy: loop.config.approvalPolicy,
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function executionFailureMessage(status: SessionFile["executions"][number]["status"] | undefined, error: string | undefined): string {
  if (error !== undefined && error.length > 0) return error;
  if (status === undefined) return "Session execution finished without an execution record.";
  return `Session execution finished with status ${status}.`;
}
