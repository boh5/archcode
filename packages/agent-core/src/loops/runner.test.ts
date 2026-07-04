import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type SessionExecutionRecord } from "@archcode/protocol";

import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { GoalState } from "../goals/state";
import type { SessionFile } from "../store/helpers";
import { LoopActiveConflictError, LoopRunner } from "./runner";
import { LoopConfigSchema, LoopStateManager, type LoopConfig, type LoopGoalTemplate, type LoopState } from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-runner");
const RUN_DIR = join(TMP_DIR, `run-${crypto.randomUUID()}`);
let nextWorkspaceId = 1;

const sessionLoopConfig: LoopConfig = {
  title: "Daily triage",
  description: "Review repository health",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "act",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 7 },
  taskPrompt: "Inspect status and summarize risks.",
  instructions: "Keep the report concise.",
};

const goalTemplate: LoopGoalTemplate = {
  title: "Ship loop-created goal",
  author: "architect",
  doneConditions: [
    { id: "done-file", kind: "file_exists", params: { path: "done.md" } },
    { id: "reviewer-check", kind: "tests_pass", params: { command: "bun test packages/agent-core/src/loops/runner.test.ts" }, required: false },
  ],
  retryPolicy: { maxRetries: 2, backoffMs: 25, escalateOnFailure: true },
  approvalPoints: ["after_plan", "before_complete"],
  reviewerAgent: "reviewer",
  prompt: "Build only the requested scope.",
  instructions: "Keep reviewer evidence in Goal artifacts.",
};

const goalLoopConfig: LoopConfig = {
  title: "Goal loop",
  description: "Create a Goal on every run",
  schedule: { kind: "manual" },
  runKind: "goal",
  mode: "act",
  approvalPolicy: "explicit_per_run",
  limits: { maxIterationsPerRun: 4 },
  goalTemplate,
};

