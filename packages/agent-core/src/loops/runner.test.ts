import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createEmptySessionStats, type SessionExecutionRecord } from "@archcode/protocol";

import type {
  ActiveSessionExecution,
  SessionCwdReferenceMigrationInput,
  SessionCwdRemovalLifecycle,
  SessionCwdRemovalResult,
  StartSessionExecutionInput,
} from "../execution";
import type { GoalState } from "../goals/state";
import { GoalStateManager } from "../goals/state";
import { HitlService } from "../hitl/service";
import { ResumeCoordinator } from "../hitl/resume-coordinator";
import { silentLogger } from "../logger";
import type { SessionFile } from "../store/helpers";
import { SessionStoreManager } from "../store/session-store-manager";
import { CollisionLedger } from "./collision-ledger";
import { LoopJobCoordinator } from "./coordinator";
import { LoopHitlResumeAdapter } from "./hitl-resume-adapter";
import { LoopJobQueue } from "./job-queue";
import { LoopActiveConflictError, LoopRunner, type LoopRunnerGoalStartOptions, type LoopRunnerWorktreeManager } from "./runner";
import { LoopScheduler, type LoopSchedulerRunInput } from "./scheduler";
import { LoopConfigSchema, LoopStateManager, type CollisionTarget, type LoopConfig, type LoopGoalTemplate, type LoopState } from "./state";
import type { LoopWorktreeInspection } from "./worktree-manager";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-runner");
const RUN_DIR = join(TMP_DIR, `run-${crypto.randomUUID()}`);
let nextWorkspaceId = 1;

const sessionLoopConfig: LoopConfig = {
  templateId: "maintain_fix",
  title: null,
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 7 },
  taskPrompt: "Inspect status and summarize risks.",
};

const goalTemplate: LoopGoalTemplate = {
  title: null,
  objective: "Build only the requested scope for the loop-created Goal.",
  acceptanceCriteria: "Reviewer can verify the change from session logs, diff, and ordinary verification output.",
};

