import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type SessionExecutionRecord } from "@archcode/protocol";

import type { ActiveSessionExecution, StartSessionExecutionInput } from "../execution";
import type { GoalState } from "../goals/state";
import type { SessionFile } from "../store/helpers";
import { CollisionLedger } from "./collision-ledger";
import { LoopActiveConflictError, LoopRunner } from "./runner";
import type { LoopSchedulerRunInput } from "./scheduler";
import { LoopConfigSchema, LoopStateManager, type CollisionTarget, type LoopConfig, type LoopGoalTemplate, type LoopState } from "./state";
import type { LoopWorktreeInspection } from "./worktree-manager";

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

const staticFileTarget: CollisionTarget = { type: "file", path: "src/static.ts" };

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

  test("passes configured tool profile through Loop origin metadata", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      toolProfileId: "loop_github_pr_watch",
    });

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(report.toolProfileId).toBe("loop_github_pr_watch");
    expect(executionInput?.origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "manual",
      mode: "act",
      approvalPolicy: "interactive",
      toolProfileId: "loop_github_pr_watch",
    });
    expect(loopRunId(executionInput)).toEqual(expect.any(String));
  });

  test("claims static collision targets and releases leases after session success", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      collisionTargets: [staticFileTarget],
    });

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    expect(report).toMatchObject({ status: "succeeded", collisionTargets: [staticFileTarget] });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("releases static collision leases after session execution failure", async () => {
    const deferred = createDeferred<void>();
    const fixture = await createFixture({ executionPromise: deferred.promise });
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      collisionTargets: [staticFileTarget],
    });

    const run = fixture.runner.runSessionLoop(loop, "manual");
    await waitFor(() => fixture.runtime.startSessionExecutionMock.mock.calls.length === 1);
    expect(await fixture.collisionLedger.readActiveLeases()).toHaveLength(1);
    deferred.reject(new Error("boom"));
    const report = await run;

    expect(report.status).toBe("failed");
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
  });

  test("records collision_conflict skipped report when static target is already leased", async () => {
    const fixture = await createFixture();
    const holder = await fixture.stateManager.create("project-a", sessionLoopConfig);
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      collisionTargets: [staticFileTarget],
    });
    await fixture.collisionLedger.acquire({ target: staticFileTarget, loopId: holder.loopId, runId: "holder-run", priority: 0, createdAt: 0 });

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    expect(report).toMatchObject({ status: "skipped", reason: "collision_conflict" });
    expect(report.collisionConflicts?.[0]?.targetKey).toBe("file:src/static.ts");
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(await fixture.collisionLedger.readActiveLeases()).toHaveLength(1);
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

  test("scheduler-compatible callback executes queued jobs in worktree workspace and returns artifact summary", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/archcode-loop-worktree" });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);
    const job = testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) });

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "manual",
      runId: "queued-worktree-run",
      startedAt: 4_000,
      job,
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "succeeded",
      sessionId: "session-1",
      worktreePath: "/tmp/archcode-loop-worktree",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
      cleanupState: "preserved",
    });
    expect(result.observedArtifacts).toContainEqual({ path: "evidence/report.md", status: "created" });
    expect(result.observedArtifacts).toContainEqual({ path: "git:branch:archcode/loop/test/job", status: "observed" });
    expect(fixture.runtime.prepareSessionWorkspaceMock).toHaveBeenCalledWith("/tmp/archcode-loop-worktree", fixture.workspaceRoot);
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith("/tmp/archcode-loop-worktree", expect.objectContaining({ loopId: loop.loopId }));
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: "/tmp/archcode-loop-worktree" });
    expect(fixture.runtime.getSessionFileMock).toHaveBeenCalledWith("/tmp/archcode-loop-worktree", "session-1");
    expect(fixture.runtime.releaseSessionWorkspaceMock).toHaveBeenCalledWith("/tmp/archcode-loop-worktree", "session-1");
    expect(fixture.runtime.releaseSessionWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.createMock).toHaveBeenCalledWith(expect.objectContaining({
      loopSlug: "Daily triage",
      subjectSlug: job.subjectKey,
      jobId: job.jobId,
      baseSha: "a".repeat(40),
      jobClass: "local",
    }));
    expect(await fixture.stateManager.readRunLog(loop.loopId)).toEqual([]);
  });

  test("scheduler-compatible callback releases prepared worktree when session creation fails before execution", async () => {
    const fixture = await createFixture({
      worktreePath: "/tmp/session-create-fail-worktree",
      createSessionError: new Error("create session failed"),
    });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "manual",
      runId: "session-create-fail-run",
      startedAt: 4_500,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40) }),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "failed",
      error: "create session failed",
      worktreePath: "/tmp/session-create-fail-worktree",
    });
    expect(fixture.runtime.prepareSessionWorkspaceMock).toHaveBeenCalledWith("/tmp/session-create-fail-worktree", fixture.workspaceRoot);
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith("/tmp/session-create-fail-worktree", expect.objectContaining({ loopId: loop.loopId }));
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionWorkspaceMock.mock.calls).toEqual([["/tmp/session-create-fail-worktree", undefined]]);
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.cleanupMock).toHaveBeenCalledTimes(1);
  });

  test("scheduler-compatible callback keeps plain manual queued jobs without git base in canonical workspace", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/plain-manual-unused-worktree" });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "manual",
      runId: "plain-manual-run",
      startedAt: 4_550,
      job: testJob(loop.loopId),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({ status: "succeeded", sessionId: "session-1" });
    expect(result.worktreePath).toBeUndefined();
    expect(fixture.worktreeManager?.createMock).not.toHaveBeenCalled();
    expect(fixture.runtime.prepareSessionWorkspaceMock).not.toHaveBeenCalled();
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, expect.objectContaining({ loopId: loop.loopId }));
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: fixture.workspaceRoot });
    expect(fixture.runtime.releaseSessionWorkspaceMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback skips superseded queued jobs without creating worktree or session", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/superseded-worktree" });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "on_pr",
      runId: "superseded-run",
      startedAt: 5_000,
      job: testJob(loop.loopId, { triggerKind: "on_pr", blockedReason: "superseded", subjectKey: "pr:1" }),
    });

    expect(result).toMatchObject({ status: "skipped", blockedReason: "superseded" });
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionWorkspaceMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.createMock).not.toHaveBeenCalled();
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
      workspaceRoot: fixture.workspaceRoot,
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

  test("releases static collision leases when goal start throws", async () => {
    const fixture = await createFixture({ goalStartError: new Error("goal start failed") });
    const loop = await fixture.stateManager.create("project-a", {
      ...goalLoopConfig,
      collisionTargets: [staticFileTarget],
    });

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({ status: "failed", error: "goal start failed" });
    expect(await fixture.collisionLedger.readActiveLeases()).toEqual([]);
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

  test("scheduler-compatible callback releases prepared worktree when goal start fails before session execution", async () => {
    const fixture = await createFixture({
      worktreePath: "/tmp/goal-start-fail-worktree",
      goalStartError: new Error("goal start failed"),
    });
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "manual",
      runId: "goal-start-fail-run",
      startedAt: 4_600,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40) }),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "failed",
      goalId: "goal-1",
      error: "goal start failed",
      worktreePath: "/tmp/goal-start-fail-worktree",
    });
    expect(fixture.runtime.prepareSessionWorkspaceMock).toHaveBeenCalledWith("/tmp/goal-start-fail-worktree", fixture.workspaceRoot);
    expect(fixture.goalStateManager.createMock).toHaveBeenCalledTimes(1);
    expect(fixture.goalStateManager.lockMock).toHaveBeenCalledWith("goal-1", goalTemplate.author);
    expect(fixture.goalRunner.startMock).toHaveBeenCalledWith("goal-1", expect.objectContaining({ workspaceRoot: "/tmp/goal-start-fail-worktree" }));
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionWorkspaceMock.mock.calls).toEqual([["/tmp/goal-start-fail-worktree", undefined]]);
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.cleanupMock).toHaveBeenCalledTimes(1);
  });

  test("scheduler-compatible callback releases prepared worktree when started goal has no main session", async () => {
    const worktreePath = "/tmp/goal-missing-session-worktree";
    const fixture = await createFixture({
      worktreePath,
      goalStartWithoutMainSession: true,
    });
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      loop,
      trigger: "manual",
      runId: "goal-missing-session-run",
      startedAt: 4_700,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40) }),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "failed",
      goalId: "goal-1",
      error: "Goal goal-1 started without a main session.",
      worktreePath,
    });
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionWorkspaceMock.mock.calls).toEqual([[worktreePath, undefined]]);
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.cleanupMock).toHaveBeenCalledTimes(1);
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
  createSessionError?: Error;
  goalStartError?: Error;
  goalStartWithoutMainSession?: boolean;
  afterCreateSession?: (sessionId: string) => Promise<void>;
  afterGoalStart?: (goal: GoalState) => Promise<void>;
  worktreePath?: string;
} = {}): Promise<{
  stateManager: LoopStateManager;
  runtime: FakeLoopRuntime;
  goalStateManager: FakeGoalStateManager;
  goalRunner: FakeGoalRunner;
  runner: LoopRunner;
  collisionLedger: CollisionLedger;
  worktreeManager?: FakeWorktreeManager;
  workspaceRoot: string;
}> {
  const workspaceRoot = join(RUN_DIR, `workspace-${nextWorkspaceId++}-${crypto.randomUUID()}`);
  await mkdir(workspaceRoot, { recursive: true });
  const stateManager = new LoopStateManager(workspaceRoot);
  const runtime = new FakeLoopRuntime(options.executionPromise ?? Promise.resolve(), options.sessionExecutions, options.afterCreateSession, options.createSessionError);
  const goalStateManager = new FakeGoalStateManager();
  const goalRunner = new FakeGoalRunner(goalStateManager, options.goalStartError, options.afterGoalStart, options.goalStartWithoutMainSession ?? false);
  const collisionLedger = new CollisionLedger({ stateManager, workspaceRoot, clock: { now: () => 1_000 } });
  const worktreeManager = options.worktreePath === undefined ? undefined : new FakeWorktreeManager(options.worktreePath);
  const runner = new LoopRunner({
    stateManager,
    runtime,
    goalStateManager,
    goalRunner,
    workspaceRoot,
    projectSlug: "project-a",
    now: () => 1_000,
    collisionLedger,
    ...(worktreeManager === undefined ? {} : { worktreeManager }),
  });
  return { stateManager, runtime, goalStateManager, goalRunner, runner, collisionLedger, worktreeManager, workspaceRoot };
}

