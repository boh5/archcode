import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  CollisionLeaseSchema,
  CollisionTargetSchema,
  LoopBudgetConfigSchema,
  LoopConfigSchema,
  LoopCoordinatorConfigSchema,
  LoopInvalidIdError,
  LoopPathError,
  LoopRunLogError,
  LoopRunReportSchema,
  LoopScheduleSpecSchema,
  LoopStateManager,
  LoopStateSchema,
  type LoopConfig,
  type LoopRunReport,
} from "./state";

const TMP_DIR = join(import.meta.dir, "__test_tmp__", "loop-state");
const VALID_LOOP_ID = "550e8400-e29b-41d4-a716-446655440000";

const manualConfig: LoopConfig = {
  templateId: "watch_report",
  title: null,
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 8 },
  taskPrompt: "Summarize open tasks",
};

const intervalConfig: LoopConfig = {
  ...manualConfig,
  schedule: { kind: "interval", everyMs: 60_000 },
};

async function captureAsyncError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected async action to throw");
}

function report(loopId: string, runId: string, startedAt: number, status: LoopRunReport["status"] = "succeeded"): LoopRunReport {
  return {
    runId,
    loopId,
    status,
    trigger: "manual",
    startedAt,
    endedAt: startedAt + 100,
    summary: `${runId} summary`,
  };
}

beforeEach(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
  await mkdir(TMP_DIR, { recursive: true });
});

afterAll(async () => {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
});