const goalLoopConfig: LoopConfig = {
  templateId: "goal_runner",
  title: null,
  schedule: { kind: "manual" },
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
      cwd: fixture.workspaceRoot,
      loopId: loop.loopId,
      sessionRole: "main",
      agentName: "build",
    });
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      workspaceRoot: fixture.workspaceRoot,
      sessionId: "session-1",
      maxSteps: 7,
      agentName: "build",
      extraTools: [],
    } satisfies Partial<StartSessionExecutionInput>));
    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(executionInput?.origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "manual",
      approvalPolicy: "interactive",
    });
    expect(loopRunId(executionInput)).toEqual(expect.any(String));
    expect(executionInput?.userMessage).toContain("Run instructions:\nInspect status and summarize risks.");
    expect(executionInput?.userMessage).not.toContain("Instructions:");

    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ status: "succeeded", sessionId: "session-1" });
    expect(state.runCount).toBe(1);
    const log = await fixture.stateManager.readRunLog(loop.loopId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ status: "succeeded", sessionId: "session-1" });
  });

  test("does not pass generated Loop title metadata to the run session", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);
    await fixture.stateManager.setTitleIfEmpty(loop.loopId, "Generated loop title");

    await fixture.runner.runSessionLoop(await fixture.stateManager.read(loop.loopId), "manual");

    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, {
      cwd: fixture.workspaceRoot,
      loopId: loop.loopId,
      sessionRole: "main",
      agentName: "build",
    });
  });

  test("passes PR Babysitter template extra tools and selected base agent", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      templateId: "pr_babysitter",
    });

    const report = await fixture.runner.runSessionLoop(loop, "manual");

    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(report.status).toBe("succeeded");
    expect(executionInput?.agentName).toBe("plan");
    expect(executionInput?.extraTools).toEqual([
      "github_get_pull_request",
      "github_list_pull_requests",
      "github_get_pull_request_checks",
      "github_list_issue_comments",
      "github_create_issue_comment",
    ]);
    expect(executionInput?.origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "manual",
      approvalPolicy: "interactive",
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

  test("fails closed when worktree isolation has no manager or durable checkpoint callbacks", async () => {
    const missingManager = await createFixture();
    const managerLoop = await missingManager.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    await expect(missingManager.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop: managerLoop,
      trigger: "manual",
      runId: "missing-manager",
      startedAt: 3_900,
      job: testJob(managerLoop.loopId, { baseSha: "a".repeat(40) }),
    })).rejects.toMatchObject({ name: "LoopWorktreeExecutionConfigurationError", reason: "manager_required" });
    expect(missingManager.runtime.createSessionMock).not.toHaveBeenCalled();

    const missingCallbacks = await createFixture({ worktreePath: "/tmp/missing-checkpoint-callbacks" });
    const callbacksLoop = await missingCallbacks.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    await expect(missingCallbacks.runner.createSchedulerRunner()({
      loop: callbacksLoop,
      trigger: "manual",
      runId: "missing-callbacks",
      startedAt: 3_901,
      job: testJob(callbacksLoop.loopId, { baseSha: "a".repeat(40) }),
    })).rejects.toMatchObject({ name: "LoopWorktreeExecutionConfigurationError", reason: "checkpoint_callbacks_required" });
    expect(missingCallbacks.worktreeManager?.createMock).not.toHaveBeenCalled();
    expect(missingCallbacks.runtime.createSessionMock).not.toHaveBeenCalled();
  });

  test("fails closed when a direct run requests worktree isolation without a durable job", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/direct-worktree" });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });

    await expect(fixture.runner.runSessionLoop(loop, "manual")).rejects.toMatchObject({
      name: "LoopWorktreeExecutionConfigurationError",
      reason: "durable_job_required",
    });
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback executes queued jobs in worktree workspace and returns artifact summary", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/archcode-loop-worktree" });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const job = testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
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
      cleanupState: "in_progress",
    });
    expect(result.observedArtifacts).toContainEqual({ path: "evidence/report.md", status: "created" });
    expect(result.observedArtifacts).toContainEqual({ path: "git:branch:archcode/loop/test/job", status: "observed" });
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, expect.objectContaining({
      loopId: loop.loopId,
      cwd: "/tmp/archcode-loop-worktree",
    }));
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: fixture.workspaceRoot });
    expect(fixture.runtime.getSessionFileMock).toHaveBeenCalledWith(fixture.workspaceRoot, "session-1");
    expect(fixture.runtime.releaseSessionAgentMock).toHaveBeenCalledWith(fixture.workspaceRoot, "session-1");
    expect(fixture.runtime.releaseSessionAgentMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.createMock).toHaveBeenCalledWith(expect.objectContaining({
      loopSlug: `loop-${loop.loopId.slice(0, 8)}`,
      subjectSlug: job.subjectKey,
      jobId: job.jobId,
      baseSha: "a".repeat(40),
      jobClass: "local",
    }));
    expect(await fixture.stateManager.readRunLog(loop.loopId)).toEqual([]);
  });

  test("checkpoints a created worktree before creating the canonical Session", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/checkpoint-before-session" });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const job = testJob(loop.loopId, { baseSha: "a".repeat(40) });
    const checkpointBaseSha = mock(async () => {
      expect(fixture.worktreeManager?.createMock).not.toHaveBeenCalled();
      expect(fixture.worktreeManager?.reuseMock).not.toHaveBeenCalled();
    });
    const checkpointWorktree = mock(async () => {
      expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
      expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
    });

    await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "checkpoint-before-session-run",
      startedAt: 4_001,
      job,
      ...worktreeCheckpointCallbacks(),
      checkpointBaseSha,
      checkpointWorktree,
    });

    expect(checkpointBaseSha).toHaveBeenCalledTimes(1);
    expect(checkpointBaseSha).toHaveBeenCalledWith("a".repeat(40));
    expect(checkpointWorktree).toHaveBeenCalledTimes(1);
    expect(checkpointWorktree).toHaveBeenCalledWith({
      worktreePath: "/tmp/checkpoint-before-session",
      worktreeBranchName: "archcode/loop/test/job",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
    });
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledTimes(1);
  });

  test("persists the exact Loop worktree claim before initial Session execution starts", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/claim-before-execution" });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const runId = "claim-before-execution-run";
    const started = await fixture.stateManager.recordRunStart(loop.loopId, {
      runId,
      loopId: loop.loopId,
      status: "running",
      trigger: "manual",
      startedAt: 4_005,
    });
    const checkpointSessionAttempt = mock(async (checkpoint: { runId: string; sessionId: string; sessionExecutionId: string }) => {
      expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
      expect((await fixture.stateManager.read(loop.loopId)).currentRun).toMatchObject({
        runId,
        sessionId: checkpoint.sessionId,
        worktreeBranchName: "archcode/loop/test/job",
      });
    });

    await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop: started,
      trigger: "manual",
      runId,
      startedAt: 4_005,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) }),
      checkpointSessionAttempt,
    });

    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledTimes(1);
    expect((await fixture.stateManager.read(loop.loopId)).currentRun).toMatchObject({
      runId,
      sessionId: "session-1",
      worktreePath: "/tmp/claim-before-execution",
      worktreeBranchName: "archcode/loop/test/job",
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
    });
    expect(checkpointSessionAttempt).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0].executionId)
      .toBe(checkpointSessionAttempt.mock.calls[0]?.[0].sessionExecutionId);
  });

  test("resolves and checkpoints an absent base SHA before creating the worktree", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/resolved-base-checkpoint" });
    await initializeGitRepo(fixture.workspaceRoot);
    const baseSha = await git(fixture.workspaceRoot, ["rev-parse", "HEAD"]);
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const checkpointBaseSha = mock(async (resolvedBaseSha: string) => {
      expect(resolvedBaseSha).toBe(baseSha);
      expect(fixture.worktreeManager?.createMock).not.toHaveBeenCalled();
    });

    await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "resolved-base-checkpoint-run",
      startedAt: 4_001,
      job: testJob(loop.loopId),
      checkpointBaseSha,
    });

    expect(checkpointBaseSha).toHaveBeenCalledWith(baseSha);
    expect(fixture.worktreeManager?.createMock).toHaveBeenCalledWith(expect.objectContaining({ baseSha }));
  });

  test("does not mutate Git when the write-ahead base checkpoint fails", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/base-checkpoint-failure" });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const checkpointError = new Error("base checkpoint write failed");

    await expect(fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "base-checkpoint-failure-run",
      startedAt: 4_001,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40) }),
      checkpointBaseSha: async () => { throw checkpointError; },
    })).rejects.toBe(checkpointError);

    expect(fixture.worktreeManager?.createMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.reuseMock).not.toHaveBeenCalled();
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
  });

  test("does not create a Session or execute an Agent when worktree checkpoint persistence fails", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/checkpoint-failure", worktreeHasChanges: false });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const checkpointError = new Error("checkpoint write failed");

    await expect(fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "checkpoint-failure-run",
      startedAt: 4_002,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40) }),
      checkpointWorktree: async () => { throw checkpointError; },
    })).rejects.toMatchObject({
      name: "LoopWorktreeScopeCheckpointError",
      cause: checkpointError,
      rollbackState: "cleaned",
    });

    expect(fixture.worktreeManager?.cleanupMock).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback reuses a persisted worktree after HITL requeue", async () => {
    const worktreePath = "/tmp/requeued-loop-worktree";
    const fixture = await createFixture({ worktreePath });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });
    const job = testJob(loop.loopId, {
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
      worktreePath,
    });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "requeued-worktree-run",
      startedAt: 4_000,
      job,
    });

    expect(result?.worktreePath).toBe(worktreePath);
    expect(fixture.worktreeManager?.reuseMock).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath,
      jobId: job.jobId,
      baseSha: job.baseSha,
    }));
    expect(fixture.worktreeManager?.createMock).not.toHaveBeenCalled();
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, expect.objectContaining({ cwd: worktreePath }));
  });

  test("scheduler-compatible callback emits cleanup intent without applying policy in the Runner", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/unchanged-preserved-worktree", worktreeHasChanges: false });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "unchanged-preserved-run",
      startedAt: 4_100,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) }),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "succeeded",
      worktreePath: "/tmp/unchanged-preserved-worktree",
      cleanupState: "in_progress",
    });
    expect(result.observedArtifacts).toContainEqual({ path: "cleanup:in_progress", status: "observed" });
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback leaves destructive cleanup to the durable saga", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/unchanged-cleaned-worktree", worktreeHasChanges: false });
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      useWorktree: true,
      cleanupPolicy: { deleteUnchangedWorktrees: true },
    });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "unchanged-cleaned-run",
      startedAt: 4_200,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) }),
    });
    if (result === undefined) throw new Error("Expected scheduler runner result");

    expect(result).toMatchObject({
      status: "succeeded",
      worktreePath: "/tmp/unchanged-cleaned-worktree",
      cleanupState: "in_progress",
    });
    expect(result.observedArtifacts).toContainEqual({ path: "cleanup:in_progress", status: "observed" });
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
    expect(fixture.runtime.migrateSessionCwdReferencesForRemovalMock).not.toHaveBeenCalled();
    expect((await fixture.runtime.getSessionFile(fixture.workspaceRoot, "session-1")).cwd).toBe("/tmp/unchanged-cleaned-worktree");
  });

  test("does not enter cleanup from the Runner after a completed Session result", async () => {
    const worktreePath = "/tmp/cleanup-lease-retry-worktree";
    const fixture = await createFixture({ worktreePath, worktreeHasChanges: false });
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      useWorktree: true,
      cleanupPolicy: { deleteUnchangedWorktrees: true },
    });
    fixture.runtime.migrateSessionCwdReferencesForRemovalMock
      .mockImplementationOnce(async (_input, operation) => await operation({
        beforeRemove: async () => { throw new Error("session became busy before cleanup"); },
        onRemoveFailureBeforeDetach: async () => undefined,
        onRemoveDetached: async () => undefined,
      }));

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "cleanup-lease-retry-run",
      startedAt: 4_225,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) }),
    });

    expect(result).toMatchObject({ status: "succeeded", cleanupState: "in_progress", worktreePath });
    expect(fixture.runtime.migrateSessionCwdReferencesForRemovalMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect((await fixture.runtime.getSessionFile(fixture.workspaceRoot, "session-1")).executions.at(-1)?.status).toBe("completed");
  });

  test("inspection of a changed worktree still emits a durable cleanup intent", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/changed-preserved-worktree", worktreeHasChanges: true });
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      useWorktree: true,
      cleanupPolicy: { deleteUnchangedWorktrees: true },
    });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "changed-preserved-run",
      startedAt: 4_250,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) }),
    });

    expect(result).toMatchObject({ cleanupState: "in_progress", worktreePath: "/tmp/changed-preserved-worktree" });
    expect(fixture.runtime.migrateSessionCwdReferencesForRemovalMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback releases prepared worktree when session creation fails before execution", async () => {
    const fixture = await createFixture({
      worktreePath: "/tmp/session-create-fail-worktree",
      createSessionError: new Error("create session failed"),
    });
    const loop = await fixture.stateManager.create("project-a", { ...sessionLoopConfig, useWorktree: true });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
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
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, expect.objectContaining({ loopId: loop.loopId, cwd: "/tmp/session-create-fail-worktree" }));
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionAgentMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback keeps plain manual queued jobs without git base in canonical workspace", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/plain-manual-unused-worktree" });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
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
    expect(fixture.runtime.createSessionMock).toHaveBeenCalledWith(fixture.workspaceRoot, expect.objectContaining({ loopId: loop.loopId }));
    expect(fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0]).toMatchObject({ workspaceRoot: fixture.workspaceRoot });
    expect(fixture.runtime.releaseSessionAgentMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback skips superseded queued jobs without creating worktree or session", async () => {
    const fixture = await createFixture({ worktreePath: "/tmp/superseded-worktree" });
    const loop = await fixture.stateManager.create("project-a", sessionLoopConfig);

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "on_pr",
      runId: "superseded-run",
      startedAt: 5_000,
      job: testJob(loop.loopId, { triggerKind: "on_pr", blockedReason: "superseded", subjectKey: "pr:1" }),
    });

    expect(result).toMatchObject({ status: "skipped", blockedReason: "superseded" });
    expect(fixture.runtime.createSessionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionAgentMock).not.toHaveBeenCalled();
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
    firstGoal.objective = "mutated objective";
    firstGoal.acceptanceCriteria = "mutated criteria";

    const second = await fixture.runner.runGoalLoop(loop, "manual");

    expect(second.status).toBe("succeeded");
    expect(second.goalId).toBe("goal-2");
    expect(second.sessionId).toBe("goal-session-2");
    expect(first.goalId).not.toBe(second.goalId);
    expect(loop.config.goalTemplate).toEqual(originalLoopTemplate);
    expect(fixture.goalStateManager.createMock).toHaveBeenCalledTimes(2);
    expect(fixture.goalStateManager.createMock.mock.calls[1]?.[0]).toEqual({
      projectId: "project-a",
      title: null,
      objective: originalLoopTemplate.objective,
      acceptanceCriteria: originalLoopTemplate.acceptanceCriteria,
      loopId: loop.loopId,
    });

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

  test("goal loop passes natural-language objective and acceptance criteria to Goal lifecycle", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);
    const expectedTemplate = loop.config.goalTemplate;
    if (expectedTemplate === undefined) throw new Error("Expected inline goal template");

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({ status: "succeeded", goalId: "goal-1", sessionId: "goal-session-1" });
    expect(fixture.goalStateManager.createMock).toHaveBeenCalledWith({
      projectId: "project-a",
      title: null,
      objective: expectedTemplate.objective,
      acceptanceCriteria: expectedTemplate.acceptanceCriteria,
      loopId: loop.loopId,
    });
    expect(fixture.goalRunner.startMock).toHaveBeenCalledWith("goal-1", {
      executionScope: {
        kind: "loop",
        loopId: loop.loopId,
        cwd: fixture.workspaceRoot,
      },
    });
  });

  test("goal loop starts the created Goal main session through runtime execution", async () => {
    const fixture = await createFixture();
    const loop = await fixture.stateManager.create("project-a", goalLoopConfig);

    const report = await fixture.runner.runGoalLoop(loop, "manual");

    expect(report).toMatchObject({
      status: "succeeded",
      goalId: "goal-1",
      sessionId: "goal-session-1",
      summary: `Goal goal-1 session goal-session-1 completed for loop ${loop.loopId}.`,
    });
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.startSessionExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      slug: "project-a",
      workspaceRoot: fixture.workspaceRoot,
      sessionId: "goal-session-1",
      maxSteps: 4,
      agentName: "orchestrator",
      extraTools: [],
    } satisfies Partial<StartSessionExecutionInput>));
    const executionInput = fixture.runtime.startSessionExecutionMock.mock.calls[0]?.[0];
    expect(executionInput?.origin).toMatchObject({
      kind: "loop",
      loopId: loop.loopId,
      trigger: "manual",
      approvalPolicy: "explicit_per_run",
    });
    expect(loopRunId(executionInput)).toEqual(expect.any(String));
    expect(executionInput?.userMessage).toContain("Run this ArchCode Goal from a Loop.");
    expect(executionInput?.userMessage).toContain("Goal ID: goal-1");
    expect(executionInput?.userMessage).toContain("Goal objective JSON");
    expect(executionInput?.userMessage).toContain("Goal acceptance criteria JSON");
    expect(executionInput?.userMessage).toContain(`Loop ID: ${loop.loopId}`);
    expect(executionInput?.userMessage).toContain("Runtime has already started and claimed this Goal for the current main session.");
    expect(executionInput?.userMessage).not.toContain("Your first action must be calling goal_manage");
    expect(executionInput?.userMessage).not.toContain("Do not edit files, delegate");
    expect(executionInput?.userMessage).toContain("goal_manage.finalize_review");

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
      ...worktreeCheckpointCallbacks(),
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
    const loop = await fixture.stateManager.create("project-a", { ...goalLoopConfig, useWorktree: true });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
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
    expect(fixture.goalStateManager.createMock).toHaveBeenCalledTimes(1);
    expect(fixture.goalRunner.startMock).toHaveBeenCalledWith("goal-1", expect.objectContaining({
      executionScope: expect.objectContaining({ cwd: "/tmp/goal-start-fail-worktree" }),
    }));
    expect(fixture.runtime.startSessionExecutionMock).not.toHaveBeenCalled();
    expect(fixture.runtime.releaseSessionAgentMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
  });

  test("scheduler-compatible callback releases prepared worktree when started goal has no main session", async () => {
    const worktreePath = "/tmp/goal-missing-session-worktree";
    const fixture = await createFixture({
      worktreePath,
      goalStartWithoutMainSession: true,
    });
    const loop = await fixture.stateManager.create("project-a", { ...goalLoopConfig, useWorktree: true });

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
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
    expect(fixture.runtime.releaseSessionAgentMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
  });

  test("does not enter cleanup from the Runner after a completed Goal Session result", async () => {
    const worktreePath = "/tmp/goal-cleanup-lease-retry-worktree";
    const fixture = await createFixture({ worktreePath, worktreeHasChanges: false });
    const loop = await fixture.stateManager.create("project-a", {
      ...goalLoopConfig,
      useWorktree: true,
      cleanupPolicy: { deleteUnchangedWorktrees: true },
    });
    fixture.runtime.migrateSessionCwdReferencesForRemovalMock
      .mockImplementationOnce(async (_input, operation) => await operation({
        beforeRemove: async () => { throw new Error("goal session became busy before cleanup"); },
        onRemoveFailureBeforeDetach: async () => undefined,
        onRemoveDetached: async () => undefined,
      }));

    const result = await fixture.runner.createSchedulerRunner()({
      ...worktreeCheckpointCallbacks(),
      loop,
      trigger: "manual",
      runId: "goal-cleanup-lease-retry-run",
      startedAt: 4_750,
      job: testJob(loop.loopId, { baseSha: "a".repeat(40), resolvedHeadSha: "a".repeat(40) }),
    });

    expect(result).toMatchObject({ status: "succeeded", cleanupState: "in_progress", worktreePath });
    expect(fixture.runtime.migrateSessionCwdReferencesForRemovalMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.cleanupMock).not.toHaveBeenCalled();
    expect(fixture.worktreeManager?.inspectMock).toHaveBeenCalledTimes(1);
    expect((await fixture.runtime.getSessionFile(fixture.workspaceRoot, "goal-session-1")).executions.at(-1)?.status).toBe("completed");
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

describe("loop-owned-hitl resume", () => {
  test("approved continuation clears needs_user state before the real scheduler dispatches it", async () => {
    const fixture = await createLoopHitlFixture({ dispatchContinuation: true });
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      approvalPolicy: "explicit_per_run",
    });
    const blocked = await fixture.scheduler.runManual(loop.loopId);
    const hitlId = blocked?.blockedByHitlIds?.[0];
    if (hitlId === undefined) throw new Error("Expected Loop HITL id");

    await fixture.coordinator.respond(hitlId, { type: "approval_decision", decision: "approved" });
    await waitFor(async () => (await fixture.jobQueue.list())[0]?.status === "succeeded");

    expect(fixture.runnerMock).toHaveBeenCalledTimes(1);
    expect(fixture.stateSeenBeforeDispatchMock).toHaveBeenCalledTimes(1);
    const stateSeenBeforeDispatch = fixture.stateSeenBeforeDispatchMock.mock.calls[0]?.[0] as LoopState | undefined;
    expect(stateSeenBeforeDispatch?.attentionStatus).toBe("clear");
    expect(stateSeenBeforeDispatch?.currentRun).toBeUndefined();
    expect((await fixture.jobQueue.list())[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    const finalState = await fixture.stateManager.read(loop.loopId);
    expect(finalState.attentionStatus).toBe("clear");
    expect(finalState.currentRun).toBeUndefined();
    expect(finalState.lastRun).toMatchObject({ status: "succeeded" });
  });

  test("loop-owned-hitl explicit run approval writes owner-local HITL and duplicate approve re-enqueues once", async () => {
    const fixture = await createLoopHitlFixture();
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      approvalPolicy: "explicit_per_run",
    });

    const report = await fixture.scheduler.runManual(loop.loopId);

    expect(fixture.runnerMock).not.toHaveBeenCalled();
    const hitlId = report?.blockedByHitlIds?.[0];
    if (hitlId === undefined) throw new Error("Expected Loop HITL id");
    expect(report).toMatchObject({
      status: "needs_user",
      blockedReason: "needs_user",
      blockedByHitlIds: [hitlId],
      attentionStatus: "waiting_for_human",
    });
    const projections = await fixture.hitl.list({ scope: "loop", ownerId: loop.loopId, includeChildren: true });
    expect(projections).toHaveLength(1);
    expect(projections[0]).toMatchObject({
      hitlId,
      owner: { ownerType: "loop", ownerId: loop.loopId },
      source: { type: "loop_approval", loopId: loop.loopId, approvalPoint: "explicit_per_run" },
    });
    expect(await fixture.hitl.knownOwners()).toContainEqual({ projectSlug: "project-a", ownerType: "loop", ownerId: loop.loopId });
    const ownerStore = await fixture.hitl.ownerStore({ projectSlug: "project-a", ownerType: "loop", ownerId: loop.loopId });
    expect((await ownerStore.list()).map((record) => record.hitlId)).toContain(hitlId);
    expect(await ownerStore.lookup(hitlId)).toMatchObject({ status: "found" });
    expect(await fixture.hitl.lookup(hitlId)).toMatchObject({ status: "found" });
    expect(await Bun.file(await fixture.stateManager.loopHitlPath(loop.loopId)).exists()).toBe(true);

    const first = await fixture.coordinator.respond(hitlId, { type: "approval_decision", decision: "approved" });
    const second = await fixture.coordinator.respond(hitlId, { type: "approval_decision", decision: "approved" });
    expect(first.status).not.toBe("missing");
    expect(second.scheduled).toBe(false);
    await waitFor(async () => (
      (await fixture.jobQueue.list(["pending"])).length === 1
      && (await fixture.stateManager.read(loop.loopId)).attentionStatus === "clear"
      && fixture.continuationQueuedMock.mock.calls.length === 1
    ));
    expect(fixture.continuationQueuedMock).toHaveBeenCalledTimes(1);

    const jobs = await fixture.jobQueue.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe("pending");
    expect(jobs[0]?.blockedByHitlIds).toBeUndefined();
    expect(jobs[0]?.resumeCheckpoint).toBeUndefined();
    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.attentionStatus).toBe("clear");
    expect(state.blockedByHitlIds).toBeUndefined();
  });

  test("loop-owned-hitl denied approval terminally skips blocked job", async () => {
    const fixture = await createLoopHitlFixture();
    const loop = await fixture.stateManager.create("project-a", {
      ...sessionLoopConfig,
      approvalPolicy: "explicit_per_run",
    });
    const report = await fixture.scheduler.runManual(loop.loopId);
    const hitlId = report?.blockedByHitlIds?.[0];
    if (hitlId === undefined) throw new Error("Expected Loop HITL id");

    const result = await fixture.coordinator.respond(hitlId, { type: "approval_decision", decision: "denied", comment: "not now" });
    expect(result.scheduled).toBe(true);
    await waitFor(async () => (await fixture.jobQueue.list(["skipped"])).length === 1 && (await fixture.stateManager.read(loop.loopId)).currentRun === undefined);

    expect((await fixture.jobQueue.list())[0]).toMatchObject({ status: "skipped", blockedReason: "not now" });
    const state = await fixture.stateManager.read(loop.loopId);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toMatchObject({ status: "skipped", summary: "not now" });
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
  worktreeHasChanges?: boolean;
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
  const worktreeManager = options.worktreePath === undefined ? undefined : new FakeWorktreeManager(options.worktreePath, options.worktreeHasChanges ?? true);
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

async function createLoopHitlFixture(options: { readonly dispatchContinuation?: boolean } = {}): Promise<{
  workspaceRoot: string;
  stateManager: LoopStateManager;
  jobQueue: LoopJobQueue;
  hitl: HitlService;
  coordinator: ResumeCoordinator;
  scheduler: LoopScheduler;
  runnerMock: ReturnType<typeof mock>;
  continuationQueuedMock: ReturnType<typeof mock>;
  stateSeenBeforeDispatchMock: ReturnType<typeof mock>;
}> {
  const workspaceRoot = join(RUN_DIR, `loop-hitl-${nextWorkspaceId++}-${crypto.randomUUID()}`);
  await mkdir(workspaceRoot, { recursive: true });
  const stateManager = new LoopStateManager(workspaceRoot);
  const jobQueue = new LoopJobQueue({ workspaceRoot, clock: { now: () => 1_000 } });
  const hitl = new HitlService({
    workspaceRoot,
    project: { slug: "project-a", name: "Project A" },
    sessions: new SessionStoreManager({ logger: silentLogger }),
    goalState: new GoalStateManager(workspaceRoot),
    loopState: stateManager,
  });
  await hitl.load(workspaceRoot);
  let scheduler!: LoopScheduler;
  const stateSeenBeforeDispatchMock = mock((_state: LoopState) => undefined);
  const continuationQueuedMock = mock(async (checkpoint: { readonly loopId: string }) => {
    if (options.dispatchContinuation !== true) return;
    stateSeenBeforeDispatchMock(await stateManager.read(checkpoint.loopId));
    await scheduler.dispatchPendingJobs();
  });
  const coordinator = new ResumeCoordinator({
    hitl,
    adapters: {
      loop: new LoopHitlResumeAdapter({
        workspaceRoot,
        stateManager,
        jobQueue,
        now: () => 1_000,
        onContinuationQueued: continuationQueuedMock,
      }),
    },
  });
  const runnerMock = mock(async (_input: LoopSchedulerRunInput) => ({ status: "succeeded" as const }));
  scheduler = new LoopScheduler({
    stateManager,
    runner: runnerMock,
    jobQueue,
    coordinator: new LoopJobCoordinator({ queue: jobQueue, clock: { now: () => 1_000 }, leaseTtlMs: 60_000 }),
    clock: { now: () => 1_000 },
    timer: { schedule: () => ({ id: undefined }), cancel: () => undefined },
    hitl,
  });
  return { workspaceRoot, stateManager, jobQueue, hitl, coordinator, scheduler, runnerMock, continuationQueuedMock, stateSeenBeforeDispatchMock };
}

class FakeLoopRuntime {
  #nextSession = 1;
  readonly #sessions = new Map<string, SessionFile>();
  readonly releaseSessionAgentMock = mock((_projectRoot: string, _sessionId: string): void => {});
  readonly migrateSessionCwdReferencesForRemovalMock = mock(async (
    input: SessionCwdReferenceMigrationInput,
    operation: (lifecycle: SessionCwdRemovalLifecycle) => Promise<SessionCwdRemovalResult>,
  ): Promise<SessionCwdRemovalResult> => await operation({
    beforeRemove: async () => {
      for (const [sessionId, session] of this.#sessions) {
        if (session.cwd !== input.fromCwd) continue;
        this.#sessions.set(sessionId, { ...session, cwd: input.toCwd });
      }
    },
    onRemoveFailureBeforeDetach: async () => {
      for (const [sessionId, session] of this.#sessions) {
        if (session.cwd !== input.toCwd) continue;
        this.#sessions.set(sessionId, { ...session, cwd: input.fromCwd });
      }
    },
    onRemoveDetached: async () => undefined,
  }));
  readonly createSessionMock = mock(async (_projectRoot: string, options?: { cwd?: string; goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> => {
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

  #makeSession(sessionId: string, options?: { cwd?: string; goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): SessionFile {
    return {
      sessionId,
      createdAt: Date.now(),
      cwd: options?.cwd ?? "/canonical-workspace",
      agentName: "orchestrator",
      title: options?.title ?? null,
      messages: [],
      steps: [],
      stats: createEmptySessionStats(),
      executions: this.sessionExecutions,
      todos: [],
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

  async createSession(projectRoot: string, options?: { cwd?: string; goalId?: string; loopId?: string; sessionRole?: "main"; title?: string }): Promise<SessionFile> {
    return await this.createSessionMock(projectRoot, options);
  }

  async getSessionFile(_workspaceRoot: string, sessionId: string): Promise<SessionFile> {
    return await this.getSessionFileMock(_workspaceRoot, sessionId);
  }

  startSessionExecution(input: StartSessionExecutionInput): ActiveSessionExecution {
    return this.startSessionExecutionMock(input);
  }

  releaseSessionAgent(projectRoot: string, sessionId: string): void {
    this.releaseSessionAgentMock(projectRoot, sessionId);
  }

  async migrateSessionCwdReferencesForRemoval<T extends SessionCwdRemovalResult>(
    input: SessionCwdReferenceMigrationInput,
    operation: (lifecycle: SessionCwdRemovalLifecycle) => Promise<T>,
  ): Promise<T> {
    return await this.migrateSessionCwdReferencesForRemovalMock(input, operation) as T;
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
  readonly reuseMock = mock(async (input: { loopSlug: string; subjectSlug: string; jobId: string; baseSha: string; worktreePath: string; jobClass?: "local" | "remote" }) => ({
    canonicalRoot: "/tmp/canonical",
    managedRoot: "/tmp/canonical.worktrees",
    worktreePath: input.worktreePath,
    worktreeName: "worktree-name",
    branchName: "archcode/loop/test/job",
    baseSha: input.baseSha,
    resolvedHeadSha: "b".repeat(40),
    canonicalStatus: { dirty: false, entries: [] },
  }));
  readonly inspectMock = mock(async (input: { worktreePath: string; branchName: string; baseSha: string }): Promise<LoopWorktreeInspection> => ({
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    baseSha: input.baseSha,
    headSha: this.hasChanges ? "b".repeat(40) : input.baseSha,
    status: this.hasChanges ? { dirty: true, entries: [{ path: "evidence/report.md", index: "?", worktree: "?", raw: "?? evidence/report.md" }] } : { dirty: false, entries: [] },
    untrackedFiles: this.hasChanges ? ["evidence/report.md"] : [],
    localCommitsAhead: this.hasChanges ? 1 : 0,
    changedRefs: this.hasChanges ? [{ ref: `refs/heads/${input.branchName}`, before: input.baseSha, after: "b".repeat(40) }] : [],
    diffStats: this.hasChanges ? { committed: " README.md | 1 +", workingTree: " evidence/report.md | 1 +" } : { committed: "", workingTree: "" },
    evidenceArtifacts: this.hasChanges ? [{ path: "evidence/report.md", status: "created" }] : [],
    hasChanges: this.hasChanges,
  }));
  readonly cleanupMock = mock(async (input: Parameters<LoopRunnerWorktreeManager["cleanup"]>[0]) => {
    const removed = !input.inspection.hasChanges && input.jobStatus !== "failed" && input.jobStatus !== "blocked" && input.jobStatus !== "needs_user";
    if (removed) {
      await input.beforeRemove?.();
      await input.onRemoveDetached?.();
    }
    return {
      cleanupState: removed ? "cleaned" as const : "preserved" as const,
      removed,
      reviewRequired: !removed,
      reason: removed ? "worktree had no changes" : "worktree contains changes",
      worktreePath: input.inspection.worktreePath,
    };
  });

  constructor(private readonly worktreePath: string, private readonly hasChanges: boolean) {}

  async create(input: Parameters<FakeWorktreeManager["createMock"]>[0]): ReturnType<FakeWorktreeManager["createMock"]> {
    return await this.createMock(input);
  }

  async reuse(input: Parameters<FakeWorktreeManager["reuseMock"]>[0]): ReturnType<FakeWorktreeManager["reuseMock"]> {
    return await this.reuseMock(input);
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
  readonly createMock = mock(async (input: {
    projectId: string;
    title?: string | null;
    objective: string;
    acceptanceCriteria: string;
    loopId?: string;
  }): Promise<GoalState> => {
    const id = `goal-${this.#nextGoal++}`;
    const now = new Date(0).toISOString();
    const goal: GoalState = {
      id,
      projectId: input.projectId,
      title: input.title ?? null,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria,
      status: "draft",
      attempt: 1,
      pendingHitlIds: [],
      approvalRefs: [],
      childSessionIds: [],
      ...(input.loopId === undefined ? {} : { loopId: input.loopId }),
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(id, goal);
    return goal;
  });

  async create(input: Parameters<FakeGoalStateManager["createMock"]>[0]): Promise<GoalState> {
    return await this.createMock(input);
  }
}

class FakeGoalRunner {
  readonly startMock = mock(async (goalId: string, _options: LoopRunnerGoalStartOptions): Promise<GoalState> => {
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

  constructor(
    private readonly goalStateManager: FakeGoalStateManager,
    private readonly startError?: Error,
    private readonly afterGoalStart?: (goal: GoalState) => Promise<void>,
    private readonly startWithoutMainSession = false,
  ) {}

  async start(goalId: string, options: LoopRunnerGoalStartOptions): Promise<GoalState> {
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

function worktreeCheckpointCallbacks(): Pick<LoopSchedulerRunInput, "checkpointBaseSha" | "checkpointWorktree"> {
  return {
    checkpointBaseSha: async () => {},
    checkpointWorktree: async () => {},
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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for predicate");
}

async function initializeGitRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "loop-runner@example.test"]);
  await git(cwd, ["config", "user.name", "Loop Runner Test"]);
  await Bun.write(join(cwd, "README.md"), "# loop runner\n");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "initial commit"]);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const process = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}
