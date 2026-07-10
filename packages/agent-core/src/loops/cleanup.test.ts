import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CollisionLedger } from "./collision-ledger";
import {
  LoopCleanupService,
  normalizeLoopCleanupPolicy,
  type LoopCleanupServiceOptions,
  type LoopCleanupWorktreeManager,
} from "./cleanup";
import { LoopJobQueue, type LoopJobRecord } from "./job-queue";
import { LoopStateManager, type LoopConfig, type LoopRunReport, type LoopRunReportStatus, type LoopState, type LoopWorktreeArtifact } from "./state";
import { LoopWorktreeManager, type LoopWorktreeInspection } from "./worktree-manager";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-cleanup");
const START = Date.UTC(2026, 6, 6, 12, 0, 0, 0);

const baseConfig: LoopConfig = {
  templateId: "watch_report",
  title: "Cleanup loop",
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 1 },
};

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("LoopCleanupService", () => {
  test("normalizes conservative cleanup policy defaults", () => {
    expect(normalizeLoopCleanupPolicy(undefined)).toMatchObject({
      enabled: false,
      action: "mark",
      deleteUnchangedWorktrees: false,
      preserveChangedArtifacts: true,
      requiresNoPendingQueue: true,
    });
    expect(normalizeLoopCleanupPolicy({ deleteUnchangedWorktrees: true })).toMatchObject({
      enabled: true,
      action: "mark",
      deleteUnchangedWorktrees: true,
    });
    expect(normalizeLoopCleanupPolicy({ enabled: false, deleteUnchangedWorktrees: true })).toMatchObject({
      enabled: false,
      deleteUnchangedWorktrees: true,
    });
  });

  test("removes only a no-change completed worktree and keeps canonical run-log", async () => {
    const repo = await createGitRepo("no-change");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "no-change", jobId: "clean-job-123456", baseSha });
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:no-change",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const beforeLog = await fixture.stateManager.readRunLog(fixture.loop.loopId);
    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.worktrees).toContainEqual(expect.objectContaining({ jobId: job.jobId, cleanupState: "cleaned", removed: true }));
    expect(await pathExists(created.worktreePath)).toBe(false);
    expect(await git(repo, ["branch", "--list", created.branchName])).toBe("");
    const afterLog = await fixture.stateManager.readRunLog(fixture.loop.loopId);
    expect(afterLog).toHaveLength(1);
    expect(afterLog[0]?.runId).toBe(beforeLog[0]?.runId);
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ cleanupState: "cleaned" });
  });

  test("uses the Session-owned migration capability at the final removal boundary", async () => {
    const repo = await createGitRepo("session-cwd-transition");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "session-cwd", jobId: "session-cwd-job-123456", baseSha });
    let migrationCalls = 0;
    let migrationHeld = false;
    let observedInput: Parameters<NonNullable<LoopCleanupServiceOptions["migrateSessionCwdReferencesForRemoval"]>>[0] | undefined;
    const migrateSessionCwdReferencesForRemoval: NonNullable<LoopCleanupServiceOptions["migrateSessionCwdReferencesForRemoval"]> = async (input, operation) => {
      migrationCalls += 1;
      migrationHeld = true;
      observedInput = input;
      try {
        const result = await operation({
          beforeRemove: async () => {
            expect(migrationHeld).toBe(true);
            expect(await pathExists(input.fromCwd)).toBe(true);
            expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(baseSha);
          },
          onRemoveFailureBeforeDetach: async () => undefined,
          onRemoveDetached: async () => undefined,
        });
        expect(await pathExists(input.fromCwd)).toBe(false);
        return result;
      } finally {
        migrationHeld = false;
      }
    };
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
      migrateSessionCwdReferencesForRemoval,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:session-cwd",
      sessionId: "session-loop-cleanup",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(migrationCalls).toBe(1);
    expect(migrationHeld).toBe(false);
    expect(observedInput).toEqual({
      projectRoot: repo,
      fromCwd: created.worktreePath,
      toCwd: repo,
    });
    expect(result.worktrees).toContainEqual(expect.objectContaining({ jobId: job.jobId, cleanupState: "cleaned", removed: true }));
    expect(await pathExists(created.worktreePath)).toBe(false);
  });

  test("fails closed when the Session cwd reference migration capability is unavailable", async () => {
    const repo = await createGitRepo("session-cwd-callback-missing");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "missing-callback", jobId: "missing-callback-job-123456", baseSha });
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
      migrateSessionCwdReferencesForRemoval: null,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:missing-callback",
      sessionId: "session-missing-callback",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.decision).toBe("cleanup_failed");
    expect(result.worktrees).toContainEqual(expect.objectContaining({
      jobId: job.jobId,
      cleanupState: "cleanup_failed",
      removed: false,
      reason: expect.stringContaining("Session cwd reference migration capability"),
    }));
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(baseSha);
  });

  test("preserves the worktree when Session cwd reference migration fails", async () => {
    const repo = await createGitRepo("session-cwd-transition-failure");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "transition-failure", jobId: "transition-failure-job-123456", baseSha });
    let migrationReleased = false;
    const migrateSessionCwdReferencesForRemoval: NonNullable<LoopCleanupServiceOptions["migrateSessionCwdReferencesForRemoval"]> = async (_input, operation) => {
      try {
        return await operation({
          beforeRemove: async () => {
            throw new Error("Session cwd changed concurrently");
          },
          onRemoveFailureBeforeDetach: async () => undefined,
          onRemoveDetached: async () => undefined,
        });
      } finally {
        migrationReleased = true;
      }
    };
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
      migrateSessionCwdReferencesForRemoval,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:transition-failure",
      sessionId: "session-transition-failure",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(migrationReleased).toBe(true);
    expect(result.decision).toBe("cleanup_failed");
    expect(result.worktrees).toContainEqual(expect.objectContaining({
      jobId: job.jobId,
      cleanupState: "cleanup_failed",
      removed: false,
      reason: "Session cwd changed concurrently",
    }));
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(baseSha);
  });

  test("preserves an unchanged worktree when deletion is not explicitly enabled", async () => {
    const repo = await createGitRepo("no-change-preserved");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "no-change-preserved", jobId: "keep-job-123456", baseSha });
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", noFindingRuns: 10 },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:no-change-preserved",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.worktrees).toContainEqual(expect.objectContaining({ jobId: job.jobId, cleanupState: "preserved", removed: false, reviewRequired: false }));
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await git(repo, ["branch", "--list", created.branchName])).toContain(created.branchName);
    const updated = await fixture.jobQueue.read(job.jobId);
    expect(updated).toMatchObject({ cleanupState: "preserved" });
    expect(updated.observedArtifacts).toContainEqual({ path: `git:branch:${created.branchName}`, status: "observed" });
    expect(updated.observedArtifacts).toContainEqual({ path: "cleanup:preserved", status: "observed" });
  });

  test("preserves a changed completed worktree and records review-required artifacts", async () => {
    const repo = await createGitRepo("changed-completed");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "changed", jobId: "changed-job-123456", baseSha });
    await writeFile(join(created.worktreePath, "review-notes.txt"), "needs review\n");
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:changed",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.worktrees).toContainEqual(expect.objectContaining({ jobId: job.jobId, cleanupState: "preserved", reviewRequired: true }));
    expect(await pathExists(created.worktreePath)).toBe(true);
    const updated = await fixture.jobQueue.read(job.jobId);
    expect(updated).toMatchObject({ cleanupState: "preserved", blockedReason: "review_required" });
    expect(updated.observedArtifacts).toContainEqual({ path: "review-notes.txt", status: "created" });
    expect(updated.observedArtifacts).toContainEqual({ path: "cleanup:preserved", status: "observed" });
    expect(result.blockers.map((blocker) => blocker.code)).toContain("unreviewed_changed_worktree");
  });

  test("preserves a failed worktree with changes and marks failed-with-changes review", async () => {
    const repo = await createGitRepo("failed-with-changes");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "failed", jobId: "failed-job-123456", baseSha });
    await writeFile(join(created.worktreePath, "partial.txt"), "partial output\n");
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "failed",
      reportStatus: "failed",
      subjectKey: "manual:failed",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    await fixture.service.scanLoop(fixture.loop.loopId);

    expect(await pathExists(created.worktreePath)).toBe(true);
    const updated = await fixture.jobQueue.read(job.jobId);
    expect(updated).toMatchObject({ cleanupState: "preserved", blockedReason: "failed_with_changes" });
    expect(updated.observedArtifacts).toContainEqual({ path: "partial.txt", status: "created" });
  });

  test("preserves blocked jobs and their reasons without invoking worktree cleanup", async () => {
    const workspaceRoot = await createWorkspace("blocked");
    const worktreePath = join(workspaceRoot, "blocked-worktree");
    await mkdir(worktreePath, { recursive: true });
    const fakeWorktreeManager = new CountingWorktreeManager();
    const fixture = await createFixture(workspaceRoot, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 0, quietDays: 0 },
      worktreeManager: fakeWorktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "blocked",
      reportStatus: "skipped",
      subjectKey: "manual:blocked",
      blockedReason: "needs_user",
      worktreePath,
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
      observedArtifacts: [{ path: "git:branch:archcode/loop/cleanup/blocked", status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(fakeWorktreeManager.inspectMock).not.toHaveBeenCalled();
    expect(fakeWorktreeManager.cleanupMock).not.toHaveBeenCalled();
    expect(await pathExists(worktreePath)).toBe(true);
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ status: "blocked", blockedReason: "needs_user" });
    expect(result.blockers.map((blocker) => blocker.code)).toContain("open_job");
    expect(result.blockers.map((blocker) => blocker.code)).toContain("pending_hitl");
  });

  test("marks or auto-pauses only when retention thresholds pass and no blockers exist", async () => {
    const markFixture = await createFixture(await createWorkspace("mark-candidate"), {
      cleanupPolicy: { enabled: true, action: "mark", noFindingRuns: 0, quietDays: 0 },
    });

    const marked = await markFixture.service.scanLoop(markFixture.loop.loopId);
    expect(marked.decision).toBe("cleanup_candidate");
    expect((await markFixture.stateManager.read(markFixture.loop.loopId)).cleanupState).toBe("cleanup_candidate");
    expect((await markFixture.stateManager.read(markFixture.loop.loopId)).status).toBe("active");

    const pauseFixture = await createFixture(await createWorkspace("auto-pause"), {
      cleanupPolicy: { enabled: true, action: "pause", noFindingRuns: 0, quietDays: 0 },
    });

    const paused = await pauseFixture.service.scanLoop(pauseFixture.loop.loopId);
    const state = await pauseFixture.stateManager.read(pauseFixture.loop.loopId);
    expect(paused.decision).toBe("auto_paused");
    expect(state.status).toBe("paused");
    expect(state.cleanupState).toBe("auto_paused");
  });

  test("never auto-pauses when queued, running, blocked, HITL, review, integration, or lease blockers exist", async () => {
    const workspaceRoot = await createWorkspace("blockers");
    const fixture = await createFixture(workspaceRoot, {
      cleanupPolicy: { enabled: true, action: "pause", noFindingRuns: 0, quietDays: 0 },
    });
    await fixture.jobQueue.enqueue({ loopId: fixture.loop.loopId, triggerKind: "manual", subjectKey: "manual:queued" });
    const running = (await fixture.jobQueue.enqueue({ loopId: fixture.loop.loopId, triggerKind: "manual", subjectKey: "manual:running" })).job;
    await fixture.jobQueue.update(running.jobId, { status: "running", startedAt: START, leaseExpiresAt: START + 60_000 });
    const blocked = (await fixture.jobQueue.enqueue({ loopId: fixture.loop.loopId, triggerKind: "manual", subjectKey: "manual:blocked" })).job;
    await fixture.jobQueue.update(blocked.jobId, { status: "blocked", blockedReason: "needs_user" });
    const review = (await fixture.jobQueue.enqueue({ loopId: fixture.loop.loopId, triggerKind: "manual", subjectKey: "manual:review" })).job;
    await fixture.jobQueue.update(review.jobId, {
      status: "succeeded",
      cleanupState: "preserved",
      blockedReason: "review_required",
      worktreePath: join(workspaceRoot, "review-worktree"),
      observedArtifacts: [{ path: "cleanup:preserved", status: "observed" }],
    });
    await fixture.stateManager.updateIntegrationSnapshot(fixture.loop.loopId, {
      errors: [{ integrationId: "github", reason: "integration_rate_limited", message: "rate limited", occurredAt: START }],
      updatedAt: START,
    });
    await fixture.collisionLedger.acquire({
      target: { type: "branch", owner: "test-owner", repo: "test-repo", branch: "main" },
      loopId: fixture.loop.loopId,
      runId: "lease-run",
      priority: 0,
      createdAt: START,
      expiresAt: START + 60_000,
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);
    const state = await fixture.stateManager.read(fixture.loop.loopId);
    const codes = result.blockers.map((blocker) => blocker.code);

    expect(result.decision).toBe("no_action");
    expect(state.status).toBe("active");
    expect(codes).toContain("open_job");
    expect(codes).toContain("pending_hitl");
    expect(codes).toContain("unreviewed_changed_worktree");
    expect(codes).toContain("integration_error");
    expect(codes).toContain("active_collision_lease");
  });

  test("marks expired unreviewed changes without deleting artifacts", async () => {
    const repo = await createGitRepo("expired-changes");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({ loopSlug: "cleanup", subjectSlug: "expired", jobId: "expired-job-123456", baseSha });
    await writeFile(join(created.worktreePath, "expired.txt"), "must review\n");
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "expired",
      reportStatus: "skipped",
      subjectKey: "manual:expired",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.worktrees).toContainEqual(expect.objectContaining({ jobId: job.jobId, cleanupState: "expired_needs_review", removed: false }));
    expect(await pathExists(created.worktreePath)).toBe(true);
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ cleanupState: "expired_needs_review", blockedReason: "expired_needs_review" });
  });

  test("records cleanup_failed when worktree cleanup throws without deleting canonical state", async () => {
    const workspaceRoot = await createWorkspace("cleanup-failure");
    const worktreePath = join(workspaceRoot, "failing-worktree");
    await mkdir(worktreePath, { recursive: true });
    const failingWorktreeManager = new ThrowingCleanupWorktreeManager(worktreePath);
    const fixture = await createFixture(workspaceRoot, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager: failingWorktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:failing-cleanup",
      worktreePath,
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
      observedArtifacts: [{ path: "git:branch:archcode/loop/cleanup/failing", status: "observed" }],
    });

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.decision).toBe("cleanup_failed");
    expect(await pathExists(worktreePath)).toBe(true);
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({ cleanupState: "cleanup_failed" });
    const state = await fixture.stateManager.read(fixture.loop.loopId);
    expect(state.cleanupState).toBe("cleanup_failed");
    expect(state.loopId).toBe(fixture.loop.loopId);
    expect(await fixture.stateManager.readRunLog(fixture.loop.loopId)).toHaveLength(1);
  });

  test("does not overwrite a newer terminal-job revision when cleanup fails", async () => {
    const workspaceRoot = await createWorkspace("cleanup-stale-revision");
    const worktreePath = join(workspaceRoot, "stale-revision-worktree");
    await mkdir(worktreePath, { recursive: true });
    let mutateBeforeFailure: () => Promise<void> = async () => {};
    const worktreeManager: LoopCleanupWorktreeManager = {
      inspect: async (input) => {
        await mutateBeforeFailure();
        throw new Error(`inspection failed for ${input.worktreePath}`);
      },
      cleanup: async () => {
        throw new Error("cleanup must not run after inspection failure");
      },
    };
    const fixture = await createFixture(workspaceRoot, {
      cleanupPolicy: { enabled: true, action: "mark", deleteUnchangedWorktrees: true, noFindingRuns: 10 },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:stale-cleanup-revision",
      worktreePath,
      baseSha: "a".repeat(40),
      resolvedHeadSha: "a".repeat(40),
      observedArtifacts: [{ path: "git:branch:archcode/loop/cleanup/stale-revision", status: "observed" }],
    });
    mutateBeforeFailure = async () => {
      await fixture.jobQueue.update(job.jobId, {
        cleanupState: "preserved",
        blockedReason: "review_required",
      });
    };

    const result = await fixture.service.scanLoop(fixture.loop.loopId);

    expect(result.decision).toBe("no_action");
    expect(result.worktrees).toContainEqual(expect.objectContaining({
      jobId: job.jobId,
      cleanupState: "preserved",
      removed: false,
      reviewRequired: true,
      reason: expect.stringContaining("changed during cleanup"),
    }));
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({
      cleanupState: "preserved",
      blockedReason: "review_required",
    });
    expect((await fixture.stateManager.read(fixture.loop.loopId)).cleanupState).not.toBe("cleanup_failed");
  });

  test("cleanupJob reconciles an already-missing worktree without rerunning execution", async () => {
    const repo = await createGitRepo("cleanup-saga-missing-path");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({
      loopSlug: "cleanup",
      subjectSlug: "missing",
      jobId: "missing-path-job-123456",
      baseSha,
    });
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: true, deleteUnchangedWorktrees: true },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:missing-path",
      worktreePath: created.worktreePath,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
      observedArtifacts: [{ path: `git:branch:${created.branchName}`, status: "observed" }],
    });
    const intent = await fixture.jobQueue.update(job.jobId, { cleanupState: "in_progress" });
    await rm(created.worktreePath, { recursive: true, force: true });

    const result = await fixture.service.cleanupJob(intent.jobId);

    expect(result).toMatchObject({ cleanupState: "cleaned", removed: true, cleanupWarning: expect.stringContaining("orphan branch") });
    expect(await fixture.jobQueue.read(intent.jobId)).toMatchObject({
      status: "succeeded",
      cleanupState: "cleaned",
      cleanupWarning: expect.stringContaining(created.branchName),
    });
    expect(await git(repo, ["rev-parse", `refs/heads/${created.branchName}`])).toBe(baseSha);
  });

  test("cleanupJob honors the enabled=false master switch even when deletion is configured", async () => {
    const repo = await createGitRepo("cleanup-saga-disabled");
    const worktreeManager = new LoopWorktreeManager({ canonicalRoot: repo });
    const baseSha = await git(repo, ["rev-parse", "HEAD"]);
    const created = await worktreeManager.create({
      loopSlug: "cleanup",
      subjectSlug: "disabled",
      jobId: "disabled-job-123456",
      baseSha,
    });
    const fixture = await createFixture(repo, {
      cleanupPolicy: { enabled: false, deleteUnchangedWorktrees: true },
      worktreeManager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:disabled",
      worktreePath: created.worktreePath,
      worktreeBranchName: created.branchName,
      baseSha,
      resolvedHeadSha: created.resolvedHeadSha,
    });
    await fixture.jobQueue.update(job.jobId, { cleanupState: "in_progress" });

    const result = await fixture.service.cleanupJob(job.jobId);

    expect(result).toMatchObject({ cleanupState: "preserved", removed: false });
    expect(await pathExists(created.worktreePath)).toBe(true);
  });

  test("cleanupJob records a detached worktree as cleaned when orphan branch deletion warns", async () => {
    const workspace = await createWorkspace("cleanup-saga-branch-warning");
    const worktreePath = join(workspace, "managed-worktree");
    await mkdir(worktreePath, { recursive: true });
    const branchName = "archcode/loop/cleanup/warning";
    const baseSha = "d".repeat(40);
    const manager: LoopCleanupWorktreeManager = {
      inspect: async () => ({
        worktreePath,
        branchName,
        baseSha,
        headSha: baseSha,
        status: { dirty: false, entries: [] },
        untrackedFiles: [],
        localCommitsAhead: 0,
        changedRefs: [],
        diffStats: { committed: "", workingTree: "" },
        evidenceArtifacts: [],
        hasChanges: false,
      }),
      cleanup: async (input) => {
        await input.beforeRemove?.();
        await input.onRemoveDetached?.();
        return {
          cleanupState: "cleaned",
          removed: true,
          reviewRequired: false,
          reason: "branch delete failed",
          worktreePath,
          branchDeleted: false,
          warning: {
            code: "BRANCH_DELETE_FAILED",
            branchName,
            message: "expected ref changed",
          },
        };
      },
    };
    const fixture = await createFixture(workspace, {
      cleanupPolicy: { enabled: true, deleteUnchangedWorktrees: true },
      worktreeManager: manager,
    });
    const { job } = await appendJobAndReport(fixture, {
      status: "succeeded",
      reportStatus: "succeeded",
      subjectKey: "manual:branch-warning",
      worktreePath,
      baseSha,
      resolvedHeadSha: baseSha,
      observedArtifacts: [{ path: `git:branch:${branchName}`, status: "observed" }],
    });
    await fixture.jobQueue.update(job.jobId, { cleanupState: "in_progress" });

    const result = await fixture.service.cleanupJob(job.jobId);

    expect(result).toMatchObject({ cleanupState: "cleaned", removed: true, cleanupWarning: "expected ref changed" });
    expect(await fixture.jobQueue.read(job.jobId)).toMatchObject({
      cleanupState: "cleaned",
      cleanupWarning: "expected ref changed",
      observedArtifacts: expect.arrayContaining([
        { path: `cleanup:orphan-branch:${branchName}`, status: "observed" },
      ]),
    });
  });
});