class FakeLoopRuntime {
  #nextSession = 1;
  readonly #sessions = new Map<string, SessionFile>();
  readonly prepareSessionWorkspaceMock = mock(async (_workspaceRoot: string, _canonicalWorkspaceRoot: string): Promise<void> => {});
  readonly releaseSessionWorkspaceMock = mock((_workspaceRoot: string, _sessionId?: string): void => {});
  readonly createSessionMock = mock(async (_workspaceRoot: string, options?: { goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> => {
    if (this.createSessionError !== undefined) throw this.createSessionError;
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
  readonly getSessionFileMock = mock(async (_workspaceRoot: string, sessionId: string): Promise<SessionFile> => {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) throw new Error(`Missing fake session ${sessionId}`);
    return session;
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
    private readonly createSessionError?: Error,
  ) {}

  async createSession(workspaceRoot: string, options?: { goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> {
    return await this.createSessionMock(workspaceRoot, options);
  }

  async getSessionFile(_workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    return await this.getSessionFileMock(_workspaceRoot, sessionId);
  }

  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.startSessionExecutionMock(input);
  }

  async prepareSessionWorkspace(workspaceRoot: string, canonicalWorkspaceRoot: string): Promise<void> {
    await this.prepareSessionWorkspaceMock(workspaceRoot, canonicalWorkspaceRoot);
  }

  releaseSessionWorkspace(workspaceRoot: string, sessionId?: string): void {
    this.releaseSessionWorkspaceMock(workspaceRoot, sessionId);
  }
}

class FakeWorktreeManager {
  readonly createMock = mock(async (input: { loopSlug: string; subjectSlug: string; jobId: string; baseSha: string; jobClass?: "local" | "remote" }) => ({
    canonicalRoot: "/tmp/canonical",
    managedRoot: "/tmp/canonical.worktrees",
    worktreePath: this.worktreePath,
    worktreeName: "worktree-name",
    branchName: "archcode/loop/test/job",
    baseSha: input.baseSha,
    resolvedHeadSha: input.baseSha,
    canonicalStatus: { dirty: false, entries: [] },
  }));
  readonly inspectMock = mock(async (input: { worktreePath: string; branchName: string; baseSha: string }): Promise<LoopWorktreeInspection> => ({
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    baseSha: input.baseSha,
    headSha: "b".repeat(40),
    status: { dirty: true, entries: [{ path: "evidence/report.md", index: "?", worktree: "?", raw: "?? evidence/report.md" }] },
    untrackedFiles: ["evidence/report.md"],
    localCommitsAhead: 1,
    changedRefs: [{ ref: `refs/heads/${input.branchName}`, before: input.baseSha, after: "b".repeat(40) }],
    diffStats: { committed: " README.md | 1 +", workingTree: " evidence/report.md | 1 +" },
    evidenceArtifacts: [{ path: "evidence/report.md", status: "created" }],
    hasChanges: true,
  }));
  readonly cleanupMock = mock(async (input: { inspection: LoopWorktreeInspection }) => ({
    cleanupState: "preserved" as const,
    removed: false,
    reviewRequired: true,
    reason: "worktree contains changes",
    worktreePath: input.inspection.worktreePath,
  }));

  constructor(private readonly worktreePath: string) {}

  async create(input: Parameters<FakeWorktreeManager["createMock"]>[0]): ReturnType<FakeWorktreeManager["createMock"]> {
    return await this.createMock(input);
  }

  async inspect(input: Parameters<FakeWorktreeManager["inspectMock"]>[0]): ReturnType<FakeWorktreeManager["inspectMock"]> {
    return await this.inspectMock(input);
  }

  async cleanup(input: Parameters<FakeWorktreeManager["cleanupMock"]>[0]): ReturnType<FakeWorktreeManager["cleanupMock"]> {
    return await this.cleanupMock(input);
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
  readonly startMock = mock(async (goalId: string, _options?: { loopId?: string; sessionTitle?: string; workspaceRoot?: string }): Promise<GoalState> => {
    if (this.startError) throw this.startError;
    const goal = this.goalStateManager.goals.get(goalId);
    if (goal === undefined) throw new Error(`Missing fake goal ${goalId}`);
    const running: GoalState = {
      ...goal,
      status: "running",
      ...(this.startWithoutMainSession ? {} : { mainSessionId: `goal-session-${this.startMock.mock.calls.length}` }),
    };
    this.goalStateManager.goals.set(goalId, running);
    await this.afterGoalStart?.(running);
    return running;
  });
  readonly doneEvaluationCount = 0;

  constructor(
    private readonly goalStateManager: FakeGoalStateManager,
    private readonly startError?: Error,
    private readonly afterGoalStart?: (goal: GoalState) => Promise<void>,
    private readonly startWithoutMainSession = false,
  ) {}

  async start(goalId: string, options?: { loopId?: string; sessionTitle?: string; workspaceRoot?: string }): Promise<GoalState> {
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

function testJob(loopId: string, overrides: Partial<NonNullable<LoopSchedulerRunInput["job"]>> = {}): NonNullable<LoopSchedulerRunInput["job"]> {
  return {
    jobId: "job-1234567890",
    triggerKind: "manual",
    subjectKey: `manual:${loopId}`,
    dedupeKey: `loop:${loopId}:manual`,
    ...overrides,
  };
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
