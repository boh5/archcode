import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  LoopActiveConflictError,
  expandLoopTemplate,
  ProjectContextResolver,
  ProjectRegistry,
  silentLogger,
  type AgentRuntime,
  type LoopConfig,
  type LoopRunReport,
} from "@archcode/agent-core";
import type { LoopBudgetSnapshot, LoopCollisionSnapshot, LoopIntegrationSnapshot, LoopState } from "@archcode/protocol";
import { SessionStoreManager } from "../../../../packages/agent-core/src/store/session-store-manager";
import { createTestProjectContextResolverOptions } from "../../../../packages/agent-core/src/tools/test-project-context";
import { createServerApp } from "../app";

const tempRoot = resolve(import.meta.dir, "__test_tmp__", "loops-routes");

const manualSessionLoopConfig: LoopConfig = {
  templateId: "watch_report",
  title: null,
  schedule: { kind: "manual" },
  approvalPolicy: "interactive",
  limits: { maxIterationsPerRun: 4, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  useWorktree: false,
  taskPrompt: "Summarize local project health.",
};

const intervalSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  schedule: { kind: "interval", everyMs: 1_000 },
};

const prTriggerSessionLoopConfig: LoopConfig = {
  ...manualSessionLoopConfig,
  schedule: { kind: "manual" },
  triggers: [{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }],
};

const TEST_GITHUB_OWNER = "test-owner";
const TEST_GITHUB_REPO = "test-repo";
const TEST_GITHUB_TARGET_KEY = `github:${TEST_GITHUB_OWNER}/${TEST_GITHUB_REPO}:pr:42`;
const TEST_GITHUB_PR_SUBJECT_KEY = `pr:${TEST_GITHUB_OWNER}/${TEST_GITHUB_REPO}#42`;

const goalLoopConfig: LoopConfig = {
  templateId: "goal_runner",
  title: null,
  schedule: { kind: "manual" },
  approvalPolicy: "explicit_per_run",
  limits: { maxIterationsPerRun: 3, softThresholdRatio: 0.8, hardThresholdRatio: 1 },
  useWorktree: false,
  goalTemplate: {
    title: null,
    objective: "Execute this inline Goal template only.",
    acceptanceCriteria: "Reviewer can decide DONE from loop-created Goal evidence.",
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

  test("rejects create payloads that omit canonical Loop fields", async () => {
    const { app, project } = await createTestApp("canonical-create-fields");
    const canonical = createLoopBodyFromConfig(manualSessionLoopConfig);

    for (const field of ["schedule", "approvalPolicy", "limits", "useWorktree"] as const) {
      const body = { ...canonical };
      delete body[field];
      const res = await app.request(`/api/projects/${project.slug}/loops`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
    }

    const missingRatios = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ ...canonical, limits: { maxIterationsPerRun: 4 } }),
      headers: { "content-type": "application/json" },
    });
    expect(missingRatios.status).toBe(400);

    const missingCadence = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ ...canonical, triggers: [{ kind: "on_pr", baseBranch: "main" }] }),
      headers: { "content-type": "application/json" },
    });
    expect(missingCadence.status).toBe(400);
  });