interface Fixture {
  readonly stateManager: LoopStateManager;
  readonly jobQueue: LoopJobQueue;
  readonly collisionLedger: CollisionLedger;
  readonly service: LoopCleanupService;
  readonly loop: LoopState;
}

async function createFixture(workspaceRoot: string, options: {
  readonly cleanupPolicy?: Record<string, unknown>;
  readonly worktreeManager?: LoopCleanupWorktreeManager;
  readonly migrateSessionCwdReferencesForRemoval?: LoopCleanupServiceOptions["migrateSessionCwdReferencesForRemoval"] | null;
} = {}): Promise<Fixture> {
  const stateManager = new LoopStateManager(workspaceRoot);
  const jobQueue = new LoopJobQueue({ workspaceRoot, clock: { now: () => START } });
  const collisionLedger = new CollisionLedger({ stateManager, workspaceRoot, clock: { now: () => START } });
  const service = new LoopCleanupService({
    stateManager,
    jobQueue,
    collisionLedger,
    workspaceRoot,
    clock: { now: () => START },
    ...(options.worktreeManager === undefined ? {} : { worktreeManager: options.worktreeManager }),
    ...(options.migrateSessionCwdReferencesForRemoval === null
      ? {}
      : {
        migrateSessionCwdReferencesForRemoval: options.migrateSessionCwdReferencesForRemoval
          ?? runWithoutSessionCwdReferences,
      }),
  });
  const config = { ...baseConfig, ...(options.cleanupPolicy === undefined ? {} : { cleanupPolicy: options.cleanupPolicy }) };
  const loop = await stateManager.create("project-a", config as LoopConfig);
  return { stateManager, jobQueue, collisionLedger, service, loop };
}