describe("Loop schemas", () => {
  test("accept strict loop state and reject unsupported config keys", () => {
    const now = Date.now();
    const state = LoopStateSchema.parse({
      loopId: VALID_LOOP_ID,
      projectId: "project-a",
      config: manualConfig,
      status: "active",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      stateVersion: 1,
    });

    expect("readinessScore" in state).toBe(false);
    expect(() => LoopStateSchema.parse({ ...state, extra: true })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, goalTemplateId: "goal-1" })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, tools: ["github_get_pull_request"] })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, allowedTools: ["github_get_pull_request"] })).toThrow();
  });

  test("accepts 5-field cron schedules and rejects seconds-field cron expressions", () => {
    expect(LoopScheduleSpecSchema.parse({ kind: "cron", expression: "*/15 * * * *" })).toEqual({
      kind: "cron",
      expression: "*/15 * * * *",
    });
    expect(() => LoopScheduleSpecSchema.parse({ kind: "cron", expression: "*/15 * * * * *" })).toThrow();
  });

  test("accepts event triggers with default cadence and rejects too-fast polling", () => {
    const parsed = LoopConfigSchema.parse({
      ...manualConfig,
      schedule: { kind: "manual" },
      triggers: [{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }],
    });
    const defaultCadence = LoopConfigSchema.parse({
      ...manualConfig,
      triggers: [{ kind: "on_commit", branch: "main" }],
    });

    expect(parsed.triggers).toEqual([{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }]);
    expect(defaultCadence.triggers).toEqual([{ kind: "on_commit", branch: "main", cadenceMs: 60_000 }]);
    expect(() => LoopConfigSchema.parse({ ...manualConfig, triggers: [{ kind: "on_pr", cadenceMs: 29_000 }] })).toThrow();
  });

  test("defaults coordinator max concurrency to two", () => {
    expect(LoopCoordinatorConfigSchema.parse({})).toEqual({ maxConcurrent: 2 });
    expect(LoopCoordinatorConfigSchema.parse({ maxConcurrent: 4 })).toEqual({ maxConcurrent: 4 });
  });

  test("normalizes legacy loop limits to budget threshold defaults", () => {
    const parsedBudget = LoopBudgetConfigSchema.parse({ maxIterationsPerRun: 8 });
    const parsedConfig = LoopConfigSchema.parse(manualConfig);

    expect(parsedBudget).toEqual({
      maxIterationsPerRun: 8,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    });
    expect(parsedConfig.limits).toEqual(parsedBudget);
  });

  test("parses template-oriented loop state with minimal limits and no readiness score", () => {
    const now = Date.now();
    const state = LoopStateSchema.parse({
      loopId: VALID_LOOP_ID,
      projectId: "project-a",
      config: manualConfig,
      status: "active",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      stateVersion: 1,
    });

    expect(state.config.limits).toEqual({
      maxIterationsPerRun: 8,
      softThresholdRatio: 0.8,
      hardThresholdRatio: 1.0,
    });
    expect("readinessScore" in state).toBe(false);
  });

  test("rejects maturity fields and non-null readiness score", () => {
    const now = Date.now();
    const state = {
      loopId: VALID_LOOP_ID,
      projectId: "project-a",
      config: manualConfig,
      status: "active",
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      stateVersion: 1,
    };

    expect(() => LoopConfigSchema.parse({ ...manualConfig, graduation: { level: "L2" } })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, noiseRate: 0.1 })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, customPatternPath: ".archcode/loops/pattern.ts" })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, readinessSignals: ["tests"] })).toThrow();
    expect(() => LoopConfigSchema.parse({ ...manualConfig, autoApprove: true })).toThrow();
    expect(() => LoopStateSchema.parse({ ...state, readinessScore: 0.9 })).toThrow();
    expect(() => LoopStateSchema.parse({ ...state, readinessScore: 80 })).toThrow();
    expect(() => LoopStateSchema.parse({ ...state, noiseRate: 0.1 })).toThrow();
  });

  test("accepts guardrail budget, collision, integration, and run reason fields", () => {
    const budget = LoopBudgetConfigSchema.parse({
      maxIterationsPerRun: 8,
      maxTokensPerRun: 100_000,
      maxEstimatedUsdPerRun: 2,
      maxWallClockMsPerRun: 900_000,
      maxRunsPerDay: 4,
      softThresholdRatio: 0.75,
      hardThresholdRatio: 1,
    });
    const collisionTarget = CollisionTargetSchema.parse({ type: "pr", owner: "arch", repo: "code", number: 42 });
    const lease = CollisionLeaseSchema.parse({
      targetKey: "pr:arch/code#42",
      target: collisionTarget,
      loopId: VALID_LOOP_ID,
      runId: "run-1",
      actionId: "action-1",
      toolCallId: "tool-1",
      priority: 10,
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    const report = LoopRunReportSchema.parse({
      runId: "run-1",
      loopId: VALID_LOOP_ID,
      status: "needs_user",
      trigger: "manual",
      startedAt: 1_000,
      endedAt: 2_000,
      reason: "hard_budget_exceeded",
      blockedByHitlIds: ["hitl-1"],
      attentionStatus: "waiting_for_human",
      budgetUsage: {
        iterations: 8,
        inputTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
        cachedInputTokens: 2,
        totalTokens: 35,
        estimatedUsd: 0.02,
        wallClockMs: 1_000,
        runsToday: 1,
        resetDateUtc: "2026-07-05",
        pricingUnavailable: false,
      },
      collisionTargets: [collisionTarget],
      collisionConflicts: [{
        targetKey: lease.targetKey,
        target: collisionTarget,
        conflictingLease: lease,
        detectedAt: 1_500,
      }],
      integrationErrors: [{
        integrationId: "github",
        reason: "integration_rate_limited",
        message: "GitHub rate limit reached",
        retryAfterMs: 60_000,
        occurredAt: 1_500,
      }],
    });
    const state = LoopStateSchema.parse({
      loopId: VALID_LOOP_ID,
      projectId: "project-a",
      config: { ...manualConfig, budget, collisionTargets: [collisionTarget] },
      status: "active",
      createdAt: 1_000,
      updatedAt: 2_000,
      lastRun: report,
      runCount: 1,
      stateVersion: 1,
      latestBudget: { budget, usage: report.budgetUsage!, updatedAt: 2_000 },
      latestCollisions: { targets: [collisionTarget], activeLeases: [lease], conflicts: report.collisionConflicts!, updatedAt: 2_000 },
      latestIntegrations: { errors: report.integrationErrors!, updatedAt: 2_000 },
    });

    expect(report.status).toBe("needs_user");
    expect(report.reason).toBe("hard_budget_exceeded");
    expect(report.blockedByHitlIds).toEqual(["hitl-1"]);
    expect(report.attentionStatus).toBe("waiting_for_human");
    expect(state.latestCollisions?.activeLeases[0]?.targetKey).toBe("pr:arch/code#42");
  });

  test("accepts queue/worktree automation fields and cleanup metadata", () => {
    const report = LoopRunReportSchema.parse({
      runId: "run-1",
      loopId: VALID_LOOP_ID,
      status: "skipped",
      trigger: "on_pr",
      triggerKind: "on_pr",
      startedAt: 1_000,
      jobId: "job-1",
      subjectKey: "pr:arch/code#42",
      dedupeKey: "loop:on_pr:pr:arch/code#42",
      branchKey: "arch/code:feature",
      worktreePath: "/tmp/worktree",
      baseSha: "base-sha",
      resolvedHeadSha: "head-sha",
      missedCount: 1,
      blockedReason: "canonical checkout is dirty",
      cleanupState: "preserved",
      observedArtifacts: [{ path: "report.md", status: "modified", sizeBytes: 100, sha: "abc123" }],
    });
    const state = LoopStateSchema.parse({
      loopId: VALID_LOOP_ID,
      projectId: "project-a",
      config: {
        ...manualConfig,
        schedule: { kind: "cron", expression: "*/15 * * * *" },
        triggers: [{ kind: "on_ci_fail", cadenceMs: 60_000, baseBranch: "main", workflowName: "ci" }],
        cleanupPolicy: { deleteUnchangedWorktrees: true, preserveChangedArtifacts: true },
      },
      status: "active",
      createdAt: 1_000,
      updatedAt: 2_000,
      lastRun: report,
      triggerHealth: [{ triggerKind: "on_ci_fail", status: "healthy", cadenceMs: 60_000, lastCheckedAt: 1_500 }],
      cleanupState: "preserved",
      runCount: 1,
      stateVersion: 1,
    });

    expect(report.trigger).toBe("on_pr");
    expect(report.observedArtifacts?.[0]?.path).toBe("report.md");
    expect(state.config.triggers?.[0]?.kind).toBe("on_ci_fail");
    expect(state.triggerHealth?.[0]?.status).toBe("healthy");
  });
});