beforeAll(async () => {
  await rm(RUN_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(RUN_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(RUN_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("session loop runner", () => {
  test("creates a linked main session and records a succeeded run report", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    expect(report.status).toBe("succeeded");
    expect(report.sessionId).toBe("session-1");
    expect(report.summary).toContain("Session session-1 completed");
    expect(report.startedAt).toBe(1_000);
    expect(report.endedAt).toBe(1_000);
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, {
      loopId: loop.loopId,
      sessionRole: "main",
      title: "Loop: Daily triage",
    });
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      workspaceRoot: fixture.workspaceRoot,
      sessionId: "session-1",
      maxSteps: 7,
    } satisfies Partial<StartSessionExecutionInput>));
    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(executionInput?.origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "manual",
      mode: "act",
      approvalPolicy: "interactive",
      toolProfileId: undefined,
    });
    expect(loopRunId(executionInput)).toEqual(expect.any(String));
    expect(executionInput?.userMessage).toContain("Task prompt:\nInspect status and summarize risks.");
    expect(executionInput?.userMessage).toContain("Instructions:\nKeep the report concise.");

    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ status: "succeeded", sessionId: "session-1" });
    expect(state.runCount).toBe(1);
    const log = await fixture.stateManager.readRunLog(loop.loopId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "succeeded", sessionId: "session-1" });
  });

  test("records failed report when session execution rejects", async () => {
    const deferred = createDeferred<void>();
    const fixture = await createFixture({ executionPromise: deferred.promise });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const run = fixture.runner.runSessionLoop(loop, "manual");
    await waitFor(() => fixture.runtime.startSessionExecutionMock.mock.calls.length === 1);
    deferred.reject(new Error("boom"));
    const report = await run;

    expect(report.status).toBe("failed");
    expect(report.error).toBe("boom");
    expect(report.sessionId).toBe("session-1");
    expect((await fixture.stateManager.read(loop.loopId)).lastRun).toMatchObject({ status: "failed", sessionId: "session-1", error: "boom" });
    expect(await fixture.stateManager.readRunLog(loop.loopId, 1)).toEqual([expect.objectContaining({ status: "failed", sessionId: "session-1", error: "boom" })]);
  });

  test("records failed report when execution promise resolves but session status is failed", async () => {
    const fixture = await createFixture({
      sessionExecutions: [{ id: "run-1", startedAt: 100, status: "failed", endedAt: 150, durationMs: 50, error: "agent failed" }],
    });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    expect(report.status).toBe("failed");
    expect(report.sessionId).toBe("session-1");
    expect(report.error).toBe("agent failed");
    expect((await fixture.stateManager.read(loop.loopId)).lastRun).toMatchObject({ status: "failed", sessionId: "session-1", error: "agent failed" });
  });

  test("exposes active conflict without creating a second session for overlapping manual trigger", async () => {
    const deferred = createDeferred<void>();
    const fixture = await createFixture({ executionPromise: deferred.promise });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const first = fixture.runner.runSessionLoop(loop, "manual");
    try {
      await waitFor(() => fixture.runtime.startSessionExecutionMock.mock.calls.length === 1);

      const conflict = await captureAsyncError(() => fixture.runner.runSessionLoop(loop, "manual"));
      expect(conflict).toBeInstanceOf(LoopActiveConflictError);
      expect(fixture.runtime.createSessionMock).toHaveBeenCalledTimes(1);
      expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledTimes(1);
    } finally {
      deferred.resolve();
    }

    expect((await first).status).toBe("succeeded");
  });

  test("scheduler-compatible callback starts a session and returns result without writing reports itself", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "interval",
      runId: "run-from-scheduler",
      startedAt: 2_000,
    });

    expect(result).toMatchObject({ status: "succeeded", sessionId: "session-1" });
    expect((await fixture.stateManager.readRunLog(loop.loopId))).toEqual([]);
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0].origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "interval",
    });
  });

  test("scheduler-compatible callback does not start a session after the run was cancelled before session creation", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);
    const started = await fixture.stateManager.recordRunStart(loop.loopId, {
      runId: "cancel-before-session",
      loopId: loop.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 2_000,
    });
    await fixture.stateManager.recordRunFinish(loop.loopId, {
      runId: "cancel-before-session",
      loopId: loop.loopId,
      status: "cancelled",
      trigger: "interval",
      startedAt: 2_000,
      endedAt: 2_010,
      reason: "global_kill_active",
    });

    const result = await fixture.runner.createSchedulerRunner()({
      loop: started,
      trigger: "interval",
      runId: "cancel-before-session",
      startedAt: 2_000,
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "global_kill_active" });
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback does not start execution when cancellation wins after session creation", async () => {
    let stateManager!: LoopStateManager;
    let loopId = "";
    const fixture = await createFixture({
      afterCreateSession: async (sessionId) => {
        await stateManager.recordRunFinish(loopId, {
          runId: "cancel-after-session",
          loopId,
          status: "cancelled",
          trigger: "interval",
          startedAt: 2_000,
          endedAt: 2_020,
          reason: "cancelled_by_user",
          sessionId,
        });
      },
    });
    stateManager = fixture.stateManager;
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);
    loopId = loop.loopId;
    const started = await fixture.stateManager.recordRunStart(loop.loopId, {
      runId: "cancel-after-session",
      loopId: loop.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 2_000,
    });

    const result = await fixture.runner.createSchedulerRunner()({
      loop: started,
      trigger: "interval",
      runId: "cancel-after-session",
      startedAt: 2_000,
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "cancelled_by_user", sessionId: "session-1" });
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
  });
});