const runWithoutSessionCwdReferences: NonNullable<LoopCleanupServiceOptions["migrateSessionCwdReferencesForRemoval"]> = async (
  _input,
  operation,
) => await operation({
  beforeRemove: async () => undefined,
  onRemoveFailureBeforeDetach: async () => undefined,
  onRemoveDetached: async () => undefined,
});

async function appendJobAndReport(fixture: Fixture, input: {
  readonly status: LoopJobRecord["status"];
  readonly reportStatus: LoopRunReportStatus;
  readonly subjectKey: string;
  readonly sessionId?: string;
  readonly blockedReason?: string;
  readonly worktreePath?: string;
  readonly worktreeBranchName?: string;
  readonly baseSha?: string;
  readonly resolvedHeadSha?: string;
  readonly observedArtifacts?: LoopWorktreeArtifact[];
}): Promise<{ readonly job: LoopJobRecord; readonly report: LoopRunReport }> {
  const enqueued = await fixture.jobQueue.enqueue({
    loopId: fixture.loop.loopId,
    triggerKind: "manual",
    subjectKey: input.subjectKey,
    worktreePath: input.worktreePath,
    worktreeBranchName: input.worktreeBranchName,
    baseSha: input.baseSha,
    resolvedHeadSha: input.resolvedHeadSha,
  });
  const job = await fixture.jobQueue.update(enqueued.job.jobId, {
    status: input.status,
    startedAt: START,
    endedAt: START + 100,
    blockedReason: input.blockedReason,
    worktreePath: input.worktreePath,
    worktreeBranchName: input.worktreeBranchName,
    baseSha: input.baseSha,
    resolvedHeadSha: input.resolvedHeadSha,
    observedArtifacts: input.observedArtifacts,
  });
  const report: LoopRunReport = {
    runId: `run-${job.jobId}`,
    loopId: fixture.loop.loopId,
    status: input.reportStatus,
    trigger: "manual",
    startedAt: START,
    endedAt: START + 100,
    sessionId: input.sessionId,
    jobId: job.jobId,
    triggerKind: job.triggerKind,
    subjectKey: job.subjectKey,
    dedupeKey: job.dedupeKey,
    blockedReason: input.blockedReason,
    worktreePath: input.worktreePath,
    worktreeBranchName: input.worktreeBranchName,
    baseSha: input.baseSha,
    resolvedHeadSha: input.resolvedHeadSha,
    observedArtifacts: input.observedArtifacts,
  };
  await fixture.stateManager.appendRunReport(fixture.loop.loopId, report);
  return { job, report };
}

