import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  LoopActiveConflictError,
  ProjectContextResolver,
  ProjectRegistry,
  silentLogger,
  type AgentRuntime,
  type LoopConfig,
  type LoopRunReport,
} from "@archcode/agent-core";
import type { LoopBudgetSnapshot, LoopCollisionSnapshot, LoopIntegrationSnapshot, LoopJobSummary, LoopState } from "@archcode/protocol";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "loops-routes");

const manualSessionLoopConfig: LoopConfig = {
  title: "Manual session loop",
  description: "Run on demand",
  schedule: { kind: "manual" },
  runKind: "session",
  mode: "report",
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4 },
  taskPrompt: "Summarize local project health.",
};

const normalizedManualSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  limits: { maxIterationsPerRun: 4, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
};

const intervalSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  title: "Interval session loop",
  schedule: { kind: "interval", everyMs: 1_000 },
};

const cronSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  title: "Cron session loop",
  schedule: { kind: "cron", expression: "*/15 * * * *" },
};

const prTriggerSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  title: "PR trigger session loop",
  schedule: { kind: "manual" },
  triggers: [{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }],
};

const goalLoopConfig: LoopConfig = {
  title: "Goal loop",
  schedule: { kind: "manual" },
  runKind: "goal",
  mode: "act",
  approvalPolicy: "explicit_per_run",
  limits: { maxIterationsPerRun: 3 },
  goalTemplate: {
    title: "Loop-created goal",
    author: "architect",
    doneConditions: [{ id: "done-file", kind: "file_exists", params: { path: "done.md" } }],
    retryPolicy: { maxRetries: 1, backoffMs: 25, escalateOnFailure: false },
    approvalPoints: ["after_plan"],
    reviewerAgent: "reviewer",
    prompt: "Execute this inline Goal template only.",
  },
};