describe("goal loop runner", () => {
  test("goal loop creates fresh goal from copied inline template on every run", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);
    const parsedLoopTemplate = loop.config.goalTemplate;
    if (parsedLoopTemplate === undefined) throw new Error("Expected inline goal template");
    const originalLoopTemplate = structuredClone(parsedLoopTemplate);

    const first = await fixture.runner.runGoalLoop(loop, "manual");
    expect(first.status).toBe("succeeded");
    expect(first.goalId).toBe("goal-1");
    expect(first.sessionId).toBe("goal-session-1");

    const firstGoal = fixture.goalStateManager.goals.get("goal-1");
    if (firstGoal === undefined) throw new Error("Expected goal-1 to exist");
    firstGoal.doneConditions[0] = { id: "mutated", kind: "file_exists", params: { path: "mutated.md" } };
    firstGoal.retryPolicy.maxRetries = 99;
    firstGoal.approvalPoints.push("after_plan");

    const second = await fixture.runner.runGoalLoop(loop, "manual");

    expect(second.status).toBe("succeeded");
    expect(second.goalId).toBe("goal-2");
    expect(second.sessionId).toBe("goal-session-2");
    expect(first.goalId).not.toBe(second.goalId);
    expect(loop.config.goalTemplate).toEqual(originalLoopTemplate);
    expect(fixture.goalStateManager.createMock).toHaveBeenCalledTimes(2);
    expect(fixture.goalStateManager.createMock.mock.calls[1]?.[3]).toEqual(originalLoopTemplate.doneConditions);
    expect(fixture.goalStateManager.createMock.mock.calls[1]?.[4]).toEqual(originalLoopTemplate.retryPolicy);
    expect(fixture.goalStateManager.createMock.mock.calls[1]?.[5]).toEqual(originalLoopTemplate.approvalPoints);

    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.lastRun).toMatchObject({ status: "succeeded", goalId: "goal-2", sessionId: "goal-session-2" });
    expect(state.runCount).toBe(2);
  });

  test("goal loop rejects goalTemplateId before runner execution and creates no goal", async () => {
    const fixture = await createFixture();
    const badConfig = {
      ...goalLoopConfig,
      goalTemplateId: "existing-goal",
    };
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);
    const malformedLoop = { ...loop, config: badConfig } as unknown as LoopState;

    expect(() => LoopConfigSchema.parse(badConfig)).toThrow();
    const rejection = await captureAsyncError(() => fixture.runner.runGoalLoop(malformedLoop, "manual"));
    expect(rejection).toBeInstanceOf(Error);
    expect(fixture.goalStateManager.createMock).not.toHaveBeenCalled();
    expect(fixture.goalRunner.startMock).not.toHaveBeenCalled();
  });

  test("goal loop passes Done reviewer and approval data to Goal lifecycle without evaluating it", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);
    const expectedTemplate = loop.config.goalTemplate;
    if (expectedTemplate === undefined) throw new Error("Expected inline goal template");

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({ status: "succeeded", goalId: "goal-1", sessionId: "goal-session-1" });
    expect(fixture.goalStateManager.createMock).toHaveBeenCalledWith(
      "project-a",
      expectedTemplate.title,
      expectedTemplate.author,
      expectedTemplate.doneConditions,
      expectedTemplate.retryPolicy,
      expectedTemplate.approvalPoints,
      expectedTemplate.reviewerAgent,
    );
    expect(fixture.goalStateManager.lockMock).toHaveBeenCalledWith("goal-1", expectedTemplate.author);
    expect(fixture.goalRunner.startMock).toHaveBeenCalledWith("goal-1", {
      loopId: loop.loopId,
      sessionTitle: "Loop Goal: Goal loop",
    });
    expect(fixture.goalRunner.doneEvaluationCount).toBe(0);
  });

  test("goal loop starts the created Goal main session through runtime execution", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({
      status: "succeeded",
      goalId: "goal-1",
      sessionId: "goal-session-1",
      summary: `Goal goal-1 session goal-session-1 completed for loop "${goalLoopConfig.title}".`,
    });
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      workspaceRoot: fixture.workspaceRoot,
      sessionId: "goal-session-1",
      maxSteps: 4,
    } satisfies Partial<StartSessionExecutionInput>));
    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(executionInput?.origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "manual",
      mode: "act",
      approvalPolicy: "explicit_per_run",
      toolProfileId: undefined,
    });
    expect(loopRunId(executionInput)).toEqual(expect.any(String));
    expect(executionInput?.userMessage).toContain("Bootstrap an ArchCode Goal run.");
    expect(executionInput?.userMessage).toContain("Goal ID: goal-1");
    expect(executionInput?.userMessage).toContain(`Loop ID: ${loop.loopId}`);
    expect(executionInput?.userMessage).toContain("Your first action must be calling goal_run with this Goal ID.");

    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.lastRun).toMatchObject({ status: "succeeded", goalId: "goal-1", sessionId: "goal-session-1" });
  });

  test("goal loop records failed report when Goal main session execution finishes failed", async () => {
    const fixture = await createFixture({
      sessionExecutions: [{ id: "run-1", startedAt: 100, status: "failed", endedAt: 150, durationMs: 50, error: "goal agent failed" }],
    });
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({ status: "failed", goalId: "goal-1", sessionId: "goal-session-1", error: "goal agent failed" });
    expect((await fixture.stateManager.read(loop.loopId)).lastRun).toMatchObject({
      status: "failed",
      goalId: "goal-1",
      sessionId: "goal-session-1",
      error: "goal agent failed",
    });
  });

  test("goal loop records failed report with goal id and error when GoalRunner fails", async () => {
    const fixture = await createFixture({ goalStartError: new Error("goal start failed") });
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({ status: "failed", goalId: "goal-1", error: "goal start failed" });
    expect(report.sessionId).toBeUndefined();
    expect((await fixture.stateManager.read(loop.loopId)).lastRun).toMatchObject({ status: "failed", goalId: "goal-1", error: "goal start failed" });
  });

  test("scheduler-compatible callback starts goal loops without writing reports itself", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "interval",
      runId: "scheduled-goal-run",
      startedAt: 3_000,
    });

    expect(result).toMatchObject({ status: "succeeded", goalId: "goal-1", sessionId: "goal-session-1" });
    expect(await fixture.stateManager.readRunLog(loop.loopId)).toEqual([]);
  });

  test("scheduler-compatible callback does not start goal session execution when cancellation wins after goal start", async () => {
    let stateManager!: LoopStateManager;
    let loopId = "";
    const fixture = await createFixture({
      afterGoalStart: async (goal) => {
        const sessionId = goal.mainSessionId;
        if (sessionId === undefined) throw new Error("Expected fake goal session");
        await stateManager.recordRunFinish(loopId, {
          runId: "cancel-goal-after-start",
          loopId,
          status: "cancelled",
          trigger: "interval",
          startedAt: 3_000,
          endedAt: 3_010,
          reason: "global_kill_active",
          goalId: goal.id,
          sessionId,
        });
      },
    });
    stateManager = fixture.stateManager;
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);
    loopId = loop.loopId;
    const started = await fixture.stateManager.recordRunStart(loop.loopId, {
      runId: "cancel-goal-after-start",
      loopId: loop.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 3_000,
    });

    const result = await fixture.runner.createSchedulerRunner()({
      loop: started,
      trigger: "interval",
      runId: "cancel-goal-after-start",
      startedAt: 3_000,
    });

    expect(result).toMatchObject({ status: "cancelled", reason: "global_kill_active", goalId: "goal-1", sessionId: "goal-session-1" });
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
  });
});