test("creates and reads a manual session loop without readiness score", async () => {
    const { app, project, runtime } = await createTestApp("manual-session-loop");

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify(createLoopBodyFromConfig(manualSessionLoopConfig)),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop).toMatchObject({ projectId: project.slug, status: "active", config: { templateId: "watch_report", title: null, schedule: { kind: "manual" } } });
    expect(createBody.loop.nextRunAt).toBeUndefined();
  expect(createBody.loop).not.toHaveProperty("readinessScore");
    expect(runtime.createLoop).toHaveBeenCalledWith(project.workspaceRoot, manualSessionLoopConfig);

    const listRes = await app.request(`/api/projects/${project.slug}/loops`);
    const listBody = await listRes.json() as { loops: LoopState[] };
    expect(listRes.status).toBe(200);
    expect(listBody.loops.map((loop) => loop.loopId)).toEqual([createBody.loop.loopId]);

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    expect(readRes.status).toBe(200);
    expect(await readRes.json()).toEqual({ loop: createBody.loop });
  });

  test("creates all supported templates through explicit canonical bodies", async () => {
    const { app, project } = await createTestApp("supported-template-create", { now: 10_000 });
    for (const templateId of ["watch_report", "maintain_fix", "pr_babysitter", "goal_runner"] as const) {
      const res = await app.request(`/api/projects/${project.slug}/loops`, {
        method: "POST",
        body: JSON.stringify(createLoopBodyFromConfig(templateId === "goal_runner" ? {
          ...expandLoopTemplate(templateId),
          goalTemplate: {
            title: null,
            objective: "Run the recurring Goal.",
            acceptanceCriteria: "Reviewer can decide DONE from loop evidence.",
          },
        } : expandLoopTemplate(templateId))),
        headers: { "content-type": "application/json" },
      });
      const body = await res.json() as { loop: LoopState };

      expect(res.status).toBe(201);
      expect(body.loop.config.templateId).toBe(templateId);
      expect(body.loop.config.title).toBeNull();
      expect(body.loop.config.useWorktree).toBe(false);
      expect(body.loop.nextRunAt).toBeUndefined();
  expect(body.loop).not.toHaveProperty("readinessScore");
    }

    const prBabysitterRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify(createLoopBodyFromConfig(expandLoopTemplate("pr_babysitter"))),
      headers: { "content-type": "application/json" },
    });
    const prBabysitterBody = await prBabysitterRes.json() as { loop: LoopState };
    expect(prBabysitterRes.status).toBe(201);
    expect(prBabysitterBody.loop.config.taskPrompt).toContain("draft a short issue comment only when a clear status update is useful");
    expect(prBabysitterBody.loop.config.taskPrompt?.toLowerCase()).not.toContain("merge");
    expect(prBabysitterBody.loop.config.taskPrompt?.toLowerCase()).not.toContain("rebase");
  });

  test("creates cron loops and persists UTC cron metadata", async () => {
    const { app, project, runtime } = await createTestApp("cron-loop-create", { now: 10_000 });

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify(createLoopBodyFromConfig({
        ...manualSessionLoopConfig,
        schedule: { kind: "cron", expression: "*/15 * * * *" },
      })),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop.config.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *" });
    expect(createBody.loop.config.title).toBeNull();
    expect(JSON.stringify(createBody.loop)).not.toContain("readinessScore");
    expect(runtime.createLoop).toHaveBeenCalledWith(project.workspaceRoot, expect.objectContaining({
      ...manualSessionLoopConfig,
      schedule: { kind: "cron", expression: "*/15 * * * *" },
    }));

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    const readBody = await readRes.json() as { loop: LoopState };
    expect(readRes.status).toBe(200);
    expect(readBody.loop.config.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *" });
  });

  test("patches simple trigger fields and rejects cleanup policy as ordinary input", async () => {
    const { app, project } = await createTestApp("manual-pr-trigger-create");

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify(createLoopBodyFromConfig(expandLoopTemplate("pr_babysitter"))),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    const patchRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`, {
      method: "PATCH",
      body: JSON.stringify({
        templateId: "maintain_fix",
        schedule: { kind: "manual" },
        triggers: [{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }],
      }),
      headers: { "content-type": "application/json" },
    });
    const patchBody = await patchRes.json() as { loop: LoopState };

    expect(patchRes.status).toBe(200);
    expect(patchBody.loop.config.templateId).toBe("maintain_fix");
    expect(patchBody.loop.config.schedule).toEqual({ kind: "manual" });
    expect(patchBody.loop.config.triggers).toEqual([{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }]);
    expect(patchBody.loop.config).not.toHaveProperty("cleanupPolicy");

    const cleanupPolicyRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`, {
      method: "PATCH",
      body: JSON.stringify({ cleanupPolicy: { deleteUnchangedWorktrees: true, preserveChangedArtifacts: true, maxPreservedWorktrees: 3 } }),
      headers: { "content-type": "application/json" },
    });
    expect(cleanupPolicyRes.status).toBe(400);

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${createBody.loop.loopId}`);
    const readBody = await readRes.json() as { loop: LoopState };
    expect(readRes.status).toBe(200);
    expect(readBody.loop.config.schedule.kind).toBe("manual");
    expect(readBody.loop.config.triggers?.[0]).toMatchObject({ kind: "on_pr", baseBranch: "main", cadenceMs: 60_000 });
  });

  test("rejects invalid cron cadence and unsupported coordinator config with stable messages", async () => {
    const { app, project } = await createTestApp("loop-config-rejections");
    const cases: Array<{ name: string; body: unknown; message: string; patch?: boolean }> = [
      {
        name: "invalid cron",
        body: { schedule: { kind: "cron", expression: "60 * * * *" } },
        message: "schedule.expression must be a valid 5-field UTC cron expression",
        patch: true,
      },
      {
        name: "impossible cron",
        body: { schedule: { kind: "cron", expression: "0 0 30 2 *" } },
        message: "schedule.expression must be a valid 5-field UTC cron expression",
        patch: true,
      },
      {
        name: "too-fast trigger cadence",
        body: { triggers: [{ kind: "on_pr", cadenceMs: 29_000, baseBranch: "main" }] },
        message: "triggers.0.cadenceMs must be at least 30000",
        patch: true,
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

    const missingTemplateRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify(createLoopBodyFromConfig(expandLoopTemplate("goal_runner"))),
      headers: { "content-type": "application/json" },
    });
    expect(missingTemplateRes.status).toBe(400);

    const createRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify(createLoopBodyFromConfig(goalLoopConfig)),
      headers: { "content-type": "application/json" },
    });
    const createBody = await createRes.json() as { loop: LoopState };

    expect(createRes.status).toBe(201);
    expect(createBody.loop.config.templateId).toBe("goal_runner");
    expect(createBody.loop.config.goalTemplate).toBeDefined();
    expect(createBody.loop.config.goalTemplate).not.toHaveProperty("author");
  expect(createBody.loop).not.toHaveProperty("readinessScore");

    const invalidRes = await app.request(`/api/projects/${project.slug}/loops`, {
      method: "POST",
      body: JSON.stringify({ ...createLoopBodyFromConfig(goalLoopConfig), goalTemplateId: "existing-goal" }),
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

    for (const body of [
      { config: manualSessionLoopConfig },
      { presetId: "daily_triage" },
      { templateId: "daily_triage" },
      { templateId: "watch_report", mode: "fix" },
      { templateId: "watch_report", toolProfileId: "loop_local_report" },
      { templateId: "pr_babysitter", extraTools: ["bash"] },
      { templateId: "watch_report", collisionTargets: [{ type: "file", path: "README.md" }] },
      { templateId: "watch_report", cleanupPolicy: { deleteUnchangedWorktrees: true } },
      { templateId: "watch_report", run: { agent: "build", type: "goal" } },
      { templateId: "watch_report", schedule: { kind: "event", event: "pull_request" } },
      { templateId: "watch_report", autoApprove: true },
      { templateId: "watch_report", customPatternPath: ".archcode/loops/patterns.ts" },
    ]) {
      const res = await app.request(`/api/projects/${project.slug}/loops`, {
        method: "POST",
        body: JSON.stringify(body),
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
      collisionTargets: [{ type: "pr", owner: TEST_GITHUB_OWNER, repo: TEST_GITHUB_REPO, number: 42 }],
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
      collisionTargets: [{ type: "pr", owner: TEST_GITHUB_OWNER, repo: TEST_GITHUB_REPO, number: 42 }],
    });
    await runtime.seedCollisionRunHistory(workspaceRoot, loop.loopId);

    const runsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs`);
    const runsBody = await runsRes.json() as { runs: LoopRunReport[] };

    expect(runsRes.status).toBe(200);
    expect(runsBody.runs[0]).toMatchObject({
      runId: "run-1",
      status: "skipped",
      reason: "collision_conflict",
      collisionConflicts: [expect.objectContaining({ targetKey: TEST_GITHUB_TARGET_KEY })],
    });
  });

  test("run history exposes trigger job metadata and sanitizes worktree paths", async () => {
    const { app, project, runtime, workspaceRoot } = await createTestApp("trigger-job-run-history-metadata");
    const loop = await createLoop(app, project.slug, prTriggerSessionLoopConfig);
    const seeded = await runtime.seedPrTriggerRunHistory(workspaceRoot, loop.loopId);

    const runsRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/runs`);
    const runsBody = await runsRes.json() as { runs: LoopRunReport[] };

    expect(runsRes.status).toBe(200);
    const safeRun = runsBody.runs.find((run) => run.runId === "run-safe-worktree");
    expect(safeRun).toMatchObject({
      jobId: "job-safe",
      trigger: "on_pr",
      subjectKey: TEST_GITHUB_PR_SUBJECT_KEY,
      dedupeKey: `${loop.loopId}:on_pr:${TEST_GITHUB_PR_SUBJECT_KEY}`,
      branchKey: `github:${TEST_GITHUB_OWNER}/${TEST_GITHUB_REPO}:main`,
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
      trigger: "on_commit",
      subjectKey: "branch:feature/leaky",
      dedupeKey: `${loop.loopId}:on_commit:branch:feature/leaky`,
      branchKey: `github:${TEST_GITHUB_OWNER}/${TEST_GITHUB_REPO}:feature/leaky`,
      cleanupState: "cleanup_failed",
    });
    expect(unsafeRun?.worktreePath).toBeUndefined();
    expect(unsafeRun?.worktreeBranchName).toBeUndefined();
    expect(unsafeRun?.baseSha).toBeUndefined();
    expect(unsafeRun?.resolvedHeadSha).toBeUndefined();
    expect(JSON.stringify(runsBody)).not.toContain(seeded.unsafeWorktreePath);
    expect(JSON.stringify(runsBody)).not.toContain("ghr_run_report_secret");
    expect(JSON.stringify(runsBody)).not.toContain("github_pat_run_report_secret");

    const persisted = await runtime.readLoopRunLog(workspaceRoot, loop.loopId);
    expect(persisted.find((run) => run.runId === "run-unsafe-worktree")?.worktreePath).toBe(seeded.unsafeWorktreePath);
  });

  test("read list and state routes expose trigger health and cleanup metadata safely", async () => {
    const { app, project, runtime, workspaceRoot } = await createTestApp("trigger-job-state-metadata");
    const loop = await createLoop(app, project.slug, prTriggerSessionLoopConfig);
    const seeded = await runtime.seedPrTriggerLoopState(workspaceRoot, loop.loopId);

    const listRes = await app.request(`/api/projects/${project.slug}/loops`);
    const listBody = await listRes.json() as { loops: LoopState[] };
    expect(listRes.status).toBe(200);
    expect(listBody.loops[0]).toMatchObject({
      loopId: loop.loopId,
      cleanupState: "cleanup_candidate",
      triggerHealth: [{ triggerKind: "on_pr", status: "blocked", cadenceMs: 60_000 }],
    });
    expect(listBody.loops[0]).not.toHaveProperty("currentJob");
    expect(listBody.loops[0]).not.toHaveProperty("queuedJobs");
    expect(JSON.stringify(listBody)).not.toContain(seeded.unsafeWorktreePath);
    expect(JSON.stringify(listBody)).not.toContain("ghp_secret_route_token");
    expect(JSON.stringify(listBody)).not.toContain("ghr_trigger_health_secret");
    expect(listBody.loops[0]?.triggerHealth?.[0]?.lastError).toContain("[REDACTED:SECRET]");

    const readRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`);
    const readBody = await readRes.json() as { loop: LoopState };
    expect(readRes.status).toBe(200);
    expect(readBody.loop).not.toHaveProperty("currentJob");
    expect(readBody.loop).not.toHaveProperty("queuedJobs");

    const stateRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}/state`);
    const stateBody = await stateRes.json() as { markdown: string; state: LoopState };
    expect(stateRes.status).toBe(200);
    expect(stateBody.state).not.toHaveProperty("currentJob");
    expect(stateBody.state).not.toHaveProperty("queuedJobs");
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

    const triggerPatchRes = await app.request(`/api/projects/${project.slug}/loops/${loop.loopId}`, {
      method: "PATCH",
      body: JSON.stringify({
        schedule: { kind: "cron", expression: "*/15 * * * *" },
        triggers: [{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }],
      }),
      headers: { "content-type": "application/json" },
    });
    const triggerPatchBody = await triggerPatchRes.json() as { loop: LoopState };
    expect(triggerPatchRes.status).toBe(200);
    expect(triggerPatchBody.loop.config.schedule).toEqual({ kind: "cron", expression: "*/15 * * * *" });
    expect(triggerPatchBody.loop.config.triggers).toEqual([{ kind: "on_pr", cadenceMs: 60_000, baseBranch: "main" }]);
    expect(triggerPatchBody.loop.config).not.toHaveProperty("cleanupPolicy");

    for (const internalPatch of [
      { config: manualSessionLoopConfig },
      { presetId: "daily_triage" },
      { templateId: "daily_triage" },
      { mode: "fix" },
      { toolProfileId: "loop_local_report" },
      { extraTools: ["bash"] },
      { collisionTargets: [{ type: "file", path: "README.md" }] },
      { cleanupPolicy: { deleteUnchangedWorktrees: true } },
      { run: { agent: "build", type: "goal" } },
      { nextRunAt: 123_456 },
      { generatedStateSummary: "server generated only" },
      { runCount: 99 },
    ]) {
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
    expect(stateBody.markdown).toContain(`# Loop ${loop.loopId}`);
    expect(stateBody.state.loopId).toBe(loop.loopId);
  expect(stateBody.state).not.toHaveProperty("readinessScore");

    const invalidIdRes = await app.request(`/api/projects/${project.slug}/loops/not-a-uuid`);
    expect(invalidIdRes.status).toBe(400);
    expect(await invalidIdRes.json()).toEqual({ error: { code: "BAD_REQUEST", message: "loopId must be a UUID" } });

    const missingLoopId = crypto.randomUUID();
    const missingLoopRes = await app.request(`/api/projects/${project.slug}/loops/${missingLoopId}`);
    expect(missingLoopRes.status).toBe(404);
    expect(await missingLoopRes.json()).toEqual({ error: { code: "LOOP_NOT_FOUND", message: `Loop not found: ${missingLoopId}` } });
  });
});