describe("loops routes", () => {
  beforeEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    await mkdir(tempRoot, { recursive: true });
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("creates and reads a manual session loop without readiness score", async () => {
    const { app, project, runtime } = await createTestApp("manual-session-loop");

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: manualSessionLoopConfig, author: "tester" }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop).toMatchObject({ projectId: project.slug, status: "active", config: { title: "Manual session loop", schedule: { kind: "manual" } } });
    expect(createBody.loop.nextRunAt).toBeUndefined();
    expect(createBody.loop.readinessScore ?? null).toBeNull();
    expect(runtime.createLoop).toHaveBeenCalledWith(project.workspaceRoot, normalizedManualSessionLoopConfig, "tester");

    const listRes = await app.request(`/api/projects/${project.slug}/loops`);
    const listBody = await listRes.json() as { loops: LoopState[] };
    expect(listRes.status).toBe(200);
    expect(listBody.loops.map((loop) => loop.loopId)).toEqual([createBody.loop.loopId]);

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ loop: createBody.loop });
  });

  test("creates interval session loops and supported presets at create time only", async () => {
    const { app, project } = await createTestApp("interval-and-preset", { now: 10_000 });

    const intervalRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: intervalSessionLoopConfig }),
      headers: { "content-type": "application/json" },
    });
    const intervalBody = await intervalRes.json() as { loop: LoopState };

    expect(intervalRes.status).toBe(201);
    expect(intervalBody.loop.config.schedule).toEqual({ kind: "interval", everyMs: 1_000 });
    expect(intervalBody.loop.nextRunAt).toBeNumber();
    expect(intervalBody.loop.readinessScore ?? null).toBeNull();

    const presetRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ presetId: "daily_triage", author: "preset-user" }),
      headers: { "content-type": "application/json" },
    });
    const presetBody = await presetRes.json() as { loop: LoopState };

    expect(presetRes.status).toBe(201);
    expect(presetBody.loop.config.sourcePreset).toBe("daily_triage");
    expect(presetBody.loop.config.title).toBe("Daily Triage");
    expect(presetBody.loop.readinessScore ?? null).toBeNull();

    const prBabysitterRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ presetId: "pr_babysitter" }),
      headers: { "content-type": "application/json" },
    });
    const prBabysitterBody = await prBabysitterRes.json() as { loop: LoopState };
    expect(prBabysitterRes.status).toBe(201);
    expect(prBabysitterBody.loop.config).toMatchObject({
      sourcePreset: "pr_babysitter",
      runKind: "session",
      toolProfileId: "loop_github_pr_watch",
      title: "PR Babysitter",
    });
    expect(prBabysitterBody.loop.config.description).toContain("PR watch/status/comment");
    expect(prBabysitterBody.loop.config.taskPrompt).toContain("Draft a short issue comment only when a clear status update is useful");
    expect(prBabysitterBody.loop.config.taskPrompt?.toLowerCase()).not.toContain("merge");
    expect(prBabysitterBody.loop.config.taskPrompt?.toLowerCase()).not.toContain("rebase");
    expect(prBabysitterBody.loop.readinessScore ?? null).toBeNull();
  });

  test("creates cron loops and persists UTC cron metadata", async () => {
    const { app, project, runtime } = await createTestApp("cron-loop-create", { now: 10_000 });

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: cronSessionLoopConfig, author: "cron-user" }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop.config.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *" });
    expect(createBody.loop.generatedStateSummary).toContain("cron */15 * * * *");
    expect(JSON.stringify(createBody.loop)).not.toContain("readinessScore");
    expect(runtime.createLoop).toHaveBeenCalledWith(project.workspaceRoot, {
      ...cronSessionLoopConfig,
      limits: { maxIterationsPerRun: 4, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
    }, "cron-user");

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    const readBody = await readRes.json() as { loop: LoopState };
    expect(readRes.status).toBe(200);
    expect(readBody.loop.config.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *" });
  });

  test("creates manual loops with PR triggers and cleanup policy separate from schedule", async () => {
    const { app, project } = await createTestApp("manual-pr-trigger-create");
    const config: LoopConfig = {
      ...prTriggerSessionLoopConfig,
      cleanupPolicy: { deleteUnchangedWorktrees: true, preserveChangedArtifacts: true, maxPreservedWorktrees: 3 },
    };

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop.config.schedule).toEqual({ kind: "manual" });
    expect(createBody.loop.config.triggers).toEqual([{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }]);
    expect(createBody.loop.config.cleanupPolicy).toEqual({ deleteUnchangedWorktrees: true, preserveChangedArtifacts: true, maxPreservedWorktrees: 3 });

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    const readBody = await readRes.json() as { loop: LoopState };
    expect(readRes.status).toBe(200);
    expect(readBody.loop.config.schedule.kind).toBe("manual");
    expect(readBody.loop.config.triggers?.[0]).toMatchObject({ kind: "on_pr", baseBranch: "main", cadenceMs: 60_000 });
  });

  test("rejects invalid cron cadence and unsupported coordinator config with stable messages", async () => {
    const { app, project } = await createTestApp("phase-5-create-rejections");
    const cases: Array<{ name: string; body: unknown; message: string; patch?: boolean }> = [
      {
        name: "invalid cron",
        body: { config: { ...manualSessionLoopConfig, schedule: { kind: "cron", expression: "60 * * * *" } } },
        message: "config.schedule.expression must be a valid 5-field UTC cron expression",
      },
      {
        name: "impossible cron",
        body: { config: { ...manualSessionLoopConfig, schedule: { kind: "cron", expression: "0 0 30 2 *" } } },
        message: "config.schedule.expression must be a valid 5-field UTC cron expression",
      },
      {
        name: "too-fast trigger cadence",
        body: { config: { ...manualSessionLoopConfig, triggers: [{ kind: "on_pr", cadenceMs: 29_000, baseBranch: "main" }] } },
        message: "config.triggers.0.cadenceMs must be at least 30000",
      },
      {
        name: "zero maxConcurrent",
        body: { config: manualSessionLoopConfig, projectConfig: { coordinator: { maxConcurrent: 0 } } },
        message: "projectConfig.coordinator.maxConcurrent must be greater than 0",
      },
      {
        name: "unsupported nonzero maxConcurrent",
        body: { config: manualSessionLoopConfig, projectConfig: { coordinator: { maxConcurrent: 2 } } },
        message: "projectConfig is not currently supported by server loop routes",
      },
      {
        name: "unsupported patch projectConfig",
        body: { projectConfig: { coordinator: { maxConcurrent: 3 } } },
        message: "projectConfig is not currently supported by server loop routes",
        patch: true,
      },
    ];

    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    for (const { body, message, patch } of cases) {
      const res = await app.request(patch ? `/api/projects/${project.slug}/loops/${loop.loopId}` : `/api/projects/${project.slug}/loops`, {
        method: patch ? "PATCH" : "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      const json = await res.json() as { error: { code: string; message: string; details?: { validationMessages?: string[] } } };

      expect(res.status).toBe(400);
      expect(json.error).toMatchObject({ code: "BAD_REQUEST", message: "Request body is invalid" });
      expect(json.error.details?.validationMessages).toContain(message);
    }
  });

  test("creates a goal loop with inline goalTemplate and rejects goalTemplateId", async () => {
    const { app, project } = await createTestApp("goal-loop-inline-template");

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: goalLoopConfig }),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop.config.runKind).toBe("goal");
    expect(createBody.loop.config.goalTemplate).toMatchObject({ title: "Loop-created goal", author: "architect" });
    expect(createBody.loop.readinessScore ?? null).toBeNull();

    const invalidRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ config: { ...goalLoopConfig, goalTemplateId: "existing-goal" } }),
      headers: { "content-type": "application/json" },
    });
    expect(invalidRes.status).toBe(400);
    expect(await invalidRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
  });

  test("rejects active duplicate and out-of-scope loop API fields", async () => {
    const { app, project, runtime } = await createTestApp("rejects-active-duplicate-or-out-of-scope", { holdRunsOpen: true });
    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    const firstTrigger = app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    await runtime.waitForActiveRun();

    const duplicateRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    expect(duplicateRes.status).toBe(409);
    expect(await duplicateRes.json()).toEqual({
      error: {
        code: "LOOP_ACTIVE_CONFLICT",
        message: `Loop ${loop.loopId} already has an active run (run-1); cannot start manual trigger.`,
        details: { loopId: loop.loopId, trigger: "manual", activeRunId: "run-1", sessionId: "session-1" },
      },
    });
    expect(runtime.createLoopRunCount()).toBe(1);

    runtime.releaseActiveRun();
    expect((await (await firstTrigger).json() as { report: LoopRunReport }).report).toMatchObject({ runId: "run-1", sessionId: "session-1", status: "succeeded" });

    for (const config of [
      { ...manualSessionLoopConfig, schedule: { kind: "event", event: "pull_request" } },
      { ...manualSessionLoopConfig, autoApprove: true },
      { ...manualSessionLoopConfig, customPatternPath: ".archcode/loops/patterns.ts" },
    ]) {
      const res = await app.request(`/api/projects/${project.slug}/loops`, {
        method: "POST",
        body: JSON.stringify({ config }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
    }
  });

  test("manual trigger returns deterministic session and goal linkage", async () => {
    const { app, project } = await createTestApp("manual-trigger-linkage");
    const sessionLoop = await createLoop(app, project.slug, manualSessionLoopConfig);
    const goalLoop = await createLoop(app, project.slug, goalLoopConfig);

    const sessionRes = await app.request(`/api/projects/${project.slug}/loops/${sessionLoop.loopId}/trigger`, { method: "POST" });
    const sessionBody = await sessionRes.json() as { report: LoopRunReport };
    expect(sessionRes.status).toBe(200);
    expect(sessionBody.report).toMatchObject({ runId: "run-1", loopId: sessionLoop.loopId, status: "succeeded", trigger: "manual", sessionId: "session-1" });
    expect(sessionBody.report.goalId).toBeUndefined();

    const goalRes = await app.request(`/api/projects/${project.slug}/loops/${goalLoop.loopId}/trigger`, { method: "POST" });
    const goalBody = await goalRes.json() as { report: LoopRunReport };
    expect(goalRes.status).toBe(200);
    expect(goalBody.report).toMatchObject({ runId: "run-2", loopId: goalLoop.loopId, status: "succeeded", trigger: "manual", goalId: "goal-2", sessionId: "goal-session-2" });
  });

  test("pause preserves active run and resume recomputes interval nextRunAt from current runtime time", async () => {
    const { app, project, runtime } = await createTestApp("pause-resume", { now: 50_000, holdRunsOpen: true });
    const loop = await createLoop(app, project.slug, intervalSessionLoopConfig);

    const firstTrigger = app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    await runtime.waitForActiveRun();

    const pauseRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/pause`, { method: "POST" });
    const paused = await pauseRes.json() as { loop: LoopState };
    expect(pauseRes.status).toBe(200);
    expect(paused.loop.status).toBe("paused");
    expect(paused.loop.nextRunAt).toBeUndefined();
    expect(paused.loop.currentRun).toMatchObject({ runId: "run-1", status: "running" });
    expect(runtime.abortSessionExecution).not.toHaveBeenCalled();

    runtime.releaseActiveRun();
    expect((await (await firstTrigger).json() as { report: LoopRunReport }).report.status).toBe("succeeded");

    runtime.setNow(80_000);
    const resumeRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/resume`, { method: "POST" });
    const resumed = await resumeRes.json() as { loop: LoopState };
    expect(resumeRes.status).toBe(200);
    expect(resumed.loop.status).toBe("active");
    expect(resumed.loop.nextRunAt).toBe(81_000);
  });

  test("cancels current run through project-scoped endpoint", async () => {
    const { app, project, runtime } = await createTestApp("cancel-current-run", { holdRunsOpen: true });
    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    const firstTrigger = app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    await runtime.waitForActiveRun();

    const cancelRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs/current/cancel`, { method: "POST" });
    const cancelBody = await cancelRes.json() as { ok: true; loopId: string; runId: string; status: string; reason: string; report: LoopRunReport };

    expect(cancelRes.status).toBe(200);
    expect(cancelBody).toMatchObject({ ok: true, loopId: loop.loopId, runId: "run-1", status: "cancelled", reason: "cancelled_by_user" });
    expect(cancelBody.report).toMatchObject({ runId: "run-1", loopId: loop.loopId, status: "cancelled", reason: "cancelled_by_user" });

    runtime.releaseActiveRun();
    expect((await (await firstTrigger).json() as { report: LoopRunReport }).report.status).toBe("cancelled");
  });

  test("reads and toggles global kill state and blocks manual trigger with structured reason", async () => {
    const { app, project } = await createTestApp("global-kill-routes");
    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    const initialRes = await app.request(`/api/projects/${project.slug}/loops/kill-state`);
    expect(initialRes.status).toBe(200);
    expect(await initialRes.json()).toEqual({ killState: { globalKillActive: false } });

    const activateRes = await app.request(`/api/projects/${project.slug}/loops/kill-all`, {
      method: "POST",
      body: JSON.stringify({ activatedBy: "tester", reason: "maintenance" }),
      headers: { "content-type": "application/json" },
    });
    expect(activateRes.status).toBe(200);
    expect(await activateRes.json()).toEqual({ killState: { globalKillActive: true, activatedAt: 1_000, activatedBy: "tester", reason: "maintenance" } });

    const triggerRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    expect(triggerRes.status).toBe(409);
    expect(await triggerRes.json()).toMatchObject({
      error: {
        code: "LOOP_ACTIVE_CONFLICT",
        details: { loopId: loop.loopId, trigger: "manual", reason: "global_kill_active", report: { status: "skipped", reason: "global_kill_active" } },
      },
    });

    const clearRes = await app.request(`/api/projects/${project.slug}/loops/kill-all`, { method: "DELETE" });
    expect(clearRes.status).toBe(200);
    expect(await clearRes.json()).toEqual({ killState: { globalKillActive: false } });
  });

  test("reads budget collision and integration snapshots without leaking secrets", async () => {
    const { app, project, runtime, workspaceRoot } = await createTestApp("guardrail-status-snapshots");
    const loop = await createLoop(app, project.slug, {
      ...manualSessionLoopConfig,
      toolProfileId: "loop_github_pr_watch",
      collisionTargets: [{ type: "pr", owner: "archcode", repo: "workbench", number: 42 }],
    });
    await runtime.seedLoopSnapshots(workspaceRoot, loop.loopId);

    const budgetRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/budget`);
    expect(budgetRes.status).toBe(200);
    expect(await budgetRes.json()).toEqual({ loopId: loop.loopId, budget: seededBudgetSnapshot() });

    const collisionsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/collisions`);
    expect(collisionsRes.status).toBe(200);
    expect(await collisionsRes.json()).toEqual({ loopId: loop.loopId, collisions: seededCollisionSnapshot(loop.loopId) });

    const integrationsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/integrations`);
    expect(integrationsRes.status).toBe(200);
    const integrationsBody = await integrationsRes.json() as { loopId: string; integrations: { statuses: Array<{ status: string; message?: string }>; snapshot: LoopIntegrationSnapshot } };
    expect(integrationsBody.loopId).toBe(loop.loopId);
    expect(integrationsBody.integrations.statuses).toContainEqual(expect.objectContaining({ status: "auth_missing", reason: "integration_auth_missing" }));
    expect(JSON.stringify(integrationsBody)).not.toContain("ghp_secret_route_token");
    expect(JSON.stringify(integrationsBody)).not.toContain("ghr_route_refresh_secret");
    expect(JSON.stringify(integrationsBody)).not.toContain("github_pat_route_secret_value");
    expect(integrationsBody.integrations.snapshot.errors[0]?.message).toContain("[REDACTED:SECRET]");
  });

  test("persists collision_conflict run history for canonical PR target", async () => {
    const { app, project, runtime, workspaceRoot } = await createTestApp("collision-run-history");
    const loop = await createLoop(app, project.slug, {
      ...manualSessionLoopConfig,
      title: "PR collision loop",
      toolProfileId: "loop_github_pr_watch",
      collisionTargets: [{ type: "pr", owner: "archcode", repo: "archcode", number: 42 }],
    });
    await runtime.seedCollisionRunHistory(workspaceRoot, loop.loopId);

    const runsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs`);
    const runsBody = await runsRes.json() as { runs: LoopRunReport[] };

    expect(runsRes.status).toBe(200);
    expect(runsBody.runs[0]).toMatchObject({
      runId: "run-1",
      status: "skipped",
      reason: "collision_conflict",
      toolProfileId: "loop_github_pr_watch",
      collisionConflicts: [expect.objectContaining({ targetKey: "github:archcode/archcode:pr:42" })],
    });
  });

  test("run history exposes Phase 5 job metadata and sanitizes worktree paths", async () => {
    const { app, project, runtime, workspaceRoot } = await createTestApp("phase-5-run-history-metadata");
    const loop = await createLoop(app, project.slug, prTriggerSessionLoopConfig);
    const seeded = await runtime.seedPhase5RunHistory(workspaceRoot, loop.loopId);

    const runsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs`);
    const runsBody = await runsRes.json() as { runs: LoopRunReport[] };

    expect(runsRes.status).toBe(200);
    const safeRun = runsBody.runs.find((run) => run.runId === "run-safe-worktree");
    expect(safeRun).toMatchObject({
      jobId: "job-safe",
      trigger: "on_pr",
      triggerKind: "on_pr",
      subjectKey: "pr:archcode/archcode#42",
      dedupeKey: `${loop.loopId}:on_pr:pr:archcode/archcode#42`,
      branchKey: "github:archcode/archcode:main",
      worktreePath: seeded.safeWorktreePath,
      baseSha: "a".repeat(40),
      resolvedHeadSha: "b".repeat(40),
      cleanupState: "preserved",
      observedArtifacts: [{ path: "evidence/report.md", status: "created", sizeBytes: 128, sha: "artifact-sha" }],
    });
    expect(safeRun?.blockedReason).toContain("[REDACTED:SECRET]");

    const unsafeRun = runsBody.runs.find((run) => run.runId === "run-unsafe-worktree");
    expect(unsafeRun).toMatchObject({
      jobId: "job-unsafe",
      triggerKind: "on_commit",
      subjectKey: "branch:feature/leaky",
      dedupeKey: `${loop.loopId}:on_commit:branch:feature/leaky`,
      branchKey: "github:archcode/archcode:feature/leaky",
      cleanupState: "cleanup_failed",
    });
    expect(unsafeRun?.worktreePath).toBeUndefined();
    expect(JSON.stringify(runsBody)).not.toContain(seeded.unsafeWorktreePath);
    expect(JSON.stringify(runsBody)).not.toContain("ghr_run_report_secret");
    expect(JSON.stringify(runsBody)).not.toContain("github_pat_run_report_secret");

    const persisted = await runtime.readLoopRunLog(workspaceRoot, loop.loopId);
    expect(persisted.find((run) => run.runId === "run-unsafe-worktree")?.worktreePath).toBe(seeded.unsafeWorktreePath);
  });

  test("read list and state routes expose trigger queue and cleanup metadata safely", async () => {
    const { app, project, runtime, workspaceRoot } = await createTestApp("phase-5-state-metadata");
    const loop = await createLoop(app, project.slug, prTriggerSessionLoopConfig);
    const seeded = await runtime.seedPhase5LoopState(workspaceRoot, loop.loopId);

    const listRes = await app.request(`/api/projects/${project.slug}/loops`);
    const listBody = await listRes.json() as { loops: LoopState[] };
    expect(listRes.status).toBe(200);
    expect(listBody.loops[0]).toMatchObject({
      loopId: loop.loopId,
      cleanupState: "cleanup_candidate",
      currentJob: {
        jobId: "job-current",
        status: "blocked",
        triggerKind: "on_pr",
        worktreePath: seeded.safeWorktreePath,
        cleanupState: "preserved",
        observedArtifacts: [{ path: "evidence/current.md", status: "modified" }],
      },
      queuedJobs: [{
        jobId: "job-queued",
        status: "queued",
        triggerKind: "on_ci_fail",
        cleanupState: "expired_needs_review",
      }],
      triggerHealth: [{ triggerKind: "on_pr", status: "blocked", cadenceMs: 60_000 }],
    });
    expect(listBody.loops[0]?.queuedJobs?.[0]?.worktreePath).toBeUndefined();
    expect(JSON.stringify(listBody)).not.toContain(seeded.unsafeWorktreePath);
    expect(JSON.stringify(listBody)).not.toContain("ghp_secret_route_token");
    expect(JSON.stringify(listBody)).not.toContain("ghr_trigger_health_secret");
    expect(JSON.stringify(listBody)).not.toContain("github_pat_job_blocked_secret");
    expect(listBody.loops[0]?.triggerHealth?.[0]?.lastError).toContain("[REDACTED:SECRET]");

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`);
    const readBody = await readRes.json() as { loop: LoopState };
    expect(readRes.status).toBe(200);
    expect(readBody.loop.currentJob?.worktreePath).toBe(seeded.safeWorktreePath);
    expect(readBody.loop.queuedJobs?.[0]?.worktreePath).toBeUndefined();

    const stateRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/state`);
    const stateBody = await stateRes.json() as { markdown: string; state: LoopState };
    expect(stateRes.status).toBe(200);
    expect(stateBody.state.currentJob?.worktreePath).toBe(seeded.safeWorktreePath);
    expect(stateBody.state.cleanupState).toBe("cleanup_candidate");
    expect(JSON.stringify(stateBody)).not.toContain(seeded.unsafeWorktreePath);
  });

  test("patch update, run reports, generated state, and invalid paths use stable JSON shapes", async () => {
    const { app, project } = await createTestApp("patch-log-state");
    const loop = await createLoop(app, project.slug, manualSessionLoopConfig);

    const patchRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "paused" }),
      headers: { "content-type": "application/json" },
    });
    expect(patchRes.status).toBe(200);
    expect(await patchRes.json()).toMatchObject({ loop: { loopId: loop.loopId, status: "paused" } });

    const phase5PatchConfig: LoopConfig = {
      ...prTriggerSessionLoopConfig,
      schedule: { kind: "cron", expression: "*/15 * * * *" },
      cleanupPolicy: { deleteUnchangedWorktrees: true, preserveChangedArtifacts: true },
    };
    const phase5PatchRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`, {
      method: "PATCH",
      body: JSON.stringify({ config: phase5PatchConfig }),
      headers: { "content-type": "application/json" },
    });
    const phase5PatchBody = await phase5PatchRes.json() as { loop: LoopState };
    expect(phase5PatchRes.status).toBe(200);
    expect(phase5PatchBody.loop.config.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *" });
    expect(phase5PatchBody.loop.config.triggers).toEqual([{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }]);
    expect(phase5PatchBody.loop.config.cleanupPolicy).toEqual({ deleteUnchangedWorktrees: true, preserveChangedArtifacts: true });

    for (const internalPatch of [{ nextRunAt: 123_456 }, { generatedStateSummary: "server generated only" }, { runCount: 99 }]) {
      const internalPatchRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`, {
        method: "PATCH",
        body: JSON.stringify(internalPatch),
        headers: { "content-type": "application/json" },
      });
      expect(internalPatchRes.status).toBe(400);
      expect(await internalPatchRes.json()).toMatchObject({ error: { code: "BAD_REQUEST", message: "Request body is invalid" } });
    }

    await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/trigger`, { method: "POST" });
    const runsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs?limit=1`);
    const runsBody = await runsRes.json() as { runs: LoopRunReport[] };
    expect(runsRes.status).toBe(200);
    expect(runsBody.runs).toEqual([expect.objectContaining({ runId: "run-1", loopId: loop.loopId, status: "succeeded" })]);

    const stateRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/state`);
    const stateBody = await stateRes.json() as { markdown: string; state: LoopState };
    expect(stateRes.status).toBe(200);
    expect(stateBody.markdown).toContain("Manual session loop");
    expect(stateBody.state.loopId).toBe(loop.loopId);
    expect(stateBody.state.readinessScore ?? null).toBeNull();

    const invalidIdRes = await app.request(`/api/projects/${project.slug}/loops/not-a-uuid`);
    expect(invalidIdRes.status).toBe(400);
    expect(await invalidIdRes.json()).toEqual({ error: { code: "BAD_REQUEST", message: "loopId must be a UUID" } });
  });
});

async function createLoop(app: ReturnType<typeof createServerApp>["app"], slug: string, config: LoopConfig): Promise<LoopState> {
  const res = await app.request(`/api/projects/${slug}/loops`, {
    method: "POST",
    body: JSON.stringify({ config }),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return (await res.json() as { loop: LoopState }).loop;
}

function seededBudgetSnapshot(): LoopBudgetSnapshot {
  return {
    budget: { maxIterationsPerRun: 4, maxTokensPerRun: 1_000, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
    usage: {
      iterations: 1,
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      totalTokens: 150,
      wallClockMs: 500,
      runsToday: 1,
      resetDateUtc: "2026-07-05",
      pricingUnavailable: true,
    },
    updatedAt: 2_000,
  };
}

function seededCollisionSnapshot(loopId: string): LoopCollisionSnapshot {
  const target = { type: "pr", owner: "archcode", repo: "archcode", number: 42 } as const;
  const lease = {
    targetKey: "github:archcode/archcode:pr:42",
    target,
    loopId,
    runId: "run-collision",
    actionId: "loop:manual",
    priority: 0,
    createdAt: 1_500,
    expiresAt: 61_500,
  };
  return {
    targets: [target],
    activeLeases: [lease],
    conflicts: [{ targetKey: lease.targetKey, target, conflictingLease: lease, detectedAt: 1_750 }],
    updatedAt: 2_000,
  };
}

function seededIntegrationSnapshot(): LoopIntegrationSnapshot {
  return {
    errors: [{
      integrationId: "github",
      reason: "integration_auth_missing",
      message: "Missing token ghp_secret_route_token plus ghr_route_refresh_secret and github_pat_route_secret_value",
      occurredAt: 2_000,
    }],
    updatedAt: 2_000,
  };
}

async function createTestApp(testName: string, options: { now?: number; holdRunsOpen?: boolean } = {}) {
  const homeDir = resolve(tempRoot, "homes", testName);
  const workspaceRoot = resolve(tempRoot, "workspaces", testName);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  const projectRegistry = new ProjectRegistry({ homeDir, logger: silentLogger });
  const project = await projectRegistry.add({ workspaceRoot, name: testName });
  const runtime = createTestRuntime(projectRegistry, options);

  return {
    app: createServerApp(runtime, { dev: true }).app,
    project,
    runtime,
    workspaceRoot,
  };
}

function createTestRuntime(projectRegistry: ProjectRegistry, options: { now?: number; holdRunsOpen?: boolean }): AgentRuntime & {
  setNow(value: number): void;
  waitForActiveRun(): Promise<void>;
  releaseActiveRun(): void;
  createLoopRunCount(): number;
  seedLoopSnapshots(workspaceRoot: string, loopId: string): Promise<void>;
  seedCollisionRunHistory(workspaceRoot: string, loopId: string): Promise<void>;
  seedPhase5RunHistory(workspaceRoot: string, loopId: string): Promise<{ safeWorktreePath: string; unsafeWorktreePath: string }>;
  seedPhase5LoopState(workspaceRoot: string, loopId: string): Promise<{ safeWorktreePath: string; unsafeWorktreePath: string }>;
} {
  const contextResolver = new ProjectContextResolver({ logger: silentLogger });
  let now = options.now ?? 1_000;
  let runSequence = 0;
  const activeRuns = new Map<string, { runId: string; sessionId?: string }>();
  let activeRunStarted: (() => void) | undefined;
  let activeRunStartedPromise = new Promise<void>((resolveStarted) => {
    activeRunStarted = resolveStarted;
  });
  let releaseActiveRun: (() => void) | undefined;
  let killState: { globalKillActive: boolean; activatedAt?: number; activatedBy?: string; reason?: string } = { globalKillActive: false };

  const runtime = {
    projectRegistry,
    contextResolver,
    warnings: [],
    mcpManager: undefined,
    toolRegistry: undefined,
    providerRegistry: undefined,
    skillService: undefined,
    hitl: undefined,
    subscribeMcpStatusChanges: mock(() => () => undefined),
    getMcpServerStatuses: mock(() => new Map()),
    createSession: mock(async () => ({ sessionId: crypto.randomUUID(), title: null, createdAt: now, messages: [], steps: [], todos: [], reminders: [], executions: [] })),
    getSessionFile: mock(async (_workspaceRoot: string, sessionId: string) => ({ sessionId, title: null, createdAt: now, messages: [], steps: [], todos: [], reminders: [], executions: [] })),
    listSessions: mock(async () => []),
    startSessionExecution: mock((input: { workspaceRoot: string; sessionId: string }) => ({
      sessionId: input.sessionId,
      workspaceRoot: input.workspaceRoot,
      agentName: "orchestrator",
      origin: "loop",
      abortController: new AbortController(),
      promise: Promise.resolve(),
      executionToken: Symbol("test-execution"),
      startedAt: now,
    })),
    abortSessionExecution: mock(() => false),
    abortSessionExecutionAndWait: mock(async () => undefined),
    abortAllSessionExecutions: mock(async () => undefined),
    isSessionExecutionRunning: mock(() => false),
    getSessionExecution: mock(() => undefined),
    subscribeSessionEvents: mock(() => () => undefined),
    deleteSession: mock(async () => undefined),
    disposeSessionAgent: mock(() => undefined),
    disposeAllSessionAgents: mock(() => undefined),
    isSessionTombstoned: mock(() => false),
    dispatchCommand: mock(async () => null),
    requestPermission: mock(async () => "timeout"),
    respondPermission: mock(() => false),
    requestQuestion: mock(async () => ({ isError: true, reason: "Cancelled" })),
    respondQuestion: mock(() => false),
    cleanupDeferredSession: mock(() => undefined),
    notifyRuntimeShutdown: mock(() => undefined),
    listLoops: mock(async (workspaceRoot: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.list(context.project.slug);
    }),
    readLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId)),
    createLoop: mock(async (workspaceRoot: string, config: LoopConfig, author?: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.create(context.project.slug, config, author);
    }),
    updateLoop: mock(async (workspaceRoot: string, loopId: string, updates) => (await contextResolver.resolve(workspaceRoot)).loopState.update(loopId, updates)),
    pauseLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.pause(loopId)),
    resumeLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.resume(loopId, now)),
    triggerLoopRun: mock(async (workspaceRoot: string, loopId: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      const loop = await context.loopState.read(loopId);
      if (killState.globalKillActive) {
        return await context.loopState.appendRunReport(loopId, {
          runId: `run-${runSequence + 1}-skipped`,
          loopId,
          status: "skipped",
          trigger: "manual",
          startedAt: now,
          endedAt: now,
          reason: "global_kill_active",
          skippedReason: "Global Loop kill switch is active; skipped trigger.",
        });
      }
      const existing = activeRuns.get(loopId);
      if (existing !== undefined) throw new LoopActiveConflictError(loopId, "manual", existing.runId, existing.sessionId);

      runSequence += 1;
      const runId = `run-${runSequence}`;
      const sessionId = loop.config.runKind === "goal" ? `goal-session-${runSequence}` : `session-${runSequence}`;
      const startedAt = now;
      const runningReport: LoopRunReport = { runId, loopId, status: "running", trigger: "manual", startedAt, sessionId };
      activeRuns.set(loopId, { runId, sessionId });
      await context.loopState.recordRunStart(loopId, runningReport);
      activeRunStarted?.();

      if (options.holdRunsOpen) {
        await new Promise<void>((resolveRelease) => {
          releaseActiveRun = resolveRelease;
        });
      }

      now += 1;
      const latest = await context.loopState.read(loopId);
      if (latest.lastRun?.runId === runId && latest.lastRun.status === "cancelled") {
        activeRuns.delete(loopId);
        activeRunStartedPromise = new Promise<void>((resolveStarted) => {
          activeRunStarted = resolveStarted;
        });
        releaseActiveRun = undefined;
        return latest.lastRun;
      }

      const finished: LoopRunReport = {
        ...runningReport,
        status: "succeeded",
        endedAt: now,
        ...(loop.config.runKind === "goal" ? { goalId: `goal-${runSequence}` } : {}),
        summary: `Loop ${loopId} completed in fake runtime.`,
      };
      try {
        await context.loopState.recordRunFinish(loopId, finished);
        return finished;
      } finally {
        activeRuns.delete(loopId);
        activeRunStartedPromise = new Promise<void>((resolveStarted) => {
          activeRunStarted = resolveStarted;
        });
        releaseActiveRun = undefined;
      }
    }),
    readLoopKillState: mock(async () => killState),
    cancelLoopCurrentRun: mock(async (workspaceRoot: string, loopId: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      const loop = await context.loopState.read(loopId);
      const running = loop.currentRun?.status === "running" ? loop.currentRun : undefined;
      if (running === undefined) return undefined;
      const report: LoopRunReport = { ...running, status: "cancelled", endedAt: now, reason: "cancelled_by_user" };
      await context.loopState.recordRunFinish(loopId, report);
      activeRuns.delete(loopId);
      return report;
    }),
    cancelCurrentLoopRun: mock(async (workspaceRoot: string, loopId: string) => runtime.cancelLoopCurrentRun(workspaceRoot, loopId)),
    activateLoopGlobalKill: mock(async (_workspaceRoot: string, input?: { activatedAt?: number; activatedBy?: string; reason?: string }) => {
      killState = {
        globalKillActive: true,
        activatedAt: input?.activatedAt ?? now,
        ...(input?.activatedBy === undefined ? {} : { activatedBy: input.activatedBy }),
        ...(input?.reason === undefined ? {} : { reason: input.reason }),
      };
      return killState;
    }),
    clearLoopGlobalKill: mock(async () => {
      killState = { globalKillActive: false };
      return killState;
    }),
    readLoopBudget: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId).then((loop) => loop.latestBudget ?? null)),
    readLoopCollisions: mock(async (workspaceRoot: string, loopId: string) => {
      const loop = await (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId);
      return loop.latestCollisions ?? { targets: loop.config.collisionTargets ?? [], activeLeases: [], conflicts: [], updatedAt: loop.updatedAt };
    }),
    readLoopIntegrationStatus: mock(async (workspaceRoot: string, loopId: string) => {
      const loop = await (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId);
      const snapshot = loop.latestIntegrations ?? null;
      return {
        statuses: [{ integrationId: "github", status: "auth_missing", reason: "integration_auth_missing", message: "Missing GitHub token", updatedAt: loop.updatedAt }],
        snapshot: snapshot === null ? null : {
          ...snapshot,
          errors: snapshot.errors.map((error) => ({ ...error, message: error.message.replace("ghp_secret_route_token", "[REDACTED:SECRET]") })),
        },
        updatedAt: Math.max(loop.updatedAt, snapshot?.updatedAt ?? 0),
      };
    }),
    readLoopRunLog: mock(async (workspaceRoot: string, loopId: string, limit?: number) => (await contextResolver.resolve(workspaceRoot)).loopState.readRunLog(loopId, limit)),
    readLoopStateMarkdown: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.readGeneratedStateMarkdown(loopId)),
    startLoopSchedulers: mock(async () => undefined),
    stopLoopSchedulers: mock(() => undefined),
    setNow(value: number) {
      now = value;
    },
    waitForActiveRun: () => activeRunStartedPromise,
    releaseActiveRun() {
      releaseActiveRun?.();
    },
    createLoopRunCount: () => runSequence,
    async seedLoopSnapshots(workspaceRoot: string, loopId: string) {
      const context = await contextResolver.resolve(workspaceRoot);
      await context.loopState.updateBudgetSnapshot(loopId, seededBudgetSnapshot());
      await context.loopState.updateCollisionSnapshot(loopId, seededCollisionSnapshot(loopId));
      await context.loopState.updateIntegrationSnapshot(loopId, seededIntegrationSnapshot());
    },
    async seedCollisionRunHistory(workspaceRoot: string, loopId: string) {
      const context = await contextResolver.resolve(workspaceRoot);
      const target = { type: "pr", owner: "archcode", repo: "archcode", number: 42 } as const;
      const conflictingLease = {
        targetKey: "github:archcode/archcode:pr:42",
        target,
        loopId: "00000000-0000-4000-8000-000000000042",
        runId: "other-run",
        priority: 10,
        createdAt: now - 100,
        expiresAt: now + 60_000,
      };
      await context.loopState.appendRunReport(loopId, {
        runId: "run-1",
        loopId,
        status: "skipped",
        trigger: "manual",
        startedAt: now,
        endedAt: now,
        reason: "collision_conflict",
        skippedReason: "Loop static collision targets conflict with an active run; skipped trigger.",
        collisionTargets: [target],
        collisionConflicts: [{ targetKey: conflictingLease.targetKey, target, conflictingLease, detectedAt: now }],
        toolProfileId: "loop_github_pr_watch",
      });
    },
    async seedPhase5RunHistory(workspaceRoot: string, loopId: string) {
      const context = await contextResolver.resolve(workspaceRoot);
      const { safeWorktreePath, unsafeWorktreePath } = phase5WorktreePaths(workspaceRoot);
      await context.loopState.appendRunReport(loopId, {
        runId: "run-safe-worktree",
        loopId,
        status: "skipped",
        trigger: "on_pr",
        triggerKind: "on_pr",
        startedAt: now,
        endedAt: now,
        reason: "execution_failed",
        jobId: "job-safe",
        subjectKey: "pr:archcode/archcode#42",
        dedupeKey: `${loopId}:on_pr:pr:archcode/archcode#42`,
        branchKey: "github:archcode/archcode:main",
        worktreePath: safeWorktreePath,
        baseSha: "a".repeat(40),
        resolvedHeadSha: "b".repeat(40),
        blockedReason: "needs_user ghr_run_report_secret github_pat_run_report_secret",
        cleanupState: "preserved",
        observedArtifacts: [{ path: "evidence/report.md", status: "created", sizeBytes: 128, sha: "artifact-sha" }],
      });
      await context.loopState.appendRunReport(loopId, {
        runId: "run-unsafe-worktree",
        loopId,
        status: "skipped",
        trigger: "on_commit",
        triggerKind: "on_commit",
        startedAt: now + 1,
        endedAt: now + 1,
        reason: "execution_failed",
        jobId: "job-unsafe",
        subjectKey: "branch:feature/leaky",
        dedupeKey: `${loopId}:on_commit:branch:feature/leaky`,
        branchKey: "github:archcode/archcode:feature/leaky",
        worktreePath: unsafeWorktreePath,
        baseSha: "c".repeat(40),
        resolvedHeadSha: "d".repeat(40),
        blockedReason: "failed_with_changes",
        cleanupState: "cleanup_failed",
      });
      return { safeWorktreePath, unsafeWorktreePath };
    },
    async seedPhase5LoopState(workspaceRoot: string, loopId: string) {
      const context = await contextResolver.resolve(workspaceRoot);
      const { safeWorktreePath, unsafeWorktreePath } = phase5WorktreePaths(workspaceRoot);
      const currentJob: LoopJobSummary = {
        jobId: "job-current",
        loopId,
        status: "blocked",
        triggerKind: "on_pr",
        subjectKey: "pr:archcode/archcode#42",
        dedupeKey: `${loopId}:on_pr:pr:archcode/archcode#42`,
        branchKey: "github:archcode/archcode:main",
        queuedAt: now,
        startedAt: now + 1,
        attempts: 1,
        blockedReason: "needs_user token=ghp_secret_route_token github_pat_job_blocked_secret",
        worktreePath: safeWorktreePath,
        baseSha: "a".repeat(40),
        resolvedHeadSha: "b".repeat(40),
        cleanupState: "preserved",
        observedArtifacts: [{ path: "evidence/current.md", status: "modified" }],
      };
      const queuedJob: LoopJobSummary = {
        jobId: "job-queued",
        loopId,
        status: "queued",
        triggerKind: "on_ci_fail",
        subjectKey: "ci:archcode/archcode:ci:deadbeef",
        dedupeKey: `${loopId}:on_ci_fail:ci:archcode/archcode:ci:deadbeef`,
        branchKey: "github:archcode/archcode:feature/leaky",
        queuedAt: now + 2,
        attempts: 0,
        worktreePath: unsafeWorktreePath,
        cleanupState: "expired_needs_review",
      };
      await context.loopState.update(loopId, {
        cleanupState: "cleanup_candidate",
        triggerHealth: [{ triggerKind: "on_pr", status: "blocked", cadenceMs: 60_000, lastCheckedAt: now + 3, lastError: "token=ghp_secret_route_token ghr_trigger_health_secret", missedCount: 1 }],
      });
      const state = await context.loopState.read(loopId);
      await Bun.write(resolve(workspaceRoot, ".archcode", "loops", loopId, "state.json"), `${JSON.stringify({
        ...state,
        currentJob,
        queuedJobs: [queuedJob],
      }, null, 2)}\n`);
      return { safeWorktreePath, unsafeWorktreePath };
    },
  } as unknown as AgentRuntime & {
    setNow(value: number): void;
    waitForActiveRun(): Promise<void>;
    releaseActiveRun(): void;
    createLoopRunCount(): number;
    seedLoopSnapshots(workspaceRoot: string, loopId: string): Promise<void>;
    seedCollisionRunHistory(workspaceRoot: string, loopId: string): Promise<void>;
    seedPhase5RunHistory(workspaceRoot: string, loopId: string): Promise<{ safeWorktreePath: string; unsafeWorktreePath: string }>;
    seedPhase5LoopState(workspaceRoot: string, loopId: string): Promise<{ safeWorktreePath: string; unsafeWorktreePath: string }>;
  };

  return runtime;
}

function phase5WorktreePaths(workspaceRoot: string): { safeWorktreePath: string; unsafeWorktreePath: string } {
  const managedRoot = resolve(dirname(workspaceRoot), `${basename(workspaceRoot)}.worktrees`);
  return {
    safeWorktreePath: join(managedRoot, "loop-safe-worktree"),
    unsafeWorktreePath: resolve(dirname(workspaceRoot), "not-managed", "loop-unsafe-worktree"),
  };
}