async function createFixture(options: {
  executionPromise?: Promise<void>;
  sessionExecutions?: SessionExecutionRecord[];
  goalStartError?: Error;
  afterCreateSession?: (sessionId: string) => Promise<void>;
  afterGoalStart?: (goal: GoalState) => Promise<void>;
} = {}): Promise<{
  stateManager: LoopStateManager;
  runtime: FakeLoopRuntime;
  goalStateManager: FakeGoalStateManager;
  goalRunner: FakeGoalRunner;
  runner: LoopRunner;
  workspaceRoot: string;
}> {
  const workspaceRoot = join(RUN_DIR, `workspace-${nextWorkspaceId++}-${crypto.randomUUID()}`);
  await mkdir(workspaceRoot, { recursive: true });
  const stateManager = new LoopStateManager(workspaceRoot);
  const runtime = new FakeLoopRuntime(options.executionPromise ?? Promise.resolve(), options.sessionExecutions, options.afterCreateSession);
  const goalStateManager = new FakeGoalStateManager();
  const goalRunner = new FakeGoalRunner(goalStateManager, options.goalStartError, options.afterGoalStart);
  const runner = new LoopRunner({
    stateManager,
    runtime,
    goalStateManager,
    goalRunner,
    workspaceRoot,
    projectSlug: "project-a",
    now: () => 1_000,
  });
  return { stateManager, runtime, goalStateManager, goalRunner, runner, workspaceRoot };
}