describe("LoopStateManager", () => {
  test("creates loop state files and generated markdown", async () => {
    const manager = new LoopStateManager(TMP_DIR);

    const created = await manager.create("project-a", manualConfig);

    const loopDir = join(TMP_DIR, ".archcode", "loops", created.loopId);
    expect(created).toMatchObject({
      projectId: "project-a",
      config: { title: null, schedule: { kind: "manual" } },
      status: "active",
      runCount: 0,
      stateVersion: 1,
    });
    expect(created.loopId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(created.nextRunAt).toBeUndefined();
    expect("readinessScore" in created).toBe(false);
    expect(existsSync(join(loopDir, "state.json"))).toBe(true);
    expect(existsSync(join(loopDir, "state.md"))).toBe(true);
    expect(await manager.read(created.loopId)).toEqual(created);

    const markdown = await Bun.file(join(loopDir, "state.md")).text();
    expect(markdown).toContain("state.json is the source of truth");
    expect(markdown).toContain(`# Loop ${created.loopId}`);
  });

  test("create discards incoming title and setTitleIfEmpty writes generated metadata once", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", { ...manualConfig, title: "Old manual title" });

    const titled = await manager.setTitleIfEmpty(created.loopId, "Generated loop title");
    const skipped = await manager.setTitleIfEmpty(created.loopId, "Second loop title");

    expect(created.config.title).toBeNull();
    expect(titled?.config.title).toBe("Generated loop title");
    expect(skipped).toBeUndefined();
    expect((await manager.read(created.loopId)).config.title).toBe("Generated loop title");
  });

  test("list filters by project and sorts by loop id", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const a1 = await manager.create("project-a", manualConfig);
    const b1 = await manager.create("project-b", manualConfig);
    const a2 = await manager.create("project-a", manualConfig);

    expect(new Set((await manager.list("project-a")).map((loop) => loop.loopId))).toEqual(new Set([a1.loopId, a2.loopId]));
    expect((await manager.list()).map((loop) => loop.loopId)).toEqual([a1.loopId, b1.loopId, a2.loopId].sort());
  });

  test("update persists editable config and status fields", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);

    const updated = await manager.update(created.loopId, {
      config: { ...manualConfig, title: "Updated", limits: { maxIterationsPerRun: 3 } },
      status: "disabled",
      generatedStateSummary: "Disabled for maintenance.",
    });

    expect(updated.config.title).toBe("Updated");
    expect(updated.status).toBe("disabled");
    expect(updated.stateVersion).toBe(created.stateVersion + 1);
    expect((await manager.read(created.loopId)).generatedStateSummary).toBe("Disabled for maintenance.");
  });

  test("update preserves generated title when stale config update carries null title", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    const staleConfig = created.config;

    await manager.setTitleIfEmpty(created.loopId, "Generated loop title");
    const updated = await manager.update(created.loopId, {
      config: { ...staleConfig, taskPrompt: "Updated run instructions" },
    });

    expect(updated.config.title).toBe("Generated loop title");
    expect(updated.config.taskPrompt).toBe("Updated run instructions");
    expect((await manager.read(created.loopId)).config.title).toBe("Generated loop title");
  });

  test("appendRunReport appends JSONL and readRunLog returns newest reports deterministically", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    const first = report(created.loopId, "run-1", 1_000);
    const second = report(created.loopId, "run-2", 2_000);
    const third = report(created.loopId, "run-3", 3_000);

    await manager.appendRunReport(created.loopId, first);
    await manager.appendRunReport(created.loopId, second);
    await manager.appendRunReport(created.loopId, third);

    const runLogPath = join(TMP_DIR, ".archcode", "loops", created.loopId, "run-log.jsonl");
    const rawLines = (await Bun.file(runLogPath).text()).trim().split("\n");
    expect(rawLines.map((line) => JSON.parse(line).runId)).toEqual(["run-1", "run-2", "run-3"]);
    expect((await manager.readRunLog(created.loopId)).map((entry) => entry.runId)).toEqual(["run-3", "run-2", "run-1"]);
    expect((await manager.readRunLog(created.loopId, 2)).map((entry) => entry.runId)).toEqual(["run-3", "run-2"]);
  });

  test("recordRunStart and recordRunFinish update state and append final report", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const running: LoopRunReport = {
      runId: "run-active",
      loopId: created.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 10_000,
    };

    const started = await manager.recordRunStart(created.loopId, running);
    expect(started.currentRun).toEqual(running);

    const finished = await manager.recordRunFinish(created.loopId, {
      ...running,
      status: "succeeded",
      endedAt: 20_000,
      summary: "done",
    });

    expect(finished.currentRun).toBeUndefined();
    expect(finished.lastRun?.runId).toBe("run-active");
    expect(finished.runCount).toBe(1);
    expect(finished.nextRunAt).toBe(80_000);
    expect((await manager.readRunLog(created.loopId, 1))[0]?.status).toBe("succeeded");
  });

  test("recordRunCleanupCompletion advances the cleanup saga without double-counting the run", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const running: LoopRunReport = {
      runId: "run-cleanup-saga",
      loopId: created.loopId,
      jobId: "job-cleanup-saga",
      status: "running",
      trigger: "interval",
      startedAt: 10_000,
      cleanupState: "in_progress",
    };
    await manager.recordRunStart(created.loopId, running);
    await manager.recordRunFinish(created.loopId, {
      ...running,
      status: "succeeded",
      endedAt: 20_000,
      summary: "execution complete; cleanup pending",
      observedArtifacts: [{ path: "cleanup:in_progress", status: "observed" }],
    });

    const completed = await manager.recordRunCleanupCompletion(created.loopId, running.runId, {
      cleanupState: "cleaned",
      cleanupWarning: "orphan branch retained",
      observedArtifacts: [{ path: "cleanup:orphan-branch:archcode/loop/test", status: "observed" }],
    });

    expect(completed).toMatchObject({
      runId: running.runId,
      cleanupState: "cleaned",
      cleanupWarning: "orphan branch retained",
    });
    const state = await manager.read(created.loopId);
    expect(state.runCount).toBe(1);
    expect(state.currentRun).toBeUndefined();
    expect(state.lastRun).toEqual(completed);
    const runLog = await manager.readRunLog(created.loopId);
    expect(runLog.map((entry) => entry.cleanupState)).toEqual(["cleaned"]);
    const rawLog = await Bun.file(join(TMP_DIR, ".archcode", "loops", created.loopId, "run-log.jsonl")).text();
    expect(rawLog.trim().split("\n")).toHaveLength(2);
  });

  test("recordRunCleanupCompletion repairs a historical run without overwriting newer Loop state", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const first: LoopRunReport = {
      runId: "run-cleanup-historical",
      loopId: created.loopId,
      jobId: "job-cleanup-historical",
      status: "succeeded",
      trigger: "interval",
      startedAt: 10_000,
      endedAt: 11_000,
      cleanupState: "in_progress",
    };
    const second: LoopRunReport = {
      runId: "run-newer",
      loopId: created.loopId,
      jobId: "job-newer",
      status: "failed",
      trigger: "interval",
      startedAt: 20_000,
      endedAt: 21_000,
      cleanupState: "cleanup_failed",
    };
    await manager.recordRunFinish(created.loopId, first);
    await manager.recordRunFinish(created.loopId, second);
    await manager.update(created.loopId, { cleanupState: "cleanup_failed" });

    const completed = await manager.recordRunCleanupCompletion(created.loopId, first.runId, {
      cleanupState: "cleaned",
      cleanupWarning: undefined,
      observedArtifacts: [{ path: "cleanup:cleaned", status: "observed" }],
    });

    expect(completed).toMatchObject({ runId: first.runId, cleanupState: "cleaned" });
    const state = await manager.read(created.loopId);
    expect(state.runCount).toBe(2);
    expect(state.lastRun).toEqual(second);
    expect(state.cleanupState).toBe("cleanup_failed");
    expect((await manager.readRunLog(created.loopId))[0]).toEqual(completed);
  });

  test("recoverRunProjection counts a run that advances from needs_user to terminal", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const blocked: LoopRunReport = {
      runId: "run-recovered-after-hitl",
      loopId: created.loopId,
      jobId: "job-recovered-after-hitl",
      status: "needs_user",
      trigger: "interval",
      startedAt: 10_000,
      endedAt: 11_000,
      blockedReason: "needs_user",
      blockedByHitlIds: ["hitl-recovered-after-hitl"],
      attentionStatus: "waiting_for_human",
    };
    await manager.recordRunBlocked(created.loopId, blocked);

    const recovered = await manager.recoverRunProjection(created.loopId, {
      ...blocked,
      status: "succeeded",
      endedAt: 12_000,
      blockedReason: undefined,
      blockedByHitlIds: undefined,
      attentionStatus: "clear",
    });

    expect(recovered.currentRun).toBeUndefined();
    expect(recovered.lastRun?.status).toBe("succeeded");
    expect(recovered.runCount).toBe(1);
    expect(recovered.blockedByHitlIds).toBeUndefined();
    expect(recovered.attentionStatus).toBe("clear");
  });

  test("pause preserves currentRun and resume computes interval nextRunAt from injected now", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", intervalConfig);
    const running: LoopRunReport = {
      runId: "run-current",
      loopId: created.loopId,
      status: "running",
      trigger: "interval",
      startedAt: 50_000,
    };
    await manager.recordRunStart(created.loopId, running);

    const paused = await manager.pause(created.loopId);
    expect(paused.status).toBe("paused");
    expect(paused.currentRun).toEqual(running);
    expect(paused.nextRunAt).toBeUndefined();

    const resumed = await manager.resume(created.loopId, 100_000);
    expect(resumed.status).toBe("active");
    expect(resumed.currentRun).toEqual(running);
    expect(resumed.nextRunAt).toBe(160_000);
  });

  test("resume leaves manual loop nextRunAt absent", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    await manager.pause(created.loopId);

    const resumed = await manager.resume(created.loopId, 100_000);

    expect(resumed.nextRunAt).toBeUndefined();
  });

  test("loopHitlPath resolves owner-local hitl.json", async () => {
    const manager = new LoopStateManager(TMP_DIR);

    expect(await manager.loopHitlPath(VALID_LOOP_ID)).toBe(
      join(TMP_DIR, ".archcode", "loops", VALID_LOOP_ID, "hitl.json"),
    );
  });

  test("rejects path traversal loop ids and contained path escapes", async () => {
    const manager = new LoopStateManager(TMP_DIR);

    expect(await captureAsyncError(() => manager.read("../escape"))).toBeInstanceOf(LoopInvalidIdError);
    expect(await captureAsyncError(() => manager.loopHitlPath("../escape"))).toBeInstanceOf(LoopInvalidIdError);
    expect(await captureAsyncError(() => manager.appendRunReport("../escape", report(VALID_LOOP_ID, "run", 1)))).toBeInstanceOf(LoopInvalidIdError);
    expect(await captureAsyncError(() => manager.resolveContainedPathForTest("../escape/state.json"))).toBeInstanceOf(LoopPathError);
    expect(existsSync(join(TMP_DIR, "escape"))).toBe(false);
  });

  test("rejects run reports for a different loop", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);

    expect(await captureAsyncError(() => manager.appendRunReport(created.loopId, report(VALID_LOOP_ID, "run", 1)))).toBeInstanceOf(LoopRunLogError);
  });

  test("atomic state writes produce valid JSON and no temp files", async () => {
    const manager = new LoopStateManager(TMP_DIR);
    const created = await manager.create("project-a", manualConfig);
    await manager.update(created.loopId, { status: "paused" });

    const loopDir = join(TMP_DIR, ".archcode", "loops", created.loopId);
    const content = await Bun.file(join(loopDir, "state.json")).text();
    expect(JSON.parse(content).loopId).toBe(created.loopId);
    expect((await readdir(loopDir)).filter((entry) => entry.startsWith(".tmp-"))).toEqual([]);
  });
});