async function createLoop(app: ReturnType<typeof createServerApp>["app"], slug: string, config: LoopConfig): Promise<LoopState> {
  const res = await app.request(`/api/projects/${slug}/loops`, {
    method: "POST",
    body: JSON.stringify(createLoopBodyFromConfig(config)),
    headers: { "content-type": "application/json" },
  });
  expect(res.status).toBe(201);
  return (await res.json() as { loop: LoopState }).loop;
}

function createLoopBodyFromConfig(config: LoopConfig): Record<string, unknown> {
  return {
    templateId: config.templateId,
    schedule: config.schedule,
    approvalPolicy: config.approvalPolicy,
    limits: config.limits,
    ...(config.taskPrompt === undefined ? {} : { taskPrompt: config.taskPrompt }),
    ...(config.goalTemplate === undefined ? {} : {
      goalTemplate: {
        objective: config.goalTemplate.objective,
        acceptanceCriteria: config.goalTemplate.acceptanceCriteria,
      },
    }),
    ...(config.triggers === undefined ? {} : { triggers: config.triggers }),
    useWorktree: config.useWorktree,
  };
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
  const target = { type: "pr", owner: TEST_GITHUB_OWNER, repo: TEST_GITHUB_REPO, number: 42 } as const;
  const lease = {
    targetKey: TEST_GITHUB_TARGET_KEY,
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
  seedPrTriggerRunHistory(workspaceRoot: string, loopId: string): Promise<{ safeWorktreePath: string; unsafeWorktreePath: string }>;
  seedPrTriggerLoopState(workspaceRoot: string, loopId: string): Promise<{ unsafeWorktreePath: string }>;
} {
  const sessionStoreManager = new SessionStoreManager({ logger: silentLogger });
  const contextResolver = new ProjectContextResolver({
    ...createTestProjectContextResolverOptions(sessionStoreManager),
    projectInfoFactory: async (workspaceRoot) => {
      const project = await projectRegistry.getByWorkspace(workspaceRoot);
      if (project === undefined) throw new Error(`Project is not registered: ${workspaceRoot}`);
      return project;
    },
    logger: silentLogger,
  });
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
    notifyRuntimeShutdown: mock(() => undefined),
    listLoops: mock(async (workspaceRoot: string) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.list(context.project.slug);
    }),
    readLoop: mock(async (workspaceRoot: string, loopId: string) => (await contextResolver.resolve(workspaceRoot)).loopState.read(loopId)),
    createLoop: mock(async (workspaceRoot: string, config: LoopConfig) => {
      const context = await contextResolver.resolve(workspaceRoot);
      return await context.loopState.create(context.project.slug, config);
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
      const isGoalLoop = loop.config.templateId === "goal_runner";
      const sessionId = isGoalLoop ? `goal-session-${runSequence}` : `session-${runSequence}`;
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
        ...(isGoalLoop ? { goalId: `goal-${runSequence}` } : {}),
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
      const target = { type: "pr", owner: TEST_GITHUB_OWNER, repo: TEST_GITHUB_REPO, number: 42 } as const;
      const conflictingLease = {
        targetKey: TEST_GITHUB_TARGET_KEY,
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
      });
    },
    async seedPrTriggerRunHistory(workspaceRoot: string, loopId: string) {
      const context = await contextResolver.resolve(workspaceRoot);
      const { safeWorktreePath, unsafeWorktreePath } = triggerWorktreePaths(workspaceRoot);
      await context.loopState.appendRunReport(loopId, {
        runId: "run-safe-worktree",
        loopId,
        status: "skipped",
        trigger: "on_pr",
        startedAt: now,
        endedAt: now,
        reason: "execution_failed",
        jobId: "job-safe",
        subjectKey: TEST_GITHUB_PR_SUBJECT_KEY,
        dedupeKey: `${loopId}:on_pr:${TEST_GITHUB_PR_SUBJECT_KEY}`,
        branchKey: `github:${TEST_GITHUB_OWNER}/${TEST_GITHUB_REPO}:main`,
        worktreePath: safeWorktreePath,
        worktreeBranchName: "archcode/loop/route-safe/job-safe",
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
        startedAt: now + 1,
        endedAt: now + 1,
        reason: "execution_failed",
        jobId: "job-unsafe",
        subjectKey: "branch:feature/leaky",
        dedupeKey: `${loopId}:on_commit:branch:feature/leaky`,
        branchKey: `github:${TEST_GITHUB_OWNER}/${TEST_GITHUB_REPO}:feature/leaky`,
        worktreePath: unsafeWorktreePath,
        worktreeBranchName: "archcode/loop/route-unsafe/job-unsafe",
        baseSha: "c".repeat(40),
        resolvedHeadSha: "d".repeat(40),
        blockedReason: "failed_with_changes",
        cleanupState: "cleanup_failed",
      });
      return { safeWorktreePath, unsafeWorktreePath };
    },
    async seedPrTriggerLoopState(workspaceRoot: string, loopId: string) {
      const context = await contextResolver.resolve(workspaceRoot);
      const { unsafeWorktreePath } = triggerWorktreePaths(workspaceRoot);
      await context.loopState.update(loopId, {
        cleanupState: "cleanup_candidate",
        triggerHealth: [{ triggerKind: "on_pr", status: "blocked", cadenceMs: 60_000, lastCheckedAt: now + 3, lastError: "token=ghp_secret_route_token ghr_trigger_health_secret", missedCount: 1 }],
      });
      return { unsafeWorktreePath };
    },
  } as unknown as AgentRuntime & {
    setNow(value: number): void;
    waitForActiveRun(): Promise<void>;
    releaseActiveRun(): void;
    createLoopRunCount(): number;
    seedLoopSnapshots(workspaceRoot: string, loopId: string): Promise<void>;
    seedCollisionRunHistory(workspaceRoot: string, loopId: string): Promise<void>;
    seedPrTriggerRunHistory(workspaceRoot: string, loopId: string): Promise<{ safeWorktreePath: string; unsafeWorktreePath: string }>;
    seedPrTriggerLoopState(workspaceRoot: string, loopId: string): Promise<{ unsafeWorktreePath: string }>;
  };

  return runtime;
}

function triggerWorktreePaths(workspaceRoot: string): { safeWorktreePath: string; unsafeWorktreePath: string } {
  const managedRoot = resolve(dirname(workspaceRoot), `${basename(workspaceRoot)}.worktrees`);
  return {
    safeWorktreePath: join(managedRoot, "loop-safe-worktree"),
    unsafeWorktreePath: resolve(dirname(workspaceRoot), "not-managed", "loop-unsafe-worktree"),
  };
}