class FakeLoopRuntime {
  #nextSession = 1;
  readonly #sessions = new Map<string, SessionFile>();
  readonly createSessionMock = mock(async (_workspaceRoot: string, options?: { goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> => {
    const sessionId = `session-${this.#nextSession++}`;
    const session = this.#makeSession(sessionId, options);
    this.#sessions.set(sessionId, session);
    await this.afterCreateSession?.(sessionId);
    return session;
  });
  readonly startSessionExecutionMock = mock((input: StartSessionExecutionInput): ActiveSessionExecution => {
    if (!this.#sessions.has(input.sessionId)) {
      this.#sessions.set(input.sessionId, this.#makeSession(input.sessionId));
    }
    return {
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: input.agentName ?? "orchestrator",
      origin: "user_message",
      abortController: new AbortController(),
      promise: this.executionPromise,
      executionToken: Symbol(`test:${input.sessionId}`),
      startedAt: Date.now(),
    };
  });

  #makeSession(sessionId: string, options?: { goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): SessionFile {
    return {
      sessionId,
      createdAt: Date.now(),
      agentName: "orchestrator",
      title: options?.title ?? null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: this.sessionExecutions,
      todos: [],
      pendingInteractions: [],
      reminders: [],
      childSessionLinks: [],
      rootSessionId: sessionId,
      ...(options?.goalId === undefined ? {} : { goalId: options.goalId }),
      ...(options?.loopId === undefined ? {} : { loopId: options.loopId }),
      ...(options?.sessionRole === undefined ? {} : { sessionRole: options.sessionRole }),
    };
  }

  constructor(
    private readonly executionPromise: Promise<void>,
    private readonly sessionExecutions: SessionExecutionRecord[] = [{ id: "run-1", startedAt: 100, status: "completed", endedAt: 150, durationMs: 50 }],
    private readonly afterCreateSession?: (sessionId: string) => Promise<void>,
  ) {}

  async createSession(workspaceRoot: string, options?: { goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> {
    return await this.createSessionMock(workspaceRoot, options);
  }

  async getSessionFile(_workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`Missing fake session ${sessionId}`);
    return session;
  }

  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.startSessionExecutionMock(input);
  }
}

class FakeGoalStateManager {
  #nextGoal = 1;
  readonly goals = new Map<string, GoalState>();
  readonly createMock = mock(async (
    projectId: string,
    title: string,
    author: string,
    doneConditions: GoalState["doneConditions"],
    retryPolicy: GoalState["retryPolicy"],
    approvalPoints: GoalState["approvalPoints"],
    reviewerAgent: string,
  ): Promise<GoalState> => {
    const id = `goal-${this.#nextGoal++}`;
    const now = new Date(0).toISOString();
    const goal: GoalState = {
      id,
      projectId,
      title,
      status: "draft",
      phase: "plan",
      doneConditions: structuredClone(doneConditions),
      doneResults: {},
      reviewerAgent,
      retryPolicy: structuredClone(retryPolicy),
      retryCount: 0,
      approvalPoints: structuredClone(approvalPoints),
      author,
      childSessionIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(id, goal);
    return goal;
  });
  readonly lockMock = mock(async (goalId: string, lockedBy: string): Promise<GoalState> => {
    const goal = this.goals.get(goalId);
    if (goal === undefined) throw new Error(`Missing fake goal ${goalId}`);
    const locked: GoalState = { ...goal, status: "locked", lockedBy, lockedAt: new Date(0).toISOString() };
    this.goals.set(goalId, locked);
    return locked;
  });

  async create(
    projectId: string,
    title: string,
    author: string,
    doneConditions: GoalState["doneConditions"],
    retryPolicy: GoalState["retryPolicy"],
    approvalPoints: GoalState["approvalPoints"],
    reviewerAgent: string,
  ): Promise<GoalState> {
    return await this.createMock(projectId, title, author, doneConditions, retryPolicy, approvalPoints, reviewerAgent);
  }

  async lock(goalId: string, lockedBy: string): Promise<GoalState> {
    return await this.lockMock(goalId, lockedBy);
  }
}

class FakeGoalRunner {
  readonly startMock = mock(async (goalId: string, _options?: { loopId?: string; sessionTitle?: string }): Promise<GoalState> => {
    if (this.startError) throw this.startError;
    const goal = this.goalStateManager.goals.get(goalId);
    if (goal === undefined) throw new Error(`Missing fake goal ${goalId}`);
    const running: GoalState = { ...goal, status: "running", mainSessionId: `goal-session-${this.startMock.mock.calls.length}` };
    this.goalStateManager.goals.set(goalId, running);
    await this.afterGoalStart?.(running);
    return running;
  });
  readonly doneEvaluationCount = 0;

  constructor(
    private readonly goalStateManager: FakeGoalStateManager,
    private readonly startError?: Error,
    private readonly afterGoalStart?: (goal: GoalState) => Promise<void>,
  ) {}

  async start(goalId: string, options?: { loopId?: string; sessionTitle?: string }): Promise<GoalState> {
    return await this.startMock(goalId, options);
  }
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function loopRunId(input: StartSessionExecutionInput | undefined): string | undefined {
  const origin = input?.origin;
  if (origin === undefined || typeof origin !== "object") return undefined;
  return origin.kind === "loop" ? origin.runId : undefined;
}

function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  return action().then(
    () => {
      throw new Error("Expected async action to throw");
    },
    (error: unknown) => error,
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for predicate");
}