class CountingWorktreeManager implements LoopCleanupWorktreeManager {
  readonly inspectMock = mock(async (_input: Parameters<LoopCleanupWorktreeManager["inspect"]>[0]): ReturnType<LoopCleanupWorktreeManager["inspect"]> => {
    throw new Error("unexpected inspect");
  });
  readonly cleanupMock = mock(async (_input: Parameters<LoopCleanupWorktreeManager["cleanup"]>[0]): ReturnType<LoopCleanupWorktreeManager["cleanup"]> => {
    throw new Error("unexpected cleanup");
  });
  async inspect(input: Parameters<LoopCleanupWorktreeManager["inspect"]>[0]): ReturnType<LoopCleanupWorktreeManager["inspect"]> {
    return await this.inspectMock(input);
  }
  async cleanup(input: Parameters<LoopCleanupWorktreeManager["cleanup"]>[0]): ReturnType<LoopCleanupWorktreeManager["cleanup"]> {
    return await this.cleanupMock(input);
  }
}

class ThrowingCleanupWorktreeManager implements LoopCleanupWorktreeManager {
  constructor(private readonly worktreePath: string) {}

  async inspect(input: Parameters<LoopCleanupWorktreeManager["inspect"]>[0]): Promise<LoopWorktreeInspection> {
    return {
      worktreePath: this.worktreePath,
      branchName: input.branchName,
      baseSha: input.baseSha,
      headSha: input.baseSha,
      status: { dirty: false, entries: [] },
      untrackedFiles: [],
      localCommitsAhead: 0,
      changedRefs: [],
      diffStats: { committed: "", workingTree: "" },
      evidenceArtifacts: [],
      hasChanges: false,
    };
  }

  async cleanup(_input: Parameters<LoopCleanupWorktreeManager["cleanup"]>[0]): ReturnType<LoopCleanupWorktreeManager["cleanup"]> {
    throw new Error("simulated cleanup failure");
  }
}

async function createWorkspace(name: string): Promise<string> {
  const workspace = join(TMP_DIR, name);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

async function createGitRepo(name: string): Promise<string> {
  const repo = await createWorkspace(name);
  await git(repo, ["init", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "loop-cleanup@example.com"]);
  await git(repo, ["config", "user.name", "Loop Cleanup"]);
  await writeFile(join(repo, "README.md"), `# ${name}\n`);
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...Bun.env, GIT_TERMINAL_PROMPT: "0" } });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
